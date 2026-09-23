/**
 * @file The browser's single point of contact with the command API.
 *
 * Every call goes through `request()`, which owns the session token, the
 * base path, and the error shape. A component never builds a URL or reads a
 * token itself, so there is exactly one place where authorization and error
 * handling can be wrong.
 *
 * @module client/api
 */

/** @const {string} Base path. Same-origin in the built app, proxied in dev. */
const BASE = '';

/** @const {string} Where the session token is kept. */
const TOKEN_KEY = 'signal-hub.token';

/** @type {string|null} */
let token = safeReadToken();

/** @type {Set<Function>} */
const authListeners = new Set();

/** @returns {string|null} */
function safeReadToken() {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) || null;
  } catch {
    // Private browsing or a blocked storage API must not break the app.
    return null;
  }
}

/**
 * Persist the session token and notify listeners.
 * @param {string|null} value
 */
function setToken(value) {
  token = value;
  try {
    if (value) globalThis.localStorage?.setItem(TOKEN_KEY, value);
    else globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    // Ignore: the in-memory token still works for this page life.
  }
  for (const listener of authListeners) listener(Boolean(value));
}

/**
 * An API failure carrying the server's message and status.
 */
export class ApiError extends Error {
  /**
   * @param {string} message @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Perform a request against the command API.
 * @param {string} path @param {object} [options]
 * @returns {Promise<any>}
 */
async function request(path, { method = 'GET', body = null, signal = null } = {}) {
  const headers = {};
  if (body !== null) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // A transport failure is reported as such, not as an empty success: the
    // panels distinguish "no data" from "could not reach the server".
    throw new ApiError(`Cannot reach the command API (${error?.message || 'network error'})`, 0);
  }

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: 'Malformed response from the command API' };
    }
  }

  if (!response.ok) {
    if (response.status === 401) setToken(null);
    throw new ApiError(payload?.error || `Request failed (${response.status})`, response.status);
  }
  return payload;
}

/**
 * The command API surface the panels use.
 * @const {object}
 */
export const api = Object.freeze({
  // Session
  login: (operator, password) =>
    request('/api/session/login', { method: 'POST', body: { operator, password } }).then((result) => {
      setToken(result.token);
      return result;
    }),
  logout: () => setToken(null),
  session: () => request('/api/session'),
  hasToken: () => Boolean(token),

  /**
   * Subscribe to sign-in/out changes.
   * @param {Function} listener @returns {Function} unsubscribe
   */
  onAuthChange(listener) {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  },

  // City and traffic
  status: () => request('/api/city/status'),
  config: () => request('/api/config'),
  roads: (bounds) => request(`/api/roads${query(bounds)}`),
  traffic: () => request('/api/traffic'),
  analytics: (windowMinutes) => request(`/api/analytics?window=${windowMinutes}`),
  health: () => request('/api/health'),
  dataSources: () => request('/api/data-sources'),

  // Intersections and signals
  intersections: (params) => request(`/api/intersections${query(params)}`),
  intersection: (id) => request(`/api/intersections/${encodeURIComponent(id)}`),
  signals: () => request('/api/signals'),
  signalHealth: () => request('/api/signals/health'),
  signalRecommendation: (id) =>
    request(`/api/intersections/${encodeURIComponent(id)}/signal/recommend`, { method: 'POST' }),
  setSignalPhase: (id, body) =>
    request(`/api/intersections/${encodeURIComponent(id)}/signal/phase`, { method: 'POST', body }),
  setGreen: (id, ms) =>
    request(`/api/intersections/${encodeURIComponent(id)}/signal/green`, { method: 'POST', body: { ms } }),
  setCycle: (id, cycleMs) =>
    request(`/api/intersections/${encodeURIComponent(id)}/signal/cycle`, { method: 'POST', body: { cycleMs } }),
  setSignalFault: (id, faulted, reason) =>
    request(`/api/intersections/${encodeURIComponent(id)}/signal/fault`, {
      method: 'POST',
      body: { faulted, reason },
    }),
  optimize: (body = {}) => request('/api/traffic/optimize', { method: 'POST', body }),

  // Cameras
  cameras: (params) => request(`/api/cameras${query(params)}`),
  camera: (id) => request(`/api/cameras/${encodeURIComponent(id)}`),
  cameraHealth: () => request('/api/cameras/health'),
  processFrame: (id, body = {}) =>
    request(`/api/cameras/${encodeURIComponent(id)}/frame`, { method: 'POST', body }),

  // Incidents
  incidents: (params) => request(`/api/incidents${query(params)}`),
  raiseIncident: (body) => request('/api/incidents', { method: 'POST', body }),
  clearIncident: (id) => request(`/api/incidents/${encodeURIComponent(id)}/clear`, { method: 'POST' }),

  // Emergency
  emergency: () => request('/api/emergency'),
  corridors: () => request('/api/emergency/corridors'),
  simulateEmergency: (body = {}) => request('/api/emergency/simulate', { method: 'POST', body }),
  preempt: (body) => request('/api/emergency/preempt', { method: 'POST', body }),
  releaseCorridor: (corridorId) =>
    request('/api/emergency/release', { method: 'POST', body: { corridorId } }),

  // Violations and enforcement
  violations: (params) => request(`/api/violations${query(params)}`),
  violation: (id) => request(`/api/violations/${encodeURIComponent(id)}`),
  reviewViolation: (id, body) =>
    request(`/api/violations/${encodeURIComponent(id)}/review`, { method: 'POST', body }),
  rules: () => request('/api/enforcement/rules'),

  // Simulation
  scenarios: () => request('/api/simulation/scenarios'),
  simulation: () => request('/api/simulation'),
  startSimulation: () => request('/api/simulation/start', { method: 'POST' }),
  pauseSimulation: () => request('/api/simulation/pause', { method: 'POST' }),
  stepSimulation: (stepS) =>
    request('/api/simulation/step', { method: 'POST', body: stepS ? { stepS } : {} }),
  resetSimulation: () => request('/api/simulation/reset', { method: 'POST' }),
  runScenario: (id, body = {}) => request('/api/simulation/scenario', { method: 'POST', body: { id, ...body } }),
  runDemo: () => request('/api/simulation/demo', { method: 'POST' }),

  // Events and audit
  events: (params) => request(`/api/events${query(params)}`),
  audit: (params) => request(`/api/audit${query(params)}`),
});

/**
 * Build a query string, dropping empty values.
 * @param {object|null} params @returns {string}
 */
function query(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * Open the live event stream.
 *
 * An `EventSource` cannot set headers, so the token travels as a query
 * parameter; the server accepts either. A stream that drops reconnects on its
 * own, which is why there is no manual retry loop here.
 * @param {object} handlers
 * @param {(event:object)=>void} handlers.onEvent
 * @param {(snapshot:object)=>void} [handlers.onSnapshot]
 * @param {(state:string)=>void} [handlers.onState]
 * @returns {{close:Function}}
 */
export function openStream({ onEvent, onSnapshot, onState }) {
  const source = new EventSource(`/api/stream?token=${encodeURIComponent(token || '')}`);
  source.addEventListener('traffic-event', (message) => {
    try {
      onEvent?.(JSON.parse(message.data));
    } catch {
      // A malformed frame is dropped; the next event still arrives.
    }
  });
  source.addEventListener('snapshot', (message) => {
    try {
      onSnapshot?.(JSON.parse(message.data));
    } catch {
      /* ignore */
    }
  });
  source.addEventListener('open', () => onState?.('open'));
  source.addEventListener('error', () => onState?.('error'));
  return {
    close: () => source.close(),
  };
}
