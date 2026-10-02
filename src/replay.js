'use strict';

const { ValidationError } = require('./errors');
const sim = require('./sim');

/**
 * Replay file format (version 1):
 *
 * {
 *   "version": 1,
 *   "kind": "lockstepnet.replay",
 *   "match": {"id": ..., "seed": ..., "max_ticks": ..., "units": [...]},
 *   "inputs": [ <input record>, ... ],          // whole-match input log
 *   "frames": [                                 // one entry per advanced tick
 *     {"tick": 1, "inputs": ["<canonical input json>", ...],
 *      "state_hash": "<64 hex>", "settled": true, "delta": {...}},
 *     ...
 *   ],
 *   "replay_hash": "<64 hex>"
 * }
 *
 * `replay_hash` is a sha256 over the canonical form of the match configuration,
 * the input records (sorted, so the array order does not matter) and the
 * recorded frame hashes. It is optional on input: when present it is checked.
 */
const FILE_KEYS = ['frames', 'inputs', 'kind', 'match', 'replay_hash', 'version'];
const MATCH_KEYS = ['id', 'max_ticks', 'seed', 'units'];
const FRAME_KEYS = ['delta', 'inputs', 'settled', 'state_hash', 'tick'];
const SHA256 = /^[0-9a-f]{64}$/;

/** Build the replay document for a match from its frames and input log. */
function buildFile(config, frames, inputs) {
  const records = inputs.map((input) => input.body);
  return {
    frames: frames.map((frame) => ({
      delta: frame.delta, inputs: frame.settled_inputs, settled: frame.settled,
      state_hash: frame.state_hash, tick: frame.tick,
    })),
    inputs: records,
    kind: 'lockstepnet.replay',
    match: { id: config.id, max_ticks: config.maxTicks, seed: config.seed, units: config.units },
    replay_hash: sim.fileHash(config, records, frames),
    version: sim.SCHEMA_VERSION,
  };
}

function validateFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('replay must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!FILE_KEYS.includes(key)) {
      throw new ValidationError(`replay has unknown field ${key}`);
    }
  }
  if (raw.kind !== 'lockstepnet.replay') {
    throw new ValidationError('replay kind must be lockstepnet.replay');
  }
  if (raw.version !== sim.SCHEMA_VERSION) {
    throw new ValidationError(`replay version must be ${sim.SCHEMA_VERSION}`);
  }
  if (raw.match && typeof raw.match === 'object' && !Array.isArray(raw.match)) {
    for (const key of Object.keys(raw.match)) {
      if (!MATCH_KEYS.includes(key)) {
        throw new ValidationError(`replay match has unknown field ${key}`);
      }
    }
  }
  const config = sim.parseConfig(raw.match);
  for (const [field, value] of [['inputs', raw.inputs], ['frames', raw.frames]]) {
    if (!Array.isArray(value)) {
      throw new ValidationError(`replay ${field} must be an array`);
    }
  }
  for (const frame of raw.frames) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      throw new ValidationError('each replay frame must be an object');
    }
    for (const key of Object.keys(frame)) {
      if (!FRAME_KEYS.includes(key)) {
        throw new ValidationError(`replay frame has unknown field ${key}`);
      }
    }
    if (!Number.isInteger(frame.tick) || frame.tick < 1) {
      throw new ValidationError('each replay frame tick must be a positive integer');
    }
    if (typeof frame.state_hash !== 'string' || !SHA256.test(frame.state_hash)) {
      throw new ValidationError(`replay frame ${frame.tick} state_hash must be a lowercase sha256 hex digest`);
    }
    if (!Array.isArray(frame.inputs)) {
      throw new ValidationError(`replay frame ${frame.tick} inputs must be an array`);
    }
  }
  return config;
}

/** Group the document's input records by tick; the first record of a key wins. */
function groupInputs(config, records) {
  const unique = new Map();
  for (const record of records) {
    const input = sim.parseInputRecord(record);
    if (input.tick >= config.maxTicks) {
      throw new ValidationError(`input tick ${input.tick} is outside the match length ${config.maxTicks}`);
    }
    const key = `${input.tick}\u0000${input.command.kind}\u0000${input.unit}`;
    if (!unique.has(key)) {
      unique.set(key, input);
    }
  }
  const buckets = new Map();
  for (const input of unique.values()) {
    const bucket = buckets.get(input.tick);
    if (bucket) {
      bucket.push(input);
    } else {
      buckets.set(input.tick, [input]);
    }
  }
  for (const bucket of buckets.values()) {
    bucket.sort(sim.compareInputs);
  }
  return buckets;
}

/**
 * Re-simulate a replay document from tick 0 and compare every recomputed state
 * hash with the recorded one. Inputs are applied in canonical order, so
 * shuffling the document's `inputs` array does not change the result.
 *
 * Returns { config, frames, mismatches, replay_hash, state, state_hash } where
 * `state_hash` is null as soon as any mismatch was found.
 */
function verifyDocument(raw) {
  const config = validateFile(raw);
  const buckets = groupInputs(config, raw.inputs);
  const state = sim.initialState(config);
  const mismatches = [];
  const frames = [];
  for (let index = 0; index < raw.frames.length; index += 1) {
    const frame = raw.frames[index];
    const expectedTick = index + 1;
    if (frame.tick !== expectedTick) {
      mismatches.push({
        expected_tick: expectedTick, kind: 'frame_sequence',
        message: `frame ${index} records tick ${frame.tick} but the log must advance one tick at a time`,
        recorded_tick: frame.tick, tick: expectedTick,
      });
      continue;
    }
    const settled = buckets.get(state.tick) || [];
    const delta = sim.applyTick(state, settled);
    const hash = sim.stateHash(state);
    const recordedInputs = frame.inputs.map((value) => String(value));
    const expectedInputs = settled.map(sim.canonicalInput);
    if (recordedInputs.length !== expectedInputs.length
      || recordedInputs.some((value, position) => value !== expectedInputs[position])) {
      mismatches.push({
        expected: expectedInputs, kind: 'frame_inputs',
        message: `frame ${frame.tick} does not list the canonical inputs of tick ${state.tick - 1}`,
        recorded: recordedInputs, tick: frame.tick,
      });
    }
    if (hash !== frame.state_hash) {
      mismatches.push({
        kind: 'state_hash', message: `frame ${frame.tick} state hash does not match the re-simulation`,
        recorded: frame.state_hash, recomputed: hash, tick: frame.tick,
      });
    }
    frames.push({ delta, state_hash: hash, tick: frame.tick });
  }

  let replayHash = null;
  if (typeof raw.replay_hash === 'string') {
    replayHash = sim.fileHash(config, raw.inputs.map((record) => sim.parseInputRecord(record)),
      raw.frames.map((frame) => ({ state_hash: frame.state_hash, tick: frame.tick })));
    if (replayHash !== raw.replay_hash) {
      mismatches.push({
        kind: 'replay_hash', message: 'replay_hash does not match the canonical fingerprint of this document',
        recorded: raw.replay_hash, recomputed: replayHash,
      });
    }
  }
  return {
    config, frames, mismatches, replay_hash: replayHash, state,
    state_hash: mismatches.length === 0 ? sim.stateHash(state) : null,
  };
}

module.exports = { buildFile, groupInputs, validateFile, verifyDocument };
