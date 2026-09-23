import test from 'node:test';
import assert from 'node:assert/strict';

import { DATA_MODES } from './policy.js';
import {
  bucketForLevel,
  buildRoadNetwork,
  clusterIntersections,
  createIntersection,
  deriveCongestion,
  freeFlowMps,
  intersectionsInBounds,
  linkRoad,
  normalizeRoad,
  roadsInBounds,
  withRoadState,
} from './network.js';
import { gridRoads } from './fixtures.mjs';

test('normalizeRoad derives lanes, free-flow speed and length, and refuses junk', () => {
  const road = normalizeRoad({
    coordinates: [
      [80.2, 13.08],
      [80.21, 13.08],
    ],
    type: 'primary',
    oneway: -1,
  }, { id: 'RD-1' });
  assert.ok(road);
  assert.equal(road.id, 'RD-1');
  assert.equal(road.roadClass, 'primary');
  assert.equal(road.lanes, 2);
  assert.equal(road.freeFlowMps, 14);
  assert.equal(road.freeFlowMode, DATA_MODES.estimated);
  assert.equal(road.oneway, -1);
  assert.ok(road.lengthM > 1000);

  assert.equal(normalizeRoad(null), null);
  assert.equal(normalizeRoad({ coordinates: [[80.2, 13.08]] }), null);
  assert.equal(normalizeRoad({ coordinates: [] }), null);
});

test('normalizeRoad honours an explicit lane count over the class default', () => {
  const road = normalizeRoad({
    coordinates: [
      [80.2, 13.08],
      [80.21, 13.08],
    ],
    type: 'motorway',
    lanes: 5,
  });
  assert.equal(road.lanes, 5);
  // An implausible count is clamped rather than trusted.
  assert.equal(
    normalizeRoad({
      coordinates: [
        [80.2, 13.08],
        [80.21, 13.08],
      ],
      type: 'motorway',
      lanes: 99,
    }).lanes,
    8,
  );
});

test('freeFlowMps falls back for an unknown class', () => {
  assert.equal(freeFlowMps('primary'), 14);
  assert.equal(freeFlowMps('cycleway'), 13.9);
  assert.equal(freeFlowMps(undefined), 13.9);
});

test('deriveCongestion prefers a provider level and labels it LIVE', () => {
  const road = normalizeRoad({
    coordinates: [
      [80.2, 13.08],
      [80.21, 13.08],
    ],
    type: 'primary',
  });
  const provider = deriveCongestion(road, 5, 0.3);
  assert.equal(provider.level, 0.3);
  assert.equal(provider.bucket, 'jam');
  assert.equal(provider.mode, DATA_MODES.live);
});

test('deriveCongestion derives from speed as an ESTIMATE when no provider level exists', () => {
  const road = normalizeRoad({
    coordinates: [
      [80.2, 13.08],
      [80.21, 13.08],
    ],
    type: 'primary',
  });
  const derived = deriveCongestion(road, 10);
  assert.equal(derived.level, 10 / 14);
  assert.equal(derived.bucket, 'slow');
  assert.equal(derived.mode, DATA_MODES.estimated);
  const absent = deriveCongestion(road, null);
  assert.equal(absent.level, null);
  assert.equal(absent.mode, DATA_MODES.unavailable);
});

test('bucketForLevel classifies at the documented boundaries', () => {
  assert.equal(bucketForLevel(1), 'free');
  assert.equal(bucketForLevel(0.85), 'free');
  assert.equal(bucketForLevel(0.84), 'slow');
  assert.equal(bucketForLevel(0.55), 'slow');
  assert.equal(bucketForLevel(0.54), 'jam');
  assert.equal(bucketForLevel(null), 'free');
});

test('withRoadState returns a new record and never mutates the input', () => {
  const road = normalizeRoad({
    coordinates: [
      [80.2, 13.08],
      [80.21, 13.08],
    ],
    type: 'primary',
  });
  const updated = withRoadState(road, {
    speedMps: 3,
    vehicleCount: 120,
    queueM: 80,
    mode: DATA_MODES.simulated,
  });
  assert.notEqual(updated, road);
  assert.equal(road.vehicleCount, 0, 'the original must be untouched');
  assert.equal(road.queueM, 0);
  assert.equal(updated.queueM, 80);
  assert.equal(updated.vehicleCount, 120);
  assert.equal(updated.congestion, 'jam');
  assert.ok(updated.densityVpkpl > 0);
  assert.equal(Object.isFrozen(updated), true);
});

test('linkRoad records intersections, cameras and keeps the signalized subset', () => {
  const road = normalizeRoad({
    coordinates: [
      [80.2, 13.08],
      [80.21, 13.08],
    ],
    type: 'primary',
  });
  const linked = linkRoad(road, {
    intersectionIds: ['INT-1', 'INT-2', 'INT-1'],
    signalizedIds: new Set(['INT-1', 'INT-2']),
    cameraIds: ['CAM-1', 'CAM-1'],
  });
  assert.deepEqual(linked.intersectionIds, ['INT-1', 'INT-2']);
  assert.deepEqual(linked.signalizedIntersectionIds, ['INT-1', 'INT-2']);
  assert.deepEqual(linked.cameraIds, ['CAM-1']);
});

test('clusterIntersections finds the four-way junctions of a grid', () => {
  const normalized = gridRoads().map((raw, index) =>
    normalizeRoad(raw, { id: `RD-${index}` }),
  );
  const clusters = clusterIntersections(normalized);
  // A 4×4 grid has 16 crossings, each meeting exactly two roads.
  assert.equal(clusters.length, 16, `got ${clusters.length}`);
  for (const cluster of clusters) assert.equal(cluster.roadIds.length, 2);
});

test('clusterIntersections does not split a junction that straddles a grid-cell edge', () => {
  // Two roads crossing at a coordinate that lands exactly on a 1e-3 cell edge.
  const lon = 80.2;
  const lat = 13.08;
  const a = normalizeRoad(
    {
      coordinates: [
        [lon - 0.001, lat],
        [lon, lat],
        [lon + 0.001, lat],
      ],
      type: 'primary',
    },
    { id: 'RD-A' },
  );
  const b = normalizeRoad(
    {
      coordinates: [
        [lon, lat - 0.001],
        [lon, lat],
        [lon, lat + 0.001],
      ],
      type: 'secondary',
    },
    { id: 'RD-B' },
  );
  const clusters = clusterIntersections([a, b]);
  const crossing = clusters.filter((cluster) => cluster.roadIds.length === 2);
  assert.equal(crossing.length, 1, `expected one junction, got ${clusters.length}`);
});

test('clusterIntersections requires the documented minimum of roads', () => {
  const single = normalizeRoad(
    {
      coordinates: [
        [80.2, 13.08],
        [80.21, 13.08],
      ],
      type: 'primary',
    },
    { id: 'RD-ONLY' },
  );
  assert.equal(clusterIntersections([single]).length, 0);
});

test('createIntersection assigns each meeting road to a cardinal approach', () => {
  const eastWest = normalizeRoad(
    {
      coordinates: [
        [80.19, 13.08],
        [80.2, 13.08],
        [80.21, 13.08],
      ],
      type: 'primary',
    },
    { id: 'RD-EW' },
  );
  const northSouth = normalizeRoad(
    {
      coordinates: [
        [80.2, 13.07],
        [80.2, 13.08],
        [80.2, 13.09],
      ],
      type: 'secondary',
    },
    { id: 'RD-NS' },
  );
  const intersection = createIntersection({
    id: 'INT-1',
    lon: 80.2,
    lat: 13.08,
    roads: [eastWest, northSouth],
  });
  // The east–west road occupies the E and W approaches; the north–south road
  // occupies N and S.
  assert.equal(intersection.approaches.E.roadId, 'RD-EW');
  assert.equal(intersection.approaches.W.roadId, 'RD-EW');
  assert.equal(intersection.approaches.N.roadId, 'RD-NS');
  assert.equal(intersection.approaches.S.roadId, 'RD-NS');
  assert.equal(intersection.approaches.N.axis, 'NS');
  assert.equal(intersection.approaches.E.axis, 'EW');
});

test('createIntersection binds a camera to the approach it observes', () => {
  const eastWest = normalizeRoad(
    {
      coordinates: [
        [80.19, 13.08],
        [80.2, 13.08],
        [80.21, 13.08],
      ],
      type: 'primary',
    },
    { id: 'RD-EW' },
  );
  const northSouth = normalizeRoad(
    {
      coordinates: [
        [80.2, 13.07],
        [80.2, 13.08],
        [80.2, 13.09],
      ],
      type: 'secondary',
    },
    { id: 'RD-NS' },
  );
  const intersection = createIntersection({
    id: 'INT-1',
    lon: 80.2,
    lat: 13.08,
    roads: [eastWest, northSouth],
    cameras: [
      { id: 'CAM-N', lon: 80.2, lat: 13.081 },
      { id: 'CAM-E', lon: 80.201, lat: 13.08 },
    ],
  });
  assert.equal(intersection.approaches.N.cameraId, 'CAM-N');
  assert.equal(intersection.approaches.E.cameraId, 'CAM-E');
  assert.deepEqual([...intersection.cameraIds].sort(), ['CAM-E', 'CAM-N']);
});

test('createIntersection refuses a missing id or non-finite coordinates', () => {
  assert.throws(() => createIntersection({ id: '', lon: 80, lat: 13 }), /requires an id/);
  assert.throws(() => createIntersection({ id: 'INT-1', lon: NaN, lat: 13 }), /finite coordinates/);
});

test('buildRoadNetwork links every road to the junctions it touches', () => {
  const network = buildRoadNetwork(gridRoads());
  assert.equal(network.intersections.length, 16);
  assert.equal(network.roads.length, 8);
  assert.ok(network.bounds);
  for (const road of network.roads) {
    // Every road in this grid spans four junctions.
    assert.equal(road.intersectionIds.length, 4, `${road.id} touches ${road.intersectionIds.length}`);
    for (const id of road.intersectionIds) {
      assert.ok(
        network.intersections.some((intersection) => intersection.id === id),
        `${road.id} links to a dropped intersection ${id}`,
      );
    }
  }
});

test('buildRoadNetwork returns an empty network for unusable input', () => {
  const network = buildRoadNetwork([]);
  assert.deepEqual(network, { roads: [], intersections: [], bounds: null });
});

test('roadsInBounds and intersectionsInBounds filter by a viewport box', () => {
  const network = buildRoadNetwork(gridRoads());
  const all = { west: 80.0, south: 12.0, east: 81.0, north: 14.0 };
  assert.equal(roadsInBounds(network.roads, all).length, network.roads.length);
  assert.equal(
    intersectionsInBounds(network.intersections, all).length,
    network.intersections.length,
  );
  assert.equal(roadsInBounds(network.roads, null).length, 0);
  const tiny = { west: 80.199, south: 13.079, east: 80.201, north: 13.081 };
  assert.equal(intersectionsInBounds(network.intersections, tiny).length, 1);
  assert.equal(roadsInBounds(network.roads, tiny).length, 2);
});
