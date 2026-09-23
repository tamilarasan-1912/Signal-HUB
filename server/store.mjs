/**
 * @file Durable storage for the records that must outlive a process restart.
 *
 * The engine keeps the live city in memory, which is correct for a simulator.
 * What it must NOT lose is the audit trail and the enforcement evidence
 * metadata, so those are mirrored here through a narrow adapter interface.
 *
 * Two drivers ship:
 *
 *  - `memory` — default; keeps records for the life of the process.
 *  - `file`   — appends JSON Lines under a directory, so an audit trail and its
 *               evidence survive a restart.
 *
 * The interface is the point. `createPostgresStore` in `docs/PERSISTENCE.md`
 * sketches the same five methods against PostGIS; swapping the driver is a
 * configuration change, not a rewrite. No credentials are ever defaulted here —
 * a connection string must be supplied by the environment.
 *
 * @module signal-hub/server/store
 */

import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * @typedef {object} StoreAdapter
 * @property {(entry:object)=>Promise<void>} appendAudit
 * @property {(record:object)=>Promise<void>} appendViolation
 * @property {(limit:number)=>Promise<object[]>} listAudit
 * @property {(limit:number)=>Promise<object[]>} listViolations
 * @property {()=>Promise<object>} stats
 */

/**
 * In-memory driver. Bounded so a long session cannot grow without limit.
 * @param {object} [options]
 * @param {number} [options.capacity=5000]
 * @returns {StoreAdapter}
 */
export function createMemoryStore({ capacity = 5000 } = {}) {
  /** @type {object[]} */ const audit = [];
  /** @type {object[]} */ const violations = [];
  const trim = (list) => {
    if (list.length > capacity) list.splice(0, list.length - capacity);
  };
  return {
    async appendAudit(entry) {
      audit.push(Object.freeze({ ...entry }));
      trim(audit);
    },
    async appendViolation(record) {
      const index = violations.findIndex((item) => item.id === record.id);
      if (index >= 0) violations[index] = Object.freeze({ ...record });
      else violations.push(Object.freeze({ ...record }));
      trim(violations);
    },
    async listAudit(limit = 200) {
      return Object.freeze(audit.slice(-limit));
    },
    async listViolations(limit = 200) {
      return Object.freeze(violations.slice(-limit));
    },
    async stats() {
      return Object.freeze({ driver: 'memory', audit: audit.length, violations: violations.length });
    },
  };
}

/**
 * Append-only JSON Lines driver.
 *
 * Chosen over a database because it needs no server to demonstrate, and it is
 * genuinely append-only: a record that has been written is never rewritten,
 * which is what makes it usable as an audit trail rather than a scratch file.
 * @param {object} options
 * @param {string} options.directory - Where the JSONL files live.
 * @returns {StoreAdapter}
 */
export function createFileStore({ directory }) {
  if (!directory || typeof directory !== 'string') {
    throw new TypeError('createFileStore requires a directory');
  }
  const auditPath = join(directory, 'audit.jsonl');
  const violationPath = join(directory, 'violations.jsonl');
  /** @type {object[]} */ const auditCache = [];
  /** @type {Map<string,object>} */ const violationCache = new Map();

  const append = async (path, record) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  };

  const readLines = async (path) => {
    try {
      const text = await readFile(path, 'utf8');
      return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null; // a torn final line from an abrupt kill is skipped
          }
        })
        .filter(Boolean);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  };

  return {
    async appendAudit(entry) {
      const record = Object.freeze({ ...entry });
      auditCache.push(record);
      if (auditCache.length > 5000) auditCache.splice(0, auditCache.length - 5000);
      await append(auditPath, record);
    },
    async appendViolation(record) {
      const frozen = Object.freeze({ ...record });
      violationCache.set(record.id, frozen);
      // Violations are appended as they change state, so the file is a change
      // log; the latest record for an id wins on read.
      await append(violationPath, frozen);
    },
    async listAudit(limit = 200) {
      const lines = await readLines(auditPath);
      return Object.freeze(lines.slice(-limit));
    },
    async listViolations(limit = 200) {
      const lines = await readLines(violationPath);
      /** @type {Map<string,object>} */ const latest = new Map();
      for (const line of lines) if (line?.id) latest.set(line.id, line);
      return Object.freeze([...latest.values()].slice(-limit));
    },
    async stats() {
      return Object.freeze({
        driver: 'file',
        directory,
        audit: (await readLines(auditPath)).length,
        violations: violationCache.size,
      });
    },
  };
}

/**
 * Build the store named by the environment.
 *
 * A `file` store needs `SIGNAL_HUB_DATA_DIR`; without it this falls back to
 * memory and says so, rather than failing to start.
 * @param {object} [env=process.env]
 * @returns {{store:StoreAdapter, driver:string, note:string}}
 */
export function createStoreFromEnv(env = process.env) {
  const requested = String(env.SIGNAL_HUB_STORE || 'memory').toLowerCase();
  if (requested === 'file' && env.SIGNAL_HUB_DATA_DIR) {
    return {
      store: createFileStore({ directory: env.SIGNAL_HUB_DATA_DIR }),
      driver: 'file',
      note: `appending JSONL under ${env.SIGNAL_HUB_DATA_DIR}`,
    };
  }
  if (requested === 'file') {
    return {
      store: createMemoryStore(),
      driver: 'memory',
      note: 'SIGNAL_HUB_STORE=file requested but SIGNAL_HUB_DATA_DIR is unset — using memory',
    };
  }
  if (requested === 'postgres') {
    // Deliberately not silent: a production durability claim must be earned.
    return {
      store: createMemoryStore(),
      driver: 'memory',
      note: 'postgres driver is documented but not implemented in this prototype — using memory',
    };
  }
  return { store: createMemoryStore(), driver: 'memory', note: 'in-process records only' };
}

/**
 * Mirror the engine's audit and enforcement records into a store.
 *
 * Subscribes to the engine's own event bus, so the durable trail is a copy of
 * the same events the UI shows — not a parallel bookkeeping path that could
 * disagree with it.
 * @param {object} options
 * @param {object} options.engine
 * @param {StoreAdapter} options.store
 * @returns {Function} An unsubscribe function.
 */
export function mirrorEngineRecords({ engine, store }) {
  /** @type {Set<string>} Audit entries already written, by identity. */
  const writtenAudit = new Set();
  const writtenViolations = new Set();

  const flushAudit = async () => {
    for (const entry of engine.getAudit({ limit: 5000 })) {
      const key = `${entry.at}|${entry.action}|${entry.role || ''}|${entry.intersectionId || ''}`;
      if (writtenAudit.has(key)) continue;
      writtenAudit.add(key);
      await store.appendAudit(entry);
    }
  };
  const flushViolations = async () => {
    for (const violation of engine.getViolations({ includePlate: false, limit: 2000 })) {
      const key = `${violation.id}|${violation.reviewStatus}`;
      if (writtenViolations.has(key)) continue;
      writtenViolations.add(key);
      // Evidence *metadata* is persisted; the frame itself is referenced, not
      // copied, so this file cannot become an uncontrolled image store.
      await store.appendViolation({
        id: violation.id,
        ruleId: violation.ruleId,
        intersectionId: violation.intersectionId,
        cameraId: violation.cameraId,
        reviewStatus: violation.reviewStatus,
        at: violation.at,
        evidenceRef: violation.evidence?.frameRef || null,
        confidence: violation.detection?.confidence ?? null,
        // No plate text is written here: it belongs to the enforcement workflow,
        // not to a general-purpose durable log.
      });
    }
  };

  const unsubscribe = engine.subscribeToEvents((event) => {
    if (event?.category === 'violation' || event?.category === 'enforcement') {
      flushViolations().catch(() => {});
    }
    flushAudit().catch(() => {});
  });

  flushAudit().catch(() => {});
  return unsubscribe;
}
