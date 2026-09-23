/**
 * @file Event bus and the audit trail.
 *
 * Two separate concerns that share a shape:
 *
 *  - {@link createEventBus} is the live stream the bottom panel renders. It is
 *    a bounded ring buffer — an operator console that grows without limit is a
 *    memory leak with a UI.
 *  - {@link createAuditLog} is the durable record of consequential commands.
 *    Rule 11 requires one; it is a distinct log because a stream entry may be
 *    dropped by the ring and an audit entry must not be.
 *
 * Both are plain data structures with injectable clocks, so a test can assert
 * on the exact sequence without waiting.
 *
 * @module traffic-control/events
 */

import {
  AUDIT_RING_CAPACITY,
  DATA_MODES,
  EVENT_RING_CAPACITY,
} from './policy.js';

/** @const {Object<string,string>} Severity vocabulary for stream entries. */
export const SEVERITY = Object.freeze({
  info: 'info',
  notice: 'notice',
  warning: 'warning',
  critical: 'critical',
});

/** @const {string[]} Event categories the stream groups by. */
export const EVENT_CATEGORIES = Object.freeze([
  'traffic',
  'signal',
  'emergency',
  'violation',
  'incident',
  'camera',
  'system',
]);

/**
 * A monotonic sequence generator. Deterministic, so an event's identity in a
 * test is stable across runs.
 * @param {string} [prefix='EV']
 * @param {number} [pad=6]
 * @returns {() => string}
 */
export function sequenceGenerator(prefix = 'EV', pad = 6) {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(pad, '0')}`;
  };
}

/**
 * Create the live event stream.
 * @param {object} [options]
 * @param {number} [options.capacity]
 * @param {() => number} [options.clock]
 * @returns {object}
 */
export function createEventBus({
  capacity = EVENT_RING_CAPACITY,
  clock = () => Date.now(),
} = {}) {
  /** @type {Map<string, object[]>} */
  const byCategory = new Map();
  /** @type {object[]} */
  const ring = [];
  const listeners = new Set();
  let nextId = sequenceGenerator('EV', 6);
  let sequence = 0;

  const notify = (record) => {
    for (const listener of [...listeners]) {
      try {
        listener(record);
      } catch {
        console.error('Traffic event listener failed');
      }
    }
  };

  const bus = {
    /**
     * Publish one event.
     * @param {object} event
     * @param {string} event.category
     * @param {string} event.type
     * @param {string} event.message
     * @param {string} [event.severity='info']
     * @param {string} [event.mode] - Data mode of the underlying fact.
     * @param {object} [event.detail]
     * @returns {object} The stored record.
     */
    publish(event) {
      const category = EVENT_CATEGORIES.includes(event.category)
        ? event.category
        : 'system';
      sequence += 1;
      const record = Object.freeze({
        id: nextId(),
        sequence,
        at: event.at ?? clock(),
        category,
        type: String(event.type || 'event'),
        severity: Object.values(SEVERITY).includes(event.severity)
          ? event.severity
          : SEVERITY.info,
        message: String(event.message || ''),
        mode: event.mode || DATA_MODES.unavailable,
        detail: event.detail ? Object.freeze({ ...event.detail }) : null,
        source: event.source ? String(event.source) : null,
      });
      ring.push(record);
      if (ring.length > capacity) ring.shift();
      if (!byCategory.has(category)) byCategory.set(category, []);
      const bucket = byCategory.get(category);
      bucket.push(record);
      if (bucket.length > capacity) bucket.shift();
      notify(record);
      return record;
    },

    /**
     * The most recent events, newest last.
     * @param {object} [options]
     * @param {number} [options.limit] @param {string} [options.category]
     * @param {string} [options.since] - ISO/epoch lower bound.
     * @returns {object[]}
     */
    recent({ limit = 50, category = null, since = null } = {}) {
      const source = category ? byCategory.get(category) || [] : ring;
      const filtered = since
        ? source.filter((record) => record.at >= since)
        : source;
      const bounded = Math.max(0, Math.floor(limit));
      return Object.freeze(filtered.slice(Math.max(0, filtered.length - bounded)));
    },

    /** @returns {number} Total events ever published (not the ring length). */
    get count() {
      return sequence;
    },

    /** @returns {number} Events currently held in the ring. */
    get size() {
      return ring.length;
    },

    /**
     * Subscribe to new events.
     * @param {(record:object) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('Expected an event listener');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Drop every retained event. Used by the simulation reset. */
    clear() {
      ring.length = 0;
      byCategory.clear();
    },
  };
  return Object.freeze(bus);
}

/**
 * Create the audit log for consequential commands.
 *
 * Rule 11: every command that would change an intersection's behaviour gets an
 * entry naming who asked, what was asked, what happened and on what evidence.
 * @param {object} [options]
 * @param {number} [options.capacity]
 * @param {() => number} [options.clock]
 * @returns {object}
 */
export function createAuditLog({
  capacity = AUDIT_RING_CAPACITY,
  clock = () => Date.now(),
} = {}) {
  /** @type {object[]} */
  const records = [];
  let nextId = sequenceGenerator('AUD', 6);

  return Object.freeze({
    /**
     * Record one consequential command.
     * @param {object} entry
     * @param {string} entry.action
     * @param {string} [entry.role]
     * @param {string} [entry.intersectionId]
     * @param {string} [entry.outcome] - 'applied' | 'refused' | 'recommended'.
     * @param {object} [entry.before] @param {object} [entry.after]
     * @param {string} [entry.reason]
     * @param {string} [entry.mode]
     * @returns {object} The stored record.
     */
    record(entry) {
      const stored = Object.freeze({
        id: nextId(),
        at: entry.at ?? clock(),
        action: String(entry.action || 'unknown'),
        role: entry.role ? String(entry.role) : null,
        intersectionId: entry.intersectionId
          ? String(entry.intersectionId)
          : null,
        outcome: entry.outcome || 'applied',
        mode: entry.mode || DATA_MODES.simulated,
        reason: entry.reason ? String(entry.reason) : null,
        before: entry.before ? Object.freeze({ ...entry.before }) : null,
        after: entry.after ? Object.freeze({ ...entry.after }) : null,
      });
      records.push(stored);
      if (records.length > capacity) records.shift();
      return stored;
    },

    /**
     * Audit records, newest last.
     * @param {object} [options]
     * @param {number} [options.limit=100]
     * @param {string} [options.intersectionId]
     * @param {string} [options.action]
     * @returns {object[]}
     */
    list({ limit = 100, intersectionId = null, action = null } = {}) {
      let out = records;
      if (intersectionId) out = out.filter((r) => r.intersectionId === intersectionId);
      if (action) out = out.filter((r) => r.action === action);
      const bounded = Math.max(0, Math.floor(limit));
      return Object.freeze(out.slice(Math.max(0, out.length - bounded)));
    },

    /** @returns {number} */
    get size() {
      return records.length;
    },

    clear() {
      records.length = 0;
    },
  });
}

/**
 * Create the operator-confirmation gate for consequential actions.
 *
 * A request is returned to the UI, and only a matching `confirm(id)` produces
 * a token the engine will honour. Requests expire, so a confirmation cannot be
 * replayed much later against a different situation.
 * @param {object} [options]
 * @param {() => number} [options.clock]
 * @param {number} [options.ttlMs]
 * @returns {object}
 */
export function createConfirmationGate({
  clock = () => Date.now(),
  ttlMs = 60_000,
} = {}) {
  /** @type {Map<string, object>} */
  const pending = new Map();
  let nextId = sequenceGenerator('CFM', 4);

  return Object.freeze({
    /**
     * Ask for confirmation before an action runs.
     * @param {object} request
     * @param {string} request.action
     * @param {string} request.prompt - The sentence shown to the operator.
     * @param {string} [request.intersectionId]
     * @param {string} [request.capability] - Required capability.
     * @param {object} [request.payload]
     * @returns {object} The pending request.
     */
    request(request) {
      const id = nextId();
      const entry = Object.freeze({
        id,
        action: String(request.action || 'unknown'),
        prompt: String(request.prompt || 'Confirm this action?'),
        intersectionId: request.intersectionId || null,
        capability: request.capability || null,
        payload: request.payload ? Object.freeze({ ...request.payload }) : null,
        requestedAt: clock(),
        expiresAt: clock() + ttlMs,
      });
      pending.set(id, entry);
      return entry;
    },

    /**
     * Resolve a pending request.
     * @param {string} id
     * @param {boolean} approved
     * @returns {{ok:boolean, reason:string|null, request:object|null}}
     */
    resolve(id, approved) {
      const entry = pending.get(id);
      if (!entry) return { ok: false, reason: 'no such confirmation request', request: null };
      pending.delete(id);
      if (clock() > entry.expiresAt)
        return { ok: false, reason: 'confirmation request expired', request: entry };
      if (!approved)
        return { ok: false, reason: 'cancelled by operator', request: entry };
      return { ok: true, reason: null, request: entry };
    },

    /** @returns {object[]} Requests still awaiting an answer. */
    listPending() {
      const now = clock();
      const out = [];
      for (const [id, entry] of pending) {
        if (now > entry.expiresAt) pending.delete(id);
        else out.push(entry);
      }
      return Object.freeze(out);
    },

    /** @returns {boolean} */
    has(id) {
      return pending.has(id);
    },

    /** Expire everything. Used by the simulation reset. */
    clear() {
      pending.clear();
    },
  });
}
