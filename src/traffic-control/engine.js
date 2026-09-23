/**
 * @file The city traffic-control engine — the single owner of platform state.
 *
 * Everything above this file is a pure function or a small service. This is
 * where they are composed: the network, one signal controller per intersection,
 * the congestion reads, the emergency engine, the violation queue, the incident
 * log, cameras, the event stream, the audit log and the scenario runner.
 *
 * DESIGN RULES THIS ENGINE ENFORCES:
 *
 *  - One store, one clock. Every module gets the same injected clock, so a
 *    simulated city and its event stream are consistent.
 *  - Modes are decided here, not by whoever calls in. Every read names the mode
 *    of the facts behind it.
 *  - No method mutates a caller's object. State changes go through
 *    `updateIntersection`, which is the only writer.
 *  - A consequential command is audited at the engine boundary, even when the
 *    sub-engine already recorded it, because the caller's role is known here.
 *
 * The engine is designed to be run server-side. See server/providers for the
 * HTTP surface; the browser layer never owns this state, which is what keeps
 * secrets out of client code and makes one city shared by every operator.
 *
 * @module traffic-control/engine
 */

import {
  DEFAULT_OPERATING_MODE,
  DATA_MODES,
  DIRECTIONS,
  OPERATING_MODES,
  approachAxis,
} from './policy.js';
import { clamp, isFiniteNumber } from './geometry.js';
import { buildRoadNetwork, freeFlowMps, withRoadState } from './network.js';
import {
  cityTrafficSummary,
  classifyIntersection,
  congestionScore,
  intersectionPressure,
  queueLengthFromCount,
  recommendGreenSplit,
  levelOfService,
  estimateDelay,
} from './congestion.js';
import { createSimulatedSignalController, describeController } from './signals.js';
import {
  buildRoutingGraph,
  createEmergencyEngine,
  fuseEmergencyDetection,
} from './emergency.js';
import {
  createAuditLog,
  createConfirmationGate,
  createEventBus,
  SEVERITY,
} from './events.js';
import { createIncidentEngine, detectSignalFailure } from './incidents.js';
import { createViolationEngine, createRuleSet, DEFAULT_RULES } from './violations.js';
import { createCameraRegistry } from './cameras.js';
import {
  applySignalState,
  createRandom,
  createScenarioRunner,
  generateDemand,
  resolveOperatingMode,
  runSimulationStep,
  SCENARIO_META,
} from './simulation.js';
import {
  createDetectorRegistry,
  createPlateReader,
  createSimulatedDetector,
  createVehicleTracker,
  runDetectionPipeline,
  detectionCensus,
} from './vision.js';

/** @const {number} How long a simulated control step represents, in seconds. */
export const SIMULATION_STEP_S = 2;

/** @const {number} ms between simulated control steps on the wall clock. */
export const SIMULATION_TICK_MS = 2000;

/**
 * Create the engine.
 *
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @param {number} [options.seed=1]
 * @param {number} [options.maxIntersections=40]
 * @param {object[]} [options.rules] - Override the default rule catalogue.
 * @param {object[]} [options.cameras] - Configured cameras to register.
 * @returns {object} The engine.
 */
export function createTrafficControlEngine({
  clock = () => Date.now(),
  seed = 1,
  maxIntersections = 40,
  rules = DEFAULT_RULES,
  cameras = [],
} = {}) {
  const random = createRandom(seed);
  const events = createEventBus({ clock });
  const audit = createAuditLog({ clock });
  const confirmations = createConfirmationGate({ clock });
  const emit = (event) => events.publish(event);

  const cameraRegistry = createCameraRegistry({ clock });
  if (cameras.length) cameraRegistry.load(cameras);

  const incidentEngine = createIncidentEngine({ clock, emit, audit });
  const violationEngine = createViolationEngine({
    clock,
    emit,
    audit,
    rules: createRuleSet(rules),
  });
  const emergencyEngine = createEmergencyEngine({ clock, emit, audit });

  const detectors = createDetectorRegistry();
  detectors.register(createSimulatedDetector({ seed }));
  const tracker = createVehicleTracker({ clock });
  const plateReaders = createPlateReader({ seed });

  /** @type {Map<string, object>} intersectionId → intersection */
  const intersections = new Map();
  /** @type {Map<string, object>} intersectionId → controller */
  const controllers = new Map();
  /** @type {Map<string, object>} roadId → road */
  let roads = new Map();
  /** @type {object|null} */
  let network = null;
  /** @type {object|null} */
  let routingGraph = null;
  /** @type {Map<string, object>} */
  let demand = new Map();
  let operatingMode = DEFAULT_OPERATING_MODE;
  let simulationRunning = false;
  let simulationSteps = 0;
  let lastStepAt = null;
  let simulationTimer = null;

  // A representative camera for each intersection, so an intersection without a
  // configured feed still has a coverage story the detector can be shown
  // against — labelled SIMULATED, because that is what it is.
  const syntheticCameras = [];

  const engine = {
    // ── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Build the city from road geometry.
     *
     * Idempotent per call: calling it again with new geometry replaces the
     * network and rebuilds the controllers, which is what a viewport move that
     * discovers new roads should do.
     * @param {object[]} rawRoads - Roads from the traffic layer's Overpass path.
     * @returns {object} A summary of what was built.
     */
    loadNetwork(rawRoads = []) {
      const built = buildRoadNetwork(rawRoads, {
        maxIntersections,
        cameras: [],
        mode: DATA_MODES.simulated,
      });
      network = built;
      intersections.clear();
      roads = new Map(built.roads.map((road) => [road.id, road]));

      // One synthetic camera per intersection approach, so every approach a
      // violation can occur on has a camera to attribute. Real, configured
      // cameras registered by the caller are bound afterwards and take
      // precedence in the readout.
      syntheticCameras.length = 0;
      for (const intersection of built.intersections) {
        for (const direction of DIRECTIONS) {
          const id = `SIM-CAM-${intersection.id}-${direction}`;
          syntheticCameras.push({
            id,
            name: `${intersection.name} ${direction}`,
            lon: intersection.lon,
            lat: intersection.lat,
            feedType: 'simulated',
            provider: 'Traffic control simulator',
            sourceKind: 'simulated',
            mode: DATA_MODES.simulated,
          });
        }
        let next = intersection;
        // Every approach gets a signal phase and a plausible baseline so the
        // very first render has something to show.
        next = this._seedIntersection(intersection);
        intersections.set(intersection.id, next);
        controllers.get(intersection.id)?.dispose();
        controllers.set(
          intersection.id,
          createSimulatedSignalController({ intersectionId: intersection.id, clock }),
        );
      }

      // Bind the real camera catalog onto the network, then the synthetic ones.
      cameraRegistry.bindToIntersections(built.intersections, 80);
      for (const camera of syntheticCameras) {
        if (cameraRegistry.get(camera.id)) continue;
        cameraRegistry.upsert(camera);
      }
      cameraRegistry.bindToIntersections(built.intersections, 80);

      // `roads` on the engine follows the network's own link pass, so a road's
      // intersectionIds reflect the intersections that actually survived.
      roads = new Map(built.roads.map((road) => [road.id, road]));

      routingGraph = buildRoutingGraph(network);
      demand = generateDemand(network, { pressure: 0.35, random });

      events.publish({
        category: 'system',
        type: 'network-loaded',
        severity: SEVERITY.notice,
        message: `City network loaded — ${built.intersections.length} intersections, ${built.roads.length} roads`,
        mode: DATA_MODES.simulated,
        detail: {
          intersections: built.intersections.length,
          roads: built.roads.length,
        },
      });
      return {
        intersections: built.intersections.length,
        roads: built.roads.length,
        bounds: built.bounds,
        cameras: cameraRegistry.summary(),
      };
    },

    /** Give a fresh intersection a baseline state and a signal phase. */
    _seedIntersection(intersection) {
      const approaches = {};
      for (const direction of DIRECTIONS) {
        const approach = intersection.approaches[direction];
        const lanes = Math.max(1, approach.lanes);
        // A baseline that is deliberately empty rather than invented: the city
        // starts with no queue and a free-flowing speed, and the simulator
        // fills it from there. That is why the initial readout can honestly say
        // SIMULATED — 0 vehicles rather than a fabricated rush hour.
        approaches[direction] = Object.freeze({
          ...approach,
          freeFlowMps: freeFlowMps(approach.roadClass),
          lanes,
          vehicleCount: 0,
          queueVehicles: 0,
          queueM: 0,
          speedMps: freeFlowMps(approach.roadClass),
          congestion: 0,
          signalPhase: 'red',
        });
      }
      return Object.freeze({ ...intersection, approaches: Object.freeze(approaches) });
    },

    /**
     * Dispose timers. Called by the server on teardown.
     */
    dispose() {
      engine.setSimulationRunning({ running: false });
      for (const controller of controllers.values()) controller.dispose();
    },

    // ── Reads ─────────────────────────────────────────────────────────────

    /** @returns {object} The whole-city status payload. */
    getStatus() {
      const list = [...intersections.values()];
      const summary = cityTrafficSummary(list, [...roads.values()]);
      const camerasSummary = cameraRegistry.summary();
      const violations = violationEngine.summary();
      const incidents = incidentEngine.summary();
      const vehicles = emergencyEngine.listVehicles();
      const signalHealth = engine.getSignalHealth();
      return Object.freeze({
        city: {
          intersections: list.length,
          signalized: summary.signalized,
          roads: summary.roads,
          cameras: camerasSummary.total,
        },
        congestion: {
          congestedRoads: summary.congestedRoads,
          slowRoads: summary.slowRoads,
          freeRoads: summary.freeRoads,
          unknownRoads: summary.unknownRoads,
          totalQueueM: summary.totalQueueM,
          meanSpeedMps: summary.meanSpeedMps,
          busiestIntersectionId: summary.busiestIntersectionId,
          worstPressure: summary.worstPressure,
        },
        incidents: { open: incidents.open, critical: incidents.critical },
        emergency: {
          vehicles: vehicles.filter((v) => v.status !== 'cleared').length,
          corridors: emergencyEngine.listCorridors().filter((c) => c.status !== 'released').length,
          preemptions: emergencyEngine.listPreemptions().length,
        },
        violations: { pending: violations.pending, total: violations.total },
        health: {
          cameras: camerasSummary,
          signals: signalHealth,
        },
        modes: {
          traffic: summary.mode,
          cameras: camerasSummary.mode,
          signals: DATA_MODES.simulated,
          emergency: vehicles.length ? DATA_MODES.simulated : DATA_MODES.unavailable,
        },
        operatingMode,
        simulation: {
          running: simulationRunning,
          steps: simulationSteps,
          lastStepAt,
          seed,
          stepSeconds: SIMULATION_STEP_S,
        },
        events: events.count,
        audit: audit.size,
        generatedAt: clock(),
      });
    },

    /** @returns {object[]} Every road, with its derived state. */
    getRoads() {
      return Object.freeze([...roads.values()]);
    },

    /** @param {string} id @returns {object|null} */
    getRoad(id) {
      return roads.get(id) || null;
    },

    /** @returns {object[]} Every intersection, signal state applied. */
    getIntersections() {
      const out = [];
      for (const intersection of intersections.values()) {
        const controller = controllers.get(intersection.id);
        const signal = controller?.getSignalState();
        out.push(
          Object.freeze({
            ...intersection,
            signal: signal || null,
            health: controller?.getHealth().status || 'unknown',
            classification: classifyIntersection({
              ...intersection,
              health: controller?.getHealth().status,
            }),
            pressure: intersectionPressure(intersection).pressure,
          }),
        );
      }
      return Object.freeze(out);
    },

    /** @param {string} id @returns {object|null} */
    getIntersection(id) {
      const intersection = intersections.get(id);
      if (!intersection) return null;
      const controller = controllers.get(id);
      const signal = controller?.getSignalState() || null;
      const health = controller?.getHealth() || null;
      const pressure = intersectionPressure(intersection);
      const recommendation = recommendGreenSplit(intersection);
      return Object.freeze({
        ...intersection,
        signal,
        health,
        pressure,
        classification: classifyIntersection({ ...intersection, health: health?.status }),
        recommendation,
        controller: describeController(controller),
        cameras: cameraRegistry.forIntersection(id),
        upcomingIncidents: incidentEngine
          .list({ status: 'open' })
          .filter((incident) => incident.affectedIntersectionIds.includes(id)),
        violations: violationEngine.list({ intersectionId: id, limit: 20, includePlate: false }),
        // Delay and LOS are per-direction and reported as estimates, because a
        // model output is not a measurement.
        approaches: Object.freeze(
          DIRECTIONS.map((direction) => {
            const approach = intersection.approaches[direction];
            const arrivalVph = demand.get(id)?.[direction] ?? 0;
            const delay = estimateDelay({
              arrivalVph,
              greenMs: signal?.states?.[direction] === 'green'
                ? signal.greenMs
                : 0,
              cycleMs: 2 * (signal?.greenMs || 30000) + 2 * 5000,
              lanes: approach.lanes,
            });
            return Object.freeze({
              ...approach,
              arrivalVph,
              delayS: delay.delayS,
              degreeOfSaturation: delay.degreeOfSaturation,
              levelOfService: levelOfService(delay.delayS),
              delayMode: delay.mode,
            });
          }),
        ),
      });
    },

    /** @returns {object[]} Controller health, one entry per intersection. */
    getSignalHealth() {
      const out = [];
      let ok = 0;
      let degraded = 0;
      let fault = 0;
      for (const [id, controller] of controllers) {
        const health = controller.getHealth();
        if (health.status === 'FAULT') fault += 1;
        else if (health.status === 'DEGRADED') degraded += 1;
        else ok += 1;
        out.push(
          Object.freeze({
            intersectionId: id,
            ...health,
            // A fault must say what it is, not only that something is wrong.
            label:
              health.status === 'FAULT'
                ? `FAULT — ${health.fault || 'controller offline'}`
                : health.status === 'DEGRADED'
                  ? `DEGRADED — heartbeat ${Math.round(health.msSinceHeartbeat / 1000)}s ago`
                  : health.preempted
                    ? 'PREEMPTED — emergency priority active'
                    : 'OK',
          }),
        );
      }
      return Object.freeze({
        controllers: Object.freeze(out),
        ok,
        degraded,
        fault,
        total: controllers.size,
        mode: DATA_MODES.simulated,
      });
    },

    /** @returns {object[]} Every camera the platform knows about. */
    getCameras() {
      return cameraRegistry.list();
    },

    /** @param {string} id @returns {object|null} */
    getCamera(id) {
      return cameraRegistry.get(id);
    },

    /** @returns {object} Camera health summary plus the per-camera list. */
    getCameraHealth() {
      return Object.freeze({
        ...cameraRegistry.summary(),
        cameras: cameraRegistry.list(),
      });
    },

    /** @returns {object[]} Open incidents. */
    getIncidents(options = {}) {
      return incidentEngine.list(options);
    },

    /** @returns {object[]} Emergency vehicles and their corridors. */
    getEmergency() {
      return Object.freeze(
        emergencyEngine.listVehicles().map((vehicle) =>
          Object.freeze({
            ...vehicle,
            corridor: vehicle.corridor
              ? emergencyEngine.getCorridor(vehicle.corridor)
              : null,
          }),
        ),
      );
    },

    /** @returns {object[]} Corridors. */
    getCorridors() {
      return emergencyEngine.listCorridors();
    },

    /**
     * Violations.
     * @param {object} [options]
     * @param {boolean} [options.includePlate=false] - Plate data is opt-in and
     *   gated by the caller's capability. Defaults to off.
     * @returns {object[]}
     */
    getViolations({ includePlate = false, ...options } = {}) {
      return violationEngine.list({ ...options, includePlate });
    },

    /** @returns {object} Violation counts. */
    getViolationSummary() {
      return violationEngine.summary();
    },

    /** @returns {object} Public configuration: rules are law-as-config. */
    getRules() {
      return Object.freeze({
        rules: violationEngine.rules.list(),
        automatedEnforcement: violationEngine.summary().automatedEnforcement,
        engines: Object.freeze({
          detectors: detectors.list(),
          plateReaders: plateReaders.list(),
        }),
      });
    },

    /**
     * The live event stream.
     * @param {object} [options]
     * @returns {object[]}
     */
    getEvents(options = {}) {
      return events.recent(options);
    },

    /**
     * The audit trail. Gated by capability at the API layer.
     * @param {object} [options]
     * @returns {object[]}
     */
    getAudit(options = {}) {
      return audit.list(options);
    },

    /** @returns {object} The scenario catalogue with its presentation metadata. */
    getScenarios() {
      return Object.freeze(
        Object.entries(SCENARIO_META).map(([id, meta]) =>
          Object.freeze({ id, ...meta }),
        ),
      );
    },

    /** @returns {object} Data-source inventory with modes. */
    getDataSources() {
      const camerasSummary = cameraRegistry.summary();
      const traffic = cityTrafficSummary(
        [...intersections.values()],
        [...roads.values()],
      );
      return Object.freeze({
        sources: Object.freeze([
          Object.freeze({
            id: 'roads',
            label: 'Road network',
            source: 'OpenStreetMap via Overpass',
            mode: roads.size ? DATA_MODES.live : DATA_MODES.unavailable,
            detail: 'Road geometry is fetched live; every derived value is labelled.',
            keyRequired: false,
          }),
          Object.freeze({
            id: 'traffic-flow',
            label: 'Traffic flow',
            source: 'TomTom Traffic Flow',
            mode: traffic.mode,
            detail: 'Live congestion when a TomTom key is configured; simulated otherwise.',
            keyRequired: true,
          }),
          Object.freeze({
            id: 'cctv',
            label: 'CCTV feeds',
            source: 'Configured camera catalog',
            mode: camerasSummary.mode,
            detail: `${camerasSummary.ok} healthy · ${camerasSummary.degraded} degraded · ${camerasSummary.unconfigured} unconfigured`,
            keyRequired: false,
          }),
          Object.freeze({
            id: 'alpr',
            label: 'Mapped ALPR infrastructure',
            source: 'OpenStreetMap / DeFlock',
            mode: DATA_MODES.live,
            detail: 'Camera locations only — not feeds, not plate reads.',
            keyRequired: false,
          }),
          Object.freeze({
            id: 'signals',
            label: 'Traffic signals',
            source: 'Built-in simulator',
            mode: DATA_MODES.simulated,
            detail: 'No signal-controller hardware is connected.',
            keyRequired: false,
          }),
          Object.freeze({
            id: 'vision',
            label: 'Vehicle detection',
            source: detectors.current()?.label || 'none',
            mode: detectors.current()?.mode || DATA_MODES.unavailable,
            detail: 'Vehicle classes only. No face or person detection exists.',
            keyRequired: false,
          }),
          Object.freeze({
            id: 'plate',
            label: 'Plate recognition',
            source: plateReaders.current()?.label || 'none',
            mode: plateReaders.current()?.mode || DATA_MODES.unavailable,
            detail: 'Enforcement workflow only; not exposed on the map.',
            keyRequired: false,
          }),
          Object.freeze({
            id: 'emergency',
            label: 'Emergency vehicles',
            source: 'Built-in simulator',
            mode: DATA_MODES.simulated,
            detail: 'No dispatch integration is configured.',
            keyRequired: false,
          }),
        ]),
        receivedAt: clock(),
      });
    },

    /** @returns {object} Relief/structure of the loaded city. */
    getNetwork() {
      return network;
    },

    // ── Writes ────────────────────────────────────────────────────────────

    /**
     * The single writer of intersection state.
     * @param {object} intersection
     * @returns {object|null}
     */
    updateIntersection(intersection) {
      if (!intersection?.id || !intersections.has(intersection.id)) return null;
      const stored = Object.freeze({ ...intersection });
      intersections.set(intersection.id, stored);
      engine._syncRoadsFor(intersection.id, stored);
      return stored;
    },

    /** Push an intersection's approach state onto its roads. */
    _syncRoadsFor(intersectionId, intersection) {
      for (const direction of DIRECTIONS) {
        const approach = intersection.approaches[direction];
        const roadId = approach.roadId;
        if (!roadId) continue;
        const road = roads.get(roadId);
        if (!road) continue;
        const updated = withRoadState(road, {
          speedMps: approach.speedMps,
          vehicleCount: Math.round(approach.vehicleCount),
          queueM: approach.queueM,
          mode: DATA_MODES.simulated,
        });
        roads.set(
          roadId,
          Object.freeze({
            ...updated,
            // A road's congestion is the worst of its approaches, because that
            // is what a driver experiences on it.
            congestion: worstCongestion(updated.congestion, approach.congestion),
          }),
        );
      }
    },

    /**
     * Set the operating mode.
     * @param {string} requested
     * @param {object} [context]
     * @returns {{ok:boolean, mode:string, reason:string|null, refused:boolean}}
     */
    setOperatingMode(requested, context = {}) {
      const resolved = resolveOperatingMode(requested, context);
      if (!resolved.refused) operatingMode = resolved.mode;
      if (resolved.refused) {
        audit.record({
          action: 'operating-mode.refused',
          role: context.role || null,
          outcome: 'refused',
          mode: DATA_MODES.unavailable,
          reason: resolved.reason,
        });
      } else if (operatingMode !== requested || requested !== DEFAULT_OPERATING_MODE) {
        audit.record({
          action: 'operating-mode.set',
          role: context.role || null,
          outcome: 'applied',
          mode: DATA_MODES.simulated,
          reason: `operating mode set to ${resolved.mode}`,
        });
      }
      return { ok: !resolved.refused, ...resolved };
    },

    /** @returns {string} */
    getOperatingMode() {
      return operatingMode;
    },

    /**
     * Directly set an intersection's phase, honouring the safe transition.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, signal:object|null}}
     */
    setSignalPhase({ intersectionId, group, phase, greenMs, role = null } = {}) {
      const controller = controllers.get(intersectionId);
      if (!controller)
        return { ok: false, reason: 'unknown intersection', signal: null };
      if (operatingMode === OPERATING_MODES.recommendation)
        return {
          ok: false,
          reason: 'operating mode is recommendation — no control is applied',
          signal: controller.getSignalState(),
        };
      const before = controller.getSignalState();
      const result = controller.setPhase({ group, phase, greenMs });
      if (result.ok) {
        audit.record({
          action: 'signals.set-phase',
          role,
          intersectionId,
          outcome: 'applied',
          mode: DATA_MODES.simulated,
          reason: `set ${group || before.group} to ${phase || 'green'}`,
          before: { group: before.group, phase: before.phase, greenMs: before.greenMs },
          after: { group: result.signal.group, phase: result.signal.phase, greenMs: result.signal.greenMs },
        });
        engine._applySignalToIntersection(intersectionId);
      }
      return {
        ok: result.ok,
        reason: result.reason,
        signal: result.signal,
        pending: result.pending || [],
      };
    },

    /**
     * Extend an intersection's green.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, signal:object|null}}
     */
    extendGreen({ intersectionId, ms, role = null } = {}) {
      return engine._controlSignal('extendGreen', { intersectionId, ms, role });
    },

    /**
     * Shorten an intersection's green.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, signal:object|null}}
     */
    shortenGreen({ intersectionId, ms, role = null } = {}) {
      return engine._controlSignal('shortenGreen', { intersectionId, ms, role });
    },

    /**
     * Set an intersection's whole cycle.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, signal:object|null}}
     */
    setCycle({ intersectionId, cycleMs, role = null } = {}) {
      return engine._controlSignal('setCycle', { intersectionId, cycleMs, role });
    },

    /** Shared path for the controller verbs that share an audit shape. */
    _controlSignal(verb, { intersectionId, role = null, ...args } = {}) {
      const controller = controllers.get(intersectionId);
      if (!controller)
        return { ok: false, reason: 'unknown intersection', signal: null };
      if (operatingMode === OPERATING_MODES.recommendation)
        return {
          ok: false,
          reason: 'operating mode is recommendation — no control is applied',
          signal: controller.getSignalState(),
        };
      const before = controller.getSignalState();
      const result = controller[verb](args.ms ?? args.cycleMs ?? { cycleMs: args.cycleMs });
      if (!result.ok) return { ok: false, reason: result.reason, signal: result.signal };
      audit.record({
        action: `signals.${verb}`,
        role,
        intersectionId,
        outcome: 'applied',
        mode: DATA_MODES.simulated,
        reason: `${verb} by ${args.ms ?? args.cycleMs} ms`,
        before: { greenMs: before.greenMs, group: before.group, phase: before.phase },
        after: { greenMs: result.signal.greenMs },
      });
      engine._applySignalToIntersection(intersectionId);
      return { ok: true, reason: null, signal: result.signal };
    },

    /** Push a controller's current phase onto its intersection's approaches. */
    _applySignalToIntersection(intersectionId) {
      const intersection = intersections.get(intersectionId);
      const controller = controllers.get(intersectionId);
      if (!intersection || !controller) return;
      intersections.set(
        intersectionId,
        applySignalState(intersection, controller.getSignalState()),
      );
    },

    /**
     * Clear a controller fault.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null}}
     */
    clearSignalFault({ intersectionId, role = null } = {}) {
      const controller = controllers.get(intersectionId);
      if (!controller) return { ok: false, reason: 'unknown intersection' };
      const result = controller.clearFault();
      if (result.ok) {
        audit.record({
          action: 'signals.clear-fault',
          role,
          intersectionId,
          outcome: 'applied',
          mode: DATA_MODES.simulated,
          reason: 'fault cleared by operator',
        });
        engine._applySignalToIntersection(intersectionId);
      }
      return { ok: result.ok, reason: result.reason };
    },

    /**
     * Ask the optimizer for a recommendation, optionally applying it.
     * @param {object} [options]
     * @param {string} [options.intersectionId] - Omit for the whole city.
     * @param {boolean} [options.apply=false]
     * @param {string} [options.role]
     * @returns {object[]}
     */
    optimize({ intersectionId = null, apply = false, role = null } = {}) {
      const targets = intersectionId
        ? [intersections.get(intersectionId)].filter(Boolean)
        : [...intersections.values()];
      const out = [];
      for (const intersection of targets) {
        const recommendation = recommendGreenSplit(intersection);
        if (!recommendation) continue;
        const entry = {
          intersectionId: intersection.id,
          recommendation,
          applied: false,
          applyReason: null,
        };
        if (apply) {
          const mode = operatingMode;
          if (mode === OPERATING_MODES.recommendation) {
            entry.applyReason = 'recommendation mode — not applied';
          } else {
            const controller = controllers.get(intersection.id);
            const signal = controller?.getSignalState();
            if (signal && signal.group === 'NS' && signal.phase === 'green') {
              const delta = recommendation.recommended.NS - signal.greenMs;
              if (Math.abs(delta) >= 3000) {
                const result = delta > 0
                  ? controller.extendGreen(delta)
                  : controller.shortenGreen(-delta);
                entry.applied = result.ok;
                if (result.ok) {
                  audit.record({
                    action: 'signals.adaptive-timing',
                    role,
                    intersectionId: intersection.id,
                    outcome: 'applied',
                    mode: DATA_MODES.simulated,
                    reason: recommendation.reason,
                    before: { greenMs: signal.greenMs },
                    after: { greenMs: result.signal.greenMs },
                  });
                  engine._applySignalToIntersection(intersection.id);
                }
              } else {
                entry.applyReason = 'recommendation within tolerance of current timing';
              }
            } else {
              entry.applyReason = 'intersection is not holding NS green';
            }
          }
        }
        out.push(Object.freeze(entry));
      }
      return Object.freeze(out);
    },

    /**
     * Run a scenario.
     * @param {string} id
     * @param {object} [options]
     * @returns {object}
     */
    runScenario(id, options = {}) {
      const runner = createScenarioRunner({
        network: network || { intersections: [], roads: [] },
        controllers,
        emergency: emergencyEngine,
        violations: violationEngine,
        incidents: incidentEngine,
        events,
        audit,
        random,
        cameras: cameraRegistry,
        updateIntersection: (intersection) => engine.updateIntersection(intersection),
        getIntersection: (id) => intersections.get(id) || null,
        operatingMode: () => operatingMode,
        routingGraph: () => routingGraph,
        readPlate: (input) => plateReaders.read(input),
        plateQualityFor: (cameraId) => {
          const camera = cameraRegistry.get(cameraId);
          if (!camera) return 0.9;
          if (camera.status === 'degraded') return 0.6;
          // A simulated camera has no real optics, so its frames are modelled
          // as clean; a configured camera's quality comes from its health.
          return camera.sourceKind === 'simulated' ? 0.97 : 0.92;
        },
        clock,
      });
      const result = runner.run(id, options);
      if (result.ok) {
        audit.record({
          action: `simulation.${id}`,
          role: options.role || null,
          outcome: 'applied',
          mode: DATA_MODES.simulated,
          reason: `scenario ${id} triggered`,
        });
      }
      return Object.freeze({ ...result, meta: SCENARIO_META[id] || null });
    },

    /**
     * Start or stop the continuous simulation clock.
     * @param {object} options
     * @param {boolean} options.running
     * @param {object} [options.scheduler]
     * @returns {{ok:boolean, running:boolean}}
     */
    setSimulationRunning({ running, scheduler = null } = {}) {
      if (running && !simulationRunning) {
        simulationRunning = true;
        const tick = () => {
          if (!simulationRunning) return;
          engine.stepSimulation();
        };
        if (scheduler) scheduler.setTimer(tick, SIMULATION_TICK_MS);
        else simulationTimer = setTimeout(tick, SIMULATION_TICK_MS);
        events.publish({
          category: 'system',
          type: 'simulation-started',
          severity: SEVERITY.notice,
          message: 'SIMULATION STARTED — control steps every 2 s',
          mode: DATA_MODES.simulated,
        });
      } else if (!running && simulationRunning) {
        simulationRunning = false;
        if (simulationTimer) clearTimeout(simulationTimer);
        simulationTimer = null;
        events.publish({
          category: 'system',
          type: 'simulation-stopped',
          severity: SEVERITY.notice,
          message: 'SIMULATION STOPPED',
          mode: DATA_MODES.simulated,
        });
      }
      return { ok: true, running: simulationRunning };
    },

    /**
     * Advance the simulation one step. Public so a test or the server's tick
     * can drive it without the wall-clock timer.
     * @param {object} [options]
     * @returns {object}
     */
    stepSimulation({ stepS = SIMULATION_STEP_S } = {}) {
      if (!network) return { updated: 0, mode: DATA_MODES.unavailable };
      const summary = runSimulationStep({
        network,
        controllers,
        demand,
        stepS,
        random,
        getIntersection: (id) => intersections.get(id) || null,
        updateIntersection: (intersection) => engine.updateIntersection(intersection),
      });
      simulationSteps += 1;
      lastStepAt = clock();
      // Controllers keep running on their own timers; re-apply their phase so
      // the intersection's reported lamps never lag the controller.
      for (const id of controllers.keys()) engine._applySignalToIntersection(id);
      return Object.freeze({ ...summary, steps: simulationSteps, at: lastStepAt });
    },

    /** @returns {boolean} */
    isSimulationRunning() {
      return simulationRunning;
    },

    /**
     * Run one camera frame through the vision pipeline.
     *
     * This is the ONLY place inference runs, and it runs server-side against a
     * frame the caller already has. No frame is fetched here.
     * @param {object} input
     * @param {string} input.cameraId
     * @param {number} [input.width] @param {number} [input.height]
     * @param {number} [input.at]
     * @param {number} [input.trafficIntensity]
     * @returns {Promise<object>}
     */
    async processFrame({ cameraId, width = 1280, height = 720, at = null, trafficIntensity = null } = {}) {
      const camera = cameraRegistry.get(cameraId);
      const intensity = isFiniteNumber(trafficIntensity)
        ? clamp(trafficIntensity, 0, 1)
        : engine._intensityFor(cameraId);
      const result = await runDetectionPipeline({
        detector: detectors.current(),
        tracker,
        frame: { cameraId, width, height, at: at ?? clock(), trafficIntensity: intensity },
      });
      return Object.freeze({
        cameraId,
        camera: camera ? { id: camera.id, status: camera.status, mode: camera.mode } : null,
        ...result,
        mode: detectors.current()?.mode || DATA_MODES.unavailable,
      });
    },

    /** Scene busyness for a camera, from the approach it observes. */
    _intensityFor(cameraId) {
      const camera = cameraRegistry.get(cameraId);
      if (!camera) return 0.4;
      const intersection = camera.intersectionId
        ? intersections.get(camera.intersectionId)
        : null;
      if (!intersection) return 0.4;
      const approach = camera.approach
        ? intersection.approaches[camera.approach]
        : intersection.approaches.N;
      if (!approach) return 0.4;
      return clamp(approach.congestion ?? 0.4, 0.1, 1);
    },

    /**
     * Fuse emergency signals into a call, and spawn the vehicle when the call
     * is strong enough.
     *
     * The threshold is where "do not act on one uncertain visual detection"
     * becomes code: a LOW band produces no vehicle at all.
     * @param {object} input
     * @returns {{ok:boolean, band:string, confidence:number, vehicle:object|null, reason:string|null}}
     */
    detectEmergency({ authorized, lightPattern, siren, visual, operator, type, lon, lat, role = null } = {}) {
      const fused = fuseEmergencyDetection({
        authorized,
        lightPattern,
        siren,
        visual,
        operator,
        type,
      });
      if (fused.band === 'low') {
        return {
          ok: false,
          band: fused.band,
          confidence: fused.confidence,
          vehicle: null,
          reason: 'insufficient independent evidence for an emergency identification',
        };
      }
      const vehicle = emergencyEngine.spawnVehicle({
        type: type || 'ambulance',
        lon: lon ?? network?.intersections?.[0]?.lon ?? 0,
        lat: lat ?? network?.intersections?.[0]?.lat ?? 0,
        detection: {
          band: fused.band,
          confidence: fused.confidence,
          reasons: fused.reasons,
          mode: fused.mode,
        },
        label: `${type || 'ambulance'} (${fused.band} confidence)`,
      });
      audit.record({
        action: 'emergency.detect',
        role,
        outcome: 'applied',
        mode: fused.mode,
        reason: `emergency detection at ${fused.band} confidence`,
        after: { vehicleId: vehicle.id, type: vehicle.type },
      });
      return {
        ok: true,
        band: fused.band,
        confidence: fused.confidence,
        vehicle,
        reason: null,
      };
    },

    /**
     * Plan a corridor for an emergency vehicle.
     * @param {object} options
     * @returns {object|null}
     */
    planCorridor({ vehicleId, toId, congestionWeight = 1, role = null } = {}) {
      const corridor = emergencyEngine.planCorridor({
        vehicleId,
        graph: routingGraph,
        toId,
        congestionWeight,
      });
      if (corridor) {
        audit.record({
          action: 'emergency.plan-corridor',
          role,
          outcome: 'applied',
          mode: DATA_MODES.simulated,
          reason: `corridor ${corridor.id} planned`,
          after: { corridorId: corridor.id, intersections: corridor.intersectionIds.length },
        });
      }
      return corridor;
    },

    /**
     * Request emergency preemption at one intersection.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, request:object|null}}
     */
    preemptIntersection({ corridorId, intersectionId, role = null } = {}) {
      if (operatingMode === OPERATING_MODES.recommendation)
        return {
          ok: false,
          reason: 'operating mode is recommendation — preemption is not applied',
          request: null,
        };
      const result = emergencyEngine.requestPreemption({
        corridorId,
        intersectionId,
        controllers,
        role,
      });
      if (result.ok) engine._applySignalToIntersection(intersectionId);
      return result;
    },

    /**
     * Release a corridor.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, released:string[]}}
     */
    releaseCorridor({ corridorId, role = null } = {}) {
      const result = emergencyEngine.releaseCorridor({
        corridorId,
        controllers,
        role,
      });
      for (const id of result.released) engine._applySignalToIntersection(id);
      return result;
    },

    /**
     * Advance every emergency vehicle that has a corridor.
     * @param {number} dtS
     * @returns {object[]}
     */
    advanceEmergencyVehicles(dtS) {
      const out = [];
      for (const vehicle of emergencyEngine.listVehicles()) {
        if (!vehicle.corridor || vehicle.status === 'cleared') continue;
        const updated = emergencyEngine.advanceVehicle(vehicle.id, dtS);
        if (updated) out.push(updated);
      }
      return Object.freeze(out);
    },

    /**
     * Run the incident detectors against the current state.
     * @returns {object[]} Incidents raised by this pass.
     */
    scanForIncidents() {
      const raised = [];
      for (const [id, controller] of controllers) {
        const failure = detectSignalFailure(controller.getHealth(), id);
        if (!failure) continue;
        const already = incidentEngine
          .list({ status: 'open' })
          .some(
            (incident) =>
              incident.type === 'TRAFFIC_SIGNAL_FAILURE' &&
              incident.affectedIntersectionIds.includes(id),
          );
        if (already) continue;
        const intersection = intersections.get(id);
        const incident = incidentEngine.raise({
          type: 'TRAFFIC_SIGNAL_FAILURE',
          lon: intersection.lon,
          lat: intersection.lat,
          source: 'controller-monitor',
          confidence: 1,
          affectedIntersectionIds: [id],
          detail: failure.detail,
          mode: DATA_MODES.simulated,
        });
        if (incident) raised.push(incident);
      }
      return Object.freeze(raised);
    },

    /**
     * Raise an incident directly (operator or API).
     * @param {object} input
     * @returns {object|null}
     */
    raiseIncident(input) {
      return incidentEngine.raise(input);
    },

    /**
     * Clear an incident.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, incident:object|null}}
     */
    clearIncident({ id, role = null } = {}) {
      return incidentEngine.clear({ id, role });
    },

    /**
     * Review a violation.
     * @param {object} options
     * @returns {{ok:boolean, reason:string|null, violation:object|null}}
     */
    reviewViolation(options) {
      return violationEngine.review(options);
    },

    /**
     * Request operator confirmation for a consequential action.
     * @param {object} options
     * @returns {object}
     */
    requestConfirmation(options) {
      return confirmations.request(options);
    },

    /**
     * Resolve a confirmation, returning whether the action may proceed.
     * @param {string} id @param {boolean} approved
     * @returns {{ok:boolean, reason:string|null, request:object|null}}
     */
    resolveConfirmation(id, approved) {
      return confirmations.resolve(id, approved);
    },

    /** @returns {object[]} */
    listPendingConfirmations() {
      return confirmations.listPending();
    },

    /**
     * Reset everything the simulator owns, leaving the network in place.
     * @returns {object}
     */
    resetSimulation() {
      engine.setSimulationRunning({ running: false });
      emergencyEngine.clear();
      incidentEngine.clear();
      violationEngine.clear();
      tracker.clear();
      confirmations.clear();
      intersections.clear();
      for (const [id, intersection] of network?.intersections
        ? network.intersections.map((i) => [i.id, i])
        : []) {
        intersections.set(id, engine._seedIntersection(intersection));
      }
      for (const controller of controllers.values()) controller.clearFault();
      demand = generateDemand(network || { intersections: [] }, {
        pressure: 0.35,
        random: createRandom(seed),
      });
      simulationSteps = 0;
      lastStepAt = null;
      events.publish({
        category: 'system',
        type: 'simulation-reset',
        severity: SEVERITY.notice,
        message: 'SIMULATION RESET',
        mode: DATA_MODES.simulated,
      });
      return { ok: true, intersections: intersections.size };
    },

    // ── Direct access (server internals and tests) ────────────────────────

    /** @returns {Map<string, object>} */
    get controllers() {
      return controllers;
    },

    /** @returns {object} */
    get events() {
      return events;
    },

    /** @returns {object} */
    get audit() {
      return audit;
    },

    /** @returns {object} */
    get emergency() {
      return emergencyEngine;
    },

    /** @returns {object} */
    get incidents() {
      return incidentEngine;
    },

    /** @returns {object} */
    get violations() {
      return violationEngine;
    },

    /** @returns {object} */
    get cameras() {
      return cameraRegistry;
    },

    /** @returns {object} */
    get routing() {
      return routingGraph;
    },

    /** @returns {object} The plate reader registry, for adapter selection. */
    get plate() {
      return plateReaders;
    },

    /** @returns {object} The detector registry, for adapter selection. */
    get detectors() {
      return detectors;
    },

    /** @returns {object} The vehicle tracker. */
    get tracker() {
      return tracker;
    },

    /** @returns {number} */
    get seed() {
      return seed;
    },
  };

  return Object.freeze(engine);
}

/** Merge two congestion buckets, keeping the worse. */
function worstCongestion(a, b) {
  const rank = { free: 0, slow: 1, jam: 2 };
  if (!a) return b || null;
  if (!b) return a;
  return (rank[a] ?? -1) >= (rank[b] ?? -1) ? a : b;
}

/** Count detection classes for a census, re-exported for the API layer. */
export { detectionCensus, congestionScore, queueLengthFromCount, approachAxis };
