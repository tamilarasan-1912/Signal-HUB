# Traffic Control

The signal model, the controller interface, and the safety rules that keep it
from producing a crash.

## What this is, and what it is not

Signal-HUB models and simulates traffic signals. It does **not** control any
hardware, and there is no code path that could without writing an adapter and
making an authorization decision.

The distinction that matters is this: the simulator is a simulator, but the
**phase machine inside it is real logic**. The ordering rules, the clearance
intervals and the conflict checks are the same rules a real controller must
obey. Getting them right in the simulator is what makes an eventual hardware
adapter a transport change rather than a redesign.

Every controller reports its own nature, so nothing downstream has to guess:

```js
describeController(controller)
// {
//   intersectionId: 'INT-002',
//   kind: 'simulator',
//   authorized: false,
//   label: 'SIMULATED — built-in signal simulator (no hardware attached)'
// }
```

`authorized: false` is the field the UI and the API check. A controller that
claimed `authorized: true` without an actual authorized integration would be
lying, and the field exists so that lie would be visible.

## The signal model

An intersection has two axes, `NS` and `EW`, each with a cardinal approach:

```text
           NORTH
             │
  WEST ──── INT-002 ──── EAST
             │
           SOUTH

  NS group: NORTH, SOUTH
  EW group: EAST,  WEST
```

An approach can hold one of these states:

| State | Meaning |
| --- | --- |
| `green` | proceed |
| `amber` | prepare to stop |
| `red` | stop |
| `all-red` | stop, both axes — the clearance interval |
| `fault` | controller unhealthy; the intersection reads all-red |

`approachStatesFor(group, phase)` derives the four approach states from the
group and phase, and `validateApproachStates(states)` asserts the invariant that
**two conflicting axes are never both green**. That function is the
conflict-prevention check, and it is called by the controller on every commit.

## The phase sequence

This is the whole state machine, and the ordering is not configurable:

```text
        ┌──────────────────────────────────────────┐
        │                                          │
        ▼                                          │
   NS GREEN ──(greenMs)──▶ NS AMBER ──(3s)──▶ NS ALL-RED ──(2s)──┐
        ▲                                                          │
        │                                                          ▼
   EW ALL-RED ◀──(2s)── EW AMBER ◀──(3s)── EW GREEN ◀────(greenMs)
```

Read it as: a green must be followed by its own amber, an amber by an all-red,
and an all-red by the *other* axis's green. The all-red hop is the safety
interval — the moment during which nothing is moving and the box clears. Skipping
it is what produces a real intersection collision, so it is a constant in
`policy.js`, not a tunable:

| Constant | Value | Why |
| --- | --- | --- |
| `AMBER_MS` | 3000 | the standard warning interval |
| `ALL_RED_MS` | 2000 | the clearance interval; never skipped |
| `MIN_GREEN_MS` | 8000 | below this a green starves pedestrians and cross traffic |
| `MAX_GREEN_MS` | 75000 | above this the other approach starves |
| `EMERGENCY_HOLD_MS` | 18000 | default priority hold |
| `EMERGENCY_RELEASE_GRACE_MS` | 4000 | grace before a stale preemption expires |
| `HEARTBEAT_TIMEOUT_MS` | 15000 | silence after which a controller is `DEGRADED` |

## The controller interface

`createSimulatedSignalController({ intersectionId, clock, scheduler })` returns a
controller. This is the interface a real adapter must implement.

### `getSignalState() → object`

The current signal group. Never null — a controller that could return null here
would force every caller to guard, and the guard would be forgotten once.

```js
{ intersectionId, group: 'NS', phase: 'green', greenMs: 30000, startedAt, … }
```

### `setPhase({ group, phase, greenMs }) → { ok, reason, signal, pending? }`

Set the active phase. **The safety rule lives here.** A request that would green
a conflicting axis does not take effect directly. Instead:

- **Same axis**: applied directly. No clearance is needed, because no conflicting
  movement is affected.
- **Crossing axis, target green**: refused as a direct jump. The controller
  commits amber on the currently green axis and returns a `pending` queue:

  ```js
  {
    ok: true,
    reason: 'queued behind amber and all-red clearance',
    signal: { group: 'NS', phase: 'amber' },
    pending: [
      { group: 'NS', phase: 'all-red', ms: 2000 },
      { group: 'EW', phase: 'green',   ms: 30000 },
    ],
  }
  ```

  The caller gets `ok: true` because the request was *accepted* — it is just
  being routed the safe way. The `reason` says so, and the `pending` array lets
  the UI narrate the steps rather than showing a frozen signal.

- **Crossing axis, non-green target** (e.g. going straight to red): applied, as
  it can only ever remove a permission.

A faulty controller refuses every one of these with
`{ ok: false, reason: 'controller in fault' }`.

### `extendGreen(ms)` / `shortenGreen(ms) → { ok, reason, signal }`

Adjust the current green. Both clamp to `[MIN_GREEN_MS, MAX_GREEN_MS]` — an
optimizer cannot starve an approach by asking for a 90-second green, and cannot
create a two-second one that traps vehicles mid-crossing. Both require the
controller to currently be in green, and both recompute the pending transition
from the *elapsed* time so the phase ends at the new boundary rather than the old
one plus the delta.

### `setCycle({ cycleMs }) → { ok, reason, signal }`

Replace the whole cycle. Both greens get half the cycle **minus the clearance
intervals the controller will spend transitioning**:

```js
const perAxis = (cycleMs - 2 * (AMBER_MS + ALL_RED_MS)) / 2;
```

Subtracting the clearance is the part that is easy to get wrong. A 90-second
cycle does not give two 45-second greens; it gives two greens that, with the four
clearance intervals, actually total 90 seconds.

### `setEmergencyPriority({ axis, reason, holdMs }) → { ok, reason, signal, pending }`

Begin a preemption. See [EMERGENCY-CORRIDOR.md](EMERGENCY-CORRIDOR.md) for the
full sequence — the short version is that it takes the **identical safe route**:
terminate the current green, amber, all-red, *then* priority green.

Two behaviours worth calling out:

- **Nested preemptions do not nest the restore.** A second request while one is
  active updates the priority axis but keeps the *original* restore target. Two
  ambulances on different axes therefore cannot strand the intersection in
  permanent priority.
- **If the priority axis is already green**, the hold is simply committed with no
  clearance, because there is nothing to clear.

### `returnToNormal({ signal }) → { ok, reason, signal }`

End the preemption. If the caller passes a truthy `signal` observation (meaning
"the vehicle is still on the approach"), the release is refused and the priority
hold continues. If the priority axis is currently green, the restore goes through
amber first rather than snapping to the other axis.

### `getHealth() → object`

```js
{
  status: 'OK' | 'DEGRADED' | 'PREEMPTED' | 'FAULT',
  fault: string | null,
  lastHeartbeat: number,
  msSinceHeartbeat: number,
  transitions: number,     // monotonic; useful for proving movement
  preempted: boolean,
}
```

`DEGRADED` is derived from heartbeat age rather than set explicitly, so a
controller that stops responding becomes visibly unhealthy without anything
having to notice and report it.

### `heartbeat()`, `setFault(reason)`, `clearFault()`, `dispose()`

`setFault` shows all-red and refuses control commands — a faulty intersection
must not keep cycling as if nothing were wrong. Nothing self-heals; an operator
clears the fault. `dispose()` clears the controller's timers.

## Adaptive optimization

`getRecommendation()` in the congestion/optimization path examines an
intersection and returns a recommendation with a stated reason:

```text
CURRENT:    North/South GREEN = 30 seconds
OPTIMIZED:  North/South GREEN = 50 seconds
REASON:     High queue detected on North approach.
```

The inputs are vehicle count, queue length, average speed, congestion, waiting
time, road priority, downstream congestion, intersection saturation, emergency
vehicles present, and active incidents. The output is a *recommendation object*,
not a mutation:

```js
{
  intersectionId,
  axis,                  // which axis to favour
  currentGreenMs,
  recommendedGreenMs,
  reason,                // human-readable, always present
  inputs: { … },         // what it saw
  mode: 'simulated',
}
```

## Three operating modes

The prototype distinguishes three levels of authority, and the distinction is
enforced rather than described:

| Mode | Behaviour |
| --- | --- |
| **RECOMMENDATION** | The engine computes and returns a recommendation. Nothing changes. |
| **SIMULATION** | The recommendation is applied to the simulator when the operator asks. This is the mode the demo runs in. |
| **AUTHORIZED CONTROL** | Not implemented. It would require a real controller adapter plus an authorization decision, and the platform does not pretend otherwise. |

`POST /api/traffic/optimize` with `{ apply: false }` is recommendation mode;
`{ apply: true }` applies to the simulator. Requiring the caller to pass `apply`
explicitly is deliberately not a default: a default of `true` would mean an
errant call mutates the city, and a default of `false` would make the demo
button lie about what it did.

Nothing silently executes. There is no code path in which a recommendation
becomes a control action without either an explicit `apply` or an operator
clicking a button that says so.

## Health monitoring and failure

A controller's health is polled, not assumed:

- `OK` — recent heartbeat, no fault, not preempted.
- `DEGRADED` — no heartbeat within `HEARTBEAT_TIMEOUT_MS`.
- `PREEMPTED` — an emergency preemption is active.
- `FAULT` — explicitly faulted; the intersection shows all-red.

`GET /api/signals/health` returns every controller's health together with a
fault summary. Faults raise an operator alert and highlight the intersection on
the map. `SIMULATE SIGNAL FAILURE` in Simulation mode drives a real controller
into a real fault, so the health path is exercised rather than mocked.

## Testing the safety properties

The signal suite proves the invariants rather than sampling them:

- **Ordering.** Every transition follows green → amber → all-red → other green.
  Driven with a manual scheduler so the test fires the timers explicitly rather
  than sleeping through real ones.
- **No conflicting greens.** `validateApproachStates` is asserted across a long
  run of transitions, and the e2e suite re-checks it against the live server over
  12 samples.
- **Clamping.** `extendGreen` cannot exceed `MAX_GREEN_MS`; `shortenGreen` cannot
  go below `MIN_GREEN_MS`.
- **Cycle arithmetic.** A requested cycle length yields greens that, with the
  clearance intervals, sum to the requested cycle.
- **Preemption is safe.** A preemption triggered from a conflicting green still
  passes through amber and all-red, and a nested preemption does not strand the
  intersection.
- **Faults refuse control**, and `clearFault` restores cycling.

## Attaching real hardware

To connect a real controller:

1. Implement the interface above over the controller's actual protocol.
2. Keep the phase ordering and clearance intervals. They are the safety property.
   If the hardware enforces its own, prove equivalence rather than removing the
   check.
3. Return `{ authorized: true, kind: 'hardware', label: '…' }` from
   `describeController` **only** once the integration is genuinely authorized.
4. Add a capability for hardware control separate from `signals:control`, so
   simulation authority does not imply hardware authority.
5. Require explicit operator confirmation for every preemption, and audit it.

Until all five are done, the platform is a simulator, and the UI says so.

## See also

- [EMERGENCY-CORRIDOR.md](EMERGENCY-CORRIDOR.md) — preemption in full
- [SIMULATION.md](SIMULATION.md) — the scenarios that drive this machinery
- [ARCHITECTURE.md](ARCHITECTURE.md) — where the controller sits
