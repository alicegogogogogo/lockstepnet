'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
  ConflictError, IntegrityError, NotFoundError, ValidationError,
} = require('../src/errors');
const { Lockstep } = require('../src/service');
const sim = require('../src/sim');

const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-snapshots-'));
let databaseCounter = 0;

// `node:sqlite` is experimental and emits a warning on first use.
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

/** Two motionless units far apart: the match runs exactly as many ticks as asked. */
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

function play(service, matchId, records = FULL_LOG, count = 8) {
  service.createMatch(matchConfig({ id: matchId }), `create-${matchId}`);
  service.submitInputs(matchId, { inputs: records }, `inputs-${matchId}`);
  return service.advance(matchId, { count }, `advance-${matchId}`);
}

/** Rebuild an internal state from a snapshot response, for hash comparison. */
function stateFromSnapshot(snapshot) {
  const units = {};
  for (const unit of snapshot.units) {
    units[unit.id] = {
      attacking: unit.attacking, health: unit.health, id: unit.id,
      position: unit.position, team: unit.team, velocity: unit.velocity,
    };
  }
  return {
    hash: null,
    maxTicks: 64,
    status: snapshot.status,
    teamDamage: { blue: snapshot.team_damage.blue, red: snapshot.team_damage.red },
    tick: snapshot.tick,
    units,
  };
}

/** Apply a deltas page to a snapshot response, the way a caller would. */
function applyDeltas(snapshot, deltas) {
  const state = stateFromSnapshot(snapshot);
  for (const delta of deltas) {
    for (const unit of delta.changed) {
      state.units[unit.id] = {
        attacking: unit.attacking, health: unit.health, id: unit.id,
        position: unit.position, team: unit.team, velocity: unit.velocity,
      };
    }
    state.teamDamage = { blue: delta.team_damage.blue, red: delta.team_damage.red };
    state.tick = delta.tick;
  }
  return state;
}

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

test('snapshot at tick 0 is the initial state', () => {
  withService((service) => {
    play(service, 'match-1');
    const fresh = withService((other) => {
      other.createMatch(matchConfig({ id: 'fresh' }), 'create-fresh');
      return other.getState('fresh');
    });
    const snapshot = service.getSnapshot('match-1', { tick: '0' });
    assert.equal(snapshot.match_id, 'match-1');
    assert.equal(snapshot.tick, 0);
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.state_hash, fresh.state_hash);
    assert.deepEqual(snapshot.team_damage, { blue: 0, red: 0 });
    assert.deepEqual(snapshot.units.map((unit) => unit.id), ['blue-1', 'red-1']);
    assert.ok(snapshot.units.every((unit) => unit.health === 100 && unit.alive && !unit.attacking));
  });
});

test('snapshot at the frontier matches the live state', () => {
  withService((service) => {
    play(service, 'match-1');
    const live = service.getState('match-1');
    const snapshot = service.getSnapshot('match-1', { tick: '8' });
    assert.equal(snapshot.tick, 8);
    assert.equal(snapshot.status, live.status);
    assert.equal(snapshot.state_hash, live.state_hash);
    assert.deepEqual(snapshot.team_damage, { blue: live.teams.blue.damage, red: live.teams.red.damage });
    assert.deepEqual(snapshot.units, live.units);
  });
});

test('snapshot reflects a mid-history frame, not the frontier', () => {
  withService((service) => {
    play(service, 'match-1');
    const snapshot = service.getSnapshot('match-1', { tick: '3' });
    assert.equal(snapshot.tick, 3);
    assert.equal(snapshot.status, 'running');
    const red = snapshot.units.find((unit) => unit.id === 'red-1');
    // After tick 3: moved by 3 then to 120, attacking since tick 2, and hit by
    // blue-1 for 10 + 10 + 9 damage over the three frames.
    assert.deepEqual(
      { attacking: red.attacking, health: red.health, position: red.position, velocity: red.velocity },
      { attacking: true, health: 71, position: 120, velocity: 0 },
    );
  });
});

test('snapshot validates match, query fields and the frontier', () => {
  withService((service) => {
    play(service, 'match-1');
    assert.throws(() => service.getSnapshot('nope', { tick: '0' }), NotFoundError);
    assert.throws(() => service.getSnapshot('match-1', {}), ValidationError);
    assert.throws(() => service.getSnapshot('match-1', { tick: '1', extra: '1' }), ValidationError);
    assert.throws(() => service.getSnapshot('match-1', { tick: 'abc' }), ValidationError);
    assert.throws(() => service.getSnapshot('match-1', { tick: '1.5' }), ValidationError);
    assert.throws(() => service.getSnapshot('match-1', { tick: '' }), ValidationError);
    assert.throws(() => service.getSnapshot('match-1', { tick: '-1' }), ValidationError);
    assert.throws(() => service.getSnapshot('match-1', { tick: '9' }), ConflictError);
  });
});

test('deltas page through the timeline and rebuild every snapshot', () => {
  withService((service) => {
    play(service, 'match-1');
    const pages = [
      service.getDeltas('match-1', { after_tick: '0', limit: '3' }),
      service.getDeltas('match-1', { after_tick: '3', limit: '3' }),
      service.getDeltas('match-1', { after_tick: '6', limit: '3' }),
    ];
    assert.deepEqual(pages[0].deltas.map((delta) => delta.tick), [1, 2, 3]);
    assert.deepEqual(pages[1].deltas.map((delta) => delta.tick), [4, 5, 6]);
    assert.deepEqual(pages[2].deltas.map((delta) => delta.tick), [7, 8]);
    assert.deepEqual(
      pages.map((page) => [page.next_tick, page.complete]),
      [[3, false], [6, false], [8, true]],
    );
    for (const page of pages) {
      const base = service.getSnapshot('match-1', { tick: String(page.after_tick) });
      assert.equal(page.base_state_hash, base.state_hash);
      for (const delta of page.deltas) {
        const snapshot = service.getSnapshot('match-1', { tick: String(delta.tick) });
        assert.equal(delta.state_hash, snapshot.state_hash);
        assert.deepEqual(delta.team_damage, snapshot.team_damage);
      }
      // Applying the page to the base snapshot lands on the next snapshot.
      const rebuilt = applyDeltas(base, page.deltas);
      const target = service.getSnapshot('match-1', { tick: String(page.next_tick) });
      assert.equal(sim.stateHash(rebuilt), target.state_hash);
    }
    // The empty page at the frontier is the identity page.
    const empty = service.getDeltas('match-1', { after_tick: '8' });
    assert.deepEqual(empty.deltas, []);
    assert.equal(empty.next_tick, 8);
    assert.equal(empty.complete, true);
    assert.equal(empty.base_state_hash, service.getState('match-1').state_hash);
  });
});

test('deltas default the limit to 1024 and never change on quiet ticks', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'match-1' }), 'create');
    service.advance('match-1', { count: 4 }, 'advance');
    const page = service.getDeltas('match-1', { after_tick: '0' });
    assert.deepEqual(page.deltas.map((delta) => delta.tick), [1, 2, 3, 4]);
    assert.ok(page.deltas.every((delta) => delta.changed.length === 0));
    assert.ok(page.deltas.every((delta) => delta.casualties.length === 0));
    assert.ok(page.deltas.every((delta) => delta.status === 'running'));
    assert.equal(page.complete, true);
  });
});

test('deltas report attacking-only changes and deaths', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'match-1' }), 'create');
    service.submitInputs('match-1', {
      inputs: [input(0, 'red-1', { attacking: true, kind: 'attack' })],
    }, 'inputs');
    service.advance('match-1', { count: 1 }, 'advance');
    const page = service.getDeltas('match-1', { after_tick: '0', limit: '1' });
    const red = page.deltas[0].changed.find((unit) => unit.id === 'red-1');
    // red-1 changed only its attacking flag; it must still be listed.
    assert.deepEqual(
      {
        alive: red.alive, attacking: red.attacking, health: red.health,
        position: red.position, velocity: red.velocity,
      },
      {
        alive: true, attacking: true, health: 100, position: 0, velocity: 0,
      },
    );
    const blue = page.deltas[0].changed.find((unit) => unit.id === 'blue-1');
    assert.equal(blue.health, 90);
    assert.deepEqual(page.deltas[0].team_damage, { blue: 0, red: 10 });
  });

  withService((service) => {
    service.createMatch(matchConfig({ id: 'match-1' }), 'create');
    service.submitInputs('match-1', {
      inputs: [
        input(0, 'red-1', { attacking: true, kind: 'attack' }),
        input(0, 'blue-1', { attacking: true, kind: 'attack' }),
      ],
    }, 'inputs');
    // Symmetric attackers grind each other down well before max_ticks.
    service.advance('match-1', { count: 64 }, 'advance');
    const live = service.getState('match-1');
    assert.equal(live.status, 'blue_wins');
    const finalTick = live.tick;
    const page = service.getDeltas('match-1', { after_tick: String(finalTick - 1), limit: '1' });
    const [delta] = page.deltas;
    assert.equal(delta.tick, finalTick);
    assert.equal(delta.status, 'blue_wins');
    assert.deepEqual(delta.casualties, ['blue-1', 'red-1']);
    assert.deepEqual(delta.team_damage, { blue: 100, red: 100 });
    assert.deepEqual(delta.changed.map((unit) => unit.id), ['blue-1', 'red-1']);
    assert.ok(delta.changed.every((unit) => !unit.alive && unit.health === 0));
    const snapshot = service.getSnapshot('match-1', { tick: String(finalTick) });
    assert.equal(snapshot.status, 'blue_wins');
    assert.equal(snapshot.state_hash, delta.state_hash);
  });
});

test('deltas validate match, query fields, limit and the frontier', () => {
  withService((service) => {
    play(service, 'match-1');
    assert.throws(() => service.getDeltas('nope', { after_tick: '0' }), NotFoundError);
    assert.throws(() => service.getDeltas('match-1', {}), ValidationError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '0', tick: '1' }), ValidationError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: 'x' }), ValidationError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '-1' }), ValidationError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '0', limit: '0' }), ValidationError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '0', limit: '1025' }), ValidationError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '0', limit: 'x' }), ValidationError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '9' }), ConflictError);
  });
});

test('history reads expose only the recomputed timeline after a rollback', () => {
  withService((service) => {
    play(service, 'match-1');
    const original = service.getSnapshot('match-1', { tick: '8' });
    service.rollback('match-1', 4);
    assert.throws(() => service.getSnapshot('match-1', { tick: '5' }), ConflictError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '5' }), ConflictError);
    const page = service.getDeltas('match-1', { after_tick: '0' });
    assert.equal(page.next_tick, 4);
    assert.equal(page.complete, true);
    service.advance('match-1', { count: 4 }, 'advance-again');
    assert.equal(service.getSnapshot('match-1', { tick: '8' }).state_hash, original.state_hash);

    // A late input rewinds and rebuilds; the reads then serve the new timeline.
    service.submitInputs('match-1', {
      inputs: [input(3, 'blue-1', { attacking: false, kind: 'attack' })],
    }, 'late');
    const moved = service.getSnapshot('match-1', { tick: '8' });
    assert.notEqual(moved.state_hash, original.state_hash);
    assert.equal(moved.state_hash, service.getState('match-1').state_hash);
    assert.equal(moved.team_damage.blue, 42);
  });
});

test('history reads never advance the match or change the statistics', () => {
  withService((service) => {
    play(service, 'match-1');
    const before = service.getState('match-1');
    service.getSnapshot('match-1', { tick: '0' });
    service.getSnapshot('match-1', { tick: '8' });
    service.getDeltas('match-1', { after_tick: '0', limit: '3' });
    service.getDeltas('match-1', { after_tick: '3' });
    const after = service.getState('match-1');
    assert.deepEqual(after, before);
  });
});

test('a corrupted or gapped frame log fails the whole read with integrity_failure', () => {
  withService((service) => {
    play(service, 'match-1');
    service.store.connection
      .prepare('UPDATE frames SET state_hash = ? WHERE match_id = ? AND tick = ?')
      .run('0'.repeat(64), 'match-1', 2);
    assert.throws(() => service.getSnapshot('match-1', { tick: '4' }), IntegrityError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '0', limit: '4' }), IntegrityError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '2' }), IntegrityError);
  });
  withService((service) => {
    play(service, 'match-1');
    service.store.connection
      .prepare('DELETE FROM frames WHERE match_id = ? AND tick = ?')
      .run('match-1', 3);
    assert.throws(() => service.getSnapshot('match-1', { tick: '4' }), IntegrityError);
    assert.throws(() => service.getDeltas('match-1', { after_tick: '0' }), IntegrityError);
  });
});

test('the HTTP server exposes the snapshot and deltas routes', async () => {
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
    await call('POST', '/matches', matchConfig({ id: 'http' }), 'create');
    await call('POST', '/matches/http/inputs', {
      inputs: [input(0, 'red-1', { attacking: true, kind: 'attack' })],
    }, 'inputs');
    await call('POST', '/matches/http/tick', { count: 4 }, 'tick');

    // No Idempotency-Key is needed for the read-only history routes.
    const snapshot = await call('GET', '/matches/http/snapshot?tick=2');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.match_id, 'http');
    assert.equal(snapshot.body.tick, 2);
    assert.equal(snapshot.body.status, 'running');
    assert.match(snapshot.body.state_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(snapshot.body.units.map((unit) => unit.id), ['blue-1', 'red-1']);

    const initial = await call('GET', '/matches/http/snapshot?tick=0');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.team_damage, { blue: 0, red: 0 });

    const deltas = await call('GET', '/matches/http/deltas?after_tick=0&limit=2');
    assert.equal(deltas.status, 200);
    assert.deepEqual(deltas.body.deltas.map((delta) => delta.tick), [1, 2]);
    assert.equal(deltas.body.next_tick, 2);
    assert.equal(deltas.body.complete, false);
    assert.equal(deltas.body.base_state_hash, initial.body.state_hash);

    const rest = await call('GET', '/matches/http/deltas?after_tick=2');
    assert.equal(rest.status, 200);
    assert.equal(rest.body.complete, true);
    assert.equal(rest.body.next_tick, 4);

    assert.equal((await call('GET', '/matches/unknown/snapshot?tick=0')).status, 404);
    assert.equal((await call('GET', '/matches/unknown/deltas?after_tick=0')).status, 404);

    const missing = await call('GET', '/matches/http/snapshot');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'validation_error');
    assert.equal((await call('GET', '/matches/http/snapshot?tick=1&bogus=1')).status, 400);
    assert.equal((await call('GET', '/matches/http/snapshot?tick=abc')).status, 400);
    assert.equal((await call('GET', '/matches/http/snapshot?tick=-1')).status, 400);
    assert.equal((await call('GET', '/matches/http/snapshot?tick=1&tick=2')).status, 400);
    assert.equal((await call('GET', '/matches/http/deltas')).status, 400);
    assert.equal((await call('GET', '/matches/http/deltas?after_tick=0&limit=0')).status, 400);
    assert.equal((await call('GET', '/matches/http/deltas?after_tick=0&limit=1025')).status, 400);

    const ahead = await call('GET', '/matches/http/snapshot?tick=5');
    assert.equal(ahead.status, 409);
    assert.equal(ahead.body.error.code, 'conflict');
    assert.equal((await call('GET', '/matches/http/deltas?after_tick=5')).status, 409);

    // The reads did not move the frontier.
    const state = await call('GET', '/matches/http');
    assert.equal(state.body.tick, 4);
  } finally {
    server.close();
    service.close();
  }
});
