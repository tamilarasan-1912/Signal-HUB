import test from 'node:test';
import assert from 'node:assert/strict';

import { DETECTION_MIN_CONFIDENCE, PLATE_MIN_CONFIDENCE, DATA_MODES } from './policy.js';
import { createVirtualClock } from './fixtures.mjs';
import {
  createDetectorRegistry,
  createPlateReader,
  createSimulatedDetector,
  createVehicleTracker,
  detectionCensus,
  emergencyCandidates,
  normalizeDetection,
  plateResultFromCharacters,
  runDetectionPipeline,
} from './vision.js';

test('normalizeDetection validates a box and drops anything below the confidence floor', () => {
  const kept = normalizeDetection({
    box: [10, 20, 30, 40],
    vehicleClass: 'car',
    confidence: 0.8,
  }, { cameraId: 'CAM-1', at: 1000 });
  assert.ok(kept);
  assert.deepEqual(kept.box, [10, 20, 30, 40]);
  assert.equal(kept.vehicleClass, 'car');
  assert.equal(kept.cameraId, 'CAM-1');
  assert.equal(kept.at, 1000);

  assert.equal(
    normalizeDetection({ box: [0, 0, 10, 10], confidence: DETECTION_MIN_CONFIDENCE - 0.01 }),
    null,
    'a sub-threshold detection must be dropped',
  );
  assert.equal(normalizeDetection({ box: [0, 0, 0, 10], confidence: 0.9 }), null);
  assert.equal(normalizeDetection({ box: [0, 0, 10], confidence: 0.9 }), null);
  assert.equal(normalizeDetection({ box: null, confidence: 0.9 }), null);
  assert.equal(normalizeDetection(null), null);
});

test('normalizeDetection refuses to promote a vehicle to emergency without a light or siren signal', () => {
  // A classifier saying "emergency" on its own is downgraded to an ordinary
  // vehicle. This is the "no single uncertain visual detection" rule.
  const bare = normalizeDetection({
    box: [0, 0, 10, 10],
    vehicleClass: 'emergency',
    confidence: 0.95,
  });
  assert.equal(bare.vehicleClass, 'car');

  const withLight = normalizeDetection({
    box: [0, 0, 10, 10],
    vehicleClass: 'emergency',
    confidence: 0.95,
    lightPattern: 0.9,
  });
  assert.equal(withLight.vehicleClass, 'emergency');
});

test('normalizeDetection coerces an unknown class to a car rather than inventing one', () => {
  const detection = normalizeDetection({
    box: [0, 0, 10, 10],
    vehicleClass: 'tank',
    confidence: 0.9,
  });
  assert.equal(detection.vehicleClass, 'car');
});

test('the detector registry selects an adapter and lists its mode', () => {
  const registry = createDetectorRegistry();
  assert.equal(registry.size, 0);
  assert.equal(registry.current(), null);
  registry.register(createSimulatedDetector({ seed: 1 }));
  assert.equal(registry.current().id, 'simulated');
  assert.equal(registry.current().mode, DATA_MODES.simulated);
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].mode, DATA_MODES.simulated);
  assert.throws(
    () => registry.register({ id: 'bad', detect: 'not a function' }),
    /needs an id and a detect function/,
  );
  assert.throws(() => registry.select('nope'), /Unknown detector/);
});

test('the simulated detector is deterministic for a seed and varies across seeds', () => {
  const a = createSimulatedDetector({ seed: 7 });
  const b = createSimulatedDetector({ seed: 7 });
  const c = createSimulatedDetector({ seed: 8 });
  const first = a.detect({ trafficIntensity: 1, at: 1 });
  const second = b.detect({ trafficIntensity: 1, at: 1 });
  const other = c.detect({ trafficIntensity: 1, at: 1 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
  assert.ok(first.length > 0);
  for (const detection of first) {
    assert.equal(detection.mode, DATA_MODES.simulated);
    assert.ok(detection.confidence >= DETECTION_MIN_CONFIDENCE);
  }
});

test('the simulated detector scales its output with scene busyness', () => {
  const quiet = createSimulatedDetector({ seed: 3 }).detect({ trafficIntensity: 0.1 });
  const busy = createSimulatedDetector({ seed: 3 }).detect({ trafficIntensity: 1 });
  assert.ok(busy.length >= quiet.length, `${busy.length} vs ${quiet.length}`);
  assert.equal(createSimulatedDetector({ seed: 3 }).detect({ trafficIntensity: 0 }).length, 0);
});

test('the tracker gives a moving vehicle a stable ID across frames', () => {
  const virtual = createVirtualClock();
  const tracker = createVehicleTracker({ clock: virtual.clock });
  const first = tracker.update([
    { box: [100, 100, 50, 50], vehicleClass: 'car', confidence: 0.9 },
  ]);
  assert.equal(first.length, 1);
  const trackId = first[0].trackId;
  // The same vehicle, nudged a few pixels — high overlap, same track.
  const second = tracker.update([
    { box: [108, 100, 50, 50], vehicleClass: 'car', confidence: 0.9 },
  ]);
  assert.equal(second.length, 1);
  assert.equal(second[0].trackId, trackId);
  assert.equal(second[0].ageFrames, 2);
  assert.equal(tracker.size, 1);
});

test('the tracker starts a new track for a vehicle that does not overlap', () => {
  const virtual = createVirtualClock();
  const tracker = createVehicleTracker({ clock: virtual.clock });
  tracker.update([{ box: [0, 0, 40, 40], vehicleClass: 'car', confidence: 0.9 }]);
  const moved = tracker.update([{ box: [600, 400, 40, 40], vehicleClass: 'car', confidence: 0.9 }]);
  assert.equal(moved.length, 1);
  assert.equal(tracker.size, 2, 'a non-overlapping detection is a new vehicle');
});

test('the tracker ages a vanished track out after its TTL', () => {
  const virtual = createVirtualClock();
  const tracker = createVehicleTracker({ clock: virtual.clock });
  tracker.update([{ box: [0, 0, 40, 40], vehicleClass: 'car', confidence: 0.9 }]);
  assert.equal(tracker.size, 1);
  virtual.advance(3000);
  tracker.update([]);
  assert.equal(tracker.size, 0);
});

test('the tracker counts misses before removing a track', () => {
  const virtual = createVirtualClock();
  const tracker = createVehicleTracker({ clock: virtual.clock });
  const created = tracker.update([{ box: [0, 0, 40, 40], vehicleClass: 'car', confidence: 0.9 }]);
  const trackId = created[0].trackId;
  tracker.update([]);
  assert.equal(tracker.get(trackId).misses, 1);
  assert.equal(tracker.get(trackId).ageFrames, 1);
});

test('the tracker exposes its update count and can be cleared', () => {
  const virtual = createVirtualClock();
  const tracker = createVehicleTracker({ clock: virtual.clock });
  tracker.update([]);
  tracker.update([]);
  assert.equal(tracker.updateCount, 2);
  tracker.update([{ box: [0, 0, 40, 40], vehicleClass: 'car', confidence: 0.9 }]);
  tracker.clear();
  assert.equal(tracker.size, 0);
});

test('plateResultFromCharacters reads a clean plate', () => {
  const result = plateResultFromCharacters({
    characters: [
      { char: 'T', confidence: 0.99 },
      { char: 'N', confidence: 0.98 },
      { char: '0', confidence: 0.97 },
      { char: '9', confidence: 0.96 },
    ],
    cameraId: 'CAM-1',
  });
  assert.equal(result.readable, true);
  assert.equal(result.plate, 'TN09');
  assert.equal(result.display, 'TN09');
  assert.equal(result.unknownCount, 0);
});

test('plateResultFromCharacters never invents a character it cannot read', () => {
  const result = plateResultFromCharacters({
    characters: [
      { char: 'T', confidence: 0.99 },
      { char: 'N', confidence: 0.3 },
      { char: '0', confidence: 0.97 },
    ],
  });
  // The low-confidence character is marked unknown, not guessed.
  assert.equal(result.characters[1].char, '?');
  assert.equal(result.unknownCount, 1);
  assert.equal(result.readable, false);
  assert.equal(result.plate, null);
  assert.equal(result.display, 'PLATE UNREADABLE');
});

test('a plate whose overall confidence is below the floor is rejected even if characters read', () => {
  const result = plateResultFromCharacters({
    characters: [
      { char: 'T', confidence: 0.99 },
      { char: 'N', confidence: 0.99 },
    ],
    confidence: PLATE_MIN_CONFIDENCE - 0.05,
  });
  assert.equal(result.readable, false);
  assert.equal(result.plate, null);
  assert.equal(result.display, 'PLATE UNREADABLE');
});

test('plateResultFromCharacters handles an empty and a malformed reading', () => {
  const empty = plateResultFromCharacters({});
  assert.equal(empty.readable, false);
  assert.equal(empty.display, 'PLATE UNREADABLE');
  assert.equal(empty.confidence, 0);

  const junk = plateResultFromCharacters({ characters: [null, { char: 5 }, undefined] });
  assert.equal(junk.readable, false);
});

test('the simulated plate reader is deterministic per track and degrades with frame quality', () => {
  const reader = createPlateReader({ seed: 11 });
  const good = reader.read({ trackId: 'TRK-00001', quality: 0.99 });
  const goodAgain = reader.read({ trackId: 'TRK-00001', quality: 0.99 });
  assert.deepEqual(good, goodAgain);
  const poor = reader.read({ trackId: 'TRK-00001', quality: 0.3 });
  assert.ok(poor.confidence < good.confidence, `${poor.confidence} vs ${good.confidence}`);
  assert.equal(poor.mode, DATA_MODES.simulated);
});

test('the plate reader registry refuses an invalid adapter and an unknown selection', () => {
  const reader = createPlateReader();
  assert.throws(() => reader.register({ id: 'x' }), /needs an id and a read function/);
  assert.throws(() => reader.select('nope'), /Unknown plate reader/);
  assert.equal(reader.current().mode, DATA_MODES.simulated);
});

test('emergencyCandidates pulls out only the detections worth fusing', () => {
  const candidates = emergencyCandidates([
    { vehicleClass: 'car', lightPattern: null, siren: null },
    { vehicleClass: 'emergency', lightPattern: null, siren: null },
    { vehicleClass: 'car', lightPattern: 0.8, siren: null },
    { vehicleClass: 'bus', lightPattern: null, siren: 0.7 },
  ]);
  assert.equal(candidates.length, 3);
});

test('detectionCensus counts every class and averages confidence', () => {
  const census = detectionCensus([
    { vehicleClass: 'car', confidence: 0.8 },
    { vehicleClass: 'car', confidence: 1 },
    { vehicleClass: 'bus', confidence: 0.6 },
    { vehicleClass: 'truck', confidence: 0.9 },
  ]);
  assert.equal(census.total, 4);
  assert.equal(census.byClass.car, 2);
  assert.equal(census.byClass.bus, 1);
  assert.equal(census.byClass.truck, 1);
  assert.equal(census.byClass.motorcycle, 0);
  assert.ok(Math.abs(census.meanConfidence - 0.825) < 1e-9);
});

test('runDetectionPipeline goes detector → tracker and returns a census', async () => {
  const virtual = createVirtualClock();
  const result = await runDetectionPipeline({
    detector: createSimulatedDetector({ seed: 5 }),
    tracker: createVehicleTracker({ clock: virtual.clock }),
    frame: { cameraId: 'CAM-1', width: 1280, height: 720, at: 1000, trafficIntensity: 0.8 },
  });
  assert.ok(result.detections.length > 0);
  assert.equal(result.tracked.length, result.detections.length);
  assert.equal(result.census.total, result.detections.length);
  for (const detection of result.detections) assert.equal(detection.cameraId, 'CAM-1');
});

test('runDetectionPipeline requires a detector and a tracker', async () => {
  await assert.rejects(
    () => runDetectionPipeline({ tracker: createVehicleTracker() }),
    /A detector is required/,
  );
  await assert.rejects(
    () => runDetectionPipeline({ detector: createSimulatedDetector() }),
    /A tracker is required/,
  );
});

test('runDetectionPipeline awaits an asynchronous detector adapter', async () => {
  const virtual = createVirtualClock();
  const asyncDetector = {
    id: 'async',
    mode: DATA_MODES.simulated,
    async detect() {
      return [{ box: [1, 2, 30, 30], vehicleClass: 'car', confidence: 0.9 }];
    },
  };
  const result = await runDetectionPipeline({
    detector: asyncDetector,
    tracker: createVehicleTracker({ clock: virtual.clock }),
    frame: { cameraId: 'CAM-9' },
  });
  assert.equal(result.detections.length, 1);
  assert.equal(result.detections[0].cameraId, 'CAM-9');
});
