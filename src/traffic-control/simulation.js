/**
 * @file Simulation engine and the operator-triggered scenarios.
 *
 * Everything this module produces is SIMULATED and says so. Its purpose is
 * that the platform is demonstrable without a city's worth of hardware: the
 * scenario set below drives the same code paths a live feed would, so the
 * signal transitions, the emergency corridor and the violation pipeline are
 * exercised by the demo exactly as they would be by reality.
 *
 * The engine is DETERMINISTIC for a given seed. That is not incidental — a
 * demo that cannot be replayed cannot be debugged, and an acceptance test that
 * cannot be replayed is not a test.
 *
 * @module traffic-control/simulation
 */

import {
  DATA_MODES,
  DEFAULT_OPERATING_MODE,
  DIRECTIONS,
  EMERGENCY_VEHICLE_TYPES,
  OPERATING_MODES,
  PHASE_GROUP_APPROACHES,
  approachAxis,
} from './policy.js';
import { clamp, haversineM, isFiniteNumber } from './geometry.js';
import {
  approachCongestion,
  intersectionPressure,
  queueLengthFromCount,
  recommendGreenSplit,
} from './congestion.js';
import { SEVERITY } from './events.js';

/** @const {string[]} Scenario identifiers the UI can trigger. */
export const SCENARIOS = Object.freeze([
  'traffic-jam',
  'red-light-violation',
  'ambulance',
  'fire-engine',
  'accident',
  'signal-failure',
  'camera-failure',
  'peak-hour',
]);

/** @const {Object<string,{label:string,description:string,glyph:string}>} */
export const SCENARIO_META = Object.freeze({
  'traffic-jam': Object.freeze({
    label: 'SIMULATE TRAFFIC JAM',
    description: 'Load one corridor until it queues and the optimizer reacts.',
    glyph: '⛔',
  }),
  'red-light-violation': Object.freeze({
    label: 'SIMULATE RED LIGHT VIOLATION',
    description: 'A tracked vehicle crosses a stop line on red and is logged.',
    glyph: '✖',
  }),
  ambulance: Object.freeze({
    label: 'SIMULATE AMBULANCE',
    description: 'Spawn an ambulance, plan its corridor and preempt signals.',
    glyph: '✚',
  }),
  'fire-engine': Object.freeze({
    label: 'SIMULATE FIRE ENGINE',
    description: 'Same corridor machinery, a fire appliance as the subject.',
    glyph: '🚒',
  }),
  accident: Object.freeze({
    label: 'SIMULATE ACCIDENT',
    description: 'Raise a collision incident with a recommended response.',
    glyph: '⚠',
  }),
  'signal-failure': Object.freeze({
    label: 'SIMULATE SIGNAL FAILURE',
    description: 'Drop one controller into fault and alert the operator.',
    glyph: '✖',
  }),
  'camera-failure': Object.freeze({
    label: 'SIMULATE CAMERA FAILURE',
    description: 'Take one camera down and record the coverage loss.',
    glyph: '📵',
  }),
  'peak-hour': Object.freeze({
    label: 'SIMULATE CITY PEAK HOUR',
    description: 'Raise demand network-wide, then let adaptive control respond.',
    glyph: '📈',
  }),
});

/**
 * A deterministic pseudo-random source.
 *
 * A 32-bit LCG, seeded per engine. Exposed as an object rather than a bare
 * function so a test can reset it and prove the same city comes back.
 * @param {number} [seed=1]
 * @returns {object}
 */
export function createRandom(seed = 1) {
  let state = (seed >>> 0) || 1;
  return Object.freeze({
    /** @returns {number} In [0, 1). */
    next() {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    },
    /** @param {number} min @param {number} max @returns {number} */
    range(min, max) {
      return min + this.next() * (max - min);
    },
    /** @param {number} max @returns {number} Integer in [0, max). */
    int(max) {
      return Math.floor(this.next() * max);
    },
    /** @param {object[]} items */
    pick(items) {
      return items[Math.floor(this.next() * items.length)];
    },
    /** @returns {number} The current raw state, for a replay log. */
    get state() {
      return state;
    },
  });
}

/**
 * Generate a demand profile for every approach in the network.
 *
 * Demand is expressed as arrivals per hour per approach, from the approach's
 * road class, and then modulated by the scenario's pressure so a jam is a
 * heavier load on the SAME geometry rather than different geometry.
 * @param {object} network
 * @param {object} [options]
 * @param {number} [options.pressure=0.5] - 0–1 network load.
 * @param {object} [options.random]
 * @param {string[]} [options.corridorIntersectionIds]
 * @returns {Map<string, object>} intersectionId → per-direction demand.
 */
export function generateDemand(network, { pressure = 0.5, random = createRandom(1), corridorIntersectionIds = [] } = {}) {
  const corridor = new Set(corridorIntersectionIds);
  /** @type {Map<string, object>} */
  const demand = new Map();
  for (const intersection of network.intersections) {
    const perDirection = {};
    for (const direction of DIRECTIONS) {
      const approach = intersection.approaches[direction];
      const base = approach.roadClass === 'motorway' || approach.roadClass === 'trunk'
        ? 1400
        : approach.roadClass === 'primary'
          ? 900
          : approach.roadClass === 'secondary'
            ? 600
            : 320;
      const corridorBoost = corridor.has(intersection.id) && (direction === 'N' || direction === 'S')
        ? 1.8
        : 1;
      const jitter = 0.85 + random.next() * 0.3;
      perDirection[direction] = Math.round(
        base * (0.35 + clamp(pressure, 0, 1) * 1.5) * corridorBoost * jitter,
      );
    }
    demand.set(intersection.id, perDirection);
  }
  return demand;
}

/**
 * Advance the traffic state one simulated step.
 *
 * Each approach moves toward the demand its arrivals imply. A served approach
 * (green) drains and speeds up; an unserved one (red) accumulates and queues.
 * The result is a new intersection record — the function does not mutate.
 * @param {object} intersection
 * @param {object} demand - Per-direction arrivals/hour.
 * @param {object} [options]
 * @param {number} [options.dtS=1]
 * @param {object} [options.random]
 * @returns {object} A new intersection.
 */
export function advanceIntersection(intersection, demand, { dtS = 1, random = createRandom(1) } = {}) {
  const approaches = {};
  for (const direction of DIRECTIONS) {
    const approach = intersection.approaches[direction];
    const arrivals = demand?.[direction] ?? 0;
    const state = approach.signalPhase;
    const lanes = Math.max(1, approach.lanes);
    const saturated = 1800 * lanes;
    // Vehicles arriving this step.
    const arriving = (arrivals / 3600) * dtS;
    // Vehicles the approach can discharge: green releases at saturation,
    // amber and red release nothing.
    const discharging = state === 'green'
      ? Math.min(
          approach.queueVehicles + arriving,
          (saturated / 3600) * dtS * 1.15,
        )
      : 0;
    const queueVehicles = Math.max(
      0,
      approach.queueVehicles + arriving - discharging,
    );
    // Speed falls as the queue fills the approach.
    const fill = clamp(queueVehicles / Math.max(1, (approach.lengthM / 1000) * 130 * lanes), 0, 1);
    const free = approach.freeFlowMps || 13.9;
    const speedMps = state === 'green' ? free * (1 - fill * 0.6) : free * (1 - fill * 0.95);
    const queueM = queueLengthFromCount(queueVehicles, lanes);
    const congestion = clamp(
      Math.max(1 - speedMps / Math.max(0.001, free), fill),
      0,
      1,
    );
    void random;
    approaches[direction] = Object.freeze({
      ...approach,
      vehicleCount: Math.round(approach.vehicleCount + queueVehicles - approach.queueVehicles),
      queueVehicles: Math.round(queueVehicles * 10) / 10,
      queueM: Math.round(queueM),
      speedMps: Math.round(speedMps * 10) / 10,
      congestion: Math.round(congestion * 100) / 100,
    });
  }
  return Object.freeze({
    ...intersection,
    approaches: Object.freeze(approaches),
    modes: Object.freeze(
      Object.fromEntries(
        DIRECTIONS.map((direction) => [
          direction,
          {
            vehicleCount: DATA_MODES.simulated,
            queueM: DATA_MODES.simulated,
            speedMps: DATA_MODES.simulated,
            congestion: DATA_MODES.simulated,
          },
        ]),
      ),
    ),
  });
}

/**
 * Apply a controller's current signal state onto an intersection's approaches.
 * @param {object} intersection
 * @param {object} signal - A signal group.
 * @returns {object} A new intersection with `signalPhase` filled in.
 */
export function applySignalState(intersection, signal) {
  if (!signal?.states) return intersection;
  const approaches = {};
  for (const direction of DIRECTIONS) {
    approaches[direction] = Object.freeze({
      ...intersection.approaches[direction],
      signalPhase: signal.states[direction] || 'red',
    });
  }
  return Object.freeze({
    ...intersection,
    approaches: Object.freeze(approaches),
    controllerId: signal.intersectionId,
  });
}

/**
 * The full demonstration, as a schedule the API returns alongside a run.
 *
 * The demo builds traffic on one corridor, has the optimizer react, runs an
 * ambulance down the same corridor, then logs a red-light violation at another
 * intersection. It is expressed as a timeline rather than a script of
 * imperative calls, so what the demo does is readable in one place and each
 * step is individually testable.
 *
 * Each `id` is the stage key `runFullDemo` records, so the plan a caller reads
 * and the stage report it receives name the same things. `scenario` is the
 * engine scenario that stage runs; `corridor-run` and `release` have none
 * because they advance and release the corridor the ambulance stage created.
 * @const {object[]}
 */
export const DEMO_SCENARIO = Object.freeze([
  Object.freeze({
    at: 0,
    id: 'traffic-jam',
    label: 'Traffic increases on the east corridor',
    scenario: 'traffic-jam',
  }),
  Object.freeze({
    at: 3000,
    id: 'optimize',
    label: 'Adaptive optimizer revises the corridor timing',
    // Engine method rather than a runnable scenario.
    scenario: null,
  }),
  Object.freeze({
    at: 6000,
    id: 'ambulance',
    label: 'Ambulance appears and a corridor is planned',
    scenario: 'ambulance',
  }),
  Object.freeze({
    at: 9000,
    id: 'corridor-run',
    label: 'Corridor preempted in simulation and vehicle advanced',
    scenario: null,
  }),
  Object.freeze({
    at: 12000,
    id: 'release',
    label: 'Ambulance passes; normal adaptive control resumes',
    scenario: null,
  }),
  Object.freeze({
    at: 15000,
    id: 'violation',
    label: 'Red-light violation detected and queued for review',
    scenario: 'red-light-violation',
  }),
]);

/**
 * Build the scenario runner.
 *
 * Each scenario is a function over the engine context, so a new scenario is an
 * addition to one table rather than a change to a switch.
 * @param {object} context
 * @returns {object}
 */
export function createScenarioRunner(context) {
  const {
    network,
    controllers,
    emergency,
    violations,
    incidents,
    events,
    audit,
    random,
    cameras,
    updateIntersection,
    getIntersection,
    operatingMode,
  } = context;

  const pickIntersection = (predicate = () => true) => {
    const candidates = network.intersections.filter(predicate);
    if (!candidates.length) return network.intersections[0] || null;
    return candidates[random.int(candidates.length)];
  };

  /** Ids of the busiest corridor, discovered from the network rather than assumed. */
  const corridorIds = () => {
    // Prefer intersections whose approaches include a major road: that is what
    // "a corridor" means in the data, so the scenario adapts to the city.
    const major = network.intersections.filter((intersection) => {
      for (const direction of DIRECTIONS) {
        const cls = intersection.approaches[direction].roadClass;
        if (cls === 'motorway' || cls === 'trunk' || cls === 'primary') return true;
      }
      return false;
    });
    const chosen = (major.length ? major : network.intersections).slice(0, 4);
    return chosen.map((intersection) => intersection.id);
  };

  /**
   * Every id a scenario can be run under.
   *
   * The scenario runner's own verbs (`emergency`, `incident`, `optimize`,
   * `preempt`, `release`) are the primitives; the ids in `SCENARIO_META` are
   * what the UI's buttons are named. Aliases keep one implementation per
   * behaviour while letting the button say `ambulance` rather than `emergency`.
   */
  const ALIASES = Object.freeze({
    ambulance: { scenario: 'emergency', options: () => ({ type: 'ambulance' }) },
    'fire-engine': { scenario: 'emergency', options: () => ({ type: 'fire-engine' }) },
    accident: { scenario: 'incident', options: () => ({ type: 'ACCIDENT' }) },
    'signal-failure': { scenario: 'signal-failure', options: () => ({}) },
    'camera-failure': { scenario: 'camera-failure', options: () => ({}) },
  });

  const scenarios = {
    /**
     * Load a corridor with traffic until it queues.
     * @param {object} [options]
     * @param {number} [options.pressure=0.9]
     * @returns {object}
     */
    'traffic-jam'({ pressure = 0.9 } = {}) {
      const ids = corridorIds();
      const demand = generateDemand(network, {
        pressure,
        random,
        corridorIntersectionIds: ids,
      });
      let changed = 0;
      for (const id of ids) {
        const intersection = getIntersection(id);
        if (!intersection) continue;
        let next = intersection;
        // Run the corridor forward a few steps so the queue is established and
        // the optimizer has something real to react to.
        for (let step = 0; step < 8; step += 1) {
          next = advanceIntersection(next, demand.get(id), { dtS: 6, random });
          const signal = controllers.get(id)?.getSignalState();
          if (signal) next = applySignalState(next, signal);
        }
        updateIntersection(next);
        changed += 1;
      }
      events.publish({
        category: 'traffic',
        type: 'corridor-loaded',
        severity: SEVERITY.warning,
        message: `TRAFFIC JAM SIMULATED — ${changed} intersections on the corridor`,
        mode: DATA_MODES.simulated,
        detail: { intersectionIds: ids, pressure },
      });
      return { ok: true, intersections: ids, pressure };
    },

    /**
     * Ask the optimizer for a fresh split on every pressured intersection and,
     * in simulation mode, apply it through the safe phase machine.
     * @returns {object}
     */
    optimize() {
      const applied = [];
      for (const intersection of network.intersections) {
        const current = getIntersection(intersection.id);
        if (!current) continue;
        const { pressure } = intersectionPressure(current);
        if (pressure < 0.35) continue;
        const recommendation = recommendGreenSplit(current);
        if (!recommendation) continue;
        const controller = controllers.get(intersection.id);
        if (!controller) continue;
        // Recommendation mode never applies. This is the single place the
        // operating mode changes what the engine does, rather than the UI.
        const mode = operatingMode();
        if (mode === OPERATING_MODES.recommendation) {
          applied.push({ intersectionId: intersection.id, applied: false, recommendation });
          continue;
        }
        const axis = PHASE_GROUP_APPROACHES.NS ? 'NS' : 'NS';
        const currentSignal = controller.getSignalState();
        if (currentSignal.group !== axis) {
          applied.push({ intersectionId: intersection.id, applied: false, recommendation });
          continue;
        }
        const delta = recommendation.recommended.NS - currentSignal.greenMs;
        if (Math.abs(delta) < 3000) continue;
        const result = delta > 0
          ? controller.extendGreen(delta)
          : controller.shortenGreen(-delta);
        if (!result.ok) continue;
        audit.record({
          action: 'signals.adaptive-timing',
          role: 'adaptive-optimizer',
          intersectionId: intersection.id,
          outcome: 'applied',
          mode: DATA_MODES.simulated,
          reason: recommendation.reason,
          before: { NS: currentSignal.greenMs, EW: recommendation.current.EW },
          after: { NS: recommendation.recommended.NS, EW: recommendation.recommended.EW },
        });
        events.publish({
          category: 'signal',
          type: 'adaptive-recommendation',
          severity: SEVERITY.notice,
          message: `ADAPTIVE SIGNAL RECOMMENDATION — ${intersection.id} NS green ${Math.round(currentSignal.greenMs / 1000)}s → ${Math.round(recommendation.recommended.NS / 1000)}s`,
          mode: DATA_MODES.simulated,
          detail: {
            intersectionId: intersection.id,
            reason: recommendation.reason,
            from: Math.round(currentSignal.greenMs / 1000),
            to: Math.round(recommendation.recommended.NS / 1000),
            confidence: Number(recommendation.confidence.toFixed(2)),
          },
        });
        applied.push({
          intersectionId: intersection.id,
          applied: true,
          recommendation,
          signal: result.signal,
        });
      }
      return { ok: true, applied };
    },

    /**
     * Spawn an emergency vehicle and plan its corridor.
     * @param {object} [options]
     * @param {string} [options.type='ambulance']
     * @returns {object|null}
     */
    emergency({ type = 'ambulance' } = {}) {
      if (!EMERGENCY_VEHICLE_TYPES.includes(type)) return null;
      const ids = corridorIds();
      if (ids.length < 2) return null;
      const startNode = network.intersections.find((i) => i.id === ids[0]) || network.intersections[0];
      const endNode = network.intersections.find((i) => i.id === ids[ids.length - 1]) || network.intersections[1];
      if (!startNode || !endNode) return null;
      // Spawn on the approach into the first intersection, so the vehicle is
      // genuinely inbound rather than sitting on the junction.
      const approach = network.intersections.find((i) => i.id === startNode.id)?.approaches?.S;
      const spawnLon = approach ? startNode.lon : startNode.lon;
      const spawnLat = approach ? startNode.lat - 0.004 : startNode.lat;
      const vehicle = emergency.spawnVehicle({
        type,
        lon: spawnLon,
        lat: spawnLat,
        detection: { band: 'high', confidence: 0.9, reasons: ['simulated scenario'] },
        label: `${type} approaching ${startNode.name}`,
      });
      const graph = context.routingGraph();
      const corridor = emergency.planCorridor({
        vehicleId: vehicle.id,
        graph,
        toId: endNode.id,
      });
      return { vehicle, corridor };
    },

    /**
     * Preempt the next un-cleared intersection on every active corridor.
     * @returns {object}
     */
    preempt() {
      const requests = [];
      for (const corridor of emergency.listCorridors()) {
        if (corridor.status === 'released') continue;
        const upcoming = emergency.upcomingIntersections(corridor.id);
        const next = upcoming[0];
        if (!next) continue;
        const result = emergency.requestPreemption({
          corridorId: corridor.id,
          intersectionId: next.intersectionId,
          controllers,
          role: 'traffic-control',
        });
        if (result.ok) {
          const controller = controllers.get(next.intersectionId);
          const signal = controller?.getSignalState();
          const intersection = getIntersection(next.intersectionId);
          if (signal && intersection)
            updateIntersection(applySignalState(intersection, signal));
          requests.push(result.request);
        }
      }
      return { ok: requests.length > 0, requests };
    },

    /**
     * Release every active corridor and restore normal control.
     * @returns {object}
     */
    release() {
      const released = [];
      for (const corridor of emergency.listCorridors()) {
        if (corridor.status === 'released') continue;
        const result = emergency.releaseCorridor({
          corridorId: corridor.id,
          controllers,
          role: 'traffic-control',
        });
        released.push(...result.released);
      }
      return { ok: true, released };
    },

    /**
     * A tracked vehicle crosses a stop line on red.
     * @param {object} [options]
     * @param {number} [options.confidence=0.94]
     * @returns {object|null}
     */
    'red-light-violation'({ confidence = 0.94 } = {}) {
      // Choose an intersection that is actually showing red on one axis, so the
      // violation is consistent with the state the platform believes.
      const candidates = network.intersections.filter((intersection) => {
        const signal = controllers.get(intersection.id)?.getSignalState();
        return Boolean(signal);
      });
      const intersection = candidates.length
        ? candidates[random.int(candidates.length)]
        : network.intersections[0];
      if (!intersection) return null;
      const signal = controllers.get(intersection.id)?.getSignalState();
      const redDirection = DIRECTIONS.find(
        (direction) => signal?.states?.[direction] === 'red',
      ) || 'E';
      const cameraId = intersection.approaches[redDirection]?.cameraId
        || `CAM-${intersection.id}`;
      const trackId = `TRK-${String(random.int(99999)).padStart(5, '0')}`;
      const detection = {
        trackId,
        vehicleClass: 'car',
        confidence,
        cameraId,
        box: [412, 380, 96, 72],
        stopLineOffsetM: 3.4,
        mode: DATA_MODES.simulated,
      };
      const plate = context.readPlate({
        trackId,
        quality: context.plateQualityFor(cameraId),
        jurisdiction: 'default',
        detection,
        cameraId,
        at: context.clock(),
        frameRef: `${cameraId}/frame/${context.clock()}`,
      });
      return violations.recordWithPlate({
        ruleId: 'RED_LIGHT',
        detection,
        cameraId,
        intersectionId: intersection.id,
        observation: {
          signalState: signal?.states?.[redDirection] || 'red',
          crossedStopLine: true,
          confidence,
          stopLineOffsetM: 3.4,
        },
        plate,
        frameRef: `${cameraId}/frame/${context.clock()}`,
        at: context.clock(),
      });
    },

    /**
     * Raise an incident with a recommended response.
     * @param {object} [options]
     * @param {string} [options.type='ACCIDENT']
     * @returns {object|null}
     */
    incident({ type = 'ACCIDENT' } = {}) {
      const intersection = pickIntersection();
      if (!intersection) return null;
      const roadId = intersection.approaches.N.roadId
        || intersection.approaches.E.roadId
        || null;
      return incidents.raise({
        type,
        lon: intersection.lon,
        lat: intersection.lat,
        source: 'simulation',
        confidence: 0.85,
        affectedRoadIds: roadId ? [roadId] : [],
        affectedIntersectionIds: [intersection.id],
        detail: `${type.replace(/_/g, ' ').toLowerCase()} reported at ${intersection.name}`,
        mode: DATA_MODES.simulated,
      });
    },

    /**
     * Drop a controller into fault.
     * @returns {object|null}
     */
    'signal-failure'() {
      const intersection = pickIntersection();
      if (!intersection) return null;
      const controller = controllers.get(intersection.id);
      if (!controller) return null;
      controller.setFault('simulated controller offline');
      const incident = incidents.raise({
        type: 'TRAFFIC_SIGNAL_FAILURE',
        lon: intersection.lon,
        lat: intersection.lat,
        source: 'controller-monitor',
        confidence: 1,
        affectedIntersectionIds: [intersection.id],
        detail: `${intersection.name} signal controller offline`,
        mode: DATA_MODES.simulated,
      });
      updateIntersection(
        applySignalState(getIntersection(intersection.id) || intersection, controller.getSignalState()),
      );
      events.publish({
        category: 'signal',
        type: 'signal-failure',
        severity: SEVERITY.critical,
        message: `SIGNAL CONTROLLER FAULT — ${intersection.id}`,
        mode: DATA_MODES.simulated,
        detail: { intersectionId: intersection.id, incidentId: incident?.id || null },
      });
      return { intersectionId: intersection.id, incident };
    },

    /**
     * Take a camera down.
     * @returns {object|null}
     */
    'camera-failure'() {
      const list = cameras.list();
      if (!list.length) return null;
      const camera = list[random.int(list.length)];
      const updated = cameras.setStatus(camera.id, {
        status: 'degraded',
        sourceKind: camera.sourceKind || 'simulated',
        message: 'simulated feed loss',
      });
      const incident = incidents.raise({
        type: 'CAMERA_FAILURE',
        lon: camera.lon,
        lat: camera.lat,
        source: 'camera-monitor',
        confidence: 1,
        detail: `${camera.id} feed unavailable`,
        mode: DATA_MODES.simulated,
      });
      events.publish({
        category: 'camera',
        type: 'camera-failure',
        severity: SEVERITY.warning,
        message: `CAMERA FAILURE — ${camera.id}`,
        mode: DATA_MODES.simulated,
        detail: { cameraId: camera.id, incidentId: incident?.id || null },
      });
      return { camera: updated, incident };
    },

    /**
     * Raise demand across the whole network.
     * @param {object} [options]
     * @param {number} [options.pressure=0.85]
     * @returns {object}
     */
    'peak-hour'({ pressure = 0.85 } = {}) {
      const demand = generateDemand(network, { pressure, random });
      let changed = 0;
      for (const intersection of network.intersections) {
        let next = getIntersection(intersection.id) || intersection;
        for (let step = 0; step < 4; step += 1) {
          next = advanceIntersection(next, demand.get(intersection.id), {
            dtS: 5,
            random,
          });
          const signal = controllers.get(intersection.id)?.getSignalState();
          if (signal) next = applySignalState(next, signal);
        }
        updateIntersection(next);
        changed += 1;
      }
      events.publish({
        category: 'traffic',
        type: 'peak-hour',
        severity: SEVERITY.warning,
        message: `CITY PEAK HOUR SIMULATED — ${changed} intersections loaded`,
        mode: DATA_MODES.simulated,
        detail: { pressure, intersections: changed },
      });
      return { ok: true, intersections: changed, pressure };
    },
  };

  return Object.freeze({
    /**
     * Run a scenario by id.
     * @param {string} id
     * @param {object} [options]
     * @returns {{ok:boolean, scenario:string, result:object|null, reason:string|null}}
     */
    run(id, options = {}) {
      const alias = ALIASES[id];
      const scenarioId = alias ? alias.scenario : id;
      const scenario = scenarios[scenarioId];
      if (!scenario)
        return { ok: false, scenario: id, result: null, reason: `unknown scenario: ${id}` };
      const merged = alias ? { ...alias.options(), ...options } : options;
      const result = scenario(merged);
      return { ok: true, scenario: id, result, reason: null };
    },
    /** @returns {string[]} Every runnable id, aliases included. */
    list() {
      return [...new Set([...Object.keys(scenarios), ...Object.keys(ALIASES)])].sort();
    },
  });
}

/**
 * Run one simulated control step across every intersection.
 *
 * Called on a timer by the engine while the simulation is running. It advances
 * demand, applies whatever phase each controller is in, and re-derives the
 * derived readouts (pressure, congestion) the UI shows.
 * @param {object} options
 * @returns {object} A summary of the step.
 */
export function runSimulationStep({
  network,
  controllers,
  demand,
  stepS = 1,
  random,
  getIntersection,
  updateIntersection,
}) {
  let updated = 0;
  let totalQueueVehicles = 0;
  for (const intersection of network.intersections) {
    const current = getIntersection(intersection.id) || intersection;
    let next = advanceIntersection(current, demand.get(intersection.id), {
      dtS: stepS,
      random,
    });
    const signal = controllers.get(intersection.id)?.getSignalState();
    if (signal) next = applySignalState(next, signal);
    updateIntersection(next);
    updated += 1;
    for (const direction of DIRECTIONS)
      totalQueueVehicles += next.approaches[direction].queueVehicles || 0;
  }
  return {
    updated,
    totalQueueVehicles: Math.round(totalQueueVehicles),
    stepS,
    mode: DATA_MODES.simulated,
  };
}

/**
 * Resolve an operating-mode request against capability.
 *
 * `authorized-control` is refused because no authorized controller integration
 * exists. Rule 6 needs one place that says no, and this is it.
 * @param {string} requested
 * @param {object} [options]
 * @param {boolean} [options.authorizedControllerConfigured=false]
 * @returns {{mode:string, reason:string|null, refused:boolean}}
 */
export function resolveOperatingMode(requested, { authorizedControllerConfigured = false } = {}) {
  if (requested === OPERATING_MODES.authorizedControl) {
    if (!authorizedControllerConfigured) {
      return {
        mode: DEFAULT_OPERATING_MODE,
        reason:
          'authorized control requires a configured, verified signal-controller integration',
        refused: true,
      };
    }
    return { mode: requested, reason: null, refused: false };
  }
  if (requested === OPERATING_MODES.recommendation)
    return { mode: requested, reason: null, refused: false };
  if (requested === OPERATING_MODES.simulation)
    return { mode: requested, reason: null, refused: false };
  return {
    mode: DEFAULT_OPERATING_MODE,
    reason: `unknown operating mode: ${requested}`,
    refused: true,
  };
}

/** Distance from a position to the nearest intersection, and which one. */
export function nearestIntersection(intersections, lon, lat) {
  let best = null;
  let bestDistance = Infinity;
  for (const intersection of intersections) {
    const distance = haversineM(lon, lat, intersection.lon, intersection.lat);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = intersection;
    }
  }
  return best ? { intersection: best, distanceM: Math.round(bestDistance) } : null;
}

/** Whether a value looks like a plausible operating mode for the API layer. */
export function isOperatingMode(value) {
  return Object.values(OPERATING_MODES).includes(value);
}

/** Whether a direction string is one of the four cardinal approaches. */
export function isDirection(value) {
  return DIRECTIONS.includes(value);
}

/** Congestion of one approach, exported for the API's per-approach readout. */
export { approachCongestion };
