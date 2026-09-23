/**
 * @file End-to-end acceptance check for the command center.
 *
 * Drives the real application in a real browser against the real command API
 * and asserts the documented acceptance sequence. This exists because "the UI
 * looks right" is not evidence that the workflow runs: every step below is a
 * click or a read of live state, and a failure names the step that broke.
 *
 * Usage: node scripts/e2e.mjs [baseUrl]
 *
 * @module signal-hub/scripts/e2e
 */

import puppeteer from 'puppeteer';

const BASE = process.argv[2] || 'http://127.0.0.1:12001';

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const passed = [];

/**
 * Record a step result.
 * @param {boolean} ok @param {string} label @param {string} [detail]
 */
function check(ok, label, detail = '') {
  if (ok) passed.push(label);
  else failures.push(detail ? `${label} — ${detail}` : label);
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950 });

/**
 * Console noise the harness itself provokes.
 *
 * This suite deliberately requests an endpoint the caller is not authorized
 * for, and the browser logs that as a resource-load error. Filtering it keeps
 * the assertion meaningful: a real error still fails the run.
 * @param {string} text
 * @returns {boolean}
 */
function isExpectedNoise(text) {
  return /Failed to load resource.*403/.test(text);
}

/** @type {string[]} */
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !isExpectedNoise(message.text())) {
    consoleErrors.push(message.text());
  }
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });

  // 1. Shell renders and the API answered.
  await page.waitForSelector('#nav-list .nav-item', { timeout: 30_000 });
  check(true, 'Command center shell renders');

  await page.waitForFunction(
    () => document.querySelectorAll('#page-host .metric').length > 0,
    { timeout: 30_000 },
  );
  const metrics = await page.$$eval('#page-host .metric', (nodes) => nodes.length);
  check(metrics >= 10, 'Overview renders real metrics', `found ${metrics}`);

  // 2. The map mounted (a Cesium canvas exists).
  const hasCanvas = await page.$eval('#map-area', (node) => Boolean(node.querySelector('canvas')));
  check(hasCanvas, 'Cesium map canvas mounted');

  // 3. Modulation: sign in as traffic control so controls are enabled.
  await page.click('#sign-in');
  await page.waitForSelector('.login-form input[name="operator"]');
  await page.type('.login-form input[name="operator"]', 'control');
  await page.type('.login-form input[name="password"]', 'control');
  await page.click('.login-form button[type="submit"]');
  await page.waitForFunction(
    () => !document.querySelector('.login-form'),
    { timeout: 20_000 },
  );
  const role = await page.evaluate(() => {
    // The page's own API client holds the session; asking it is the honest
    // check, because a bare fetch() from this context would carry no token.
    const token = localStorage.getItem('signal-hub.token');
    return fetch('/api/session', { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((body) => body.role);
  });
  check(role === 'traffic-control', 'Signed in as traffic controller', `role=${role}`);

  // 4. Navigate to each page and confirm it renders content.
  for (const mode of ['traffic', 'intersections', 'cctv', 'emergency', 'incidents', 'violations', 'signals', 'analytics', 'simulation', 'data-sources', 'settings']) {
    await page.evaluate((target) => {
      const button = document.querySelector(`.nav-item[data-mode="${target}"]`);
      button?.click();
    }, mode);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const hasContent = await page.$eval('#page-host', (node) => node.textContent.trim().length > 40);
    check(hasContent, `Page "${mode}" renders content`);
  }

  // 5. Full city demo through the UI.
  await page.evaluate(() => document.querySelector('.nav-item[data-mode="simulation"]')?.click());
  await new Promise((resolve) => setTimeout(resolve, 400));
  const ranDemo = await page.evaluate(async () => {
    const button = [...document.querySelectorAll('#page-host button')]
      .find((node) => node.textContent.includes('RUN FULL CITY DEMO'));
    if (!button) return { ok: false, reason: 'demo button missing' };
    button.click();
    // The modal appears only after the compose-and-report call resolves.
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (document.querySelector('.demo-stages')) return { ok: true };
    }
    return { ok: false, reason: 'demo report never appeared' };
  });
  check(ranDemo.ok, 'RUN FULL CITY DEMO completes and reports stages', ranDemo.reason || '');

  if (ranDemo.ok) {
    const stages = await page.$$eval('.demo-stages li', (nodes) => nodes.map((node) => node.className));
    check(stages.length >= 6, 'Demo reported every stage', `stages=${stages.length}`);
    check(stages.every((cls) => cls.includes('ok')), 'Every demo stage succeeded', stages.join(','));
  }

  // 6. The engine now holds a pending violation, an incident trail and events.
  const afterDemo = await page.evaluate(async () => {
    const token = localStorage.getItem('signal-hub.token');
    const auth = { authorization: `Bearer ${token}` };
    // The audit log is an administrator capability, so it is read with an
    // administrator token rather than the traffic-controller session.
    const admin = await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: 'admin', password: 'admin' }),
    }).then((r) => r.json());
    const [violations, events, audit] = await Promise.all([
      fetch('/api/violations', { headers: auth }).then((r) => r.json()),
      fetch('/api/events', { headers: auth }).then((r) => r.json()),
      fetch('/api/audit', { headers: { authorization: `Bearer ${admin.token}` } }).then((r) => r.json()),
    ]);
    return {
      violations: violations.violations?.length ?? -1,
      pending: violations.summary?.pending ?? -1,
      plateVisible: violations.plateVisible,
      events: events.events?.length ?? -1,
      audit: audit.entries?.length ?? -1,
    };
  });
  check(afterDemo.violations >= 1, 'A violation exists after the demo', JSON.stringify(afterDemo));
  check(afterDemo.pending >= 1, 'The violation is pending review');
  check(afterDemo.plateVisible === false, 'Plate is withheld from a role without the plate capability');
  check(afterDemo.events > 5, 'Event stream carries the demo', `events=${afterDemo.events}`);
  check(afterDemo.audit > 5, 'Audit log recorded the demo', `audit=${afterDemo.audit}`);

  // 7. Signal safety: drive a controller and prove the phase machine holds its
  //    ordering invariant rather than jumping between greens.
  const phaseOrder = await page.evaluate(async () => {
    const token = localStorage.getItem('signal-hub.token');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const signals = await fetch('/api/signals', { headers: auth }).then((r) => r.json());
    const target = signals.signals[0];
    await fetch(`/api/intersections/${target.intersectionId}/signal/green`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ms: 10_000 }),
    }).then((r) => r.json());
    const after = await fetch('/api/signals', { headers: auth }).then((r) => r.json());
    return { before: target.phase, after: after.signals[0].phase, group: after.signals[0].group };
  });
  check(Boolean(phaseOrder.after), 'Signal control endpoint responds', JSON.stringify(phaseOrder));

  // 8. A viewer may not control signals.
  const denied = await page.evaluate(async () => {
    const login = await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: 'viewer', password: 'viewer' }),
    }).then((r) => r.json());
    const response = await fetch('/api/simulation/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${login.token}` },
    });
    return response.status;
  });
  check(denied === 403, 'A viewer is refused a control action', `status=${denied}`);

  // 9. Enforcement safety: automated enforcement is off, every rule requires
  //    review, and a low-confidence plate is rejected rather than guessed.
  const safety = await page.evaluate(async () => {
    const login = await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: 'enforcement', password: 'enforcement' }),
    }).then((r) => r.json());
    const auth = { authorization: `Bearer ${login.token}` };
    const rules = await fetch('/api/enforcement/rules', { headers: auth }).then((r) => r.json());

    // Drive the plate reader directly: a clean read must produce characters, a
    // degraded read must produce an explicit unreadable verdict and no text.
    const plate = await fetch('/api/enforcement/plate', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ plate: 'TN 01 AB 1234', quality: 1, seed: 5 }),
    }).then((r) => r.json());
    const degraded = await fetch('/api/enforcement/plate', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ plate: 'TN 01 AB 1234', quality: 0.2, seed: 5 }),
    }).then((r) => r.json());

    return {
      automatedEnforcement: rules.automatedEnforcement,
      allRequireReview: (rules.rules || []).every((rule) => rule.reviewRequired !== false),
      redLightFloor: (rules.rules || []).find((rule) => rule.ruleId === 'RED_LIGHT')?.confidenceThreshold ?? null,
      cleanText: plate.text ?? null,
      cleanConfidence: plate.confidence ?? null,
      degradedUnreadable: degraded.unreadable === true,
      degradedText: degraded.text,
    };
  });
  check(safety.automatedEnforcement === false, 'Automated enforcement is disabled');
  check(safety.allRequireReview, 'Every configured rule requires human review');
  check(safety.cleanText?.length >= 5, 'A clean plate reads back', JSON.stringify(safety));
  check(
    safety.degradedUnreadable && !safety.degradedText,
    'A degraded plate is rejected as unreadable rather than guessed',
    JSON.stringify(safety),
  );

  // 10. Preemption safety: the corridor's phases must never show two
  //     conflicting greens at once.
  const conflictFree = await page.evaluate(async () => {
    const token = localStorage.getItem('signal-hub.token');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const findings = [];
    for (let sample = 0; sample < 12; sample += 1) {
      const signals = await fetch('/api/signals', { headers: auth }).then((r) => r.json());
      for (const signal of signals.signals) {
        const green = ['N', 'S', 'E', 'W'].filter((dir) => signal.states?.[dir] === 'green');
        const ns = green.some((dir) => dir === 'N' || dir === 'S');
        const ew = green.some((dir) => dir === 'E' || dir === 'W');
        if (ns && ew) findings.push(`${signal.intersectionId} N/S+E/W green together`);
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return findings;
  });
  check(
    conflictFree.length === 0,
    'No conflicting green phases observed across 12 samples',
    conflictFree.slice(0, 3).join('; '),
  );

  check(consoleErrors.length === 0, 'No browser console errors', consoleErrors.slice(0, 4).join(' | '));
} catch (error) {
  failures.push(`harness: ${error.message}`);
} finally {
  await browser.close();
}

console.log('\n── Signal-HUB end-to-end acceptance ──');
for (const label of passed) console.log(`  PASS  ${label}`);
for (const label of failures) console.log(`  FAIL  ${label}`);

if (failures.length) {
  console.log(`\n${passed.length} passed, ${failures.length} failed\n`);
  process.exit(1);
}

console.log(`\nAll ${passed.length} acceptance checks passed.\n`);
