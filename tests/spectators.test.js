'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { ConflictError, IntegrityError, NotFoundError, ValidationError } = require('../src/errors');
const { Lockstep } = require('../src/service');

const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-spectators-'));
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

function battle(service, matchId = 'match-1') {
  setup(service, matchId);
  service.submitInputs(matchId, { inputs: battleLog() }, 'inputs-1');
  return service.advance(matchId, { count: 8 }, 'advance-1');
}

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

test('a spectator is created with its delayed visible frontier', () => {
  withService((service) => {
    battle(service);

    const delayed = service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 3 }, 'spec-1');
    assert.equal(delayed.spectator_id, 'cast-1');
    assert.equal(delayed.match_id, 'match-1');
    assert.equal(delayed.delay_ticks, 3);
    assert.equal(delayed.visible_tick, 5);

    const live = service.createSpectator('match-1', { id: 'cast-2', delay_ticks: 0 }, 'spec-2');
    assert.equal(live.visible_tick, 8);

    // A delay larger than the frontier clamps to tick 0.
    const far = service.createSpectator('match-1', { id: 'cast-3', delay_ticks: 100 }, 'spec-3');
    assert.equal(far.visible_tick, 0);

    // Idempotent replay of the exact request.
    assert.deepEqual(
      service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 3 }, 'spec-1'),
      delayed,
    );
  });
});

test('a finished match exposes its final tick to every spectator', () => {
  withService((service) => {
    service.createMatch(config({ max_ticks: 4 }), 'create-match-1');
    service.advance('match-1', { count: 4 }, 'advance-1');
    assert.equal(service.getState('match-1').status, 'max_ticks');

    const spectator = service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 3 }, 'spec-1');
    assert.equal(spectator.visible_tick, 4);

    const poll = service.pollSpectator('match-1', 'cast-1', {}, 'poll-1');
    assert.equal(poll.visible_tick, 4);
    assert.equal(poll.complete, true);
    assert.deepEqual(poll.frames.map((frame) => frame.tick), [1, 2, 3, 4]);
  });
});

test('spectator creation validates the body and enforces uniqueness', () => {
  withService((service) => {
    setup(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 2 }, 'spec-1');

    const rejects = (body) => assert.throws(
      () => service.createSpectator('match-1', body, `key-${JSON.stringify(body)}`),
      ValidationError,
    );
    rejects({ id: 'cast-2' });
    rejects({ delay_ticks: 2 });
    rejects({ id: 'bad id', delay_ticks: 2 });
    rejects({ id: 9, delay_ticks: 2 });
    rejects({ id: 'cast-2', delay_ticks: -1 });
    rejects({ id: 'cast-2', delay_ticks: 1025 });
    rejects({ id: 'cast-2', delay_ticks: 1.5 });
    rejects({ id: 'cast-2', delay_ticks: '2' });
    rejects({ id: 'cast-2', delay_ticks: 2, extra: true });

    // A duplicate id is a conflict, as is reusing a key for another body.
    assert.throws(
      () => service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 0 }, 'spec-2'),
      ConflictError,
    );
    assert.throws(
      () => service.createSpectator('match-1', { id: 'cast-9', delay_ticks: 2 }, 'spec-1'),
      ConflictError,
    );
    // A missing Idempotency-Key is a validation error.
    assert.throws(
      () => service.createSpectator('match-1', { id: 'cast-9', delay_ticks: 2 }, undefined),
      ValidationError,
    );
    // An unknown match is not found.
    assert.throws(
      () => service.createSpectator('nope', { id: 'cast-1', delay_ticks: 2 }, 'spec-x'),
      NotFoundError,
    );
  });
});

test('poll streams contiguous frames up to the delayed visible tick', () => {
  withService((service) => {
    const advanced = battle(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 3 }, 'spec-1');

    const poll = service.pollSpectator('match-1', 'cast-1', {}, 'poll-1');
    assert.equal(poll.mode, 'stream');
    assert.equal(poll.visible_tick, 5);
    assert.equal(poll.complete, true);
    assert.equal(poll.next_tick, 5);
    assert.deepEqual(poll.frames.map((frame) => frame.tick), [1, 2, 3, 4, 5]);
    assert.deepEqual(poll.frames, advanced.frames.slice(0, 5));

    // State is projected at next_tick, not at the live frontier.
    const frameFive = service.store.readFrames('match-1').find((frame) => frame.tick === 5);
    assert.equal(poll.state_hash, frameFive.state_hash);
    assert.deepEqual(poll.team_damage, {
      blue: frameFive.state.teams.blue, red: frameFive.state.teams.red,
    });
    const expectedUnits = frameFive.state.units
      .map((unit) => ({
        alive: unit.health > 0, attacking: unit.attacking, health: unit.health,
        id: unit.id, position: unit.position, team: unit.team, velocity: unit.velocity,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    assert.deepEqual(poll.units, expectedUnits);

    // An identical poll returns the stored first response.
    assert.deepEqual(service.pollSpectator('match-1', 'cast-1', {}, 'poll-1'), poll);
  });
});

test('a partial window reports complete=false and is paged with next_tick', () => {
  withService((service) => {
    battle(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 0 }, 'spec-1');

    const first = service.pollSpectator('match-1', 'cast-1', { after_tick: 2, limit: 3 }, 'poll-1');
    assert.equal(first.mode, 'stream');
    assert.equal(first.complete, false);
    assert.equal(first.next_tick, 5);
    assert.deepEqual(first.frames.map((frame) => frame.tick), [3, 4, 5]);

    const second = service.pollSpectator('match-1', 'cast-1', { after_tick: 5, limit: 1024 }, 'poll-2');
    assert.equal(second.complete, true);
    assert.equal(second.next_tick, 8);
    assert.deepEqual(second.frames.map((frame) => frame.tick), [6, 7, 8]);

    // Polling at the visible tick is an empty, already-complete window whose
    // snapshot is taken at after_tick.
    const caughtUp = service.pollSpectator('match-1', 'cast-1', { after_tick: 8 }, 'poll-3');
    assert.equal(caughtUp.complete, true);
    assert.deepEqual(caughtUp.frames, []);
    assert.equal(caughtUp.next_tick, 8);
    assert.equal(caughtUp.state_hash, service.getState('match-1').state_hash);
  });
});

test('poll validates its parameters and reports unknown matches and spectators', () => {
  withService((service) => {
    battle(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 3 }, 'spec-1');

    for (const bad of [
      { after_tick: -1 }, { after_tick: 1.5 }, { after_tick: '1' },
      { limit: 0 }, { limit: 1025 }, { limit: 1.5 }, { limit: '2' },
      { after_tick: 0, extra: true },
    ]) {
      assert.throws(
        () => service.pollSpectator('match-1', 'cast-1', bad, `bad-${JSON.stringify(bad)}`),
        ValidationError,
      );
    }
    // after_tick past the visible tick is a conflict in stream mode.
    assert.throws(() => service.pollSpectator('match-1', 'cast-1', { after_tick: 6 }, 'ahead'), ConflictError);
    // A missing Idempotency-Key is a validation error; a reused key conflicts.
    assert.throws(() => service.pollSpectator('match-1', 'cast-1', {}, undefined), ValidationError);
    service.pollSpectator('match-1', 'cast-1', { after_tick: 0 }, 'poll-1');
    assert.throws(() => service.pollSpectator('match-1', 'cast-1', { after_tick: 1 }, 'poll-1'), ConflictError);

    assert.throws(() => service.pollSpectator('match-1', 'ghost', {}, 'k1'), NotFoundError);
    assert.throws(() => service.pollSpectator('nope', 'cast-1', {}, 'k2'), NotFoundError);
  });
});

test('a rollback below the returned frontier resets the next poll', () => {
  withService((service) => {
    const advanced = battle(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 0 }, 'spec-1');
    const first = service.pollSpectator('match-1', 'cast-1', {}, 'poll-1');
    assert.equal(first.next_tick, 8);

    service.rollback('match-1', 3);
    const reset = service.pollSpectator('match-1', 'cast-1', { after_tick: 8 }, 'poll-2');
    assert.equal(reset.mode, 'reset');
    assert.equal(reset.visible_tick, 3);
    assert.equal(reset.complete, true);
    assert.equal(reset.next_tick, 3);
    assert.deepEqual(reset.frames.map((frame) => frame.tick), [1, 2, 3]);
    assert.deepEqual(reset.frames, advanced.frames.slice(0, 3));

    // Advancing again reproduces the hashes, and the spectator streams on.
    service.advance('match-1', { count: 5 }, 'advance-2');
    const resumed = service.pollSpectator('match-1', 'cast-1', { after_tick: 3 }, 'poll-3');
    assert.equal(resumed.mode, 'stream');
    assert.equal(resumed.complete, true);
    assert.deepEqual(resumed.frames.map((frame) => frame.tick), [4, 5, 6, 7, 8]);
    assert.deepEqual(resumed.frames, advanced.frames.slice(3));
  });
});

test('a reset poll ignores after_tick, even one past the visible tick', () => {
  withService((service) => {
    battle(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 0 }, 'spec-1');
    service.pollSpectator('match-1', 'cast-1', {}, 'poll-1');

    service.rollback('match-1', 2);
    const reset = service.pollSpectator('match-1', 'cast-1', { after_tick: 99, limit: 1 }, 'poll-2');
    assert.equal(reset.mode, 'reset');
    assert.equal(reset.complete, false);
    assert.equal(reset.next_tick, 1);
    assert.deepEqual(reset.frames.map((frame) => frame.tick), [1]);

    // The client pages the reset window with next_tick.
    const page = service.pollSpectator('match-1', 'cast-1', { after_tick: 1, limit: 1 }, 'poll-3');
    assert.equal(page.mode, 'stream');
    assert.deepEqual(page.frames.map((frame) => frame.tick), [2]);
    assert.equal(page.complete, true);
  });
});

test('a late input rollback resets the spectator even though the frontier returns', () => {
  withService((service) => {
    setup(service);
    service.submitInputs('match-1', { inputs: battleLog().filter((record) => record.tick >= 2) }, 'inputs-1');
    service.advance('match-1', { count: 8 }, 'advance-1');
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 0 }, 'spec-1');
    service.pollSpectator('match-1', 'cast-1', {}, 'poll-1');

    const late = service.submitInputs('match-1', { inputs: [attack(0, 'red-1')] }, 'inputs-2');
    assert.notEqual(late.rollback, null);
    assert.equal(late.rollback.to_tick, 0);
    assert.equal(service.getState('match-1').tick, 8);

    const reset = service.pollSpectator('match-1', 'cast-1', { after_tick: 8 }, 'poll-2');
    assert.equal(reset.mode, 'reset');
    assert.equal(reset.complete, true);
    assert.equal(reset.next_tick, 8);
    assert.deepEqual(reset.frames.map((frame) => frame.tick), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(reset.state_hash, late.state_hash);

    // A spectator that never received a frame is unaffected by the rollback.
    service.createSpectator('match-1', { id: 'cast-2', delay_ticks: 0 }, 'spec-2');
    const fresh = service.pollSpectator('match-1', 'cast-2', {}, 'poll-3');
    assert.equal(fresh.mode, 'stream');
  });
});

test('a rollback at or above the returned frontier does not reset', () => {
  withService((service) => {
    battle(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 0 }, 'spec-1');
    service.pollSpectator('match-1', 'cast-1', { limit: 4 }, 'poll-1');

    // The spectator holds frames up to tick 4; rewinding to 4 keeps streaming.
    service.rollback('match-1', 4);
    const poll = service.pollSpectator('match-1', 'cast-1', { after_tick: 4 }, 'poll-2');
    assert.equal(poll.mode, 'stream');
    assert.equal(poll.complete, true);
    assert.deepEqual(poll.frames, []);
  });
});

test('a tampered frame turns a poll into an integrity failure', () => {
  withService((service) => {
    battle(service);
    service.createSpectator('match-1', { id: 'cast-1', delay_ticks: 0 }, 'spec-1');

    service.store.connection.prepare('UPDATE frames SET state_hash = ? WHERE match_id = ? AND tick = ?')
      .run('f'.repeat(64), 'match-1', 6);
    assert.throws(
      () => service.pollSpectator('match-1', 'cast-1', {}, 'poll-1'),
      IntegrityError,
    );
  });
});

test('spectators never enter the state hash or replay document', () => {
  const without = withService((service) => {
    battle(service, 'shared');
    return { replay: service.replayFile('shared'), state: service.getState('shared') };
  });
  const withSpectators = withService((service) => {
    battle(service, 'shared');
    service.createSpectator('shared', { id: 'cast-1', delay_ticks: 2 }, 'spec-1');
    service.createSpectator('shared', { id: 'cast-2', delay_ticks: 0 }, 'spec-2');
    service.pollSpectator('shared', 'cast-1', {}, 'poll-1');
    service.pollSpectator('shared', 'cast-2', { limit: 3 }, 'poll-2');
    return { replay: service.replayFile('shared'), state: service.getState('shared') };
  });
  assert.equal(withSpectators.state.state_hash, without.state.state_hash);
  assert.equal(withSpectators.replay.replay_hash, without.replay.replay_hash);
  assert.deepEqual(withSpectators.replay.frames, without.replay.frames);
  assert.equal(JSON.stringify(withSpectators.replay).includes('cast-1'), false);
});

test('the HTTP server exposes the spectator routes and enforces the key header', async () => {
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
    await call('POST', '/matches/http/inputs', { inputs: battleLog() }, 'inputs');
    await call('POST', '/matches/http/tick', { count: 8 }, 'tick');

    const created = await call('POST', '/matches/http/spectators', { id: 'cast-1', delay_ticks: 3 }, 'spec');
    assert.equal(created.status, 201);
    assert.equal(created.body.spectator_id, 'cast-1');
    assert.equal(created.body.visible_tick, 5);
    assert.equal((await call('POST', '/matches/http/spectators', { id: 'cast-1', delay_ticks: 3 })).status, 400);
    assert.equal((await call('POST', '/matches/http/spectators', { id: 'cast-1', delay_ticks: 0 }, 'other')).status, 409);
    assert.equal((await call('POST', '/matches/http/spectators', { id: 'cast-2', delay_ticks: 2000 }, 'bad')).status, 400);

    const poll = await call('POST', '/matches/http/spectators/cast-1/poll', { after_tick: 0, limit: 3 }, 'poll');
    assert.equal(poll.status, 200);
    assert.equal(poll.body.mode, 'stream');
    assert.equal(poll.body.complete, false);
    assert.equal(poll.body.next_tick, 3);
    assert.deepEqual(poll.body.frames.map((frame) => frame.tick), [1, 2, 3]);

    assert.equal((await call('POST', '/matches/http/spectators/cast-1/poll', { after_tick: 99 }, 'ahead')).status, 409);
    assert.equal((await call('POST', '/matches/http/spectators/cast-1/poll', { limit: 0 }, 'bad')).status, 400);
    assert.equal((await call('POST', '/matches/http/spectators/ghost/poll', {}, 'x')).status, 404);
    assert.equal((await call('POST', '/matches/missing/spectators', { id: 'c', delay_ticks: 0 }, 'x')).status, 404);

    // A rollback below the served frontier switches the next poll to reset.
    await call('POST', '/matches/http/spectators', { id: 'cast-2', delay_ticks: 0 }, 'spec-2');
    await call('POST', '/matches/http/spectators/cast-2/poll', {}, 'poll-2');
    await call('POST', '/matches/http/rollback', { tick: 2 }, 'rollback');
    const reset = await call('POST', '/matches/http/spectators/cast-2/poll', { after_tick: 8 }, 'poll-3');
    assert.equal(reset.status, 200);
    assert.equal(reset.body.mode, 'reset');
    assert.equal(reset.body.next_tick, 2);
    assert.deepEqual(reset.body.frames.map((frame) => frame.tick), [1, 2]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.close();
  }
});
