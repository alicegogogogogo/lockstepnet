'use strict';

const { createHash } = require('node:crypto');
const { ConflictError, IntegrityError, NotFoundError, ValidationError } = require('./errors');
const replay = require('./replay');
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
      return { ...this.processInputs(record, raw.inputs, null),
        ...this.describe(record.config, this.store.readState(matchId)) };
    });
  }

  /**
   * Validate, store and (when late) roll back a batch of input records.
   *
   * Shared by `POST /matches/{id}/inputs` (`session = null`) and the
   * session-scoped input route. With a session, records for units the session
   * does not own are rejected with `wrong_session`; parsing, dedup keys, the
   * canonical order, late-input rollback and every stat are otherwise
   * identical, so the session channel cannot change the deterministic result.
   */
  processInputs(record, entries, session) {
    const matchId = record.config.id;
    const frontier = this.store.readState(matchId).tick;
    let owned = null;
    if (session) {
      owned = new Set(session.units);
    }
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
      if (owned && !owned.has(input.unit)) {
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
      accepted, duplicates, rejected, rollback,
    };
  }

  /**
   * Open a player session and bind it to a set of match units.
   *
   * Units must exist in the match configuration, be listed once and not be
   * claimed by another session. Session metadata never reaches the simulation,
   * the state hash or the replay document: it only gates which units a session
   * channel may submit inputs for.
   */
  createSession(matchId, raw, key) {
    const record = this.match(matchId);
    sim.exactKeys(raw, ['id', 'units'], 'body');
    sim.requireKeys(raw, ['id', 'units'], 'body');
    const sessionId = sim.identifier(raw.id, 'session id');
    if (!Array.isArray(raw.units)) {
      throw new ValidationError('units must be an array');
    }
    if (raw.units.length === 0) {
      throw new ValidationError('units must be a non-empty array');
    }
    const units = [];
    const seen = new Set();
    for (const entry of raw.units) {
      const unit = sim.identifier(entry, 'session unit id');
      if (seen.has(unit)) {
        throw new ValidationError(`session units must be unique: ${unit}`);
      }
      seen.add(unit);
      if (!record.config.units.some((candidate) => candidate.id === unit)) {
        throw new ValidationError(`session references unknown unit ${unit}`);
      }
      units.push(unit);
    }
    return this.idempotent(key, `create-session:${matchId}:${sessionId}`, raw, () => {
      if (this.store.readSession(matchId, sessionId)) {
        throw new ConflictError(`session ${sessionId} already exists in match ${matchId}`);
      }
      const claims = this.store.readSessionClaims(matchId);
      for (const unit of units) {
        const owner = claims.get(unit);
        if (owner) {
          throw new ConflictError(`unit ${unit} already belongs to session ${owner}`);
        }
      }
      this.store.insertSession(matchId, sessionId, units);
      return { match_id: matchId, session_id: sessionId, status: 'connected', units };
    });
  }

  /** Load a session or fail with `not_found`; the match itself is checked first. */
  requireSession(matchId, sessionId) {
    this.match(matchId);
    const session = this.store.readSession(matchId, sessionId);
    if (!session) {
      throw new NotFoundError(`session ${sessionId} was not found in match ${matchId}`);
    }
    return session;
  }

  describeSession(matchId, sessionId) {
    const session = this.store.readSession(matchId, sessionId);
    return {
      match_id: matchId, session_id: sessionId, status: session.status, units: session.units,
    };
  }

  /**
   * Session channel for `POST /matches/{id}/sessions/{sid}/inputs`. The input
   * format, dedup keys, canonical order, late-input rollback and stats are
   * exactly the global route's; records for units outside the session are
   * rejected with `wrong_session`. A disconnected session cannot submit.
   */
  submitSessionInputs(matchId, sessionId, raw, key) {
    const record = this.match(matchId);
    const session = this.requireSession(matchId, sessionId);
    sim.exactKeys(raw, ['inputs'], 'body');
    if (!Array.isArray(raw.inputs)) {
      throw new ValidationError('inputs must be an array');
    }
    return this.idempotent(key, `submit-session-inputs:${matchId}:${sessionId}`, raw, () => {
      if (raw.inputs.length === 0) {
        throw new ValidationError('inputs must be a non-empty array');
      }
      if (session.status !== 'connected') {
        throw new ConflictError(`session ${sessionId} is ${session.status} and cannot submit inputs`);
      }
      return {
        ...this.processInputs(record, raw.inputs, session),
        ...this.describe(record.config, this.store.readState(matchId)),
      };
    });
  }

  /** Mark a session disconnected; its inputs, frames and the match are untouched. */
  disconnect(matchId, sessionId, raw, key) {
    this.requireSession(matchId, sessionId);
    const body = raw === undefined || raw === null ? {} : raw;
    sim.exactKeys(body, [], 'body');
    return this.idempotent(key, `session-disconnect:${matchId}:${sessionId}`, body, () => {
      const session = this.store.readSession(matchId, sessionId);
      if (session.status === 'connected') {
        this.store.setSessionStatus(matchId, sessionId, 'disconnected');
      }
      return this.describeSession(matchId, sessionId);
    });
  }

  /**
   * Reconnect a session and catch up incrementally.
   *
   * Returns at most `limit` (default and cap 1024) frame summaries strictly
   * after `after_tick`, plus the caught-up unit/team state. `complete` is true
   * only when the window reaches the current frontier. Frames must be
   * contiguous and their hashes must match the snapshot and frontier hashes;
   * a divergence is an `integrity_failure`. `after_tick` beyond the frontier
   * is a `conflict` and leaves everything untouched.
   */
  resume(matchId, sessionId, raw, key) {
    this.match(matchId);
    this.requireSession(matchId, sessionId);
    const body = raw === undefined || raw === null ? {} : raw;
    sim.exactKeys(body, ['after_tick', 'limit'], 'body');
    const afterTick = body.after_tick === undefined ? 0 : body.after_tick;
    if (!Number.isInteger(afterTick) || afterTick < 0) {
      throw new ValidationError('after_tick must be a non-negative integer');
    }
    const limit = body.limit === undefined ? sim.MAX_STEP : body.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > sim.MAX_STEP) {
      throw new ValidationError(`limit must be an integer between 1 and ${sim.MAX_STEP}`);
    }
    const normalized = { after_tick: afterTick, limit };
    return this.idempotent(key, `session-resume:${matchId}:${sessionId}`, normalized, () => {
      const frontier = this.store.readState(matchId);
      if (afterTick > frontier.tick) {
        throw new ConflictError(`after_tick ${afterTick} is past the current tick ${frontier.tick}`);
      }
      const available = this.store.readFramesFrom(matchId, afterTick + 1);
      const frames = available.slice(0, limit);
      frames.forEach((frame, index) => {
        const expectedTick = afterTick + index + 1;
        if (frame.tick !== expectedTick) {
          throw new IntegrityError(
            `resume of match ${matchId} expected frame ${expectedTick} but the next frame is ${frame.tick}`,
          );
        }
      });
      const endTick = afterTick + frames.length;
      // When the window covers every frame the log still holds yet stops short
      // of the frontier, a trailing frame is missing rather than merely paged.
      const reachedLogEnd = frames.length === available.length;
      if (reachedLogEnd && endTick < frontier.tick) {
        throw new IntegrityError(
          `resume of match ${matchId} found no frame ${endTick + 1} but the frontier is ${frontier.tick}`,
        );
      }
      // The caught-up state is reconstructed from the recorded snapshot, so its
      // hash must reproduce the last delivered frame hash and the frontier hash
      // when the window reaches it.
      const caught = this.snapshotAt(matchId, endTick);
      caught.hash = sim.stateHash(caught);
      if (frames.length > 0 && caught.hash !== frames[frames.length - 1].state_hash) {
        throw new IntegrityError(
          `frame ${endTick} of match ${matchId} snapshot hashes to ${caught.hash} but was recorded as ${frames[frames.length - 1].state_hash}`,
        );
      }
      const complete = endTick === frontier.tick;
      if (complete && caught.hash !== frontier.hash) {
        throw new IntegrityError(
          `frame ${endTick} of match ${matchId} matches its frame hash but not the frontier hash ${frontier.hash}`,
        );
      }
      this.store.setSessionStatus(matchId, sessionId, 'connected');
      return {
        after_tick: afterTick,
        complete,
        frames: frames.map((frame) => ({
          casualties: frame.delta.casualties, settled: frame.settled,
          state_hash: frame.state_hash, tick: frame.tick,
        })),
        match_id: matchId,
        next_tick: endTick,
        session_id: sessionId,
        state_hash: caught.hash,
        status: 'connected',
        team_damage: { blue: caught.teamDamage.blue, red: caught.teamDamage.red },
        units: Object.values(caught.units).sort((left, right) => (left.id < right.id ? -1 : 1))
          .map((unit) => ({
            alive: unit.health > 0, attacking: unit.attacking, health: unit.health,
            id: unit.id, position: unit.position, team: unit.team, velocity: unit.velocity,
          })),
      };
    });
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

module.exports = { Lockstep };
