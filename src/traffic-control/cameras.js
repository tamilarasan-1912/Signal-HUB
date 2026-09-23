/**
 * @file Camera registry for the traffic-control plane.
 *
 * Reuses the existing CCTV architecture rather than duplicating it: camera
 * *identity, position and feed URLs* come from the repository's own catalog
 * (`server/providers/cctv/catalog.js` behind `/api/cctv/sources`), and this
 * module adds the operational view — which intersection an approach belongs to,
 * whether its feed is healthy, and whether a failure is worth an incident.
 *
 * Nothing here fetches media. Serving a frame is the CCTV proxy's job, and it
 * already has the fallback chain (upstream → Street View → synthetic SVG) that
 * DATA-SOURCES.md documents.
 *
 * @module traffic-control/cameras
 */

import { DATA_MODES } from './policy.js';

/**
 * Normalize one camera from the repository's catalog shape into a traffic
 * camera record.
 * @param {object} source
 * @param {object} [options]
 * @param {string} [options.mode] - `live` for a configured feed, `simulated`
 *   for one the scenario engine invented.
 * @returns {object|null}
 */
export function normalizeCamera(source, { mode = DATA_MODES.live } = {}) {
  if (!source || typeof source.id !== 'string' || !source.id) return null;
  const lat = Number(source.lat);
  const lon = Number(source.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const feedType = typeof source.feedType === 'string' ? source.feedType : 'image';
  const configured = Boolean(source.url || source.snapshotUrl);
  return Object.freeze({
    id: source.id,
    name: source.name || source.label || source.id,
    city: source.city || '',
    lon,
    lat,
    headingDeg: Number.isFinite(Number(source.headingDeg)) ? Number(source.headingDeg) : null,
    fovDeg: Number.isFinite(Number(source.fovDeg)) ? Number(source.fovDeg) : null,
    provider: source.provider || '',
    feedType,
    // A camera with no upstream URL is not a broken camera — it is an
    // unconfigured one, and the two must not be reported the same way.
    status: configured ? 'unknown' : 'unconfigured',
    sourceKind: source.sourceKind || (configured ? 'configured' : 'unconfigured'),
    frameUrl: `/api/cctv/frame/${encodeURIComponent(source.id)}`,
    mediaUrl: configured && feedType !== 'image'
      ? `/api/cctv/media/${encodeURIComponent(source.id)}`
      : null,
    message: configured ? 'Awaiting first health report' : 'No upstream configured',
    intersectionId: null,
    roadId: null,
    approach: null,
    updatedAt: null,
    mode: configured ? mode : DATA_MODES.unconfigured,
  });
}

/**
 * The camera registry.
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @returns {object}
 */
export function createCameraRegistry({ clock = () => Date.now() } = {}) {
  /** @type {Map<string, object>} */
  const cameras = new Map();

  const registry = {
    /**
     * Replace the registry from a catalog payload.
     * @param {object[]} sources
     * @returns {number} How many were kept.
     */
    load(sources = []) {
      cameras.clear();
      let kept = 0;
      for (const source of sources) {
        const camera = normalizeCamera(source);
        if (!camera) continue;
        cameras.set(camera.id, camera);
        kept += 1;
      }
      return kept;
    },

    /**
     * Add or replace one camera. Used by the simulator for a synthetic camera.
     * @param {object} camera
     * @returns {object|null}
     */
    upsert(camera) {
      const normalized = camera?.id && camera?.mode
        ? Object.freeze({ ...camera })
        : normalizeCamera(camera, { mode: DATA_MODES.simulated });
      if (!normalized) return null;
      cameras.set(normalized.id, normalized);
      return normalized;
    },

    /** @param {string} id @returns {object|null} */
    get(id) {
      return cameras.get(id) || null;
    },

    /** @returns {object[]} */
    list() {
      return Object.freeze([...cameras.values()]);
    },

    /**
     * Update a camera's reported health.
     * @param {string} id
     * @param {object} patch
     * @returns {object|null}
     */
    setStatus(id, patch = {}) {
      const camera = cameras.get(id);
      if (!camera) return null;
      const updated = Object.freeze({
        ...camera,
        status: patch.status || camera.status,
        sourceKind: patch.sourceKind || camera.sourceKind,
        message: patch.message || camera.message,
        updatedAt: clock(),
      });
      cameras.set(id, updated);
      return updated;
    },

    /**
     * Bind cameras to intersection approaches by proximity and bearing.
     *
     * A camera is attached to the approach whose bearing from the intersection
     * matches where the camera actually sits, so "the camera on the north
     * approach" means a camera north of the junction — not whichever one
     * happened to sort first.
     * @param {object[]} intersections
     * @param {number} [radiusM=80]
     * @returns {Map<string, string>} cameraId → intersectionId
     */
    bindToIntersections(intersections = [], radiusM = 80) {
      /** @type {Map<string, string>} */
      const bound = new Map();
      for (const [id, camera] of cameras) {
        let best = null;
        for (const intersection of intersections) {
          const gap = distanceM(
            camera.lon,
            camera.lat,
            intersection.lon,
            intersection.lat,
          );
          if (gap > radiusM) continue;
          if (!best || gap < best.distanceM) best = { intersection, distanceM: gap };
        }
        if (!best) continue;
        const approach = bearingApproach(
          best.intersection,
          camera.lon,
          camera.lat,
        );
        const updated = Object.freeze({
          ...camera,
          intersectionId: best.intersection.id,
          approach,
        });
        cameras.set(id, updated);
        bound.set(id, best.intersection.id);
      }
      return bound;
    },

    /**
     * Cameras bound to an intersection (or its approaches).
     * @param {string} intersectionId
     * @returns {object[]}
     */
    forIntersection(intersectionId) {
      return Object.freeze(
        [...cameras.values()].filter(
          (camera) => camera.intersectionId === intersectionId,
        ),
      );
    },

    /**
     * Health summary for the top bar.
     * @returns {{total:number, ok:number, degraded:number, unconfigured:number,
     *   unknown:number, mode:string}}
     */
    summary() {
      let ok = 0;
      let degraded = 0;
      let unconfigured = 0;
      let unknown = 0;
      for (const camera of cameras.values()) {
        if (camera.status === 'ok') ok += 1;
        else if (camera.status === 'degraded') degraded += 1;
        else if (camera.status === 'unconfigured') unconfigured += 1;
        else unknown += 1;
      }
      const live = ok + degraded;
      return {
        total: cameras.size,
        ok,
        degraded,
        unconfigured,
        unknown,
        // The summary's own mode reflects what is actually flowing: any healthy
        // configured feed makes this LIVE-ish, but a catalogue of unconfigured
        // entries must not read as a live camera network.
        mode: live ? DATA_MODES.live : cameras.size ? DATA_MODES.unconfigured : DATA_MODES.unavailable,
      };
    },

    clear() {
      cameras.clear();
    },
  };
  return Object.freeze(registry);
}

function distanceM(lonA, latA, lonB, latB) {
  const DEG = Math.PI / 180;
  const dLat = (latB - latA) * DEG;
  const dLon = (lonB - lonA) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * DEG) * Math.cos(latB * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingApproach(intersection, lon, lat) {
  const DEG = Math.PI / 180;
  const dLon = (lon - intersection.lon) * DEG;
  const lat1 = intersection.lat * DEG;
  const lat2 = lat * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = ((Math.atan2(y, x) / DEG) + 360) % 360;
  if (deg >= 315 || deg < 45) return 'N';
  if (deg < 135) return 'E';
  if (deg < 225) return 'S';
  return 'W';
}
