/**
 * @file Geodesy helpers for the traffic-control plane.
 *
 * Cesium-free and dependency-free on purpose: the same road geometry is
 * measured in the browser layer, in the server engine and in unit tests, and a
 * distance that differs between those three is a bug nobody would notice until
 * an operator did.
 *
 * @module traffic-control/geometry
 */

/** @const {number} Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6371008.8;

const DEG = Math.PI / 180;

/**
 * Clamp a number into a range.
 * @param {number} value @param {number} min @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Whether a value is a usable finite number.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Great-circle distance between two lon/lat points, in metres.
 * @param {number} lonA @param {number} latA
 * @param {number} lonB @param {number} latB
 * @returns {number} Metres.
 */
export function haversineM(lonA, latA, lonB, latB) {
  const dLat = (latB - latA) * DEG;
  const dLon = (lonB - lonA) * DEG;
  const lat1 = latA * DEG;
  const lat2 = latB * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial compass bearing from A to B, degrees clockwise from north.
 * @param {number} lonA @param {number} latA
 * @param {number} lonB @param {number} latB
 * @returns {number} Degrees in [0, 360).
 */
export function bearingDeg(lonA, latA, lonB, latB) {
  const lat1 = latA * DEG;
  const lat2 = latB * DEG;
  const dLon = (lonB - lonA) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = Math.atan2(y, x) / DEG;
  return (deg + 360) % 360;
}

/**
 * Snap a compass bearing to the nearest cardinal approach direction.
 *
 * The 45° cut is inclusive on the lower edge so a 45.0° bearing is NORTH-EAST
 * and resolves to `N`, matching how a driver would describe the approach.
 * @param {number} deg
 * @returns {'N'|'E'|'S'|'W'|null} Null for a non-finite bearing.
 */
export function cardinalFromBearing(deg) {
  if (!Number.isFinite(deg)) return null;
  const wrapped = ((deg % 360) + 360) % 360;
  if (wrapped >= 315 || wrapped < 45) return 'N';
  if (wrapped < 135) return 'E';
  if (wrapped < 225) return 'S';
  return 'W';
}

/**
 * The opposite cardinal approach.
 * @param {string} direction
 * @returns {'N'|'E'|'S'|'W'|null}
 */
export function oppositeDirection(direction) {
  if (direction === 'N') return 'S';
  if (direction === 'S') return 'N';
  if (direction === 'E') return 'W';
  if (direction === 'W') return 'E';
  return null;
}

/**
 * Total length of a lon/lat polyline in metres.
 * @param {number[][]} coordinates - Array of `[lon, lat]`.
 * @returns {number} Metres; 0 for a degenerate polyline.
 */
export function polylineLengthM(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const [lonA, latA] = coordinates[i];
    const [lonB, latB] = coordinates[i + 1];
    if (![lonA, latA, lonB, latB].every(isFiniteNumber)) continue;
    total += haversineM(lonA, latA, lonB, latB);
  }
  return total;
}

/**
 * Average of a numeric sample, ignoring non-finite entries.
 * @param {number[]} values
 * @returns {number|null} Null when the sample carries no usable value.
 */
export function finiteMean(values) {
  if (!Array.isArray(values)) return null;
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (!isFiniteNumber(value)) continue;
    total += value;
    count += 1;
  }
  return count ? total / count : null;
}

/**
 * The point on a polyline nearest to a target, with its along-line offset.
 *
 * Used to place an intersection or an incident *on* a road rather than beside
 * it, and to know how far along the road it sits.
 * @param {number[][]} coordinates - Array of `[lon, lat]`.
 * @param {number} lon @param {number} lat
 * @returns {{index:number, lon:number, lat:number, offsetM:number, distanceM:number}|null}
 *   Null for a polyline with fewer than two usable vertices.
 */
export function nearestPointOnPolyline(coordinates, lon, lat) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) return null;
  let best = null;
  let travelled = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const [lonA, latA] = coordinates[i];
    const [lonB, latB] = coordinates[i + 1];
    const segmentM = haversineM(lonA, latA, lonB, latB);
    if (!isFiniteNumber(lonA) || !isFiniteNumber(lonB)) continue;
    // Project in degree space — good enough at city scale, and it keeps the
    // function cheap enough to run for every road in a viewport.
    const spanLon = lonB - lonA;
    const spanLat = latB - latA;
    const spanSq = spanLon * spanLon + spanLat * spanLat;
    const t = spanSq === 0 ? 0 : clamp(((lon - lonA) * spanLon + (lat - latA) * spanLat) / spanSq, 0, 1);
    const pLon = lonA + spanLon * t;
    const pLat = latA + spanLat * t;
    const distanceM = haversineM(lon, lat, pLon, pLat);
    if (!best || distanceM < best.distanceM) {
      best = {
        index: i,
        lon: pLon,
        lat: pLat,
        offsetM: travelled + segmentM * t,
        distanceM,
      };
    }
    travelled += segmentM;
  }
  return best;
}

/**
 * Bounding box of a lon/lat polyline.
 * @param {number[][]} coordinates
 * @returns {{west:number,south:number,east:number,north:number}|null}
 */
export function boundsOf(coordinates) {
  if (!Array.isArray(coordinates) || !coordinates.length) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of coordinates) {
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) continue;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!Number.isFinite(west)) return null;
  return { west, south, east, north };
}

/**
 * Merge two bounding boxes.
 * @param {object|null} a @param {object|null} b
 * @returns {object|null}
 */
export function unionBounds(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    west: Math.min(a.west, b.west),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    north: Math.max(a.north, b.north),
  };
}

/**
 * Whether a bounding box contains a point.
 * @param {object|null} bounds @param {number} lon @param {number} lat
 * @returns {boolean}
 */
export function boundsContain(bounds, lon, lat) {
  if (!bounds || !isFiniteNumber(lon) || !isFiniteNumber(lat)) return false;
  return (
    lon >= bounds.west &&
    lon <= bounds.east &&
    lat >= bounds.south &&
    lat <= bounds.north
  );
}

/**
 * Area of a bounding box in square metres (small box approximation).
 * @param {object|null} bounds
 * @returns {number}
 */
export function boundsAreaM2(bounds) {
  if (!bounds) return 0;
  const midLat = (bounds.south + bounds.north) / 2;
  const heightM = haversineM(bounds.west, bounds.south, bounds.west, bounds.north);
  const widthM = haversineM(
    bounds.west,
    midLat,
    bounds.east,
    midLat,
  );
  return heightM * widthM;
}

/**
 * The point `distanceM` along a polyline from its start.
 * @param {number[][]} coordinates
 * @param {number} distanceM
 * @returns {{lon:number,lat:number,bearingDeg:number}|null}
 */
export function pointAlongPolyline(coordinates, distanceM) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  let remaining = Math.max(0, distanceM);
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const [lonA, latA] = coordinates[i];
    const [lonB, latB] = coordinates[i + 1];
    const segmentM = haversineM(lonA, latA, lonB, latB);
    if (remaining <= segmentM || i === coordinates.length - 2) {
      const t = segmentM === 0 ? 0 : clamp(remaining / segmentM, 0, 1);
      return {
        lon: lonA + (lonB - lonA) * t,
        lat: latA + (latB - latA) * t,
        bearingDeg: bearingDeg(lonA, latA, lonB, latB),
      };
    }
    remaining -= segmentM;
  }
  return null;
}

/**
 * Intersection-over-union of two `[x, y, w, h]` boxes.
 * @param {number[]} a @param {number[]} b
 * @returns {number} IoU in [0, 1]; 0 when either box is degenerate.
 */
export function boxIou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length < 4 || b.length < 4) return 0;
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  if (![ax, ay, aw, ah, bx, by, bw, bh].every(isFiniteNumber)) return 0;
  if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) return 0;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection === 0) return 0;
  const union = aw * ah + bw * bh - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/**
 * A destination point from a start, a bearing and a distance.
 * @param {number} lon @param {number} lat
 * @param {number} bearingDegrees @param {number} distanceM
 * @returns {{lon:number,lat:number}}
 */
export function destinationPoint(lon, lat, bearingDegrees, distanceM) {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = bearingDegrees * DEG;
  const lat1 = lat * DEG;
  const lon1 = lon * DEG;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lon: (lon2 / DEG + 540) % 360 - 180, lat: lat2 / DEG };
}
