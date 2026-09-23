/**
 * @file Prototype session and capability gating for the Signal-HUB API.
 *
 * This is deliberately a *prototype* authorization layer, not an identity
 * provider. It issues a signed opaque session token for a named operator and
 * maps the operator's role onto the capability set the traffic-control engine
 * already defines (`ROLE_CAPABILITIES`). The point is that the consequential
 * endpoints are genuinely gated and every one of them is audited — a viewer
 * really cannot drive a signal, rather than a comment claiming it cannot.
 *
 * Replacing this with real SSO means implementing `verifyToken` against the
 * real issuer; nothing else in the API has to change.
 *
 * @module signal-hub/server/auth
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ROLES,
  ROLE_CAPABILITIES,
} from '../src/traffic-control/policy.js';

/** @const {number} Session lifetime. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Demo credentials, one per role, for the prototype sign-in screen.
 *
 * These are for a local demonstration build. They are deliberately obvious and
 * are NOT a security control: the server refuses to boot with these defaults
 * when `SIGNAL_HUB_ENV=production` (see `assertProductionConfig`).
 * @const {Object<string,{password:string,role:string,label:string}>}
 */
export const DEMO_ACCOUNTS = Object.freeze({
  viewer: Object.freeze({ password: 'viewer', role: ROLES.viewer, label: 'City Viewer' }),
  operator: Object.freeze({ password: 'operator', role: ROLES.operator, label: 'Shift Operator' }),
  control: Object.freeze({
    password: 'control',
    role: ROLES.trafficControl,
    label: 'Traffic Controller',
  }),
  enforcement: Object.freeze({
    password: 'enforcement',
    role: ROLES.enforcementReview,
    label: 'Enforcement Reviewer',
  }),
  admin: Object.freeze({ password: 'admin', role: ROLES.administrator, label: 'Administrator' }),
});

/** @returns {string} A fresh signing secret. */
function freshSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * Sign and encode a session payload.
 * @param {object} payload @param {string} secret
 * @returns {string}
 */
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * Verify and decode a session token. Returns null for anything malformed,
 * mis-signed, or expired — never throws, so a bad token is a 401 rather than a
 * 500.
 * @param {string} token @param {string} secret @param {number} now
 * @returns {object|null}
 */
function verify(token, secret, now) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.exp || payload.exp < now) return null;
  return payload;
}

/**
 * Build the session authority.
 * @param {object} [options]
 * @param {Function} [options.now] - Injected clock.
 * @param {string} [options.secret] - Injected signing secret.
 * @returns {object}
 */
export function createSessionAuthority({ now = () => Date.now(), secret = freshSecret() } = {}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('Session secret must be a string of at least 16 characters');
  }

  return Object.freeze({
    /** @returns {object[]} The roles this build understands, for the UI. */
    listRoles() {
      return Object.entries(ROLES).map(([key, role]) => Object.freeze({
        key,
        role,
        capabilities: ROLE_CAPABILITIES[role] || [],
      }));
    },

    /** @returns {string[]} */
    capabilitiesFor(role) {
      return [...(ROLE_CAPABILITIES[role] || [])];
    },

    /**
     * Exchange a handle and password for a session.
     * @param {string} handle @param {string} password
     * @returns {{ok:boolean, token?:string, session?:object, reason?:string}}
     */
    login(handle, password) {
      const key = String(handle || '').trim().toLowerCase();
      const account = DEMO_ACCOUNTS[key];
      if (!account) return { ok: false, reason: 'unknown operator' };
      // Length-safe comparison so the prototype does not set a bad example.
      const given = Buffer.from(String(password ?? ''));
      const want = Buffer.from(account.password);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        return { ok: false, reason: 'invalid credentials' };
      }
      const issuedAt = now();
      const payload = {
        operator: key,
        label: account.label,
        role: account.role,
        iat: issuedAt,
        exp: issuedAt + SESSION_TTL_MS,
      };
      return { ok: true, token: sign(payload, secret), session: payload };
    },

    /**
     * Resolve a request's session, falling back to an unauthenticated viewer so
     * the read-only views work without a sign-in for a local demonstration.
     * @param {string|undefined} token
     * @returns {object}
     */
    resolve(token) {
      const anonymous = (reason) => Object.freeze({
        operator: 'anonymous',
        label: reason,
        role: ROLES.viewer,
        capabilities: ROLE_CAPABILITIES[ROLES.viewer],
        authenticated: false,
      });
      if (!token) return anonymous('Unauthenticated viewer');
      const payload = verify(token, secret, now());
      if (!payload) return anonymous('Invalid or expired session');
      return Object.freeze({
        operator: payload.operator,
        label: payload.label,
        role: payload.role,
        capabilities: ROLE_CAPABILITIES[payload.role] || [],
        authenticated: true,
      });
    },

    /**
     * @param {object} session @param {string} capability
     * @returns {boolean}
     */
    can(session, capability) {
      return Array.isArray(session?.capabilities) && session.capabilities.includes(capability);
    },
  });
}

/**
 * Refuse to boot with prototype credentials in a production deployment.
 *
 * The point is that the insecure default cannot silently follow the code into
 * a real environment: the process reports the problem and exits.
 * @param {object} [env=process.env]
 * @returns {{ok:boolean, problems:string[]}}
 */
export function assertProductionConfig(env = process.env) {
  const problems = [];
  const isProduction = String(env.SIGNAL_HUB_ENV || '').toLowerCase() === 'production';
  if (!isProduction) return { ok: true, problems };
  if (!env.SIGNAL_HUB_SESSION_SECRET) {
    problems.push(
      'SIGNAL_HUB_SESSION_SECRET must be set in production (prototype demo accounts are otherwise active)',
    );
  }
  if (String(env.SIGNAL_HUB_ALLOW_DEMO_ACCOUNTS || '').toLowerCase() === 'true') {
    problems.push('SIGNAL_HUB_ALLOW_DEMO_ACCOUNTS must not be enabled in production');
  }
  return { ok: problems.length === 0, problems };
}
