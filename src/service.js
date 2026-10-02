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
      const frontier = this.store.readState(matchId).tick;
      const accepted = [];
      const duplicates = [];
      const rejected = [];
      let earliest = null;
      raw.inputs.forEach((entry, index) => {
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
