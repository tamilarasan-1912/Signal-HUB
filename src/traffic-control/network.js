/**
 * @file Normalized road-network and intersection model.
 *
 * Roads come from the SAME Overpass road geometry the existing traffic layer
 * already fetches (`src/layers/traffic/source.js` → `/api/overpass` →
 * `normalizeOverpassRoads`). This module adds the derived, control-plane view
 * of that geometry — lanes, free-flow speed, congestion, queue — without
 * re-fetching anything the repository already has.
 *
 * Every field that is not directly measured carries a mode from
 * {@link DATA_MODES}. `speedMps` measured by TomTom is LIVE; the same road's
 * `freeFlowMps` is a class baseline and is ESTIMATED; a simulated road's speed
 * is SIMULATED. A reader must never have to guess which is which.
 *
 * @module traffic-control/network
 */

import {
  DATA_MODES,
  DEFAULT_FREE_FLOW_MPS,
  FREE_FLOW_LEVEL,
  FREE_FLOW_MPS_BY_ROAD_CLASS,
  LANES_BY_ROAD_CLASS,
  SLOW_FLOW_LEVEL,
  DIRECTIONS,
  PHASE_GROUP_APPROACHES,
  approachAxis,
} from './policy.js';
import {
  boundsContain,
  boundsOf,
  clamp,
  haversineM,
  isFiniteNumber,
  nearestPointOnPolyline,
  polylineLengthM,
  unionBounds,
} from './geometry.js';
import { createSignalGroup } from './signals.js';

/** @const {number} Metres within which a road vertex counts as an intersection. */
export const INTERSECTION_CLUSTER_M = 22;

/** @const {number} Metres of road on each side of an intersection approach. */
export const APPROACH_LENGTH_M = 120;

/**
 * Free-flow speed for a road class.
 * @param {string} roadClass
 * @returns {number} m/s
 */
export function freeFlowMps(roadClass) {
  return FREE_FLOW_MPS_BY_ROAD_CLASS[roadClass] ?? DEFAULT_FREE_FLOW_MPS;
}

/**
 * Normalize one road from the traffic layer's parsed shape into the control
 * plane's road record.
 *
 * Accepts either the raw Overpass-normalized shape (`coordinates`, `type`,
 * `oneway`) or the traffic layer's parsed shape (which additionally carries
 * `waypoints` and `segmentDist`).
 * @param {object} road
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {string} [options.name]
 * @param {string} [options.mode] - Data mode for this road's dynamics.
 * @returns {object|null} Null for a degenerate road.
 */
export function normalizeRoad(road, { id, name, mode = DATA_MODES.simulated } = {}) {
  if (!road || !Array.isArray(road.coordinates) || road.coordinates.length < 2)
    return null;
  const roadClass = typeof road.type === 'string' ? road.type : 'unclassified';
  const lengthM = isFiniteNumber(road.lengthM)
    ? road.lengthM
    : polylineLengthM(road.coordinates);
  if (lengthM <= 0) return null;
  const lanes = Number.isInteger(road.lanes)
    ? clamp(road.lanes, 1, 8)
    : LANES_BY_ROAD_CLASS[roadClass] ?? 1;
  return Object.freeze({
    id: id || road.id || `ROAD-${roadClass}-${Math.round(lengthM)}`,
    name: name || road.name || '',
    roadClass,
    coordinates: road.coordinates,
    lanes,
    oneway: Number.isInteger(road.oneway) ? road.oneway : 0,
    lengthM,
    bounds: boundsOf(road.coordinates),
    freeFlowMps: freeFlowMps(roadClass),
    freeFlowMode: DATA_MODES.estimated,
    speedMps: null,
    speedMode: mode,
    trafficLevel: null,
    levelMode: mode,
    congestion: null,
    queueM: 0,
    vehicleCount: 0,
    densityVpkpl: null,
    incidents: Object.freeze([]),
    cameraIds: Object.freeze([]),
    intersectionIds: Object.freeze([]),
    signalizedIntersectionIds: Object.freeze([]),
  });
}

/**
 * Derive the congestion level of a road from its speed against free flow.
 *
 * TomTom's own `traffic_level` (current/free-flow speed) is preferred when it
 * is available, because it is the value the upstream provider computed. When
 * it is absent the level is derived here and labelled as an estimate.
 * @param {object} road - A normalized road.
 * @param {number|null} [measuredSpeedMps]
 * @param {number|null} [measuredLevel]
 * @returns {{level:number|null, bucket:'free'|'slow'|'jam'|null, mode:string}}
 */
export function deriveCongestion(road, measuredSpeedMps = null, measuredLevel = null) {
  if (isFiniteNumber(measuredLevel)) {
    return {
      level: clamp(measuredLevel, 0, 1),
      bucket: bucketForLevel(measuredLevel),
      mode: DATA_MODES.live,
    };
  }
  if (isFiniteNumber(measuredSpeedMps) && road?.freeFlowMps > 0) {
    const level = clamp(measuredSpeedMps / road.freeFlowMps, 0, 1);
    return { level, bucket: bucketForLevel(level), mode: DATA_MODES.estimated };
  }
  return { level: null, bucket: null, mode: DATA_MODES.unavailable };
}

/**
 * Bucket a 0–1 traffic level.
 * @param {number} level
 * @returns {'free'|'slow'|'jam'}
 */
export function bucketForLevel(level) {
  if (!isFiniteNumber(level)) return 'free';
  if (level >= FREE_FLOW_LEVEL) return 'free';
  if (level >= SLOW_FLOW_LEVEL) return 'slow';
  return 'jam';
}

/**
 * Apply a measured or simulated state onto a road, returning a new record.
 * Frozen records keep the store's snapshots safe to hand to the UI.
 * @param {object} road
 * @param {object} state
 * @param {number|null} [state.speedMps]
 * @param {number|null} [state.trafficLevel]
 * @param {string} [state.mode]
 * @param {number} [state.vehicleCount]
 * @returns {object} A new frozen road.
 */
export function withRoadState(road, state = {}) {
  const { level, bucket, mode } = deriveCongestion(
    road,
    state.speedMps ?? null,
    state.trafficLevel ?? null,
  );
  const speedMps = isFiniteNumber(state.speedMps)
    ? state.speedMps
    : isFiniteNumber(level)
      ? road.freeFlowMps * level
      : null;
  const densityVpkpl =
    isFiniteNumber(state.vehicleCount) && road.lanes > 0
      ? state.vehicleCount / Math.max(0.001, road.lengthM / 1000) / road.lanes
      : null;
  return Object.freeze({
    ...road,
    speedMps,
    speedMode: state.mode || mode,
    trafficLevel: level,
    levelMode: mode,
    congestion: bucket,
    queueM: isFiniteNumber(state.queueM) ? Math.max(0, state.queueM) : road.queueM,
    vehicleCount: Number.isInteger(state.vehicleCount)
      ? Math.max(0, state.vehicleCount)
      : road.vehicleCount,
    densityVpkpl,
  });
}

/**
 * Attach relationships to a road (intersections, cameras, incidents).
 * @param {object} road
 * @param {object} links
 * @returns {object} A new frozen road.
 */
export function linkRoad(road, links = {}) {
  const intersectionIds = links.intersectionIds
    ? Object.freeze([...new Set(links.intersectionIds)])
    : road.intersectionIds;
  const signalized = links.intersectionIds && links.signalizedIds
    ? intersectionIds.filter((id) => links.signalizedIds.has(id))
    : road.signalizedIntersectionIds;
  return Object.freeze({
    ...road,
    intersectionIds,
    signalizedIntersectionIds: Object.freeze([...signalized]),
    cameraIds: links.cameraIds
      ? Object.freeze([...new Set(links.cameraIds)])
      : road.cameraIds,
    incidents: links.incidents
      ? Object.freeze([...links.incidents])
      : road.incidents,
  });
}

/**
 * Build an intersection from a location and the roads that meet there.
 *
 * Each approach is measured along the incoming road, so an approach's queue
 * and speed are properties of real geometry rather than placeholder numbers.
 * @param {object} options
 * @param {string} options.id
 * @param {string} [options.name]
 * @param {number} options.lon @param {number} options.lat
 * @param {object[]} [options.roads] - Roads meeting at this intersection.
 * @param {Array<{id:string,lon:number,lat:number}>} [options.cameras]
 * @param {string} [options.mode]
 * @returns {object} A frozen intersection.
 */
export function createIntersection({
  id,
  name = '',
  lon,
  lat,
  roads = [],
  cameras = [],
  mode = DATA_MODES.simulated,
} = {}) {
  if (typeof id !== 'string' || !id)
    throw new TypeError('An intersection requires an id');
  if (!isFiniteNumber(lon) || !isFiniteNumber(lat))
    throw new TypeError(`Intersection ${id} requires finite coordinates`);

  /** @type {Record<string, object>} */
  const approaches = {};
  for (const direction of DIRECTIONS) {
    approaches[direction] = {
      direction,
      axis: approachAxis(direction),
      roadId: null,
      roadName: '',
      roadClass: '',
      lengthM: APPROACH_LENGTH_M,
      lanes: 0,
      vehicleCount: 0,
      queueM: 0,
      queueVehicles: 0,
      speedMps: null,
      congestion: null,
      cameraId: null,
      signalPhase: 'red',
      mode,
    };
  }

  // Assign each meeting road to the approach whose bearing matches where that
  // road heads. A road can be attached to at most one direction, and the
  // assignment is deterministic (nearest bearing wins) so a store rebuild
  // produces the same intersection.
  const claims = [];
  for (const road of roads) {
    const hit = nearestPointOnPolyline(road.coordinates, lon, lat);
    if (!hit || hit.distanceM > INTERSECTION_CLUSTER_M * 2) continue;
    // Bearing from the intersection outward along the road, both ways.
    const ahead = pointAhead(road.coordinates, hit.index);
    for (const candidate of [ahead, ahead === null ? null : (ahead + 180) % 360]) {
      if (candidate === null) continue;
      const direction = cardinalOf(candidate);
      if (!direction) continue;
      claims.push({ road, direction, distanceM: hit.distanceM, bearingDeg: candidate });
    }
  }
  for (const claim of claims.sort((a, b) => a.distanceM - b.distanceM)) {
    const approach = approaches[claim.direction];
    if (!approach || approach.roadId) continue;
    approach.roadId = claim.road.id;
    approach.roadName = claim.road.name || '';
    approach.roadClass = claim.road.roadClass;
    approach.lanes = claim.road.lanes;
    approach.lengthM = Math.min(APPROACH_LENGTH_M, Math.max(20, claim.road.lengthM / 2));
  }

  // Cameras bind to the approach whose bearing they sit on, so a camera looks
  // down the approach it actually observes.
  const camerasByDirection = {};
  for (const camera of cameras) {
    if (!isFiniteNumber(camera.lon) || !isFiniteNumber(camera.lat)) continue;
    const bearing = bearingTo(lon, lat, camera.lon, camera.lat);
    const direction = cardinalOf(bearing);
    if (!direction) continue;
    camerasByDirection[direction] ??= camera.id;
  }
  for (const direction of DIRECTIONS) {
    approaches[direction].cameraId = camerasByDirection[direction] ?? null;
  }

  const modes = Object.freeze(
    Object.fromEntries(
      Object.entries(approaches).map(([direction, approach]) => [
        direction,
        { vehicleCount: mode, queueM: mode, speedMps: mode, congestion: mode },
      ]),
    ),
  );

  return Object.freeze({
    id,
    name: name || id,
    lon,
    lat,
    signalized: true,
    approaches: Object.freeze(
      Object.fromEntries(
        Object.entries(approaches).map(([direction, approach]) => [
          direction,
          Object.freeze(approach),
        ]),
      ),
    ),
    modes,
    controllerId: null,
    mode,
    cameraIds: Object.freeze(
      Object.values(camerasByDirection).filter(Boolean),
    ),
    incidentIds: Object.freeze([]),
    violationIds: Object.freeze([]),
  });
}

/** Bearing from a polyline segment outward along the road. */
function pointAhead(coordinates, index) {
  const base = Math.max(0, Math.min(coordinates.length - 2, index));
  const [lonA, latA] = coordinates[base];
  const [lonB, latB] = coordinates[base + 1];
  if (!isFiniteNumber(lonA) || !isFiniteNumber(lonB)) return null;
  const y = latB - latA;
  const x = lonB - lonA;
  if (x === 0 && y === 0) return null;
  const deg = (Math.atan2(x, y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function cardinalOf(deg) {
  if (!isFiniteNumber(deg)) return null;
  const wrapped = ((deg % 360) + 360) % 360;
  if (wrapped >= 315 || wrapped < 45) return 'N';
  if (wrapped < 135) return 'E';
  if (wrapped < 225) return 'S';
  return 'W';
}

function bearingTo(lonA, latA, lonB, latB) {
  const DEG = Math.PI / 180;
  const dLon = (lonB - lonA) * DEG;
  const lat1 = latA * DEG;
  const lat2 = latB * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/**
 * Cluster road vertices into candidate intersections.
 *
 * Greedy spatial clustering over a hash grid, with a 3×3 neighbour lookup so a
 * point on a cell boundary still merges with its true neighbours. The naive
 * `floor(lon / cell)` single-cell version is not merely slow at city scale — it
 * silently splits a junction whenever a coordinate lands an epsilon either side
 * of a cell edge, which is a bug that produces a plausible-looking but wrong
 * city.
 *
 * O(n) in vertices, since the neighbour lookup is bounded at nine cells.
 * @param {object[]} roads - Normalized roads.
 * @param {object} [options]
 * @param {number} [options.minRoads=2] - Fewer than this is not a junction.
 * @param {number} [options.radiusM=INTERSECTION_CLUSTER_M]
 * @returns {Array<{lon:number,lat:number,roadIds:string[]}>}
 */
export function clusterIntersections(roads, { minRoads = 2, radiusM = INTERSECTION_CLUSTER_M } = {}) {
  // A 1e-3 degree cell is ≈ 111 m of latitude — comfortably larger than the
  // cluster radius, so the 3×3 neighbourhood covers every possible merge.
  const cellDeg = 0.001;
  /** @type {Map<string, Array<{lon:number,lat:number,roadIds:Set<string>}>>} */
  const cells = new Map();
  /** @type {Array<{lon:number,lat:number,roadIds:Set<string>}>} */
  const clusters = [];
  const key = (lon, lat) =>
    `${Math.floor(lon / cellDeg)}:${Math.floor(lat / cellDeg)}`;

  const attach = (cluster, roadId, lon, lat) => {
    // Running mean keeps the cluster centre at the junction rather than at
    // whichever vertex happened to arrive first.
    const n = cluster._count + 1;
    cluster.lon += (lon - cluster.lon) / n;
    cluster.lat += (lat - cluster.lat) / n;
    cluster._count = n;
    cluster.roadIds.add(roadId);
  };

  for (const road of roads) {
    const seenCells = new Set();
    for (const [lon, lat] of road.coordinates) {
      if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) continue;
      const cx = Math.floor(lon / cellDeg);
      const cy = Math.floor(lat / cellDeg);
      let target = null;
      for (let dx = -1; dx <= 1 && !target; dx += 1) {
        for (let dy = -1; dy <= 1 && !target; dy += 1) {
          const bucket = cells.get(`${cx + dx}:${cy + dy}`);
          if (!bucket) continue;
          for (const cluster of bucket) {
            if (haversineM(lon, lat, cluster.lon, cluster.lat) <= radiusM) {
              target = cluster;
              break;
            }
          }
        }
      }
      if (!target) {
        target = { lon, lat, roadIds: new Set(), _count: 0, _cell: key(lon, lat) };
        attach(target, road.id, lon, lat);
        clusters.push(target);
        const bucket = cells.get(target._cell);
        if (bucket) bucket.push(target);
        else cells.set(target._cell, [target]);
        continue;
      }
      attach(target, road.id, lon, lat);
      // A cluster whose centre drifted into a new cell must be reachable there.
      const movedCell = key(target.lon, target.lat);
      if (movedCell !== target._cell) {
        const bucket = cells.get(movedCell);
        if (bucket) {
          if (!bucket.includes(target)) bucket.push(target);
        } else cells.set(movedCell, [target]);
        target._cell = movedCell;
      }
      seenCells.add(target._cell);
    }
    void seenCells;
  }

  return clusters
    .filter((cluster) => cluster.roadIds.size >= minRoads)
    .map((cluster) => ({
      lon: cluster.lon,
      lat: cluster.lat,
      roadIds: [...cluster.roadIds].sort(),
    }))
    .sort((a, b) => (a.lat === b.lat ? a.lon - b.lon : a.lat - b.lat));
}

/**
 * Build the whole normalized network from road geometry.
 *
 * @param {object[]} rawRoads - Roads shaped like the traffic layer's output.
 * @param {object} [options]
 * @param {number} [options.maxIntersections=60]
 * @param {Array<{id:string,lon:number,lat:number}>} [options.cameras]
 * @param {string} [options.mode]
 * @returns {{roads:object[], intersections:object[], bounds:object|null}}
 */
export function buildRoadNetwork(rawRoads, {
  maxIntersections = 60,
  cameras = [],
  mode = DATA_MODES.simulated,
} = {}) {
  const roads = [];
  for (const [index, raw] of (rawRoads || []).entries()) {
    const road = normalizeRoad(raw, { id: `RD-${String(index + 1).padStart(4, '0')}`, mode });
    if (road) roads.push(road);
  }
  if (!roads.length) return { roads: [], intersections: [], bounds: null };

  const clusters = clusterIntersections(roads).slice(0, maxIntersections);
  const byId = new Map(roads.map((road) => [road.id, road]));
  const roadIdsSet = new Set(roads.map((road) => road.id));
  const intersections = clusters.map((cluster, index) => {
    const meeting = cluster.roadIds
      .map((id) => byId.get(id))
      .filter(Boolean);
    return createIntersection({
      id: `INT-${String(index + 1).padStart(3, '0')}`,
      name: meeting.find((road) => road.name)?.name
        ? `${meeting.find((road) => road.name).name} Junction`
        : `Junction INT-${String(index + 1).padStart(3, '0')}`,
      lon: cluster.lon,
      lat: cluster.lat,
      roads: meeting,
      cameras,
      mode,
    });
  });
  const signalizedIds = new Set(intersections.map((i) => i.id));

  // Link each road to the intersections it actually touches.
  const intersectionByRoad = new Map();
  for (const intersection of intersections) {
    for (const direction of DIRECTIONS) {
      const roadId = intersection.approaches[direction].roadId;
      if (!roadId) continue;
      if (!intersectionByRoad.has(roadId)) intersectionByRoad.set(roadId, []);
      intersectionByRoad.get(roadId).push(intersection.id);
    }
  }
  const cameraByRoad = new Map();
  for (const intersection of intersections) {
    for (const direction of DIRECTIONS) {
      const roadId = intersection.approaches[direction].roadId;
      const cameraId = intersection.approaches[direction].cameraId;
      if (!roadId || !cameraId) continue;
      if (!cameraByRoad.has(roadId)) cameraByRoad.set(roadId, []);
      cameraByRoad.get(roadId).push(cameraId);
    }
  }

  const linked = roads.map((road) =>
    linkRoad(road, {
      intersectionIds: intersectionByRoad.get(road.id) || [],
      signalizedIds,
      cameraIds: cameraByRoad.get(road.id) || [],
    }),
  );
  // `roadIdsSet` is the set of every road the network kept; intersections only
  // exist where at least two of them meet, so this asserts the cluster step.
  void roadIdsSet;

  let bounds = null;
  for (const road of linked) bounds = unionBounds(bounds, road.bounds);

  return { roads: linked, intersections, bounds };
}

/**
 * Roads in a viewport box.
 * @param {object[]} roads @param {object} bounds
 * @returns {object[]}
 */
export function roadsInBounds(roads, bounds) {
  if (!bounds) return [];
  return roads.filter((road) => {
    const b = road.bounds;
    if (!b) return false;
    return (
      b.east >= bounds.west &&
      b.west <= bounds.east &&
      b.north >= bounds.south &&
      b.south <= bounds.north
    );
  });
}

/**
 * Intersections in a viewport box.
 * @param {object[]} intersections @param {object} bounds
 * @returns {object[]}
 */
export function intersectionsInBounds(intersections, bounds) {
  return intersections.filter((i) => boundsContain(bounds, i.lon, i.lat));
}

/**
 * A fresh signal group for every phase, for the intersection's controller.
 * @param {string} intersectionId
 * @returns {object[]}
 */
export function initialSignalGroups(intersectionId) {
  return PHASE_GROUP_APPROACHES
    ? [createSignalGroup({ intersectionId, group: 'NS', phase: 'green' })]
    : [];
}
