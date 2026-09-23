# Signal-HUB

**AI-assisted centralized city traffic intelligence and control platform.**

Signal-HUB puts a city's roads, intersections, signals, cameras, traffic flow,
emergency vehicles, incidents and enforcement workflow into one God's-Eye 3D
command center. It is built on the geospatial foundation of the open-source
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) project: the
Cesium globe, the layer and data-source architecture, and the camera/map
language are upstream, and the traffic-control domain is what this repository
adds.

It runs end to end today, with no city hardware and no API keys, because every
source it cannot reach is simulated *and labelled as simulated* everywhere it
appears.

```text
CITY → ROADS → TRAFFIC → INTERSECTIONS → CAMERAS → COMPUTER VISION
     → VEHICLE DETECTION → TRAFFIC ANALYSIS → SIGNAL OPTIMIZATION
     → EMERGENCY DETECTION → EMERGENCY ROUTE → SIGNAL PREEMPTION
     → VIOLATION DETECTION → EVIDENCE → AUTHORIZED REVIEW
```

## Quick start

Requires **Node 22 or newer**.

```bash
npm install
npm start                 # command API on http://127.0.0.1:12001
```

Open <http://127.0.0.1:12001> and sign in. The server serves the built
frontend, so one command is enough. For frontend development with hot reload:

```bash
npm start                 # terminal 1 — API on :12001
npm run dev               # terminal 2 — Vite on :12000, proxies /api to :12001
```

Then sign in with any demo account (see [Demo accounts](#demo-accounts)).
`control` can drive signals and run the simulation; `enforcement` can review
violations; `admin` can read the audit log.

### Verify it works

```bash
npm test                  # traffic-control core + server API suites
npm run test:e2e          # browser acceptance checks against a running server
npm run build             # production build
npm run verify:map        # proves the 3D globe actually renders, not just mounts
```

## What actually works

Every row below is implemented and covered by a test. The **Mode** column is the
honest provenance of the data the feature works on.

| Capability | Mode | Notes |
| --- | --- | --- |
| 3D city globe with layered overlays | live imagery / simulated data | Cesium; bundled imagery unless `CESIUM_ION_TOKEN` is set |
| Road network from OpenStreetMap | live if reachable, else labelled fallback | Overpass; degrades to a labelled synthetic grid |
| Intersection model with per-approach state | simulated | queue, count, speed, congestion, phase per approach |
| Traffic-flow congestion engine | live (TomTom) or simulated | TomTom when `TOMTOM_API_KEY` is set, otherwise labelled simulated |
| Adaptive signal optimization | simulated | rule-based recommendation with a stated reason |
| Signal phase machine with amber/all-red | simulated | safe ordering enforced by the domain, proven by tests |
| Emergency vehicle detection and fusion | simulated | confidence banded LOW/MEDIUM/HIGH |
| Emergency corridor planning | simulated | route, upcoming intersections, ETA |
| Emergency signal preemption | simulated | safe terminate → amber → all-red → priority → restore |
| Computer-vision detection pipeline | simulated | pluggable detector, tracker, classifier adapters |
| Traffic-violation rule engine | simulated | configurable rules, no law hardcoded in the model |
| License-plate recognition | simulated adapter | refuses to guess; unreadable below the confidence floor |
| Evidence records and review workflow | simulated | every violation opens as `PENDING`, never auto-fined |
| Configurable penalty calculation | configuration | amounts by jurisdiction; labelled "verify against current rules" |
| Incident detection and response | simulated | accident, breakdown, signal failure, camera failure, etc. |
| Signal-controller health monitoring | simulated | faults, heartbeats, operator alerts |
| Live event stream and audit trail | real | every consequential command is recorded with its actor |
| Role-based access control | real | five roles, capability-gated on the server |
| Command center UI, 12 operational modes | real | the map is created once and survives mode changes |
| Scenario simulator | simulated | one button per scenario, each labelled |

**Nothing here controls real traffic signals.** See
[What is simulated vs. real](#what-is-simulated-vs-real).

## Architecture

### The three engines and the control adapter

```text
                    CITY CONTROL CENTER
                     God's-Eye 3D UI
                            |
        +-------------------+-------------------+
        |                   |                   |
        v                   v                   v
  Traffic Engine      Vision Engine      Emergency Engine
  roads, flow         detections         vehicles, routes
  intersections       tracking           preemption
  signal state        violations
        |                   |                   |
        +-------------------+-------------------+
                            |
                            v
                     DECISION ENGINE
              congestion · optimization · incidents · priority
                            |
                            v
                     CONTROL ADAPTER
              simulator (implemented)
              real controller API (interface only)
```

The engine runs **on the server, not in the browser**. That is a deliberate
choice with three consequences: API keys never reach client code, every operator
shares one city rather than a private copy, and the audit trail is written by
the process that actually made the change.

### Repository layout

```text
src/traffic-control/      the domain — no HTTP, no DOM, no Cesium
  policy.js               thresholds, roles, capabilities, data modes
  geometry.js             geodesy: bearings, distances, projections
  network.js              roads → intersections → approaches
  congestion.js           density, queue length, level of service
  signals.js              the phase machine and conflict rules
  cameras.js              camera registry, health, feed types
  emergency.js            detection fusion, routing, preemption
  incidents.js            incident lifecycle and response
  violations.js           rules, evidence, review states
  vision.js               detector/tracker/classifier/ANPR adapters
  simulation.js           demand, scenarios, the demo
  events.js               the event bus and audit log
  engine.js               composition root — wires the above together

server/                   the command API
  index.mjs               process bootstrap, static serving
  api.mjs                 the route table, capability-gated
  auth.mjs                sessions, tokens, production config guard
  roads.mjs               Overpass fetch with labelled fallback
  store.mjs               persistence adapters (memory, file)

src/client/               the command center
  theme.js                the status vocabulary (colour + glyph + word)
  api.js                  the only module that knows a URL
  store.js                state, polling, SSE — the only source of truth
  map.js                  Cesium layers, one data source per layer
  panels.js               every page, as (state, ctx) => Element
  app.js                  the shell
  dom.js  styles.css      small helpers and styling

scripts/                  run-tests, e2e acceptance, map verification
```

The layering is enforced by convention and by tests, not by tooling: the domain
never imports from `server/` or `src/client/`, which is what lets the same
engine be unit-tested with no server and no browser.

## What is simulated vs. real

This is the section to read before believing anything the UI shows.

**Real, in that it is a genuine computation on real inputs:**

- The road geometry, when Overpass is reachable and `SIGNAL_HUB_LIVE_ROADS` is
  not `false`.
- The signal phase machine, its amber/all-red timing, and its conflict rules.
  The simulator is a simulator, but the safety logic inside it is real logic.
- The congestion maths, level of service, and queue estimation, given inputs.
- The violation rule evaluation, evidence construction and review state machine.
- Authentication, role checks, authorization, and the audit trail.
- The ANPR confidence thresholding: a low-confidence read is refused, not
  guessed, and that behaviour is real regardless of which adapter is loaded.

**Simulated, and labelled `simulated` at every point it surfaces:**

- Vehicle counts, speeds, queues and congestion, without a live flow provider.
- All signal states. There is no hardware.
- All emergency vehicles, their routes and their preemptions.
- All computer-vision detections and all plate reads.
- All violations, incidents, and signal/camera faults.

**Requires an API key to become live:**

| Source | Environment variable | Without it |
| --- | --- | --- |
| Traffic flow | `TOMTOM_API_KEY` | `simulated` — clearly labelled |
| Cesium imagery | `CESIUM_ION_TOKEN` | bundled OpenStreetMap imagery |
| Road geometry | none (Overpass is keyless) | labelled synthetic grid on failure |

**Requires authorized integration, and is NOT implemented:**

- Any real traffic-signal controller. `TrafficSignalController` exists as an
  interface with a simulator behind it. Pointing it at hardware is an adapter,
  an authorization decision, and a legal one — not a config flag.
- Authorized ANPR/plate vendor feeds. The adapter seam exists; the vendor does
  not.
- Government enforcement and payment systems. Penalties are *calculated* from
  configuration and displayed with a "verify against current jurisdiction rules"
  warning. The platform never issues a fine.

### Data modes

Every value carries a mode: `live`, `simulated`, `estimated`, `unavailable`, or
`unconfigured`. The UI renders each with a distinct glyph **and** a word, not
just a colour, so a simulated value cannot be mistaken for a live one by someone
who cannot distinguish the colours. `theme.js` makes a missing mode render as
unknown rather than defaulting to live.

## Command center

Twelve modes, reachable from the left rail:

| Mode | What it is for |
| --- | --- |
| Overview | city-wide metrics, congestion corridors, the event stream |
| Live traffic | road-level density and level of service |
| Intersections | the intersection command panel, per-approach detail |
| Signals | signal state, controller health, timing controls |
| CCTV | camera grid, health, feeds or labelled fallbacks |
| Emergency | emergency vehicles, corridors, preemption status |
| Incidents | incident list, severity, recommended response |
| Violations | review queue and evidence |
| Analytics | congestion history and pressure rankings |
| Simulation | scenario buttons and the full demo |
| Signal health | controller heartbeats and faults |
| Data sources | provenance of every input, and what each needs |

The map is created once when the app boots and is not destroyed when you change
mode, so the camera you set stays where you put it.

### Accessibility

Status is never carried by colour alone. Every status value renders as a glyph
(`● ▲ ▼ ✕`) plus a text label plus a colour. Mode badges always spell out
`SIMULATED` / `LIVE` / `ESTIMATED`.

## APIs

All routes are capability-gated. An anonymous caller may read the city; control
and enforcement routes require a session token.

```text
GET  /api/city/status              GET  /api/session
GET  /api/roads                    POST /api/session/login
GET  /api/roads/:id
GET  /api/intersections            GET  /api/cameras
GET  /api/intersections/:id        GET  /api/cameras/health
GET  /api/intersections/:id/signal/recommend   GET /api/cameras/:id
POST /api/intersections/:id/signal/phase       GET /api/cameras/:id/frame
POST /api/intersections/:id/signal/green
POST /api/intersections/:id/signal/cycle       GET  /api/incidents
POST /api/intersections/:id/signal/fault       POST /api/incidents
GET  /api/signals                              POST /api/incidents/:id/clear
GET  /api/signals/health
GET  /api/traffic                  GET  /api/emergency
POST /api/traffic/optimize         GET  /api/emergency/corridors
                                   POST /api/emergency/simulate
GET  /api/violations               POST /api/emergency/preempt
GET  /api/violations/:id           POST /api/emergency/release
POST /api/violations/:id/review
GET  /api/enforcement/rules        GET  /api/simulation
POST /api/enforcement/plate        GET  /api/simulation/scenarios
                                   POST /api/simulation/start
GET  /api/events                   POST /api/simulation/step
GET  /api/audit                    POST /api/simulation/reset
GET  /api/analytics                POST /api/simulation/scenario
GET  /api/data-sources             POST /api/simulation/demo
GET  /api/health
GET  /api/config
```

The event stream is also available as Server-Sent Events at
`GET /api/events/stream`.

## The demonstration scenario

`POST /api/simulation/demo`, or the **Run full demo** button in Simulation mode,
executes the complete chain and reports each stage:

```text
1  traffic-jam      demand concentrates on one corridor;
                    congestion, queues and delay are computed
2  optimize         adaptive engine recommends longer green for the loaded
                    approach, with the reason stated
3  ambulance        an emergency vehicle appears, is fused to HIGH confidence
4  corridor-run     route computed, upcoming intersections detected,
                    preemption applied through amber and all-red, held,
                    then normal adaptive control resumes
5  release          corridor cleared
6  violation        a vehicle crosses the stop line on red; evidence captured;
                    plate read attempted; event opened as PENDING REVIEW
```

Every stage result is returned, and the whole run appears in the event timeline
and the audit log.

### Triggering one thing at a time

Simulation mode exposes a button per scenario: traffic jam, peak hour, red-light
violation, ambulance, fire engine, accident, signal failure, camera failure, and
the emergency corridor.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_PORT` | `12001` | command API port |
| `API_HOST` | `0.0.0.0` | bind address |
| `SIGNAL_HUB_AREA` | `chennai` | area preset (`chennai`, `grid`, …) |
| `SIGNAL_HUB_LIVE_ROADS` | `true` | fetch real roads from Overpass |
| `SIGNAL_HUB_SEED` | `7` | simulation seed — same seed, same city |
| `SIGNAL_HUB_MAX_INTERSECTIONS` | `60` | cap on the modelled network |
| `SIGNAL_HUB_SERVE_STATIC` | `true` | serve the built frontend from this process |
| `SIGNAL_HUB_AUTOSTART` | `false` | start the simulation on boot |
| `SIGNAL_HUB_STORE` | `memory` | `memory` or `file` |
| `SIGNAL_HUB_DATA_DIR` | — | required for the `file` store |
| `SIGNAL_HUB_SESSION_SECRET` | random | token signing secret; set in any real deployment |
| `SIGNAL_HUB_ENV` | — | set to `production` to enforce the production config guard |
| `TOMTOM_API_KEY` | — | live traffic flow |
| `CESIUM_ION_TOKEN` | — | Cesium ion imagery |
| `OVERPASS_URL` | public endpoint | alternate Overpass instance |

The server refuses to start under `SIGNAL_HUB_ENV=production` if demo credentials
or a missing session secret would follow it into production.

## Demo accounts

Prototype credentials, for local demonstration only:

| Handle | Password | Role | Can |
| --- | --- | --- | --- |
| `viewer` | `viewer` | City Viewer | read the city and traffic |
| `operator` | `operator` | Shift Operator | + run simulation, read violations (plate hidden) |
| `control` | `control` | Traffic Controller | + control signals, preempt for emergency |
| `enforcement` | `enforcement` | Enforcement Reviewer | + read plates, review violations |
| `admin` | `admin` | Administrator | + read the audit log |

The capability matrix is the single source of truth in
`src/traffic-control/policy.js`, and the server gates on it. It is not a UI
convention that could be bypassed by calling the API directly — there is a test
that proves a viewer is refused every control route.

## Security and privacy

- **No secrets in client code.** All provider keys are read server-side; the
  browser only ever sees `/api/*` on its own origin.
- **Authorization is server-side.** The UI hides what you cannot do, but hiding
  is cosmetic — the route table refuses regardless.
- **Every consequential action is audited** with its actor, role, reason and
  before/after state.
- **Plate data is capability-gated** and stripped from the violation list for
  any caller without the plate capability. It is never rendered on the map.
- **No automatic enforcement.** Violations always open as `PENDING`, and the
  platform reports `automatedEnforcement: false`. Nothing fines anyone.
- **No face recognition, no person tracking, no named-person search.** Of the
  things the platform deliberately does not do, these are the ones that would
  matter most if they crept in.
- **Evidence retention is bounded** by a configurable window, and open cases are
  never purged.

See [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

Stated plainly, because a prototype that oversells itself is worse than one that
does less:

1. **No real signal control.** The simulator is not connected to hardware and
   there is no code path that could be, without writing an adapter.
2. **No real computer vision.** The detector and plate reader are deterministic
   simulations. They exercise the *pipeline*, not a model. Swapping in a real
   model means implementing one adapter interface.
3. **No real ANPR.** No vendor integration, no test imagery, no plate database.
4. **The file store is append-only JSONL**, not a database. The entity model is
   shaped for PostgreSQL/PostGIS, but that port is not done.
5. **The `postgres` store is not implemented** — asking for it falls back to
   memory and says so, rather than pretending.
6. **Single-city, single-process.** No multi-tenancy, no horizontal scaling, no
   shared state between instances.
7. **Demo credentials are hardcoded** for local use, and the production guard
   exists to stop them travelling.
8. **Emergency detection is simulated-only.** Real-world preemption needs
   authorized vehicle metadata and operator confirmation, which no prototype
   should invent.
9. **No voice control yet.** The architecture leaves room for it; no speech
   pipeline is wired.

## Documentation

| Document | Covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | module boundaries, data flow, why the engine is server-side |
| [docs/TRAFFIC-CONTROL.md](docs/TRAFFIC-CONTROL.md) | the signal controller interface and phase machine |
| [docs/EMERGENCY-CORRIDOR.md](docs/EMERGENCY-CORRIDOR.md) | detection fusion, routing, safe preemption |
| [docs/VISION.md](docs/VISION.md) | detector/tracker/ANPR adapter interfaces |
| [docs/VIOLATIONS.md](docs/VIOLATIONS.md) | rules, evidence, plate confidence, review workflow |
| [docs/SIMULATION.md](docs/SIMULATION.md) | scenarios, the demo, the determinism guarantee |
| [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) | every input, its mode, and what it needs |
| [docs/SECURITY.md](docs/SECURITY.md) | roles, capabilities, secrets, retention, privacy |

## Development principles

- Reuse the upstream God's Eye View foundation rather than replacing it.
- Do not remove working upstream behaviour.
- Keep live and simulated data separated, and label both.
- Put real-world integrations behind explicit adapter interfaces.
- Never fabricate live traffic or enforcement data.
- Never invent unreadable plate characters.
- Never silently execute a consequential control action.
- Require human review before anything resembling an enforcement outcome.
- Keep every consequential command in the audit trail.
- Stay modular enough that real hardware can be attached later.

## References

- God's Eye View: <https://github.com/bilawalsidhu/gods-eye-view>
- Signal-HUB: <https://github.com/tamilarasan-1912/Signal-HUB>

## License

MIT.
