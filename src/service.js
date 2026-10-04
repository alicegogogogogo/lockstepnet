'use strict';

const { createHash } = require('node:crypto');
const { ConflictError, IntegrityError, NotFoundError, ValidationError } = require('./errors');
const replay = require('./replay');
const { ReplayReader, ReplayWriter, VerifyReplay } = require('./replaystream');
const sim = require('./sim');
const { Store } = require('./store');

/** Canonical JSON used to compare an idempotent retry with the original request. */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function requestHash(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** A spectator stream may trail the live frontier by at most this many ticks. */
const MAX_SPECTATOR_DELAY = 1024;

/**
 * LockstepNet service: deterministic lockstep simulation with rollback replay.
 *
 * The whole contract follows from three rules:
 *   1. a match state is a pure function of (configuration, set of input records);
 *   2. an input record is keyed by (tick, unit, command) and applied in a
 *      canonical order inside its tick, so arrival order is irrelevant;
 *   3. an input for a tick that already ran forces a rollback: the frames from
 *      that tick on are rebuilt by replaying the stored input log, which
 *      reproduces the hashes that were recorded before the rollback.
 */
class Lockstep {
  constructor(database) {
    this.store = new Store(database);
  }

  close() {
    this.store.close();
  }

  /** Required-key idempotency: repeats return the first result, conflicts are 409. */
  idempotent(key, operation, body, action) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
      throw new ValidationError('Idempotency-Key header must be a non-empty string of at most 200 characters');
    }
    const hash = requestHash(body);
    return this.store.transaction(() => {
      const existing = this.store.getIdempotent(key);
      if (existing) {
        if (existing.operation !== operation) {
          throw new ConflictError('idempotency key was already used for another operation');
        }
        if (existing.requestHash !== hash) {
          throw new ConflictError('idempotency key was already used with a different request body');
        }
        return existing.response;
      }
      const response = action();
      this.store.putIdempotent(key, operation, hash, response);
      return response;
    });
  }

  match(matchId) {
    const record = this.store.readMatch(matchId);
    if (!record) {
      throw new NotFoundError(`match ${matchId} was not found`);
    }
    return record;
  }

  config(matchId) {
    return this.match(matchId).config;
  }

  createMatch(raw, key) {
    const config = sim.parseConfig(raw);
    return this.idempotent(key, `create-match:${config.id}`, raw, () => {
      if (this.store.readMatch(config.id)) {
        throw new ConflictError(`match ${config.id} already exists`);
      }
      const state = sim.initialState(config);
      state.hash = sim.stateHash(state);
      this.store.insertMatch(config, state);
      return this.describe(config, state);
    });
  }

  getState(matchId) {
    const record = this.match(matchId);
    return this.describe(record.config, this.store.readState(matchId));
  }

  /**
   * Public projection of a match: configuration, current deterministic state and
   * input-delivery counters.
   *
   * `missing` counts the input records the match expected but never received:
   * one per unit alive at the start of each already simulated tick, minus the
   * records that were delivered for that tick.
   */
  describe(config, state) {
    const frames = this.store.readFrames(config.id);
    const stats = this.store.readStats(config.id);
    let missing = 0;
    let settled = 0;
    for (const frame of frames) {
      const gap = Math.max(0, frame.alive - frame.inputs.length);
      missing += gap;
      settled += gap === 0 ? 1 : 0;
    }
    const alive = Object.values(state.units).filter((unit) => unit.health > 0);
    const team = (name) => ({ alive: alive.filter((unit) => unit.team === name).length, damage: state.teamDamage[name] });
    return {
      config: { id: config.id, max_ticks: config.maxTicks, seed: config.seed, units: config.units },
      inputs: {
        accepted: stats.accepted, duplicates: stats.duplicates, missing,
        rejected: stats.rejected, rollbacks: stats.rollbacks, settled,
      },
      match_id: config.id,
      max_ticks: config.maxTicks,
      seed: config.seed,
      state_hash: state.hash,
      status: state.status,
      teams: { blue: team('blue'), red: team('red') },
      tick: state.tick,
      units: Object.values(state.units).sort((left, right) => (left.id < right.id ? -1 : 1)).map((unit) => ({
        alive: unit.health > 0, attacking: unit.attacking, health: unit.health,
        id: unit.id, position: unit.position, team: unit.team, velocity: unit.velocity,
      })),
    };
  }

  /**
   * Queue input records. Records may arrive in any order, any number of times
   * and any number per request.
   *
   *  - a record whose (tick, unit, command) key is already stored is a
   *    duplicate: counted, never re-applied, and it cannot change the state;
   *  - a record for a tick beyond the frontier is stored for later;
   *  - a record for a tick at or below the frontier triggers one rollback to the
   *    earliest such tick, then a recomputation back to the frontier;
   *  - a record for an unknown unit, an out-of-range tick or a malformed command
   *    is rejected with a reason and leaves the state untouched.
   */
  submitInputs(matchId, raw, key) {
    const record = this.match(matchId);
    sim.exactKeys(raw, ['inputs'], 'body');
    if (!Array.isArray(raw.inputs)) {
      throw new ValidationError('inputs must be an array');
    }
    return this.idempotent(key, `submit-inputs:${matchId}`, raw, () => {
      if (raw.inputs.length === 0) {
        throw new ValidationError('inputs must be a non-empty array');
      }
      return this.processInputs(record, raw.inputs);
    });
  }

  /**
   * The input pipeline shared by the match-wide and the session-scoped input
   * endpoints: validation, de-duplication, stat accounting and the single
   * rollback-and-rebuild pass for late records. When `options.session` is set, a
   * record whose unit is not bound to that session is rejected with
   * `wrong_session` instead of being applied; the global rules, ordering and
   * counters stay identical.
   */
  processInputs(record, entries, options = {}) {
    const matchId = record.config.id;
    const session = options.session || null;
    const frontier = this.store.readState(matchId).tick;
    const accepted = [];
    const duplicates = [];
    const rejected = [];
    let earliest = null;
    entries.forEach((entry, index) => {
      let input;
      try {
        input = sim.parseInputRecord(entry);
      } catch (error) {
        rejected.push({ index, message: error.message, reason: 'invalid_input' });
        return;
      }
      if (input.tick >= record.config.maxTicks) {
        rejected.push({
          index,
          message: `input tick ${input.tick} is outside the match length ${record.config.maxTicks}`,
          reason: 'out_of_range',
        });
        return;
      }
      if (!record.config.units.some((unit) => unit.id === input.unit)) {
        rejected.push({ index, message: `input references unknown unit ${input.unit}`, reason: 'unknown_unit' });
        return;
      }
      if (session && !session.units.includes(input.unit)) {
        rejected.push({
          index,
          message: `unit ${input.unit} does not belong to session ${session.id}`,
          reason: 'wrong_session',
        });
        return;
      }
      if (this.store.readInput(matchId, input.tick, input.unit, input.command.kind)) {
        duplicates.push({ command: input.command.kind, tick: input.tick, unit: input.unit });
        return;
      }
      input.arrival = this.store.countInputsBefore(matchId, record.config.maxTicks);
      this.store.insertInput(matchId, input, sim.stripInput(input));
      accepted.push({ command: input.command.kind, seq: input.seq, tick: input.tick, unit: input.unit });
      if (earliest === null || input.tick < earliest) {
        earliest = input.tick;
      }
    });

    this.store.bumpStat(matchId, 'accepted', accepted.length);
    this.store.bumpStat(matchId, 'duplicates', duplicates.length);
    this.store.bumpStat(matchId, 'rejected', rejected.length);

    let rollback = null;
    if (earliest !== null && earliest < frontier) {
      // A late input rewinds the match to the earliest affected tick and then
      // replays forward to the frontier it had reached before this request, so
      // accepting a late input never loses already simulated ticks.
      const rewound = this.rollback(matchId, earliest);
      const { frames } = this.resimulate(matchId, earliest, frontier, false);
      const after = this.store.readState(matchId);
      this.store.bumpStat(matchId, 'rollbacks', 1);
      rollback = { ...rewound, frames_recomputed: frames.length, hash_after: after.hash, tick: after.tick };
    }
    return {
      ...this.describe(record.config, this.store.readState(matchId)),
      accepted, duplicates, rejected, rollback,
    };
  }

  /** Load a match's session or fail with 404; never returns null. */
  requireSession(matchId, sessionId) {
    this.match(matchId);
    const session = this.store.readSession(matchId, sessionId);
    if (!session) {
      throw new NotFoundError(`session ${sessionId} of match ${matchId} was not found`);
    }
    return session;
  }

  describeSession(matchId, session) {
    return {
      match_id: matchId,
      session_id: session.id,
      status: session.status,
      units: session.units.slice(),
    };
  }

  /**
   * Bind a session to one or more match units. Units must be a non-empty list of
   * distinct units of this match, and no unit may belong to another session, so
   * ownership is unique. Sessions are bookkeeping only: they never enter the
   * state hash or the replay document.
   */
  createSession(matchId, raw, key) {
    const record = this.match(matchId);
    sim.exactKeys(raw, ['id', 'units'], 'body');
    if (raw.id === undefined || raw.units === undefined) {
      throw new ValidationError('body must contain id and units');
    }
    const sessionId = sim.identifier(raw.id, 'session id');
    if (!Array.isArray(raw.units) || raw.units.length === 0) {
      throw new ValidationError('units must be a non-empty array');
    }
    const units = [];
    const seen = new Set();
    for (const entry of raw.units) {
      const unitId = sim.identifier(entry, 'session unit id');
      if (seen.has(unitId)) {
        throw new ValidationError(`session units must be unique: ${unitId}`);
      }
      seen.add(unitId);
      if (!record.config.units.some((unit) => unit.id === unitId)) {
        throw new ValidationError(`session references unknown unit ${unitId}`);
      }
      units.push(unitId);
    }
    units.sort();
    return this.idempotent(key, `create-session:${matchId}`, raw, () => {
      if (this.store.readSession(matchId, sessionId)) {
        throw new ConflictError(`session ${sessionId} already exists for match ${matchId}`);
      }
      for (const other of this.store.readSessions(matchId)) {
        const overlap = other.units.find((unitId) => seen.has(unitId));
        if (overlap) {
          throw new ConflictError(`unit ${overlap} already belongs to session ${other.id}`);
        }
      }
      const session = { id: sessionId, status: 'connected', units };
      this.store.insertSession(matchId, session);
      return this.describeSession(matchId, session);
    });
  }

  /**
   * Submit inputs through a session. The format, de-duplication key, canonical
   * order, late-input rollback and counters are exactly those of the match-wide
   * endpoint; an input for a unit the session does not own is rejected with
   * reason `wrong_session`, and a disconnected session may not submit at all.
   */
  submitSessionInputs(matchId, sessionId, raw, key) {
    const session = this.requireSession(matchId, sessionId);
    sim.exactKeys(raw, ['inputs'], 'body');
    if (!Array.isArray(raw.inputs)) {
      throw new ValidationError('inputs must be an array');
    }
    return this.idempotent(key, `submit-session-inputs:${matchId}:${sessionId}`, raw, () => {
      if (session.status === 'disconnected') {
        throw new ConflictError(`session ${sessionId} is disconnected and cannot submit inputs`);
      }
      if (raw.inputs.length === 0) {
        throw new ValidationError('inputs must be a non-empty array');
      }
      return this.processInputs(this.match(matchId), raw.inputs, { session });
    });
  }

  /** Mark a session disconnected; the match itself is unaffected. Idempotent. */
  disconnectSession(matchId, sessionId, raw, key) {
    const session = this.requireSession(matchId, sessionId);
    const body = raw === undefined || raw === null ? {} : raw;
    sim.exactKeys(body, [], 'body');
    return this.idempotent(key, `disconnect-session:${matchId}:${sessionId}`, body, () => {
      if (session.status !== 'disconnected') {
        this.store.setSessionStatus(matchId, sessionId, 'disconnected');
      }
      return this.describeSession(matchId, { ...session, status: 'disconnected' });
    });
  }

  /**
   * Reconnect a session and stream the frames recorded *after* `after_tick`, at
   * most `limit` per call (default and maximum 1024), together with the
   * caught-up unit states and team damage. The session ends up `connected`; a
   * partial window reports `complete: false` and is paged by calling again with
   * the returned `next_tick`.
   *
   * The window is read from the recorded frame log and must be contiguous and
   * hash-consistent end to end; a gap or a recomputation mismatch is an
   * `integrity_failure` instead of an inconsistent catch-up.
   */
  resumeSession(matchId, sessionId, raw, key) {
    const session = this.requireSession(matchId, sessionId);
    sim.exactKeys(raw, ['after_tick', 'limit'], 'body');
    if (!Object.prototype.hasOwnProperty.call(raw, 'after_tick')) {
      throw new ValidationError('body must contain after_tick');
    }
    const afterTick = raw.after_tick;
    if (!Number.isInteger(afterTick) || afterTick < 0) {
      throw new ValidationError('after_tick must be a non-negative integer');
    }
    const limit = raw.limit === undefined ? sim.MAX_STEP : raw.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > sim.MAX_STEP) {
      throw new ValidationError(`limit must be an integer between 1 and ${sim.MAX_STEP}`);
    }
    return this.idempotent(key, `resume-session:${matchId}:${sessionId}`, raw, () => {
      const frontier = this.store.readState(matchId).tick;
      if (afterTick > frontier) {
        throw new ConflictError(`after_tick ${afterTick} is past the current tick ${frontier}`);
      }
      const frames = this.sessionFrames(matchId, afterTick, limit, frontier);
      if (session.status !== 'connected') {
        this.store.setSessionStatus(matchId, sessionId, 'connected');
      }
      const state = this.store.readState(matchId);
      const reached = afterTick + frames.length;
      const complete = reached >= frontier;
      const units = this.unitsAt(matchId, session.units, reached, state)
        .sort((left, right) => (left.id < right.id ? -1 : 1));
      return {
        complete,
        frames,
        match_id: matchId,
        next_tick: reached,
        session_id: sessionId,
        state_hash: complete ? state.hash : this.frameHashAt(matchId, reached),
        status: 'connected',
        team_damage: this.teamDamageAt(matchId, reached, state),
        units,
      };
    });
  }

  /**
   * The recorded frame summaries strictly after `afterTick`, up to `limit`, in
   * tick order. The log must be contiguous from the requested point; the window
   * is re-derived in memory from the snapshot before it and must reproduce every
   * recorded hash - a divergence is an integrity failure rather than a silently
   * different catch-up. Nothing here mutates the frame log.
   */
  sessionFrames(matchId, afterTick, limit, frontier) {
    const end = Math.min(afterTick + limit, frontier);
    const byTick = new Map();
    for (const frame of this.store.readFramesFrom(matchId, afterTick + 1)) {
      byTick.set(frame.tick, frame);
    }
    const frames = [];
    for (let tick = afterTick + 1; tick <= end; tick += 1) {
      const frame = byTick.get(tick);
      if (!frame) {
        // Every tick up to the frontier must have a frame; a gap means the log
        // was corrupted and catch-up cannot be served continuously.
        throw new IntegrityError(`match ${matchId} is missing recorded frame ${tick}`);
      }
      frames.push({
        casualties: frame.delta.casualties, settled: frame.settled,
        state_hash: frame.state_hash, tick: frame.tick,
      });
    }
    if (frames.length > 0) {
      this.verifyWindow(matchId, afterTick, frames);
    }
    return frames;
  }

  /**
   * Recompute the frames of a catch-up window in memory from the snapshot before
   * it and the stored input log, comparing each hash with the recorded one. This
   * is the read-only counterpart of the rollback rebuild: session catch-up never
   * trims or rewrites the frame log.
   */
  verifyWindow(matchId, afterTick, frames) {
    const state = this.snapshotAt(matchId, afterTick);
    const buckets = new Map();
    for (const input of this.store.readInputs(matchId)) {
      const bucket = buckets.get(input.tick);
      if (bucket) {
        bucket.push(input.body);
      } else {
        buckets.set(input.tick, [input.body]);
      }
    }
    for (const bucket of buckets.values()) {
      bucket.sort(sim.compareInputs);
    }
    for (const frame of frames) {
      const settled = buckets.get(state.tick) || [];
      sim.applyTick(state, settled);
      state.hash = sim.stateHash(state);
      if (state.tick !== frame.tick || state.hash !== frame.state_hash) {
        throw new IntegrityError(`frame ${frame.tick} of match ${matchId} does not recompute to its recorded hash`);
      }
    }
  }

  /** Hash of the state *after* frame `tick`; 0 is the initial (frontier) hash. */
  frameHashAt(matchId, tick) {
    if (tick <= 0) {
      return sim.stateHash(sim.initialState(this.config(matchId)));
    }
    const frame = this.store.readFrames(matchId).find((candidate) => candidate.tick === tick);
    if (!frame) {
      throw new IntegrityError(`match ${matchId} has no recorded frame ${tick}`);
    }
    return frame.state_hash;
  }

  /** Team damage at frame `tick`, taken from the frame snapshot when mid-window. */
  teamDamageAt(matchId, tick, current) {
    if (tick >= current.tick) {
      return { blue: current.teamDamage.blue, red: current.teamDamage.red };
    }
    if (tick <= 0) {
      return { blue: 0, red: 0 };
    }
    const frame = this.store.readFrames(matchId).find((candidate) => candidate.tick === tick);
    if (!frame) {
      throw new IntegrityError(`match ${matchId} has no recorded frame ${tick}`);
    }
    return { blue: frame.state.teams.blue, red: frame.state.teams.red };
  }

  /** Snapshots of the session-owned units as they are at frame `tick`. */
  unitsAt(matchId, unitIds, tick, current) {
    let source;
    if (tick >= current.tick) {
      source = current.units;
    } else if (tick <= 0) {
      source = sim.initialState(this.config(matchId)).units;
    } else {
      const frame = this.store.readFrames(matchId).find((candidate) => candidate.tick === tick);
      if (!frame) {
        throw new IntegrityError(`match ${matchId} has no recorded frame ${tick}`);
      }
      source = {};
      for (const unit of frame.state.units) {
        source[unit.id] = unit;
      }
    }
    return unitIds.map((id) => {
      const unit = source[id];
      if (!unit) {
        throw new IntegrityError(`frame ${tick} of match ${matchId} is missing unit ${id}`);
      }
      return {
        alive: unit.health > 0, attacking: unit.attacking, health: unit.health,
        id: unit.id, position: unit.position, team: unit.team, velocity: unit.velocity,
      };
    });
  }

  /** Load a match's spectator or fail with 404; never returns null. */
  requireSpectator(matchId, spectatorId) {
    this.match(matchId);
    const spectator = this.store.readSpectator(matchId, spectatorId);
    if (!spectator) {
      throw new NotFoundError(`spectator ${spectatorId} of match ${matchId} was not found`);
    }
    return spectator;
  }

  /**
   * The frame a spectator may currently see: the frontier delayed by
   * `delay_ticks` while a match runs, or the final tick once it has ended. A
   * finished match is frozen, so its spectators catch up to the very end instead
   * of trailing forever.
   */
  visibleTick(spectator, state) {
    if (state.status !== 'running') {
      return state.tick;
    }
    return Math.max(0, state.tick - spectator.delayTicks);
  }

  /**
   * Register a spectator: a passive reader that trails the live frontier by
   * `delay_ticks`. Spectators are bookkeeping only: creating one never advances
   * the match and never enters a `state_hash` or `replay_hash`.
   */
  createSpectator(matchId, raw, key) {
    const record = this.match(matchId);
    sim.exactKeys(raw, ['id', 'delay_ticks'], 'body');
    if (raw.id === undefined || raw.delay_ticks === undefined) {
      throw new ValidationError('body must contain id and delay_ticks');
    }
    const spectatorId = sim.identifier(raw.id, 'spectator id');
    const delayTicks = sim.integer(raw.delay_ticks, 'delay_ticks', 0, MAX_SPECTATOR_DELAY);
    return this.idempotent(key, `create-spectator:${matchId}`, raw, () => {
      if (this.store.readSpectator(matchId, spectatorId)) {
        throw new ConflictError(`spectator ${spectatorId} already exists for match ${matchId}`);
      }
      const spectator = { delayTicks, highWater: 0, id: spectatorId, maxDelivered: 0, reset: false };
      this.store.insertSpectator(matchId, spectator);
      const state = this.store.readState(matchId);
      return {
        delay_ticks: delayTicks,
        match_id: matchId,
        spectator_id: spectatorId,
        visible_tick: this.visibleTick(spectator, state),
      };
    });
  }

  /**
   * Poll a spectator's delayed stream.
   *
   * In normal `stream` mode the response carries the contiguous recorded frames
   * strictly after `after_tick` up to the spectator's `visible_tick`, at most
   * `limit` frames, followed by the state at the end of the returned window.
   * `complete` is true only when the window reached `visible_tick`.
   *
   * When a rollback (a late input or the explicit endpoint) rewrites a frame the
   * spectator had already received, the spectator is marked for reset: the next
   * poll ignores `after_tick`, replays from tick 0 in pages of `limit`, and
   * reports `mode: "reset"` until the reset stream catches back up.
   */
  pollSpectator(matchId, spectatorId, raw, key) {
    const spectator = this.requireSpectator(matchId, spectatorId);
    sim.exactKeys(raw, ['after_tick', 'limit'], 'body');
    const afterTick = raw.after_tick === undefined ? 0 : raw.after_tick;
    if (!Number.isInteger(afterTick) || afterTick < 0) {
      throw new ValidationError('after_tick must be a non-negative integer');
    }
    const limit = raw.limit === undefined ? sim.MAX_STEP : raw.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > sim.MAX_STEP) {
      throw new ValidationError(`limit must be an integer between 1 and ${sim.MAX_STEP}`);
    }
    return this.idempotent(key, `poll-spectator:${matchId}:${spectatorId}`, raw, () => {
      const state = this.store.readState(matchId);
      const visible = this.visibleTick(spectator, state);
      if (!spectator.reset && afterTick > visible) {
        throw new ConflictError(`after_tick ${afterTick} is past the visible tick ${visible}`);
      }

      let mode = 'stream';
      let startTick = afterTick;
      if (spectator.reset) {
        // A reset replays the whole history from tick 0 in limit-sized pages;
        // after_tick from the client is discarded. The spectator's high-water
        // mark, rewound to 0 when the reset was flagged, is the paging cursor.
        mode = 'reset';
        startTick = spectator.highWater;
      }

      const end = Math.min(startTick + limit, visible);
      const frames = this.spectatorFrames(matchId, startTick, end);
      const reached = startTick + frames.length;

      let complete;
      let nextReset = spectator.reset;
      if (spectator.reset) {
        complete = reached >= visible;
        nextReset = !complete;
      } else {
        complete = reached >= visible;
      }

      const updated = {
        ...spectator,
        highWater: reached,
        maxDelivered: Math.max(spectator.maxDelivered, reached),
        reset: nextReset,
      };
      this.store.writeSpectator(matchId, updated);

      return {
        complete,
        frames,
        match_id: matchId,
        mode,
        next_tick: reached,
        spectator_id: spectatorId,
        state_hash: this.frameHashAt(matchId, reached),
        team_damage: this.teamDamageAt(matchId, reached, state),
        units: this.allUnitsAt(matchId, reached, state),
      };
    });
  }

  /**
   * Contiguous recorded frames with ticks in `(startTick, endTick]`, each
   * re-derived from the snapshot before the window and checked against its
   * recorded hash. A gap or a recomputation mismatch is an `integrity_failure`
   * rather than an inconsistent stream.
   */
  spectatorFrames(matchId, startTick, endTick) {
    if (endTick <= startTick) {
      return [];
    }
    const byTick = new Map();
    for (const frame of this.store.readFramesFrom(matchId, startTick + 1)) {
      byTick.set(frame.tick, frame);
    }
    const frames = [];
    for (let tick = startTick + 1; tick <= endTick; tick += 1) {
      const frame = byTick.get(tick);
      if (!frame) {
        throw new IntegrityError(`match ${matchId} is missing recorded frame ${tick}`);
      }
      frames.push({
        casualties: frame.delta.casualties, settled: frame.settled,
        state_hash: frame.state_hash, tick: frame.tick,
      });
    }
    this.verifyWindow(matchId, startTick, frames);
    return frames;
  }

  /** Every unit snapshot as it is at frame `tick`, sorted by unit id. */
  allUnitsAt(matchId, tick, current) {
    return this.unitsAt(
      matchId,
      this.config(matchId).units.map((unit) => unit.id),
      tick,
      current,
    ).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  /**
   * Advance a match by `count` ticks (default 1).
   *
   * The frontier never passes `max_ticks`, and the simulation stops early when a
   * team is eliminated. Advancing a match that is not `running` is a 409.
   */
  advance(matchId, raw, key) {
    const config = this.config(matchId);
    const body = raw === undefined || raw === null ? { count: 1 } : raw;
    sim.exactKeys(body, ['count'], 'body');
    const count = body.count === undefined ? 1 : body.count;
    if (!Number.isInteger(count) || count < 1 || count > sim.MAX_STEP) {
      throw new ValidationError(`count must be an integer between 1 and ${sim.MAX_STEP}`);
    }
    return this.idempotent(key, `advance:${matchId}`, { count }, () => {
      const before = this.store.readState(matchId);
      if (before.status !== 'running') {
        throw new ConflictError(`match ${matchId} is ${before.status} and cannot advance`);
      }
      const target = Math.min(before.tick + count, config.maxTicks);
      const { frames } = this.resimulate(matchId, before.tick, target, false);
      const updated = this.store.readState(matchId);
      return {
        ...this.describe(config, updated),
        advanced: frames.length,
        frames: frames.map((frame) => ({
          casualties: frame.delta.casualties, settled: frame.settled,
          state_hash: frame.state_hash, tick: frame.tick,
        })),
        state_hash: updated.hash,
      };
    });
  }

  /**
   * Explicit rollback: rewind the match to `tick` by discarding every frame after
   * it. Input records are never discarded, so the next `POST /tick` replays them
   * and reproduces exactly the hashes recorded before the rollback.
   */
  rollback(matchId, tick) {
    const record = this.match(matchId);
    if (!Number.isInteger(tick) || tick < 0 || tick > record.config.maxTicks) {
      throw new ValidationError(`tick must be an integer between 0 and ${record.config.maxTicks}`);
    }
    const before = this.store.readState(matchId);
    if (tick > before.tick) {
      throw new ConflictError(`tick ${tick} is past the current tick ${before.tick}`);
    }
    this.resimulate(matchId, tick, tick, false);
    const after = this.store.readState(matchId);
    return {
      frames_recomputed: before.tick - tick,
      from_tick: before.tick, hash_after: after.hash, hash_before: before.hash,
      match_id: matchId, tick: after.tick, to_tick: tick,
    };
  }

  /** The whole match as a portable replay document. */
  replayFile(matchId) {
    const record = this.match(matchId);
    const frames = this.store.readFrames(matchId).map((frame) => ({
      delta: frame.delta, settled: frame.settled, settled_inputs: frame.inputs,
      state_hash: frame.state_hash, tick: frame.tick,
    }));
    return replay.buildFile(record.config, frames, this.store.readInputs(matchId));
  }

  /**
   * The determined match timeline as a self-describing replay byte stream.
   *
   * The stream records the format version, the tick configuration, the seed,
   * the start frame, the participant identifiers and the initial state hash,
   * followed by every confirmed frame with the inputs that were finally
   * applied (canonical JSON payloads, kept as raw bytes) and the resulting
   * state hash. Frames are committed in strictly ascending tick order, so the
   * exported bytes are a pure function of the initial conditions and the final
   * timeline: two matches whose inputs arrived in different orders but settled
   * to the same timeline export byte-identical streams.
   */
  replayStream(matchId) {
    const record = this.match(matchId);
    const config = record.config;
    const frames = this.store.readFrames(matchId);
    const writer = new ReplayWriter({
      initialStateHash: sim.stateHash(sim.initialState(config)),
      match: { id: config.id, max_ticks: config.maxTicks, seed: config.seed, units: config.units },
      startFrame: frames.length === 0 ? 1 : frames[0].tick,
    });
    for (const frame of frames) {
      writer.appendFrame({
        inputs: frame.inputs.map((canonical) => ({
          participant: JSON.parse(canonical).unit,
          payload: canonical,
        })),
        stateHash: frame.state_hash,
        tick: frame.tick,
      });
    }
    return writer.finalize();
  }

  /**
   * Verify a replay byte stream in this process: re-simulate it from the
   * recorded initial conditions and compare every recorded state hash.
   */
  verifyReplayStream(source, options = {}) {
    return VerifyReplay(source, options);
  }

  /**
   * `POST /matches/{id}/verify` accepts either `{"match_id": "..."}` to
   * re-simulate a stored match, or `{"replay": {...}}` for an uploaded replay.
   */
  verify(raw) {
    sim.exactKeys(raw, ['match_id', 'replay'], 'body');
    if (raw.replay !== undefined && raw.match_id !== undefined) {
      throw new ValidationError('provide either match_id or replay, not both');
    }
    if (raw.replay !== undefined) {
      return this.verifyDocument(raw.replay);
    }
    if (typeof raw.match_id !== 'string' || raw.match_id.length === 0) {
      throw new ValidationError('match_id must be a non-empty string');
    }
    return this.verifyDocument(this.replayFile(raw.match_id));
  }

  verifyDocument(document) {
    const result = replay.verifyDocument(document);
    const stored = this.store.readMatch(result.config.id);
    const mismatches = result.mismatches.slice();
    let recordedHash = null;
    if (stored && stored.tick === result.state.tick) {
      recordedHash = stored.stateHash;
      if (recordedHash !== result.state_hash) {
        mismatches.push({
          kind: 'state_hash',
          message: 'replayed final state does not match the stored match state',
          recorded: recordedHash, recomputed: result.state_hash, tick: result.state.tick,
        });
      }
    }
    return {
      consistent: mismatches.length === 0,
      final_state_hash: result.state_hash,
      match_id: result.config.id,
      mismatches,
      recorded_state_hash: recordedHash,
      replay_hash: result.replay_hash,
      ticks_replayed: result.frames.length,
    };
  }

  /**
   * Rebuild the frame log from `resumeTick` up to `targetTick`.
   *
   * Frames after `resumeTick` are discarded and re-derived from the snapshot at
   * `resumeTick` plus the stored input records. Every rebuilt frame that already
   * existed must keep its hash; a divergence means the log or the engine changed
   * and is reported as `integrity_failure` instead of silently changing results.
   *
   * `extend` lets the match simulate past `targetTick` until a team is eliminated
   * or `max_ticks` is reached. `POST /tick` does not extend: stopping exactly at
   * the requested tick is what makes rollback-then-advance reproduce hashes.
   */
  resimulate(matchId, resumeTick, targetTick, extend = false) {
    const config = this.config(matchId);
    if (targetTick < resumeTick) {
      throw new IntegrityError(`cannot resimulate ${matchId} backwards from ${resumeTick} to ${targetTick}`);
    }
    const expected = new Map();
    for (const frame of this.store.readFramesFrom(matchId, resumeTick + 1)) {
      expected.set(frame.tick, frame.state_hash);
    }
    // `resumeTick` is a *frame* number: resuming continues from the state that
    // frame recorded, and must read it before the log is trimmed.
    const state = this.snapshotAt(matchId, resumeTick);
    const resumeStatus = state.status;
    this.store.deleteFramesFrom(matchId, resumeTick + 1);
    // A spectator whose delayed stream already held a frame this rebuild
    // discards must restart from tick 0. A plain forward advance never reaches
    // this branch with such a spectator: its visible window lags the frontier,
    // so its high-water mark cannot pass the old frontier.
    for (const spectator of this.store.readSpectatorsPast(matchId, resumeTick)) {
      // Rewind the reset paging cursor to 0 so the replay restarts at tick 0.
      // The monotonic max-delivered mark is kept: it is what triggered this and
      // continues to describe how far this spectator has ever seen.
      spectator.highWater = 0;
      spectator.reset = true;
      this.store.writeSpectator(matchId, spectator);
    }
    const buckets = new Map();
    for (const input of this.store.readInputs(matchId)) {
      const bucket = buckets.get(input.tick);
      if (bucket) {
        bucket.push(input.body);
      } else {
        buckets.set(input.tick, [input.body]);
      }
    }
    for (const bucket of buckets.values()) {
      bucket.sort(sim.compareInputs);
    }

    state.status = 'running';
    const boundary = extend ? config.maxTicks : targetTick;
    const rebuilt = [];
    let endedNaturally = false;
    // Iteration `produced` applies the inputs of tick `produced - 1` and records
    // frame `produced`.
    for (let produced = resumeTick + 1; produced <= boundary; produced += 1) {
      const aliveAtStart = Object.values(state.units).filter((unit) => unit.health > 0).length;
      const settled = buckets.get(state.tick) || [];
      const delta = sim.applyTick(state, settled);
      state.hash = sim.stateHash(state);
      const recorded = expected.get(state.tick);
      if (recorded !== undefined && recorded !== state.hash) {
        throw new IntegrityError(
          `frame ${state.tick} of match ${matchId} recomputed to ${state.hash} but was recorded as ${recorded}`,
        );
      }
      const frame = {
        alive: aliveAtStart,
        delta,
        inputs: settled.map(sim.canonicalInput),
        settled: settled.length >= aliveAtStart,
        state: {
          teams: { blue: state.teamDamage.blue, red: state.teamDamage.red },
          tick: state.tick,
          units: Object.values(state.units).map((unit) => ({
            attacking: unit.attacking, health: unit.health, id: unit.id,
            position: unit.position, team: unit.team, velocity: unit.velocity,
          })),
        },
        state_hash: state.hash,
        tick: state.tick,
      };
      this.store.insertFrame(matchId, frame);
      rebuilt.push(frame);
      if (state.status !== 'running') {
        endedNaturally = true;
        break;
      }
    }
    if (state.tick === targetTick && !endedNaturally) {
      // A timeline that stops exactly at the requested frontier keeps the status
      // that frontier had, instead of inventing one from the tick count.
      state.status = resumeStatus;
    }
    // The frontier hash is always the hash of the state the frontier holds, so a
    // rolled-back match reports the same hash that its frame held before.
    state.hash = sim.stateHash(state);
    this.store.writeState(matchId, state, {});
    return { frames: rebuilt, state };
  }

  /**
   * State snapshot *after* frame `tick`: the initial state for tick 0, otherwise
   * the snapshot frame `tick` itself stored. A missing frame is a hard failure
   * because every later frame depends on it.
   */
  snapshotAt(matchId, tick) {
    const config = this.config(matchId);
    if (tick <= 0) {
      return sim.initialState(config);
    }
    const frame = this.store.readFrames(matchId).find((candidate) => candidate.tick === tick);
    if (!frame) {
      throw new IntegrityError(`match ${matchId} has no recorded frame ${tick} to resume from`);
    }
    const state = sim.initialState(config);
    state.teamDamage = { blue: frame.state.teams.blue, red: frame.state.teams.red };
    state.tick = frame.state.tick;
    for (const unit of frame.state.units) {
      state.units[unit.id] = { ...unit };
    }
    return state;
  }
}

module.exports = { Lockstep, ReplayReader, ReplayWriter, VerifyReplay };
