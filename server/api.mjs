/**
 * @file The Signal-HUB HTTP API.
 *
 * A thin, capability-gated façade over the traffic-control engine. Every
 * handler calls the engine rather than reimplementing any traffic logic, so
 * there is exactly one place where a signal changes, one place where a
 * violation is created, and one audit log.
 *
 * Two conventions the whole surface follows:
 *
 *  1. **Provenance travels with the data.** Responses carry the engine's
 *     `live`/`simulated`/`estimated`/`unavailable` modes rather than stripping
 *     them, so the client cannot accidentally present simulated traffic as real.
 *  2. **Consequential actions are gated and audited.** Anything that moves a
 *     signal, preempts a corridor, or reviews a violation checks a capability
 *     first and names the operator in the audit entry.
 *
 * @module signal-hub/server/api
 */

import { CAPABILITIES } from '../src/traffic-control/policy.js';

/** @const {number} Bounds a JSON body so a malformed request cannot exhaust memory. */
const MAX_BODY_BYTES = 256 * 1024;

/** @const {Record<string,number>} Per-session request budget. */
const RATE_LIMIT = Object.freeze({ windowMs: 1000, max: 60 });

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('Request body must be a JSON object');
      error.statusCode = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.statusCode) throw error;
    const bad = new Error('Request body is not valid JSON');
    bad.statusCode = 400;
    throw bad;
  }
}

/**
 * Coerce a query flag. `?apply=1`, `?apply=true` and `?apply=yes` are true.
 * @param {unknown} value @param {boolean} [fallback=false]
 * @returns {boolean}
 */
function asFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Build the API.
 *
 * @param {object} deps
 * @param {object} deps.engine - The traffic-control engine.
 * @param {object} deps.sessions - A session authority.
 * @param {object} [deps.runtime] - Mutable server runtime facts (road source, etc.).
 * @param {Function} [deps.now]
 * @returns {{handle:Function, subscribe:Function}}
 */
export function createApi({ engine, sessions, runtime = {}, now = () => Date.now() }) {
  /** @type {Set<object>} Subscribers to the engine's event stream. */
  const streamSubscribers = new Set();
  /** @type {Map<string,{count:number,resetAt:number}>} */
  const rateBuckets = new Map();

  // The SSE stream is fed from the engine's own event bus, so a subscriber sees
  // the same events the timeline and audit log do — there is no second source
  // of truth that could drift.
  engine.subscribeToEvents?.((event) => {
    for (const subscriber of streamSubscribers) {
      try {
        subscriber(event);
      } catch {
        streamSubscribers.delete(subscriber);
      }
    }
  });

  /**
   * Apply a simple per-operator request budget.
   * @param {string} key @returns {boolean} Whether the request is allowed.
   */
  function allow(key) {
    const at = now();
    const bucket = rateBuckets.get(key);
    if (!bucket || at > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: at + RATE_LIMIT.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT.max;
  }

  /**
   * Resolve the caller's session from a bearer token or a query token, since an
   * EventSource cannot set headers.
   * @param {import('node:http').IncomingMessage} req @param {URL} url
   * @returns {object}
   */
  function sessionFor(req, url) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    return sessions.resolve(bearer || url.searchParams.get('token') || null);
  }

  /** @const {Array<object>} Declarative route table, matched in order. */
  const routes = [
    // ─── Session ───────────────────────────────────────────────────────────
    {
      method: 'POST',
      pattern: /^\/api\/session\/login$/,
      handler: async ({ body }) => {
        const result = sessions.login(body.operator, body.password);
        if (!result.ok) {
          return { status: 401, body: { error: result.reason } };
        }
        return {
          status: 200,
          body: {
            token: result.token,
            session: {
              operator: result.session.operator,
              label: result.session.label,
              role: result.session.role,
              capabilities: sessions.capabilitiesFor(result.session.role),
            },
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/session$/,
      handler: ({ session }) => ({
        status: 200,
        body: {
          operator: session.operator,
          label: session.label,
          role: session.role,
          capabilities: session.capabilities,
          authenticated: session.authenticated,
          roles: sessions.listRoles(),
        },
      }),
    },

    // ─── City, traffic, network ────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/city\/status$/,
      capability: CAPABILITIES.viewCity,
      handler: () => ({
        status: 200,
        body: { ...engine.getStatus(), roadSource: runtime.roadSource || null },
      }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/roads$/,
      capability: CAPABILITIES.viewTraffic,
      handler: ({ url }) => {
        const bounds = parseBounds(url);
        const roads = engine.getRoads();
        return {
          status: 200,
          body: {
            roads: bounds ? roads.filter((road) => roadIntersectsBounds(road, bounds)) : roads,
            total: roads.length,
            bounds,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/roads\/([^/]+)$/,
      capability: CAPABILITIES.viewTraffic,
      handler: ({ params }) => {
        const road = engine.getRoad(params[0]);
        return road ? { status: 200, body: road } : { status: 404, body: { error: 'Unknown road' } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/intersections$/,
      capability: CAPABILITIES.viewTraffic,
      handler: ({ url }) => {
        const bounds = parseBounds(url);
        let list = engine.getIntersections();
        if (bounds) list = list.filter((item) => pointInBounds(item, bounds));
        const limit = clampInt(url.searchParams.get('limit'), 1, 400, 200);
        return {
          status: 200,
          body: { intersections: list.slice(0, limit), total: list.length, bounds },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/intersections\/([^/]+)$/,
      capability: CAPABILITIES.viewTraffic,
      handler: ({ params }) => {
        const intersection = engine.getIntersection(params[0]);
        if (!intersection) return { status: 404, body: { error: 'Unknown intersection' } };
        return {
          status: 200,
          body: {
            ...intersection,
            approaches: engine.getApproachTable(params[0]),
            recommendation: engine.getSignalRecommendation(params[0]),
            control: engine.describeControl(params[0]),
          },
        };
      },
    },

    // ─── Signals ───────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/signals$/,
      capability: CAPABILITIES.viewTraffic,
      handler: () => ({ status: 200, body: { signals: engine.getSignals() } }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/signals\/health$/,
      capability: CAPABILITIES.viewTraffic,
      handler: () => ({ status: 200, body: engine.getSignalHealth() }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/intersections\/([^/]+)\/signal\/recommend$/,
      capability: CAPABILITIES.viewTraffic,
      handler: ({ params, session }) => {
        const recommendation = engine.getSignalRecommendation(params[0]);
        if (!recommendation) {
          return { status: 404, body: { error: 'No recommendation available for that intersection' } };
        }
        return { status: 200, body: { intersectionId: params[0], recommendation, mode: 'estimated', by: session.operator } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/intersections\/([^/]+)\/signal\/phase$/,
      capability: CAPABILITIES.controlSignals,
      handler: ({ params, body, session }) => {
        const result = engine.setSignalPhase({
          intersectionId: params[0],
          group: body.group,
          phase: body.phase,
          greenMs: body.greenMs,
          role: session.role,
        });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/intersections\/([^/]+)\/signal\/green$/,
      capability: CAPABILITIES.controlSignals,
      handler: ({ params, body, session }) => {
        const ms = Number(body.ms);
        if (!Number.isFinite(ms)) return { status: 400, body: { error: 'ms must be a number' } };
        const result = ms >= 0
          ? engine.extendGreen({ intersectionId: params[0], ms, role: session.role })
          : engine.shortenGreen({ intersectionId: params[0], ms: -ms, role: session.role });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/intersections\/([^/]+)\/signal\/cycle$/,
      capability: CAPABILITIES.controlSignals,
      handler: ({ params, body, session }) => {
        const result = engine.setCycle({
          intersectionId: params[0],
          cycleMs: Number(body.cycleMs),
          role: session.role,
        });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/intersections\/([^/]+)\/signal\/fault$/,
      capability: CAPABILITIES.controlSignals,
      handler: ({ params, body, session }) => {
        const result = engine.setSignalFault({
          intersectionId: params[0],
          faulted: asFlag(body.faulted, true),
          reason: body.reason,
          role: session.role,
        });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },

    // ─── Traffic optimization ──────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/traffic$/,
      capability: CAPABILITIES.viewTraffic,
      handler: () => ({ status: 200, body: engine.getTraffic() }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/traffic\/optimize$/,
      capability: CAPABILITIES.controlSignals,
      handler: ({ body, session }) => {
        const results = engine.optimize({
          intersectionId: body.intersectionId || null,
          apply: asFlag(body.apply, false),
          role: session.role,
        });
        return { status: 200, body: { results, applied: asFlag(body.apply, false), by: session.operator } };
      },
    },

    // ─── Cameras ───────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/cameras$/,
      capability: CAPABILITIES.viewCity,
      handler: ({ url }) => {
        const bounds = parseBounds(url);
        let cameras = engine.getCameras();
        if (bounds) cameras = cameras.filter((camera) => pointInBounds(camera, bounds));
        const limit = clampInt(url.searchParams.get('limit'), 1, 600, 300);
        return { status: 200, body: { cameras: cameras.slice(0, limit), total: cameras.length } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/cameras\/health$/,
      capability: CAPABILITIES.viewCity,
      handler: () => ({ status: 200, body: engine.getCameraHealth() }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/cameras\/([^/]+)$/,
      capability: CAPABILITIES.viewCity,
      handler: ({ params }) => {
        const camera = engine.getCamera(params[0]);
        return camera ? { status: 200, body: camera } : { status: 404, body: { error: 'Unknown camera' } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/cameras\/([^/]+)\/frame$/,
      capability: CAPABILITIES.viewCity,
      handler: async ({ params, body, session }) => {
        const result = await engine.processFrame({
          cameraId: params[0],
          width: Number(body.width) || 1280,
          height: Number(body.height) || 720,
          trafficIntensity: body.trafficIntensity,
        });
        return { status: 200, body: { ...result, by: session.operator } };
      },
    },

    // ─── Incidents ─────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/incidents$/,
      capability: CAPABILITIES.viewTraffic,
      handler: ({ url }) => ({
        status: 200,
        body: {
          incidents: engine.getIncidents({
            includeCleared: asFlag(url.searchParams.get('includeCleared'), false),
          }),
        },
      }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/incidents$/,
      capability: CAPABILITIES.controlSignals,
      handler: ({ body, session }) => {
        const result = engine.raiseIncident({ ...body, role: session.role });
        return result.ok
          ? { status: 201, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/incidents\/([^/]+)\/clear$/,
      capability: CAPABILITIES.controlSignals,
      handler: ({ params, session }) => {
        const result = engine.clearIncident({ id: params[0], role: session.role });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 404, body: result };
      },
    },

    // ─── Emergency ─────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/emergency$/,
      capability: CAPABILITIES.viewTraffic,
      handler: () => ({ status: 200, body: engine.getEmergency() }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/emergency\/corridors$/,
      capability: CAPABILITIES.viewTraffic,
      handler: () => ({ status: 200, body: { corridors: engine.getCorridors() } }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/emergency\/simulate$/,
      capability: CAPABILITIES.runSimulation,
      handler: ({ body, session }) => {
        const result = engine.runScenario('ambulance', {
          type: body.type || 'ambulance',
          fromId: body.fromId,
          toId: body.toId,
          role: session.role,
        });
        return result.ok
          ? { status: 201, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/emergency\/preempt$/,
      capability: CAPABILITIES.preemptSignals,
      handler: ({ body, session }) => {
        const result = engine.preemptIntersection({
          corridorId: body.corridorId,
          intersectionId: body.intersectionId,
          role: session.role,
        });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/emergency\/release$/,
      capability: CAPABILITIES.preemptSignals,
      handler: ({ body, session }) => {
        const result = engine.releaseCorridor({
          corridorId: body.corridorId,
          role: session.role,
        });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },

    // ─── Violations and enforcement ────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/violations$/,
      capability: CAPABILITIES.viewViolations,
      handler: ({ url, session }) => {
        // Plate text exists only inside an authorized enforcement workflow, so
        // it is included only for a caller holding the plate capability.
        const includePlate = sessions.can(session, CAPABILITIES.viewPlate);
        return {
          status: 200,
          body: {
            violations: engine.getViolations({
              includePlate,
              reviewStatus: url.searchParams.get('reviewState') || undefined,
            }),
            summary: engine.getViolationSummary(),
            plateVisible: includePlate,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/violations\/([^/]+)$/,
      capability: CAPABILITIES.viewViolations,
      handler: ({ params, session }) => {
        const includePlate = sessions.can(session, CAPABILITIES.viewPlate);
        const violation = engine.getViolation(params[0], { includePlate });
        return violation
          ? { status: 200, body: { ...violation, plateVisible: includePlate } }
          : { status: 404, body: { error: 'Unknown violation' } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/violations\/([^/]+)\/review$/,
      capability: CAPABILITIES.reviewViolations,
      handler: ({ params, body, session }) => {
        const result = engine.reviewViolation({
          id: params[0],
          decision: body.decision,
          reviewer: session.operator,
          role: session.role,
          note: body.note,
        });
        return result.ok
          ? { status: 200, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/enforcement\/rules$/,
      capability: CAPABILITIES.viewViolations,
      handler: () => ({ status: 200, body: engine.getRules() }),
    },

    // ─── Simulation ────────────────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/simulation\/scenarios$/,
      capability: CAPABILITIES.viewTraffic,
      handler: () => ({ status: 200, body: engine.getScenarios() }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/simulation$/,
      capability: CAPABILITIES.viewTraffic,
      handler: () => ({ status: 200, body: engine.getSimulationState() }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/simulation\/start$/,
      capability: CAPABILITIES.runSimulation,
      handler: ({ session }) => ({
        status: 200,
        body: { ...engine.setSimulationRunning({ running: true }), by: session.operator },
      }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/simulation\/pause$/,
      capability: CAPABILITIES.runSimulation,
      handler: ({ session }) => ({
        status: 200,
        body: { ...engine.setSimulationRunning({ running: false }), by: session.operator },
      }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/simulation\/step$/,
      capability: CAPABILITIES.runSimulation,
      handler: ({ body, session }) => ({
        status: 200,
        body: {
          ...engine.stepSimulation({ stepS: Number(body.stepS) || undefined }),
          by: session.operator,
        },
      }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/simulation\/reset$/,
      capability: CAPABILITIES.runSimulation,
      handler: ({ session }) => ({
        status: 200,
        body: { ...engine.resetSimulation({ role: session.role }), by: session.operator },
      }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/simulation\/scenario$/,
      capability: CAPABILITIES.runSimulation,
      handler: ({ body, session }) => {
        const result = engine.runScenario(body.id, { ...body, role: session.role });
        return result.ok
          ? { status: 201, body: { ...result, by: session.operator } }
          : { status: 400, body: result };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/simulation\/demo$/,
      capability: CAPABILITIES.runSimulation,
      handler: async ({ session }) => {
        const result = await engine.runFullDemo({ role: session.role });
        return { status: 200, body: { ...result, by: session.operator } };
      },
    },

    // ─── Events, audit, sources, health ────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/api\/events$/,
      capability: CAPABILITIES.viewCity,
      handler: ({ url }) => ({
        status: 200,
        body: {
          events: engine.getEvents({
            limit: clampInt(url.searchParams.get('limit'), 1, 500, 120),
            category: url.searchParams.get('category') || undefined,
          }),
        },
      }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/audit$/,
      capability: CAPABILITIES.readAudit,
      handler: ({ url }) => ({
        status: 200,
        body: {
          entries: engine.getAudit({
            limit: clampInt(url.searchParams.get('limit'), 1, 500, 150),
          }),
        },
      }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/data-sources$/,
      capability: CAPABILITIES.viewCity,
      handler: () => ({
        status: 200,
        body: { ...engine.getDataSources(), roadSource: runtime.roadSource || null },
      }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/health$/,
      capability: CAPABILITIES.viewCity,
      handler: () => ({ status: 200, body: engine.getSystemHealth() }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/analytics$/,
      capability: CAPABILITIES.viewTraffic,
      handler: ({ url }) => ({
        status: 200,
        body: engine.getAnalytics({
          windowMinutes: clampInt(url.searchParams.get('window'), 5, 720, 60),
        }),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/config$/,
      capability: CAPABILITIES.viewCity,
      handler: () => ({
        status: 200,
        body: {
          operatingModes: engine.getOperatingModes(),
          operatingMode: engine.getOperatingMode(),
          areas: runtime.areas || [],
          map: runtime.map || {},
        },
      }),
    },
  ];

  return Object.freeze({
    /**
     * Handle one request.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @returns {Promise<boolean>} Whether the request was handled.
     */
    async handle(req, res) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const session = sessionFor(req, url);

      // Server-Sent Events stream. Declared here rather than in the table
      // because it holds the connection open instead of returning a body.
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        if (!sessions.can(session, CAPABILITIES.viewCity)) {
          sendJson(res, 403, { error: 'Not permitted to view the city stream' });
          return true;
        }
        return handleStream(req, res, session);
      }

      if (!allow(session.operator)) {
        sendJson(res, 429, { error: 'Too many requests — slow down' });
        return true;
      }

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = url.pathname.match(route.pattern);
        if (!match) continue;

        if (route.capability && !sessions.can(session, route.capability)) {
          sendJson(res, 403, {
            error: `Role "${session.role}" lacks capability "${route.capability}"`,
            capability: route.capability,
            role: session.role,
          });
          return true;
        }

        let body = {};
        if (req.method === 'POST') {
          try {
            body = await readJsonBody(req);
          } catch (error) {
            sendJson(res, error.statusCode || 400, { error: error.message });
            return true;
          }
        }

        try {
          const result = await route.handler({
            params: match.slice(1).map((value) => decodeURIComponent(value)),
            body,
            url,
            session,
            req,
          });
          sendJson(res, result.status, result.body);
        } catch (error) {
          // A handler fault is logged server-side and reported generically:
          // internals never travel to the client.
          console.error('[signal-hub] handler error', url.pathname, error);
          sendJson(res, error.statusCode || 500, {
            error: error.statusCode
              ? error.message
              : 'Internal error handling the request',
          });
        }
        return true;
      }

      return false;
    },

    /** @returns {number} Live SSE subscriber count, for the health page. */
    streamSubscriberCount() {
      return streamSubscribers.size;
    },
  });

  /**
   * Open an SSE stream and push engine events as they occur.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object} session
   */
  function handleStream(req, res, session) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);

    const send = (event) => {
      res.write(`event: traffic-event\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Give the new subscriber the state it cannot derive from future events
    // alone, so a reconnect does not leave the panel blank until something
    // happens.
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({
        actor: session.operator,
        status: engine.getStatus(),
        at: now(),
      })}\n\n`,
    );

    streamSubscribers.add(send);
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: now() })}\n\n`);
    }, 15_000);

    const close = () => {
      clearInterval(heartbeat);
      streamSubscribers.delete(send);
    };
    req.on('close', close);
    req.on('error', close);
    return true;
  }
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status @param {object} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Parse `?west=&south=&east=&north=` into a bounds object.
 * @param {URL} url @returns {object|null}
 */
function parseBounds(url) {
  const west = Number(url.searchParams.get('west'));
  const south = Number(url.searchParams.get('south'));
  const east = Number(url.searchParams.get('east'));
  const north = Number(url.searchParams.get('north'));
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

/** @param {{lon:number,lat:number}} point @param {object} bounds */
function pointInBounds(point, bounds) {
  return (
    point.lon >= bounds.west
    && point.lon <= bounds.east
    && point.lat >= bounds.south
    && point.lat <= bounds.north
  );
}

/** @param {object} road @param {object} bounds */
function roadIntersectsBounds(road, bounds) {
  const coordinates = road.coordinates || [];
  return coordinates.some(([lon, lat]) => pointInBounds({ lon, lat }, bounds));
}

/**
 * Clamp an integer query parameter.
 * @param {string|null} raw @param {number} min @param {number} max @param {number} fallback
 * @returns {number}
 */
function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
