# Architecture

How Signal-HUB is put together, and why the pieces are where they are.

## The one decision everything else follows from

**The traffic-control engine runs on the server, not in the browser.**

Three consequences fall out of that, and each one is the reason for a whole
layer of the design:

1. **Provider keys stay server-side.** A Cesium ion token or a TomTom key is
   read in `server/index.mjs` and never serialized into a response. The browser
   only ever talks to `/api/*` on its own origin, so there is no code path by
   which a key could reach a client bundle.
2. **Every operator shares one city.** Two browsers looking at Signal-HUB see
   the same signal states, the same incidents, the same preemption. A preemption
   one operator triggers is visible to the others within a poll cycle.
3. **The audit trail is written by the process that made the change.** An audit
   entry cannot be forged, dropped or reordered by a client, because the client
   never writes one.

The cost is that the frontend cannot work without the API. That is the correct
trade for an operations tool: a command center that each operator privately
re-imagines is not a command center.

## Layers

```text
┌──────────────────────────────────────────────────────────────┐
│  src/client/        presentation                             │
│    theme · api · store · map · panels · app                  │
│    knows DOM, Cesium, fetch — and nothing about traffic laws │
├──────────────────────────────────────────────────────────────┤
│  server/            transport and authorization              │
│    index · api · auth · roads · store                        │
│    knows HTTP, sessions, capabilities — not traffic physics  │
├──────────────────────────────────────────────────────────────┤
│  src/traffic-control/   the domain                           │
│    pure modules over plain data                              │
│    knows traffic — and nothing about HTTP, DOM or Cesium     │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point **downward only**. `src/traffic-control/` has no import of
anything in `server/` or `src/client/`; if it did, the domain could no longer be
unit-tested without a server and a browser, which is exactly what the 125 core
tests do.

The engine is the composition root for the domain: `engine.js` constructs the
sub-engines, loads the road network, seeds the intersections and wires the event
bus. Everything else in `src/traffic-control/` is a factory that receives what it
needs.

## Data flow

### Reading the city

```text
Overpass (or fallback)
      │ roads: raw OSM ways
      ▼
network.js        buildNetwork()  ──▶  roads, intersections, approaches
      │
      ▼
engine.loadNetwork()
      │ seeds one signal controller per intersection
      │ seeds four synthetic cameras per intersection (one per approach),
      │   with real configured cameras taking precedence
      ▼
   ENGINE STATE ──────────────▶ api.mjs ──▶ JSON ──▶ store.js ──▶ panels.js
        │                                                              │
        │ events                                                       │
        ▼                                                              ▼
    events.js  ──▶ SSE /api/events/stream ───────────────────────▶ timeline
```

### Changing the city

Every mutation follows the same path, and that uniformity is what makes the
audit trail complete rather than patchy:

```text
operator clicks
      ▼
panels.js ──▶ api.js ──▶ POST /api/…
                              ▼
                         api.mjs: capability check
                              ▼
                         engine.<method>()
                              ▼
                    domain validates, applies, or refuses
                              ▼
                    events.publish() ──▶ event bus
                              │              │
                              │              ├──▶ audit log
                              │              ├──▶ SSE subscribers
                              │              └──▶ store mirror
                              ▼
                    returns {ok, reason, …} ──▶ UI shows the real outcome
```

The important property is that **a refused action is a value, not an exception**.
`{ ok: false, reason: 'queued behind amber and all-red clearance' }` is a normal
return. The UI can therefore tell the operator precisely what the system decided
instead of showing a generic error, and the domain never has to throw to signal a
policy decision.

## Module inventory

### `src/traffic-control/` — the domain

| Module | Responsibility | Notably not its job |
| --- | --- | --- |
| `policy.js` | every threshold, role, capability and data mode; the single source of truth for numbers | applying any of them |
| `geometry.js` | bearings, haversine distance, interpolation, projections | knowing what a road is |
| `network.js` | OSM ways → roads → intersections → cardinal approaches | fetching OSM |
| `congestion.js` | density, queue estimation, level of service, delay | reading sensors |
| `signals.js` | the phase machine, conflict rules, the controller interface | being connected to hardware |
| `cameras.js` | camera registry, health, feed type, snapshot fallback | decoding video |
| `emergency.js` | detection fusion, routing graph, corridor planning, preemption | driving a siren |
| `incidents.js` | incident lifecycle, severity, recommended response | dispatching anyone |
| `violations.js` | configurable rules, evidence, review states, penalties | issuing a fine |
| `vision.js` | detector/tracker/classifier/ANPR adapter registries | running a neural network |
| `simulation.js` | demand generation, scenarios, the demo | pretending to be live |
| `events.js` | the event bus and the audit log | persisting to disk |
| `engine.js` | composition root; owns state, exposes the API surface | HTTP |

### `server/` — transport

| Module | Responsibility |
| --- | --- |
| `index.mjs` | process bootstrap, config from env, static file serving, production guard |
| `api.mjs` | the route table; capability gating; body limits; rate limiting; SSE |
| `auth.mjs` | session authority, signed tokens, demo accounts, production config assertions |
| `roads.mjs` | Overpass fetch with a labelled fallback, area presets |
| `store.mjs` | memory and file stores; mirrors engine records |

### `src/client/` — presentation

| Module | Responsibility |
| --- | --- |
| `theme.js` | the status vocabulary: every status is a glyph + word + colour; `modeToken()` |
| `api.js` | the only module that constructs a URL or attaches a token |
| `store.js` | all application state; polling and SSE; the only source of truth |
| `map.js` | Cesium viewer and one `CustomDataSource` per layer |
| `panels.js` | every page as a pure `(state, ctx) => Element` function |
| `app.js` | the shell, the mode router, confirmation handling |
| `dom.js` | small element helpers |
| `styles.css` | dark command-center styling |

## Why these boundaries

### The domain holds no references to the outside

`signals.js` does not call `setTimeout` directly. It takes a `scheduler`:

```js
createSimulatedSignalController({
  scheduler: { setTimer, clearTimer },   // injected
})
```

That one seam is what lets the signal tests drive a phase transition
deterministically with a manual scheduler instead of sleeping and hoping. A test
that waits for a real 3-second amber is a test that fails on a loaded CI box.

The same pattern repeats: `clock`, `random`, `emit` and `audit` are all injected.
The default in production is the real thing; the default in a test is a virtual
one.

### Adapters, not conditionals

The places where real hardware or a real model would attach are all the same
shape — a registry the engine holds:

```js
detectors.register({ id, label, mode, detect })
trackers.register(...)
classifiers.register(...)
plateReaders.register({ id, label, mode, read })
```

The current adapter is a simulation. Adding a real one is one `register` call and
no change to any consumer, because consumers ask the registry and never the
adapter by name. This is what "modular so real hardware can be attached later"
means concretely, rather than as an aspiration.

### One route table

`api.mjs` holds a flat array of `{ method, pattern, capability, handler }`. There
is no framework and no middleware chain, for a reason: the entire authorization
surface is then one readable list, and a reviewer can confirm that every mutating
route names a capability by reading one file top to bottom. A route cannot
accidentally skip authorization without visibly omitting the field, and there is
a test per role asserting the refusals.

## State and lifetime

```text
createTrafficControlEngine({ seed, maxIntersections })
  ├── events, audit           long-lived
  ├── network, intersections  replaced by loadNetwork()
  ├── controllers             one per intersection
  ├── cameras                 one registry, seeded per intersection
  ├── detectors/trackers/plateReaders   registries
  └── dispose()               clears every timer the engine owns
```

`dispose()` matters more than it looks. The controllers schedule timers and the
simulation loop schedules a tick; a process that creates an engine per test and
never disposes it accumulates live timers, and the symptom is a test suite that
hangs at exit rather than fails. The server test harness disposes inside its
`close()` for exactly this reason.

`resetSimulation()` is the operator-facing equivalent: it clears the derived
state (emergency vehicles, incidents, violations, confirmations) and re-seeds the
intersections, while leaving the network and the controllers in place.

## The event bus

One bus, several consumers:

```text
events.publish({ category, type, severity, message, mode, detail })
   ├── ring buffer        → GET /api/events        → the timeline
   ├── audit log          → GET /api/audit          → the durable record
   ├── SSE subscribers    → GET /api/events/stream  → live push
   └── store mirror       → SIGNAL_HUB_DATA_DIR     → JSONL on disk
```

Because the timeline and the audit log read the same bus, they cannot disagree.
A separate "audit write" call at each mutation site would drift the moment one
site forgot it; subscribing to the bus means a new event type is audited by
existing rather than by remembering.

`mode` travels with every event. An event that came from the simulator says so,
which is what keeps the timeline honest when a reader scrolls back through it
later without the badges they were looking at.

## Performance strategy

City scale means thousands of potential entities and a globe that must stay
interactive. The approach is inherited from God's Eye View's LOD philosophy:

- **One `CustomDataSource` per layer** (roads, intersections, cameras,
  emergency, incidents, violations, corridor). Toggling a layer is a visibility
  flip rather than a rebuild.
- **Capped entity counts.** Each layer's list is sliced to a bound before
  rendering. A city with 400 intersections renders a bounded number of them at
  low zoom rather than 400 expensive primitives.
- **Distance display conditions.** Labels and detail appear only within a
  distance threshold, so a city-wide view is not a wall of text.
- **Poll interval, not per-entity subscriptions.** One `/api/state`-style poll
  refreshes everything on a timer, rather than one request per object.
- **SSE for the event stream**, because it is append-only and cheap to push.
- **Debounced viewport handling.** A camera move schedules a single update rather
  than one per mouse event.

None of this renders a vehicle-per-vehicle city at maximum detail, which is the
honest answer: the prototype shows congestion at road and intersection
granularity, and vehicles exist as detections inside the vision pipeline rather
than as 5000 globe entities.

## What is deliberately absent

- **No ORM and no migrations.** Two store adapters behind one interface. The
  entity model is normalized and documented so the PostgreSQL/PostGIS port is a
  driver, not a redesign.
- **No web framework.** `node:http` and a route table, so the whole HTTP surface
  is inspectable.
- **No build step for the server.** `node server/index.mjs` runs the source
  directly; Vite is only for the client.
- **No client-side router.** Modes are state, not URLs. The map is created once
  and persists across mode changes, which a route-based teardown would fight.

## Extending it

**Add a scenario.** Add a function to the `scenarios` object in
`simulation.js` and an entry to `SCENARIO_META`; the UI button and the API
endpoint appear from the metadata.

**Add a data provider.** Implement `{ id, label, mode, detect }` and
`detectors.register(...)`. `mode` is required, because a provider that cannot
state its own provenance cannot be rendered honestly.

**Attach a real signal controller.** Implement the controller interface from
[docs/TRAFFIC-CONTROL.md](TRAFFIC-CONTROL.md) — `getSignalState`, `setPhase`,
`extendGreen`, `shortenGreen`, `setCycle`, `setEmergencyPriority`,
`returnToNormal`, `getHealth` — and return it from the engine's controller
factory. Keep the phase-machine invariants; they are the safety property, not
decoration.

**Add a route.** Add an entry to the table in `api.mjs`. If it mutates anything,
it names a capability; if it is consequential, it audits.

## See also

- [TRAFFIC-CONTROL.md](TRAFFIC-CONTROL.md) — the controller interface in detail
- [EMERGENCY-CORRIDOR.md](EMERGENCY-CORRIDOR.md) — the safe preemption sequence
- [DATA-SOURCES.md](DATA-SOURCES.md) — provenance of every input
- [SECURITY.md](SECURITY.md) — capabilities, secrets, retention
