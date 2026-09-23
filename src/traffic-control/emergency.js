/**
 * @file Emergency detection, routing, corridor planning and signal preemption.
 *
 * Three separable pieces, in the order they run:
 *
 *  1. {@link fuseEmergencyDetection} — combine independent signals into one
 *     identification with a confidence band. A single visual classification is
 *     never enough for a control decision; the fusion is where that rule lives.
 *  2. {@link routeForEmergency} — Dijkstra over the intersection graph, using
 *     the road network the rest of the platform already has. Congestion raises
 *     edge cost so a corridor prefers a clear street over a jammed one, unless
 *     the caller asks for the shortest distance.
 *  3. {@link createEmergencyEngine} — owns emergency vehicles, their corridors,
 *     and the preemption lifecycle. It calls a signal controller's safe
 *     transition API; it never sets a lamp directly.
 *
 * Nothing here contacts dispatch, and no real siren or light-bar signal is
 * received. Every emergency vehicle in this prototype is SIMULATED, and every
 * corridor is a simulated preemption.
 *
 * @module traffic-control/emergency
 */

import {
  CONFIDENCE_BANDS,
  DATA_MODES,
  DIRECTIONS,
  EMERGENCY_HOLD_MS,
  EMERGENCY_RELEASE_GRACE_MS,
  EMERGENCY_VEHICLE_TYPES,
  approachAxis,
} from './policy.js';
import {
  bearingDeg,
  clamp,
  destinationPoint,
  haversineM,
  isFiniteNumber,
  pointAlongPolyline,
  polylineLengthM,
} from './geometry.js';
import { SEVERITY } from './events.js';

/** @const {number} Metres/second an ambulance is modelled at, unimpeded. */
export const EMERGENCY_TRAVEL_MPS = 16.7;

/** @const {number} Metres within which a vehicle is "approaching" an intersection. */
export const APPROACH_NOTICE_M = 220;

/** @const {number} Seconds of broadcast window the UI narrates an ETA over. */
export const ETA_RADAR_S = 90;

/**
 * Fuse independent emergency-identification signals into one call.
 *
 * Signals, in descending order of trustworthiness:
 *  - `authorized` — a connected emergency-vehicle feed. If a dispatcher says
 *    this is an ambulance, it is one.
 *  - `lightPattern` — a measured emergency light-bar flash pattern.
 *  - `siren` — an audio siren detection.
 *  - `visual` — a classifier's opinion from one camera frame.
 *  - `operator` — a human said so.
 *
 * Weights are not a probability model and are not presented as one. They exist
 * so that one uncertain visual detection cannot on its own reach HIGH, which is
 * the documented requirement.
 * @param {object} signals
 * @param {boolean} [signals.authorized]
 * @param {number} [signals.lightPattern] - 0–1 confidence.
 * @param {number} [signals.siren]
 * @param {number} [signals.visual]
 * @param {boolean} [signals.operator]
 * @param {string} [signals.type]
 * @returns {{confidence:number, band:'high'|'medium'|'low', type:string|null,
 *   signals:object, mode:string, reasons:string[]}}
 */
export function fuseEmergencyDetection(signals = {}) {
  const contributions = [];
  const reasons = [];
  let score = 0;
  let totalWeight = 0;

  const add = (name, value, weight, reason) => {
    if (!isFiniteNumber(value) || value <= 0) return;
    score += clamp(value, 0, 1) * weight;
    totalWeight += weight;
    contributions.push({ name, value: clamp(value, 0, 1), weight });
    if (reason) reasons.push(reason);
  };

  // An authorized feed short-circuits the weighting: it is authoritative, so
  // the fused call is HIGH whatever the camera thought.
  if (signals.authorized === true) {
    contributions.push({ name: 'authorized', value: 1, weight: 1 });
    reasons.push('authorized emergency-vehicle feed');
    return {
      confidence: 1,
      band: 'high',
      type: EMERGENCY_VEHICLE_TYPES.includes(signals.type) ? signals.type : null,
      signals: Object.freeze({ ...signals }),
      mode: DATA_MODES.live,
      reasons,
    };
  }

  add('lightPattern', signals.lightPattern, 0.35, 'emergency light pattern');
  add('siren', signals.siren, 0.3, 'siren detected');
  add('visual', signals.visual, 0.2, 'visual classification');
  if (signals.operator === true) {
    contributions.push({ name: 'operator', value: 1, weight: 0.4 });
    reasons.push('operator confirmed');
    score += 0.4;
    totalWeight += 0.4;
  }

  const confidence = totalWeight > 0 ? clamp(score / totalWeight, 0, 1) : 0;
  const allWeak =
    contributions.length > 0 &&
    contributions.every((c) => c.name === 'visual' && c.value < 0.7);
  if (allWeak)
    reasons.push('visual classification alone — do not use for control');
  return {
    confidence: allWeak ? Math.min(confidence, CONFIDENCE_BANDS.medium - 0.01) : confidence,
    band: confidenceBand(confidence, allWeak),
    type: EMERGENCY_VEHICLE_TYPES.includes(signals.type) ? signals.type : null,
    signals: Object.freeze({ ...signals }),
    mode:
      signals.lightPattern || signals.siren
        ? DATA_MODES.simulated
        : DATA_MODES.estimated,
    reasons,
  };
}

/**
 * @param {number} confidence @param {boolean} [capAtMedium]
 * @returns {'high'|'medium'|'low'}
 */
export function confidenceBand(confidence, capAtMedium = false) {
  if (!isFiniteNumber(confidence) || confidence <= 0) return 'low';
  if (confidence >= CONFIDENCE_BANDS.high) return capAtMedium ? 'medium' : 'high';
  if (confidence >= CONFIDENCE_BANDS.medium) return 'medium';
  return 'low';
}

/**
 * Build the routing graph from a normalized road network.
 *
 * Nodes are intersections. An edge exists when two intersections share a road,
 * and its weight is the road length in metres, scaled by congestion. Returns
 * adjacency plus the node coordinates so the caller can reconstruct geometry.
 * @param {object} network
 * @returns {{nodes:Map<string,object>, edges:Map<string,Array<object>>}}
 */
export function buildRoutingGraph(network) {
  const intersections = network?.intersections || [];
  const roads = network?.roads || [];
  const byId = new Map(intersections.map((i) => [i.id, i]));
  /** @type {Map<string, Array<{to:string, roadId:string, costM:number, baseM:number, congestion:number}>>} */
  const edges = new Map();
  const roadById = new Map(roads.map((road) => [road.id, road]));

  // Each road knows which intersections it touches; connecting consecutive
  // pairs along that list would impose an order the data does not have, so a
  // road with k intersections contributes a clique. k is 2 for a normal street
  // segment and rarely more than 3, so the clique stays cheap.
  for (const road of roads) {
    const touching = road.intersectionIds.filter((id) => byId.has(id));
    if (touching.length < 2) continue;
    for (let a = 0; a < touching.length - 1; a += 1) {
      for (let b = a + 1; b < touching.length; b += 1) {
        const from = touching[a];
        const to = touching[b];
        const fromNode = byId.get(from);
        const toNode = byId.get(to);
        const baseM = haversineM(fromNode.lon, fromNode.lat, toNode.lon, toNode.lat);
        if (baseM <= 0) continue;
        const congestion = congestionPenalty(road);
        const costM = baseM * (1 + congestion);
        if (!edges.has(from)) edges.set(from, []);
        if (!edges.has(to)) edges.set(to, []);
        edges.get(from).push({ to, roadId: road.id, costM, baseM, congestion });
        edges.get(to).push({ to: from, roadId: road.id, costM, baseM, congestion });
      }
    }
  }
  void roadById;
  return { nodes: byId, edges };
}

/** How much extra time a congested road adds, as a multiplier bonus. */
function congestionPenalty(road) {
  if (!road) return 0;
  if (road.congestion === 'jam') return 1.5;
  if (road.congestion === 'slow') return 0.6;
  if (isFiniteNumber(road.trafficLevel)) return clamp((1 - road.trafficLevel) * 1.5, 0, 1.5);
  return 0;
}

/**
 * Shortest path between two intersections.
 *
 * Dijkstra with a binary heap. Deliberately not A*: the heuristic for a
 * lat/lon graph is a great-circle distance, which is only admissible when edge
 * costs are at least distances — and they are not once congestion multiplies
 * them, so A* would silently return suboptimal routes.
 * @param {object} graph
 * @param {string} fromId @param {string} toId
 * @param {object} [options]
 * @param {number} [options.congestionWeight=1] - 0 for shortest distance.
 * @returns {{path:string[], roadIds:string[], distanceM:number, costM:number}|null}
 */
export function shortestPath(graph, fromId, toId, { congestionWeight = 1 } = {}) {
  if (!graph?.edges?.has(fromId) || !graph.nodes.has(toId)) return null;
  if (fromId === toId)
    return { path: [fromId], roadIds: [], distanceM: 0, costM: 0 };

  /** @type {Map<string, number>} */
  const best = new Map([[fromId, 0]]);
  /** @type {Map<string, {from:string, roadId:string}>} */
  const cameFrom = new Map();
  const queue = new MinHeap();
  queue.push(fromId, 0);

  while (queue.size) {
    const { key: node, priority } = queue.pop();
    if (node === toId) break;
    if (priority > (best.get(node) ?? Infinity)) continue;
    for (const edge of graph.edges.get(node) || []) {
      const weight =
        edge.baseM + (edge.baseM * edge.congestion * congestionWeight);
      const candidate = priority + weight;
      if (candidate < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, candidate);
        cameFrom.set(edge.to, { from: node, roadId: edge.roadId });
        queue.push(edge.to, candidate);
      }
    }
  }
  if (!best.has(toId)) return null;

  const path = [toId];
  const roadIds = [];
  let cursor = toId;
  let distanceM = 0;
  while (cursor !== fromId) {
    const step = cameFrom.get(cursor);
    if (!step) return null;
    path.unshift(step.from);
    roadIds.unshift(step.roadId);
    cursor = step.from;
  }
  const nodes = graph.nodes;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = nodes.get(path[i]);
    const b = nodes.get(path[i + 1]);
    distanceM += haversineM(a.lon, a.lat, b.lon, b.lat);
  }
  return { path, roadIds, distanceM, costM: best.get(toId) };
}

/** A tiny binary heap; ~40 lines beats a dependency for one call site. */
class MinHeap {
  constructor() {
    this._items = [];
  }
  get size() {
    return this._items.length;
  }
  push(key, priority) {
    this._items.push({ key, priority });
    let i = this._items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._items[parent].priority <= this._items[i].priority) break;
      [this._items[parent], this._items[i]] = [this._items[i], this._items[parent]];
      i = parent;
    }
  }
  pop() {
    const top = this._items[0];
    const last = this._items.pop();
    if (this._items.length) {
      this._items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (
          left < this._items.length &&
          this._items[left].priority < this._items[smallest].priority
        )
          smallest = left;
        if (
          right < this._items.length &&
          this._items[right].priority < this._items[smallest].priority
        )
          smallest = right;
        if (smallest === i) break;
        [this._items[smallest], this._items[i]] = [
          this._items[i],
          this._items[smallest],
        ];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * A route for an emergency vehicle, with the intersections it must preempt.
 * @param {object} graph
 * @param {object} options
 * @param {string} options.fromId @param {string} options.toId
 * @param {number} [options.congestionWeight=1]
 * @returns {object|null}
 */
export function routeForEmergency(graph, { fromId, toId, congestionWeight = 1 } = {}) {
  const found = shortestPath(graph, fromId, toId, { congestionWeight });
  if (!found) return null;
  const intersections = found.path.map((id) => graph.nodes.get(id)).filter(Boolean);
  return {
    intersectionIds: found.path,
    roadIds: found.roadIds,
    distanceM: Math.round(found.distanceM),
    etaS: Math.round(found.distanceM / EMERGENCY_TRAVEL_MPS),
    // Approach direction at each intersection is the bearing of travel into it,
    // which is what the preemption request needs to name.
    priorityAxes: approachAxesAlongRoute(intersections),
    geometry: intersections.map((node) => [node.lon, node.lat]),
    mode: DATA_MODES.simulated,
  };
}

/**
 * The axis an emergency vehicle's movement occupies at each intersection.
 *
 * Entering an intersection travelling north or south means the priority axis
 * is NS. Two consecutive points are enough to name it; a repeated point (a
 * data artefact) keeps the previous axis rather than guessing.
 * @param {object[]} intersections
 * @returns {Array<{intersectionId:string, axis:'NS'|'EW'|null, bearingDeg:number|null}>}
 */
export function approachAxesAlongRoute(intersections) {
  const out = [];
  for (let i = 0; i < intersections.length; i += 1) {
    const current = intersections[i];
    const next = intersections[i + 1] || null;
    const previous = intersections[i - 1] || null;
    const reference = next || previous;
    if (!reference) {
      out.push({ intersectionId: current.id, axis: null, bearingDeg: null });
      continue;
    }
    const bearing = next
      ? bearingDeg(current.lon, current.lat, reference.lon, reference.lat)
      : bearingDeg(reference.lon, reference.lat, current.lon, current.lat);
    const direction =
      bearing >= 315 || bearing < 45
        ? 'N'
        : bearing < 135
          ? 'E'
          : bearing < 225
            ? 'S'
            : 'W';
    out.push({
      intersectionId: current.id,
      axis: approachAxis(direction),
      bearingDeg: bearing,
    });
  }
  return out;
}

/**
 * Create an emergency vehicle record.
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.type
 * @param {number} options.lon @param {number} options.lat
 * @param {object} [options.detection]
 * @param {string} [options.label]
 * @returns {object}
 */
export function createEmergencyVehicle({
  id,
  type,
  lon,
  lat,
  detection = null,
  label = '',
} = {}) {
  if (typeof id !== 'string' || !id)
    throw new TypeError('An emergency vehicle requires an id');
  if (!EMERGENCY_VEHICLE_TYPES.includes(type))
    throw new TypeError(`Unknown emergency vehicle type: ${type}`);
  if (!isFiniteNumber(lon) || !isFiniteNumber(lat))
    throw new TypeError(`Emergency vehicle ${id} requires coordinates`);
  return Object.freeze({
    id,
    type,
    label: label || `${type} ${id}`,
    lon,
    lat,
    headingDeg: 0,
    speedMps: 0,
    status: 'approaching',
    mode: DATA_MODES.simulated,
    detection: detection || null,
    confidence: detection?.band || 'low',
    route: null,
    corridor: null,
    spawnedAt: null,
  });
}

/**
 * The emergency engine: owns vehicles, corridors and preemption requests.
 *
 * @param {object} options
 * @param {() => number} [options.clock]
 * @param {(event:object) => void} [options.emit] - Event sink (the event bus).
 * @param {object} [options.audit] - Audit log.
 * @returns {object}
 */
export function createEmergencyEngine({ clock = () => Date.now(), emit = null, audit = null } = {}) {
  /** @type {Map<string, object>} */
  const vehicles = new Map();
  /** @type {Map<string, object>} */
  const corridors = new Map();
  /** @type {Map<string, object>} */
  const preemptions = new Map();
  let nextVehicle = 1;
  let nextCorridor = 1;

  const publish = (event) => {
    try {
      emit?.(event);
    } catch (error) {
      console.error('Emergency event sink failed', error);
    }
  };

  const engine = {
    /**
     * Register a simulated emergency vehicle.
     * @param {object} options
     * @returns {object} The vehicle.
     */
    spawnVehicle({ type, lon, lat, detection = null, label = '' } = {}) {
      const id = `EMV-${String(nextVehicle++).padStart(4, '0')}`;
      const vehicle = createEmergencyVehicle({ id, type, lon, lat, detection, label });
      vehicles.set(id, { ...vehicle, spawnedAt: clock() });
      publish({
        category: 'emergency',
        type: 'emergency-vehicle-detected',
        severity: SEVERITY.critical,
        message: `${type.toUpperCase()} detected`,
        mode: DATA_MODES.simulated,
        detail: {
          vehicleId: id,
          type,
          confidence: vehicle.confidence,
          lon,
          lat,
        },
      });
      return vehicles.get(id);
    },

    /** @returns {object[]} */
    listVehicles() {
      return Object.freeze([...vehicles.values()]);
    },

    /** @param {string} id @returns {object|null} */
    getVehicle(id) {
      return vehicles.get(id) || null;
    },

    /**
     * Plan and register a corridor for a vehicle.
     *
     * This is planning only — it changes no signal. `requestPreemption` is the
     * separate, audited step that does.
     * @param {object} options
     * @param {string} options.vehicleId
     * @param {object} options.graph
     * @param {string} options.toId
     * @param {number} [options.congestionWeight]
     * @returns {object|null}
     */
    planCorridor({ vehicleId, graph, toId, congestionWeight = 1 } = {}) {
      const vehicle = vehicles.get(vehicleId);
      if (!vehicle) return null;
      // Start from the intersection nearest the vehicle's current position.
      const fromId = nearestNodeId(graph, vehicle.lon, vehicle.lat);
      if (!fromId) return null;
      const route = routeForEmergency(graph, { fromId, toId, congestionWeight });
      if (!route) return null;
      const id = `COR-${String(nextCorridor++).padStart(3, '0')}`;
      const corridor = Object.freeze({
        id,
        vehicleId,
        type: vehicle.type,
        fromId,
        toId,
        ...route,
        status: 'planned',
        mode: DATA_MODES.simulated,
        // The upcoming intersections, with the axis that must go (or stay)
        // green. This is what the map draws in blue and the UI lists.
        upcoming: Object.freeze(
          route.priorityAxes.map((entry, index) => {
            const intersection = graph.nodes.get(entry.intersectionId);
            return Object.freeze({
              intersectionId: entry.intersectionId,
              name: intersection?.name || entry.intersectionId,
              axis: entry.axis,
              order: index,
              lon: intersection?.lon ?? null,
              lat: intersection?.lat ?? null,
              cleared: false,
            });
          }),
        ),
      });
      corridors.set(id, corridor);
      vehicles.set(vehicleId, { ...vehicle, route: corridor, corridor: id });
      publish({
        category: 'emergency',
        type: 'emergency-corridor-requested',
        severity: SEVERITY.critical,
        message: `EMERGENCY CORRIDOR REQUESTED — ${corridor.intersectionIds.length} intersections`,
        mode: DATA_MODES.simulated,
        detail: {
          corridorId: id,
          vehicleId,
          intersectionIds: [...corridor.intersectionIds],
          etaS: corridor.etaS,
        },
      });
      return corridor;
    },

    /** @returns {object[]} */
    listCorridors() {
      return Object.freeze([...corridors.values()]);
    },

    /** @param {string} id @returns {object|null} */
    getCorridor(id) {
      return corridors.get(id) || null;
    },

    /**
     * Request preemption at one intersection for a corridor.
     *
     * The engine asks the controller for an emergency priority; the controller
     * performs the safe amber → all-red → green sequence. If the controller
     * refuses (a fault, or an unknown axis) the preemption is not recorded, so
     * the corridor cannot claim a state that is not real.
     * @param {object} options
     * @param {string} options.corridorId
     * @param {string} options.intersectionId
     * @param {object} options.controllers - Map of intersectionId → controller.
     * @param {string} [options.role]
     * @returns {{ok:boolean, reason:string|null, request:object|null}}
     */
    requestPreemption({ corridorId, intersectionId, controllers, role = null } = {}) {
      const corridor = corridors.get(corridorId);
      if (!corridor)
        return { ok: false, reason: 'unknown corridor', request: null };
      const controller = controllers?.get?.(intersectionId);
      if (!controller)
        return { ok: false, reason: 'no controller at that intersection', request: null };
      const entry = corridor.upcoming.find(
        (item) => item.intersectionId === intersectionId,
      );
      const axis = entry?.axis || 'NS';
      const before = controller.getSignalState();
      const result = controller.setEmergencyPriority({
        axis,
        reason: `${corridor.type} approaching`,
        holdMs: EMERGENCY_HOLD_MS,
      });
      if (!result.ok)
        return { ok: false, reason: result.reason, request: null };

      const request = Object.freeze({
        id: `PRM-${corridorId}-${intersectionId}`,
        corridorId,
        vehicleId: corridor.vehicleId,
        intersectionId,
        axis,
        reason: `${capitalize(corridor.type)} approaching`,
        requestedAt: clock(),
        expiresAt: clock() + EMERGENCY_HOLD_MS + EMERGENCY_RELEASE_GRACE_MS,
        before: Object.freeze({
          group: before.group,
          phase: before.phase,
          states: before.states,
        }),
        pending: Object.freeze(result.pending.map((step) => Object.freeze({ ...step }))),
        mode: DATA_MODES.simulated,
      });
      preemptions.set(request.id, request);
      const updated = corridor.upcoming.map((item) =>
        item.intersectionId === intersectionId ? { ...item, cleared: true } : item,
      );
      const nextCorridor = Object.freeze({
        ...corridor,
        upcoming: Object.freeze(updated.map((item) => Object.freeze(item))),
        status: 'active',
      });
      corridors.set(corridorId, nextCorridor);

      audit?.record({
        action: 'signals.emergency-preemption',
        role,
        intersectionId,
        outcome: 'applied',
        mode: DATA_MODES.simulated,
        reason: request.reason,
        before: { ...request.before },
        after: { axis, holdMs: EMERGENCY_HOLD_MS },
      });
      publish({
        category: 'signal',
        type: 'signal-priority-active',
        severity: SEVERITY.critical,
        message: `SIGNAL PRIORITY ACTIVE — ${intersectionId} (${axis})`,
        mode: DATA_MODES.simulated,
        detail: {
          intersectionId,
          axis,
          reason: request.reason,
          durationS: Math.round(EMERGENCY_HOLD_MS / 1000),
          corridorId,
        },
      });
      return { ok: true, reason: null, request };
    },

    /** @returns {object[]} */
    listPreemptions() {
      return Object.freeze([...preemptions.values()]);
    },

    /**
     * Release a preemption and let the intersection return to adaptive timing.
     * @param {object} options
     * @param {string} options.corridorId
     * @param {object} options.controllers
     * @param {string} [options.role]
     * @returns {{ok:boolean, reason:string|null, released:string[]}}
     */
    releaseCorridor({ corridorId, controllers, role = null } = {}) {
      const corridor = corridors.get(corridorId);
      if (!corridor)
        return { ok: false, reason: 'unknown corridor', released: [] };
      const released = [];
      for (const [id, request] of preemptions) {
        if (request.corridorId !== corridorId) continue;
        const controller = controllers?.get?.(request.intersectionId);
        const result = controller?.returnToNormal?.({ signal: false });
        if (result?.ok) {
          preemptions.delete(id);
          released.push(request.intersectionId);
          audit?.record({
            action: 'signals.emergency-release',
            role,
            intersectionId: request.intersectionId,
            outcome: 'applied',
            mode: DATA_MODES.simulated,
            reason: 'corridor released',
          });
        }
      }
      const nextCorridor = Object.freeze({
        ...corridor,
        status: 'released',
        upcoming: Object.freeze(
          corridor.upcoming.map((item) => Object.freeze({ ...item, cleared: false })),
        ),
      });
      corridors.set(corridorId, nextCorridor);
      const vehicle = vehicles.get(corridor.vehicleId);
      if (vehicle) vehicles.set(corridor.vehicleId, { ...vehicle, status: 'cleared' });
      publish({
        category: 'signal',
        type: 'signal-restored',
        severity: SEVERITY.notice,
        message: `RESTORING NORMAL CONTROL — ${released.join(', ') || 'no active preemption'}`,
        mode: DATA_MODES.simulated,
        detail: { corridorId, released },
      });
      return { ok: true, reason: null, released };
    },

    /**
     * Advance a vehicle along its corridor.
     * @param {string} vehicleId @param {number} dtS
     * @returns {object|null} The updated vehicle.
     */
    advanceVehicle(vehicleId, dtS) {
      const vehicle = vehicles.get(vehicleId);
      if (!vehicle?.route || !isFiniteNumber(dtS) || dtS <= 0) return vehicle || null;
      const distance = EMERGENCY_TRAVEL_MPS * dtS;
      const waypoints = vehicle.route.geometry;
      if (!waypoints || waypoints.length < 2) return vehicle;
      // Project the vehicle between waypoints by arc length from the route start.
      const next = stepAlongRoute(vehicle, waypoints, distance);
      const updated = {
        ...vehicle,
        lon: next.lon,
        lat: next.lat,
        headingDeg: next.headingDeg,
        speedMps: EMERGENCY_TRAVEL_MPS,
        travelledM: (vehicle.travelledM || 0) + distance,
      };
      if (updated.travelledM >= vehicle.route.distanceM) {
        updated.status = 'arrived';
        updated.speedMps = 0;
      }
      vehicles.set(vehicleId, updated);
      return updated;
    },

    /**
     * Vehicles within a radius of a point, for the map and the alert panel.
     * @param {number} lon @param {number} lat @param {number} radiusM
     * @returns {object[]}
     */
    vehiclesNear(lon, lat, radiusM) {
      const out = [];
      for (const vehicle of vehicles.values()) {
        const distanceM = haversineM(lon, lat, vehicle.lon, vehicle.lat);
        if (distanceM <= radiusM) out.push(Object.freeze({ ...vehicle, distanceM }));
      }
      return Object.freeze(out);
    },

    /**
     * The intersections on a corridor that are still ahead of the vehicle.
     * @param {string} corridorId
     * @returns {object[]}
     */
    upcomingIntersections(corridorId) {
      const corridor = corridors.get(corridorId);
      if (!corridor) return [];
      return corridor.upcoming.filter((item) => !item.cleared);
    },

    clear() {
      vehicles.clear();
      corridors.clear();
      preemptions.clear();
    },
  };
  return Object.freeze(engine);
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Nearest graph node to a position. */
function nearestNodeId(graph, lon, lat) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of graph?.nodes?.values?.() || []) {
    const distance = haversineM(lon, lat, node.lon, node.lat);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node.id;
    }
  }
  return best;
}

/** Move a distance along a route's waypoints, clamped to the end. */
function stepAlongRoute(vehicle, waypoints, deltaM) {
  let remaining = (vehicle.travelledM || 0) + deltaM;
  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const [lonA, latA] = waypoints[i];
    const [lonB, latB] = waypoints[i + 1];
    const segment = haversineM(lonA, latA, lonB, latB);
    if (remaining <= segment || i === waypoints.length - 2) {
      const t = segment === 0 ? 0 : clamp(remaining / segment, 0, 1);
      return {
        lon: lonA + (lonB - lonA) * t,
        lat: latA + (latB - latA) * t,
        headingDeg: bearingDeg(lonA, latA, lonB, latB),
      };
    }
    remaining -= segment;
  }
  const [lon, lat] = waypoints[waypoints.length - 1];
  return { lon, lat, headingDeg: vehicle.headingDeg || 0 };
}

/**
 * Where a vehicle sits relative to an intersection, for the notice window.
 * @param {object} vehicle @param {object} intersection
 * @returns {{distanceM:number, approaching:boolean, etaS:number|null}}
 */
export function approachStatus(vehicle, intersection) {
  const distanceM = haversineM(vehicle.lon, vehicle.lat, intersection.lon, intersection.lat);
  return {
    distanceM: Math.round(distanceM),
    approaching: distanceM <= APPROACH_NOTICE_M,
    etaS: distanceM <= APPROACH_NOTICE_M
      ? Math.max(1, Math.round(distanceM / EMERGENCY_TRAVEL_MPS))
      : null,
  };
}

/**
 * Where an emergency vehicle would be in `seconds` at its modelled speed.
 * @param {object} vehicle @param {number} seconds
 * @returns {{lon:number,lat:number}|null}
 */
export function projectVehicle(vehicle, seconds) {
  if (!isFiniteNumber(seconds) || !isFiniteNumber(vehicle?.headingDeg)) return null;
  const { lon, lat } = destinationPoint(
    vehicle.lon,
    vehicle.lat,
    vehicle.headingDeg,
    EMERGENCY_TRAVEL_MPS * seconds,
  );
  return { lon, lat };
}

/** Every direction an intersection's approaches cover, for the UI table. */
export function approachTable(intersection) {
  return DIRECTIONS.map((direction) => {
    const approach = intersection?.approaches?.[direction];
    return {
      direction,
      roadName: approach?.roadName || 'unmapped',
      vehicleCount: approach?.vehicleCount ?? 0,
      queueM: approach?.queueM ?? 0,
      speedMps: approach?.speedMps ?? null,
      congestion: approach?.congestion ?? null,
      cameraId: approach?.cameraId || null,
      signalPhase: approach?.signalPhase || 'red',
      mode: intersection?.modes?.[direction]?.vehicleCount || intersection?.mode || DATA_MODES.unavailable,
    };
  });
}

/** The length of a corridor's geometry, for display and sanity checks. */
export function corridorLengthM(corridor) {
  return Math.round(polylineLengthM(corridor?.geometry || []));
}

/** A point partway along a corridor, for the corridor's progress readout. */
export function corridorPointAt(corridor, fraction) {
  const length = polylineLengthM(corridor?.geometry || []);
  return pointAlongPolyline(corridor?.geometry || [], length * clamp(fraction, 0, 1));
}
