/**
 * @file The Signal-HUB command API process.
 *
 * Owns exactly one traffic-control engine and serves the command center over
 * HTTP. The engine lives here rather than in the browser for three reasons that
 * matter: secrets never reach client code, every operator shares one city, and
 * the audit trail is written by the process that made the change.
 *
 * Routing is a plain `node:http` server against the small route table in
 * `api.mjs`; the frontend is served by Vite in development and by this process
 * in a built deployment, so there is one command to run in each case.
 *
 * @module signal-hub/server
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTrafficControlEngine } from '../src/traffic-control/engine.js';
import { DATA_MODES } from '../src/traffic-control/policy.js';
import { assertProductionConfig, createSessionAuthority } from './auth.mjs';
import { createApi } from './api.mjs';
import { AREA_PRESETS, resolveRoadNetwork } from './roads.mjs';
import { createStoreFromEnv, mirrorEngineRecords } from './store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** @const {Object<string,string>} */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
});

/**
 * Resolve startup configuration from the environment.
 * @param {object} env @returns {object}
 */
function readConfig(env) {
  const areaId = String(env.SIGNAL_HUB_AREA || 'chennai').toLowerCase();
  return {
    port: Number(env.API_PORT || 12001),
    host: env.API_HOST || '0.0.0.0',
    areaId,
    area: AREA_PRESETS[areaId] || AREA_PRESETS.grid,
    allowLiveRoads: String(env.SIGNAL_HUB_LIVE_ROADS || 'true').toLowerCase() !== 'false',
    seed: Number(env.SIGNAL_HUB_SEED || 7),
    maxIntersections: Number(env.SIGNAL_HUB_MAX_INTERSECTIONS || 60),
    serveStatic: String(env.SIGNAL_HUB_SERVE_STATIC || 'true').toLowerCase() !== 'false',
    autoStartSimulation: String(env.SIGNAL_HUB_AUTOSTART || 'false').toLowerCase() === 'true',
  };
}

/**
 * Start the command API.
 * @param {object} [options]
 * @param {object} [options.env=process.env]
 * @returns {Promise<{server:import('node:http').Server, engine:object, url:string}>}
 */
export async function startServer({ env = process.env } = {}) {
  const guard = assertProductionConfig(env);
  if (!guard.ok) {
    throw new Error(
      `Refusing to start in production with an insecure configuration:\n  - ${guard.problems.join('\n  - ')}`,
    );
  }

  const config = readConfig(env);
  const engine = createTrafficControlEngine({
    seed: config.seed,
    maxIntersections: config.maxIntersections,
  });

  // The road layer is resolved before the server listens, so the very first
  // request already sees a city. A failed Overpass fetch is a labelled fallback,
  // not a startup failure.
  const network = await resolveRoadNetwork({
    bbox: config.area.bbox,
    allowLive: config.allowLiveRoads,
  });
  const built = engine.loadNetwork(network.roads);

  const runtime = {
    roadSource: {
      mode: network.mode,
      source: network.source,
      detail: network.detail,
      fallbackReason: network.fallbackReason,
      area: config.area,
      receivedAt: Date.now(),
    },
    areas: Object.values(AREA_PRESETS).map((area) => ({
      id: area.id,
      label: area.label,
      lon: area.lon,
      lat: area.lat,
      height: area.height,
    })),
    map: {
      // A Cesium ion token is optional. Without one the globe still renders
      // with the bundled imagery, and the UI says which imagery is in use.
      cesiumIonToken: Boolean(env.CESIUM_ION_TOKEN),
      imagery: env.CESIUM_ION_TOKEN ? 'Cesium ion' : 'bundled OpenStreetMap imagery',
      liveTrafficProvider: Boolean(env.TOMTOM_API_KEY),
    },
    config,
  };

  const sessions = createSessionAuthority({
    secret: env.SIGNAL_HUB_SESSION_SECRET || undefined,
  });

  const { store, driver, note } = createStoreFromEnv(env);
  mirrorEngineRecords({ engine, store });
  runtime.roadSource.store = { driver, note };

  const api = createApi({ engine, sessions, runtime });

  const server = createServer(async (req, res) => {
    // A permissive CORS policy is correct here: the API is same-origin in the
    // built app and proxied in development, and the prototype is not a
    // credentialed cross-site service. Auth is a bearer token, not a cookie.
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (await api.handle(req, res)) return;
    } catch (error) {
      console.error('[signal-hub] api failure', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Command API failure' }));
      return;
    }

    if (config.serveStatic && req.method === 'GET') {
      if (await serveStatic(req, res)) return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((settle, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, settle);
  });

  if (config.autoStartSimulation) engine.setSimulationRunning({ running: true });

  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : config.port}`;
  return { server, engine, url, config, runtime, built };
}

/**
 * Serve a file from `dist/`, falling back to `index.html` for a client route.
 *
 * Path traversal is blocked by resolving against the dist root and rejecting
 * anything that escapes it.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
async function serveStatic(req, res) {
  const distRoot = resolve(root, 'dist');
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const candidate = normalize(join(distRoot, pathname === '/' ? 'index.html' : pathname));
  if (!candidate.startsWith(distRoot)) return false;

  const send = async (file) => {
    const body = await readFile(file);
    const type = CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    });
    res.end(body);
    return true;
  };

  try {
    const info = await stat(candidate);
    if (info.isFile()) return await send(candidate);
  } catch {
    // fall through to the SPA entry
  }
  try {
    return await send(join(distRoot, 'index.html'));
  } catch {
    return false;
  }
}

/** Start when run directly. */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const guard = assertProductionConfig();
  if (!guard.ok) {
    console.error('Refusing to start:', guard.problems.join('; '));
    process.exit(1);
  }
  try {
    const { url, engine, built, runtime } = await startServer();
    console.log(`[signal-hub] Command API listening on ${url}`);
    console.log(
      `[signal-hub] City: ${built.intersections} intersections, ${built.roads} roads — ${runtime.roadSource.mode} (${runtime.roadSource.source})`,
    );
    if (runtime.roadSource.fallbackReason) {
      console.log(`[signal-hub] Road fallback reason: ${runtime.roadSource.fallbackReason}`);
    }
    // Liveness must be observable: a heartbeat keeps controller health honest
    // and lets a fault raise a DEGRADED state rather than a stale OK.
    const heartbeat = setInterval(() => {
      for (const controller of engine.controllers.values()) controller.heartbeat();
    }, 5000);
    const shutdown = () => {
      clearInterval(heartbeat);
      engine.dispose();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('[signal-hub] failed to start:', error);
    process.exit(1);
  }
}

export { DATA_MODES };
