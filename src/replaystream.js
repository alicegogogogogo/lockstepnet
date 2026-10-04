'use strict';

const { createHash } = require('node:crypto');
const { LockstepError, ValidationError } = require('./errors');

/**
 * Binary replay stream: a self-describing, transferable encoding of one
 * confirmed session timeline.
 *
 * A stream records everything needed to re-run the timeline in another
 * process: the format version, the tick configuration, the session seed, the
 * first recorded frame, the participant identifiers, the initial state hash
 * and, for every frame, the final inputs that were applied (payloads kept as
 * raw bytes) and the resulting state hash. The layout is canonical: the same
 * initial conditions and the same final timeline encode to the same byte
 * sequence no matter what order the inputs originally arrived in.
 *
 * Layout (all integers big-endian, hashes are raw 32-byte sha256 digests):
 *
 *   magic             8 bytes   "LNRPLAY1"
 *   major             uint16    format major version (1); an unknown major is
 *                               rejected with ErrReplayVersion
 *   minor             uint16    compatible revision; readers of the same major
 *                               skip unknown extension fields
 *   headerLength      uint32    byte length of the header section
 *   --- header section ---
 *   seed              uint32    session seed
 *   maxTicks          uint32    tick configuration: the match length limit
 *   startFrame        uint32    frame number of the first recorded frame
 *   frameCount        uint32    number of recorded frames (zero is allowed)
 *   initialStateHash  32 bytes  state hash before the first recorded frame
 *   participantCount  uint16
 *   participants      participantCount x { idLength uint8, id UTF-8 bytes }
 *                               sorted bytewise, unique, non-empty ids
 *   extensionCount    uint16
 *   extensions        extensionCount x { tag uint16, length uint32, value }
 *                               unknown tags are carried through and skipped
 *   --- frames section: frameCount records ---
 *   frame             uint32    must equal startFrame + index
 *   inputCount        uint16
 *   inputs            inputCount x { participant uint16 (index into the
 *                               participant table), payloadLength uint32,
 *                               payload bytes } sorted by (participant,
 *                               payload), exact duplicates recorded once
 *   stateHash         32 bytes  state hash after this frame
 *   --- trailer ---
 *   checksum          32 bytes  sha256 of every preceding byte
 *
 * Frames are contiguous from startFrame; a frame with no inputs is recorded
 * with inputCount 0 and is preserved by the reader.
 */

const MAGIC = Buffer.from('LNRPLAY1', 'ascii');
const VERSION_MAJOR = 1;
const VERSION_MINOR = 0;
const HASH_BYTES = 32;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

/** Header extension tag carrying the canonical JSON of the match configuration. */
const EXTENSION_CONFIG = 1;

/** Base class of every replay-stream error. */
class ReplayError extends LockstepError {
  constructor(message) {
    super(message);
    this.code = 'replay_error';
  }
}

/** A frame was recorded twice, out of order, or with a gap in the sequence. */
class ErrReplayFrameOrder extends ReplayError {
  constructor(message) {
    super(message);
    this.code = 'replay_frame_order';
  }
}

/** A frame was offered to a writer that was already closed. */
class ErrReplayClosed extends ReplayError {
  constructor(message) {
    super(message);
    this.code = 'replay_closed';
  }
}

/** The byte stream is malformed: bad identifier, boundary, sequence or checksum. */
class ErrReplayCorrupt extends ReplayError {
  constructor(message) {
    super(message);
    this.code = 'replay_corrupt';
  }
}

/** The stream was written by an unsupported format major version. */
class ErrReplayVersion extends ReplayError {
  constructor(message) {
    super(message);
    this.code = 'replay_version';
  }
}

/**
 * The re-simulation left the recorded timeline. Carries the first diverging
 * `frame`, the recorded (`expected`) hash and the recomputed (`actual`) hash.
 */
class ErrReplayDiverged extends ReplayError {
  constructor(frame, expected, actual) {
    super(`replay diverged at frame ${frame}: recorded state hash ${expected}, re-simulation produced ${actual}`);
    this.code = 'replay_diverged';
    this.actual = actual;
    this.expected = expected;
    this.frame = frame;
  }
}

/** The requested frame range is empty or outside the recorded timeline. */
class ErrReplayRange extends ReplayError {
  constructor(message) {
    super(message);
    this.code = 'replay_range';
  }
}

function uint(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Coerce a payload to an owned Buffer; strings are encoded as UTF-8. */
function toBytes(value, field) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  throw new ValidationError(`${field} must be a Buffer, Uint8Array or string`);
}

/** Normalize a state hash given as 32 raw bytes or as lowercase hex. */
function toHashBytes(value, field) {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if ((Buffer.isBuffer(value) || value instanceof Uint8Array) && value.length === HASH_BYTES) {
    return Buffer.from(value);
  }
  throw new ValidationError(`${field} must be 32 raw bytes or a lowercase sha256 hex string`);
}

/** Bytewise (UTF-8) order, the canonical order of participant identifiers. */
function compareIds(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Bounds-checked big-endian reader over one section of the stream. */
class Cursor {
  constructor(bytes, offset, end) {
    this.bytes = bytes;
    this.end = end;
    this.offset = offset;
  }

  take(length, what) {
    if (this.offset + length > this.end) {
      throw new ErrReplayCorrupt(`replay is corrupt: ${what} runs past the end of its section`);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  u8(what) {
    return this.take(1, what).readUInt8(0);
  }

  u16(what) {
    return this.take(2, what).readUInt16BE(0);
  }

  u32(what) {
    return this.take(4, what).readUInt32BE(0);
  }
}

function serializeFrame(frame) {
  const head = Buffer.alloc(6);
  head.writeUInt32BE(frame.frame, 0);
  head.writeUInt16BE(frame.inputs.length, 4);
  const parts = [head];
  for (const input of frame.inputs) {
    const prefix = Buffer.alloc(6);
    prefix.writeUInt16BE(input.index, 0);
    prefix.writeUInt32BE(input.payload.length, 2);
    parts.push(prefix, input.payload);
  }
  parts.push(frame.hash);
  return Buffer.concat(parts);
}

/**
 * Recording end of a replay stream.
 *
 *   const writer = new ReplayWriter({
 *     seed: 11, maxTicks: 64, startFrame: 1,
 *     participants: ['red-1', 'blue-1'],
 *     initialStateHash: '<64 hex>',
 *   });
 *   writer.writeFrame(1, [{ participant: 'red-1', payload: Buffer.from(...) }], hash1);
 *   writer.writeFrame(2, [], hash2);            // zero-input frames are kept
 *   const bytes = writer.close();
 *
 * Only monotonically advancing confirmed frames are accepted: the first frame
 * must be `startFrame` and every later frame exactly one past the previous
 * one, otherwise ErrReplayFrameOrder is thrown. Writing after close() throws
 * ErrReplayClosed. A rejected frame is validated in full before anything is
 * recorded, so a failed write never leaves half a record behind.
 */
class ReplayWriter {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError('replay writer options must be an object');
    }
    for (const key of Object.keys(options)) {
      if (!['seed', 'maxTicks', 'startFrame', 'participants', 'initialStateHash', 'extensions'].includes(key)) {
        throw new ValidationError(`replay writer options has unknown field ${key}`);
      }
    }
    this.seed = uint(options.seed === undefined ? 0 : options.seed, 'seed', 0, UINT32_MAX);
    this.maxTicks = uint(options.maxTicks, 'maxTicks', 1, UINT32_MAX);
    this.startFrame = uint(options.startFrame === undefined ? 1 : options.startFrame, 'startFrame', 0, UINT32_MAX);
    this.initialStateHash = toHashBytes(options.initialStateHash, 'initial state hash');

    if (!Array.isArray(options.participants)) {
      throw new ValidationError('participants must be an array');
    }
    if (options.participants.length > UINT16_MAX) {
      throw new ValidationError(`participants must contain at most ${UINT16_MAX} entries`);
    }
    const ids = options.participants.map((id) => {
      if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > 255) {
        throw new ValidationError('each participant id must be a non-empty string of at most 255 UTF-8 bytes');
      }
      return id;
    });
    // Participants are stored in canonical bytewise order, so the constructor
    // argument order cannot influence the exported bytes.
    this.participants = Object.freeze(ids.slice().sort(compareIds));
    this.participantBytes = this.participants.map((id) => Buffer.from(id, 'utf8'));
    this.participantIndex = new Map();
    this.participants.forEach((id, index) => {
      if (this.participantIndex.has(id)) {
        throw new ValidationError(`participant ids must be unique: ${id}`);
      }
      this.participantIndex.set(id, index);
    });

    this.extensions = (options.extensions === undefined ? [] : options.extensions).map((extension) => {
      if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
        throw new ValidationError('each extension must be an object with tag and value');
      }
      return {
        tag: uint(extension.tag, 'extension tag', 0, UINT16_MAX),
        value: toBytes(extension.value, 'extension value'),
      };
    });
    this.extensions.sort((left, right) => left.tag - right.tag || Buffer.compare(left.value, right.value));

    this.buffer = null;
    this.closed = false;
    this.frames = [];
  }

  /**
   * Record one confirmed frame. `inputs` is a list of
   * `{ participant, payload }`; payloads are kept as raw bytes. Inputs are
   * canonicalized (exact duplicates dropped, sorted by participant id and
   * payload bytes), so the arrival order of the originals is irrelevant.
   */
  writeFrame(frame, inputs, stateHash) {
    if (this.closed) {
      throw new ErrReplayClosed('the replay writer is closed and cannot record more frames');
    }
    const expected = this.startFrame + this.frames.length;
    if (!Number.isInteger(frame) || frame !== expected) {
      throw new ErrReplayFrameOrder(`frame ${frame} cannot be recorded: the next confirmed frame is ${expected}`);
    }
    const normalized = this.normalizeInputs(inputs);
    const hash = toHashBytes(stateHash, 'frame state hash');
    this.frames.push({ frame, hash, inputs: normalized });
    return this;
  }

  normalizeInputs(inputs) {
    if (inputs === undefined) {
      return [];
    }
    if (!Array.isArray(inputs)) {
      throw new ValidationError('frame inputs must be an array');
    }
    if (inputs.length > UINT16_MAX) {
      throw new ValidationError(`a frame can carry at most ${UINT16_MAX} inputs`);
    }
    const seen = new Set();
    const normalized = [];
    for (const input of inputs) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ValidationError('each frame input must be an object with participant and payload');
      }
      const index = this.participantIndex.get(input.participant);
      if (index === undefined) {
        throw new ValidationError(`frame input references unknown participant ${input.participant}`);
      }
      const payload = toBytes(input.payload, 'input payload');
      const key = `${index}:${payload.toString('hex')}`;
      // An exact re-delivery of the same payload from the same participant is
      // recorded once, mirroring the input log's duplicate rule.
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({ index, payload });
    }
    normalized.sort((left, right) => left.index - right.index || Buffer.compare(left.payload, right.payload));
    return normalized;
  }

  serializeHeader() {
    const head = Buffer.alloc(16 + HASH_BYTES + 2);
    head.writeUInt32BE(this.seed, 0);
    head.writeUInt32BE(this.maxTicks, 4);
    head.writeUInt32BE(this.startFrame, 8);
    head.writeUInt32BE(this.frames.length, 12);
    this.initialStateHash.copy(head, 16);
    head.writeUInt16BE(this.participants.length, 16 + HASH_BYTES);
    const parts = [head];
    this.participantBytes.forEach((bytes) => {
      parts.push(Buffer.from([bytes.length]), bytes);
    });
    const extensionCount = Buffer.alloc(2);
    extensionCount.writeUInt16BE(this.extensions.length, 0);
    parts.push(extensionCount);
    for (const extension of this.extensions) {
      const prefix = Buffer.alloc(6);
      prefix.writeUInt16BE(extension.tag, 0);
      prefix.writeUInt32BE(extension.value.length, 2);
      parts.push(prefix, extension.value);
    }
    return Buffer.concat(parts);
  }

  /** Seal the stream and return its bytes. Idempotent. */
  close() {
    if (this.closed) {
      return this.buffer;
    }
    this.closed = true;
    const header = this.serializeHeader();
    const prefix = Buffer.alloc(16);
    MAGIC.copy(prefix, 0);
    prefix.writeUInt16BE(VERSION_MAJOR, 8);
    prefix.writeUInt16BE(VERSION_MINOR, 10);
    prefix.writeUInt32BE(header.length, 12);
    const body = Buffer.concat([prefix, header, ...this.frames.map(serializeFrame)]);
    this.buffer = Buffer.concat([body, createHash('sha256').update(body).digest()]);
    return this.buffer;
  }
}

/** Parse and fully validate a stream; throws before anything is exposed. */
function parseStream(bytes) {
  if (bytes.length < 12) {
    throw new ErrReplayCorrupt('replay is corrupt: shorter than the fixed identifier and version');
  }
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ErrReplayCorrupt('replay is corrupt: the fixed identifier does not match');
  }
  const major = bytes.readUInt16BE(8);
  const minor = bytes.readUInt16BE(10);
  if (major !== VERSION_MAJOR) {
    throw new ErrReplayVersion(`replay version ${major}.${minor} is not supported by this reader`);
  }
  if (bytes.length < 16) {
    throw new ErrReplayCorrupt('replay is corrupt: the header length is missing');
  }
  const headerLength = bytes.readUInt32BE(12);
  const headerEnd = 16 + headerLength;
  if (headerEnd > bytes.length - HASH_BYTES) {
    throw new ErrReplayCorrupt('replay is corrupt: the header runs past the data or the trailer is missing');
  }

  const cursor = new Cursor(bytes, 16, headerEnd);
  const seed = cursor.u32('seed');
  const maxTicks = cursor.u32('tick configuration');
  const startFrame = cursor.u32('start frame');
  const frameCount = cursor.u32('frame count');
  const initialStateHash = cursor.take(HASH_BYTES, 'initial state hash').toString('hex');
  const participantCount = cursor.u16('participant count');
  const participants = [];
  let previousId = null;
  for (let index = 0; index < participantCount; index += 1) {
    const length = cursor.u8('participant id length');
    if (length === 0) {
      throw new ErrReplayCorrupt('replay is corrupt: a participant id is empty');
    }
    const id = cursor.take(length, 'participant id').toString('utf8');
    if (previousId !== null && compareIds(previousId, id) >= 0) {
      throw new ErrReplayCorrupt('replay is corrupt: participant ids are not in canonical order');
    }
    previousId = id;
    participants.push(id);
  }
  const extensionCount = cursor.u16('extension count');
  const extensions = [];
  for (let index = 0; index < extensionCount; index += 1) {
    const tag = cursor.u16('extension tag');
    const length = cursor.u32('extension length');
    // Unknown tags are kept as opaque bytes and skipped by consumers, so a
    // compatible newer minor version cannot break this reader.
    extensions.push({ tag, value: Buffer.from(cursor.take(length, 'extension value')) });
  }
  if (cursor.offset !== headerEnd) {
    throw new ErrReplayCorrupt('replay is corrupt: the header section has a boundary mismatch');
  }

  const framesEnd = bytes.length - HASH_BYTES;
  const frameCursor = new Cursor(bytes, headerEnd, framesEnd);
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const frameNumber = frameCursor.u32('frame number');
    if (frameNumber !== startFrame + index) {
      throw new ErrReplayCorrupt(
        `replay is corrupt: record ${index} carries frame ${frameNumber}, breaking the frame sequence`,
      );
    }
    const inputCount = frameCursor.u16('input count');
    const inputs = [];
    let previous = null;
    for (let position = 0; position < inputCount; position += 1) {
      const participant = frameCursor.u16('input participant');
      if (participant >= participants.length) {
        throw new ErrReplayCorrupt('replay is corrupt: an input references an unknown participant');
      }
      const payloadLength = frameCursor.u32('input payload length');
      const payload = Buffer.from(frameCursor.take(payloadLength, 'input payload'));
      if (previous !== null && (participant < previous.index
        || (participant === previous.index && Buffer.compare(previous.payload, payload) >= 0))) {
        throw new ErrReplayCorrupt('replay is corrupt: frame inputs are not in canonical order');
      }
      previous = { index: participant, payload };
      inputs.push(Object.freeze({ participant: participants[participant], payload }));
    }
    const stateHash = frameCursor.take(HASH_BYTES, 'frame state hash').toString('hex');
    frames.push(Object.freeze({ frame: frameNumber, inputs: Object.freeze(inputs), stateHash }));
  }
  if (frameCursor.offset !== framesEnd) {
    throw new ErrReplayCorrupt('replay is corrupt: the frames section has a boundary mismatch');
  }
  const checksum = createHash('sha256').update(bytes.subarray(0, framesEnd)).digest();
  if (!checksum.equals(bytes.subarray(framesEnd))) {
    throw new ErrReplayCorrupt('replay is corrupt: the content checksum does not match');
  }
  return {
    extensions, frames, frameCount, initialStateHash, maxTicks, minor,
    participants, seed, startFrame,
  };
}

/**
 * Reading end of a replay stream.
 *
 * The constructor validates the whole stream eagerly - fixed identifier,
 * format version, structural boundaries, frame sequence and the whole-content
 * checksum - before any frame is exposed, and throws ErrReplayCorrupt (or
 * ErrReplayVersion for an unsupported major version) instead of ever
 * returning a partially usable replay. Data comes from memory bytes or, via
 * `ReplayReader.fromStream`, from any readable stream; the file system is
 * never touched.
 */
class ReplayReader {
  constructor(data) {
    let bytes;
    if (Buffer.isBuffer(data)) {
      bytes = data;
    } else if (data instanceof Uint8Array) {
      bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else {
      throw new ValidationError('replay data must be a Buffer or Uint8Array');
    }
    const parsed = parseStream(bytes);
    this.meta = Object.freeze({
      endFrame: parsed.frameCount === 0 ? parsed.startFrame - 1 : parsed.startFrame + parsed.frameCount - 1,
      frameCount: parsed.frameCount,
      initialStateHash: parsed.initialStateHash,
      maxTicks: parsed.maxTicks,
      minor: parsed.minor,
      participants: Object.freeze(parsed.participants.slice()),
      seed: parsed.seed,
      startFrame: parsed.startFrame,
      version: VERSION_MAJOR,
    });
    this.frameList = parsed.frames;
    this.extensionList = parsed.extensions;
  }

  /** Stream metadata: version, seed, tick configuration, frame range, participants, initial hash. */
  get metadata() {
    return this.meta;
  }

  /** Iterate the recorded frames in order: `{ frame, inputs, stateHash }`. */
  *frames() {
    for (const frame of this.frameList) {
      yield frame;
    }
  }

  /** The raw value of a header extension, or null when the tag is absent. */
  extension(tag) {
    const found = this.extensionList.find((extension) => extension.tag === tag);
    return found ? Buffer.from(found.value) : null;
  }

  /** Every header extension as `{ tag, value }` pairs, unknown tags included. */
  get extensions() {
    return this.extensionList.map((extension) => ({ tag: extension.tag, value: Buffer.from(extension.value) }));
  }

  /** Collect a readable stream (or any async iterable of chunks) and parse it. */
  static async fromStream(stream) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new ReplayReader(Buffer.concat(chunks));
  }
}

/**
 * Verify a recorded timeline by re-simulation.
 *
 *   verifyReplay(bytes, {
 *     simulate(frame, inputs) { ...; return stateHash; },
 *     startFrame, endFrame,            // optional window, defaults to everything
 *     initialStateHash,                // optional check of the starting point
 *   })
 *
 * Starting from the recorded initial conditions, every recorded frame up to
 * `endFrame` is handed to `simulate` in strict frame order and the hash it
 * returns is compared with the recorded one. Frames before `startFrame` are
 * simulated (to keep the state continuous) but not compared. When everything
 * matches, `{ finalFrame, stateHash }` of the last verified frame is
 * returned; the first mismatch stops the verification and throws
 * ErrReplayDiverged with the frame and both hashes. A range that is empty or
 * outside the recorded timeline throws ErrReplayRange. An error thrown by
 * `simulate` itself is rethrown untouched - it is never reported as
 * corruption or divergence.
 */
function verifyReplay(data, options = {}) {
  const reader = data instanceof ReplayReader ? data : new ReplayReader(data);
  const meta = reader.metadata;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ValidationError('verifyReplay options must be an object');
  }
  if (typeof options.simulate !== 'function') {
    throw new ValidationError('verifyReplay requires a simulate(frame, inputs) callback');
  }
  const simulate = options.simulate;
  const start = options.startFrame === undefined ? meta.startFrame : options.startFrame;
  const end = options.endFrame === undefined ? meta.endFrame : options.endFrame;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new ValidationError('startFrame and endFrame must be integers');
  }
  // A recording with no frames has exactly one meaningful request: its empty
  // range, which verifies the initial hash and nothing else.
  const emptyRange = meta.frameCount === 0 && start === meta.startFrame && end === meta.endFrame;
  if (end < start && !emptyRange) {
    throw new ErrReplayRange(`frame range [${start}, ${end}] ends before it starts`);
  }
  if (start < meta.startFrame || end > meta.endFrame) {
    throw new ErrReplayRange(
      `frame range [${start}, ${end}] is outside the recorded range [${meta.startFrame}, ${meta.endFrame}]`,
    );
  }
  if (options.initialStateHash !== undefined) {
    const initial = toHashBytes(options.initialStateHash, 'initial state hash').toString('hex');
    if (initial !== meta.initialStateHash) {
      throw new ErrReplayDiverged(meta.startFrame - 1, meta.initialStateHash, initial);
    }
  }
  let finalFrame = meta.startFrame - 1;
  let stateHash = meta.initialStateHash;
  for (const frame of reader.frames()) {
    if (frame.frame > end) {
      break;
    }
    const actual = toHashBytes(simulate(frame.frame, frame.inputs, reader), 'simulated state hash').toString('hex');
    if (frame.frame >= start && actual !== frame.stateHash) {
      throw new ErrReplayDiverged(frame.frame, frame.stateHash, actual);
    }
    finalFrame = frame.frame;
    stateHash = frame.stateHash;
  }
  return { finalFrame, stateHash };
}

module.exports = {
  EXTENSION_CONFIG,
  ErrReplayClosed,
  ErrReplayCorrupt,
  ErrReplayDiverged,
  ErrReplayFrameOrder,
  ErrReplayRange,
  ErrReplayVersion,
  ReplayError,
  ReplayReader,
  ReplayWriter,
  VerifyReplay: verifyReplay,
  verifyReplay,
};
