'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const { ValidationError } = require('../src/errors');
const {
  ErrReplayClosed,
  ErrReplayCorrupt,
  ErrReplayDiverged,
  ErrReplayFrameOrder,
  ErrReplayRange,
  ErrReplayVersion,
  ReplayReader,
  ReplayWriter,
  verifyReplay,
} = require('../src/replaystream');
const { Lockstep } = require('../src/service');
const sim = require('../src/sim');

// `node:sqlite` is experimental and emits a warning on first use.
process.removeAllListeners('warning');
process.on('warning', () => {});

const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-replaystream-'));
let databaseCounter = 0;

function databasePath() {
  databaseCounter += 1;
  return path.join(workspace, `test-${databaseCounter}.db`);
}

function withService(body) {
  const service = new Lockstep(databasePath());
  try {
    return body(service);
  } finally {
    service.close();
  }
}

const H0 = 'aa'.repeat(32);
const H1 = 'bb'.repeat(32);
const H2 = 'cc'.repeat(32);
const H3 = 'dd'.repeat(32);

function makeWriter(overrides = {}) {
  return new ReplayWriter({
    initialStateHash: H0,
    maxTicks: 64,
    participants: ['red-1', 'blue-1'],
    seed: 11,
    startFrame: 1,
    ...overrides,
  });
}

/** Recompute the trailer checksum after tampering with the body. */
function reseal(bytes) {
  const body = Buffer.from(bytes.subarray(0, bytes.length - 32));
  return Buffer.concat([body, createHash('sha256').update(body).digest()]);
}

function validBytes() {
  const writer = makeWriter();
  writer.writeFrame(1, [{ participant: 'red-1', payload: 'r1' }], H1);
  writer.writeFrame(2, [], H2);
  return writer.close();
}

test('writer and reader round-trip: metadata, frames, zero-input frames', () => {
  const writer = makeWriter();
  writer.writeFrame(1, [
    { participant: 'red-1', payload: 'r1' },
    { participant: 'blue-1', payload: Buffer.from('b1') },
  ], H1);
  writer.writeFrame(2, [], H2);
  const reader = new ReplayReader(writer.close());

  assert.equal(reader.metadata.version, 1);
  assert.equal(reader.metadata.seed, 11);
  assert.equal(reader.metadata.maxTicks, 64);
  assert.equal(reader.metadata.startFrame, 1);
  assert.equal(reader.metadata.endFrame, 2);
  assert.equal(reader.metadata.frameCount, 2);
  assert.deepEqual(reader.metadata.participants, ['blue-1', 'red-1']);
  assert.equal(reader.metadata.initialStateHash, H0);

  const frames = [...reader.frames()];
  assert.equal(frames.length, 2);
  assert.equal(frames[0].frame, 1);
  // Inputs come back normalized: sorted by participant identifier.
  assert.deepEqual(
    frames[0].inputs.map((input) => [input.participant, input.payload.toString('utf8')]),
    [['blue-1', 'b1'], ['red-1', 'r1']],
  );
  assert.equal(frames[0].stateHash, H1);
  // The zero-input frame is preserved.
  assert.equal(frames[1].frame, 2);
  assert.deepEqual(frames[1].inputs, []);
  assert.equal(frames[1].stateHash, H2);
});

test('exported bytes are independent of participant and input arrival order', () => {
  const build = (participants, inputs) => {
    const writer = makeWriter({ participants });
    writer.writeFrame(1, inputs, H1);
    writer.writeFrame(2, [], H2);
    return writer.close();
  };
  const inputs = [
    { participant: 'red-1', payload: 'r1' },
    { participant: 'blue-1', payload: 'b1' },
    { participant: 'red-1', payload: 'r2' },
  ];
  const forward = build(['blue-1', 'red-1'], inputs);
  const shuffled = build(['red-1', 'blue-1'], inputs.slice().reverse());
  assert.deepEqual(shuffled, forward);

  // An exact re-delivery of the same payload is recorded once.
  const duplicated = makeWriter();
  duplicated.writeFrame(1, [...inputs, inputs[0]], H1);
  duplicated.writeFrame(2, [], H2);
  assert.deepEqual(duplicated.close(), forward);
});

test('writer rejects duplicate, out-of-order and gapped frames', () => {
  const writer = makeWriter();
  assert.throws(() => writer.writeFrame(2, [], H1), ErrReplayFrameOrder);
  writer.writeFrame(1, [], H1);
  assert.throws(() => writer.writeFrame(1, [], H1), ErrReplayFrameOrder);
  assert.throws(() => writer.writeFrame(3, [], H2), ErrReplayFrameOrder);
  writer.writeFrame(2, [], H2);
  assert.equal(new ReplayReader(writer.close()).metadata.frameCount, 2);
});

test('writing after close fails; close itself is idempotent', () => {
  const writer = makeWriter();
  writer.writeFrame(1, [], H1);
  const bytes = writer.close();
  assert.throws(() => writer.writeFrame(2, [], H2), ErrReplayClosed);
  assert.deepEqual(writer.close(), bytes);
});

test('a rejected frame never leaves half a record behind', () => {
  const writer = makeWriter();
  assert.throws(() => writer.writeFrame(1, [{ participant: 'ghost', payload: 'x' }], H1), ValidationError);
  assert.throws(() => writer.writeFrame(1, [{ participant: 'red-1', payload: 42 }], H1), ValidationError);
  assert.throws(() => writer.writeFrame(1, [], 'not-a-hash'), ValidationError);
  // The next expected frame is still 1 and records cleanly.
  writer.writeFrame(1, [{ participant: 'red-1', payload: 'r1' }], H1);
  const frames = [...new ReplayReader(writer.close()).frames()];
  assert.equal(frames.length, 1);
  assert.equal(frames[0].inputs.length, 1);
});

test('reader rejects empty, truncated, mislabelled and resealed-garbage data', () => {
  const bytes = validBytes();
  const headerLength = bytes.readUInt32BE(12);

  assert.throws(() => new ReplayReader(Buffer.alloc(0)), ErrReplayCorrupt);
  assert.throws(() => new ReplayReader(bytes.subarray(0, 20)), ErrReplayCorrupt);
  // A header without the complete trailer is corrupt.
  assert.throws(() => new ReplayReader(bytes.subarray(0, 16 + headerLength)), ErrReplayCorrupt);
  // Trailing garbage breaks the structural boundary.
  assert.throws(() => new ReplayReader(Buffer.concat([bytes, Buffer.from('x')])), ErrReplayCorrupt);

  const badMagic = Buffer.from(bytes);
  badMagic[0] ^= 0xff;
  assert.throws(() => new ReplayReader(reseal(badMagic)), ErrReplayCorrupt);

  const badChecksum = Buffer.from(bytes);
  badChecksum[badChecksum.length - 1] ^= 0xff;
  assert.throws(() => new ReplayReader(badChecksum), ErrReplayCorrupt);

  // Break the frame sequence: the second record claims to be frame 5.
  const firstFrameSize = 6 + (6 + 2) + 32;
  const secondFrameAt = 16 + headerLength + firstFrameSize;
  const badSequence = Buffer.from(bytes);
  badSequence.writeUInt32BE(5, secondFrameAt);
  assert.throws(() => new ReplayReader(reseal(badSequence)), ErrReplayCorrupt);

  // An input that references a participant outside the table.
  const badParticipant = Buffer.from(bytes);
  badParticipant.writeUInt16BE(9, 16 + headerLength + 6);
  assert.throws(() => new ReplayReader(reseal(badParticipant)), ErrReplayCorrupt);
});

test('unsupported major versions are reported separately from corruption', () => {
  const bytes = validBytes();
  const future = Buffer.from(bytes);
  future.writeUInt16BE(2, 8);
  assert.throws(() => new ReplayReader(reseal(future)), ErrReplayVersion);

  // A compatible minor revision still reads; unknown extensions are skipped.
  const minor = Buffer.from(bytes);
  minor.writeUInt16BE(7, 10);
  const reader = new ReplayReader(reseal(minor));
  assert.equal(reader.metadata.minor, 7);
  assert.equal(reader.metadata.frameCount, 2);
});

test('unknown extension fields are carried through and safely skipped', () => {
  const writer = makeWriter({
    extensions: [{ tag: 42, value: 'hello' }, { tag: 7, value: Buffer.from([1, 2]) }],
  });
  writer.writeFrame(1, [], H1);
  const reader = new ReplayReader(writer.close());
  assert.equal(reader.extension(42).toString('utf8'), 'hello');
  assert.deepEqual(reader.extension(7), Buffer.from([1, 2]));
  assert.equal(reader.extension(99), null);
  assert.equal(reader.extensions.length, 2);
});

test('the reader accepts any byte stream, not just contiguous memory', async () => {
  const bytes = validBytes();
  const reader = await ReplayReader.fromStream(Readable.from([bytes.subarray(0, 11), bytes.subarray(11)]));
  assert.equal(reader.metadata.frameCount, 2);
  assert.equal([...reader.frames()][1].stateHash, H2);
});

test('an empty recording verifies against its initial hash', () => {
  const bytes = makeWriter().close();
  const reader = new ReplayReader(bytes);
  assert.equal(reader.metadata.frameCount, 0);
  assert.equal(reader.metadata.endFrame, 0);
  assert.deepEqual([...reader.frames()], []);
  const result = verifyReplay(bytes, {
    simulate: () => {
      throw new Error('must not be called');
    },
  });
  assert.deepEqual(result, { finalFrame: 0, stateHash: H0 });
});

const CONFIG = {
  id: 'stream-1',
  max_ticks: 64,
  seed: 11,
  units: [
    { id: 'blue-1', position: 990, team: 'blue', velocity: 0 },
    { id: 'red-1', position: 0, team: 'red', velocity: 0 },
  ],
};

const TICK_INPUTS = [
  [
    { command: { by: 3, kind: 'move' }, tick: 0, unit: 'red-1' },
    { command: { attacking: true, kind: 'attack' }, tick: 0, unit: 'blue-1' },
  ],
  [],
  [{ command: { attacking: true, kind: 'attack' }, tick: 2, unit: 'red-1' }],
  [],
];

/** Record a real timeline with the deterministic engine and seal it. */
function recordTimeline() {
  const config = sim.parseConfig(CONFIG);
  const state = sim.initialState(config);
  const writer = new ReplayWriter({
    initialStateHash: sim.stateHash(state),
    maxTicks: config.maxTicks,
    participants: config.units.map((unit) => unit.id),
    seed: config.seed,
    startFrame: 1,
  });
  const hashes = [];
  TICK_INPUTS.forEach((records, index) => {
    const parsed = records.map(sim.parseInputRecord).sort(sim.compareInputs);
    const inputs = parsed.map((input) => ({ participant: input.unit, payload: sim.canonicalInput(input) }));
    sim.applyTick(state, parsed);
    const hash = sim.stateHash(state);
    hashes.push(hash);
    writer.writeFrame(index + 1, inputs, hash);
  });
  return { bytes: writer.close(), config, hashes };
}

/** A simulate callback that re-runs the recorded frames with the real engine. */
function simulator(config) {
  const state = sim.initialState(config);
  return (frame, inputs) => {
    const records = inputs.map((input) => sim.parseInputRecord(JSON.parse(input.payload.toString('utf8'))));
    records.sort(sim.compareInputs);
    sim.applyTick(state, records);
    return sim.stateHash(state);
  };
}

test('verifyReplay re-simulates the timeline and returns the final frame and hash', () => {
  const { bytes, config, hashes } = recordTimeline();
  const result = verifyReplay(bytes, { simulate: simulator(config) });
  assert.deepEqual(result, { finalFrame: 4, stateHash: hashes[3] });

  // A reader instance and a windowed range work too.
  const windowed = verifyReplay(new ReplayReader(bytes), {
    endFrame: 3,
    simulate: simulator(config),
    startFrame: 2,
  });
  assert.deepEqual(windowed, { finalFrame: 3, stateHash: hashes[2] });
});

test('verifyReplay stops at the first diverging frame with both hashes', () => {
  const { bytes, config, hashes } = recordTimeline();
  const tampered = Buffer.from(bytes);
  const forged = 'ff'.repeat(32);
  const at = tampered.indexOf(Buffer.from(hashes[1], 'hex'));
  assert.notEqual(at, -1);
  tampered.fill(Buffer.from(forged, 'hex'), at, at + 32);
  try {
    verifyReplay(reseal(tampered), { simulate: simulator(config) });
    assert.fail('expected ErrReplayDiverged');
  } catch (error) {
    assert.ok(error instanceof ErrReplayDiverged);
    assert.equal(error.frame, 2);
    assert.equal(error.expected, forged);
    assert.equal(error.actual, hashes[1]);
  }
});

test('verifyReplay rejects ranges outside the recorded timeline', () => {
  const { bytes, config } = recordTimeline();
  const simulate = simulator(config);
  assert.throws(() => verifyReplay(bytes, { endFrame: 5, simulate }), ErrReplayRange);
  assert.throws(() => verifyReplay(bytes, { simulate, startFrame: 0 }), ErrReplayRange);
  assert.throws(() => verifyReplay(bytes, { endFrame: 2, simulate, startFrame: 3 }), ErrReplayRange);
  assert.throws(() => verifyReplay(bytes, { simulate, startFrame: 5 }), ErrReplayRange);
});

test('a failing simulate callback keeps its own error', () => {
  const { bytes } = recordTimeline();
  const boom = new Error('engine exploded');
  assert.throws(
    () => verifyReplay(bytes, { simulate: () => { throw boom; } }),
    (error) => error === boom,
  );
});

test('verifyReplay can check the recorded initial state hash', () => {
  const { bytes, config, hashes } = recordTimeline();
  const initial = sim.stateHash(sim.initialState(config));
  const result = verifyReplay(bytes, { initialStateHash: initial, simulate: simulator(config) });
  assert.equal(result.stateHash, hashes[3]);
  assert.throws(
    () => verifyReplay(bytes, { initialStateHash: H3, simulate: simulator(config) }),
    (error) => error instanceof ErrReplayDiverged && error.frame === 0,
  );
});

const MATCH = {
  id: 'match-1',
  max_ticks: 64,
  seed: 11,
  units: [
    { id: 'blue-1', position: 990, team: 'blue', velocity: 0 },
    { id: 'red-1', position: 0, team: 'red', velocity: 0 },
  ],
};

/** Two inputs per tick for ticks 0..7, ordered by tick. */
const LOG = [];
for (let tick = 0; tick < 8; tick += 1) {
  LOG.push({ command: { by: tick % 2 === 0 ? 3 : -2, kind: 'move' }, tick, unit: 'red-1' });
  LOG.push({ command: { attacking: tick % 2 === 0, kind: 'attack' }, tick, unit: 'blue-1' });
}

test('a stored match exports to a stream another process can verify', () => {
  withService((service) => {
    service.createMatch(MATCH, 'create-1');
    service.submitInputs('match-1', { inputs: LOG }, 'inputs-1');
    service.advance('match-1', { count: 8 }, 'tick-1');
    const bytes = service.exportReplay('match-1');
    const expected = service.getState('match-1').state_hash;
    // The verifying side is a fresh service with its own database: the stream
    // alone (configuration extension included) is enough.
    withService((other) => {
      const result = other.verifyReplayBytes(bytes);
      assert.equal(result.match_id, 'match-1');
      assert.equal(result.final_frame, 8);
      assert.equal(result.state_hash, expected);
    });
  });
});

test('export bytes are identical however the inputs arrived', () => {
  const build = (late) => withService((service) => {
    service.createMatch(MATCH, 'create-1');
    if (late) {
      // Half the log arrives after the frontier passed it: rollback + rebuild.
      service.submitInputs('match-1', { inputs: LOG.slice(0, 8) }, 'inputs-1');
      service.advance('match-1', { count: 8 }, 'tick-1');
      service.submitInputs('match-1', { inputs: LOG.slice(8).reverse() }, 'inputs-2');
    } else {
      service.submitInputs('match-1', { inputs: LOG }, 'inputs-1');
      service.advance('match-1', { count: 8 }, 'tick-1');
    }
    return service.exportReplay('match-1');
  });
  assert.deepEqual(build(true), build(false));
});

test('exported zero-input frames survive the round trip', () => {
  withService((service) => {
    service.createMatch(MATCH, 'create-1');
    service.advance('match-1', { count: 3 }, 'tick-1');
    const bytes = service.exportReplay('match-1');
    const frames = [...new ReplayReader(bytes).frames()];
    assert.equal(frames.length, 3);
    assert.ok(frames.every((frame) => frame.inputs.length === 0));
    withService((other) => {
      const result = other.verifyReplayBytes(bytes);
      assert.equal(result.final_frame, 3);
      assert.equal(result.state_hash, service.getState('match-1').state_hash);
    });
  });
});
