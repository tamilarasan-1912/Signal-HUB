/**
 * @file Server API tests.
 *
 * These drive the real engine through the real route table over real HTTP, with
 * only the session authority stubbed to issue tokens for each role. Mocking the
 * engine here would defeat the purpose: the behaviour under test is precisely
 * the coupling between the capability gate and the engine's own state, and a
 * fake engine would let a real authorization bug pass.
 *
 * @module signal-hub/server/api.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createTrafficControlEngine } from '../src/traffic-control/engine.js';
import { CAPABILITIES, ROLE_CAPABILITIES } from '../src/traffic-control/policy.js';
import { DEMO_ACCOUNTS, createSessionAuthority } from './auth.mjs';
import { createApi } from './api.mjs';

/** @const {object[]} A four-by-four grid, enough to have real intersections. */
function gridRoads() {
  const roads = [];
  for (let i = 0; i < 4; i += 1) {
    const lat = 13.08 + i * 0.01;
    roads.push({ id: `R${i}`, coordinates: [[80.2, lat], [80.21, lat], [80.22, lat], [80.23, lat]], type: 'primary', oneway: 0 });
  }
  for (let j = 0; j < 4; j += 1) {
    const lon = 80.2 + j * 0.01;
    roads.push({ id: `C${j}`, coordinates: [[lon, 13.08], [lon, 13.09], [lon, 13.1], [lon, 13.11]], type: 'secondary', oneway: 0 });
  }
  return roads;
}

/**
 * Start a test server.
 *
 * The session authority is real; only the credential store is bypassed, by
 * asking it to mint a token for a named role.
 * @returns {Promise<{get:Function, post:Function, engine:object, close:Function, tokens:object}>}
 */
async function startTestServer() {
  const engine = createTrafficControlEngine({ seed: 3 });
  engine.loadNetwork(gridRoads());
  const sessions = createSessionAuthority({ secret: 'test-secret-not-for-production' });
  const runtime = {
    roadSource: { mode: 'simulated', source: 'Test grid', detail: 'fixture', area: { id: 'test', label: 'Test' } },
    areas: [],
    map: { cesiumIonToken: false, imagery: 'none', liveTrafficProvider: false },
    config: { areaId: 'test', maxIntersections: 60, seed: 3, operatingMode: 'simulation' },
  };
  const api = createApi({ engine, sessions, runtime });

  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (await api.handle(req, res)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // One real token per role, minted through the real login path so the test
  // exercises the same code an operator does.
  const handleFor = {
    viewer: 'viewer',
    operator: 'operator',
    'traffic-control': 'control',
    'enforcement-review': 'enforcement',
    administrator: 'admin',
  };
  const tokens = {};
  for (const role of Object.keys(ROLE_CAPABILITIES)) {
    const handle = handleFor[role];
    const account = DEMO_ACCOUNTS[handle];
    const result = sessions.login(handle, account.password);
    if (!result.ok) throw new Error(`could not mint a ${role} token: ${result.reason}`);
    tokens[role] = result.token;
  }

  const call = async (method, path, { token = null, body = null } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== null) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return {
    engine,
    tokens,
    get: (path, token) => call('GET', path, { token }),
    post: (path, token, body) => call('POST', path, { token, body }),
    close: () =>
      new Promise((resolve) => {
        // The engine owns timers (controller phases, the simulation tick), so
        // it must be disposed or the test process never exits.
        engine.dispose();
        server.close(resolve);
      }),
  };
}

test('an unauthenticated caller may read the city but not control it', async () => {
  const server = await startTestServer();
  try {
    const status = await server.get('/api/city/status');
    // The read endpoints are open to an anonymous viewer by design; the write
    // endpoints are where authorization begins.
    assert.equal(status.status, 200);
    assert.ok(status.body.city.intersections > 0);

    const control = await server.post('/api/simulation/start');
    assert.equal(control.status, 403, 'anonymous control must be refused');
  } finally {
    await server.close();
  }
});

test('a viewer is refused every control capability', async () => {
  const server = await startTestServer();
  try {
    const viewer = server.tokens.viewer;
    const attempts = [
      ['/api/simulation/start', null],
      ['/api/simulation/step', null],
      ['/api/traffic/optimize', { apply: true }],
      ['/api/emergency/simulate', { type: 'ambulance' }],
      ['/api/enforcement/plate', { quality: 1 }],
      ['/api/audit', null],
    ];
    for (const [path, body] of attempts) {
      const method = path === '/api/audit' ? 'get' : 'post';
      const result = method === 'get'
        ? await server.get(path, viewer)
        : await server.post(path, viewer, body);
      assert.equal(result.status, 403, `${path} must refuse a viewer`);
    }
  } finally {
    await server.close();
  }
});

test('a traffic controller may control signals but may not read the audit log or plates', async () => {
  const server = await startTestServer();
  try {
    const control = server.tokens['traffic-control'];
    const started = await server.post('/api/simulation/start', control);
    assert.equal(started.status, 200);
    assert.equal(started.body.running, true);

    const signals = await server.get('/api/signals', control);
    assert.equal(signals.status, 200);
    const target = signals.body.signals[0].intersectionId;

    const green = await server.post(`/api/intersections/${target}/signal/green`, control, { ms: 15_000 });
    assert.equal(green.status, 200);

    // The plate workflow and the audit trail are separate capabilities: holding
    // control of the signals must not confer access to either.
    const audit = await server.get('/api/audit', control);
    assert.equal(audit.status, 403, 'a traffic controller must not read the audit log');
    const plate = await server.post('/api/enforcement/plate', control, { quality: 1 });
    assert.equal(plate.status, 403, 'a traffic controller must not read plates');
  } finally {
    await server.close();
  }
});

test('the violation list withholds plate text from a caller without the plate capability', async () => {
  const server = await startTestServer();
  try {
    // Raise a violation through the engine, then read it through the API at two
    // different privilege levels.
    server.engine.runScenario('red-light-violation', { role: 'administrator' });

    const operator = await server.get('/api/violations', server.tokens.operator);
    assert.equal(operator.status, 200);
    assert.equal(operator.body.plateVisible, false);
    for (const violation of operator.body.violations) {
      assert.equal(violation.plate, null, 'plate must be stripped for a non-enforcement caller');
    }

    const enforcement = await server.get('/api/violations', server.tokens['enforcement-review']);
    assert.equal(enforcement.status, 200);
    assert.equal(enforcement.body.plateVisible, true);
    assert.ok(enforcement.body.violations.length > 0);
  } finally {
    await server.close();
  }
});

test('a perfectly clean frame reads a plate and a degraded frame is rejected', async () => {
  const server = await startTestServer();
  try {
    const enforcement = server.tokens['enforcement-review'];
    const clean = await server.post('/api/enforcement/plate', enforcement, {
      trackId: 'TRK-API-TEST',
      quality: 1,
    });
    assert.equal(clean.status, 200);
    assert.ok(clean.body.text, `a clean frame must read: ${JSON.stringify(clean.body)}`);
    assert.equal(clean.body.unreadable, false);

    const ruined = await server.post('/api/enforcement/plate', enforcement, {
      trackId: 'TRK-API-TEST',
      quality: 0.1,
    });
    assert.equal(ruined.status, 200);
    assert.equal(ruined.body.text, null, 'a degraded frame must not produce characters');
    assert.equal(ruined.body.unreadable, true);
    assert.equal(ruined.body.display, 'PLATE UNREADABLE');
  } finally {
    await server.close();
  }
});

test('the plate endpoint validates its quality input instead of trusting it', async () => {
  const server = await startTestServer();
  try {
    const enforcement = server.tokens['enforcement-review'];
    // A non-numeric quality must not become NaN and leak into a confidence.
    const nonsense = await server.post('/api/enforcement/plate', enforcement, { quality: 'not-a-number' });
    assert.equal(nonsense.status, 200);
    assert.ok(Number.isFinite(nonsense.body.confidence), 'confidence must stay finite');

    const outOfRange = await server.post('/api/enforcement/plate', enforcement, { quality: 99 });
    assert.equal(outOfRange.status, 200);
    assert.ok(outOfRange.body.confidence <= 1, 'confidence must be clamped to 1');
  } finally {
    await server.close();
  }
});

test('signal faults raised through the API surface in controller health', async () => {
  const server = await startTestServer();
  try {
    const control = server.tokens['traffic-control'];
    const signal = (await server.get('/api/signals', control)).body.signals[0];

    const faulted = await server.post(`/api/intersections/${signal.intersectionId}/signal/fault`, control, {
      faulted: true,
      reason: 'api test fault',
    });
    assert.equal(faulted.status, 200);

    const health = await server.get('/api/signals/health', control);
    assert.equal(health.status, 200);
    const entry = health.body.controllers.find((item) => item.intersectionId === signal.intersectionId);
    assert.equal(entry.status, 'FAULT', 'a faulted controller must report FAULT');

    const cleared = await server.post(`/api/intersections/${signal.intersectionId}/signal/fault`, control, {
      faulted: false,
    });
    assert.equal(cleared.status, 200);
  } finally {
    await server.close();
  }
});

test('a nonsensical review decision is refused rather than silently accepted', async () => {
  const server = await startTestServer();
  try {
    server.engine.runScenario('red-light-violation', { role: 'administrator' });
    const reviewer = server.tokens['enforcement-review'];
    const list = await server.get('/api/violations', reviewer);
    const target = list.body.violations[0];

    const refused = await server.post(`/api/violations/${target.id}/review`, reviewer, { decision: 'drop-the-case' });
    assert.equal(refused.status, 400);
    assert.ok(Array.isArray(refused.body.supported));

    // The record must be untouched: a refused decision is not a partial write.
    const after = await server.get(`/api/violations/${target.id}`, reviewer);
    assert.equal(after.body.reviewStatus, 'pending');
  } finally {
    await server.close();
  }
});

test('reviewing an unknown violation is a 404 and reviewing one twice is allowed', async () => {
  const server = await startTestServer();
  try {
    const reviewer = server.tokens['enforcement-review'];
    const missing = await server.post('/api/violations/VIO-DOES-NOT-EXIST/review', reviewer, { decision: 'approved' });
    assert.equal(missing.status, 404);

    server.engine.runScenario('red-light-violation', { role: 'administrator' });
    const list = await server.get('/api/violations', reviewer);
    const target = list.body.violations[0];
    const first = await server.post(`/api/violations/${target.id}/review`, reviewer, { decision: 'approve' });
    assert.equal(first.status, 200, 'the short form "approve" must be understood');
    const second = await server.post(`/api/violations/${target.id}/review`, reviewer, { decision: 'reject' });
    assert.equal(second.status, 200, 'a reviewer may reverse an earlier decision');
    const after = await server.get(`/api/violations/${target.id}`, reviewer);
    assert.equal(after.body.reviewStatus, 'rejected');
  } finally {
    await server.close();
  }
});

test('the full demo runs over HTTP and leaves a reviewable violation', async () => {
  const server = await startTestServer();
  try {
    const admin = server.tokens.administrator;
    const demo = await server.post('/api/simulation/demo', admin);
    assert.equal(demo.status, 200);
    assert.equal(demo.body.ok, true);
    assert.ok(demo.body.stages.length >= 6, 'the demo must report every stage');
    for (const stage of demo.body.stages) {
      assert.equal(stage.ok, true, `stage ${stage.stage} failed`);
    }

    const violations = await server.get('/api/violations', server.tokens['enforcement-review']);
    assert.ok(violations.body.summary.pending >= 1, 'the demo must leave a violation pending review');
    assert.equal(violations.body.summary.automatedEnforcement, false);
  } finally {
    await server.close();
  }
});

test('reviewing a violation records the decision and the reviewer', async () => {
  const server = await startTestServer();
  try {
    server.engine.runScenario('red-light-violation', { role: 'administrator' });
    const reviewer = server.tokens['enforcement-review'];
    const list = await server.get('/api/violations', reviewer);
    const target = list.body.violations[0];

    const reviewed = await server.post(`/api/violations/${target.id}/review`, reviewer, { decision: 'approved' });
    assert.equal(reviewed.status, 200);

    const after = await server.get(`/api/violations/${target.id}`, reviewer);
    assert.equal(after.body.reviewStatus, 'approved');
    assert.ok(after.body.reviewedAt > 0, 'the decision must be timestamped');

    // A decision is a consequential action, so it must be in the audit trail.
    const audit = await server.get('/api/audit', server.tokens.administrator);
    assert.ok(
      audit.body.entries.some((entry) => String(entry.action).includes('violation')),
      'the review must be audited',
    );
  } finally {
    await server.close();
  }
});

test('an unknown route and a malformed body are both refused cleanly', async () => {
  const server = await startTestServer();
  try {
    const missing = await server.get('/api/does-not-exist', server.tokens.administrator);
    assert.equal(missing.status, 404);

    const nonsense = await server.post('/api/simulation/scenario', server.tokens.administrator, { id: 'not-a-scenario' });
    assert.ok(nonsense.status >= 400, 'an unknown scenario must not report success');
  } finally {
    await server.close();
  }
});

test('the data-sources inventory reports a mode for every source', async () => {
  const server = await startTestServer();
  try {
    const sources = await server.get('/api/data-sources');
    assert.equal(sources.status, 200);
    assert.ok(sources.body.sources.length >= 5);
    // `unconfigured` is a legitimate mode — a camera catalog with no feed
    // provider attached is unconfigured, not unknown — and the UI renders it as
    // such. What must never happen is an empty or absent mode.
    const known = ['live', 'simulated', 'estimated', 'unavailable', 'unconfigured'];
    for (const source of sources.body.sources) {
      assert.ok(
        known.includes(source.mode),
        `${source.label} has an unlabelled mode: ${source.mode}`,
      );
      assert.ok(source.keyRequired === true || source.keyRequired === false);
    }
  } finally {
    await server.close();
  }
});

test('a capability the caller lacks is a 403, never a silent empty success', async () => {
  const server = await startTestServer();
  try {
    const viewer = server.tokens.viewer;
    const violations = await server.get('/api/violations', viewer);
    assert.equal(violations.status, 403, 'refusal must be explicit rather than an empty list');
  } finally {
    await server.close();
  }
});

test('the session endpoint reports the caller\'s role and capabilities', async () => {
  const server = await startTestServer();
  try {
    const anonymous = await server.get('/api/session');
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.authenticated, false);
    assert.ok(anonymous.body.capabilities.includes(CAPABILITIES.viewCity));

    const admin = await server.get('/api/session', server.tokens.administrator);
    assert.equal(admin.body.role, 'administrator');
    assert.ok(admin.body.capabilities.includes(CAPABILITIES.readAudit));
  } finally {
    await server.close();
  }
});
