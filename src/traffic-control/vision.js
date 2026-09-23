/**
 * @file Modular vehicle-detection, tracking and plate-recognition pipeline.
 *
 *     frame ─▶ detector ─▶ tracker ─▶ event analyser ─▶ traffic engine
 *
 * The detector is an ADAPTER: {@link createDetectorRegistry} holds named
 * implementations and the platform asks for one by name. No proprietary model
 * is required and none is bundled — {@link createSimulatedDetector} satisfies
 * the interface deterministically, which is what makes the pipeline testable
 * and demonstrable without a GPU or a licensed model.
 *
 * PRIVACY. This module detects VEHICLES ONLY. There is deliberately no face
 * detector, no person classifier, no gait or appearance descriptor, and the
 * tracker's state holds a bounding box and a class — never a colour histogram
 * or any other signature that would survive between scenes. Plate reading lives
 * in {@link plateResultFromCharacters} and is only ever reachable from the
 * enforcement workflow (see violations.js), never from general map exploration.
 *
 * @module traffic-control/vision
 */

import {
  DATA_MODES,
  DETECTION_MIN_CONFIDENCE,
  PLATE_MIN_CHAR_CONFIDENCE,
  PLATE_MIN_CONFIDENCE,
  TRACK_IOU_THRESHOLD,
  TRACK_TTL_MS,
  VEHICLE_CLASSES,
} from './policy.js';
import { boxIou, clamp, isFiniteNumber } from './geometry.js';

/**
 * The interface every detector adapter implements.
 *
 * Documented as a JSDoc typedef rather than a class: a detector may be a
 * function, a module object or a remote call, and forcing inheritance on it
 * would be ceremony without benefit.
 * @typedef {object} VehicleDetector
 * @property {string} id
 * @property {string} label
 * @property {string} mode - Data mode of this detector's output.
 * @property {(frame:object) => Promise<object[]>|object[]} detect
 */

/**
 * Validate one detection into the pipeline's canonical shape.
 * @param {object} raw
 * @param {object} [context]
 * @param {string} [context.cameraId]
 * @param {number} [context.at]
 * @returns {object|null} Null for a detection below the confidence floor.
 */
export function normalizeDetection(raw, { cameraId = null, at = null } = {}) {
  if (!raw || !Array.isArray(raw.box) || raw.box.length < 4) return null;
  const [x, y, w, h] = raw.box;
  if (![x, y, w, h].every(isFiniteNumber) || w <= 0 || h <= 0) return null;
  const confidence = isFiniteNumber(raw.confidence) ? clamp(raw.confidence, 0, 1) : 0;
  if (confidence < DETECTION_MIN_CONFIDENCE) return null;
  const vehicleClass = VEHICLE_CLASSES.includes(raw.vehicleClass)
    ? raw.vehicleClass
    : 'car';
  // A detection whose class is `emergency` is a claim about a light bar or a
  // siren; without one of those signals it stays an ordinary vehicle so a
  // classifier cannot promote a van to an ambulance on its own.
  const emergencyHint =
    vehicleClass === 'emergency' &&
    (isFiniteNumber(raw.lightPattern) || isFiniteNumber(raw.siren));
  return Object.freeze({
    box: Object.freeze([x, y, w, h]),
    vehicleClass: emergencyHint || vehicleClass !== 'emergency' ? vehicleClass : 'car',
    confidence,
    cameraId: raw.cameraId || cameraId,
    at: raw.at ?? at,
    frameRef: raw.frameRef || null,
    lightPattern: isFiniteNumber(raw.lightPattern) ? clamp(raw.lightPattern, 0, 1) : null,
    siren: isFiniteNumber(raw.siren) ? clamp(raw.siren, 0, 1) : null,
    mode: raw.mode || DATA_MODES.simulated,
  });
}

/**
 * A registry of detector adapters, so the model provider is configurable.
 * @returns {object}
 */
export function createDetectorRegistry() {
  /** @type {Map<string, VehicleDetector>} */
  const adapters = new Map();
  let active = null;
  return Object.freeze({
    /**
     * Register an adapter.
     * @param {VehicleDetector} adapter
     */
    register(adapter) {
      if (!adapter?.id || typeof adapter.detect !== 'function')
        throw new TypeError('A detector needs an id and a detect function');
      adapters.set(adapter.id, adapter);
      if (!active) active = adapter.id;
      return adapter.id;
    },
    /** @param {string} id */
    select(id) {
      if (!adapters.has(id)) throw new Error(`Unknown detector: ${id}`);
      active = id;
      return adapters.get(id);
    },
    /** @returns {VehicleDetector|null} */
    current() {
      return active ? adapters.get(active) : null;
    },
    /** @returns {Array<{id:string,label:string,mode:string}>} */
    list() {
      return [...adapters.values()].map((adapter) => ({
        id: adapter.id,
        label: adapter.label || adapter.id,
        mode: adapter.mode || DATA_MODES.simulated,
      }));
    },
    /** @returns {number} */
    get size() {
      return adapters.size;
    },
  });
}

/**
 * Deterministic simulated detector.
 *
 * Useful and honest: it produces a stable sequence of vehicles for a given
 * seed, which lets the demo and the tests assert on real numbers without
 * pretending a model ran. Its output mode is SIMULATED and stays SIMULATED.
 * @param {object} [options]
 * @param {number} [options.seed=1]
 * @param {number} [options.maxPerFrame=6]
 * @returns {VehicleDetector}
 */
export function createSimulatedDetector({ seed = 1, maxPerFrame = 6 } = {}) {
  // A 32-bit LCG. Not a good RNG; a *reproducible* one, which is the property
  // this needs — the same seed must yield the same city every time.
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  let frame = 0;
  return Object.freeze({
    id: 'simulated',
    label: 'Built-in simulated detector',
    mode: DATA_MODES.simulated,
    /**
     * @param {object} input
     * @param {number} [input.width=1280] @param {number} [input.height=720]
     * @param {string} [input.cameraId]
     * @param {number} [input.at]
     * @param {number} [input.trafficIntensity=0.5] - 0–1 scene busyness.
     * @returns {object[]}
     */
    detect({ width = 1280, height = 720, cameraId = null, at = null, trafficIntensity = 0.5 } = {}) {
      frame += 1;
      const count = Math.round(clamp(trafficIntensity, 0, 1) * maxPerFrame);
      const out = [];
      for (let i = 0; i < count; i += 1) {
        const w = 40 + next() * 70;
        const h = 30 + next() * 55;
        const x = next() * Math.max(1, width - w);
        const y = height * 0.45 + next() * Math.max(1, height * 0.5 - h);
        const roll = next();
        const vehicleClass =
          roll > 0.96
            ? 'motorcycle'
            : roll > 0.86
              ? 'truck'
              : roll > 0.8
                ? 'bus'
                : 'car';
        out.push(
          normalizeDetection(
            {
              box: [x, y, w, h],
              vehicleClass,
              confidence: 0.62 + next() * 0.37,
              mode: DATA_MODES.simulated,
            },
            { cameraId, at },
          ),
        );
      }
      return out.filter(Boolean);
    },
    /** @returns {number} Frames this detector has processed. */
    get frameCount() {
      return frame;
    },
  });
}

/**
 * Create the short-lived scene tracker.
 *
 * Greedy IoU association by descending overlap. Deliberately not a Kalman
 * filter: the requirement is a tracking ID that survives occlusion for a
 * couple of seconds within one camera's view, and a filter would add state
 * (velocity, covariance) that could be used to reidentify a vehicle later.
 * This tracker remembers only where a box was.
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @param {number} [options.ttlMs]
 * @param {number} [options.iouThreshold]
 * @returns {object}
 */
export function createVehicleTracker({
  clock = () => Date.now(),
  ttlMs = TRACK_TTL_MS,
  iouThreshold = TRACK_IOU_THRESHOLD,
} = {}) {
  /** @type {Map<string, object>} */
  const tracks = new Map();
  let nextTrack = 1;
  let updates = 0;

  return Object.freeze({
    /**
     * Associate detections with existing tracks and update them.
     * @param {object[]} detections
     * @returns {Array<{trackId:string, detection:object, ageFrames:number, firstSeen:number}>}
     */
    update(detections = []) {
      updates += 1;
      const now = clock();
      const claimedTracks = new Set();
      const out = [];

      // Score every (detection, track) pair, then take the best first. Greedy
      // is sufficient here and is order-stable, which matters for the tests.
      const pairs = [];
      for (const [trackId, track] of tracks) {
        for (const [index, detection] of detections.entries()) {
          const iou = boxIou(track.box, detection.box);
          if (iou >= iouThreshold) pairs.push({ trackId, index, iou });
        }
      }
      pairs.sort((a, b) => b.iou - a.iou);
      const claimedDetections = new Set();
      for (const pair of pairs) {
        if (claimedTracks.has(pair.trackId) || claimedDetections.has(pair.index))
          continue;
        claimedTracks.add(pair.trackId);
        claimedDetections.add(pair.index);
        const track = tracks.get(pair.trackId);
        const detection = detections[pair.index];
        const updated = {
          ...track,
          box: detection.box,
          vehicleClass: detection.vehicleClass,
          confidence: detection.confidence,
          lastSeen: now,
          ageFrames: track.ageFrames + 1,
          misses: 0,
        };
        tracks.set(pair.trackId, updated);
        out.push({
          trackId: pair.trackId,
          detection,
          ageFrames: updated.ageFrames,
          firstSeen: updated.firstSeen,
        });
      }

      for (const [index, detection] of detections.entries()) {
        if (claimedDetections.has(index)) continue;
        const trackId = `TRK-${String(nextTrack++).padStart(5, '0')}`;
        tracks.set(trackId, {
          box: detection.box,
          vehicleClass: detection.vehicleClass,
          confidence: detection.confidence,
          firstSeen: now,
          lastSeen: now,
          ageFrames: 1,
          misses: 0,
        });
        // A track born in this frame was matched, not missed. Without this the
        // aging pass below would record a miss against every new vehicle and a
        // freshly-seen car would read as already intermittently occluded.
        claimedTracks.add(trackId);
        out.push({ trackId, detection, ageFrames: 1, firstSeen: now });
      }

      // Age out tracks that stopped being matched.
      for (const [trackId, track] of tracks) {
        if (now - track.lastSeen > ttlMs) {
          tracks.delete(trackId);
          continue;
        }
        if (!claimedTracks.has(trackId))
          tracks.set(trackId, { ...track, misses: track.misses + 1 });
      }
      return out;
    },

    /** @returns {object[]} Live tracks. */
    list() {
      return Object.freeze(
        [...tracks.entries()].map(([trackId, track]) =>
          Object.freeze({ trackId, ...track }),
        ),
      );
    },

    /** @param {string} trackId @returns {object|null} */
    get(trackId) {
      const track = tracks.get(trackId);
      return track ? Object.freeze({ trackId, ...track }) : null;
    },

    /** @returns {number} Frames processed. */
    get updateCount() {
      return updates;
    },

    /** @returns {number} Tracked vehicles alive right now. */
    get size() {
      return tracks.size;
    },

    clear() {
      tracks.clear();
    },
  });
}

/**
 * A plate reading, with the confidence rules applied.
 *
 * Rule 8: never invent characters. A character below the confidence floor is
 * replaced with `?`, and if the whole reading is under the plate floor the
 * function returns UNREADABLE with a null text. It does not guess, and it does
 * not pad the string to make it look complete.
 * @param {object} input
 * @param {Array<{char:string,confidence:number}>} [input.characters]
 * @param {number} [input.confidence] - Overall reading confidence.
 * @param {string} [input.region]
 * @param {string} [input.jurisdiction]
 * @param {object} [input.detection]
 * @param {string} [input.cameraId]
 * @param {number} [input.at]
 * @param {string} [input.frameRef]
 * @returns {object}
 */
export function plateResultFromCharacters({
  characters = [],
  confidence = null,
  region = '',
  jurisdiction = '',
  detection = null,
  cameraId = null,
  at = null,
  frameRef = null,
} = {}) {
  const masked = [];
  let sum = 0;
  let viable = 0;
  for (const entry of characters) {
    const char = typeof entry?.char === 'string' ? entry.char : '';
    const charConfidence = isFiniteNumber(entry?.confidence) ? entry.confidence : 0;
    if (!char) continue;
    if (charConfidence >= PLATE_MIN_CHAR_CONFIDENCE) {
      masked.push(char);
      sum += charConfidence;
      viable += 1;
    } else {
      // Below the per-character floor: mark it unknown rather than name it.
      masked.push('?');
    }
  }
  const charMean = viable ? sum / viable : 0;
  const overall = isFiniteNumber(confidence)
    ? clamp(confidence, 0, 1)
    : charMean;
  const textual = masked.join('');
  const unknownCount = masked.filter((char) => char === '?').length;
  const readable =
    masked.length > 0 &&
    overall >= PLATE_MIN_CONFIDENCE &&
    unknownCount === 0;

  return Object.freeze({
    plate: readable ? textual : null,
    display: readable ? textual : 'PLATE UNREADABLE',
    confidence: overall,
    charMean,
    unknownCount,
    readable,
    characters: Object.freeze(
      masked.map((char, index) =>
        Object.freeze({
          char,
          confidence: isFiniteNumber(characters[index]?.confidence)
            ? characters[index].confidence
            : 0,
        }),
      ),
    ),
    region: region || '',
    jurisdiction: jurisdiction || '',
    detection: detection || null,
    cameraId: cameraId || null,
    at: at ?? null,
    frameRef: frameRef || null,
    mode: DATA_MODES.simulated,
  });
}

/**
 * Plate-reading adapter interface.
 *
 * Same shape as the detector registry: a named adapter the platform selects. A
 * real ANPR vendor integration is one `register` call, and until one exists the
 * simulated reader is what runs — which is why the API returns a confidence
 * rather than a string.
 * @param {object} [options]
 * @param {number} [options.seed=7]
 * @returns {object}
 */
export function createPlateReader({ seed = 7 } = {}) {
  /** @type {Map<string, object>} */
  const adapters = new Map();
  let active = null;

  const simulated = {
    id: 'simulated-anpr',
    label: 'Built-in simulated ANPR (test plates only)',
    mode: DATA_MODES.simulated,
    /**
     * @param {object} input
     * @param {string} [input.trackId]
     * @param {number} [input.quality=0.95] - 0–1 frame quality.
     * @returns {object} A plate result.
     */
    read({ trackId = 'TRK-00000', quality = 0.95, jurisdiction = '', detection = null, cameraId = null, at = null, frameRef = null } = {}) {
      // A plate is fabricated from the track id ONLY because this adapter is a
      // stand-in. Every value is derived from the track and the reader's seed
      // rather than from a shared running state, so reading the SAME track
      // twice always yields the same plate and the same confidences. A reader
      // that drifted between calls on one vehicle would make a demo
      // unreplayable and a test flaky.
      const letters = 'TN';
      const digits = String(Math.abs(hashString(trackId)) % 10000).padStart(4, '0');
      const body = `${letters}${digits}`;
      const characters = [...body].map((char, index) => ({
        char,
        // Quality drives per-character confidence so a poor frame really does
        // produce an unreadable plate instead of a lucky guess.
        confidence: clamp(
          quality - deterministicJitter(seed, trackId, `char:${index}`) * 0.2,
          0,
          1,
        ),
      }));
      return plateResultFromCharacters({
        characters,
        confidence: clamp(
          quality - deterministicJitter(seed, trackId, 'overall') * 0.15,
          0,
          1,
        ),
        region: 'test',
        jurisdiction,
        detection,
        cameraId,
        at,
        frameRef,
      });
    },
  };

  adapters.set(simulated.id, simulated);
  active = simulated.id;

  return Object.freeze({
    register(adapter) {
      if (!adapter?.id || typeof adapter.read !== 'function')
        throw new TypeError('A plate reader needs an id and a read function');
      adapters.set(adapter.id, adapter);
      return adapter.id;
    },
    select(id) {
      if (!adapters.has(id)) throw new Error(`Unknown plate reader: ${id}`);
      active = id;
      return adapters.get(id);
    },
    current() {
      return adapters.get(active) || null;
    },
    list() {
      return [...adapters.values()].map((adapter) => ({
        id: adapter.id,
        label: adapter.label || adapter.id,
        mode: adapter.mode || DATA_MODES.simulated,
      }));
    },
    /**
     * Read a plate through the selected adapter.
     * @param {object} input
     * @returns {object|null} Null when no adapter is selected.
     */
    read(input = {}) {
      const adapter = adapters.get(active);
      if (!adapter) return null;
      return adapter.read(input);
    },
  });
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < String(value).length; i += 1) {
    hash = (hash * 31 + String(value).charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * A stable pseudo-random value in [0, 1) for a seed/key/salt triple.
 *
 * Derived from its inputs rather than from a shared running state, which is
 * what lets the simulated plate reader be replayed exactly. The result is
 * hashed again before scaling because a raw 32-bit integer's low bits from an
 * xorshift are poorly distributed at the small salt counts used here.
 * @param {number} seed @param {string} key @param {string} salt
 * @returns {number} In [0, 1).
 */
function deterministicJitter(seed, key, salt) {
  const mixed = hashString(`${seed >>> 0}:${key}:${salt}`);
  return (mixed >>> 0) / 0x100000000;
}

/**
 * Detect emergency vehicles from a set of detections.
 *
 * The visual class is only a hint; {@link fuseEmergencyDetection} in the
 * emergency module is the component that turns hints into a banded call. This
 * function's job is narrower: pull out the detections worth fusing.
 * @param {object[]} detections
 * @returns {object[]}
 */
export function emergencyCandidates(detections = []) {
  return detections.filter(
    (detection) =>
      detection.vehicleClass === 'emergency' ||
      isFiniteNumber(detection.lightPattern) ||
      isFiniteNumber(detection.siren),
  );
}

/**
 * Aggregate detections into a per-class census, for the traffic engine.
 * @param {object[]} detections
 * @returns {{total:number, byClass:Object<string,number>, meanConfidence:number|null}}
 */
export function detectionCensus(detections = []) {
  const byClass = Object.fromEntries(VEHICLE_CLASSES.map((name) => [name, 0]));
  let sum = 0;
  let count = 0;
  for (const detection of detections) {
    if (!detection) continue;
    byClass[detection.vehicleClass] = (byClass[detection.vehicleClass] || 0) + 1;
    if (isFiniteNumber(detection.confidence)) {
      sum += detection.confidence;
      count += 1;
    }
  }
  return {
    total: detections.filter(Boolean).length,
    byClass,
    meanConfidence: count ? sum / count : null,
  };
}

/**
 * Run one frame through detector → tracker.
 *
 * The pipeline is async-safe: a detector that returns a promise is awaited. The
 * caller gets both the raw detections and the tracked associations so the
 * event analyser can use whichever it needs.
 * @param {object} input
 * @param {object} input.detector @param {object} input.tracker
 * @param {object} input.frame
 * @returns {Promise<{detections:object[], tracked:object[], census:object}>}
 */
export async function runDetectionPipeline({ detector, tracker, frame } = {}) {
  if (typeof detector?.detect !== 'function')
    throw new TypeError('A detector is required');
  if (typeof tracker?.update !== 'function')
    throw new TypeError('A tracker is required');
  const raw = await detector.detect(frame);
  const detections = (Array.isArray(raw) ? raw : [])
    .map((item) => normalizeDetection(item, { cameraId: frame?.cameraId, at: frame?.at }))
    .filter(Boolean);
  const tracked = tracker.update(detections);
  return { detections, tracked, census: detectionCensus(detections) };
}
