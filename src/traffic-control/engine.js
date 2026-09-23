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
  OPERATING_MODE_META,
  OPERATING_MODE_ORDER,
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
  approachStatus,
} from './emergency.js';
import {
  createAuditLog,
  createConfirmationGate,
  createEventBus,
  SEVERITY,
} from './events.js';
import { createIncidentEngine, detectSignalFailure } from './incidents.js';
import {
  createViolationEngine,
  createRuleSet,
  DEFAULT_RULES,
  enforcedSignalStates,
} from './violations.js';
import { createCameraRegistry } from './cameras.js';
import {
  applySignalState,
  createRandom,
  createScenarioRunner,
  DEMO_SCENARIO,
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
  /** @type {string|null} The scenario most recently run, for the simulation page. */
  let lastScenario = null;
  /**
   * A bounded ring of city summaries, one per control step.
   *
   * The analytics view charts this rather than synthesising a trend, so a chart
   * can only ever show measurements the engine actually took. Bounded so a
   * long-running session cannot grow without limit.
   * @type {object[]}
   */
  const analyticsSamples = [];
  /** @const {number} */
  const ANALYTICS_SAMPLE_CAPACITY = 900;

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
        // Which signal states can support each claim, so the UI can explain why
        // a crossing did or did not qualify rather than only showing the verdict.
        enforcedSignalStates: enforcedSignalStates(),
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

    /** @returns {object} The demand model, for the analytics view. */
    getDemand() {
      return Object.freeze(Object.fromEntries([...demand.entries()].map(([id, byDir]) => [id, { ...byDir }])));
    },

    // ── Read-side projections the command center renders ──────────────────

    /**
     * Signal state for every intersection, flattened for the map layer.
     * @returns {object[]}
     */
    getSignals() {
      const out = [];
      for (const [id, controller] of controllers) {
        const signal = controller.getSignalState();
        const health = controller.getHealth();
        const intersection = intersections.get(id);
        out.push(
          Object.freeze({
            intersectionId: id,
            name: intersection?.name || id,
            lon: intersection?.lon ?? null,
            lat: intersection?.lat ?? null,
            group: signal.group,
            phase: signal.phase,
            greenMs: signal.greenMs,
            cycleMs: signal.cycleMs,
            states: signal.states,
            preempted: Boolean(signal.preemption),
            preemption: signal.preemption || null,
            health: health.status,
            label: health.label,
            // Every phase the simulator can be in is a simulated one: no
            // hardware is attached, and the readout says so.
            mode: DATA_MODES.simulated,
          }),
        );
      }
      return Object.freeze(out);
    },

    /** @param {string} id @returns {object|null} */
    getSignal(id) {
      return engine.getSignals().find((signal) => signal.intersectionId === id) || null;
    },

    /**
     * The four-approach readout for one intersection.
     * @param {string} id
     * @returns {object[]}
     */
    getApproachTable(id) {
      const intersection = intersections.get(id);
      if (!intersection) return Object.freeze([]);
      const signal = controllers.get(id)?.getSignalState() || null;
      return Object.freeze(
        DIRECTIONS.map((direction) => {
          const approach = intersection.approaches[direction];
          return Object.freeze({
            direction,
            axis: approachAxis(direction),
            roadId: approach.roadId,
            roadName: approach.roadName,
            roadClass: approach.roadClass,
            lanes: approach.lanes,
            vehicleCount: approach.vehicleCount,
            queueVehicles: approach.queueVehicles,
            queueM: approach.queueM,
            speedMps: approach.speedMps,
            freeFlowMps: approach.freeFlowMps,
            congestion: approach.congestion,
            cameraId: approach.cameraId,
            signalState: signal?.states?.[direction] ?? 'unknown',
            phase: signal?.phase ?? 'unknown',
            greenMs: signal?.greenMs ?? null,
          });
        }),
      );
    },

    /**
     * The adaptive recommendation for one intersection, with its reasoning.
     * @param {string} id
     * @returns {object|null}
     */
    getSignalRecommendation(id) {
      const intersection = intersections.get(id);
      if (!intersection) return null;
      const recommendation = recommendGreenSplit(intersection);
      if (!recommendation) return null;
      const signal = controllers.get(id)?.getSignalState() || null;
      return Object.freeze({
        ...recommendation,
        current: {
          ...recommendation.current,
          holding: signal?.group ?? null,
          phase: signal?.phase ?? null,
        },
        // Applying a recommendation moves a simulated signal only, never real
        // hardware, and only in an operating mode that permits it.
        applicable: operatingMode !== OPERATING_MODES.recommendation,
        operatingMode,
      });
    },

    /**
     * Describe one intersection's control path for the operator.
     * @param {string} id @returns {object|null}
     */
    describeControl(id) {
      const controller = controllers.get(id);
      if (!controller) return null;
      return Object.freeze({
        ...describeController(controller),
        operatingMode,
        emergencyPreemption: controller.getHealth().preempted,
        fault: controller.getHealth().fault,
      });
    },

    /** @returns {object[]} Operating modes the UI may offer. */
    getOperatingModes() {
      return Object.freeze(
        OPERATING_MODE_ORDER.map((mode) => {
          const resolved = resolveOperatingMode(mode);
          return Object.freeze({
            mode,
            selected: mode === operatingMode,
            selectable: !resolved.refused,
            reason: resolved.reason,
            label: OPERATING_MODE_META[mode]?.label || mode,
            detail: OPERATING_MODE_META[mode]?.detail || '',
          });
        }),
      );
    },

    /**
     * City-wide traffic readout for the traffic page and analytics.
     * @returns {object}
     */
    getTraffic() {
      const list = [...intersections.values()];
      const summary = cityTrafficSummary(list, [...roads.values()]);
      const roadList = [...roads.values()];
      const congested = roadList
        .filter((road) => road.congestion === 'jam')
        .sort((a, b) => b.queueM - a.queueM)
        .slice(0, 20);
      return Object.freeze({
        summary,
        congestedRoads: Object.freeze(congested),
        // The busiest intersections by queue, which is what an operator
        // triages first.
        pressureRanking: Object.freeze(
          list
            .map((intersection) => ({
              intersectionId: intersection.id,
              name: intersection.name,
              pressure: intersectionPressure(intersection).pressure,
              reasons: intersectionPressure(intersection).reasons,
            }))
            .sort((a, b) => b.pressure - a.pressure)
            .slice(0, 20),
        ),
        mode: summary.mode,
      });
    },

    /**
     * A bounded time series for the analytics charts.
     *
     * The series is sampled from the engine's own accumulated observations
     * rather than synthesised for display: each sample is the city summary as
     * it stood when that step ran. When no history exists yet the result is an
     * empty series and the UI says so, instead of drawing an invented trend.
     * @param {object} [options]
     * @param {number} [options.windowMinutes=60]
     * @returns {object}
     */
    getAnalytics({ windowMinutes = 60 } = {}) {
      const cutoff = clock() - windowMinutes * 60_000;
      const samples = analyticsSamples.filter((sample) => sample.at >= cutoff);
      const violations = violationEngine.list({ limit: 500, includePlate: false });
      const incidents = incidentEngine.list({ status: 'open', limit: 500 });
      const corridors = emergencyEngine.listCorridors();
      return Object.freeze({
        windowMinutes,
        samples: Object.freeze(samples),
        totals: Object.freeze({
          violations: violations.length,
          incidents: incidents.length,
          corridors: corridors.length,
          corridorsReleased: corridors.filter((corridor) => corridor.status === 'released').length,
          simulationSteps,
        }),
        mode: samples.length ? samples[samples.length - 1].mode : DATA_MODES.unavailable,
        note: samples.length
          ? 'Sampled from the live engine state at each simulation step.'
          : 'No samples yet — start the simulation to accumulate history.',
      });
    },

    /**
     * Aggregate platform health, so one degraded provider is visible without
     * the rest of the command center going dark.
     * @returns {object}
     */
    getSystemHealth() {
      const signalHealth = engine.getSignalHealth();
      const camerasSummary = cameraRegistry.summary();
      const traffic = cityTrafficSummary([...intersections.values()], [...roads.values()]);
      const detectorsList = detectors.list();
      const sources = engine.getDataSources().sources;
      const component = (id, label, status, detail) =>
        Object.freeze({ id, label, status, detail });

      const components = [
        component(
          'network',
          'Road network',
          network ? 'HEALTHY' : 'UNAVAILABLE',
          network ? `${roads.size} roads` : 'no network loaded',
        ),
        component(
          'signals',
          'Signal controllers',
          signalHealth.fault > 0
            ? 'FAULT'
            : signalHealth.degraded > 0
              ? 'DEGRADED'
              : controllers.size
                ? 'HEALTHY'
                : 'UNAVAILABLE',
          `${signalHealth.ok} ok · ${signalHealth.degraded} degraded · ${signalHealth.fault} fault`,
        ),
        component(
          'cameras',
          'Camera layer',
          camerasSummary.total === 0
            ? 'UNAVAILABLE'
            : camerasSummary.degraded + camerasSummary.unconfigured > 0
              ? 'DEGRADED'
              : 'HEALTHY',
          `${camerasSummary.ok} ok · ${camerasSummary.degraded} degraded`,
        ),
        component(
          'traffic',
          'Traffic feed',
          traffic.mode === DATA_MODES.unavailable ? 'UNAVAILABLE' : 'HEALTHY',
          `mode ${traffic.mode}`,
        ),
        component(
          'vision',
          'Vision engine',
          detectorsList.length ? 'HEALTHY' : 'UNAVAILABLE',
          detectorsList[0]?.label || 'none registered',
        ),
        component(
          'emergency',
          'Emergency feed',
          'HEALTHY',
          `${emergencyEngine.listVehicles().length} vehicles · no dispatch integration`,
        ),
        component(
          'simulation',
          'Simulation engine',
          simulationRunning ? 'HEALTHY' : 'DEGRADED',
          simulationRunning ? `running · step ${simulationSteps}` : 'paused',
        ),
        component(
          'backend',
          'Command API',
          'HEALTHY',
          `pid ${typeof process !== 'undefined' ? process.pid : 'n/a'}`,
        ),
      ];

      const rank = { HEALTHY: 0, DEGRADED: 1, FAULT: 2, UNAVAILABLE: 3 };
      const worst = components.reduce(
        (acc, item) => (rank[item.status] > rank[acc] ? item.status : acc),
        'HEALTHY',
      );
      return Object.freeze({
        overall: worst,
        components: Object.freeze(components),
        sources,
        at: clock(),
      });
    },

    /**
     * Current simulation state, for the simulation page readout.
     * @returns {object}
     */
    getSimulationState() {
      return Object.freeze({
        running: simulationRunning,
        steps: simulationSteps,
        stepSeconds: SIMULATION_STEP_S,
        seed,
        lastStepAt,
        scenario: lastScenario,
        operatingMode,
        vehicles: emergencyEngine.listVehicles().length,
        corridors: emergencyEngine.listCorridors().filter((corridor) => corridor.status !== 'released').length,
        incidents: incidentEngine.list({ status: 'open' }).length,
        violations: violationEngine.summary().pending,
        congestion: cityTrafficSummary([...intersections.values()], [...roads.values()]),
        mode: DATA_MODES.simulated,
        at: clock(),
      });
    },

    /**
     * One violation with its evidence, plate gated by the caller.
     * @param {string} id
     * @param {object} [options]
     * @returns {object|null}
     */
    getViolation(id, { includePlate = false } = {}) {
      const violation = violationEngine.get(id);
      if (!violation) return null;
      return includePlate ? violation : Object.freeze({ ...violation, plate: null });
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
     * Put a controller into or out of a fault state.
     *
     * This is how the simulator reproduces a signal failure for the demo, and
     * how a real health monitor would mark a controller it had lost contact
     * with. A faulty controller shows all-red and refuses control verbs until
     * an operator clears it — it does not self-heal, which is the safe default.
     * @param {object} options
     * @param {string} options.intersectionId
     * @param {boolean} [options.faulted=true]
     * @param {string} [options.reason]
     * @param {string} [options.role]
     * @returns {{ok:boolean, reason:string|null, signal:object|null}}
     */
    setSignalFault({ intersectionId, faulted = true, reason = null, role = null } = {}) {
      const controller = controllers.get(intersectionId);
      if (!controller) return { ok: false, reason: 'unknown intersection', signal: null };
      const result = faulted
        ? controller.setFault(reason || 'signal controller offline')
        : controller.clearFault();
      if (result.ok) {
        audit.record({
          action: faulted ? 'signals.fault' : 'signals.clear-fault',
          role,
          intersectionId,
          outcome: 'applied',
          mode: DATA_MODES.simulated,
          reason: reason || (faulted ? 'fault raised' : 'fault cleared by operator'),
        });
        engine._applySignalToIntersection(intersectionId);
        if (faulted) {
          const incident = detectSignalFailure(controller.getHealth(), intersectionId);
          if (incident) incidentEngine.raise(incident);
        }
      }
      return { ok: result.ok, reason: result.reason, signal: result.signal };
    },

    /**
     * Subscribe to the engine's event bus.
     *
     * The server's SSE stream is fed from here, so a connected operator sees
     * exactly the events the timeline and audit log do.
     * @param {Function} listener
     * @returns {Function} An unsubscribe function.
     */
    subscribeToEvents(listener) {
      return events.subscribe(listener);
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
        lastScenario = id;
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
     * Run the full end-to-end city demonstration.
     *
     * Composes the platform's own scenarios in the documented order rather than
     * scripting the UI: congestion → adaptive timing → emergency corridor →
     * preemption → release → violation → review queue. Each stage reports what
     * it did so the command center's timeline is a record of real engine work,
     * not an animation that looks like work.
     *
     * Everything here is SIMULATED. The method name says "demo" rather than
     * "control" because no stage touches real infrastructure.
     * @param {object} [options]
     * @param {string} [options.role]
     * @param {number} [options.stepS] - Simulated seconds to advance between stages.
     * @returns {Promise<object>}
     */
    async runFullDemo({ role = null, stepS = 5 } = {}) {
      if (!network) return { ok: false, reason: 'no network loaded', stages: [] };
      const stages = [];
      const record = (stage, detail) => stages.push(Object.freeze({ stage, ...detail }));

      // 1–2. Load a corridor until it queues.
      const jam = engine.runScenario('traffic-jam', { role });
      engine.stepSimulation({ stepS });
      record('traffic-jam', {
        ok: jam.ok,
        label: 'Traffic loaded on the busiest corridor',
        intersections: jam.result?.intersections || [],
      });

      // 3. Adaptive optimizer revises the corridor timing.
      const optimised = engine.optimize({ apply: true, role });
      record('optimize', {
        ok: true,
        label: 'Adaptive optimizer revised corridor timing',
        applied: optimised.filter((entry) => entry.applied).length,
        recommendations: optimised.length,
      });

      // 4. Let the revised timing take effect before the emergency run.
      engine.stepSimulation({ stepS });
      engine.stepSimulation({ stepS });

      // 5. Emergency vehicle appears, corridor planned, signals preempted.
      const ambulance = engine.runScenario('ambulance', { role });
      record('ambulance', {
        ok: ambulance.ok,
        label: 'Ambulance detected and corridor planned',
        vehicleId: ambulance.result?.vehicle?.id || null,
        corridorId: ambulance.result?.corridor?.id || null,
        intersections: ambulance.result?.corridor?.intersectionIds || [],
      });

      // 6. Drive the vehicle along the corridor and preempt each intersection
      //    as the vehicle actually reaches it. Preemption is requested from
      //    proximity, not asserted up front, so the log below reflects what the
      //    engine really did. The loop is bounded, and stops early once every
      //    corridor has arrived or been released.
      const advance = [];
      const preempted = [];
      const maxSteps = 80;
      for (let i = 0; i < maxSteps; i += 1) {
        engine.stepSimulation({ stepS });
        advance.push(...engine.advanceEmergencyVehicles(stepS));
        for (const corridor of emergencyEngine.listCorridors()) {
          if (corridor.status === 'released') continue;
          const vehicle = emergencyEngine.getVehicle(corridor.vehicleId);
          if (!vehicle) continue;
          for (const upcoming of emergencyEngine.upcomingIntersections(corridor.id)) {
            const target = intersections.get(upcoming.intersectionId);
            if (!target) continue;
            if (!approachStatus(vehicle, target).approaching) continue;
            const result = engine.preemptIntersection({
              corridorId: corridor.id,
              intersectionId: upcoming.intersectionId,
              role,
            });
            if (result.ok) preempted.push(result.request);
          }
        }
        const stillMoving = emergencyEngine
          .listVehicles()
          .some((vehicle) => vehicle.corridor && vehicle.status !== 'cleared' && vehicle.status !== 'arrived');
        if (!stillMoving) break;
      }
      record('corridor-run', {
        ok: preempted.length > 0,
        label: 'Corridor preempted in simulation and vehicle advanced',
        advances: advance.length,
        preemptions: preempted.length,
        preemptedIntersections: preempted.map((request) => request.intersectionId),
        vehicleStatus: emergencyEngine.listVehicles().map((vehicle) => vehicle.status),
      });

      // 7. Release and hand control back to the adaptive loop.
      const corridors = emergencyEngine.listCorridors();
      const open = corridors.filter((corridor) => corridor.status !== 'released');
      const released = [];
      for (const corridor of open) {
        released.push(engine.releaseCorridor({ corridorId: corridor.id, role }));
      }
      record('release', {
        ok: true,
        label: 'Corridor released; normal adaptive control restored',
        released: released.length,
      });

      // 8. Violation, evidence and plate pipeline, then the review queue.
      const violation = engine.runScenario('red-light-violation', { role });
      const pending = violationEngine.summary().pending;
      record('violation', {
        ok: violation.ok,
        label: 'Red-light violation detected and queued for review',
        violationId: violation.result?.violation?.id || violation.result?.violationId || null,
        pending,
      });

      engine.stepSimulation({ stepS });

      audit.record({
        action: 'simulation.full-demo',
        role,
        outcome: 'applied',
        mode: DATA_MODES.simulated,
        reason: `full city demo completed — ${stages.length} stages`,
      });
      events.publish({
        category: 'system',
        type: 'demo-complete',
        severity: SEVERITY.notice,
        message: 'FULL CITY DEMO COMPLETE — all stages SIMULATED',
        mode: DATA_MODES.simulated,
        detail: { stages: stages.length },
      });

      return Object.freeze({
        ok: true,
        stages: Object.freeze(stages),
        demoDefinition: DEMO_SCENARIO,
        mode: DATA_MODES.simulated,
        at: clock(),
      });
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
      engine._sampleAnalytics();
      return Object.freeze({ ...summary, steps: simulationSteps, at: lastStepAt });
    },

    /**
     * Record one analytics sample. Called after each control step so the
     * analytics view charts real engine state rather than an invented curve.
     */
    _sampleAnalytics() {
      const summary = cityTrafficSummary([...intersections.values()], [...roads.values()]);
      analyticsSamples.push(
        Object.freeze({
          at: lastStepAt,
          step: simulationSteps,
          congestedRoads: summary.congestedRoads,
          slowRoads: summary.slowRoads,
          freeRoads: summary.freeRoads,
          totalQueueM: summary.totalQueueM,
          meanSpeedMps: summary.meanSpeedMps,
          worstPressure: summary.worstPressure,
          mode: summary.mode,
        }),
      );
      if (analyticsSamples.length > ANALYTICS_SAMPLE_CAPACITY) {
        analyticsSamples.splice(0, analyticsSamples.length - ANALYTICS_SAMPLE_CAPACITY);
      }
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
      lastScenario = null;
      analyticsSamples.length = 0;
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
