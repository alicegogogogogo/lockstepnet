'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { ConflictError, NotFoundError, ValidationError } = require('../src/errors');
const { Lockstep } = require('../src/service');
const sim = require('../src/sim');

const ROOT = path.join(__dirname, '..');
const workspace = mkdtempSync(path.join(tmpdir(), 'lockstepnet-tests-'));
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

/**
 * Two units that never reach each other: red stays at 0, blue stays at 990. A
 * plain 8-tick match therefore always runs to exactly the tick that was asked
 * for, which keeps every frame-count assertion stable. `max_ticks` is far enough
 * away that rollback tests can rewind and re-advance freely.
 */
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

/**
 * Eight ticks of inputs, two records per tick, deliberately interleaved so no
 * arrival order can be mistaken for the canonical one.
 */
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

function play(service, matchId, records, count = 8) {
  service.createMatch(matchConfig({ id: matchId }), `create-${matchId}`);
  service.submitInputs(matchId, { inputs: records }, `inputs-${matchId}`);
  return service.advance(matchId, { count }, `advance-${matchId}`);
}

after(() => {
  rmSync(workspace, { force: true, recursive: true });
});

test('the final hash depends on the input set, never on the arrival order', () => {
  const ordered = [...FULL_LOG].sort((left, right) => left.tick - right.tick);
  const orders = [
    ordered,
    [...ordered].reverse(),
    ordered.filter((_, index) => index % 2 === 0).concat(ordered.filter((_, index) => index % 2 === 1)),
  ];
  const hashes = orders.map((records, index) => withService((service) => play(service, `order-${index}`, records)).state_hash);
  assert.match(hashes[0], /^[0-9a-f]{64}$/);
  assert.equal(hashes[1], hashes[0]);
  assert.equal(hashes[2], hashes[0]);

  // The same log delivered one record per request, oldest record last.
  const drip = withService((service) => {
    service.createMatch(matchConfig({ id: 'drip' }), 'create');
    for (const record of [...ordered].reverse()) {
      service.submitInputs('drip', { inputs: [record] }, `inputs-${record.tick}-${record.unit}-${record.command.kind}`);
    }
    return service.advance('drip', { count: 8 }, 'advance').state_hash;
  });
  assert.equal(drip, hashes[0]);

  // A second database file must reproduce the same match bit for bit.
  const elsewhere = withService((service) => play(service, 'elsewhere', FULL_LOG).state_hash);
  assert.equal(elsewhere, hashes[0]);
});

test('duplicate records are counted but cannot change the result', () => {
  const expected = withService((service) => play(service, 'unique', FULL_LOG).state_hash);
  const duplicate = withService((service) => {
    service.createMatch(matchConfig({ id: 'dupe' }), 'create');
    const first = service.submitInputs('dupe', { inputs: FULL_LOG }, 'inputs-1');
    assert.equal(first.inputs.accepted, FULL_LOG.length);
    const again = service.submitInputs('dupe', { inputs: FULL_LOG }, 'inputs-2');
    assert.equal(again.accepted.length, 0);
    assert.equal(again.duplicates.length, FULL_LOG.length);
    assert.equal(again.inputs.duplicates, FULL_LOG.length);
    return service.advance('dupe', { count: 8 }, 'advance').state_hash;
  });
  assert.equal(duplicate, expected);
});

test('missing inputs are reported and change the outcome', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'sparse' }), 'create');
    service.submitInputs('sparse', { inputs: [input(0, 'red-1', { attacking: true, kind: 'attack' })] }, 'inputs');
    const state = service.advance('sparse', { count: 3 }, 'advance');
    assert.equal(state.tick, 3);
    assert.equal(state.inputs.missing, 5);
    assert.equal(state.inputs.accepted, 1);
    assert.equal(state.frames[0].settled, false);
    assert.equal(state.frames.length, 3);
  });
});

test('advancing without a body advances exactly one tick', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'step' }), 'create');
    const state = service.advance('step', undefined, 'advance');
    assert.equal(state.tick, 1);
    assert.equal(state.frames.length, 1);
    assert.equal(state.frames[0].tick, 1);
  });
});

test('a late input rolls back and reproduces the in-order hash', () => {
  const expected = withService((service) => play(service, 'prompt', FULL_LOG).state_hash);
  withService((service) => {
    service.createMatch(matchConfig({ id: 'late' }), 'create');
    service.submitInputs('late', { inputs: FULL_LOG.filter((record) => record.tick < 4) }, 'inputs-1');
    const early = service.advance('late', { count: 8 }, 'advance-1');
    assert.equal(early.tick, 8);
    const stale = early.state_hash;

    const late = service.submitInputs('late', { inputs: FULL_LOG.filter((record) => record.tick >= 4) }, 'inputs-2');
    assert.equal(late.inputs.rollbacks, 1);
    assert.equal(late.rollback.to_tick, 4);
    assert.equal(late.rollback.from_tick, 8);
    assert.equal(late.rollback.frames_recomputed, late.tick - 4);
    assert.equal(late.rollback.hash_before, stale);
    assert.equal(late.tick, 8);
    assert.equal(late.state_hash, late.rollback.hash_after);
    assert.equal(late.state_hash, expected);
  });
});

test('rollback rewinds a match and re-advancing reproduces the same hash', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'rewind' }), 'create');
    service.submitInputs('rewind', { inputs: FULL_LOG }, 'inputs');
    const full = service.advance('rewind', { count: 8 }, 'advance-1');
    const report = service.rollback('rewind', 3);
    assert.equal(report.to_tick, 3);
    assert.equal(report.from_tick, 8);
    assert.equal(report.frames_recomputed, 5);
    assert.equal(report.hash_before, full.state_hash);

    const after = service.getState('rewind');
    assert.equal(after.tick, 3);
    assert.equal(after.state_hash, report.hash_after);
    assert.notEqual(after.state_hash, full.state_hash);
    // The frontier hash is the hash of the state the frontier holds, so it must
    // still equal the hash of the frame that was discarded.
    assert.equal(report.hash_after, full.frames[2].state_hash);

    const again = service.advance('rewind', { count: 5 }, 'advance-2');
    assert.equal(again.tick, 8);
    assert.equal(again.state_hash, full.state_hash);
    assert.equal(service.verify({ match_id: 'rewind' }).consistent, true);
  });
});

test('rollback beyond the current tick is a conflict', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'ahead' }), 'create');
    service.advance('ahead', { count: 2 }, 'advance');
    assert.throws(() => service.rollback('ahead', 5), (error) => error instanceof ConflictError && error.status === 409);
    assert.throws(() => service.rollback('ahead', -1), ValidationError);
  });
});

test('out-of-range ticks, unknown units and malformed commands are rejected', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'reject' }), 'create');
    const result = service.submitInputs('reject', {
      inputs: [
        input(0, 'red-1', { by: 1, kind: 'move' }),
        input(900, 'red-1', { by: 1, kind: 'move' }),
        input(0, 'ghost', { attacking: true, kind: 'attack' }),
        input(0, 'blue-1', { kind: 'dash' }),
        input(0, 'blue-1', { by: 1, kind: 'move', position: 2 }),
      ],
    }, 'inputs');
    assert.equal(result.accepted.length, 1);
    assert.deepEqual(result.rejected.map((entry) => entry.reason),
      ['out_of_range', 'unknown_unit', 'invalid_input', 'invalid_input']);
    assert.deepEqual(result.rejected.map((entry) => entry.index), [1, 2, 3, 4]);
    assert.equal(result.inputs.rejected, 4);
    assert.equal(result.tick, 0);
  });
});

test('the state hash is a pure function of the hashable state', () => {
  const config = sim.parseConfig(matchConfig());
  const state = sim.initialState(config);
  const baseline = sim.stateHash(state);
  assert.match(baseline, /^[0-9a-f]{64}$/);
  assert.equal(sim.stateHash(sim.cloneState(state)), baseline);

  const nudged = sim.cloneState(state);
  nudged.units['red-1'].position += 1;
  assert.notEqual(sim.stateHash(nudged), baseline);

  const attacking = sim.cloneState(state);
  attacking.units['blue-1'].attacking = true;
  assert.notEqual(sim.stateHash(attacking), baseline);

  const damaged = sim.cloneState(state);
  damaged.units['red-1'].health -= 1;
  damaged.teamDamage.blue += 1;
  assert.notEqual(sim.stateHash(damaged), baseline);
});

test('the input record identity ignores arrival order and sequence tags', () => {
  const first = input(3, 'red-1', { attacking: true, kind: 'attack' });
  const second = { ...first, seq: 99 };
  assert.equal(sim.canonicalInput(first), sim.canonicalInput(second));
  assert.equal(sim.inputSetHash([first, second]), sim.inputSetHash([second, first]));

  const attack = input(1, 'red-1', { attacking: true, kind: 'attack' });
  const move = input(1, 'red-1', { kind: 'move', velocity: 3 });
  assert.equal([move, attack].sort(sim.compareInputs)[0], move);
  assert.equal([attack, move].sort(sim.compareInputs)[0], move);
});

test('attacks resolve simultaneously against the lowest-health enemy', () => {
  const config = sim.parseConfig({
    id: 'focus',
    max_ticks: 10,
    units: [
      { id: 'blue-1', position: 0, team: 'blue', velocity: 0 },
      { id: 'red-1', position: 0, team: 'red', velocity: 0 },
      { id: 'red-2', position: 0, team: 'red', velocity: 0 },
    ],
  });
  const state = sim.initialState(config);
  state.units['blue-1'].attacking = true;
  const delta = sim.applyTick(state, []);
  assert.deepEqual(delta.casualties, []);
  assert.equal(state.units['red-1'].health, 90);
  assert.equal(state.units['red-2'].health, 100);
  assert.equal(state.teamDamage.blue, 10);
  assert.equal(state.teamDamage.red, 0);
});

test('a match stops at max_ticks or when one team is eliminated', () => {
  withService((service) => {
    service.createMatch(matchConfig({
      id: 'timeout',
      max_ticks: 3,
      units: [{ id: 'blue-1', team: 'blue' }, { id: 'red-1', position: 40, team: 'red', velocity: 0 }],
    }), 'create');
    service.submitInputs('timeout', { inputs: [
      input(0, 'blue-1', { attacking: true, kind: 'attack' }),
      input(0, 'red-1', { attacking: true, kind: 'attack' }),
    ] }, 'inputs');
    const state = service.advance('timeout', { count: 3 }, 'advance');
    assert.equal(state.tick, 3);
    assert.equal(state.status, 'max_ticks');
    assert.equal(state.teams.blue.alive, 1);
    assert.equal(state.teams.red.alive, 1);
    assert.throws(() => service.advance('timeout', { count: 1 }, 'advance-2'), ConflictError);
  });

  withService((service) => {
    service.createMatch(matchConfig({
      id: 'elimination',
      max_ticks: 40,
      units: [
        { id: 'blue-1', position: 900, team: 'blue', velocity: 0 },
        { id: 'red-1', position: 100, team: 'red', velocity: 0 },
        { id: 'red-2', position: 110, team: 'red', velocity: 0 },
        { id: 'red-3', position: 120, team: 'red', velocity: 0 },
      ],
    }), 'create');
    service.submitInputs('elimination', { inputs: [
      input(0, 'blue-1', { attacking: true, kind: 'attack' }),
      input(0, 'red-1', { attacking: true, kind: 'attack' }),
      input(0, 'red-2', { attacking: true, kind: 'attack' }),
      input(0, 'red-3', { attacking: true, kind: 'attack' }),
    ] }, 'inputs');
    const state = service.advance('elimination', { count: 40 }, 'advance');
    assert.equal(state.status, 'red_wins');
    assert.equal(state.teams.blue.alive, 0);
    const loser = state.units.find((unit) => unit.id === 'blue-1');
    assert.equal(loser.alive, false);
    assert.equal(loser.health, 0);
  });
});

test('replay documents verify, and a shuffled input array stays valid', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'doc' }), 'create');
    service.submitInputs('doc', { inputs: FULL_LOG }, 'inputs');
    service.advance('doc', { count: 8 }, 'advance');
    const document = service.replayFile('doc');
    assert.equal(document.kind, 'lockstepnet.replay');
    assert.equal(document.version, sim.SCHEMA_VERSION);
    assert.equal(document.frames.length, 8);
    assert.equal(document.inputs.length, FULL_LOG.length);

    const verdict = service.verify({ replay: document });
    assert.equal(verdict.consistent, true);
    assert.equal(verdict.mismatches.length, 0);
    assert.equal(verdict.ticks_replayed, 8);
    assert.equal(verdict.final_state_hash, service.getState('doc').state_hash);

    assert.equal(service.verify({ replay: { ...document, inputs: [...document.inputs].reverse() } }).consistent, true);
  });
});

test('tampering with a frame, its inputs or the fingerprint is located', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'tamper' }), 'create');
    service.submitInputs('tamper', { inputs: FULL_LOG }, 'inputs');
    service.advance('tamper', { count: 8 }, 'advance');
    const document = service.replayFile('tamper');
    const broken = (mutate) => {
      const copy = JSON.parse(JSON.stringify(document));
      mutate(copy);
      return service.verify({ replay: copy });
    };

    const wrongHash = broken((copy) => { copy.frames[2].state_hash = 'f'.repeat(64); });
    assert.equal(wrongHash.consistent, false);
    assert.equal(wrongHash.mismatches[0].kind, 'state_hash');
    assert.equal(wrongHash.mismatches[0].tick, 3);
    assert.equal(wrongHash.final_state_hash, null);

    const wrongInputs = broken((copy) => { copy.frames[4].inputs = []; });
    assert.equal(wrongInputs.consistent, false);
    assert.equal(wrongInputs.mismatches[0].kind, 'frame_inputs');
    assert.equal(wrongInputs.mismatches[0].tick, 5);

    const skipped = broken((copy) => { copy.frames.splice(3, 1); });
    assert.equal(skipped.mismatches.some((entry) => entry.kind === 'frame_sequence'), true);

    const fingerprint = broken((copy) => { copy.replay_hash = '0'.repeat(64); });
    assert.equal(fingerprint.mismatches.some((entry) => entry.kind === 'replay_hash'), true);
  });
});

test('replay documents are validated before they are replayed', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'shape' }), 'create');
    const document = service.replayFile('shape');
    const rejects = (patch) => assert.throws(() => service.verify({ replay: { ...document, ...patch } }), ValidationError);
    rejects({ kind: 'other' });
    rejects({ version: 99 });
    rejects({ unexpected: true });
    rejects({ inputs: 'all' });
    rejects({ frames: [{ tick: 0, state_hash: 'x' }] });
    rejects({ frames: [{ inputs: [], state_hash: 'A'.repeat(64), tick: 1 }] });
    rejects({ match: { id: 'x', units: [] } });
    rejects({ match: { id: 'x' } });
  });
});

test('a partial log still verifies', () => {
  withService((service) => {
    service.createMatch(matchConfig({ id: 'partial' }), 'create');
    service.submitInputs('partial', { inputs: FULL_LOG }, 'inputs-1');
    service.advance('partial', { count: 4 }, 'advance-1');
    const verdict = service.verify({ replay: service.replayFile('partial') });
    assert.equal(verdict.consistent, true);
    assert.equal(verdict.ticks_replayed, 4);
  });
});

test('idempotency keys return the first result and conflict on reuse', () => {
  withService((service) => {
    const first = service.createMatch(matchConfig({ id: 'idem' }), 'key-1');
    assert.deepEqual(service.createMatch(matchConfig({ id: 'idem' }), 'key-1'), first);
    assert.throws(() => service.createMatch(matchConfig({ id: 'idem' }), undefined), ValidationError);
    assert.throws(() => service.createMatch(matchConfig({ id: 'idem-2' }), 'key-1'), ConflictError);

    service.submitInputs('idem', { inputs: [input(0, 'red-1', { by: 5, kind: 'move' })] }, 'key-2');
    service.advance('idem', { count: 1 }, 'key-3');
    assert.equal(service.advance('idem', { count: 1 }, 'key-3').tick, 1);
    assert.equal(service.getState('idem').tick, 1);
    assert.throws(() => service.submitInputs('idem', {
      inputs: [input(0, 'red-1', { by: 9, kind: 'move' })],
    }, 'key-2'), ConflictError);
  });
});

test('unknown matches are not found', () => {
  withService((service) => {
    assert.throws(() => service.getState('nope'), (error) => error instanceof NotFoundError && error.status === 404);
    assert.throws(() => service.replayFile('nope'), NotFoundError);
    assert.throws(() => service.verify({ match_id: 'nope' }), NotFoundError);
    assert.throws(() => service.submitInputs('nope', { inputs: [] }, 'key'), NotFoundError);
  });
});

test('the CLI verifies a replay file and reports tampering', async () => {
  const database = databasePath();
  const file = path.join(workspace, 'replay.json');
  const service = new Lockstep(database);
  service.createMatch(matchConfig({ id: 'cli' }), 'create');
  service.submitInputs('cli', { inputs: FULL_LOG }, 'inputs');
  service.advance('cli', { count: 8 }, 'advance');
  const document = service.replayFile('cli');
  writeFileSync(file, JSON.stringify(document));
  service.close();

  const run = (target) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'verify', '--path', target, '--database', database], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => resolve({ code, stdout }));
  });

  const ok = await run(file);
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).consistent, true);

  const broken = JSON.parse(JSON.stringify(document));
  broken.frames[0].state_hash = '1'.repeat(64);
  const brokenPath = path.join(workspace, 'broken.json');
  writeFileSync(brokenPath, JSON.stringify(broken));
  const bad = await run(brokenPath);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).consistent, false);
});

test('the HTTP server serves the documented routes and the startup line', async () => {
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
    assert.deepEqual((await call('GET', '/health')).body, { service: 'lockstepnet', status: 'ok' });

    const created = await call('POST', '/matches', matchConfig({ id: 'http' }), 'http-create');
    assert.equal(created.status, 201);
    assert.equal(created.body.match_id, 'http');
    const repeated = await call('POST', '/matches', matchConfig({ id: 'http' }), 'http-create');
    assert.equal(repeated.body.state_hash, created.body.state_hash);

    const submitted = await call('POST', '/matches/http/inputs', { inputs: FULL_LOG }, 'http-inputs');
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.accepted.length, FULL_LOG.length);

    const ticked = await call('POST', '/matches/http/tick', { count: 8 }, 'http-tick');
    assert.equal(ticked.status, 200);
    assert.equal(ticked.body.tick, 8);
    assert.equal(ticked.body.frames.length, 8);
    assert.equal((await call('GET', '/matches/http')).body.state_hash, ticked.body.state_hash);

    const replay = await call('GET', '/matches/http/replay');
    assert.equal(replay.body.frames.length, 8);
    assert.equal((await call('POST', '/matches/http/verify', { replay: replay.body })).body.consistent, true);

    const rolled = await call('POST', '/matches/http/rollback', { tick: 4 }, 'http-rollback');
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.tick, 4);
    assert.equal(rolled.body.from_tick, 8);
    assert.equal(rolled.body.frames_recomputed, 4);

    const badCount = await call('POST', '/matches/http/tick', { count: 0 }, 'http-tick-bad');
    assert.equal(badCount.status, 400);
    assert.equal(badCount.body.error.code, 'validation_error');
    assert.equal((await call('GET', '/matches/missing')).status, 404);
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('POST', '/matches/http/inputs', { inputs: FULL_LOG })).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.close();
  }

  // The process must print its listening line and answer /health over curl.
  const child = spawn(process.execPath, [
    path.join(ROOT, 'src', 'server.js'), '--host', '127.0.0.1', '--port', '18097', '--database', databasePath(),
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = await new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('listening on')) {
        resolve(stdout.trim());
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early with ${code}`)));
    setTimeout(() => reject(new Error('server did not start in time')), 10000);
  });
  try {
    assert.equal(line, 'LockstepNet listening on http://127.0.0.1:18097');
    const response = await fetch('http://127.0.0.1:18097/health');
    assert.deepEqual(await response.json(), { service: 'lockstepnet', status: 'ok' });
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  }
});
