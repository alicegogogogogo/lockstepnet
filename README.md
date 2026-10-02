# LockstepNet

LockstepNet is a small backend for **deterministic lockstep frame simulation with
rollback replay**. It runs a fixed-tick simulation of a tiny battle engine, takes
player inputs addressed to a specific tick and returns a state hash per tick.
Because the engine is a pure function of (configuration, set of input records), an
input that arrives late only causes a rollback: the affected frames are recomputed
from the stored input log and the final hash is bit-for-bit the same as if the
input had arrived on time.

The initial release intentionally supports a compact public contract:

- a match is a fixed-tick simulation of units on a 1-D line, at most 32 units on
  exactly two teams (`red` and `blue`);
- inputs are addressed to a tick and keyed by `(tick, unit, command)`, applied in
  a canonical order inside their tick, so arrival order cannot change the result;
- every advanced tick records a frame carrying a sha256 state hash;
- a late or out-of-order input triggers a rollback and recomputation;
- a replay document can be verified by re-simulating it from tick 0.

## Requirements

- Node.js 22.5 or newer (uses the standard-library `node:sqlite` binding)
- no third-party runtime dependencies

## Run the service

```bash
node src/server.js --host 127.0.0.1 --port 18090 --database lockstepnet.db
```

The process prints `LockstepNet listening on http://127.0.0.1:18090` after it has
bound the port. `--host`, `--port` and `--database` default to `127.0.0.1`,
`18090` and `lockstepnet.db`.

## Data model

A match has a `tick`, the number of frames already simulated (`0` on creation),
and a `status`: `running` while it can advance, `red_wins` or `blue_wins` when
every unit of the other team reached 0 health, or `max_ticks` when the frontier
reached `max_ticks` with both teams alive. `tick` grows strictly until a rollback
rewinds it, the frontier never passes `max_ticks`, and `POST /tick` on a match
that is not `running` is a `conflict`.

### Match configuration
`POST /matches` accepts exactly `id`, `seed`, `max_ticks` and `units`:

```json
{
  "id": "duel-1",
  "seed": 11,
  "max_ticks": 64,
  "units": [
    {"id": "red-1", "team": "red", "position": 0, "velocity": 5},
    {"id": "blue-1", "team": "blue", "position": 1000, "velocity": -5}
  ]
}
```

- `id` matches `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, at most 64 characters; unit ids
  follow the same rule and must be unique.
- `seed` is a reserved non-negative integer (default `0`); the engine uses no
  randomness, so two matches with different seeds and the same inputs still
  produce the same hashes.
- `max_ticks` defaults to `1000`, minimum `1`, maximum `100000`.
- `units` holds 1 to 32 entries and must contain at least one unit per team.
- `position` defaults to `0` for `red` and `1000` for `blue` and is clamped to
  `[0, 1000]`; `velocity` defaults to `+5` (`red`) or `-5` (`blue`).

Every unit starts with 100 health and `attacking: false`.

### Tick semantics

Each tick is one discrete time step and applies, in this exact order:

1. **Movement.** For every `move` input, in ascending unit-id order: a `position`
   command sets the coordinate and a `by` command adds a relative step, both
   clamped to `[0, 1000]`. A `velocity` command only stores the value; the stored
   velocity never moves a unit on its own. Dead units ignore `move` commands.
2. **Intent.** For every `attack` input, in ascending unit-id order, the unit's
   `attacking` flag is set to the submitted boolean. It stays set on later ticks
   until a command turns it off.
3. **Targeting.** Again in ascending unit-id order, every living unit with
   `attacking: true` picks its target: the living enemy with the **lowest
   health**, ties broken by the **lowest unit id**.
4. **Damage.** All damage is accumulated first and then applied simultaneously,
   each attacker dealing `max(1, floor(10 * attacker.health / 100))`, with health
   floored at `0`. Attacks read the health units had *before* this tick's damage,
   so simultaneous kills stay symmetric.
5. **Bookkeeping.** `team_damage[team]` accumulates the damage that team has dealt
   to its opponent, and the match ends if a team is eliminated or the frontier
   reaches `max_ticks`.

A tick with no input for a unit is a no-op for that unit. Each tick records a
**frame** with `tick`, the canonical inputs that were applied, the resulting
`state_hash`, whether the tick was `settled` (one record per unit alive at the
start of the tick) and a `delta` listing the units whose `position`, `health` or
`velocity` changed plus any `casualties`.

### State hash

`state_hash` is the sha256, as lowercase hex, of
`sha256("lockstepnet.state.v1\n" + payload)`, where `payload` is a canonical JSON
object with this exact field order, integer numbers and no whitespace:

```
{"team_damage":{"blue":<int>,"red":<int>},
 "tick":<int>,
 "units":[...],
 "version":1}
```

`units` lists living units sorted by unit id and then dead units sorted by unit
id, each with this exact field order:

```
{"attacking":<true|false>,"health":<int|null>,"id":"<unit id>",
 "position":<int>,"team":"<red|blue>","velocity":<int>}
```

`health` is the current health for living units and `null` for dead ones, whose
`attacking` is always `false` and whose `position`/`velocity` are frozen at their
last values. Nothing else takes part: `seed`, `max_ticks`, unapplied velocity,
arrival order and arrival time are invisible to the hash.

## HTTP API

All bodies are JSON, unknown fields are rejected with `validation_error`, and every
state-changing `POST` requires an `Idempotency-Key` header.

### Health

`GET /health` returns `{"service":"lockstepnet","status":"ok"}`.

### Create a match

```http
POST /matches
Idempotency-Key: create-duel-1

{"id":"duel-1","seed":11,"max_ticks":64,
 "units":[{"id":"red-1","team":"red"},{"id":"blue-1","team":"blue"}]}
```

Returns HTTP 201 with the match state: `match_id`, `config`, `tick`, `status`,
`state_hash`, `units`, `teams` and `inputs`, where `inputs` counts `accepted`,
`duplicates`, `missing`, `rejected`, `rollbacks` and `settled`.

### Submit inputs

```http
POST /matches/duel-1/inputs
Idempotency-Key: inputs-1

{"inputs":[
  {"tick":0,"unit":"red-1","command":{"kind":"move","position":400}},
  {"tick":1,"unit":"red-1","command":{"kind":"attack","attacking":true}}
]}
```

A `move` command contains **exactly one** of `position` (absolute), `by` (relative
step) or `velocity`. An `attack` command contains exactly `kind` and `attacking`.
The optional `seq` is an arrival tag and never takes part in the hash.

Returns HTTP 201 with the match state plus:

```json
{
  "accepted":  [{"command":"move","seq":0,"tick":0,"unit":"red-1"}],
  "duplicates":[{"command":"attack","tick":1,"unit":"red-1"}],
  "rejected":  [{"index":2,"message":"...","reason":"invalid_input"}],
  "rollback":  null
}
```

- **duplicate** — `(tick, unit, command)` is already stored: counted, not applied,
  and it cannot change the state.
- **rejected** — `reason` is `invalid_input`, `out_of_range` (tick >= `max_ticks`)
  or `unknown_unit`; records appear in submission order with their `index`.
- **rollback** — non-null only when a record addressed a tick at or below the
  current frontier.

### Advance the simulation

```http
POST /matches/duel-1/tick
Idempotency-Key: tick-1

{"count":8}
```

`count` defaults to `1` and is limited to `1024`. Returns the match state plus
`advanced` (frames produced by this request) and `frames`, an array of
`{"tick","state_hash","settled","casualties"}`. The response `state_hash` is the
hash of the last frame, and the simulation stops early if a team is eliminated.

### Inspect, replay and verify

```http
GET  /matches/duel-1
GET  /matches/duel-1/replay
POST /matches/duel-1/verify
Idempotency-Key: verify-1

{"match_id":"duel-1"}
```

`GET /matches/{id}` returns the current match state; its `units` list every unit
with `id`, `team`, `position`, `velocity`, `health`, `attacking` and `alive`,
sorted by unit id. `GET /matches/{id}/replay` returns the whole match as a
portable replay document (format below).

The verify body may instead carry `{"replay":{...}}` with an uploaded document.
Either form re-simulates the match from tick 0 and compares every recomputed state
hash with the recorded one:

```json
{"consistent":true,"match_id":"duel-1","ticks_replayed":8,
 "final_state_hash":"<64 hex>","recorded_state_hash":"<64 hex>",
 "replay_hash":"<64 hex>","mismatches":[]}
```

Each `mismatches` entry has a `kind` of `state_hash` (a frame no longer
re-simulates to its recorded hash), `frame_inputs` (a frame does not list the
canonical inputs of its tick), `frame_sequence` (the log skips or repeats a tick)
or `replay_hash` (the document fingerprint is wrong), plus the offending `tick`.
Shuffling the `inputs` array of a valid document does not change the verdict.

### Roll back

```http
POST /matches/duel-1/rollback
Idempotency-Key: rollback-1

{"tick":4}
```

Discards every frame after `tick` and trims the frontier back to it:

```json
{"match_id":"duel-1","from_tick":8,"to_tick":4,"tick":4,
 "hash_before":"<64 hex>","hash_after":"<64 hex>","frames_recomputed":4}
```

Input records are **never** discarded, so advancing again replays them and
reproduces exactly the hashes recorded before the rollback. Rolling back past the
current tick is a `conflict`; a negative or non-integer tick is a
`validation_error`.

### Rollback boundaries on late input

`POST /inputs` performs one automatic rollback when the earliest accepted record
addresses a tick at or below the frontier:

1. the frontier is trimmed back to that tick and its frames are discarded;
2. the span from that tick to the previously recorded frontier is rebuilt from
   the stored input records, in canonical order;
3. every rebuilt frame that already existed must reproduce its recorded hash; a
   divergence is reported as `integrity_failure` (409) instead of silently
   returning a different hash.

The response carries `rollback`:
`{"from_tick":8,"to_tick":4,"tick":8,"frames_recomputed":4,"hash_before":"...",
"hash_after":"..."}`. Because arrival order and arrival time are not part of the
canonical input, a late input produces the same final `state_hash` as a prompt
one. Records for ticks past the frontier are stored and applied when the frontier
reaches them.

### Sessions, disconnect and resume

A session binds a client to one or more match units so its inputs are submitted
through a session channel. Sessions are bookkeeping only: they never take part
in a `state_hash` or `replay_hash`, and queries, replay, verification,
advancement and rollback behave exactly as without them.

```http
POST /matches/duel-1/sessions
Idempotency-Key: session-p1

{"id":"p1","units":["red-1"]}
```

Returns HTTP 201 with `session_id`, `match_id`, `units` and a `status` that
starts at `connected`. `units` must be a non-empty list of distinct units that
all belong to the match, and no unit may belong to two sessions; creating a
session whose id already exists is a `conflict`.

```http
POST /matches/duel-1/sessions/p1/inputs
Idempotency-Key: session-p1-inputs-1

{"inputs":[{"tick":0,"unit":"red-1","command":{"kind":"attack","attacking":true}}]}
```

This uses the same input format, de-duplication key, canonical order, late-input
rollback and counters as `POST /matches/{id}/inputs`. A record whose unit is not
bound to the session is reported under `rejected` with reason
`wrong_session`; submitting to a `disconnected` session is a `conflict`.

```http
POST /matches/duel-1/sessions/p1/disconnect   # body must be {} or empty
Idempotency-Key: session-p1-disconnect

POST /matches/duel-1/sessions/p1/resume
Idempotency-Key: session-p1-resume-1

{"after_tick":4,"limit":1024}
```

`disconnect` sets the session `status` to `disconnected` without touching the
match. `resume` sets it back to `connected` and streams the frames recorded
**after** `after_tick`, at most `limit` of them (`limit` defaults to `1024` and
may not exceed it). The response carries:

```json
{
  "session_id": "p1",
  "match_id": "duel-1",
  "status": "connected",
  "frames": [
    {"tick": 5, "state_hash": "<64 hex>", "settled": true, "casualties": []}
  ],
  "units": [
    {"id":"red-1","team":"red","position":0,"velocity":5,"health":90,"attacking":true,"alive":true}
  ],
  "team_damage": {"blue": 0, "red": 10},
  "state_hash": "<64 hex>",
  "next_tick": 8,
  "complete": true
}
```

- `frames` are contiguous and in tick order; each is re-derived from the stored
  input log and must reproduce its recorded hash, otherwise the request fails
  with `integrity_failure` instead of returning inconsistent data.
- `units` lists the session's units and `team_damage` the totals as they are at
  `next_tick`; `state_hash` is the hash of that tick.
- `complete` is `true` once the window reaches the current frontier, otherwise
  the client calls again with `after_tick` set to the returned `next_tick`.

`after_tick` must be a non-negative integer no greater than the current tick
(`conflict` when it is ahead); `limit` must be an integer from `1` to `1024`.
`disconnect` and `resume` are state-transition calls: repeating either one (a
new call with the same already-reached state) simply reports that state, so a
partial catch-up is paged with further `resume` calls. An unknown match is
`not_found`; an unknown session is also `not_found`.

### Spectators and delay compensation

A spectator is a passive observer that trails the live frontier by a fixed
number of ticks. Spectators are bookkeeping only, exactly like sessions:
creating or polling one never advances the match and never enters a
`state_hash` or `replay_hash`; queries, replay, verification, advancement and
rollback behave exactly as without them.

```http
POST /matches/duel-1/spectators
Idempotency-Key: spectator-cam

{"id":"cam","delay_ticks":4}
```

The body contains exactly `id` and `delay_ticks`. `id` follows the identifier
rule and must be unique among the match's spectators (a duplicate is a
`conflict`); `delay_ticks` is an integer from `0` to `1024`. Returns HTTP 201
with `spectator_id`, `match_id`, `delay_ticks` and `visible_tick`.

`visible_tick` is the newest frame the spectator may currently see:
`max(0, tick - delay_ticks)` while the match is `running`. Once the match has
ended (`red_wins`, `blue_wins` or `max_ticks`) the frontier is frozen, so
`visible_tick` becomes the final tick and the spectator may catch up to the end.

```http
POST /matches/duel-1/spectators/cam/poll
Idempotency-Key: spectator-cam-poll-1

{"after_tick":0,"limit":1024}
```

The body contains exactly `after_tick` and `limit`; `after_tick` (the last frame
the caller already holds) defaults to `0` and `limit` defaults to `1024` and is
an integer from `1` to `1024`. A successful response carries `mode` set to
`stream`:

```json
{
  "spectator_id": "cam",
  "match_id": "duel-1",
  "mode": "stream",
  "frames": [
    {"tick": 1, "state_hash": "<64 hex>", "settled": true, "casualties": []}
  ],
  "next_tick": 5,
  "units": [
    {"id":"red-1","team":"red","position":0,"velocity":5,"health":90,"attacking":true,"alive":true}
  ],
  "team_damage": {"blue": 0, "red": 10},
  "state_hash": "<64 hex>",
  "complete": false
}
```

- `frames` are contiguous and in tick order, covering the recorded frames
  strictly after `after_tick` up to `visible_tick`, at most `limit`; each frame
  carries `tick`, `state_hash`, `settled` and `casualties` and must reproduce
  its recorded hash, otherwise the request fails with `integrity_failure`.
- `next_tick` is one past the last delivered frame and is the `after_tick` of
  the next poll. `units` lists every unit and `team_damage` the totals as they
  are at `next_tick`; `state_hash` is the hash of that tick (the initial hash
  when no frame was delivered).
- `complete` is `true` only when the window reaches `visible_tick`. When no
  frame is in the window, the response is the snapshot at `after_tick` with an
  empty `frames` array.
- `after_tick` greater than `visible_tick` is a `conflict`.

Polling is a state-changing call (it advances the spectator's paging cursor)
and requires an `Idempotency-Key`; both spectator POSTs return
`validation_error` when the header is missing, and reuse of a key for another
operation or body is a `conflict`.

#### Rollback and the reset stream

If a late input triggers an automatic rollback, or
`POST /matches/{id}/rollback` rewinds past a frame that a spectator has already
received (the rollback target is below the spectator's highest delivered
frame), that part of history is recomputed and the frames the spectator held
can change. The next poll therefore returns `mode` set to `reset`: it ignores
`after_tick`, replays the whole match from tick 0 in pages of `limit`, and the
caller pages through with the returned `next_tick`. Every reset page keeps
`mode: "reset"`, and `complete` is true once the replay reaches the current
`visible_tick`; the following poll is a normal `stream` again. A frame that does
not reproduce its recorded hash during the replay fails the poll with
`integrity_failure`.

An unknown match or spectator is `not_found`; malformed parameters are
`validation_error`; a duplicate spectator id or an `after_tick` ahead of the
visible tick is `conflict`.

### Replay file format

```json
{
  "version": 1,
  "kind": "lockstepnet.replay",
  "match": {"id":"duel-1","seed":11,"max_ticks":64,
            "units":[{"id":"red-1","team":"red","position":0,"velocity":5}]},
  "inputs": [{"tick":0,"unit":"red-1","command":{"kind":"move","position":400}}],
  "frames": [{"tick":1,"state_hash":"<64 hex>","settled":true,
              "inputs":["<canonical input json>"],
              "delta":{"tick":1,"changed":[...],"casualties":[]}}],
  "replay_hash": "<64 hex>"
}
```

- `inputs` is the whole-match input log and is order-insensitive.
- `frames` holds one entry per advanced tick, contiguous from `1`, and each
  frame's `inputs` array is the ascending canonical form of that tick's records.
- `replay_hash` is the sha256 of the domain string `lockstepnet.replay.v1\n`
  followed by the canonical JSON of the match configuration, the sorted input
  records and the frame ticks and hashes. It is optional on input: when present it
  is checked.
- A verifier derives all unit snapshots from `match.units` plus the frames.

## Command line

```bash
node src/cli.js verify --path replay.json [--database lockstepnet.db]
```

Prints the same verdict as `POST /matches/{id}/verify`. Exit code `0` means
consistent, `1` means a mismatch and `2` means the document was rejected.

## Errors

```json
{"error":{"code":"validation_error","message":"human readable detail"}}
```

Validation errors return 400, a missing match or route returns 404, a conflict
returns 409, and an internal consistency failure returns 409 with the code
`integrity_failure`. A state-changing POST without the `Idempotency-Key` header is
a `validation_error`; reusing a key for another operation or body is a `conflict`;
repeating an identical request returns the first response without advancing again.

## Tests

```bash
node --test tests/*.test.js
```
