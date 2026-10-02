'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * Persistence built on the standard-library SQLite binding (`node:sqlite`, Node
 * 22.5+). It stores the match configuration, the *current* unit state, the
 * recorded frame log and the input records.
 *
 * The frame log is the replay artefact: inputs are keyed by
 * (match, tick, unit, command) and never discarded, while frames are keyed by
 * (match, tick) and are deleted and rebuilt by every rollback.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY, seed INTEGER NOT NULL, max_ticks INTEGER NOT NULL,
    tick INTEGER NOT NULL, status TEXT NOT NULL, state_hash TEXT,
    units_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS units (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    id TEXT NOT NULL, team TEXT NOT NULL, position INTEGER NOT NULL,
    velocity INTEGER NOT NULL, health INTEGER NOT NULL, attacking INTEGER NOT NULL,
    PRIMARY KEY (match_id, id)
  );
  CREATE TABLE IF NOT EXISTS teams (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    team TEXT NOT NULL, damage INTEGER NOT NULL,
    PRIMARY KEY (match_id, team)
  );
  CREATE TABLE IF NOT EXISTS frames (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    tick INTEGER NOT NULL, state_hash TEXT NOT NULL, delta_json TEXT NOT NULL,
    state_json TEXT NOT NULL, input_json TEXT NOT NULL, alive INTEGER NOT NULL,
    settled INTEGER NOT NULL,
    PRIMARY KEY (match_id, tick)
  );
  CREATE TABLE IF NOT EXISTS inputs (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    tick INTEGER NOT NULL, unit TEXT NOT NULL, command TEXT NOT NULL,
    seq INTEGER NOT NULL, arrival INTEGER NOT NULL, body_json TEXT NOT NULL,
    PRIMARY KEY (match_id, tick, unit, command)
  );
  CREATE TABLE IF NOT EXISTS stats (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    name TEXT NOT NULL, value INTEGER NOT NULL,
    PRIMARY KEY (match_id, name)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    id TEXT NOT NULL, status TEXT NOT NULL, units_json TEXT NOT NULL,
    PRIMARY KEY (match_id, id)
  );
  CREATE TABLE IF NOT EXISTS spectators (
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    id TEXT NOT NULL, delay_ticks INTEGER NOT NULL,
    high_tick INTEGER NOT NULL, needs_reset INTEGER NOT NULL,
    PRIMARY KEY (match_id, id)
  );
  CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY, operation TEXT NOT NULL,
    request_hash TEXT NOT NULL, response_json TEXT NOT NULL
  );
`;

function unitRow(unit) {
  return {
    attacking: unit.attacking, health: unit.health, id: unit.id,
    position: unit.position, team: unit.team, velocity: unit.velocity,
  };
}

class Store {
  constructor(path) {
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA journal_mode = WAL');
    this.connection.exec('PRAGMA foreign_keys = ON');
    this.connection.exec(SCHEMA);
  }

  close() {
    this.connection.close();
  }

  /** Run `body` inside a transaction; roll back on any throw. */
  transaction(body) {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const value = body();
      this.connection.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        /* the transaction was already closed */
      }
      throw error;
    }
  }

  insertMatch(config, state) {
    this.connection
      .prepare('INSERT INTO matches(id, seed, max_ticks, tick, status, state_hash, units_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(config.id, config.seed, config.maxTicks, state.tick, state.status, state.hash, JSON.stringify(config.units));
    const insertUnit = this.connection
      .prepare('INSERT INTO units(match_id, id, team, position, velocity, health, attacking) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const id of Object.keys(state.units).sort()) {
      const unit = state.units[id];
      insertUnit.run(config.id, unit.id, unit.team, unit.position, unit.velocity, unit.health, unit.attacking ? 1 : 0);
    }
    for (const team of ['blue', 'red']) {
      this.connection.prepare('INSERT INTO teams(match_id, team, damage) VALUES (?, ?, ?)')
        .run(config.id, team, state.teamDamage[team]);
    }
  }

  readMatch(matchId) {
    const row = this.connection.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!row) {
      return null;
    }
    return {
      config: { id: row.id, maxTicks: row.max_ticks, seed: row.seed, units: JSON.parse(row.units_json) },
      stateHash: row.state_hash,
      status: row.status,
      tick: row.tick,
    };
  }

  readState(matchId) {
    const row = this.connection.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!row) {
      return null;
    }
    const units = {};
    for (const unit of this.connection.prepare('SELECT * FROM units WHERE match_id = ?').all(matchId)) {
      units[unit.id] = {
        attacking: unit.attacking === 1, health: unit.health, id: unit.id,
        position: unit.position, team: unit.team, velocity: unit.velocity,
      };
    }
    const teamDamage = { blue: 0, red: 0 };
    for (const team of this.connection.prepare('SELECT * FROM teams WHERE match_id = ?').all(matchId)) {
      teamDamage[team.team] = team.damage;
    }
    return { hash: row.state_hash, maxTicks: row.max_ticks, status: row.status, teamDamage, tick: row.tick, units };
  }

  writeState(matchId, state) {
    this.connection.prepare('UPDATE matches SET tick = ?, status = ?, state_hash = ? WHERE id = ?')
      .run(state.tick, state.status, state.hash, matchId);
    const updateUnit = this.connection
      .prepare('UPDATE units SET team = ?, position = ?, velocity = ?, health = ?, attacking = ? WHERE match_id = ? AND id = ?');
    for (const id of Object.keys(state.units).sort()) {
      const unit = state.units[id];
      updateUnit.run(unit.team, unit.position, unit.velocity, unit.health, unit.attacking ? 1 : 0, matchId, unit.id);
    }
    const updateTeam = this.connection.prepare('UPDATE teams SET damage = ? WHERE match_id = ? AND team = ?');
    for (const team of ['blue', 'red']) {
      updateTeam.run(state.teamDamage[team], matchId, team);
    }
  }

  deleteFramesFrom(matchId, tick) {
    this.connection.prepare('DELETE FROM frames WHERE match_id = ? AND tick >= ?').run(matchId, tick);
  }

  insertFrame(matchId, frame) {
    this.connection
      .prepare('INSERT INTO frames(match_id, tick, state_hash, delta_json, state_json, input_json, alive, settled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(matchId, frame.tick, frame.state_hash, JSON.stringify(frame.delta), JSON.stringify(frame.state),
        JSON.stringify(frame.inputs), frame.alive, frame.settled ? 1 : 0);
  }

  readFrames(matchId) {
    return this.connection
      .prepare('SELECT * FROM frames WHERE match_id = ? ORDER BY tick')
      .all(matchId)
      .map((row) => ({
        alive: row.alive, delta: JSON.parse(row.delta_json), inputs: JSON.parse(row.input_json),
        settled: row.settled === 1, state: JSON.parse(row.state_json),
        state_hash: row.state_hash, tick: row.tick,
      }));
  }

  readFramesFrom(matchId, tick) {
    return this.readFrames(matchId).filter((frame) => frame.tick >= tick);
  }

  readInputs(matchId) {
    return this.connection
      .prepare('SELECT * FROM inputs WHERE match_id = ? ORDER BY tick, command, unit')
      .all(matchId)
      .map((row) => ({ body: JSON.parse(row.body_json), tick: row.tick }));
  }

  readInput(matchId, tick, unit, command) {
    return this.connection
      .prepare('SELECT body_json FROM inputs WHERE match_id = ? AND tick = ? AND unit = ? AND command = ?')
      .get(matchId, tick, unit, command) ?? null;
  }
  insertInput(matchId, input, body) {
    this.connection
      .prepare('INSERT INTO inputs(match_id, tick, unit, command, seq, arrival, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(matchId, input.tick, input.unit, input.command.kind, input.seq, input.arrival, JSON.stringify(body));
  }

  countInputsBefore(matchId, tick) {
    return this.connection.prepare('SELECT COUNT(*) AS total FROM inputs WHERE match_id = ? AND tick < ?')
      .get(matchId, tick).total;
  }

  readStats(matchId) {
    const stats = { accepted: 0, duplicates: 0, rejected: 0, rollbacks: 0 };
    for (const row of this.connection.prepare('SELECT name, value FROM stats WHERE match_id = ?').all(matchId)) {
      stats[row.name] = row.value;
    }
    return stats;
  }

  bumpStat(matchId, name, amount) {
    if (amount === 0) {
      return;
    }
    this.connection
      .prepare('INSERT INTO stats(match_id, name, value) VALUES (?, ?, ?) ON CONFLICT(match_id, name) DO UPDATE SET value = value + excluded.value')
      .run(matchId, name, amount);
  }

  insertSession(matchId, session) {
    this.connection
      .prepare('INSERT INTO sessions(match_id, id, status, units_json) VALUES (?, ?, ?, ?)')
      .run(matchId, session.id, session.status, JSON.stringify(session.units));
  }

  readSession(matchId, sessionId) {
    const row = this.connection
      .prepare('SELECT * FROM sessions WHERE match_id = ? AND id = ?')
      .get(matchId, sessionId);
    return row ? { id: row.id, status: row.status, units: JSON.parse(row.units_json) } : null;
  }

  readSessions(matchId) {
    return this.connection
      .prepare('SELECT * FROM sessions WHERE match_id = ? ORDER BY id')
      .all(matchId)
      .map((row) => ({ id: row.id, status: row.status, units: JSON.parse(row.units_json) }));
  }

  setSessionStatus(matchId, sessionId, status) {
    this.connection.prepare('UPDATE sessions SET status = ? WHERE match_id = ? AND id = ?')
      .run(status, matchId, sessionId);
  }

  insertSpectator(matchId, spectator) {
    this.connection
      .prepare('INSERT INTO spectators(match_id, id, delay_ticks, high_tick, needs_reset) VALUES (?, ?, ?, ?, ?)')
      .run(matchId, spectator.id, spectator.delayTicks, spectator.highTick, spectator.needsReset ? 1 : 0);
  }

  readSpectator(matchId, spectatorId) {
    const row = this.connection
      .prepare('SELECT * FROM spectators WHERE match_id = ? AND id = ?')
      .get(matchId, spectatorId);
    return row ? {
      delayTicks: row.delay_ticks, highTick: row.high_tick,
      id: row.id, needsReset: row.needs_reset === 1,
    } : null;
  }

  /**
   * Flag every spectator of the match that was already served a frame past
   * `tick`: its next poll must restart from tick 0 instead of streaming.
   */
  markSpectatorsReset(matchId, tick) {
    this.connection.prepare('UPDATE spectators SET needs_reset = 1 WHERE match_id = ? AND high_tick > ?')
      .run(matchId, tick);
  }

  updateSpectator(matchId, spectatorId, highTick, needsReset) {
    this.connection.prepare('UPDATE spectators SET high_tick = ?, needs_reset = ? WHERE match_id = ? AND id = ?')
      .run(highTick, needsReset ? 1 : 0, matchId, spectatorId);
  }

  getIdempotent(key) {
    const row = this.connection.prepare('SELECT * FROM idempotency WHERE key = ?').get(key);
    return row ? { operation: row.operation, requestHash: row.request_hash, response: JSON.parse(row.response_json) } : null;
  }

  putIdempotent(key, operation, requestHashValue, response) {
    this.connection
      .prepare('INSERT INTO idempotency(key, operation, request_hash, response_json) VALUES (?, ?, ?, ?)')
      .run(key, operation, requestHashValue, JSON.stringify(response));
  }
}

module.exports = { Store, unitRow };
