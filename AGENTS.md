# AGENTS.md — Signal-HUB

Repository-specific context for AI agents and contributors.

## What this repo is

Signal-HUB is a centralized city traffic intelligence and control platform, built
on top of the open-source God's Eye View project
(https://github.com/bilawalsidhu/gods-eye-view).

God's Eye View supplies the geospatial foundation: Cesium 3D visualization, road
and traffic flow layers, CCTV source architecture, ALPR-camera infrastructure
visualization, layer-based data architecture, and server-side provider patterns.
Signal-HUB adds the traffic-control plane on top of it.

## Repository status

**Early development / architecture phase.** As of this writing the upstream God's
Eye View checkout is maintained separately; the `src/traffic-control/` module in
this repository is the first piece landed here and is self-contained.

## Module layout

`src/traffic-control/` is the traffic-control domain core. It is deliberately
**dependency-free** — every file imports only its siblings and, for tests, Node
built-ins. That means it can be moved between the standalone Signal-HUB repo and
the God's Eye View checkout without dragging a build config along.

| File | Responsibility |
| --- | --- |
| `policy.js` | Shared constants, data modes, operating modes, roles, status vocabulary |
| `geometry.js` | Geodesy: distance, bearing, polyline projection, bounding boxes, IoU |
| `signals.js` | Signal-controller abstraction + safe simulator (amber → all-red → green) |
| `network.js` | Normalized roads and intersections built from Overpass road geometry |
| `congestion.js` | Congestion scoring, queue estimation, delay/LOS, green-split optimizer |
| `cameras.js` | Camera registry, health, and binding to intersection approaches |
| `emergency.js` | Emergency detection fusion, routing, corridors, preemption |
| `vision.js` | Detector/tracker/plate-reader adapters (vehicle detection only) |
| `violations.js` | Configurable rule engine, evidence packages, review queue, penalties |
| `incidents.js` | Incident catalogue, recommended responses, fault detectors |
| `events.js` | Live event stream, audit log, operator-confirmation gate |
| `simulation.js` | Deterministic scenario engine and demand model |
| `engine.js` | Composition root — the single owner of platform state |
| `fixtures.mjs` | Shared test fixtures (grid roads, virtual clock) |

## Invariants that must not regress

These encode the project's rules. Several are enforced in code rather than merely
documented, and there are tests that fail if the enforcement is removed.

1. **No conflicting green, ever.** A phase transition always passes through amber
   and then all-red. `advance()` in `signals.js` has no path from one green to a
   conflicting green, and `validateApproachStates()` is asserted against every
   state the controller can produce. `ALL_RED_MS` is not configurable to zero.
2. **Data provenance is mandatory.** Every fact carries a mode from `DATA_MODES`
   (`live`/`simulated`/`estimated`/`unavailable`/`unconfigured`). Simulated data
   must never be presented as live. See `isMeasured()`.
3. **No real-world control.** `OPERATING_MODES.authorizedControl` is refused by
   `resolveOperatingMode()` unless an authorized controller integration is
   configured, which it is not. The UI cannot select it.
4. **A single uncertain visual detection cannot trigger control.**
   `fuseEmergencyDetection()` caps a visual-only call below HIGH; a detection
   classified `emergency` without a light-pattern or siren signal is downgraded to
   an ordinary vehicle.
5. **No automatic enforcement.** `AUTOMATED_ENFORCEMENT_ENABLED` is `false` and
   the violation engine has no branch that issues a finding without a reviewer.
   Every violation lands in `pending`.
6. **Never invent plate characters.** `plateResultFromCharacters()` substitutes
   `?` below the per-character floor and returns `PLATE UNREADABLE` with a null
   text below the overall floor. It does not guess or pad.
7. **Consequential commands are audited.** `engine.*` writes an audit entry with
   the caller's role for anything that changes controller behaviour.
8. **No person-level processing.** `vision.js` detects vehicles only. There is no
   face detector, gait or appearance descriptor, and the tracker stores a bounding
   box and a class — never a re-identifying signature.

## Testing

Tests live beside the modules as `*.test.mjs` and run on the Node test runner:

```bash
node --test src/traffic-control/*.test.mjs
```

- `fixtures.mjs` (not `.test.mjs`) holds shared fixtures. The upstream unit-test
  runner discovers every `src/**/*.test.mjs`, so a fixture stored in a test file
  would be re-executed — and re-registered as tests — by each importer.
- `createVirtualClock()` exists because a signal controller built with real
  `setTimeout` keeps the event loop alive for its whole green interval, which
  makes any network-building test hang ~30s after it has already passed.
- Test reproduce real bug findings. Two currently-guarded behaviours came from
  failing tests rather than review: the tracker counting a newly-created track as
  a miss, and the plate reader drifting between reads of the same track.

## Conventions

- Plain ES modules, no build step required for this module.
- Frozen records everywhere; state changes go through `engine.updateIntersection`.
- Injectable `clock` and `scheduler` so tests are deterministic.
- Comments explain *why* (an invariant, a trade-off, a safety rule), never what
  the next line does.
