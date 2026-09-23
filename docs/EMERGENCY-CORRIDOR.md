# Emergency Corridor

How an emergency vehicle is detected, routed, and given priority through
signalized intersections — safely, in simulation.

## Scope

Everything on this page is **simulated**. There is no dispatch integration, no
siren detection, and no connected emergency-vehicle feed. The routes are
computed over the real modelled road graph; the vehicles and their detections are
generated.

The design goal is that a real feed could be attached without changing the
routing, the corridor planning, or the preemption logic — because those are the
parts worth getting right, and they are independent of where the vehicle came
from.

## Detection is fused, not assumed

The single most dangerous thing this subsystem could do is act on one uncertain
visual detection. So a detection is never a single signal; it is a **weighted
fusion** of whatever evidence exists.

```js
fuseEmergencyDetection({
  lightPattern,   // 0–1, the emergency light pattern
  siren,          // 0–1, siren present
  visual,         // 0–1, visual classification
  operator,       // true, an operator confirmed it
  authorized,     // true, an authorized feed said so
  type,           // 'ambulance' | 'fire-engine' | 'police'
})
```

### Weights

| Signal | Weight | Rationale |
| --- | --- | --- |
| light pattern | 0.35 | the strongest passive indicator; hard to fake |
| siren | 0.30 | strong, but unavailable in many legal/technical setups |
| visual class | 0.20 | weakest; a white van is not an ambulance |
| operator confirmation | 0.40 | a human is more reliable than any of these |

The weights sum where the evidence is strongest rather than being averaged with
zeros, so "no siren data available" does not drag down a confident light-pattern
read into `LOW`.

### Two rules that matter

**An authorized feed short-circuits everything.** If `authorized === true`, the
result is confidence `1`, band `high`, mode `live` — no weighting at all. An
authorized dispatch feed is authoritative, and diluting it with camera guesses
would be strictly worse than trusting it.

**Visual classification alone is capped at MEDIUM.** If the only evidence is a
visual class below 0.7, the reason list says so explicitly:

```text
'reasons': ['visual classification alone — do not use for control']
```

and the band is capped below `high`. This is the guard against the failure mode
where a confident-looking box on a white van green-lights an intersection.

### Confidence bands

| Band | Threshold | What it means |
| --- | --- | --- |
| `high` | ≥ 0.8 | proceed; operator confirmation still shown |
| `medium` | ≥ 0.5 | show, do not act without confirmation |
| `low` | < 0.5 | informational only |

The band, the confidence and the reasons are all returned and all displayed. An
operator sees *why* the system believes there is an ambulance, not just a score.

## Routing

The corridor is computed on the modelled road graph.

```text
buildRoutingGraph(network)      → nodes (intersections) + edges (road segments)
shortestPath(graph, from, to, { congestionWeight })
routeForEmergency(graph, { fromId, toId, congestionWeight })
```

`congestionWeight` lets the emergency route trade distance for time: an ambulance
should take the longer uncongested road over the shorter jammed one, which is the
whole point of having a congestion engine feeding a routing graph.

Relevant constants:

| Constant | Value | Meaning |
| --- | --- | --- |
| `EMERGENCY_TRAVEL_MPS` | 16.7 | ~60 km/h planning speed |
| `APPROACH_NOTICE_M` | 220 m | when an intersection is "upcoming" |
| `ETA_RADAR_S` | 90 s | planning horizon |

Once a route exists, `approachAxesAlongRoute(intersections)` determines, for each
intersection on the path, which **axis** the vehicle will cross on. That axis is
what the preemption request asks for — not a blind "green everywhere", but the
specific direction the vehicle needs.

## The preemption sequence

This is the safety-critical part. An emergency vehicle does **not** get an
instant green. It gets the same safe transition every other phase change gets,
just with the priority axis as the destination:

```text
1. TERMINATE    current green ends
2. AMBER        3 s on the axis that was green
3. ALL-RED      2 s, both axes stopped — the box clears
4. PRIORITY     priority axis green, held for EMERGENCY_HOLD_MS (18 s)
5. HOLD         extended if the vehicle is still approaching
6. RESTORE      priority green → amber → normal adaptive control
```

The UI narrates this rather than hiding it:

```text
EMERGENCY PREEMPTION ACTIVE
Intersection:        INT-002
Reason:              Ambulance approaching
Priority direction:  NORTH
Expected duration:   18 sec

    …then, after the vehicle passes…

RESTORING NORMAL CONTROL
```

### Why no instant green

Instantly switching conflicting real-world lights to green is how people die.
Whatever is already in the intersection — a car completing a turn, a pedestrian
mid-crossing — is killed by a light that changes faster than a human can react.
The 5 seconds of amber-plus-all-red exist so that a driver who saw green has time
to clear.

The same reasoning applies in a simulator. If the safety sequence is not enforced
in the prototype, the prototype is not a prototype of a safe system; and if the
check is removed when hardware is attached, the tests that would have caught it
have already been deleted.

## Preemption state

The controller holds one active preemption at a time:

```js
preemption = {
  axis: 'NS',
  reason: 'Ambulance approaching',
  holdMs: 18000,
  restore: { group: 'EW', phase: 'green', greenMs: 30000 },
}
```

`restore` is captured when the preemption *begins*, so ordinary control resumes
exactly where it left off rather than at some default.

### Nested requests

A second emergency vehicle while a preemption is active:

- updates `preemption.axis` to the new priority direction,
- **keeps the original `restore` target**,
- does not stack holds.

Without that first-write-wins rule on `restore`, two ambulances arriving on
different axes would each overwrite the other's restore target, and the
intersection could be left in permanent priority after both had passed — a bug
that would be very hard to find from the symptom.

### Release

`returnToNormal({ signal })` accepts an observation. A truthy value means the
vehicle is still on the approach, and the release is **refused**:

```js
{ ok: false, reason: 'emergency vehicle still on the approach', signal }
```

That lets the caller hold the intersection until the vehicle has genuinely
cleared rather than releasing on a timer and hoping.

Corridors also carry an `expiresAt`:
`clock() + EMERGENCY_HOLD_MS + EMERGENCY_RELEASE_GRACE_MS`. A corridor whose
vehicle never arrives — because the simulation stopped, or the vehicle was
cleared manually — therefore expires on its own instead of holding a green
forever.

## The corridor on the map

The planned corridor is drawn in a distinct bright blue along the road geometry,
with the upcoming intersections highlighted and the priority axis indicated. The
status vocabulary keeps this meaningful without relying on colour:

```text
BLUE    = emergency vehicle route     (glyph + "EMERGENCY ROUTE" label)
PURPLE  = incident / response operation
```

`corridorLengthM(corridor)` and `corridorPointAt(corridor, fraction)` support the
animated vehicle position along the path, so the operator sees the vehicle move
along the corridor rather than a static line.

## Operator confirmation

Preemption is consequential, so it is not silent:

```text
Operator:  "Give priority to ambulance."
System:    "Emergency vehicle detected at INT-014.
            Activate simulated emergency corridor?"

           [ CONFIRM ]   [ CANCEL ]
```

The confirmation is recorded in the audit trail along with the actor and the
reason. In the demo scenario the confirmation is part of the scripted stage; in
interactive use it is a real prompt.

## Driving it

```bash
# Spawn an ambulance and plan its corridor
curl -X POST http://127.0.0.1:12001/api/emergency/simulate \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"ambulance","toIntersection":"INT-014"}'

# Apply preemption at an intersection
curl -X POST http://127.0.0.1:12001/api/emergency/preempt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"intersectionId":"INT-002","axis":"NS","reason":"ambulance"}'

# Release
curl -X POST http://127.0.0.1:12001/api/emergency/release \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"corridorId":"EMG-0001"}'
```

Or press **SIMULATE AMBULANCE** in Simulation mode, which does all three in
sequence as part of the demonstration.

## What a real integration needs

To make this real rather than simulated, all of these:

1. **An authorized emergency-vehicle feed** — CAD/dispatch integration — so
   `authorized: true` reflects an actual authority rather than a flag someone
   set. This is what upgrades a detection from band `medium` to `high`.
2. **Legal review of siren/audio detection** in the relevant jurisdiction. Its
   availability is jurisdiction-specific, which is why it carries weight but is
   never required.
3. **Real controller adapters**, with the same clearance intervals proven
   equivalent (see [TRAFFIC-CONTROL.md](TRAFFIC-CONTROL.md)).
4. **Explicit human authorization** for preemption, with a named role and an
   audit entry.
5. **A fallback when the preemption fails** — the vehicle must be able to proceed
   safely without priority, which in practice means the intersection defaulting
   to a known state rather than to whatever it was mid-phase.

Until all five exist, this subsystem informs an operator and nothing more.

## Testing

- Fusion produces `high` for an authorized feed regardless of weak camera input.
- Visual-only evidence is capped at `medium` and carries the warning reason.
- A preemption from a conflicting green passes through amber and all-red before
  the priority green — asserted on the phase sequence, not on a timer.
- A nested preemption preserves the original restore target.
- Release is refused while the vehicle is still observed on the approach.
- An expired corridor releases on its own.
- No conflicting greens are produced across a preemption cycle.

## See also

- [TRAFFIC-CONTROL.md](TRAFFIC-CONTROL.md) — the phase machine being driven
- [VISION.md](VISION.md) — where the visual evidence comes from
- [SIMULATION.md](SIMULATION.md) — the ambulance scenario end to end
