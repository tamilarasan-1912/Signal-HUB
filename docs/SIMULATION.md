# Simulation

The scenario engine, the end-to-end demo, and the determinism that makes both
testable.

## Why simulation is a first-class subsystem

There is no city traffic hardware to attach to, and no lawful way to conduct
experiments on a live signal network. So the simulation is not a stopgap — it is
the only way the platform's behaviour can be demonstrated and tested at all.

That makes one property non-negotiable: **the simulation drives the same code
paths a live feed would.** If the demo called private shortcuts, it would prove
nothing about the system. It generates demand, advances intersections, applies
signal states and publishes events through the same functions a real input would.

The scenarios are therefore not mocks. They are *inputs*.

## Determinism

```js
createRandom(seed)   // a 32-bit LCG, seeded per engine
```

Same seed, same city, same scenario, same result. `SIGNAL_HUB_SEED` defaults to
7, so two runs of the demo produce the same congestion, the same ambulance route
and the same violation.

This is what makes a failed test reproducible and a bug report actionable: a
symptom can be replayed exactly, rather than "it happened once".

`createRandom` is exposed as an object rather than a bare function so a test can
reset it deliberately and prove the same sequence comes back.

## Demand

```js
generateDemand(network, { pressure, random, corridorIntersectionIds })
```

Demand is generated per intersection, weighted by road class and then modulated
by the scenario's `pressure`. A jam is a high pressure on a corridor; peak hour
is a moderate pressure everywhere. The weighting by road class is why traffic
concentrates on arterials rather than distributing uniformly, which is what makes
the congestion engine's output look like a city rather than like noise.

```js
advanceIntersection(intersection, demand, { dtS, random })
```

One step of traffic evolution for a single intersection: vehicles arrive, queue,
and discharge according to the signal state. `applySignalState(intersection,
signal)` binds the controller's actual phase onto the intersection, so the queue
dynamics respond to the signal rather than to an assumed one.

## Scenarios

Eight scenarios, each an operator-triggerable button.

| Scenario | `SCENARIO_META` label | What it drives |
| --- | --- | --- |
| `traffic-jam` | SIMULATE TRAFFIC JAM | loads one corridor until it queues, so the optimizer has something real to react to |
| `red-light-violation` | SIMULATE RED LIGHT VIOLATION | a tracked vehicle crosses a stop line on red and is logged |
| `ambulance` | SIMULATE AMBULANCE | spawns an ambulance, plans its corridor, preempts signals |
| `fire-engine` | SIMULATE FIRE ENGINE | the same corridor machinery with a fire appliance |
| `accident` | SIMULATE ACCIDENT | raises a collision incident with a recommended response |
| `signal-failure` | SIMULATE SIGNAL FAILURE | drops one controller into fault and alerts the operator |
| `camera-failure` | SIMULATE CAMERA FAILURE | takes one camera down and records the coverage loss |
| `peak-hour` | SIMULATE CITY PEAK HOUR | raises demand network-wide and lets adaptive control respond |

Plus a verb-based form for composition. The runner understands `emergency`,
`incident`, `optimize` and the direct scenario ids, and maps short names onto
them:

```js
ambulance:      { scenario: 'emergency', options: { type: 'ambulance' } }
fire-engine:    { scenario: 'emergency', options: { type: 'fire-engine' } }
accident:       { scenario: 'incident',  options: { type: 'ACCIDENT' } }
signal-failure: { scenario: 'signal-failure', options: {} }
camera-failure: { scenario: 'camera-failure', options: {} }
```

Because scenarios compose this way, a new one is a function plus a metadata
entry. The API endpoint and the UI button both appear from the metadata, so
there is no third place to remember to update.

### `traffic-jam` in detail

The one worth reading, because it shows the simulation doing real work:

```js
'traffic-jam'({ pressure = 0.9 }) {
  const ids = corridorIds();                        // a real corridor in the data
  const demand = generateDemand(network, { pressure, random, corridorIntersectionIds: ids });
  for (const id of ids) {
    let next = getIntersection(id);
    for (let step = 0; step < 8; step += 1) {       // run forward so a queue forms
      next = advanceIntersection(next, demand.get(id), { dtS: 6, random });
      const signal = controllers.get(id)?.getSignalState();
      if (signal) next = applySignalState(next, signal);
    }
    updateIntersection(next);
  }
}
```

Two details that matter:

- **`corridorIds()` selects a corridor that exists in the loaded data**, not a
  hardcoded list of IDs. The scenario adapts to whichever city was loaded, which
  is why it works against both the Chennai preset and the fallback grid.
- **It steps forward 8 times at 6 seconds** rather than setting a queue value
  directly. The queue is *emergent* from arrival rates and signal discharge. A
  scenario that assigned `queueLength = 42` would produce a number the optimizer
  reacted to without any of the machinery being real.

## The end-to-end demo

```js
DEMO_SCENARIO = [
  { id: 'traffic-jam',  scenario: 'traffic-jam' },
  { id: 'optimize',     scenario: null },
  { id: 'ambulance',    scenario: 'ambulance' },
  { id: 'corridor-run', scenario: null },
  { id: 'release',      scenario: null },
  { id: 'violation',    scenario: 'red-light-violation' },
]
```

`scenario: null` marks a stage the engine drives through a method rather than a
runnable scenario: `optimize` asks the optimizer directly, `corridor-run`
advances the ambulance and preempts each intersection as it arrives, and
`release` hands control back. The plan and the stage report use the same ids, so
a caller can match the two without guessing, and a test asserts that they agree.

`POST /api/simulation/demo` runs the whole chain and reports every stage:

```json
{
  "ok": true,
  "mode": "simulated",
  "stages": [
    { "stage": "traffic-jam",  "ok": true, "label": "…" },
    { "stage": "optimize",     "ok": true, "label": "…" },
    { "stage": "ambulance",    "ok": true, "label": "…" },
    { "stage": "corridor-run", "ok": true, "label": "…", "preemptions": 2 },
    { "stage": "release",      "ok": true, "label": "…" },
    { "stage": "violation",    "ok": true, "label": "…", "violationId": "VIO-2026-000001" }
  ]
}
```

Each stage is recorded by an explicit `record(stage, detail)` helper whose
`ok` is set from what the stage actually observed, never from a scenario's own
return value. That distinction is deliberate: an earlier version spread the
scenario result into the stage object, so a scenario result carrying an `ok`
field could overwrite the stage's own `ok` and a failed stage could report
success. Keeping `ok` derived from observed state rather than a nested payload
is what makes the e2e assertion — that every stage's `ok` is true — meaningful.

`corridor-run` reports what it measured rather than what it hoped. It preempts
from the ambulance's actual proximity to each upcoming intersection, so
`preemptions` is a count of requests the engine really accepted and can be 0 if
the vehicle never gets close enough — in which case the stage reports `ok:
false` instead of claiming a corridor that was never preempted.

### Walking the demo

```text
1  traffic-jam
   demand concentrates on one corridor; eight 6-second steps
   → vehicle counts rise, queues form, average speed falls, congestion rises

2  optimize
   the adaptive engine reads the corridor's queues and computes a recommendation
   → "North/South GREEN 30s → 50s — High queue detected on North approach."
   → applied to the simulator, so the next steps actually flow

3  ambulance
   an emergency vehicle is created at a point on the network with a destination
   → fuseEmergencyDetection → band HIGH
   → route computed, upcoming intersections identified

4  corridor-run
   the ambulance is stepped along its route; at each upcoming intersection, once
   within approach range:
   → terminate current green → amber (3 s) → all-red (2 s) → priority green
   → corridor drawn in blue, intersections highlighted
   → "EMERGENCY PREEMPTION ACTIVE / Priority direction: NORTH / 18 sec"
   the loop runs until the vehicle arrives, then stops early

5  release
   preemption released
   → priority green → amber → restore the captured normal timing
   → "RESTORING NORMAL CONTROL"

6  violation
   a vehicle is tracked across a stop line while its signal reads red
   → evidence assembled: frame ref, stop-line crossing, signal state, track ID
   → plate read attempted; unreadable if below the confidence floor
   → violation created as PENDING REVIEW
```

Because stages 1–5 run before stage 6, the demo leaves the city in a state where
the event timeline, the audit log, the incident list and the violation queue are
all populated. One button, one complete story.

## The simulation clock

The engine steps on a timer while running:

```text
POST /api/simulation/start   → the loop begins
POST /api/simulation/step    → one step, for scripted or manual driving
POST /api/simulation/pause   → the loop stops
POST /api/simulation/reset   → derived state cleared, network kept
```

`resetSimulation()` clears emergency vehicles, incidents, violations, confirmations,
vehicle tracks, and re-seeds the intersections — while leaving the network and
the controllers in place. Reset is "clear the scenario", not "reload the city".

Every engine owns timers, and `dispose()` clears them. This matters in tests:
a suite that creates an engine per case and never disposes it accumulates live
timers, and the symptom is a suite that hangs at exit rather than fails. The
server test harness disposes inside `close()` for this reason.

## Operating modes

The prototype distinguishes data provenance throughout, and the simulation is
where that is most visible:

| Badge | Meaning |
| --- | --- |
| `SIMULATED` | generated by this subsystem |
| `LIVE` | from an actual configured source |
| `ESTIMATED` | derived from observations |
| `UNAVAILABLE` | the source cannot currently provide data |
| `UNCONFIGURED` | no upstream is attached |

Events carry their mode, so scrolling the timeline later — without the badges
that were on screen at the time — still shows which entries were simulated.
Since the demo writes simulated events, the honest case is the visible one.

## Driving the simulation

```bash
# One scenario
curl -X POST http://127.0.0.1:12001/api/simulation/scenario \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"traffic-jam","options":{"pressure":0.95}}'

# The full chain
curl -X POST http://127.0.0.1:12001/api/simulation/demo \
  -H "authorization: Bearer $TOKEN"

# Manual stepping
curl -X POST http://127.0.0.1:12001/api/simulation/step \
  -H "authorization: Bearer $TOKEN"

# List what is available
curl http://127.0.0.1:12001/api/simulation/scenarios
```

Or use Simulation mode: one button per scenario, plus **Run full demo**, with the
stage results shown as they complete.

## Performance

- A scenario steps a bounded number of times (8 × 6 s for a jam) rather than
  looping until convergence. A scenario that ran to a fixed point would block a
  request for an unbounded time.
- Demand is a `Map` keyed by intersection, computed once per scenario.
- The running loop steps at a fixed interval rather than as fast as possible.
- Reset re-seeds rather than recomputing the network, which is the expensive
  part.

## Testing

- `createRandom(seed)` is deterministic across runs.
- `generateDemand` weights by road class and responds to `pressure`.
- `advanceIntersection` queues and discharges according to the signal state.
- The demo completes and reports every stage.
- **Every stage's `ok` is true** — asserted in both the core suite and the e2e
  suite, which is the check that caught the stage-result nesting bug.
- A scenario that could not run reports `ok: false` rather than throwing.
- The demo leaves at least one violation pending review.
- `resetSimulation` clears derived state while keeping the network.
- An unknown scenario id is refused rather than silently succeeding.

## See also

- [TRAFFIC-CONTROL.md](TRAFFIC-CONTROL.md) — the signals the simulation drives
- [EMERGENCY-CORRIDOR.md](EMERGENCY-CORRIDOR.md) — the corridor stages
- [VIOLATIONS.md](VIOLATIONS.md) — the final stage
