'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { ConflictError, IntegrityError, NotFoundError, ValidationError } = require('../src/errors');
const { Lockstep } = require('../src/service');

const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-sessions-'));
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

function config(overrides = {}) {
  return {
    id: 'match-1',
    max_ticks: 64,
    seed: 11,
    units: [
      { id: 'blue-1', position: 990, team: 'blue', velocity: 0 },
      { id: 'red-1', position: 0, team: 'red', velocity: 0 },
      { id: 'red-2', position: 10, team: 'red', velocity: 0 },
    ],
    ...overrides,
  };
}

const attack = (tick, unit) => ({ command: { attacking: true, kind: 'attack' }, tick, unit });
const move = (tick, unit, by) => ({ command: { by, kind: 'move' }, tick, unit });

function setup(service, matchId = 'match-1') {
  service.createMatch(config({ id: matchId }), `create-${matchId}`);
  return matchId;
}

/** Frames 0..7 where red-1 advances and attacks, blue-1 shoots back. */
function battleLog() {
  return [
    move(0, 'red-1', 3), move(2, 'red-1', 5), move(4, 'red-1', 7), move(6, 'red-1', 9),
    attack(1, 'red-1'), attack(3, 'red-1'), attack(5, 'red-1'), attack(7, 'red-1'),
    attack(0, 'blue-1'), attack(2, 'blue-1'), attack(4, 'blue-1'), attack(6, 'blue-1'),
  ];
}

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

test('a session is created connected and returns its binding', () => {
  withService((service) => {
    setup(service);
    const session = service.createSession('match-1', { id: 'p1', units: ['red-2', 'red-1'] }, 'session-1');
    assert.equal(session.status, 'connected');
    assert.equal(session.session_id, 'p1');
    assert.equal(session.match_id, 'match-1');
    assert.deepEqual(session.units, ['red-1', 'red-2']);

    // Idempotent replay of the exact request.
    assert.deepEqual(
      service.createSession('match-1', { id: 'p1', units: ['red-2', 'red-1'] }, 'session-1'),
      session,
    );
  });
});

test('session units must be a non-empty list of distinct, known, unbound units', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');

    const rejects = (body) => assert.throws(
      () => service.createSession('match-1', body, `key-${JSON.stringify(body)}`),
      ValidationError,
    );
    rejects({ id: 'p2', units: [] });
    rejects({ id: 'p2', units: ['red-1', 'red-1'] });
    rejects({ id: 'p2', units: ['ghost'] });
    rejects({ id: 'bad id', units: ['red-2'] });
    rejects({ id: 9, units: ['red-2'] });
    rejects({ id: 'p3', units: ['red-2'], extra: true });
    rejects({ units: ['red-2'] });
    // A unit already bound to another session is a conflict, not a validation error.
    assert.throws(() => service.createSession('match-1', { id: 'p2', units: ['red-2', 'red-1'] }, 'overlap'),
      ConflictError);
    assert.throws(() => service.createSession('match-1', { id: 'p1', units: ['red-2'] }, 'session-2'),
      ConflictError);
  });
});

test('a session id reused for another operation or body is a conflict', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'shared-key');
    assert.throws(
      () => service.submitSessionInputs('match-1', 'p1', { inputs: [attack(0, 'red-1')] }, 'shared-key'),
      ConflictError,
    );
    assert.throws(
      () => service.createSession('match-1', { id: 'p2', units: ['blue-1'] }, 'shared-key'),
      ConflictError,
    );
  });
});

test('session inputs reuse the global rules and reject foreign units as wrong_session', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');
    const result = service.submitSessionInputs('match-1', 'p1', {
      inputs: [
        attack(0, 'red-1'),
        attack(0, 'red-2'),
        attack(0, 'blue-1'),
        attack(900, 'red-1'),
        attack(0, 'ghost'),
      ],
    }, 'inputs-1');
    assert.equal(result.accepted.length, 1);
    assert.deepEqual(result.rejected.map((entry) => entry.reason),
      ['wrong_session', 'wrong_session', 'out_of_range', 'unknown_unit']);
    assert.deepEqual(result.rejected.map((entry) => entry.index), [1, 2, 3, 4]);
    assert.equal(result.inputs.rejected, 4);
    assert.equal(result.inputs.accepted, 1);

    // The same record through the match-wide endpoint is now a duplicate.
    const again = service.submitInputs('match-1', { inputs: [attack(0, 'red-1')] }, 'inputs-2');
    assert.equal(again.duplicates.length, 1);

    // A session-scoped duplicate is counted exactly like a global one.
    const dup = service.submitSessionInputs('match-1', 'p1', { inputs: [attack(0, 'red-1')] }, 'inputs-3');
    assert.equal(dup.duplicates.length, 1);
    assert.equal(dup.accepted.length, 0);
  });
});

test('a disconnected session cannot submit inputs and the failure changes nothing', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');
    service.submitSessionInputs('match-1', 'p1', { inputs: [attack(0, 'red-1')] }, 'inputs-1');
    service.advance('match-1', { count: 2 }, 'advance-1');
    service.disconnectSession('match-1', 'p1', {}, 'disconnect-1');

    const before = service.getState('match-1');
    assert.throws(
      () => service.submitSessionInputs('match-1', 'p1', { inputs: [attack(1, 'red-1')] }, 'inputs-2'),
      ConflictError,
    );
    const after = service.getState('match-1');
    assert.equal(after.tick, before.tick);
    assert.equal(after.state_hash, before.state_hash);
    assert.equal(after.inputs.accepted, before.inputs.accepted);

    // Disconnect is idempotent; reconnecting lets inputs flow again.
    assert.equal(service.disconnectSession('match-1', 'p1', {}, 'disconnect-1').status, 'disconnected');
    service.resumeSession('match-1', 'p1', { after_tick: 2, limit: 1024 }, 'resume-1');
    assert.doesNotThrow(
      () => service.submitSessionInputs('match-1', 'p1', { inputs: [attack(2, 'red-1')] }, 'inputs-3'),
    );
  });
});

test('resume streams contiguous frames after after_tick and catches unit state up', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1', 'red-2'] }, 'session-1');
    service.submitSessionInputs('match-1', 'p1', { inputs: battleLog() }, 'inputs-1');
    const advanced = service.advance('match-1', { count: 8 }, 'advance-1');
    service.disconnectSession('match-1', 'p1', {}, 'disconnect-1');

    const resumed = service.resumeSession('match-1', 'p1', { after_tick: 4, limit: 1024 }, 'resume-1');
    assert.equal(resumed.status, 'connected');
    assert.equal(resumed.complete, true);
    assert.equal(resumed.next_tick, 8);
    assert.deepEqual(resumed.frames.map((frame) => frame.tick), [5, 6, 7, 8]);
    assert.deepEqual(resumed.frames, advanced.frames.slice(4));

    // The top-level hash is the frontier hash; every window frame keeps its hash.
    assert.equal(resumed.state_hash, advanced.state_hash);
    for (const frame of resumed.frames) {
      assert.equal(frame.state_hash, advanced.frames.find((candidate) => candidate.tick === frame.tick).state_hash);
    }

    // Unit states and team damage are projected at the frontier.
    const current = service.getState('match-1');
    for (const id of ['red-1', 'red-2']) {
      const expected = current.units.find((unit) => unit.id === id);
      assert.deepEqual(resumed.units.find((unit) => unit.id === id), expected);
    }
    assert.deepEqual(resumed.team_damage, {
      blue: current.teams.blue.damage, red: current.teams.red.damage,
    });

    // An identical resume call returns the stored first response.
    const replay = service.resumeSession('match-1', 'p1', { after_tick: 4, limit: 1024 }, 'resume-1');
    assert.deepEqual(replay, resumed);
  });
});

test('a partial window reports complete=false and is paged with next_tick', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');
    service.submitSessionInputs('match-1', 'p1', { inputs: battleLog() }, 'inputs-1');
    const advanced = service.advance('match-1', { count: 8 }, 'advance-1');
    service.disconnectSession('match-1', 'p1', {}, 'disconnect-1');

    const first = service.resumeSession('match-1', 'p1', { after_tick: 2, limit: 3 }, 'resume-1');
    assert.equal(first.complete, false);
    assert.equal(first.next_tick, 5);
    assert.deepEqual(first.frames.map((frame) => frame.tick), [3, 4, 5]);
    // Mid-window state hash, team damage and units come from frame 5's snapshot.
    const frameFive = advanced.frames[4];
    assert.equal(first.state_hash, frameFive.state_hash);

    const second = service.resumeSession('match-1', 'p1', { after_tick: 5, limit: 1024 }, 'resume-2');
    assert.equal(second.complete, true);
    assert.equal(second.next_tick, 8);
    assert.deepEqual(second.frames.map((frame) => frame.tick), [6, 7, 8]);

    // Resuming from the frontier is an empty, already-complete window.
    const caughtUp = service.resumeSession('match-1', 'p1', { after_tick: 8, limit: 1024 }, 'resume-3');
    assert.equal(caughtUp.complete, true);
    assert.deepEqual(caughtUp.frames, []);
    assert.equal(caughtUp.next_tick, 8);
  });
});

test('limit defaults to 1024 and rejects values outside 1..1024; after_tick is validated', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');
    service.advance('match-1', { count: 1 }, 'advance-1');
    service.disconnectSession('match-1', 'p1', {}, 'disconnect-1');

    for (const bad of [
      { after_tick: -1 }, { after_tick: 1.5 }, { after_tick: '1' }, {},
      { after_tick: 0, limit: 0 }, { after_tick: 0, limit: 1025 },
      { after_tick: 0, limit: 1.5 }, { after_tick: 0, limit: '2' },
      { after_tick: 0, extra: true },
    ]) {
      assert.throws(
        () => service.resumeSession('match-1', 'p1', bad, `bad-${JSON.stringify(bad)}`),
        ValidationError,
      );
    }
    // Failed validation and the ahead-of-frontier conflict leave the session down.
    assert.throws(
      () => service.resumeSession('match-1', 'p1', { after_tick: 5 }, 'resume-ahead'),
      ConflictError,
    );
    assert.equal(service.store.readSession('match-1', 'p1').status, 'disconnected');

    // limit defaults to 1024; a successful call reconnects and reaches the frontier.
    const resumed = service.resumeSession('match-1', 'p1', { after_tick: 0 }, 'resume-ok');
    assert.equal(resumed.complete, true);
    assert.equal(resumed.next_tick, 1);
    assert.equal(service.store.readSession('match-1', 'p1').status, 'connected');
  });
});

test('unknown matches and sessions are not found', () => {
  withService((service) => {
    setup(service);
    assert.throws(() => service.createSession('nope', { id: 'p1', units: ['red-1'] }, 'k1'), NotFoundError);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');
    assert.throws(() => service.submitSessionInputs('match-1', 'ghost', { inputs: [] }, 'k2'), NotFoundError);
    assert.throws(() => service.disconnectSession('match-1', 'ghost', {}, 'k3'), NotFoundError);
    assert.throws(() => service.resumeSession('match-1', 'ghost', { after_tick: 0 }, 'k4'), NotFoundError);
  });
});

test('a late session input rolls back and the resume window recomputes identically', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');
    service.submitSessionInputs('match-1', 'p1', { inputs: battleLog().filter((record) => record.tick >= 2) }, 'inputs-1');
    const early = service.advance('match-1', { count: 8 }, 'advance-1');

    const late = service.submitSessionInputs('match-1', 'p1', { inputs: [attack(0, 'red-1')] }, 'inputs-2');
    assert.notEqual(late.rollback, null);
    assert.equal(late.rollback.to_tick, 0);
    assert.notEqual(late.state_hash, early.state_hash);

    service.disconnectSession('match-1', 'p1', {}, 'disconnect-1');
    const resumed = service.resumeSession('match-1', 'p1', { after_tick: 0, limit: 1024 }, 'resume-1');
    assert.equal(resumed.complete, true);
    assert.equal(resumed.state_hash, late.state_hash);
    assert.equal(service.verify({ match_id: 'match-1' }).consistent, true);
  });
});

test('a tampered frame turns catch-up into an integrity failure', () => {
  withService((service) => {
    setup(service);
    service.createSession('match-1', { id: 'p1', units: ['red-1'] }, 'session-1');
    service.submitSessionInputs('match-1', 'p1', { inputs: battleLog() }, 'inputs-1');
    service.advance('match-1', { count: 8 }, 'advance-1');
    service.disconnectSession('match-1', 'p1', {}, 'disconnect-1');

    service.store.connection.prepare('UPDATE frames SET state_hash = ? WHERE match_id = ? AND tick = ?')
      .run('f'.repeat(64), 'match-1', 6);
    assert.throws(
      () => service.resumeSession('match-1', 'p1', { after_tick: 4, limit: 1024 }, 'resume-1'),
      IntegrityError,
    );
    // The failed resume must not have reconnected the session.
    assert.equal(service.store.readSession('match-1', 'p1').status, 'disconnected');
  });
});

test('session metadata never enters the state hash or replay document', () => {
  const without = withService((service) => {
    setup(service, 'shared');
    service.submitInputs('shared', { inputs: battleLog() }, 'inputs');
    service.advance('shared', { count: 8 }, 'advance');
    return { state: service.getState('shared'), replay: service.replayFile('shared') };
  });
  const withSession = withService((service) => {
    setup(service, 'shared');
    service.createSession('shared', { id: 'p1', units: ['red-1'] }, 'session-1');
    service.createSession('shared', { id: 'p2', units: ['blue-1', 'red-2'] }, 'session-2');
    service.submitSessionInputs('shared', 'p1', { inputs: battleLog().filter((record) => record.unit === 'red-1') }, 'i1');
    service.submitSessionInputs('shared', 'p2', { inputs: battleLog().filter((record) => record.unit !== 'red-1') }, 'i2');
    service.advance('shared', { count: 8 }, 'advance');
    return { state: service.getState('shared'), replay: service.replayFile('shared') };
  });
  assert.equal(withSession.state.state_hash, without.state.state_hash);
  assert.equal(withSession.replay.replay_hash, without.replay.replay_hash);
  assert.deepEqual(withSession.replay.frames, without.replay.frames);
  assert.equal(JSON.stringify(withSession.replay).includes('p1'), false);
});

test('the HTTP server exposes the session routes and enforces the key header', async () => {
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
    await call('POST', '/matches', config({ id: 'http' }), 'create');
    const created = await call('POST', '/matches/http/sessions', { id: 'p1', units: ['red-1', 'red-2'] }, 'sess');
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'connected');
    assert.deepEqual(created.body.units, ['red-1', 'red-2']);
    assert.equal((await call('POST', '/matches/http/sessions', { id: 'pX', units: [] }, 'bad')).status, 400);
    assert.equal((await call('POST', '/matches/http/sessions', { id: 'pX', units: ['red-1'] })).status, 400);

    const inputs = await call('POST', '/matches/http/sessions/p1/inputs', {
      inputs: [attack(0, 'red-1'), attack(0, 'blue-1')],
    }, 'sess-inputs');
    assert.equal(inputs.status, 201);
    assert.equal(inputs.body.accepted.length, 1);
    assert.equal(inputs.body.rejected[0].reason, 'wrong_session');
    assert.equal((await call('POST', '/matches/http/sessions/p1/inputs', { inputs: [] })).status, 400);

    await call('POST', '/matches/http/tick', { count: 6 }, 'tick');
    const disconnected = await call('POST', '/matches/http/sessions/p1/disconnect', {}, 'disconnect');
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.status, 'disconnected');
    assert.equal((await call('POST', '/matches/http/sessions/p1/inputs', { inputs: [] }, 'down')).status, 409);

    const resumed = await call('POST', '/matches/http/sessions/p1/resume', { after_tick: 2, limit: 3 }, 'resume');
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, 'connected');
    assert.equal(resumed.body.complete, false);
    assert.equal(resumed.body.next_tick, 5);
    assert.deepEqual(resumed.body.frames.map((frame) => frame.tick), [3, 4, 5]);

    assert.equal((await call('POST', '/matches/http/sessions/missing/resume', { after_tick: 0 }, 'x')).status, 404);
    assert.equal((await call('POST', '/matches/missing/sessions', { id: 'p1', units: ['red-1'] }, 'x')).status, 404);
    assert.equal((await call('POST', '/matches/http/sessions/p1/resume', { after_tick: 99 }, 'ahead')).status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.close();
  }
});
