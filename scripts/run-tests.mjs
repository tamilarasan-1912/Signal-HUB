/**
 * @file The project's test entry point.
 *
 * Runs each suite in its own child process and reports a single verdict. Node's
 * test runner is used directly rather than through a framework: the suites are
 * plain `node:test` files, so adding one is adding a file, not wiring a plugin.
 *
 * Layout that matters:
 *  - The core suites are pure domain logic and must always pass.
 *  - The server suite binds a real HTTP listener on an ephemeral port.
 *  - The browser suite needs Chrome, so it is opt-in via `--browser` and is
 *    skipped (not faked) when the browser is unavailable.
 *
 * Usage:
 *   node scripts/run-tests.mjs              # core + server
 *   node scripts/run-tests.mjs --browser     # …and the end-to-end acceptance run
 *   node scripts/run-tests.mjs --all         # same as --browser
 *
 * @module signal-hub/scripts/run-tests
 */

import { spawn } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Run one suite and return its outcome.
 * @param {string} label @param {string[]} args
 * @returns {Promise<{label:string, code:number, output:string}>}
 */
function run(label, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ label, code: code ?? 1, output }));
  });
}

/**
 * Collect test files under a directory.
 * @param {string} pattern @returns {Promise<string[]>}
 */
async function collect(pattern) {
  const found = [];
  for await (const path of glob(pattern, { cwd: root })) found.push(path);
  return found.sort();
}

/** Whether the browser suite was requested. */
const withBrowser = process.argv.includes('--browser') || process.argv.includes('--all');

/** @type {Array<{label:string, files:string[]}>} */
const suites = [
  { label: 'traffic-control core', files: await collect('src/traffic-control/*.test.mjs') },
  { label: 'server API', files: await collect('server/*.test.mjs') },
];

const results = [];

for (const suite of suites) {
  if (suite.files.length === 0) {
    results.push({ label: suite.label, code: 1, output: 'No test files found — the suite would pass vacuously.' });
    continue;
  }
  const outcome = await run(suite.label, ['--test', '--test-force-exit', ...suite.files]);
  results.push(outcome);
}

if (withBrowser) {
  // The acceptance suite drives the running application, so it is only
  // meaningful against a live command API. It is reported as skipped rather
  // than failed when none is up.
  const probe = await fetch('http://127.0.0.1:12001/api/health').catch(() => null);
  if (!probe?.ok) {
    results.push({
      label: 'browser acceptance',
      code: 0,
      output: 'SKIPPED — no command API on http://127.0.0.1:12001. Start it with `npm start` first.',
    });
  } else {
    results.push(await run('browser acceptance', ['scripts/e2e.mjs']));
  }
}

let failed = 0;
let skipped = 0;
for (const result of results) {
  const summary = result.output
    .split('\n')
    .filter((line) => /^ℹ (tests|pass|fail)|^All \d+ acceptance|^SKIPPED|^\d+ passed/.test(line.trim()))
    .join('\n');
  if (result.output.includes('SKIPPED')) {
    skipped += 1;
    console.log(`\n── ${result.label}: SKIPPED`);
  } else if (result.code === 0) {
    console.log(`\n── ${result.label}: PASS`);
  } else {
    failed += 1;
    console.log(`\n── ${result.label}: FAIL`);
  }
  if (summary) console.log(summary);
  if (result.code !== 0) console.log(result.output);
}

console.log(
  failed
    ? `\n${results.length - failed - skipped}/${results.length} suites passed, ${failed} failed.\n`
    : `\nAll ${results.length - skipped} runnable suites passed${skipped ? ` (${skipped} skipped)` : ''}.\n`,
);

process.exit(failed ? 1 : 0);
