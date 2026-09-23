/**
 * @file The command center's client-side state.
 *
 * One store, one refresh loop, one set of subscribers. Panels read from here
 * and never fetch independently, so two panels cannot disagree about the city
 * and an SSE burst cannot cause twenty redundant requests.
 *
 * Refresh policy:
 *
 *  - A slow poll (2 s) covers the aggregate readouts.
 *  - The SSE stream pushes individual events for the timeline.
 *  - A refresh is coalesced: a request made while one is in flight schedules
 *    exactly one follow-up rather than queueing.
 *
 * @module client/store
 */

import { api, openStream } from './api.js';

/** @const {number} Aggregate poll interval in milliseconds. */
const POLL_MS = 2000;
/** @const {number} Event-stream buffer length. */
const EVENT_BUFFER = 300;

/**
 * Create the store.
 * @param {object} [options]
 * @param {number} [options.pollMs]
 * @returns {object}
 */
export function createStore({ pollMs = POLL_MS } = {}) {
  /** @type {Set<Function>} */
  const listeners = new Set();

  const state = {
    ready: false,
    error: null,
    degraded: [],
    status: null,
    config: null,
    roads: [],
    intersections: [],
    signals: [],
    cameras: [],
    traffic: null,
    incidents: [],
    emergency: [],
    corridors: [],
    violations: [],
    violationSummary: null,
    events: [],
    audit: [],
    health: null,
    dataSources: null,
    simulation: null,
    scenarios: [],
    analytics: null,
    session: null,
    mode: 'overview',
    selection: null,
    stream: 'connecting',
    lastUpdate: null,
  };

  let pollTimer = null;
  let inFlight = false;
  let followUp = false;
  let stream = null;

  /** Notify subscribers. */
  function emit() {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        console.error('[signal-hub] subscriber failed', error);
      }
    }
  }

  /**
   * Whether the current session holds a capability.
   * @param {string} capability @returns {boolean}
   */
  function can(capability) {
    return (state.session?.capabilities || []).includes(capability);
  }

  /**
   * Fetch every aggregate readout in one pass.
   *
   * Each call is independently guarded: a failing camera endpoint yields an
   * empty camera list and a `degraded` note, and the rest of the command
   * center still updates. That is the difference between a degraded provider
   * and a dead console.
   *
   * Capability-gated endpoints are only requested when the session actually
   * holds the capability. A viewer asking for the plate-bearing violation list
   * would be refused by the server anyway, and a refusal that is expected is
   * not a fault — so it is neither requested nor reported as one.
   */
  async function refresh() {
    if (inFlight) {
      followUp = true;
      return;
    }
    inFlight = true;
    state.degraded = [];
    const allowed = (capability) => !capability || can(capability);
    try {
      const [
        status,
        roads,
        intersections,
        signals,
        cameras,
        traffic,
        incidents,
        emergency,
        corridors,
        violations,
        events,
        health,
        dataSources,
        simulation,
        analytics,
      ] = await Promise.all([
        settle('city status', () => api.status()),
        settle('roads', () => api.roads()),
        settle('intersections', () => api.intersections({ limit: 300 })),
        settle('signals', () => api.signals()),
        settle('cameras', () => api.cameras({ limit: 300 })),
        settle('traffic', () => api.traffic()),
        settle('incidents', () => api.incidents()),
        settle('emergency', () => api.emergency()),
        settle('corridors', () => api.corridors()),
        allowed('violations:view')
          ? settle('violations', () => api.violations({ limit: 200 }))
          : Promise.resolve(null),
        settle('events', () => api.events({ limit: 120 })),
        settle('health', () => api.health()),
        settle('data sources', () => api.dataSources()),
        settle('simulation', () => api.simulation()),
        settle('analytics', () => api.analytics(60)),
      ]);

      state.status = status;
      state.roads = roads?.roads || [];
      state.intersections = intersections?.intersections || [];
      state.signals = signals?.signals || [];
      state.cameras = cameras?.cameras || [];
      state.traffic = traffic;
      state.incidents = incidents?.incidents || [];
      state.emergency = emergency?.vehicles || [];
      state.corridors = corridors?.corridors || [];
      state.violations = violations?.violations || [];
      state.violationSummary = violations?.summary || null;
      state.events = events?.events || [];
      state.health = health;
      state.dataSources = dataSources;
      state.simulation = simulation;
      state.analytics = analytics;
      state.error = status ? null : 'The command API is not responding';
      state.ready = Boolean(status);
      state.lastUpdate = Date.now();
      void auditIfPermitted();
    } finally {
      inFlight = false;
      emit();
      if (followUp) {
        followUp = false;
        void refresh();
      }
    }
  }

  /**
   * Read a slice of state, recording a failure rather than throwing.
   * @param {string} label @param {Function} fn
   * @returns {Promise<any>}
   */
  async function settle(label, fn) {
    try {
      return await fn();
    } catch (error) {
      state.degraded.push({ label, message: error?.message || 'failed' });
      return null;
    }
  }

  /**
   * The audit log is capability-gated, so a viewer's 403 is expected and must
   * not be reported as a fault.
   */
  async function auditIfPermitted() {
    const capabilities = state.session?.capabilities || [];
    if (!capabilities.includes('audit:read')) {
      state.audit = [];
      return;
    }
    const result = await settle('audit', () => api.audit({ limit: 150 }));
    if (result) state.audit = result.entries || [];
  }

  /** Open the live stream. */
  function connect() {
    stream?.close();
    stream = openStream({
      onState: (value) => {
        state.stream = value === 'open' ? 'open' : value;
        emit();
      },
      onSnapshot: (snapshot) => {
        state.stream = 'open';
        if (snapshot?.status) state.status = snapshot.status;
        emit();
      },
      onEvent: (event) => {
        // The pushed event is prepended so the timeline updates the instant
        // something happens, without waiting for the next poll.
        state.events = [event, ...state.events].slice(0, EVENT_BUFFER);
        emit();
      },
    });
  }

  /**
   * Load the current session and its capabilities.
   *
   * Declared as a hoisted function rather than only as an object member
   * because `start()` depends on it before the returned object exists.
   */
  async function loadSession() {
    try {
      state.session = await api.session();
    } catch {
      state.session = {
        operator: 'anonymous',
        role: 'viewer',
        capabilities: ['city:view', 'traffic:view'],
        authenticated: false,
      };
    }
    emit();
  }

  return Object.freeze({
    state,

    /**
     * Subscribe to state changes.
     * @param {Function} listener @returns {Function} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Start polling and streaming. */
    async start() {
      await loadSession();
      await refresh();
      connect();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => void refresh(), pollMs);
    },

    /** Load the current session and its capabilities. */
    loadSession,

    /**
     * Sign in.
     * @param {string} operator @param {string} password
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    async signIn(operator, password) {
      try {
        const result = await api.login(operator, password);
        state.session = { ...result.session, authenticated: true };
        await refresh();
        connect();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message || 'Sign-in failed' };
      }
    },

    /** Sign out and fall back to the unauthenticated viewer. */
    async signOut() {
      api.logout();
      await loadSession();
      await refresh();
      connect();
    },

    /** @returns {boolean} */
    can,

    /**
     * Run a consequential action, then refresh.
     *
     * Every mutation funnels through here, so the UI never keeps optimistic
     * state that could disagree with the server: the panel re-reads the truth
     * after the action instead of guessing at it.
     * @param {Function} fn
     * @returns {Promise<{ok:boolean, result?:any, error?:string}>}
     */
    async act(fn) {
      try {
        const result = await fn();
        await refresh();
        return { ok: true, result };
      } catch (error) {
        state.error = error?.message || 'Action failed';
        emit();
        return { ok: false, error: error?.message || 'Action failed' };
      }
    },

    /**
     * Change the active page.
     * @param {string} mode
     */
    setMode(mode) {
      state.mode = mode;
      state.selection = null;
      emit();
    },

    /**
     * Select a map object or a list item.
     * @param {object|null} selection
     */
    select(selection) {
      state.selection = selection;
      emit();
    },

    /** Poll immediately. */
    refresh,

    /** Stop polling and streaming. */
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      stream?.close();
    },
  });
}
