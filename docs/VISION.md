# Vision

The computer-vision pipeline: detection, tracking, plate reading, and the
adapter seams a real model would attach to.

## Scope, stated honestly first

**There is no neural network in this repository.** The detector, the tracker and
the plate reader are deterministic simulations. They exercise the *pipeline* —
frame in, detections out, tracks over time, plate confidence, violation
evidence — with results that are reproducible and testable.

What is real is the architecture: the interfaces, the confidence handling, the
thresholding, the refusal to guess, and the way a low-confidence result is
propagated instead of being rounded up to a plausible answer. Swapping in a real
model is implementing one adapter interface; nothing that consumes detections
changes.

The pipeline shape:

```text
Camera frame
     │
     ▼
Detector          → bounding boxes + class + confidence
     │
     ▼
Tracker           → stable track IDs across frames
     │
     ▼
Event analyzer    → what the tracks mean (queue, violation, emergency)
     │
     ▼
Traffic engine    → counts, density, level of service
```

## Detection

### The detection record

`normalizeDetection(raw, { cameraId, at })` turns adapter output into the shape
everything else consumes:

```js
{
  detectionId,
  cameraId,
  bbox: { x, y, w, h },      // normalized 0–1, so it is resolution-independent
  vehicleClass,              // 'car' | 'bus' | 'truck' | 'motorcycle' | 'emergency' | …
  confidence,                // 0–1
  at,                        // timestamp
  trackId,                   // assigned by the tracker
  lightPattern,              // 0–1, for emergency fusion
  siren,                     // 0–1, for emergency fusion
  mode,                      // 'simulated' | 'live' | …
}
```

Boxes are normalized to the frame rather than expressed in pixels. A detection
from a 1920×1080 camera and one from a 640×480 camera then mean the same thing,
and the geometry code never has to know the resolution.

`DETECTION_MIN_CONFIDENCE` is 0.5: below that a detection is dropped rather than
carried forward to be filtered later. Dropping at the edge is cheaper and makes
"why is this count 40 and not 47" answerable at one place.

### The detector registry

```js
createDetectorRegistry()
  .register({ id, label, mode, detect })   // add an adapter
  .select(id)                              // choose one
  .current()                               // what is running
  .list()                                  // for the data-sources page
```

`createSimulatedDetector({ seed, maxPerFrame })` is the built-in adapter. It is
deterministic in `seed` — the same frame gives the same detections — which is
what makes the demo replayable and the tests stable.

A real adapter implements the same three fields plus `detect(frame)`. `mode` is
**required**: a provider that cannot state its own provenance cannot be rendered
honestly, so the registry enforces that instead of hoping.

## Tracking

`createVehicleTracker({ clock })` maintains short-lived scene tracks.

| Constant | Value | Meaning |
| --- | --- | --- |
| `TRACK_IOU_THRESHOLD` | 0.3 | IoU above which two boxes are the same vehicle |
| `TRACK_TTL_MS` | 2500 | how long a track survives without a matching detection |

The tracker matches by IoU, so a vehicle moving between frames keeps its
`trackId`. This is what makes a violation attributable to *a vehicle* rather than
to a detection: the stop-line crossing and the plate read must refer to the same
track, or the evidence does not hold together.

Tracks are deliberately short-lived and in-memory. This is scene tracking for a
violation window, **not** vehicle re-identification across the city. There is no
persistent vehicle identity, and that is a privacy property rather than a
limitation — see [SECURITY.md](SECURITY.md).

`TRACK_TTL_MS` of 2.5 s is short for a reason: a vehicle that leaves the frame
and returns is a new track, so the platform cannot accumulate a movement history
for a vehicle across cameras.

## The pipeline call

```js
await runDetectionPipeline({ detector, tracker, frame })
// → { detections, tracked, census }
```

`census` is what the traffic engine consumes:

```js
{ total, byClass: { car, bus, truck, motorcycle, emergency }, meanConfidence }
```

One call runs the whole chain. The caller supplies the frame; the pipeline does
not reach for a camera, which is what keeps it testable without a video source.

## Emergency vehicle detection

Detection does **not** decide that something is an ambulance. The visual class is
a hint, and `emergencyCandidates(detections)` pulls out the detections worth
fusing — those whose class is `emergency`, or that carry a light pattern or a
siren signal.

The decision is made by `fuseEmergencyDetection`, which weighs multiple signals
and bands the result. A visual classification alone is capped below `high` and
carries an explicit warning reason. Full detail in
[EMERGENCY-CORRIDOR.md](EMERGENCY-CORRIDOR.md) — the short version is that no
single uncertain visual read can trigger a control action.

## Plate recognition

### The two-stage result

A plate read produces characters *and* a verdict. The crucial design decision is
that **an unreadable plate is a value, not an error**:

```js
plateResultFromCharacters({ characters, confidence, region, jurisdiction, … })
// {
//   plate: 'TN1076' | null,          // null when not readable
//   display: 'TN1076' | 'PLATE UNREADABLE',
//   confidence,                       // overall, 0–1
//   charMean,                         // mean of the confident characters
//   unknownCount,                     // how many characters fell below the floor
//   readable: boolean,
//   characters: [{ char, confidence }],
//   …
// }
```

### The thresholds

| Constant | Value | Meaning |
| --- | --- | --- |
| `PLATE_MIN_CONFIDENCE` | 0.9 | overall confidence required to be readable |
| `PLATE_MIN_CHAR_CONFIDENCE` | 0.85 | per-character floor |

Both must be satisfied. Per-character matters because an overall 0.92 average can
easily hide one character at 0.3 — and a plate with one guessed character is a
plate that identifies the wrong vehicle.

### Never invent a character

This is the rule the implementation is built around:

```js
if (charConfidence >= PLATE_MIN_CHAR_CONFIDENCE) {
  masked.push(char);           // confident: keep it
} else {
  masked.push('?');            // below the floor: mark it unknown, DO NOT NAME IT
}
```

A below-floor character becomes `?`, never a best guess. And `readable` requires
`unknownCount === 0`, so a single `?` makes the whole result unreadable:

```js
const readable =
  masked.length > 0 &&
  overall >= PLATE_MIN_CONFIDENCE &&
  unknownCount === 0;
```

The consequence is that a partial read reports `PLATE UNREADABLE` rather than a
suggestive string. `TN1?76` is not shown to an operator, because an operator
reads it as `TN1076` and the platform has now invented the character that decides
whose vehicle this is.

This is enforced by tests at both levels and by the e2e acceptance run, which
asserts that a degraded frame returns `null` text and the unreadable marker.

### The reader registry

```js
createPlateReader({ seed })
  .register({ id, label, mode, read })
  .select(id)
  .current()
  .list()
  .read(input)
```

The built-in `simulated-anpr` adapter derives plates deterministically from the
track ID, so the same vehicle reads the same plate every time. That
determinism is deliberate: a reader that drifted between calls would make a demo
unreplayable and a test flaky.

Frame quality drives confidence, and the jitter scales with the frame's
*unreliability* rather than being a flat subtraction:

```js
confidence = clamp(quality - jitter * 0.2 * (1 - quality), 0, 1)
```

A flat subtraction was the original implementation, and it had a real bug: at
quality 1.0 a jitter of 0.1 would push a perfect frame to 0.9 and below the
0.9 floor, so a clean frame could be reported unreadable. Frame quality should
decide readability; luck should not.

Observed behaviour:

| Quality | Confidence | Verdict |
| --- | --- | --- |
| 1.00 | 1.000 | reads |
| 0.99 | 0.989 | reads |
| 0.97 | 0.966 | reads |
| 0.95 | 0.944 | reads |
| 0.90 | 0.888 | unreadable |
| 0.50 | 0.439 | unreadable, all characters `?` |
| 0.20 | 0.102 | unreadable, all characters `?` |

### The API

```bash
curl -X POST http://127.0.0.1:12001/api/enforcement/plate \
  -H "authorization: Bearer $ENFORCEMENT_TOKEN" -H 'content-type: application/json' \
  -d '{"trackId":"TRK-TEST-0001","quality":0.97}'
```

```json
{
  "plate": "TN1076",
  "display": "TN1076",
  "text": "TN1076",
  "confidence": 0.966,
  "unreadable": false,
  "characters": [{ "char": "T", "confidence": 0.967 }, …],
  "mode": "simulated",
  "adapter": { "id": "simulated-anpr", "label": "Built-in simulated ANPR (test plates only)" }
}
```

`quality` is validated and clamped. A non-numeric value does not become `NaN`
and leak into a confidence; it becomes 0.

## Frames and fallbacks

Camera media is modelled but **not played**. The server exposes the two media
routes and the client renders an explicit, labelled placeholder for each state
rather than embedding a player:

| State | What the panel shows |
| --- | --- |
| `simulated` | a placeholder stating the feed is simulated and generated by the vision adapter, never an optical view |
| configured, feed present | a placeholder stating that playback requires the camera-provider integration described in [DATA-SOURCES.md](DATA-SOURCES.md) |
| `offline` / `degraded` | an explicit fallback with the reason, and the last-known timestamp |
| `unconfigured` | "no upstream configured" — distinct from a camera that is down |

`hls.js` is a dependency and the adapter seam (`mediaUrl`, `feedType`) exists, so
attaching a real player is wiring a `<video>` element to `mediaUrl`. It is not
done, and the panel says so instead of showing a blank box. A blank panel is
worse than a labelled one: an operator cannot tell "no signal" from "nothing is
happening".

`cameras.js` tracks per-camera health (`ok`, `degraded`, `unconfigured`), and
`GET /api/cameras/health` reports the aggregate. A camera with no upstream URL is
reported as `unconfigured` rather than broken, because those are different
problems with different fixes. `SIMULATE CAMERA FAILURE` drives a real camera
into a real degraded state so the health path is exercised.

## Performance

- Detections are produced per frame on demand, not continuously.
- The tracker holds only what is in `TRACK_TTL_MS`; there is no unbounded growth.
- Frames are not stored. A violation keeps a *reference* to its evidence frame,
  not the frame's bytes, so the record stays small.
- Camera health is polled on the same interval as everything else rather than
  per-camera.

## Privacy boundaries

These are design constraints, not defaults that happen to hold:

- **No face recognition.** No face model is loaded, and no adapter interface
  accepts a face.
- **No person tracking.** `vehicleClass` has no person category.
- **No named-person search.** There is no entity a name could be attached to.
- **Plate data is capability-gated.** It is stripped from the violation API for
  any caller without the plate capability, and it is never rendered on the map.
- **Tracks are short-lived.** 2.5 seconds of scene tracking, no cross-camera
  identity.

## What a real integration needs

1. **A detector adapter** returning `{ bbox, vehicleClass, confidence }` per
   object. `mode` becomes `live`.
2. **Legal review** of camera use in the jurisdiction, and a lawful basis for any
   plate processing.
3. **Synchronized timestamps** between camera and intersection, because a
   red-light violation is a claim about signal state *at the moment of crossing*
   and unsynchronized clocks make the claim unfalsifiable.
4. **Media retention policy** and a storage implementation, with the retention
   window enforced — the code already bounds `retainUntil`.
5. **An ANPR vendor integration** behind `plateReaders.register(...)`.

## Testing

- `normalizeDetection` handles malformed input without throwing.
- The simulated detector is deterministic in its seed.
- The tracker assigns stable IDs by IoU and expires tracks after `TRACK_TTL_MS`.
- `plateResultFromCharacters` returns unreadable for a low overall confidence,
  for an empty read, and for malformed characters.
- A below-floor character becomes `?` and makes the whole plate unreadable.
- The simulated reader is deterministic per track, and a poor frame is strictly
  less confident than a clean one.
- The API returns unreadable rather than guessed characters for a degraded frame.
- The registry refuses an adapter without an `id` or a `read` function.

## See also

- [EMERGENCY-CORRIDOR.md](EMERGENCY-CORRIDOR.md) — how detections fuse into a banded call
- [VIOLATIONS.md](VIOLATIONS.md) — how a detection becomes evidence
- [DATA-SOURCES.md](DATA-SOURCES.md) — the mode of every stage
