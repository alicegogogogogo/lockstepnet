'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { IntegrityError, NotFoundError, ValidationError } = require('../src/errors');
const { createServer } = require('../src/http');
const { Lockstep } = require('../src/service');

const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-snapshots-'));
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

const move = (tick, unit, command) => ({ command: { kind: 'move', ...command }, tick, unit });
const attack = (tick, unit, attacking) => ({ command: { attacking, kind: 'attack' }, tick, unit });

function duel(overrides = {}) {
  return {
    id: 'match-1',
    max_ticks: 64,
    seed: 11,
    units: [
      { id: 'blue-1', position: 900, team: 'blue', velocity: 0 },
      { id: 'red-1', position: 100, team: 'red', velocity: 0 },
    ],
    ...overrides,
  };
}

/** Run eight lively ticks: moves, attack toggles and mutual damage. */
function play(service, matchId = 'match-1', count = 8) {
  service.createMatch(duel({ id: matchId }), `create-${matchId}`);
  service.submitInputs(matchId, { inputs: [
    move(0, 'red-1', { by: 5 }),
    move(2, 'red-1', { position: 200 }),
    attack(1, 'red-1', true),
    attack(3, 'red-1', false),
    attack(0, 'blue-1', true),
    move(4, 'blue-1', { velocity: -9 }),
    attack(6, 'blue-1', false),
  ] }, `inputs-${matchId}`);
  return service.advance(matchId, { count }, `advance-${matchId}`);
}

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

test('snapshot at tick 0 is the initial state and other ticks follow frames', () => {
  withService((service) => {
    const current = play(service);
    const s0 = service.getSnapshot('match-1', new URLSearchParams('tick=0'));
    assert.deepEqual(Object.keys(s0), ['match_id', 'tick', 'status', 'state_hash', 'team_damage', 'units']);
    assert.equal(s0.match_id, 'match-1');
    assert.equal(s0.tick, 0);
    assert.equal(s0.status, 'running');
    assert.deepEqual(s0.team_damage, { blue: 0, red: 0 });
    assert.deepEqual(s0.units.map((u) => u.id), ['blue-1', 'red-1']);
    for (const unit of s0.units) {
      assert.equal(unit.alive, true);
      assert.equal(unit.attacking, false);
      assert.equal(unit.health, 100);
    }

    for (let tick = 1; tick <= current.tick; tick += 1) {
      const snap = service.getSnapshot('match-1', new URLSearchParams(`tick=${tick}`));
      assert.equal(snap.tick, tick);
      assert.equal(snap.state_hash, current.frames[tick - 1].state_hash);
      assert.equal(snap.status, 'running');
      // units stay sorted by id and carry the full public projection
      assert.deepEqual(snap.units.map((u) => u.id), ['blue-1', 'red-1']);
      assert.ok(snap.units.every((u) => ['alive', 'attacking', 'health', 'id', 'position', 'team', 'velocity']
        .every((key) => Object.prototype.hasOwnProperty.call(u, key))));
    }
    const frontier = service.getSnapshot('match-1', new URLSearchParams(`tick=${current.tick}`));
    assert.equal(frontier.state_hash, current.state_hash);
    assert.deepEqual(frontier.units, current.units);
    assert.deepEqual(frontier.team_damage, { blue: current.teams.blue.damage, red: current.teams.red.damage });
  });
});

test('a delta page carries contiguous frames and every documented field', () => {
  withService((service) => {
    const current = play(service);
    const page = service.getDeltas('match-1', new URLSearchParams('after_tick=0'));
    assert.deepEqual(Object.keys(page), ['match_id', 'after_tick', 'base_state_hash', 'next_tick', 'complete', 'deltas']);
    assert.equal(page.match_id, 'match-1');
    assert.equal(page.after_tick, 0);
    assert.equal(page.next_tick, current.tick);
    assert.equal(page.complete, true);
    assert.equal(page.deltas.length, current.tick);
    assert.deepEqual(page.deltas.map((d) => d.tick), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const [index, entry] of page.deltas.entries()) {
      assert.deepEqual(Object.keys(entry), ['tick', 'state_hash', 'status', 'settled', 'casualties', 'team_damage', 'changed']);
      assert.equal(entry.tick, index + 1);
      assert.equal(entry.state_hash, current.frames[index].state_hash);
      assert.equal(entry.status, 'running');
      assert.equal(entry.settled, current.frames[index].settled);
      assert.deepEqual(entry.casualties, current.frames[index].casualties);
      assert.deepEqual(entry.changed.map((u) => u.id), entry.changed.map((u) => u.id).sort());
      assert.ok(entry.team_damage.blue >= 0 && entry.team_damage.red >= 0);
    }
  });
});

test('a pure attacking toggle is reported even when nothing else changes for that unit', () => {
  withService((service) => {
    // No movement anywhere; red-1 starts attacking at tick 0. Frame 1 must list
    // red-1's attacking toggle even though blue-1 also takes damage that frame.
    service.createMatch(duel({ id: 'quiet' }), 'create-quiet');
    service.submitInputs('quiet', { inputs: [attack(0, 'red-1', true)] }, 'inputs-quiet');
    service.advance('quiet', { count: 2 }, 'advance-quiet');
    const page = service.getDeltas('quiet', new URLSearchParams('after_tick=0'));
    const toggle = page.deltas[0].changed.find((u) => u.id === 'red-1');
    assert.ok(toggle);
    assert.equal(toggle.attacking, true);
    assert.equal(toggle.health, 100);
    assert.equal(toggle.position, 100);
    // Same tick: blue takes the first hit; tick 2 the second.
    assert.equal(page.deltas[0].changed.find((u) => u.id === 'blue-1').health, 90);
    assert.equal(page.deltas[1].changed.find((u) => u.id === 'blue-1').health, 80);
  });
});

test('a tick with no observable change still gets an entry with an empty changed list', () => {
  withService((service) => {
    service.createMatch(duel({ id: 'idle' }), 'create-idle');
    service.advance('idle', { count: 2 }, 'advance-idle');
    const page = service.getDeltas('idle', new URLSearchParams('after_tick=0&limit=2'));
    assert.equal(page.deltas.length, 2);
    for (const entry of page.deltas) {
      assert.deepEqual(entry.changed, []);
      assert.equal(entry.settled, false);
      assert.deepEqual(entry.casualties, []);
      assert.deepEqual(entry.team_damage, { blue: 0, red: 0 });
    }
  });
});

test('death appears both as a casualty and as a full changed projection', () => {
  withService((service) => {
    service.createMatch({
      id: 'execution',
      max_ticks: 40,
      units: [
        { id: 'blue-1', position: 900, team: 'blue', velocity: 0 },
        { id: 'red-1', position: 100, team: 'red', velocity: 0 },
        { id: 'red-2', position: 110, team: 'red', velocity: 0 },
        { id: 'red-3', position: 120, team: 'red', velocity: 0 },
      ],
    }, 'create-execution');
    service.submitInputs('execution', { inputs: [
      attack(0, 'red-1', true),
      attack(0, 'red-2', true),
      attack(0, 'red-3', true),
    ] }, 'inputs-execution');
    const ended = service.advance('execution', { count: 40 }, 'advance-execution');
    assert.equal(ended.status, 'red_wins');
    const page = service.getDeltas('execution', new URLSearchParams('after_tick=0&limit=1024'));
    const killer = page.deltas.find((d) => d.casualties.includes('blue-1'));
    assert.ok(killer);
    const body = killer.changed.find((u) => u.id === 'blue-1');
    assert.ok(body);
    assert.equal(body.alive, false);
    assert.equal(body.health, 0);
    const final = service.getSnapshot('execution', new URLSearchParams(`tick=${ended.tick}`));
    assert.equal(final.status, 'red_wins');
  });
});

test('deltas applied from the after_tick snapshot reproduce the next_tick snapshot', () => {
  withService((service) => {
    const current = play(service, 'paging', 8);
    const s0 = service.getSnapshot('paging', new URLSearchParams('tick=0'));
    const applyPage = (units, entries) => {
      const byId = new Map(units.map((u) => [u.id, u]));
      for (const entry of entries) {
        for (const change of entry.changed) {
          byId.set(change.id, { ...byId.get(change.id), ...change });
        }
      }
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    };
    for (const limit of [1, 2, 3, 7, 1024]) {
      let after = 0;
      let units = s0.units;
      let damage = { blue: 0, red: 0 };
      while (true) {
        const page = service.getDeltas('paging', new URLSearchParams(`after_tick=${after}&limit=${limit}`));
        assert.equal(page.base_state_hash, service.getSnapshot('paging', new URLSearchParams(`tick=${after}`)).state_hash);
        units = applyPage(units, page.deltas);
        if (page.deltas.length > 0) {
          damage = { ...page.deltas[page.deltas.length - 1].team_damage };
        }
        after = page.next_tick;
        const snap = service.getSnapshot('paging', new URLSearchParams(`tick=${after}`));
        assert.deepEqual(units, snap.units, `units at tick ${after} with limit ${limit}`);
        assert.deepEqual(damage, snap.team_damage, `team_damage at tick ${after} with limit ${limit}`);
        if (page.complete) break;
      }
      assert.equal(after, current.tick);
    }

    // An empty page at the frontier: next_tick equals after_tick, complete true.
    const empty = service.getDeltas('paging', new URLSearchParams(`after_tick=${current.tick}&limit=4`));
    assert.deepEqual(empty.deltas, []);
    assert.equal(empty.next_tick, current.tick);
    assert.equal(empty.complete, true);
    assert.equal(empty.base_state_hash, current.state_hash);

    // A partial window is not complete and resumes on the next call.
    const first = service.getDeltas('paging', new URLSearchParams('after_tick=0&limit=3'));
    assert.equal(first.next_tick, 3);
    assert.equal(first.complete, false);
    const second = service.getDeltas('paging', new URLSearchParams('after_tick=3&limit=1024'));
    assert.equal(second.next_tick, current.tick);
    assert.equal(second.complete, true);
  });
});

test('history follows the recomputed timeline after a late input or an explicit rollback', () => {
  withService((service) => {
    service.createMatch(duel({ id: 'rew' }), 'create-rew');
    service.submitInputs('rew', { inputs: [move(0, 'red-1', { by: 3 })] }, 'inputs-rew-1');
    service.advance('rew', { count: 4 }, 'advance-rew-1');
    const staleTick3 = service.getSnapshot('rew', new URLSearchParams('tick=3')).state_hash;

    service.submitInputs('rew', { inputs: [move(1, 'blue-1', { position: 42 })] }, 'inputs-rew-2');
    const freshTick3 = service.getSnapshot('rew', new URLSearchParams('tick=3')).state_hash;
    assert.notEqual(freshTick3, staleTick3);
    const page = service.getDeltas('rew', new URLSearchParams('after_tick=0'));
    assert.ok(page.deltas[1].changed.some((u) => u.id === 'blue-1' && u.position === 42));

    // Explicit rollback truncates readable history; re-advancing reproduces hashes.
    const beforeRewind = page.deltas.map((d) => d.state_hash);
    service.rollback('rew', 2);
    assert.throws(() => service.getSnapshot('rew', new URLSearchParams('tick=3')), (e) => e.status === 409);
    assert.throws(() => service.getDeltas('rew', new URLSearchParams('after_tick=3')), (e) => e.status === 409);
    service.advance('rew', { count: 2 }, 'advance-rew-2');
    const again = service.getDeltas('rew', new URLSearchParams('after_tick=2&limit=2'));
    assert.deepEqual(again.deltas.map((d) => d.state_hash), [beforeRewind[2], beforeRewind[3]]);
  });
});

test('the endpoints are read-only: no advance, no statistic changes', () => {
  withService((service) => {
    play(service, 'ro');
    const before = service.getState('ro');
    for (const query of ['tick=0', 'tick=4', 'tick=8']) {
      service.getSnapshot('ro', new URLSearchParams(query));
    }
    for (const query of ['after_tick=0', 'after_tick=2&limit=2', 'after_tick=8']) {
      service.getDeltas('ro', new URLSearchParams(query));
    }
    const after = service.getState('ro');
    assert.equal(after.tick, before.tick);
    assert.equal(after.state_hash, before.state_hash);
    assert.deepEqual(after.inputs, before.inputs);
  });
});

test('parameter validation: missing, unknown, non-integer, negative, bad limit', () => {
  withService((service) => {
    play(service, 'val');
    const snap = (query) => () => service.getSnapshot('val', new URLSearchParams(query));
    const delta = (query) => () => service.getDeltas('val', new URLSearchParams(query));
    for (const bad of ['', 'tick', 'tick=', 'tick=-1', 'tick=1.5', 'tick=true', 'tick=abc', 'tick=01', 'unknown=1', 'tick=1&tick=2']) {
      assert.throws(snap(bad), (e) => e instanceof ValidationError && e.status === 400, `snapshot ?${bad}`);
    }
    for (const bad of ['', 'after_tick', 'after_tick=', 'after_tick=-2', 'after_tick=0.5', 'after_tick=x',
      'limit=0', 'limit=1025', 'limit=-1', 'limit=1.0', 'limit=true', 'stranger=0', 'after_tick=0&after_tick=0']) {
      assert.throws(delta(bad), (e) => e instanceof ValidationError && e.status === 400, `deltas ?${bad}`);
    }
    // limit defaults to 1024 and accepts the boundary values.
    assert.equal(service.getDeltas('val', new URLSearchParams('after_tick=0&limit=1')).deltas.length, 1);
    assert.equal(service.getDeltas('val', new URLSearchParams('after_tick=0&limit=1024')).deltas.length, 8);

    // ahead of the frontier is a conflict, not a validation error
    assert.throws(snap('tick=9'), (e) => e.status === 409 && e.code === 'conflict');
    assert.throws(delta('after_tick=9'), (e) => e.status === 409 && e.code === 'conflict');

    assert.throws(() => service.getSnapshot('nope', new URLSearchParams('tick=0')), NotFoundError);
    assert.throws(() => service.getDeltas('nope', new URLSearchParams('after_tick=0')), NotFoundError);
  });
});

test('frame gaps and hash mismatches fail the whole read with integrity_failure', () => {
  withService((service) => {
    const current = play(service, 'corrupt');
    const db = service.store.connection;
    db.prepare("UPDATE frames SET state_hash = ? WHERE match_id = 'corrupt' AND tick = 2").run('a'.repeat(64));
    for (const tick of [0, 2, current.tick]) {
      assert.throws(
        () => service.getSnapshot('corrupt', new URLSearchParams(`tick=${tick}`)),
        (e) => e instanceof IntegrityError && e.status === 409 && e.code === 'integrity_failure',
        `snapshot tick ${tick}`,
      );
    }
    assert.throws(() => service.getDeltas('corrupt', new URLSearchParams('after_tick=0')), IntegrityError);

    // A gap in the recorded frame log is reported the same way.
    db.prepare("UPDATE frames SET state_hash = state_hash WHERE match_id = 'corrupt' AND tick = 2").run();
    db.prepare("DELETE FROM frames WHERE match_id = 'corrupt' AND tick = 2").run();
    assert.throws(() => service.getSnapshot('corrupt', new URLSearchParams('tick=2')), IntegrityError);
    assert.throws(() => service.getDeltas('corrupt', new URLSearchParams('after_tick=0')), IntegrityError);
    // Ticks behind the gap cannot be served either: the timeline is verified as one piece.
    assert.throws(() => service.getSnapshot('corrupt', new URLSearchParams('tick=1')), IntegrityError);
  });
});

test('the HTTP routes map status codes and need no Idempotency-Key', async () => {
  const service = new Lockstep(databasePath());
  const server = createServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (route) => fetch(`${base}${route}`);
  try {
    const created = await fetch(`${base}/matches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'create' },
      body: JSON.stringify(duel({ id: 'http' })),
    });
    assert.equal(created.status, 201);
    await fetch(`${base}/matches/http/inputs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'inputs' },
      body: JSON.stringify({ inputs: [attack(0, 'red-1', true), move(1, 'blue-1', { by: -7 })] }),
    });
    await fetch(`${base}/matches/http/tick`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'tick' },
      body: JSON.stringify({ count: 4 }),
    });

    let response = await get('/matches/http/snapshot?tick=0');
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.match_id, 'http');
    assert.equal(body.tick, 0);

    response = await get('/matches/http/deltas?after_tick=0&limit=2');
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.deltas.length, 2);
    assert.equal(body.next_tick, 2);
    assert.equal(body.complete, false);

    // default limit: absent limit is accepted
    response = await get('/matches/http/deltas?after_tick=2');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).next_tick, 4);

    for (const route of ['/matches/missing/snapshot?tick=0', '/matches/missing/deltas?after_tick=0']) {
      response = await get(route);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, 'not_found');
    }
    for (const route of [
      '/matches/http/snapshot',
      '/matches/http/snapshot?tick=-1',
      '/matches/http/snapshot?tick=x',
      '/matches/http/snapshot?tick=1&bogus=2',
      '/matches/http/deltas',
      '/matches/http/deltas?after_tick=0&limit=0',
      '/matches/http/deltas?after_tick=0&limit=9999',
      '/matches/http/deltas?after_tick=1&what=2',
    ]) {
      response = await get(route);
      assert.equal(response.status, 400, `${route} -> ${response.status}`);
      assert.equal((await response.json()).error.code, 'validation_error');
    }
    for (const route of ['/matches/http/snapshot?tick=5', '/matches/http/deltas?after_tick=5']) {
      response = await get(route);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'conflict');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.close();
  }
});
