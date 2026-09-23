import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boundsAreaM2,
  boundsContain,
  boundsOf,
  boxIou,
  clamp,
  destinationPoint,
  finiteMean,
  haversineM,
  isFiniteNumber,
  nearestPointOnPolyline,
  oppositeDirection,
  cardinalFromBearing,
  pointAlongPolyline,
  polylineLengthM,
  unionBounds,
} from './geometry.js';

test('haversine measures a known distance within tolerance', () => {
  // London → Paris is ~343.5 km great-circle.
  const d = haversineM(-0.1276, 51.5072, 2.3522, 48.8566);
  assert.ok(Math.abs(d - 343_500) < 5_000, `got ${d}`);
});

test('haversine is zero for a coincident point and symmetric', () => {
  assert.equal(haversineM(80.2, 13.08, 80.2, 13.08), 0);
  const forward = haversineM(80.2, 13.08, 80.25, 13.1);
  const back = haversineM(80.25, 13.1, 80.2, 13.08);
  assert.ok(Math.abs(forward - back) < 1e-6);
});

test('polyline length adds its segments and ignores degenerate input', () => {
  const line = [
    [80.2, 13.08],
    [80.21, 13.08],
    [80.22, 13.08],
  ];
  const total = polylineLengthM(line);
  const first = haversineM(80.2, 13.08, 80.21, 13.08);
  const second = haversineM(80.21, 13.08, 80.22, 13.08);
  assert.ok(Math.abs(total - (first + second)) < 1e-6);
  assert.equal(polylineLengthM([]), 0);
  assert.equal(polylineLengthM([[80.2, 13.08]]), 0);
  assert.equal(polylineLengthM(null), 0);
});

test('a polyline carrying an unusable vertex skips that segment rather than returning NaN', () => {
  const line = [
    [80.2, 13.08],
    ['nonsense', 13.08],
    [80.22, 13.08],
  ];
  const total = polylineLengthM(line);
  assert.ok(Number.isFinite(total));
});

test('cardinalFromBearing resolves the four quadrants and their boundaries', () => {
  assert.equal(cardinalFromBearing(0), 'N');
  assert.equal(cardinalFromBearing(359), 'N');
  assert.equal(cardinalFromBearing(45), 'E');
  assert.equal(cardinalFromBearing(90), 'E');
  assert.equal(cardinalFromBearing(134.9), 'E');
  assert.equal(cardinalFromBearing(180), 'S');
  assert.equal(cardinalFromBearing(270), 'W');
  assert.equal(cardinalFromBearing(315), 'N');
  // A bearing off the end of the range wraps rather than failing.
  assert.equal(cardinalFromBearing(370), 'N');
  assert.equal(cardinalFromBearing(-10), 'N');
  assert.equal(cardinalFromBearing(NaN), null);
});

test('oppositeDirection is its own inverse', () => {
  for (const direction of ['N', 'E', 'S', 'W']) {
    assert.equal(oppositeDirection(oppositeDirection(direction)), direction);
  }
  assert.equal(oppositeDirection('NE'), null);
});

test('nearestPointOnPolyline projects onto the segment and reports the along-line offset', () => {
  const line = [
    [80.2, 13.08],
    [80.22, 13.08],
  ];
  const hit = nearestPointOnPolyline(line, 80.2, 13.081);
  assert.ok(hit);
  assert.ok(Math.abs(hit.lon - 80.2) < 1e-6);
  assert.ok(Math.abs(hit.lat - 13.08) < 1e-6);
  assert.ok(hit.distanceM > 100 && hit.distanceM < 130, `got ${hit.distanceM}`);
  assert.ok(hit.offsetM < 1);

  const mid = nearestPointOnPolyline(line, 80.21, 13.08);
  assert.ok(mid);
  const half = polylineLengthM(line) / 2;
  assert.ok(Math.abs(mid.offsetM - half) < 1, `${mid.offsetM} vs ${half}`);
  assert.equal(nearestPointOnPolyline(line, NaN, 13.08), null);
  assert.equal(nearestPointOnPolyline([[80.2, 13.08]], 80.2, 13.08), null);
});

test('pointAlongPolyline walks the line and clamps at the end', () => {
  const line = [
    [80.2, 13.08],
    [80.22, 13.08],
  ];
  const total = polylineLengthM(line);
  const quarter = pointAlongPolyline(line, total / 4);
  assert.ok(quarter);
  assert.ok(Math.abs(quarter.lon - 80.205) < 1e-3);
  assert.ok(Math.abs(quarter.bearingDeg - 90) < 1);
  const past = pointAlongPolyline(line, total * 10);
  assert.ok(past);
  assert.ok(Math.abs(past.lon - 80.22) < 1e-6);
  assert.equal(pointAlongPolyline([], 0), null);
});

test('boundsOf and boundsContain handle a line and an empty input', () => {
  const bounds = boundsOf([
    [80.2, 13.0],
    [80.3, 13.2],
    [80.25, 13.05],
  ]);
  assert.deepEqual(bounds, { west: 80.2, south: 13.0, east: 80.3, north: 13.2 });
  assert.equal(boundsContain(bounds, 80.25, 13.1), true);
  assert.equal(boundsContain(bounds, 80.4, 13.1), false);
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf(null), null);
  assert.equal(boundsContain(null, 0, 0), false);
});

test('unionBounds grows to cover both boxes', () => {
  const a = { west: 80.2, south: 13.0, east: 80.3, north: 13.1 };
  const b = { west: 80.25, south: 12.9, east: 80.4, north: 13.05 };
  assert.deepEqual(unionBounds(a, b), {
    west: 80.2,
    south: 12.9,
    east: 80.4,
    north: 13.1,
  });
  assert.deepEqual(unionBounds(null, b), b);
  assert.deepEqual(unionBounds(a, null), a);
  assert.equal(unionBounds(null, null), null);
});

test('boundsAreaM2 scales with the box and is zero without one', () => {
  const small = boundsAreaM2({ west: 80.2, south: 13.0, east: 80.201, north: 13.001 });
  const large = boundsAreaM2({ west: 80.2, south: 13.0, east: 80.21, north: 13.01 });
  assert.ok(large > small * 50, `${large} vs ${small}`);
  assert.equal(boundsAreaM2(null), 0);
});

test('boxIou measures real overlap and refuses degenerate boxes', () => {
  assert.equal(boxIou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(boxIou([0, 0, 10, 10], [10, 0, 10, 10]), 0);
  // Half overlap: intersection 50, union 150.
  const half = boxIou([0, 0, 10, 10], [5, 0, 10, 10]);
  assert.ok(Math.abs(half - 50 / 150) < 1e-9, `got ${half}`);
  assert.equal(boxIou([0, 0, 0, 10], [0, 0, 10, 10]), 0);
  assert.equal(boxIou([0, 0, 10, 10], [0, 0, 10]), 0);
  assert.equal(boxIou(null, [0, 0, 1, 1]), 0);
  assert.equal(boxIou([0, 0, NaN, 1], [0, 0, 1, 1]), 0);
});

test('destinationPoint moves the requested distance at the requested bearing', () => {
  const north = destinationPoint(80.2, 13.0, 0, 1000);
  assert.ok(Math.abs(north.lon - 80.2) < 1e-9);
  assert.ok(north.lat > 13.0);
  const back = haversineM(80.2, 13.0, north.lon, north.lat);
  assert.ok(Math.abs(back - 1000) < 1, `got ${back}`);

  // A due-east heading follows a great circle, so latitude drifts slightly off
  // the equator — what must hold is the heading and the distance.
  const dueEast = destinationPoint(80.2, 13.0, 90, 500);
  assert.ok(dueEast.lon > 80.2);
  assert.ok(Math.abs(haversineM(80.2, 13.0, dueEast.lon, dueEast.lat) - 500) < 1);
});

test('clamp, isFiniteNumber and finiteMean behave at the edges', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber('5'), false);
  assert.equal(isFiniteNumber(Infinity), false);
  assert.equal(isFiniteNumber(NaN), false);
  assert.equal(finiteMean([1, 2, 3]), 2);
  assert.equal(finiteMean([1, NaN, 3]), 2);
  assert.equal(finiteMean([]), null);
  assert.equal(finiteMean([NaN]), null);
  assert.equal(finiteMean(null), null);
});
