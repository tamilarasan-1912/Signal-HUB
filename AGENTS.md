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

**Working prototype.** The traffic-control domain, the command API and the
command-center frontend are all implemented, tested and runnable:

```bash
npm install
npm start          # API + built frontend on http://127.0.0.1:12001
npm test           # core + server suites
npm run test:e2e   # browser acceptance run against a running server
```

The frontend dev server (`npm run dev`, port 12000) proxies `/api` to the API
process. There are two test layers beyond the unit suites:

- `scripts/e2e.mjs` — puppeteer acceptance over the real app in a real browser.
  Cesium needs software rendering under headless Chrome (`--use-angle=swiftshader`).
- `scripts/verify-map.mjs` — reads back the composited map to prove the globe
  actually renders. The e2e suite only proves the canvas *mounted*; this proves
  pixels. Note that WebGL `readPixels` returns an empty buffer because Cesium does
  not set `preserveDrawingBuffer`, so the screenshot is the honest source.

## Layout beyond the domain

| Path | Responsibility |
| --- | --- |
| `src/traffic-control/` | the domain — no HTTP, no DOM, no Cesium |
| `server/` | the command API: routing, capability gating, sessions, stores |
| `src/client/` | the command center: theme, api, store, map, panels, app |
| `scripts/` | test runner, e2e acceptance, map verification |
| `docs/` | architecture and subsystem documentation |

## Module layout

`src/traffic-control/` is the traffic-control domain core. It is deliberately
**dependency-free** — every file imports only its siblings and, for tests, Node
built-ins. That means it can be moved between the standalone Signal-HUB repo and
the God's Eye View checkout without dragging a build config along.

The layering is one-directional and worth preserving: the domain never imports
from `server/` or `src/client/`. That is what lets the same engine be unit-tested
with no server and no browser.

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
   must never be presented as live. The client renders a mode as a glyph, a word
   *and* a colour via `theme.js#modeToken()`, and an unrecognised mode degrades to
   `UNKNOWN` rather than defaulting to `LIVE`.
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
- Test reproduce real bug findings. Four currently-guarded behaviours came from
  failing tests rather than review: the tracker counting a newly-created track as
  a miss, the plate reader drifting between reads of the same track, the plate
  reader's flat jitter subtraction (a perfect-quality frame could still fall below
  the readability floor, so readability depended on luck rather than on frame
  quality), and the API passing `decision`/`reviewer` to an engine expecting
  `status`/`role` — which returned `400` to every reviewer and made the whole
  review workflow unreachable over HTTP even though the domain was fine. That
  last one is why `server/api.test.mjs` drives the review path end to end: a unit
  test on the engine alone would not have caught it.

## API-layer gotchas

Two mistakes were made once each and are worth not repeating:

- **Do not spread an array into an object.** List endpoints must return
  `{ violations: [...] }`, not `{ ...list }`, or the numeric keys become the
  response. The bug is invisible until a client reads `.violations`.
- **Do not let a scenario's own `ok` decide a stage's `ok`.** `runFullDemo`
  records each stage as `{ stage, ok, label, ...observations }` via an explicit
  `record()` call, and `ok` is derived from what the stage observed. Spreading a
  scenario result into the stage lets the result's `ok` overwrite the stage's,
  so a failed stage reports success.
- **Report what a stage measured, not what it hoped.** The `corridor-run` stage
  of the demo requests preemption from the ambulance's actual proximity to each
  upcoming intersection and counts the requests the engine accepted. An earlier
  version advanced the vehicle and then printed the preemption count anyway,
  which was always 0 while the label claimed the corridor had been preempted; it
  now reports `ok: false` if nothing was preempted. `simulation.test.mjs` covers
  the demo for this reason — nothing else did.
- **Keep `DEMO_SCENARIO` ids equal to the stage keys.** The API returns the plan
  and the stage report together, so a caller matches them by id. A `scenario:
  null` entry marks a stage driven by an engine method rather than a runnable
  scenario, and a test asserts every non-null `scenario` names a real one.

## Conventions

- Plain ES modules, no build step required for this module.
- Frozen records everywhere; state changes go through `engine.updateIntersection`.
- Injectable `clock` and `scheduler` so tests are deterministic.
- Comments explain *why* (an invariant, a trade-off, a safety rule), never what
  the next line does.
