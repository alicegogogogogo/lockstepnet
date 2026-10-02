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

function recordedFrames(service, matchId) {
  return service.store.readFrames(matchId).map((frame) => ({
    casualties: frame.delta.casualties, settled: frame.settled,
    state_hash: frame.state_hash, tick: frame.tick,
  }));
}

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

test('creating a spectator returns the binding and the delay-derived visible tick', () => {
  withService((service) => {
    setup(service);
    const before = service.createSpectator('match-1', { id: 'cam', delay_ticks: 4 }, 'spec-1');
    assert.equal(before.spectator_id, 'cam');
    assert.equal(before.match_id, 'match-1');
    assert.equal(before.delay_ticks, 4);
    assert.equal(before.visible_tick, 0);

    service.advance('match-1', { count: 8 }, 'advance-1');
    const created = service.createSpectator('match-1', { id: 'late-cam', delay_ticks: 3 }, 'spec-2');
    assert.equal(created.visible_tick, 5);

    // delay clamps visible_tick at 0, and an exact replay returns the first response.
    assert.deepEqual(
      service.createSpectator('match-1', { id: 'cam', delay_ticks: 4 }, 'spec-1'),
      before,
    );
  });
});

test('a finished match exposes the final tick regardless of the delay', () => {
  withService((service) => {
    service.createMatch(config({ id: 'done', max_ticks: 3 }), 'create-done');
    service.advance('done', { count: 3 }, 'advance-done');
    assert.equal(service.getState('done').status, 'max_ticks');
    const created = service.createSpectator('done', { id: 'cam', delay_ticks: 100 }, 'spec');
    assert.equal(created.visible_tick, 3);
    const polled = service.pollSpectator('done', 'cam', { after_tick: 0 }, 'poll');
    assert.deepEqual(polled.frames.map((frame) => frame.tick), [1, 2, 3]);
    assert.equal(polled.complete, true);
  });
});

test('duplicate spectator id is a conflict while malformed bodies are validation errors', () => {
  withService((service) => {
    setup(service);
    service.advance('match-1', { count: 2 }, 'advance');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'spec-1');

    assert.throws(
      () => service.createSpectator('match-1', { id: 'cam', delay_ticks: 1 }, 'spec-2'),
      ConflictError,
    );
    const rejects = (body) => assert.throws(
      () => service.createSpectator('match-1', body, `key-${JSON.stringify(body)}`),
      ValidationError,
    );
    rejects({ id: 'bad id', delay_ticks: 0 });
    rejects({ id: 9, delay_ticks: 0 });
    rejects({ id: 'cam2' });
    rejects({ id: 'cam2', delay_ticks: -1 });
    rejects({ id: 'cam2', delay_ticks: 1025 });
    rejects({ id: 'cam2', delay_ticks: 1.5 });
    rejects({ id: 'cam2', delay_ticks: '4' });
    rejects({ id: 'cam2', delay_ticks: 0, extra: true });
  });
});

test('both spectator POSTs require an idempotency key and reuse is a conflict', () => {
  withService((service) => {
    setup(service);
    assert.throws(() => service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, undefined),
      ValidationError);
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'shared');
    assert.throws(() => service.pollSpectator('match-1', 'cam', { after_tick: 0 }, undefined),
      ValidationError);
    assert.throws(() => service.pollSpectator('match-1', 'cam', { after_tick: 0 }, 'shared'),
      ConflictError);
    assert.throws(
      () => service.createSpectator('match-1', { id: 'other', delay_ticks: 0 }, 'shared'),
      ConflictError,
    );
  });
});

test('stream mode pages contiguous frames up to the visible tick', () => {
  withService((service) => {
    // No combat: the units never interact, so the match runs the full 12 ticks
    // and every frame-count and visible-tick assertion stays stable.
    setup(service);
    const advanced = service.advance('match-1', { count: 8 }, 'advance');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 4 }, 'spec');

    const first = service.pollSpectator('match-1', 'cam', { after_tick: 0, limit: 2 }, 'poll-1');
    assert.equal(first.mode, 'stream');
    assert.equal(first.complete, false);
    assert.equal(first.next_tick, 2);
    assert.deepEqual(first.frames.map((frame) => frame.tick), [1, 2]);
    assert.deepEqual(first.frames, advanced.frames.slice(0, 2));
    assert.equal(first.state_hash, advanced.frames[1].state_hash);
    assert.deepEqual(first.team_damage, { blue: 0, red: 0 });
    assert.equal(first.units.find((unit) => unit.id === 'red-1').health, 100);

    // Repeating the identical call returns the cached page and must not advance the cursor.
    assert.deepEqual(
      service.pollSpectator('match-1', 'cam', { after_tick: 0, limit: 2 }, 'poll-1'),
      first,
    );

    const second = service.pollSpectator('match-1', 'cam', { after_tick: 2 }, 'poll-2');
    assert.equal(second.mode, 'stream');
    assert.equal(second.complete, true);
    assert.equal(second.next_tick, 4);
    assert.deepEqual(second.frames.map((frame) => frame.tick), [3, 4]);
    assert.deepEqual(second.frames, advanced.frames.slice(2, 4));

    // Defaults are after_tick=0/limit=1024, so an empty body re-serves the whole window.
    const caughtUp = service.pollSpectator('match-1', 'cam', {}, 'poll-3');
    assert.deepEqual(caughtUp.frames.map((frame) => frame.tick), [1, 2, 3, 4]);
    // Polling at the visible tick returns an empty window: the snapshot at after_tick.
    const empty = service.pollSpectator('match-1', 'cam', { after_tick: 4, limit: 1024 }, 'poll-4');
    assert.deepEqual(empty.frames, []);
    assert.equal(empty.next_tick, 4);
    assert.equal(empty.complete, true);
    assert.equal(empty.state_hash, advanced.frames[3].state_hash);
    assert.deepEqual(empty.team_damage, { blue: 0, red: 0 });

    // Advancing the frontier opens a new delayed window.
    service.advance('match-1', { count: 4 }, 'advance-2');
    const grown = service.pollSpectator('match-1', 'cam', { after_tick: 4 }, 'poll-5');
    assert.equal(grown.complete, true);
    assert.equal(grown.next_tick, 8);
    assert.deepEqual(grown.frames.map((frame) => frame.tick), [5, 6, 7, 8]);

    // after_tick past the visible tick is a conflict.
    assert.throws(
      () => service.pollSpectator('match-1', 'cam', { after_tick: 9 }, 'poll-ahead'),
      ConflictError,
    );
  });
});

test('poll defaults and parameter ranges', () => {
  withService((service) => {
    setup(service);
    service.advance('match-1', { count: 1 }, 'advance');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'spec');
    for (const bad of [
      { after_tick: -1 }, { after_tick: 1.5 }, { after_tick: '1' },
      { after_tick: 0, limit: 0 }, { after_tick: 0, limit: 1025 },
      { after_tick: 0, limit: 1.5 }, { after_tick: 0, limit: '2' },
      { after_tick: 0, extra: true },
    ]) {
      assert.throws(
        () => service.pollSpectator('match-1', 'cam', bad, `bad-${JSON.stringify(bad)}`),
        ValidationError,
      );
    }
    const ok = service.pollSpectator('match-1', 'cam', {}, 'poll-defaults');
    assert.equal(ok.next_tick, 1);
    assert.equal(ok.complete, true);
  });
});

test('a rollback above the delivered window leaves the stream in stream mode', () => {
  withService((service) => {
    setup(service);
    service.advance('match-1', { count: 8 }, 'advance-1');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'spec');
    const first = service.pollSpectator('match-1', 'cam', { after_tick: 0, limit: 4 }, 'poll-1');
    assert.equal(first.next_tick, 4);

    service.rollback('match-1', 6, 'rollback-1');
    assert.equal(service.store.readSpectator('match-1', 'cam').reset, false);
    const next = service.pollSpectator('match-1', 'cam', { after_tick: 4 }, 'poll-2');
    assert.equal(next.mode, 'stream');
    assert.deepEqual(next.frames.map((frame) => frame.tick), [5, 6]);
    assert.equal(next.complete, true);
  });
});

test('a rollback below the highest frame ever delivered forces a reset even after re-polling', () => {
  withService((service) => {
    setup(service);
    service.advance('match-1', { count: 8 }, 'advance-1');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'spec');
    service.pollSpectator('match-1', 'cam', { after_tick: 0 }, 'poll-8');
    // Re-poll an older window; the cursor moves back but tick 8 was still returned.
    service.pollSpectator('match-1', 'cam', { after_tick: 2, limit: 1 }, 'poll-old');

    service.rollback('match-1', 5, 'rollback-1');
    assert.equal(service.store.readSpectator('match-1', 'cam').reset, true);
    const reset = service.pollSpectator('match-1', 'cam', { after_tick: 99, limit: 3 }, 'reset-1');
    assert.equal(reset.mode, 'reset');
    assert.deepEqual(reset.frames.map((frame) => frame.tick), [1, 2, 3]);
  });
});

test('an explicit rollback below the delivered window forces a reset replay from tick 0', () => {
  withService((service) => {
    setup(service);
    const advanced = service.advance('match-1', { count: 8 }, 'advance-1');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'spec');
    service.pollSpectator('match-1', 'cam', { after_tick: 0 }, 'poll-full');

    service.rollback('match-1', 6, 'rollback-1');
    assert.equal(service.store.readSpectator('match-1', 'cam').reset, true);

    // after_tick is ignored during a reset: the replay always restarts at tick 0.
    const first = service.pollSpectator('match-1', 'cam', { after_tick: 7, limit: 3 }, 'reset-1');
    assert.equal(first.mode, 'reset');
    assert.equal(first.complete, false);
    assert.equal(first.next_tick, 3);
    assert.deepEqual(first.frames.map((frame) => frame.tick), [1, 2, 3]);
    assert.deepEqual(first.frames, advanced.frames.slice(0, 3));

    const second = service.pollSpectator('match-1', 'cam', { after_tick: 3 }, 'reset-2');
    assert.equal(second.mode, 'reset');
    assert.equal(second.complete, true);
    assert.equal(second.next_tick, 6);
    assert.deepEqual(second.frames.map((frame) => frame.tick), [4, 5, 6]);
    assert.equal(service.store.readSpectator('match-1', 'cam').reset, false);

    // The completed reset is followed by a normal stream at the new frontier.
    const streamed = service.pollSpectator('match-1', 'cam', { after_tick: 6 }, 'stream-1');
    assert.equal(streamed.mode, 'stream');
    assert.deepEqual(streamed.frames, []);
    assert.equal(streamed.complete, true);
  });
});

test('a late input forces a reset whose replay matches the recomputed frames', () => {
  withService((service) => {
    setup(service);
    service.advance('match-1', { count: 8 }, 'advance-1');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'spec');
    service.pollSpectator('match-1', 'cam', { after_tick: 0 }, 'poll-full');

    const late = service.submitInputs('match-1', { inputs: [move(0, 'red-1', 5)] }, 'late-input');
    assert.notEqual(late.rollback, null);
    assert.equal(service.store.readSpectator('match-1', 'cam').reset, true);

    const frames = [];
    let response;
    let key = 0;
    for (;;) {
      response = service.pollSpectator('match-1', 'cam', {
        after_tick: response ? response.next_tick : 0, limit: 3,
      }, `reset-${key += 1}`);
      assert.equal(response.mode, 'reset');
      frames.push(...response.frames);
      if (response.complete) {
        break;
      }
    }
    assert.deepEqual(frames, recordedFrames(service, 'match-1'));
    assert.equal(response.state_hash, late.state_hash);

    const after = service.pollSpectator('match-1', 'cam', { after_tick: 8 }, 'after');
    assert.equal(after.mode, 'stream');
    assert.deepEqual(after.frames, []);
    assert.equal(after.complete, true);
    assert.equal(service.verify({ match_id: 'match-1' }).consistent, true);
  });
});

test('a tampered frame turns the stream and the reset replay into integrity failures', () => {
  withService((service) => {
    setup(service);
    service.advance('match-1', { count: 8 }, 'advance-1');
    service.createSpectator('match-1', { id: 'cam', delay_ticks: 0 }, 'spec');
    service.pollSpectator('match-1', 'cam', { after_tick: 0 }, 'poll-full');

    service.store.connection.prepare('UPDATE frames SET state_hash = ? WHERE match_id = ? AND tick = ?')
      .run('f'.repeat(64), 'match-1', 6);

    // A second spectator streams straight into the corrupted window.
    service.createSpectator('match-1', { id: 'fresh', delay_ticks: 0 }, 'spec-2');
    assert.throws(
      () => service.pollSpectator('match-1', 'fresh', { after_tick: 4 }, 'bad-stream'),
      IntegrityError,
    );

    // The first spectator is forced into a reset that hits the same frame.
    service.rollback('match-1', 7, 'rollback-1');
    assert.throws(
      () => service.pollSpectator('match-1', 'cam', { after_tick: 0 }, 'bad-reset'),
      IntegrityError,
    );
  });
});

test('unknown matches and spectators are not found', () => {
  withService((service) => {
    setup(service);
    assert.throws(
      () => service.createSpectator('nope', { id: 'cam', delay_ticks: 0 }, 'k1'),
      NotFoundError,
    );
    assert.throws(
      () => service.pollSpectator('match-1', 'ghost', { after_tick: 0 }, 'k2'),
      NotFoundError,
    );
    assert.throws(
      () => service.pollSpectator('nope', 'ghost', { after_tick: 0 }, 'k3'),
      NotFoundError,
    );
  });
});

test('spectators never enter the state hash or the replay document', () => {
  const without = withService((service) => {
    setup(service, 'shared');
    service.submitInputs('shared', { inputs: [move(0, 'red-1', 5), attack(1, 'blue-1')] }, 'inputs');
    service.advance('shared', { count: 8 }, 'advance');
    return { state: service.getState('shared'), replay: service.replayFile('shared') };
  });
  const withSpectators = withService((service) => {
    setup(service, 'shared');
    service.submitInputs('shared', { inputs: [move(0, 'red-1', 5), attack(1, 'blue-1')] }, 'inputs');
    service.advance('shared', { count: 8 }, 'advance');
    service.createSpectator('shared', { id: 'cam', delay_ticks: 4 }, 's1');
    service.createSpectator('shared', { id: 'obs', delay_ticks: 0 }, 's2');
    service.pollSpectator('shared', 'cam', { after_tick: 0, limit: 2 }, 'p1');
    service.pollSpectator('shared', 'obs', { after_tick: 0 }, 'p2');
    return { state: service.getState('shared'), replay: service.replayFile('shared') };
  });
  assert.equal(withSpectators.state.state_hash, without.state.state_hash);
  assert.equal(withSpectators.replay.replay_hash, without.replay.replay_hash);
  assert.deepEqual(withSpectators.replay.frames, without.replay.frames);
  assert.equal(JSON.stringify(withSpectators.replay).includes('cam'), false);
});

test('the HTTP server exposes the spectator routes', async () => {
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
    await call('POST', '/matches/http/tick', { count: 8 }, 'tick');

    const missingKey = await call('POST', '/matches/http/spectators', { id: 'cam', delay_ticks: 4 });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error.code, 'validation_error');

    const created = await call('POST', '/matches/http/spectators', { id: 'cam', delay_ticks: 4 }, 'spec');
    assert.equal(created.status, 201);
    assert.equal(created.body.spectator_id, 'cam');
    assert.equal(created.body.visible_tick, 4);

    assert.equal((await call('POST', '/matches/http/spectators', { id: 'cam', delay_ticks: 0 }, 'dup')).status, 409);
    assert.equal((await call('POST', '/matches/http/spectators', { id: 'bad' }, 'bad')).status, 400);

    const pollMissingKey = await call('POST', '/matches/http/spectators/cam/poll', { after_tick: 0 });
    assert.equal(pollMissingKey.status, 400);

    const polled = await call('POST', '/matches/http/spectators/cam/poll', { after_tick: 0, limit: 2 }, 'poll');
    assert.equal(polled.status, 200);
    assert.equal(polled.body.mode, 'stream');
    assert.deepEqual(polled.body.frames.map((frame) => frame.tick), [1, 2]);
    assert.equal(polled.body.complete, false);

    assert.equal((await call('POST', '/matches/http/spectators/cam/poll', { after_tick: 9 }, 'ahead')).status, 409);
    assert.equal((await call('POST', '/matches/http/spectators/ghost/poll', { after_tick: 0 }, 'x')).status, 404);
    assert.equal((await call('POST', '/matches/missing/spectators', { id: 'cam', delay_ticks: 0 }, 'y')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.close();
  }
});
