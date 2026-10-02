'use strict';

const { createHash } = require('node:crypto');
const { ValidationError } = require('./errors');

/**
 * Deterministic integer simulation core.
 *
 * The engine uses integer arithmetic only: no floating point, no Date, no
 * Math.random, no locale-sensitive comparison. Given the same match
 * configuration and the same *set* of input records the sequence of states -
 * and therefore every state hash - is reproducible, whatever order those
 * records reached the service in.
 */

const SCHEMA_VERSION = 1;
const STATE_DOMAIN = 'lockstepnet.state.v1\n';
const POSITION_MIN = 0;
const POSITION_MAX = 1000;
const HEALTH_MAX = 100;
const ATTACK_BASE = 10;
const MAX_TICKS_LIMIT = 100000;
const MAX_STEP = 1024;
const MAX_UNITS = 32;
const TEAMS = ['blue', 'red'];
const COMMAND_ORDER = ['move', 'attack'];
// Canonical order inside one tick: move commands first, then attacks.
const COMMAND_RANK = { move: 0, attack: 1 };

function identifier(value, field, maxLength = 64) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ValidationError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) {
    throw new ValidationError(`${field} must match ^[A-Za-z0-9][A-Za-z0-9_.:-]*$`);
  }
  return value;
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function exactKeys(raw, allowed, field) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`${field} has unknown field ${key}`);
    }
  }
}

function requireKeys(raw, required, field) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new ValidationError(`${field} must contain ${required.join(', ')}`);
    }
  }
}

function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Parse and validate the immutable match configuration accepted by POST /matches. */
function parseConfig(raw) {
  exactKeys(raw, ['id', 'seed', 'max_ticks', 'units'], 'match');
  requireKeys(raw, ['id', 'units'], 'match');
  const id = identifier(raw.id, 'match id');
  const seed = raw.seed === undefined ? 0 : integer(raw.seed, 'seed', 0, 2147483647);
  const maxTicks = raw.max_ticks === undefined ? 1000 : integer(raw.max_ticks, 'max_ticks', 1, MAX_TICKS_LIMIT);
  if (!Array.isArray(raw.units) || raw.units.length === 0) {
    throw new ValidationError('units must be a non-empty array');
  }
  if (raw.units.length > MAX_UNITS) {
    throw new ValidationError(`units must contain at most ${MAX_UNITS} entries`);
  }
  const units = [];
  const seen = new Set();
  for (const entry of raw.units) {
    exactKeys(entry, ['id', 'team', 'position', 'velocity'], 'each unit');
    requireKeys(entry, ['id', 'team'], 'each unit');
    const unitId = identifier(entry.id, 'unit id');
    if (seen.has(unitId)) {
      throw new ValidationError(`unit ids must be unique: ${unitId}`);
    }
    seen.add(unitId);
    if (!TEAMS.includes(entry.team)) {
      throw new ValidationError(`unit ${unitId} team must be one of ${TEAMS.join(', ')}`);
    }
    const position = entry.position === undefined
      ? (entry.team === 'red' ? POSITION_MIN : POSITION_MAX)
      : integer(entry.position, `unit ${unitId} position`, POSITION_MIN, POSITION_MAX);
    const velocity = entry.velocity === undefined
      ? (entry.team === 'red' ? 5 : -5)
      : integer(entry.velocity, `unit ${unitId} velocity`, -POSITION_MAX, POSITION_MAX);
    units.push({ id: unitId, position, team: entry.team, velocity });
  }
  units.sort(byId);
  if (!units.some((unit) => unit.team === 'red') || !units.some((unit) => unit.team === 'blue')) {
    throw new ValidationError('units must contain at least one unit on each team');
  }
  return { id, maxTicks, seed, units };
}

/** Fresh, hashable match state for a validated configuration. */
function initialState(config) {
  const units = {};
  for (const unit of config.units) {
    units[unit.id] = {
      attacking: false, health: HEALTH_MAX, id: unit.id,
      position: unit.position, team: unit.team, velocity: unit.velocity,
    };
  }
  return { hash: null, maxTicks: config.maxTicks, status: 'running', teamDamage: { blue: 0, red: 0 }, tick: 0, units };
}

function cloneState(state) {
  const units = {};
  for (const id of Object.keys(state.units).sort()) {
    units[id] = { ...state.units[id] };
  }
  return {
    hash: state.hash, maxTicks: state.maxTicks, status: state.status,
    teamDamage: { blue: state.teamDamage.blue, red: state.teamDamage.red },
    tick: state.tick, units,
  };
}

function liveUnits(state, team) {
  return Object.values(state.units)
    .filter((unit) => unit.health > 0 && (team === undefined || unit.team === team))
    .sort(byId);
}

function opponentOf(team) {
  return team === 'red' ? 'blue' : 'red';
}

function checkFinished(state) {
  if (state.status !== 'running') {
    return null;
  }
  if (liveUnits(state, 'red').length === 0) {
    return 'blue_wins';
  }
  return liveUnits(state, 'blue').length === 0 ? 'red_wins' : null;
}

/**
 * Advance the state by exactly one tick. The order inside a tick is part of the
 * public contract (README section "Tick semantics"):
 *   1. `move` commands apply in unit-id order: an absolute `position` or a
 *      relative `by` step, both clamped to [0,1000]; dead units ignore moves;
 *   2. `attack` commands apply in unit-id order and only toggle the flag;
 *   3. again in unit-id order, every attacking unit picks its target: the living
 *      enemy with the lowest health, ties broken by unit id;
 *   4. all damage is accumulated first and applied simultaneously, each attacker
 *      dealing max(1, floor(10 * attacker.health / 100));
 *   5. per-team damage totals are folded into the state.
 *
 * Returns the frame delta: every unit whose position, health or velocity changed
 * plus the units that died during this tick.
 */
function applyTick(state, boxes) {
  const before = {};
  for (const id of Object.keys(state.units)) {
    const unit = state.units[id];
    before[id] = { health: unit.health, position: unit.position, velocity: unit.velocity };
  }

  const positions = {};
  const velocities = {};
  for (const input of boxes) {
    const unit = state.units[input.unit];
    if (!unit || input.command.kind !== 'move' || unit.health <= 0) {
      continue;
    }
    if (input.command.position !== undefined) {
      positions[unit.id] = input.command.position;
    }
    if (input.command.velocity !== undefined) {
      velocities[unit.id] = input.command.velocity;
    } else if (input.command.by !== undefined) {
      positions[unit.id] = Math.min(POSITION_MAX, Math.max(POSITION_MIN, unit.position + input.command.by));
    }
  }
  for (const id of Object.keys(positions).sort()) {
    state.units[id].position = positions[id];
  }
  for (const id of Object.keys(velocities).sort()) {
    state.units[id].velocity = velocities[id];
  }
  for (const input of boxes) {
    const unit = state.units[input.unit];
    if (unit && input.command.kind === 'attack') {
      unit.attacking = input.command.attacking;
    }
  }

  const damage = {};
  for (const attacker of liveUnits(state)) {
    if (!attacker.attacking) {
      continue;
    }
    const targets = liveUnits(state, opponentOf(attacker.team));
    if (targets.length === 0) {
      continue;
    }
    let target = targets[0];
    for (const candidate of targets) {
      if (candidate.health < target.health || (candidate.health === target.health && candidate.id < target.id)) {
        target = candidate;
      }
    }
    const amount = Math.max(1, Math.floor((ATTACK_BASE * attacker.health) / HEALTH_MAX));
    damage[target.id] = (damage[target.id] || 0) + amount;
  }

  const healths = {};
  for (const id of Object.keys(damage).sort()) {
    healths[id] = Math.max(0, state.units[id].health - damage[id]);
  }
  for (const id of Object.keys(healths).sort()) {
    state.units[id].health = healths[id];
    // `teamDamage[team]` is the total damage that team has *dealt* to its
    // opponent, so the health lost by a unit is credited to the other team.
    state.teamDamage[opponentOf(state.units[id].team)] += before[id].health - healths[id];
  }

  state.tick += 1;
  const changed = [];
  const casualties = [];
  for (const id of Object.keys(state.units).sort()) {
    const unit = state.units[id];
    const was = before[id];
    if (unit.health <= 0 && was.health > 0) {
      casualties.push(id);
    }
    if (unit.position !== was.position || unit.health !== was.health || unit.velocity !== was.velocity) {
      changed.push({ health: unit.health, id, position: unit.position, velocity: unit.velocity });
    }
  }
  const outcome = checkFinished(state);
  if (outcome) {
    state.status = outcome;
  } else if (state.tick >= state.maxTicks) {
    state.status = 'max_ticks';
  }
  return { casualties, changed, tick: state.tick };
}

/**
 * Validate one input record, the unit of `POST /matches/{id}/inputs`:
 *
 *   {"tick":<int>=0,"unit":"<unit id>","command":{"kind":"move","position":<0..1000>}}
 *   {"tick":<int>=0,"unit":"<unit id>","command":{"kind":"move","by":<int -1000..1000>}}
 *   {"tick":<int>=0,"unit":"<unit id>","command":{"kind":"move","velocity":<int -1000..1000>}}
 *   {"tick":<int>=0,"unit":"<unit id>","command":{"kind":"attack","attacking":<bool>}}
 *
 * The optional `seq` is an arrival tag and never takes part in the hash.
 */
function parseInputRecord(raw) {
  exactKeys(raw, ['tick', 'unit', 'seq', 'command'], 'input');
  requireKeys(raw, ['tick', 'unit', 'command'], 'input');
  const tick = integer(raw.tick, 'input tick', 0, MAX_TICKS_LIMIT - 1);
  const unit = identifier(raw.unit, 'input unit');
  const seq = raw.seq === undefined ? 0 : integer(raw.seq, 'input seq', 0, 2147483647);
  const command = raw.command;
  exactKeys(command, ['kind', 'position', 'by', 'velocity', 'attacking'], 'input command');
  if (command.kind === 'move') {
    const present = ['position', 'by', 'velocity'].filter((key) => command[key] !== undefined);
    if (present.length !== 1) {
      throw new ValidationError('a move command must contain exactly one of position, by, or velocity');
    }
    if (command.position !== undefined) {
      return { command: { kind: 'move', position: integer(command.position, 'move position', POSITION_MIN, POSITION_MAX) }, seq, tick, unit };
    }
    if (command.by !== undefined) {
      return { command: { by: integer(command.by, 'move by', -POSITION_MAX, POSITION_MAX), kind: 'move' }, seq, tick, unit };
    }
    return { command: { kind: 'move', velocity: integer(command.velocity, 'move velocity', -POSITION_MAX, POSITION_MAX) }, seq, tick, unit };
  }
  if (command.kind === 'attack') {
    if (typeof command.attacking !== 'boolean' || command.position !== undefined
      || command.by !== undefined || command.velocity !== undefined) {
      throw new ValidationError('an attack command must contain exactly kind and a boolean attacking');
    }
    return { command: { attacking: command.attacking, kind: 'attack' }, seq, tick, unit };
  }
  throw new ValidationError(`input command kind must be one of ${COMMAND_ORDER.join(', ')}`);
}

/** Drop the arrival tag so replay documents stay canonical. */
function stripInput(input) {
  return { command: input.command, tick: input.tick, unit: input.unit };
}

/**
 * Canonical JSON of one input record. It covers tick, unit and command only -
 * never the arrival order or the arrival sequence - so resubmitting the same
 * record, or delivering it late, produces the same canonical bytes.
 */
function canonicalInput(input) {
  const command = input.command.kind === 'move'
    ? { by: input.command.by, kind: 'move', position: input.command.position, velocity: input.command.velocity }
    : { attacking: input.command.attacking, kind: 'attack' };
  return `{"command":${JSON.stringify(command)},"tick":${input.tick},"unit":${JSON.stringify(input.unit)}}`;
}

/** Order two input records inside the same tick: move before attack, then unit id. */
function compareInputs(left, right) {
  if (left.tick !== right.tick) {
    return left.tick - right.tick;
  }
  const rank = COMMAND_RANK[left.command.kind] - COMMAND_RANK[right.command.kind];
  return rank !== 0 ? rank : (left.unit < right.unit ? -1 : left.unit > right.unit ? 1 : 0);
}

/**
 * Canonical state hash:
 *
 *   payload = '{"team_damage":{"blue":<n>,"red":<n>},"tick":<n>,"units":[' +
 *             alive units sorted by id, then dead units sorted by id, each as
 *             '{"attacking":<bool>,"health":<n|null>,"id":"<id>","position":<n>,'
 *             + '"team":"<red|blue>","velocity":<n>}' +
 *             '],"version":1}'
 *   state_hash = sha256('lockstepnet.state.v1\n' + payload) as lowercase hex
 *
 * Every number is an integer and the field order is fixed, so the payload is a
 * byte-exact function of the state.
 */
function stateHash(state) {
  const entries = [];
  for (const unit of liveUnits(state)) {
    entries.push(
      `{"attacking":${unit.attacking === true},"health":${unit.health},"id":${JSON.stringify(unit.id)},`
        + `"position":${unit.position},"team":${JSON.stringify(unit.team)},"velocity":${unit.velocity}}`,
    );
  }
  for (const unit of Object.values(state.units).filter((candidate) => candidate.health <= 0).sort(byId)) {
    entries.push(
      `{"attacking":false,"health":null,"id":${JSON.stringify(unit.id)},`
        + `"position":${unit.position},"team":${JSON.stringify(unit.team)},"velocity":${unit.velocity}}`,
    );
  }
  const payload = `{"team_damage":{"blue":${state.teamDamage.blue},"red":${state.teamDamage.red}},`
    + `"tick":${state.tick},"units":[${entries.join(',')}],"version":${SCHEMA_VERSION}}`;
  return createHash('sha256').update(`${STATE_DOMAIN}${payload}`).digest('hex');
}

/** sha256 over the canonical form of a list of input records; order-insensitive. */
function inputSetHash(inputs) {
  const hash = createHash('sha256');
  for (const row of inputs.map(canonicalInput).sort()) {
    hash.update(row);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** Fingerprint of a recorded replay: inputs (order-insensitive) plus frame hashes. */
function fileHash(config, inputs, frames) {
  const text = JSON.stringify({
    hashes: frames.map((frame) => frame.state_hash),
    inputs: inputs.map(canonicalInput).sort(),
    match: { id: config.id, max_ticks: config.maxTicks, seed: config.seed, units: config.units },
    schema: SCHEMA_VERSION,
    ticks: frames.map((frame) => frame.tick),
  });
  return createHash('sha256').update(`lockstepnet.replay.v1\n${text}`).digest('hex');
}

module.exports = {
  ATTACK_BASE, COMMAND_ORDER, HEALTH_MAX, MAX_STEP, MAX_TICKS_LIMIT, MAX_UNITS,
  POSITION_MAX, POSITION_MIN, SCHEMA_VERSION, TEAMS,
  applyTick, canonicalInput, cloneState, compareInputs, exactKeys, fileHash,
  identifier, initialState, inputSetHash, integer, liveUnits, parseConfig,
  parseInputRecord, stateHash, stripInput,
};
