'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { ConflictError, IntegrityError, NotFoundError, ValidationError } = require('../src/errors');
const { Lockstep } = require('../src/service');

const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-session-tests-'));
let databaseCounter = 0;

process.removeAllListeners('warning');
process.on('warning', () => {});

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

const input = (tick, unit, command) => ({ command, tick, unit });

/** Create the standard match and a session owning red-1. */
function seeded(service, matchId = 'match-1', sessionId = 'p1') {
  service.createMatch(matchConfig({ id: matchId }), `create-${matchId}`);
  const session = service.createSession(matchId, { id: sessionId, units: ['red-1'] }, `session-${sessionId}`);
  return session;
}

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

test('creating a session binds its units and returns connected', () => {
  withService((service) => {
    const session = seeded(service);
    assert.deepEqual(session, {
      match_id: 'match-1', session_id: 'p1', status: 'connected', units: ['red-1'],
    });

    // Sessions are invisible to the match state and its hash.
    const state = service.getState('match-1');
    assert.equal(state.tick, 0);
    assert.doesNotMatch(JSON.stringify(state), /session/);
  });
});

test('session creation validates id and units', () => {
  withService((service) => {
    service.createMatch(matchConfig(), 'create');
    const create = (body) => service.createSession('match-1', body, `key-${JSON.stringify(body)}`);
    assert.throws(() => create({ id: '', units: ['red-1'] }), ValidationError);
    assert.throws(() => create({ id: 'p 1', units: ['red-1'] }), ValidationError);
    assert.throws(() => create({ id: 'p1', units: [] }), ValidationError);
    assert.throws(() => create({ id: 'p1', units: 'red-1' }), ValidationError);
    assert.throws(() => create({ id: 'p1', units: ['red-1', 'red-1'] }), ValidationError);
    assert.throws(() => create({ id: 'p1', units: ['ghost'] }), ValidationError);
    assert.throws(() => create({ id: 'p1', units: ['red-1'], extra: 1 }), ValidationError);
    assert.throws(() => create({ units: ['red-1'] }), ValidationError);
    assert.throws(() => service.createSession('nope', { id: 'p1', units: ['red-1'] }, 'key'), NotFoundError);
    assert.throws(() => service.createSession('match-1', { id: 'p1', units: ['red-1'] }), ValidationError);
  });
});

test('a unit belongs to at most one session and session ids are unique', () => {
  withService((service) => {
    seeded(service, 'match-1', 'p1');
    assert.throws(
      () => service.createSession('match-1', { id: 'p2', units: ['red-1'] }, 'p2'),
      ConflictError,
    );
    assert.throws(
      () => service.createSession('match-1', { id: 'p1', units: ['blue-1'] }, 'p1-again'),
      ConflictError,
    );
    // The failed claims changed nothing: blue-1 can still get its own session.
    assert.deepEqual(
      service.createSession('match-1', { id: 'p3', units: ['blue-1'] }, 'p3').units,
      ['blue-1'],
    );
  });
});

test('session inputs follow the same rules as global inputs and reject foreign units', () => {
  withService((service) => {
    seeded(service);
    const result = service.submitSessionInputs('match-1', 'p1', { inputs: [
      input(0, 'red-1', { by: 3, kind: 'move' }),
      input(0, 'blue-1', { kind: 'move', position: 500 }),
      input(0, 'red-1', { attacking: true, kind: 'attack' }),
      input(0, 'red-1', { by: 3, kind: 'move' }),
      input(900, 'red-1', { by: 1, kind: 'move' }),
      input(0, 'ghost', { attacking: true, kind: 'attack' }),
    ] }, 'inputs-1');
    assert.equal(result.accepted.length, 2);
    assert.equal(result.duplicates.length, 1);
    assert.deepEqual(result.rejected.map((entry) => entry.reason),
      ['wrong_session', 'out_of_range', 'unknown_unit']);
    assert.deepEqual(result.rejected.map((entry) => entry.index), [1, 4, 5]);
    assert.equal(result.inputs.accepted, 2);
    assert.equal(result.inputs.rejected, 3);

    // The rejected record never reached the log: it is accepted later as new.
    const retry = service.submitSessionInputs('match-1', 'p1', {
      inputs: [input(0, 'blue-1', { kind: 'move', position: 500 })],
    }, 'inputs-2');
    assert.equal(retry.rejected.length, 1);
    assert.equal(retry.rejected[0].reason, 'wrong_session');

    assert.throws(() => service.submitSessionInputs('match-1', 'ghost', { inputs: [] }, 'k'), NotFoundError);
    assert.throws(() => service.submitSessionInputs('nope', 'p1', { inputs: [] }, 'k'), NotFoundError);
  });
});

test('the global input route stays ungated after sessions exist', () => {
  withService((service) => {
    seeded(service);
    const result = service.submitInputs('match-1', { inputs: [
      input(0, 'red-1', { by: 3, kind: 'move' }),
      input(0, 'blue-1', { kind: 'move', position: 500 }),
    ] }, 'global');
    assert.equal(result.accepted.length, 2);
  });
});

test('session channels cannot change the deterministic result or the replay', () => {
  const viaGlobal = withService((service) => {
    service.createMatch(matchConfig({ id: 'global' }), 'create');
    service.submitInputs('global', { inputs: [
      input(0, 'red-1', { by: 3, kind: 'move' }),
      input(0, 'blue-1', { kind: 'move', position: 500 }),
      input(1, 'red-1', { attacking: true, kind: 'attack' }),
    ] }, 'inputs');
    return service.advance('global', { count: 4 }, 'advance').state_hash;
  });
  const viaSession = withService((service) => {
    service.createMatch(matchConfig({ id: 'session' }), 'create');
    const red = service.createSession('session', { id: 'red', units: ['red-1'] }, 's-red');
    const blue = service.createSession('session', { id: 'blue', units: ['blue-1'] }, 's-blue');
    assert.deepEqual(red.status, 'connected');
    service.submitSessionInputs('session', 'red', { inputs: [
      input(0, 'red-1', { by: 3, kind: 'move' }),
      input(1, 'red-1', { attacking: true, kind: 'attack' }),
    ] }, 'red-inputs');
    service.submitSessionInputs('session', 'blue', {
      inputs: [input(0, 'blue-1', { kind: 'move', position: 500 })],
    }, 'blue-inputs');
    const advanced = service.advance('session', { count: 4 }, 'advance');
    assert.equal(service.verify({ match_id: 'session' }).consistent, true);
    const replay = service.replayFile('session');
    assert.deepEqual(Object.keys(replay).sort(), ['frames', 'inputs', 'kind', 'match', 'replay_hash', 'version']);
    assert.equal(service.verify({ replay }).consistent, true);
    return advanced.state_hash;
  });
  assert.equal(viaSession, viaGlobal);
});

test('a disconnected session cannot submit, and a rejected request changes nothing', () => {
  withService((service) => {
    seeded(service);
    const disconnected = service.disconnect('match-1', 'p1', {}, 'disconnect');
    assert.equal(disconnected.status, 'disconnected');

    assert.throws(
      () => service.submitSessionInputs('match-1', 'p1', {
        inputs: [input(0, 'red-1', { by: 3, kind: 'move' })],
      }, 'late'),
      ConflictError,
    );
    assert.equal(service.getState('match-1').inputs.accepted, 0);
    assert.equal(service.getState('match-1').tick, 0);

    // Disconnect is idempotent for the same key.
    assert.equal(service.disconnect('match-1', 'p1', {}, 'disconnect').status, 'disconnected');
  });
});

test('resume catches up frame summaries incrementally with full unit state', () => {
  withService((service) => {
    seeded(service);
    service.submitSessionInputs('match-1', 'p1', { inputs: [
      input(0, 'red-1', { attacking: true, kind: 'attack' }),
      input(1, 'red-1', { attacking: false, kind: 'attack' }),
    ] }, 'inputs');
    const advanced = service.advance('match-1', { count: 8 }, 'advance');
    service.disconnect('match-1', 'p1', {}, 'disconnect');

    const first = service.resume('match-1', 'p1', { after_tick: 0, limit: 3 }, 'resume-1');
    assert.equal(first.status, 'connected');
    assert.equal(first.complete, false);
    assert.equal(first.next_tick, 3);
    assert.equal(first.after_tick, 0);
    assert.deepEqual(first.frames.map((frame) => frame.tick), [1, 2, 3]);
    assert.equal(first.frames[0].state_hash, advanced.frames[0].state_hash);
    assert.equal(first.state_hash, advanced.frames[2].state_hash);
    assert.equal(first.units.length, 2);
    assert.equal(first.team_damage.blue, 0);

    // Disconnect again and resume the remaining window: it reaches the frontier.
    service.disconnect('match-1', 'p1', {}, 'disconnect-2');
    const rest = service.resume('match-1', 'p1', { after_tick: 3, limit: 1024 }, 'resume-2');
    assert.deepEqual(rest.frames.map((frame) => frame.tick), [4, 5, 6, 7, 8]);
    assert.equal(rest.complete, true);
    assert.equal(rest.next_tick, 8);
    assert.equal(rest.state_hash, advanced.state_hash);
    const finalState = service.getState('match-1');
    assert.deepEqual(rest.team_damage, {
      blue: finalState.teams.blue.damage, red: finalState.teams.red.damage,
    });
    assert.deepEqual(
      rest.units.find((unit) => unit.id === 'red-1'),
      advanced.units.find((unit) => unit.id === 'red-1'),
    );

    // Resuming exactly from the frontier is an empty, complete window.
    const atFrontier = service.resume('match-1', 'p1', { after_tick: 8 }, 'resume-3');
    assert.equal(atFrontier.complete, true);
    assert.deepEqual(atFrontier.frames, []);
    assert.equal(atFrontier.next_tick, 8);
    assert.equal(atFrontier.state_hash, advanced.state_hash);

    // Repeating the first resume with its key replays the stored first response.
    assert.deepEqual(service.resume('match-1', 'p1', { after_tick: 0, limit: 3 }, 'resume-1'), first);
  });
});

test('resume validates its body and refuses a future tick', () => {
  withService((service) => {
    seeded(service);
    service.advance('match-1', { count: 2 }, 'advance');
    service.disconnect('match-1', 'p1', {}, 'disconnect');
    const resume = (body, key = `key-${JSON.stringify(body)}`) =>
      service.resume('match-1', 'p1', body, key);
    assert.throws(() => resume({ after_tick: -1 }), ValidationError);
    assert.throws(() => resume({ after_tick: 1.5 }), ValidationError);
    assert.throws(() => resume({ after_tick: '1' }), ValidationError);
    assert.throws(() => resume({ limit: 0 }), ValidationError);
    assert.throws(() => resume({ limit: 1025 }), ValidationError);
    assert.throws(() => resume({ limit: 2.5 }), ValidationError);
    assert.throws(() => resume({ after_tick: 0, limit: 3, extra: 1 }), ValidationError);
    assert.throws(() => service.resume('match-1', 'ghost', { after_tick: 0 }, 'x'), NotFoundError);
    assert.throws(() => service.resume('nope', 'p1', { after_tick: 0 }, 'x'), NotFoundError);

    assert.throws(() => resume({ after_tick: 5 }), ConflictError);
    // The failed resume left the session disconnected and frames intact.
    const state = service.getState('match-1');
    assert.equal(state.tick, 2);
    const retried = service.resume('match-1', 'p1', { after_tick: 2 }, 'after-failure');
    assert.equal(retried.status, 'connected');
    assert.equal(retried.complete, true);
  });
});

test('resume key reuse for another body or operation conflicts', () => {
  withService((service) => {
    seeded(service);
    service.advance('match-1', { count: 4 }, 'advance');
    service.resume('match-1', 'p1', { after_tick: 0, limit: 2 }, 'shared');
    assert.throws(() => service.resume('match-1', 'p1', { after_tick: 1, limit: 2 }, 'shared'), ConflictError);
    assert.throws(
      () => service.disconnect('match-1', 'p1', {}, 'shared'),
      ConflictError,
    );
  });
});

test('a late input through a session still rolls back with hash integrity', () => {
  withService((service) => {
    seeded(service);
    service.submitSessionInputs('match-1', 'p1', {
      inputs: [input(0, 'red-1', { kind: 'move', position: 10 })],
    }, 'inputs-1');
    const early = service.advance('match-1', { count: 6 }, 'advance-1');
    const late = service.submitSessionInputs('match-1', 'p1', {
      inputs: [input(2, 'red-1', { by: 8, kind: 'move' })],
    }, 'inputs-2');
    assert.equal(late.inputs.rollbacks, 1);
    assert.equal(late.rollback.to_tick, 2);
    assert.equal(late.rollback.from_tick, 6);
    assert.equal(late.tick, 6);
    assert.notEqual(late.state_hash, early.state_hash);
    assert.equal(service.verify({ match_id: 'match-1' }).consistent, true);
  });
});

test('resume detects tampered snapshots and gaps in the frame log', () => {
  withService((service) => {
    seeded(service, 'tamper-1');
    service.advance('tamper-1', { count: 4 }, 'advance');
    service.disconnect('tamper-1', 'p1', {}, 'disconnect');
    // A recorded snapshot whose state no longer hashes to its state_hash must
    // be reported instead of handing the client a fabricated catch-up state.
    const frame = service.store.connection.prepare('SELECT state_json FROM frames WHERE match_id = ? AND tick = ?')
      .get('tamper-1', 4);
    const snapshot = JSON.parse(frame.state_json);
    snapshot.units.find((unit) => unit.id === 'red-1').health -= 5;
    service.store.connection.prepare('UPDATE frames SET state_json = ? WHERE match_id = ? AND tick = ?')
      .run(JSON.stringify(snapshot), 'tamper-1', 4);
    assert.throws(
      () => service.resume('tamper-1', 'p1', { after_tick: 0 }, 'resume'),
      (error) => error instanceof IntegrityError && error.code === 'integrity_failure',
    );
  });

  withService((service) => {
    seeded(service, 'tamper-2');
    service.advance('tamper-2', { count: 4 }, 'advance-2');
    service.disconnect('tamper-2', 'p1', {}, 'disconnect-2');
    service.store.connection.prepare('DELETE FROM frames WHERE match_id = ? AND tick = ?')
      .run('tamper-2', 2);
    assert.throws(
      () => service.resume('tamper-2', 'p1', { after_tick: 0, limit: 4 }, 'resume-2'),
      IntegrityError,
    );
  });
});

test('the HTTP server serves the session routes', async () => {
  const { createServer } = require('../src/http');
  const service = new Lockstep(databasePath());
  const server = createServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, key) => {
    const response = await fetch(`${base}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      method,
    });
    return { body: await response.json(), status: response.status };
  };

  try {
    await call('POST', '/matches', matchConfig({ id: 'http-session' }), 'create');

    const created = await call('POST', '/matches/http-session/sessions', { id: 'p1', units: ['red-1'] }, 'sess');
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, {
      match_id: 'http-session', session_id: 'p1', status: 'connected', units: ['red-1'],
    });
    assert.equal((await call('POST', '/matches/http-session/sessions', { id: 'p1', units: ['red-1'] })).status, 400);
    assert.equal((await call('POST', '/matches/http-session/sessions', { id: 'p2', units: ['red-1'] }, 'p2')).status, 409);
    assert.equal((await call('POST', '/matches/http-session/sessions', { id: 'bad', units: [] }, 'bad')).status, 400);

    const submitted = await call('POST', '/matches/http-session/sessions/p1/inputs', { inputs: [
      input(0, 'red-1', { kind: 'move', position: 12 }),
      input(0, 'blue-1', { kind: 'move', position: 12 }),
    ] }, 'inputs');
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.accepted.length, 1);
    assert.equal(submitted.body.rejected[0].reason, 'wrong_session');

    await call('POST', '/matches/http-session/tick', { count: 5 }, 'tick');
    const disconnected = await call('POST', '/matches/http-session/sessions/p1/disconnect', {}, 'off');
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.status, 'disconnected');
    assert.equal((await call('POST', '/matches/http-session/sessions/p1/inputs', {
      inputs: [input(1, 'red-1', { by: 1, kind: 'move' })],
    }, 'while-off')).status, 409);

    const resumed = await call('POST', '/matches/http-session/sessions/p1/resume', { after_tick: 2, limit: 2 }, 'back');
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.body.frames.map((frame) => frame.tick), [3, 4]);
    assert.equal(resumed.body.complete, false);
    assert.equal(resumed.body.next_tick, 4);

    assert.equal((await call('POST', '/matches/http-session/sessions/nope/resume', { after_tick: 0 }, 'x')).status, 404);
    assert.equal((await call('POST', '/matches/missing/sessions', { id: 'p1', units: ['red-1'] }, 'x')).status, 404);
    assert.equal((await call('POST', '/matches/http-session/sessions/p1/resume', { after_tick: 99 }, 'future')).status, 409);
    assert.equal((await call('POST', '/matches/http-session/sessions/p1/resume', { after_tick: -1 }, 'neg')).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.close();
  }
});
