/**
 * @file Road-network acquisition for Signal-HUB.
 *
 * Two sources, and the caller always knows which one answered:
 *
 *  - **Overpass / OpenStreetMap** — real road geometry, labelled `live`.
 *  - **A generated grid** — a deterministic synthetic city used when Overpass
 *    is unreachable or no area is configured, labelled `simulated`.
 *
 * The generated grid exists so the application still demonstrates a full
 * city-scale workflow with no network access. It is never presented as a real
 * place: the returned descriptor carries the mode, and the UI is expected to
 * show it.
 *
 * The Overpass decoding mirrors the road shaping the God's Eye View foundation
 * uses (see `src/sources/overpassRoads.js` upstream): ways become
 * `{coordinates, type, oneway}` records for the traffic-control layer.
 *
 * @module signal-hub/server/roads
 */

import { DATA_MODES } from '../src/traffic-control/policy.js';

/** @const {string} An Overpass instance. Overridable for a self-hosted mirror. */
const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** @const {number} Bound on how long a road fetch may take. */
const OVERPASS_TIMEOUT_MS = 25_000;

/**
 * Highway classes the traffic-control network understands. Fetching driveable
 * ways only keeps the payload and the resulting graph relevant to traffic.
 * @const {string}
 */
const DRIVEABLE_HIGHWAYS = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
].join('|');

/**
 * Decode an Overpass payload into traffic-control road records.
 *
 * Exported separately from the fetch so it can be tested against a captured
 * payload with no network access.
 * @param {object} payload
 * @returns {object[]}
 */
export function normalizeOverpassRoads(payload) {
  const roads = [];
  for (const element of payload?.elements || []) {
    if (element.type !== 'way' || !Array.isArray(element.geometry)) continue;
    if (element.geometry.length < 2) continue;
    const oneway = element.tags?.oneway;
    const roundabout = element.tags?.junction === 'roundabout';
    roads.push({
      id: `OSM-${element.id}`,
      name: element.tags?.name || element.tags?.ref || null,
      coordinates: element.geometry.map((point) => [point.lon, point.lat]),
      type: element.tags?.highway || 'unclassified',
      oneway: oneway === 'yes' || oneway === '1' || oneway === 'true' || roundabout
        ? 1
        : oneway === '-1'
          ? -1
          : 0,
    });
  }
  return roads;
}

/**
 * Build the Overpass query for a bounding box.
 * @param {{south:number,west:number,north:number,east:number}} bbox
 * @returns {string}
 */
export function overpassQuery(bbox) {
  const { south, west, north, east } = bbox;
  return `[out:json][timeout:20];way["highway"~"^(${DRIVEABLE_HIGHWAYS})$"](${south},${west},${north},${east});out geom;`;
}

/**
 * Fetch road geometry from Overpass.
 * @param {object} options
 * @param {{south:number,west:number,north:number,east:number}} options.bbox
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {string} [options.url]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok:boolean, roads?:object[], reason?:string, elapsedMs:number}>}
 */
export async function fetchOverpassRoads({
  bbox,
  fetchImpl = globalThis.fetch,
  url = process.env.OVERPASS_URL || DEFAULT_OVERPASS_URL,
  timeoutMs = OVERPASS_TIMEOUT_MS,
} = {}) {
  const started = Date.now();
  if (!bbox) return { ok: false, reason: 'no bounding box', elapsedMs: 0 };
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'no fetch implementation', elapsedMs: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Overpass asks clients to identify themselves.
        'user-agent': 'Signal-HUB/0.1 (traffic-control prototype)',
      },
      body: `data=${encodeURIComponent(overpassQuery(bbox))}`,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `Overpass responded ${response.status}`,
        elapsedMs: Date.now() - started,
      };
    }
    const payload = await response.json();
    const roads = normalizeOverpassRoads(payload);
    if (!roads.length) {
      return { ok: false, reason: 'Overpass returned no driveable ways', elapsedMs: Date.now() - started };
    }
    return { ok: true, roads, elapsedMs: Date.now() - started };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? `Overpass timed out after ${timeoutMs} ms` : `Overpass unreachable: ${error?.message || error}`,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A deterministic street grid, as a stand-in city.
 *
 * Real geometry would be preferable, so this is labelled `simulated` in the
 * descriptor and the UI states it plainly. Spacing is ~1.1 km, close enough to
 * a dense urban grid that the queue and delay arithmetic behaves realistically.
 * @param {object} [options]
 * @param {number} [options.blocks=5] @param {number} [options.spacing=0.01]
 * @param {number} [options.lon=80.2] @param {number} [options.lat=13.08]
 * @returns {object[]}
 */
export function generateGridCity({ blocks = 5, spacing = 0.01, lon = 80.2, lat = 13.08 } = {}) {
  const roads = [];
  for (let row = 0; row < blocks; row += 1) {
    const y = lat + row * spacing;
    const coordinates = [];
    for (let col = 0; col < blocks; col += 1) coordinates.push([lon + col * spacing, y]);
    roads.push({
      id: `GRID-EW-${row}`,
      name: `East–West Avenue ${row + 1}`,
      coordinates,
      type: row % 2 === 0 ? 'primary' : 'secondary',
      oneway: 0,
    });
  }
  for (let col = 0; col < blocks; col += 1) {
    const x = lon + col * spacing;
    const coordinates = [];
    for (let row = 0; row < blocks; row += 1) coordinates.push([x, lat + row * spacing]);
    roads.push({
      id: `GRID-NS-${col}`,
      name: `North–South Street ${col + 1}`,
      coordinates,
      type: col % 2 === 0 ? 'primary' : 'secondary',
      oneway: 0,
    });
  }
  return roads;
}

/**
 * Resolve the road network for a named city area, live where possible.
 *
 * Never throws: an unreachable Overpass is a labelled fallback, not a crash,
 * because a failed map provider must not take the whole command center down.
 * @param {object} [options]
 * @param {{south:number,west:number,north:number,east:number}} [options.bbox]
 * @param {boolean} [options.allowLive=true] - Set false to force the generated city.
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<object>}
 */
export async function resolveRoadNetwork({ bbox = null, allowLive = true, fetchImpl } = {}) {
  if (allowLive && bbox) {
    const live = await fetchOverpassRoads({ bbox, fetchImpl });
    if (live.ok) {
      return Object.freeze({
        roads: live.roads,
        mode: DATA_MODES.live,
        source: 'OpenStreetMap via Overpass',
        detail: `${live.roads.length} ways fetched in ${live.elapsedMs} ms`,
        fallbackReason: null,
      });
    }
    return Object.freeze({
      roads: generateGridCity(),
      mode: DATA_MODES.simulated,
      source: 'Generated street grid',
      detail: 'Synthetic city — real geometry unavailable',
      fallbackReason: live.reason,
    });
  }
  return Object.freeze({
    roads: generateGridCity(),
    mode: DATA_MODES.simulated,
    source: 'Generated street grid',
    detail: 'Synthetic city — no area configured',
    fallbackReason: bbox ? null : 'no bounding box configured',
  });
}

/** @const {object} A few preset areas so the demo has somewhere to load. */
export const AREA_PRESETS = Object.freeze({
  chennai: Object.freeze({
    id: 'chennai',
    label: 'Chennai (Anna Nagar)',
    bbox: Object.freeze({ south: 13.06, west: 80.18, north: 13.11, east: 80.24 }),
    lon: 80.21,
    lat: 13.085,
    height: 4200,
  }),
  bengaluru: Object.freeze({
    id: 'bengaluru',
    label: 'Bengaluru (Central)',
    bbox: Object.freeze({ south: 12.93, west: 77.55, north: 12.99, east: 77.63 }),
    lon: 77.59,
    lat: 12.96,
    height: 5200,
  }),
  grid: Object.freeze({
    id: 'grid',
    label: 'Generated grid city',
    bbox: null,
    lon: 80.2,
    lat: 13.08,
    height: 3200,
  }),
});
