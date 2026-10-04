'use strict';

const { createHash } = require('node:crypto');
const { LockstepError, ValidationError } = require('./errors');
const sim = require('./sim');

/**
 * Self-describing replay byte stream (format version 1).
 *
 * A replay stream is the transferable form of one determined match timeline:
 * the initial conditions, every confirmed frame in order and a whole-stream
 * checksum, laid out as
 *
 *   header  := magic(8) version(uint16 LE) header_length(uint32 LE) header_json
 *   magic   := "LSNRPLY1"
 *   header_json := canonical JSON (sorted keys, no whitespace):
 *     { "initial_state_hash": "<64 hex>",
 *       "kind": "lockstepnet.replay.stream",
 *       "match": {"id","max_ticks","seed","units":[...]},   // initial conditions
 *       "max_ticks": <int>,                                  // tick/step configuration
 *       "participants": ["<unit id>", ...],                  // sorted, stable ids
 *       "seed": <int>,
 *       "start_frame": <int >= 1>,
 *       "version": 1 }
 *   frame   := tick(uint32 LE) body_length(uint32 LE) body
 *   body    := input_count(uint16 LE) inputs... state_hash(32 bytes) [extension]
 *   input   := participant_index(uint16 LE) payload_length(uint32 LE) payload
 *   trailer := frame_count(uint32 LE) checksum(32 bytes)
 *   checksum := sha256 of every byte before the checksum field
 *
 * Input payloads are kept as raw bytes; the writer stores the canonical input
 * JSON produced by the engine. Inputs inside a frame are sorted by stable
 * participant identifier (ties by payload bytes), so the exported byte sequence
 * is a pure function of the initial conditions and the final timeline - never
 * of the order inputs originally arrived in. Bytes after a frame's state hash
 * up to `body_length` are an extension area: readers of compatible versions
 * skip them, so future fields never break old readers.
 */

const MAGIC = Buffer.from('LSNRPLY1', 'ascii');
const VERSION = 1;
const KIND = 'lockstepnet.replay.stream';
const HASH_HEX = /^[0-9a-f]{64}$/;
const FIXED_HEADER_BYTES = MAGIC.length + 2 + 4;
const TRAILER_BYTES = 4 + 32;
const MAX_HEADER_BYTES = 1_000_000;
const MAX_FRAME_BYTES = 16_000_000;
const MAX_FRAME_INPUTS = 0xffff;

/** A recorded frame's inputs were not monotonically advancing. */
class ErrReplayFrameOrder extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'replay_frame_order';
    this.status = 409;
  }
}

/** A write was attempted after the stream was finalized. */
class ErrReplayClosed extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'replay_closed';
    this.status = 409;
  }
}

/** The byte stream failed structural or checksum validation. */
class ErrReplayCorrupt extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'replay_corrupt';
    this.status = 400;
  }
}

/** The stream was written by an unsupported format version. */
class ErrReplayVersion extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'replay_version';
    this.status = 400;
  }
}

/** Re-simulation produced a different state hash than the stream recorded. */
class ErrReplayDiverged extends LockstepError {
  constructor(frame, expectedHash, actualHash) {
    super(`frame ${frame} diverged: the stream records ${expectedHash} but re-simulation produced ${actualHash}`);
    this.code = 'replay_diverged';
    this.status = 409;
    this.frame = frame;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/** The requested frame range is empty or outside the recorded timeline. */
class ErrReplayRange extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'replay_range';
    this.status = 400;
  }
}

/** Canonical JSON with sorted keys: the byte-exact form of the stream header. */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function toBuffer(value, field) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  throw new ValidationError(`${field} must be bytes (Buffer, Uint8Array, ArrayBuffer) or a string`);
}

function hashHex(value, field) {
  if (typeof value !== 'string' || !HASH_HEX.test(value)) {
    throw new ValidationError(`${field} must be a lowercase sha256 hex digest`);
  }
  return value;
}

/** Order two frame inputs by stable participant identifier, then payload bytes. */
function compareFrameInputs(left, right) {
  if (left.participant !== right.participant) {
    return left.participant < right.participant ? -1 : 1;
  }
  return Buffer.compare(left.payload, right.payload);
}

/**
 * Recording entry point: accepts only monotonically advancing confirmed frames
 * and finalizes them into the transferable byte stream.
 *
 *   const writer = new ReplayWriter({ match, initialStateHash, startFrame: 1 });
 *   writer.appendFrame({ tick: 1, stateHash, inputs: [{ participant, payload }] });
 *   const bytes = writer.finalize();
 *
 * `appendFrame` validates a frame completely before committing it, so a
 * rejected frame never leaves half a record behind: the next expected tick is
 * unchanged and the same frame can be retried. A duplicate or out-of-order
 * tick raises ErrReplayFrameOrder; any write after `finalize` raises
 * ErrReplayClosed.
 */
class ReplayWriter {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError('replay writer options must be an object');
    }
    // The match configuration is the recorded initial condition; it is what
    // VerifyReplay later re-simulates from.
    const config = sim.parseConfig(options.match);
    const seed = options.seed === undefined ? config.seed : sim.integer(options.seed, 'seed', 0, 2147483647);
    if (seed !== config.seed) {
      throw new ValidationError('seed must match the match configuration');
    }
    const maxTicks = options.maxTicks === undefined
      ? config.maxTicks
      : sim.integer(options.maxTicks, 'max_ticks', 1, sim.MAX_TICKS_LIMIT);
    if (maxTicks !== config.maxTicks) {
      throw new ValidationError('max_ticks must match the match configuration');
    }
    const unitIds = config.units.map((unit) => unit.id);
    const participants = (options.participants === undefined ? unitIds : options.participants);
    if (!Array.isArray(participants) || participants.length === 0) {
      throw new ValidationError('participants must be a non-empty array of unit ids');
    }
    const sorted = participants.map((id, index) => sim.identifier(id, `participant ${index}`)).sort();
    if (new Set(sorted).size !== sorted.length
      || sorted.length !== unitIds.length
      || sorted.some((id, index) => id !== unitIds[index])) {
      throw new ValidationError('participants must be exactly the distinct unit ids of the match');
    }
    const startFrame = options.startFrame === undefined ? 1 : options.startFrame;
    if (!Number.isInteger(startFrame) || startFrame < 1) {
      throw new ValidationError('start frame must be a positive integer');
    }
    this.config = config;
    this.initialStateHash = hashHex(options.initialStateHash, 'initial state hash');
    this.maxTicks = maxTicks;
    this.participants = sorted;
    this.seed = seed;
    this.startFrame = startFrame;
    this.bytes = null;
    this.chunks = [];
    this.closed = false;
    this.frameCount = 0;
    this.nextTick = startFrame;
  }

  /**
   * Commit one confirmed frame. `frame` is `{tick, stateHash, inputs}` where
   * each input is `{participant, payload}` and `payload` is kept as raw bytes.
   * Inputs are stored sorted by participant id, so the committed record does
   * not depend on the order they were passed in.
   */
  appendFrame(frame) {
    if (this.closed) {
      throw new ErrReplayClosed('the replay stream is finalized and no longer accepts frames');
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      throw new ValidationError('frame must be an object');
    }
    if (!Number.isInteger(frame.tick)) {
      throw new ValidationError('frame tick must be an integer');
    }
    if (frame.tick !== this.nextTick) {
      throw new ErrReplayFrameOrder(`frame ${frame.tick} does not continue the timeline: frame ${this.nextTick} is expected next`);
    }
    const stateHash = hashHex(frame.stateHash, `frame ${frame.tick} state hash`);
    const entries = frame.inputs === undefined ? [] : frame.inputs;
    if (!Array.isArray(entries)) {
      throw new ValidationError(`frame ${frame.tick} inputs must be an array`);
    }
    if (entries.length > MAX_FRAME_INPUTS) {
      throw new ValidationError(`frame ${frame.tick} carries more than ${MAX_FRAME_INPUTS} inputs`);
    }
    // Everything below only builds the record; the writer state changes once,
    // after every field has validated, so a rejected frame leaves no trace.
    const inputs = entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ValidationError(`frame ${frame.tick} input ${index} must be an object`);
      }
      const participant = sim.identifier(entry.participant, `frame ${frame.tick} input ${index} participant`);
      if (!this.participants.includes(participant)) {
        throw new ValidationError(`frame ${frame.tick} input ${index} references non-participant ${participant}`);
      }
      const payload = toBuffer(entry.payload, `frame ${frame.tick} input ${index} payload`);
      if (payload.length > MAX_FRAME_BYTES) {
        throw new ValidationError(`frame ${frame.tick} input ${index} payload is too large`);
      }
      return { participant, payload };
    }).sort(compareFrameInputs);

    let bodyLength = 2 + 32;
    for (const input of inputs) {
      bodyLength += 6 + input.payload.length;
    }
    const chunk = Buffer.alloc(8 + bodyLength);
    chunk.writeUInt32LE(frame.tick, 0);
    chunk.writeUInt32LE(bodyLength, 4);
    chunk.writeUInt16LE(inputs.length, 8);
    let cursor = 10;
    for (const input of inputs) {
      chunk.writeUInt16LE(this.participants.indexOf(input.participant), cursor);
      chunk.writeUInt32LE(input.payload.length, cursor + 2);
      input.payload.copy(chunk, cursor + 6);
      cursor += 6 + input.payload.length;
    }
    Buffer.from(stateHash, 'hex').copy(chunk, cursor);

    this.chunks.push(chunk);
    this.nextTick = frame.tick + 1;
    this.frameCount += 1;
    return this;
  }

  /**
   * Seal the stream and return its bytes. Finalizing is idempotent; writing
   * more frames afterwards is not and raises ErrReplayClosed.
   */
  finalize() {
    if (this.closed) {
      return this.bytes;
    }
    const header = Buffer.from(canonicalJson({
      initial_state_hash: this.initialStateHash,
      kind: KIND,
      match: {
        id: this.config.id,
        max_ticks: this.config.maxTicks,
        seed: this.config.seed,
        units: this.config.units,
      },
      max_ticks: this.maxTicks,
      participants: this.participants,
      seed: this.seed,
      start_frame: this.startFrame,
      version: VERSION,
    }), 'utf8');
    if (header.length > MAX_HEADER_BYTES) {
      throw new ValidationError(`replay header must be at most ${MAX_HEADER_BYTES} bytes`);
    }
    const fixed = Buffer.alloc(FIXED_HEADER_BYTES);
    MAGIC.copy(fixed, 0);
    fixed.writeUInt16LE(VERSION, MAGIC.length);
    fixed.writeUInt32LE(header.length, MAGIC.length + 2);
    const count = Buffer.alloc(4);
    count.writeUInt32LE(this.frameCount, 0);
    const body = Buffer.concat([fixed, header, ...this.chunks, count]);
    this.bytes = Buffer.concat([body, createHash('sha256').update(body).digest()]);
    this.closed = true;
    return this.bytes;
  }
}

/** Validate the decoded header JSON; unknown extension fields are skipped. */
function parseHeader(header) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new ErrReplayCorrupt('replay header must be an object');
  }
  if (header.kind !== KIND) {
    throw new ErrReplayCorrupt(`replay kind must be ${KIND}`);
  }
  if (header.version === undefined) {
    throw new ErrReplayCorrupt('replay header must carry a format version');
  }
  if (header.version !== VERSION) {
    throw new ErrReplayVersion(`replay format version ${header.version} is not supported`);
  }
  const corruptInteger = (field) => new ErrReplayCorrupt(`replay header ${field} must be an integer in range`);
  if (!Number.isInteger(header.seed) || header.seed < 0 || header.seed > 2147483647) {
    throw corruptInteger('seed');
  }
  if (!Number.isInteger(header.max_ticks) || header.max_ticks < 1 || header.max_ticks > sim.MAX_TICKS_LIMIT) {
    throw corruptInteger('max_ticks');
  }
  if (!Number.isInteger(header.start_frame) || header.start_frame < 1) {
    throw corruptInteger('start_frame');
  }
  if (typeof header.initial_state_hash !== 'string' || !HASH_HEX.test(header.initial_state_hash)) {
    throw new ErrReplayCorrupt('replay header initial_state_hash must be a lowercase sha256 hex digest');
  }
  if (!Array.isArray(header.participants) || header.participants.length === 0) {
    throw new ErrReplayCorrupt('replay header participants must be a non-empty array');
  }
  const participants = header.participants.map((id) => {
    try {
      return sim.identifier(id, 'participant');
    } catch (error) {
      throw new ErrReplayCorrupt(`replay header participant is invalid: ${error.message}`);
    }
  });
  if (new Set(participants).size !== participants.length) {
    throw new ErrReplayCorrupt('replay header participants must be distinct');
  }
  participants.sort();
  let config;
  try {
    config = sim.parseConfig(header.match);
  } catch (error) {
    throw new ErrReplayCorrupt(`replay header match configuration is invalid: ${error.message}`);
  }
  const unitIds = config.units.map((unit) => unit.id);
  if (config.seed !== header.seed || config.maxTicks !== header.max_ticks
    || participants.length !== unitIds.length
    || participants.some((id, index) => id !== unitIds[index])) {
    throw new ErrReplayCorrupt('replay header seed, max_ticks and participants must match the match configuration');
  }
  return {
    config,
    initialStateHash: header.initial_state_hash,
    match: header.match,
    maxTicks: header.max_ticks,
    participants,
    seed: header.seed,
    startFrame: header.start_frame,
  };
}

/**
 * Reading entry point: validates a replay stream in full - fixed identifier,
 * format version, structural boundaries and the whole-stream checksum - before
 * any frame is exposed, then offers the metadata and per-frame iteration.
 *
 *   const reader = await ReplayReader.open(source); // bytes or a readable stream
 *   for (const frame of reader) { ... }
 *
 * A source may be in-memory bytes (Buffer, Uint8Array, ArrayBuffer, string) or
 * an existing stream interface (a Node readable or a WHATWG ReadableStream);
 * nothing touches the file system. Any structural defect raises
 * ErrReplayCorrupt, an unsupported format version raises ErrReplayVersion, and
 * a failed validation never yields a partially usable replay.
 */
class ReplayReader {
  constructor(bytes) {
    const buffer = toBuffer(bytes, 'replay');
    if (buffer.length < FIXED_HEADER_BYTES + TRAILER_BYTES) {
      throw new ErrReplayCorrupt('replay stream is truncated: it is shorter than the fixed header and trailer');
    }
    if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new ErrReplayCorrupt('replay stream does not start with the lockstepnet replay identifier');
    }
    const version = buffer.readUInt16LE(MAGIC.length);
    if (version !== VERSION) {
      throw new ErrReplayVersion(`replay format version ${version} is not supported`);
    }
    const headerLength = buffer.readUInt32LE(MAGIC.length + 2);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw new ErrReplayCorrupt('replay header length is out of bounds');
    }
    const headerEnd = FIXED_HEADER_BYTES + headerLength;
    if (headerEnd + TRAILER_BYTES > buffer.length) {
      throw new ErrReplayCorrupt('replay stream is truncated inside the header');
    }
    const checksum = createHash('sha256').update(buffer.subarray(0, buffer.length - 32)).digest();
    if (!checksum.equals(buffer.subarray(buffer.length - 32))) {
      throw new ErrReplayCorrupt('replay stream checksum does not match its content');
    }
    let header;
    try {
      header = JSON.parse(buffer.toString('utf8', FIXED_HEADER_BYTES, headerEnd));
    } catch {
      throw new ErrReplayCorrupt('replay header is not valid JSON');
    }
    const meta = parseHeader(header);

    const frames = [];
    let offset = headerEnd;
    while (offset < buffer.length - TRAILER_BYTES) {
      if (offset + 8 > buffer.length - TRAILER_BYTES) {
        throw new ErrReplayCorrupt('replay stream is truncated inside a frame header');
      }
      const tick = buffer.readUInt32LE(offset);
      const bodyLength = buffer.readUInt32LE(offset + 4);
      if (bodyLength < 2 + 32 || bodyLength > MAX_FRAME_BYTES) {
        throw new ErrReplayCorrupt(`frame ${tick} body length is out of bounds`);
      }
      const bodyStart = offset + 8;
      const bodyEnd = bodyStart + bodyLength;
      if (bodyEnd > buffer.length - TRAILER_BYTES) {
        throw new ErrReplayCorrupt(`replay stream is truncated inside frame ${tick}`);
      }
      const expectedTick = meta.startFrame + frames.length;
      if (tick !== expectedTick) {
        throw new ErrReplayCorrupt(`frame ${tick} breaks the frame sequence: frame ${expectedTick} is expected`);
      }
      frames.push(parseFrameBody(buffer, tick, bodyStart, bodyEnd, meta.participants));
      offset = bodyEnd;
    }
    if (offset !== buffer.length - TRAILER_BYTES) {
      throw new ErrReplayCorrupt('replay stream is truncated before its trailer');
    }
    const frameCount = buffer.readUInt32LE(buffer.length - TRAILER_BYTES);
    if (frameCount !== frames.length) {
      throw new ErrReplayCorrupt(`replay trailer records ${frameCount} frames but the stream carries ${frames.length}`);
    }

    this.meta = Object.freeze({
      firstFrame: meta.startFrame,
      frameCount: frames.length,
      initialStateHash: meta.initialStateHash,
      kind: KIND,
      lastFrame: meta.startFrame + frames.length - 1,
      match: meta.match,
      maxTicks: meta.maxTicks,
      participants: Object.freeze(meta.participants.slice()),
      seed: meta.seed,
      startFrame: meta.startFrame,
      version: VERSION,
    });
    this.frameList = Object.freeze(frames);
  }

  /** Open a replay from in-memory bytes or from an existing readable stream. */
  static async open(source) {
    if (source instanceof ReplayReader) {
      return source;
    }
    if (Buffer.isBuffer(source) || source instanceof Uint8Array
      || source instanceof ArrayBuffer || typeof source === 'string') {
      return new ReplayReader(source);
    }
    if (source && typeof source[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of source) {
        chunks.push(toBuffer(chunk, 'replay stream chunk'));
      }
      return new ReplayReader(Buffer.concat(chunks));
    }
    if (source && typeof source.getReader === 'function') {
      const streamReader = source.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await streamReader.read();
        if (done) {
          break;
        }
        chunks.push(toBuffer(value, 'replay stream chunk'));
      }
      return new ReplayReader(Buffer.concat(chunks));
    }
    throw new ValidationError('replay source must be bytes or a readable stream');
  }

  /** Synchronous open for in-memory bytes. */
  static parse(bytes) {
    return new ReplayReader(bytes);
  }

  /** Stream metadata: version, seed, tick configuration, participants, range. */
  get metadata() {
    return this.meta;
  }

  /** The recorded frames in tick order; zero-input frames are preserved. */
  get frames() {
    return this.frameList;
  }

  /** The frame recorded for `tick`, or undefined when it is not in the stream. */
  frameAt(tick) {
    return this.frameList.find((frame) => frame.tick === tick);
  }

  [Symbol.iterator]() {
    return this.frameList[Symbol.iterator]();
  }
}

function parseFrameBody(buffer, tick, bodyStart, bodyEnd, participants) {
  const inputCount = buffer.readUInt16LE(bodyStart);
  let cursor = bodyStart + 2;
  const inputs = [];
  for (let index = 0; index < inputCount; index += 1) {
    if (cursor + 6 > bodyEnd - 32) {
      throw new ErrReplayCorrupt(`frame ${tick} input ${index} is out of bounds`);
    }
    const participantIndex = buffer.readUInt16LE(cursor);
    const payloadLength = buffer.readUInt32LE(cursor + 2);
    cursor += 6;
    if (participantIndex >= participants.length) {
      throw new ErrReplayCorrupt(`frame ${tick} input ${index} references an unknown participant`);
    }
    if (cursor + payloadLength > bodyEnd - 32) {
      throw new ErrReplayCorrupt(`frame ${tick} input ${index} payload is out of bounds`);
    }
    inputs.push({
      participant: participants[participantIndex],
      payload: Buffer.from(buffer.subarray(cursor, cursor + payloadLength)),
    });
    cursor += payloadLength;
  }
  const stateHash = buffer.toString('hex', cursor, cursor + 32);
  // Bytes between the state hash and bodyEnd are a compatible-version
  // extension area and are skipped on purpose.
  const frame = {
    inputs: Object.freeze(inputs.sort(compareFrameInputs)),
    stateHash,
    tick,
    /**
     * The frame's inputs decoded from their canonical JSON payloads, sorted by
     * stable participant identifier. A payload that is not canonical JSON
     * cannot drive the deterministic simulation and is reported as corrupt.
     */
    normalizedInputs() {
      return frame.inputs.map((input) => {
        try {
          return JSON.parse(input.payload.toString('utf8'));
        } catch {
          throw new ErrReplayCorrupt(`frame ${frame.tick} input payload is not canonical JSON`);
        }
      });
    },
  };
  return Object.freeze(frame);
}

/**
 * Verification entry point: re-simulate a replay stream from its recorded
 * initial conditions, strictly advancing by the recorded frame numbers, and
 * compare every frame's state hash with the recorded one.
 *
 *   const { finalFrame, finalStateHash } = await VerifyReplay(bytes);
 *
 * `source` is anything ReplayReader.open accepts. Options:
 *   - startFrame / endFrame: restrict the compared range (defaults to the
 *     whole recording). An end frame before the start frame, or a range
 *     outside the recorded frames, raises ErrReplayRange. Frames before
 *     startFrame are still simulated so the state advances correctly.
 *   - simulate(state, inputs, frame): custom step callback standing in for
 *     the deterministic engine. It may return the new state hash; when it
 *     returns nothing the state is hashed with the canonical rule. An error
 *     it throws is propagated unchanged - never reclassified as corruption
 *     or divergence.
 *
 * The first hash mismatch stops the verification and raises ErrReplayDiverged
 * carrying the diverging frame, the recorded (expected) hash and the actual
 * recomputed hash. When every frame matches, the final frame number and the
 * final state hash are returned.
 */
async function VerifyReplay(source, options = {}) {
  const reader = await ReplayReader.open(source);
  const meta = reader.metadata;
  const startFrame = options.startFrame === undefined ? meta.firstFrame : options.startFrame;
  const endFrame = options.endFrame === undefined ? meta.lastFrame : options.endFrame;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) {
    throw new ErrReplayRange('start and end frames must be integers');
  }
  if (options.simulate !== undefined && typeof options.simulate !== 'function') {
    throw new ValidationError('simulate must be a function');
  }
  const step = options.simulate || ((state, inputs) => {
    sim.applyTick(state, inputs);
    return sim.stateHash(state);
  });
  const config = sim.parseConfig(meta.match);
  const state = sim.initialState(config);
  let hash = sim.stateHash(state);
  if (hash !== meta.initialStateHash) {
    throw new ErrReplayDiverged(meta.firstFrame - 1, meta.initialStateHash, hash);
  }
  if (meta.frameCount === 0) {
    if (options.startFrame !== undefined || options.endFrame !== undefined) {
      throw new ErrReplayRange('the replay records no frames');
    }
    return { finalFrame: meta.firstFrame - 1, finalStateHash: hash, framesVerified: 0 };
  }
  if (endFrame < startFrame) {
    throw new ErrReplayRange(`end frame ${endFrame} is before start frame ${startFrame}`);
  }
  if (startFrame < meta.firstFrame || endFrame > meta.lastFrame) {
    throw new ErrReplayRange(
      `requested range ${startFrame}..${endFrame} is outside the recorded range ${meta.firstFrame}..${meta.lastFrame}`,
    );
  }
  for (const frame of reader) {
    if (frame.tick > endFrame) {
      break;
    }
    const produced = step(state, frame.normalizedInputs(), frame);
    hash = typeof produced === 'string' ? produced : sim.stateHash(state);
    if (frame.tick >= startFrame && hash !== frame.stateHash) {
      throw new ErrReplayDiverged(frame.tick, frame.stateHash, hash);
    }
  }
  return { finalFrame: endFrame, finalStateHash: hash, framesVerified: endFrame - startFrame + 1 };
}

module.exports = {
  ErrReplayClosed,
  ErrReplayCorrupt,
  ErrReplayDiverged,
  ErrReplayFrameOrder,
  ErrReplayRange,
  ErrReplayVersion,
  REPLAY_STREAM_KIND: KIND,
  REPLAY_STREAM_VERSION: VERSION,
  ReplayReader,
  ReplayWriter,
  VerifyReplay,
  verifyReplay: VerifyReplay,
};
