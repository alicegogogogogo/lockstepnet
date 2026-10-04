'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { ValidationError } = require('../src/errors');
const { createServer } = require('../src/http');
const { Lockstep } = require('../src/service');
const {
  ErrReplayClosed,
  ErrReplayCorrupt,
  ErrReplayDiverged,
  ErrReplayFrameOrder,
  ErrReplayRange,
  ErrReplayVersion,
  ReplayReader,
  ReplayWriter,
  VerifyReplay,
} = require('../src/replaystream');

const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-replaystream-'));
let databaseCounter = 0;

// `node:sqlite` is experimental and emits a warning on first use.
process.removeAllListeners('warning');
process.on('warning', () => {});

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

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

/** Two units that never reach each other, so every match runs exactly as asked. */
function matchConfig(overrides = {}) {
  return {
    id: 'match-1',
    max_ticks: 64,
    seed: 11,
    units: [
      { id: 'blue-1', position: 990, team: 'blue', velocity: 0 },
      { id: 'red-1', position: 0, team: 'red', velocity: 0 },
    ],
    ...overrides,
  };
}

function input(tick, unit, command) {
  return { command, tick, unit };
}

/** Inputs for ticks 0..7, deliberately not in canonical order. */
const FULL_LOG = Object.freeze([
  input(0, 'red-1', { by: 3, kind: 'move' }),
  input(2, 'red-1', { kind: 'move', position: 120 }),
  input(4, 'red-1', { kind: 'move', velocity: 9 }),
  input(6, 'red-1', { by: -5, kind: 'move' }),
  input(1, 'red-1', { attacking: true, kind: 'attack' }),
  input(3, 'red-1', { attacking: false, kind: 'attack' }),
  input(5, 'red-1', { attacking: true, kind: 'attack' }),
  input(7, 'red-1', { attacking: true, kind: 'attack' }),
  input(0, 'blue-1', { kind: 'move', position: 500 }),
  input(2, 'blue-1', { kind: 'move', velocity: -3 }),
  input(4, 'blue-1', { by: 40, kind: 'move' }),
  input(6, 'blue-1', { kind: 'move', position: 480 }),
  input(0, 'blue-1', { attacking: true, kind: 'attack' }),
  input(2, 'blue-1', { attacking: true, kind: 'attack' }),
  input(6, 'blue-1', { attacking: true, kind: 'attack' }),
]);

let keyCounter = 0;
function key(prefix) {
  keyCounter += 1;
  return `${prefix}-${keyCounter}`;
}

/** A match advanced 8 ticks over the full input log; returns its export. */
function settledMatch(service, log) {
  service.createMatch(matchConfig(), key('create'));
  for (const batch of log) {
    service.submitInputs('match-1', { inputs: batch }, key('inputs'));
  }
  const advanced = service.advance('match-1', { count: 8 }, key('tick'));
  return { advanced, stream: service.replayStream('match-1') };
}

/** Locate the stream's frames and trailer without using the reader. */
function layout(bytes) {
  const headerLength = bytes.readUInt32LE(10);
  const headerEnd = 14 + headerLength;
  const frames = [];
  let offset = headerEnd;
  while (offset < bytes.length - 36) {
    const bodyLength = bytes.readUInt32LE(offset + 4);
    frames.push({ bodyLength, offset, tick: bytes.readUInt32LE(offset) });
    offset += 8 + bodyLength;
  }
  return { frames, headerEnd, headerLength, trailerOffset: offset };
}

/** Recompute the whole-stream checksum after tampering with the content. */
function reseal(bytes) {
  const body = Buffer.from(bytes.subarray(0, bytes.length - 32));
  return Buffer.concat([body, createHash('sha256').update(body).digest()]);
}

/** Rebuild the stream with a changed header object and a fresh checksum. */
function rebuildWithHeader(bytes, mutate) {
  const { headerEnd, headerLength } = layout(bytes);
  const header = JSON.parse(bytes.toString('utf8', 14, headerEnd));
  mutate(header);
  const replacement = Buffer.from(JSON.stringify(header), 'utf8');
  const fixed = Buffer.alloc(14);
  bytes.copy(fixed, 0, 0, 14);
  fixed.writeUInt32LE(replacement.length, 10);
  return reseal(Buffer.concat([fixed, replacement, bytes.subarray(headerEnd)]));
}

function writerOptions() {
  const service = new Lockstep(databasePath());
  try {
    service.createMatch(matchConfig(), key('create'));
    const state = service.getState('match-1');
    return {
      initialStateHash: state.state_hash,
      match: matchConfig(),
    };
  } finally {
    service.close();
  }
}

test('writer commits frames and produces a self-describing stream', () => {
  const options = writerOptions();
  const writer = new ReplayWriter(options);
  writer.appendFrame({ stateHash: 'a'.repeat(64), tick: 1 });
  writer.appendFrame({
    inputs: [
      { participant: 'red-1', payload: '{"command":{"by":3,"kind":"move"},"tick":1,"unit":"red-1"}' },
      { participant: 'blue-1', payload: '{"command":{"attacking":true,"kind":"attack"},"tick":1,"unit":"blue-1"}' },
    ],
    stateHash: 'b'.repeat(64),
    tick: 2,
  });
  const bytes = writer.finalize();
  assert.ok(Buffer.isBuffer(bytes));

  const reader = ReplayReader.parse(bytes);
  assert.equal(reader.metadata.version, 1);
  assert.equal(reader.metadata.seed, 11);
  assert.equal(reader.metadata.maxTicks, 64);
  assert.equal(reader.metadata.startFrame, 1);
  assert.equal(reader.metadata.firstFrame, 1);
  assert.equal(reader.metadata.lastFrame, 2);
  assert.equal(reader.metadata.frameCount, 2);
  assert.deepEqual(reader.metadata.participants, ['blue-1', 'red-1']);
  assert.equal(reader.metadata.initialStateHash, options.initialStateHash);
  assert.equal(reader.frames.length, 2);
  assert.equal(reader.frames[0].inputs.length, 0, 'zero-input frames are preserved');
  assert.equal(reader.frames[1].stateHash, 'b'.repeat(64));
  // Inputs come back sorted by stable participant identifier.
  assert.deepEqual(reader.frames[1].inputs.map((entry) => entry.participant), ['blue-1', 'red-1']);
  assert.deepEqual(reader.frames[1].normalizedInputs(), [
    { command: { attacking: true, kind: 'attack' }, tick: 1, unit: 'blue-1' },
    { command: { by: 3, kind: 'move' }, tick: 1, unit: 'red-1' },
  ]);
  assert.equal(reader.frameAt(2), reader.frames[1]);
  assert.equal(reader.frameAt(9), undefined);
});

test('writer rejects duplicate and out-of-order frames with ErrReplayFrameOrder', () => {
  const writer = new ReplayWriter(writerOptions());
  writer.appendFrame({ stateHash: 'a'.repeat(64), tick: 1 });
  assert.throws(() => writer.appendFrame({ stateHash: 'b'.repeat(64), tick: 1 }), ErrReplayFrameOrder);
  assert.throws(() => writer.appendFrame({ stateHash: 'b'.repeat(64), tick: 3 }), ErrReplayFrameOrder);
  // The rejected frames left no half record behind: tick 2 still commits.
  writer.appendFrame({ stateHash: 'b'.repeat(64), tick: 2 });
  const reader = ReplayReader.parse(writer.finalize());
  assert.deepEqual(reader.frames.map((frame) => frame.tick), [1, 2]);
});

test('writer rejects malformed frames without committing anything', () => {
  const writer = new ReplayWriter(writerOptions());
  assert.throws(() => writer.appendFrame({ stateHash: 'not-a-hash', tick: 1 }), ValidationError);
  assert.throws(
    () => writer.appendFrame({ inputs: [{ participant: 'ghost', payload: 'x' }], stateHash: 'a'.repeat(64), tick: 1 }),
    ValidationError,
  );
  writer.appendFrame({ stateHash: 'a'.repeat(64), tick: 1 });
  assert.equal(ReplayReader.parse(writer.finalize()).metadata.frameCount, 1);
});

test('writer is closed after finalize', () => {
  const writer = new ReplayWriter(writerOptions());
  writer.appendFrame({ stateHash: 'a'.repeat(64), tick: 1 });
  const bytes = writer.finalize();
  assert.throws(() => writer.appendFrame({ stateHash: 'b'.repeat(64), tick: 2 }), ErrReplayClosed);
  assert.deepEqual(writer.finalize(), bytes, 'finalizing twice returns the same bytes');
});

test('exported bytes are identical whatever order the inputs arrived in', () => {
  const forward = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  const interleaved = withService((service) => {
    const batches = [
      [FULL_LOG[14], FULL_LOG[3]],
      [FULL_LOG[8], FULL_LOG[11], FULL_LOG[0]],
      [FULL_LOG[6], FULL_LOG[1], FULL_LOG[13]],
      [FULL_LOG[9], FULL_LOG[4], FULL_LOG[12], FULL_LOG[2]],
      [FULL_LOG[7], FULL_LOG[10], FULL_LOG[5]],
    ];
    return settledMatch(service, batches).stream;
  });
  assert.deepEqual(interleaved, forward);

  // A late input forces a rollback and rebuild; the final timeline - and
  // therefore the exported bytes - is still the same.
  const late = withService((service) => {
    service.createMatch(matchConfig(), key('create'));
    service.submitInputs('match-1', { inputs: FULL_LOG.filter((entry) => entry.tick >= 2) }, key('inputs'));
    service.advance('match-1', { count: 8 }, key('tick'));
    const lateInputs = FULL_LOG.filter((entry) => entry.tick < 2);
    const result = service.submitInputs('match-1', { inputs: lateInputs }, key('inputs'));
    assert.ok(result.rollback, 'the late inputs triggered a rollback');
    return service.replayStream('match-1');
  });
  assert.deepEqual(late, forward);
});

test('reader accepts in-memory bytes and readable streams', async () => {
  const bytes = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  const fromBuffer = await ReplayReader.open(bytes);
  assert.equal(fromBuffer.metadata.frameCount, 8);
  const fromStream = await ReplayReader.open(Readable.from([bytes.subarray(0, 50), bytes.subarray(50)]));
  assert.equal(fromStream.metadata.frameCount, 8);
  const fromUint8 = await ReplayReader.open(new Uint8Array(bytes));
  assert.equal(fromUint8.metadata.frameCount, 8);
  assert.deepEqual([...fromBuffer].map((frame) => frame.tick), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('reader rejects empty, truncated and magic-less data as corrupt', async () => {
  const bytes = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  const { headerEnd } = layout(bytes);
  assert.throws(() => ReplayReader.parse(Buffer.alloc(0)), ErrReplayCorrupt);
  assert.throws(() => ReplayReader.parse(bytes.subarray(0, 10)), ErrReplayCorrupt);
  // A header without a complete trailer is corrupt, not a partial replay.
  assert.throws(() => ReplayReader.parse(bytes.subarray(0, headerEnd + 12)), ErrReplayCorrupt);
  // Truncated mid-frame.
  assert.throws(() => ReplayReader.parse(bytes.subarray(0, bytes.length - 20)), ErrReplayCorrupt);
  const badMagic = Buffer.from(bytes);
  badMagic.write('XXXXXXXX', 0, 'ascii');
  assert.throws(() => ReplayReader.parse(reseal(badMagic)), ErrReplayCorrupt);
  await assert.rejects(() => ReplayReader.open(Buffer.alloc(0)), ErrReplayCorrupt);
});

test('reader reports an unsupported version separately from corruption', () => {
  const bytes = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  const future = Buffer.from(bytes);
  future.writeUInt16LE(99, 8);
  assert.throws(() => ReplayReader.parse(reseal(future)), ErrReplayVersion);
  const headerVersion = rebuildWithHeader(bytes, (header) => {
    header.version = 2;
  });
  assert.throws(() => ReplayReader.parse(headerVersion), ErrReplayVersion);
});

test('reader rejects a tampered checksum and an illegal frame sequence', () => {
  const bytes = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 40] ^= 0xff;
  assert.throws(() => ReplayReader.parse(flipped), ErrReplayCorrupt);

  const { frames } = layout(bytes);
  const skipped = Buffer.from(bytes);
  skipped.writeUInt32LE(frames[1].tick + 5, frames[1].offset);
  assert.throws(() => ReplayReader.parse(reseal(skipped)), ErrReplayCorrupt);
});

test('reader skips unknown extension fields of a compatible version', async () => {
  const bytes = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  const extendedHeader = rebuildWithHeader(bytes, (header) => {
    header.future_extension = { anything: true };
  });
  const reader = ReplayReader.parse(extendedHeader);
  assert.equal(reader.metadata.frameCount, 8);
  const verdict = await VerifyReplay(extendedHeader);
  assert.equal(verdict.finalFrame, 8);

  // Extra bytes at the end of a frame body are a compatible extension too.
  const { frames, trailerOffset } = layout(bytes);
  const first = frames[0];
  const grown = Buffer.concat([
    bytes.subarray(0, first.offset + 4),
    Buffer.from([first.bodyLength + 7, 0, 0, 0]),
    bytes.subarray(first.offset + 8, first.offset + 8 + first.bodyLength),
    Buffer.from('ext-000'),
    bytes.subarray(first.offset + 8 + first.bodyLength),
  ]);
  const resealed = reseal(grown);
  assert.equal(layout(resealed).trailerOffset, trailerOffset + 7);
  assert.equal(ReplayReader.parse(resealed).metadata.frameCount, 8);
  const afterExtension = await VerifyReplay(resealed);
  assert.equal(afterExtension.finalFrame, 8);
});

test('VerifyReplay confirms a stream exported by the service', async () => {
  const { advanced, stream } = withService((service) => settledMatch(service, [FULL_LOG]));
  const verdict = await VerifyReplay(stream);
  assert.equal(verdict.finalFrame, 8);
  assert.equal(verdict.framesVerified, 8);
  assert.equal(verdict.finalStateHash, advanced.frames[advanced.frames.length - 1].state_hash);

  // A restricted range verifies only that window and returns its end.
  const partial = await VerifyReplay(stream, { endFrame: 5, startFrame: 3 });
  assert.equal(partial.finalFrame, 5);
  assert.equal(partial.framesVerified, 3);
  assert.equal(partial.finalStateHash, advanced.frames[4].state_hash);
});

test('VerifyReplay works from a fresh reader with no service state', async () => {
  const stream = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  // A "new process" view: only the bytes, no database.
  const reader = ReplayReader.parse(Buffer.from(stream));
  const verdict = await VerifyReplay(reader);
  assert.equal(verdict.finalFrame, 8);
});

test('VerifyReplay stops at the first diverging frame', async () => {
  const { stream } = withService((service) => settledMatch(service, [FULL_LOG]));
  const { frames } = layout(stream);
  const target = frames[3];
  const tampered = Buffer.from(stream);
  // Corrupt the recorded state hash of frame 4, then reseal the checksum.
  const hashOffset = target.offset + 8 + target.bodyLength - 32;
  tampered[hashOffset] ^= 0x01;
  const expected = tampered.toString('hex', hashOffset, hashOffset + 32);
  try {
    await VerifyReplay(reseal(tampered));
    assert.fail('expected ErrReplayDiverged');
  } catch (error) {
    assert.ok(error instanceof ErrReplayDiverged);
    assert.equal(error.frame, 4);
    assert.equal(error.expectedHash, expected);
    assert.match(error.actualHash, /^[0-9a-f]{64}$/);
    assert.notEqual(error.actualHash, expected);
  }
});

test('VerifyReplay detects a forged initial state hash', async () => {
  const stream = withService((service) => settledMatch(service, [FULL_LOG]).stream);
  const forged = rebuildWithHeader(stream, (header) => {
    header.initial_state_hash = '0'.repeat(64);
  });
  await assert.rejects(
    () => VerifyReplay(forged),
    (error) => error instanceof ErrReplayDiverged && error.frame === 0,
  );
});

test('VerifyReplay rejects out-of-range requests with ErrReplayRange', async () => {
  const { stream } = withService((service) => settledMatch(service, [FULL_LOG]));
  await assert.rejects(() => VerifyReplay(stream, { endFrame: 2, startFrame: 5 }), ErrReplayRange);
  await assert.rejects(() => VerifyReplay(stream, { endFrame: 9 }), ErrReplayRange);
  await assert.rejects(() => VerifyReplay(stream, { startFrame: 0 }), ErrReplayRange);
});

test('VerifyReplay propagates simulation callback errors unchanged', async () => {
  const { stream } = withService((service) => settledMatch(service, [FULL_LOG]));
  const boom = new Error('engine exploded');
  await assert.rejects(
    () => VerifyReplay(stream, {
      simulate: () => {
        throw boom;
      },
    }),
    (error) => error === boom,
  );
});

test('VerifyReplay accepts a custom simulation callback', async () => {
  const { advanced, stream } = withService((service) => settledMatch(service, [FULL_LOG]));
  const sim = require('../src/sim');
  const seen = [];
  const verdict = await VerifyReplay(stream, {
    simulate: (state, inputs, frame) => {
      seen.push({ inputs: inputs.length, tick: frame.tick });
      sim.applyTick(state, inputs);
      return sim.stateHash(state);
    },
  });
  assert.equal(verdict.finalFrame, 8);
  assert.equal(verdict.finalStateHash, advanced.frames[7].state_hash);
  assert.equal(seen.length, 8);
  assert.deepEqual(seen[0], { inputs: 3, tick: 1 });
});

test('the HTTP layer serves the replay stream as octets', async () => {
  const service = new Lockstep(databasePath());
  const server = createServer(service);
  try {
    service.createMatch(matchConfig(), key('create'));
    service.submitInputs('match-1', { inputs: FULL_LOG.slice() }, key('inputs'));
    service.advance('match-1', { count: 8 }, key('tick'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/matches/match-1/replay.stream`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    const bytes = Buffer.from(await response.arrayBuffer());
    const verdict = await VerifyReplay(bytes);
    assert.equal(verdict.finalFrame, 8);
    assert.deepEqual(bytes, service.replayStream('match-1'));
  } finally {
    server.close();
    service.close();
  }
});

test('replay features leave plain sessions and matches untouched', () => {
  withService((service) => {
    service.createMatch(matchConfig(), key('create'));
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, key('session'));
    service.submitSessionInputs('match-1', 'p1', {
      inputs: [input(0, 'red-1', { by: 3, kind: 'move' })],
    }, key('session-inputs'));
    const advanced = service.advance('match-1', { count: 2 }, key('tick'));
    assert.equal(advanced.tick, 2);
    // An unknown replay version never affects ordinary session operation.
    const future = Buffer.from(service.replayStream('match-1'));
    future.writeUInt16LE(99, 8);
    assert.throws(() => ReplayReader.parse(reseal(future)), ErrReplayVersion);
    const state = service.getState('match-1');
    assert.equal(state.tick, 2);
    assert.equal(state.status, 'running');
  });
});
