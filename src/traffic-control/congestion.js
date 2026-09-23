/**
 * @file Congestion analysis — the central traffic-analysis service.
 *
 * Inputs are anything the platform has: a TomTom traffic level, a measured
 * speed, a vehicle count from the detector, a queue observation. Outputs are
 * congestion score, queue length, delay, level of service and an intersection
 * pressure figure the optimizer consumes.
 *
 * Everything here is pure. A service that computed its own traffic would be a
 * second source of truth; this module only transforms what it is handed, and
 * reports the mode of every input it used so the caller can label the result.
 *
 * @module traffic-control/congestion
 */

import {
  DATA_MODES,
  DEFAULT_GREEN_MS,
  LOS_F_DELAY_S,
  MAX_GREEN_MS,
  MIN_GREEN_MS,
} from './policy.js';
import { bucketForLevel, freeFlowMps } from './network.js';
import { clamp, isFiniteNumber } from './geometry.js';

/** @const {number} veh/km/lane assumed for a fully stopped queue (jam density). */
export const JAM_DENSITY_VPKM = 130;

/** @const {number} Average vehicle length plus headway, metres. */
export const EFFECTIVE_VEHICLE_LENGTH_M = 7.5;

/**
 * Queue length in metres from a vehicle count.
 *
 * Backed by jam density rather than a made-up constant: a stopped lane holds
 * about 130 vehicles per kilometre, so N vehicles occupy N/130 km.
 * @param {number} vehicleCount
 * @param {number} [lanes=1]
 * @returns {number} Metres of queue.
 */
export function queueLengthFromCount(vehicleCount, lanes = 1) {
  if (!isFiniteNumber(vehicleCount) || vehicleCount <= 0) return 0;
  const perLane = vehicleCount / Math.max(1, lanes);
  return (perLane / JAM_DENSITY_VPKM) * 1000;
}

/**
 * Vehicle count implied by a queue length, the inverse of the above.
 * @param {number} queueM
 * @param {number} [lanes=1]
 * @returns {number} Whole vehicles.
 */
export function countFromQueueLength(queueM, lanes = 1) {
  if (!isFiniteNumber(queueM) || queueM <= 0) return 0;
  return Math.max(0, Math.round((queueM / 1000) * JAM_DENSITY_VPKM * Math.max(1, lanes)));
}

/**
 * Density in vehicles per kilometre per lane.
 * @param {number} vehicleCount @param {number} lengthM @param {number} [lanes=1]
 * @returns {number|null}
 */
export function densityVpkpl(vehicleCount, lengthM, lanes = 1) {
  if (!isFiniteNumber(vehicleCount) || !isFiniteNumber(lengthM)) return null;
  if (lengthM <= 0) return null;
  return vehicleCount / (lengthM / 1000) / Math.max(1, lanes);
}

/**
 * Congestion score for a road segment, 0 (free) to 1 (gridlock).
 *
 * Blends the speed ratio with density because each alone lies: a fast road
 * with a huge standing queue reads free by speed and jammed by density, and
 * the operator cares about the queue. When only one signal is available the
 * score is that signal, so a partial feed still produces a sane number.
 * @param {object} input
 * @param {number|null} [input.speedMps]
 * @param {number|null} [input.freeFlowMps]
 * @param {number|null} [input.trafficLevel] - Provider level (wins if present).
 * @param {number|null} [input.vehicleCount]
 * @param {number|null} [input.lengthM]
 * @param {number} [input.lanes=1]
 * @returns {{score:number|null, bucket:'free'|'slow'|'jam'|null, mode:string,
 *   components:{speed:number|null,density:number|null,provider:number|null}}}
 */
export function congestionScore({
  speedMps = null,
  freeFlowMps: freeSpeed = null,
  trafficLevel = null,
  vehicleCount = null,
  lengthM = null,
  lanes = 1,
} = {}) {
  const components = { speed: null, density: null, provider: null };
  if (isFiniteNumber(trafficLevel)) {
    components.provider = clamp(trafficLevel, 0, 1);
    return {
      score: components.provider,
      bucket: bucketForLevel(components.provider),
      mode: DATA_MODES.live,
      components,
    };
  }
  if (isFiniteNumber(speedMps) && isFiniteNumber(freeSpeed) && freeSpeed > 0) {
    components.speed = clamp(speedMps / freeSpeed, 0, 1);
  }
  const density = densityVpkpl(vehicleCount, lengthM, lanes);
  if (isFiniteNumber(density)) {
    // Normalize against jam density: 0 at empty, 1 at a standing queue.
    components.density = clamp(density / JAM_DENSITY_VPKM, 0, 1);
  }
  const present = [components.speed, components.density].filter(isFiniteNumber);
  if (!present.length) {
    return { score: null, bucket: null, mode: DATA_MODES.unavailable, components };
  }
  const score = present.reduce((sum, value) => sum + value, 0) / present.length;
  return {
    score,
    bucket: bucketForLevel(score),
    mode: DATA_MODES.estimated,
    components,
  };
}

/**
 * Level of service letter for an average control delay, HCM style.
 * @param {number|null} delayS
 * @returns {'A'|'B'|'C'|'D'|'E'|'F'|null}
 */
export function levelOfService(delayS) {
  if (!isFiniteNumber(delayS)) return null;
  if (delayS <= 10) return 'A';
  if (delayS <= 20) return 'B';
  if (delayS <= 35) return 'C';
  if (delayS <= 55) return 'D';
  if (delayS <= LOS_F_DELAY_S) return 'E';
  return 'F';
}

/**
 * Estimated average control delay for an approach.
 *
 * A simplified Webster-style estimate: uniform delay from the green ratio plus
 * a queue-overflow term. It is labelled ESTIMATED everywhere it surfaces — it
 * is a model output, not a measurement.
 * @param {object} input
 * @param {number} input.arrivalVph - Arrivals, vehicles/hour.
 * @param {number} input.greenMs - Effective green, milliseconds.
 * @param {number} input.cycleMs - Cycle length, milliseconds.
 * @param {number} [input.saturationVph=1800] - Saturation flow per lane.
 * @param {number} [input.lanes=1]
 * @returns {{delayS:number|null, degreeOfSaturation:number|null, mode:string}}
 */
export function estimateDelay({
  arrivalVph,
  greenMs,
  cycleMs,
  saturationVph = 1800,
  lanes = 1,
} = {}) {
  if (![arrivalVph, greenMs, cycleMs].every(isFiniteNumber)) {
    return { delayS: null, degreeOfSaturation: null, mode: DATA_MODES.unavailable };
  }
  if (cycleMs <= 0 || greenMs <= 0) {
    return { delayS: null, degreeOfSaturation: null, mode: DATA_MODES.unavailable };
  }
  const capacityVph = saturationVph * Math.max(1, lanes) * (greenMs / cycleMs);
  const y = capacityVph > 0 ? arrivalVph / capacityVph : Infinity;
  if (!Number.isFinite(y)) {
    return { delayS: null, degreeOfSaturation: null, mode: DATA_MODES.estimated };
  }
  const greenRatio = clamp(greenMs / cycleMs, 0.05, 1);
  const uniform = (cycleMs / 2000) * (1 - greenRatio) ** 2 / (1 - Math.min(0.95, greenRatio * y));
  // Overflow term grows sharply past saturation, which is what makes a
  // saturated approach read as a problem rather than merely slow.
  const overflow = y > 1 ? 60 * (y - 1) ** 2 : 0;
  return {
    delayS: clamp(uniform + overflow, 0, 600),
    degreeOfSaturation: y,
    mode: DATA_MODES.estimated,
  };
}

/**
 * Intersection pressure: how much the intersection wants a timing change.
 *
 * One number per intersection so the optimizer can rank the city instead of
 * walking it, and so an operator can see why this one was picked.
 * @param {object} intersection - A normalized intersection with approach state.
 * @returns {{pressure:number, worst:string|null, critical:number,
 *   conflicting:number, mode:string, reasons:string[]}}
 */
export function intersectionPressure(intersection) {
  const approaches = intersection?.approaches || {};
  let worst = null;
  let worstScore = -1;
  let total = 0;
  let counted = 0;
  const axisScores = { NS: [], EW: [] };
  for (const [direction, approach] of Object.entries(approaches)) {
    const score = approachCongestion(approach);
    if (!isFiniteNumber(score)) continue;
    total += score;
    counted += 1;
    if (score > worstScore) {
      worstScore = score;
      worst = direction;
    }
    if (approach.axis) axisScores[approach.axis].push(score);
  }
  if (!counted) {
    return {
      pressure: 0,
      worst: null,
      critical: 0,
      conflicting: 0,
      mode: DATA_MODES.unavailable,
      reasons: ['no approach data'],
    };
  }
  const mean = (values) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const ns = mean(axisScores.NS);
  const ew = mean(axisScores.EW);
  const critical = Math.max(ns, ew);
  const conflicting = Math.min(ns, ew);
  const reasons = [];
  if (!Number.isFinite(worstScore)) reasons.push('no approach data');
  else if (worstScore > 0.6) reasons.push(`high queue detected on ${worst} approach`);
  if (critical - conflicting > 0.25)
    reasons.push('imbalanced cross-street demand');
  if (critical > 0.55 && conflicting > 0.55)
    reasons.push('saturated in both axes');
  return {
    // Pressure weights the critical axis heavily and the imbalance between
    // axes lightly: a uniformly busy intersection is a capacity problem, an
    // imbalanced one is a timing problem, and timing is what we can fix.
    pressure: clamp(0.75 * critical + 0.25 * (critical - conflicting), 0, 1),
    worst,
    critical,
    conflicting,
    mode: DATA_MODES.estimated,
    reasons,
  };
}

/**
 * A single approach's congestion in 0–1, preferring measured data.
 * @param {object} approach
 * @returns {number|null}
 */
export function approachCongestion(approach) {
  if (!approach) return null;
  if (isFiniteNumber(approach.congestion)) return clamp(approach.congestion, 0, 1);
  if (isFiniteNumber(approach.speedMps)) {
    const free = approach.freeFlowMps || freeFlowMps(approach.roadClass);
    if (free > 0) return clamp(1 - approach.speedMps / free, 0, 1);
  }
  if (isFiniteNumber(approach.queueVehicles) && approach.queueVehicles > 0) {
    // Queue depth as a fraction of the approach's own length.
    const ratio = approach.queueM / Math.max(1, approach.lengthM);
    return clamp(ratio, 0, 1);
  }
  if (isFiniteNumber(approach.vehicleCount)) {
    const density = densityVpkpl(
      approach.vehicleCount,
      approach.lengthM,
      approach.lanes,
    );
    if (isFiniteNumber(density)) return clamp(density / JAM_DENSITY_VPKM, 0, 1);
  }
  return null;
}

/**
 * Classify an intersection for display, naming the reason rather than only
 * colouring it.
 * @param {object} intersection
 * @returns {{status:string, label:string, glyph:string, color:string, signal:string}}
 */
export function classifyIntersection(intersection) {
  const { pressure, reasons } = intersectionPressure(intersection);
  const health = intersection?.health || null;
  if (health === 'FAULT') {
    return {
      status: 'fault',
      label: 'SIGNAL FAULT',
      glyph: '✖',
      color: '#ff4d4d',
      signal: 'red',
      reasons: ['signal controller offline'],
    };
  }
  if (pressure >= 0.7) {
    return {
      status: 'congested',
      label: 'CONGESTED',
      glyph: '⛔',
      color: '#e05252',
      signal: 'red',
      reasons,
    };
  }
  if (pressure >= 0.4) {
    return {
      status: 'slowing',
      label: 'SLOWING',
      glyph: '⏸',
      color: '#f0b23e',
      signal: 'amber',
      reasons,
    };
  }
  return {
    status: 'flowing',
    label: 'FLOWING',
    glyph: '▶',
    color: '#2ecc71',
    signal: 'green',
    reasons,
  };
}

/**
 * Recommend a green split for an intersection.
 *
 * The recommendation is a proposal with a stated reason; nothing here changes
 * a controller. In `authorized-control` mode a caller could apply it, and the
 * caller — not this function — is where that decision belongs.
 * @param {object} intersection
 * @param {object} [options]
 * @param {number} [options.cycleMs=90000]
 * @returns {{intersectionId:string, current:{NS:number,EW:number},
 *   recommended:{NS:number,EW:number}, reason:string, mode:string,
 *   pressure:number, confidence:number}|null}
 */
export function recommendGreenSplit(intersection, { cycleMs = 90000 } = {}) {
  const { pressure, worst, critical, conflicting, reasons, mode } =
    intersectionPressure(intersection);
  if (mode === DATA_MODES.unavailable) return null;
  const usable = Math.max(
    2 * MIN_GREEN_MS,
    cycleMs - 2 * (3000 + 2000),
  );
  const total = critical + conflicting;
  // Allocate by demand, then floor each axis at the minimum green so a
  // recommendation can never starve a movement into gridlock.
  const nsShare = total > 0 ? critical / total : 0.5;
  let ns = Math.round(usable * nsShare);
  let ew = usable - ns;
  ns = clamp(ns, MIN_GREEN_MS, MAX_GREEN_MS);
  ew = clamp(ew, MIN_GREEN_MS, MAX_GREEN_MS);

  const current = intersection.approaches?.NS_GROUP?.greenMs;
  const currentNs = isFiniteNumber(current) ? current : DEFAULT_GREEN_MS;
  const nsAtCritical = intersection.approaches?.N?.axis === 'NS';
  const recommended = nsAtCritical ? { NS: ns, EW: ew } : { NS: ew, EW: ns };
  const swing = Math.abs(recommended.NS - currentNs);
  const reason = reasons.length
    ? `${reasons[0][0].toUpperCase()}${reasons[0].slice(1)}.`
    : 'Balanced demand — timing is already appropriate.';
  return {
    intersectionId: intersection.id,
    current: { NS: currentNs, EW: DEFAULT_GREEN_MS },
    recommended,
    reason,
    mode: DATA_MODES.estimated,
    pressure,
    // Confidence is a function of how much evidence stood behind the read: a
    // larger swing on a more pressured intersection is a firmer call.
    confidence: clamp(0.4 + pressure * 0.5 + Math.min(0.1, swing / 100000), 0, 1),
  };
}

/**
 * City-wide congestion summary for the overview panel.
 * @param {object[]} intersections @param {object[]} roads
 * @returns {object}
 */
export function cityTrafficSummary(intersections = [], roads = []) {
  let congestedRoads = 0;
  let slowRoads = 0;
  let freeRoads = 0;
  let unknownRoads = 0;
  let totalQueueM = 0;
  let speedSum = 0;
  let speedCount = 0;
  for (const road of roads) {
    if (road.congestion === 'jam') congestedRoads += 1;
    else if (road.congestion === 'slow') slowRoads += 1;
    else if (road.congestion === 'free') freeRoads += 1;
    else unknownRoads += 1;
    totalQueueM += road.queueM || 0;
    if (isFiniteNumber(road.speedMps)) {
      speedSum += road.speedMps;
      speedCount += 1;
    }
  }
  const pressures = intersections.map((i) => intersectionPressure(i).pressure);
  const busiest = intersections.length
    ? intersections[
        pressures.indexOf(Math.max(...pressures))
      ]?.id || null
    : null;
  return {
    roads: roads.length,
    intersections: intersections.length,
    congestedRoads,
    slowRoads,
    freeRoads,
    unknownRoads,
    signalized: intersections.filter((i) => i.signalized).length,
    faults: intersections.filter((i) => i.health === 'FAULT').length,
    totalQueueM: Math.round(totalQueueM),
    meanSpeedMps: speedCount ? speedSum / speedCount : null,
    meanSpeedMode: speedCount ? DATA_MODES.estimated : DATA_MODES.unavailable,
    busiestIntersectionId: busiest,
    worstPressure: pressures.length ? Math.max(...pressures) : null,
    mode: roads.some((road) => road.levelMode === DATA_MODES.live)
      ? DATA_MODES.live
      : roads.length
        ? DATA_MODES.simulated
        : DATA_MODES.unavailable,
  };
}
