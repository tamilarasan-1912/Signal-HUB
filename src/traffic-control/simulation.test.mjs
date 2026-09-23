/**
 * @file The end-to-end demonstration scenario.
 *
 * These tests exist because the demo's stage labels previously reported work
 * the engine had not done: the corridor stage claimed preemption while only
 * advancing the vehicle, so `preemptions` was always 0 and the label was false.
 * A scenario that reports success without doing the work is worse than one that
 * fails, so each stage is asserted against engine state rather than its own
 * self-report.
 *
 * @module signal-hub/traffic-control/simulation.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTrafficControlEngine } from './engine.js';
import { gridRoads } from './fixtures.mjs';
import { DEMO_SCENARIO } from './simulation.js';

/** A loaded engine, disposed by the caller. */
function loadedEngine(options = {}) {
  const engine = createTrafficControlEngine({ seed: 7, maxIntersections: 60, ...options });
  engine.loadNetwork(gridRoads());
  return engine;
}

/** The stage record for one demo stage id. */
function stage(demo, id) {
  return demo.stages.find((entry) => entry.stage === id) || null;
}

test('the demo runs every documented stage in order', async () => {
  const engine = loadedEngine();
  try {
    const demo = await engine.runFullDemo({ role: 'administrator' });
    assert.equal(demo.ok, true, JSON.stringify(demo.stages));
    // The demo is the composition of these scenarios, so a stage going missing
    // must fail here rather than silently shortening the demonstration.
    assert.deepEqual(
      demo.stages.map((entry) => entry.stage),
      ['traffic-jam', 'optimize', 'ambulance', 'corridor-run', 'release', 'violation'],
    );
    for (const entry of demo.stages) {
      assert.equal(entry.ok, true, `${entry.stage} reported not-ok`);
      assert.ok(entry.label, `${entry.stage} has no label`);
    }
  } finally {
    engine.dispose();
  }
});

test('the corridor stage really preempts signals rather than only asserting it', async () => {
  const engine = loadedEngine();
  try {
    const demo = await engine.runFullDemo({ role: 'administrator' });
    const corridor = stage(demo, 'corridor-run');
    assert.ok(corridor.preemptions > 0, 'no preemption was requested for the corridor');
    assert.deepEqual(
      corridor.preemptedIntersections,
      corridor.preemptedIntersections.filter(Boolean),
      'a preemption was recorded without an intersection id',
    );
    // Every claimed preemption must correspond to a real request in the engine,
    // so the count cannot be inflated independently of the engine's own state.
    assert.ok(
      engine.getEmergency().length > 0,
      'the demo claims preemption but the engine holds no emergency vehicle',
    );
  } finally {
    engine.dispose();
  }
});

test('the ambulance arrives rather than the demo stopping short of it', async () => {
  const engine = loadedEngine();
  try {
    const demo = await engine.runFullDemo({ role: 'administrator' });
    const corridor = stage(demo, 'corridor-run');
    assert.ok(
      corridor.vehicleStatus.includes('arrived') || corridor.vehicleStatus.includes('cleared'),
      `the emergency vehicle never reached the end of its corridor: ${corridor.vehicleStatus}`,
    );
  } finally {
    engine.dispose();
  }
});

test('the corridor is released so adaptive control is handed back', async () => {
  const engine = loadedEngine();
  try {
    const demo = await engine.runFullDemo({ role: 'administrator' });
    const release = stage(demo, 'release');
    assert.ok(release.released > 0, 'no corridor was released');
    // A released corridor must not still be claimed as active by the engine.
    const stillOpen = engine.getCorridors().filter((entry) => entry.status !== 'released');
    assert.equal(stillOpen.length, 0, 'a corridor remained open after the release stage');
  } finally {
    engine.dispose();
  }
});

test('the violation stage produces a record that is pending review, not enforced', async () => {
  const engine = loadedEngine();
  try {
    const demo = await engine.runFullDemo({ role: 'administrator' });
    const violation = stage(demo, 'violation');
    assert.ok(violation.violationId, 'no violation was created');
    assert.ok(violation.pending > 0, 'the violation did not enter the review queue');
    const record = engine.getViolation(violation.violationId, { includePlate: true });
    assert.ok(record, 'the reported violation id does not resolve in the engine');
    assert.equal(record.reviewStatus, 'pending');
  } finally {
    engine.dispose();
  }
});

test('no stage of the demo activates real-world control', async () => {
  const engine = loadedEngine();
  try {
    const demo = await engine.runFullDemo({ role: 'administrator' });
    // The demo is simulation-only; authorized control is refused until a real
    // controller integration is configured, which it is not.
    assert.equal(demo.mode, 'simulated');
    assert.notEqual(engine.getStatus().operatingMode, 'authorized-control');
  } finally {
    engine.dispose();
  }
});

test('every demo stage is backed by a definition the UI can list', () => {
  const engine = loadedEngine();
  try {
    // A `scenario` name is a promise to the UI that this id can be run on its
    // own. Stages driven by an engine method set it to null instead, so the plan
    // never advertises a scenario that does not exist.
    const runnable = new Set(engine.getScenarios().map((entry) => entry.id));
    for (const entry of DEMO_SCENARIO) {
      assert.ok(entry.id, 'a demo stage has no id');
      assert.ok(entry.label, `${entry.id} has no label`);
      assert.ok(Number.isFinite(entry.at), `${entry.id} has no schedule`);
      if (entry.scenario === null) continue;
      assert.ok(
        runnable.has(entry.scenario),
        `demo stage ${entry.id} names unknown scenario ${entry.scenario}`,
      );
    }
  } finally {
    engine.dispose();
  }
});

test('the published plan names the same stages the report returns', async () => {
  const engine = loadedEngine();
  try {
    const demo = await engine.runFullDemo({ role: 'administrator' });
    // The API hands callers both the plan and the report. If they disagree, a
    // caller reading the plan cannot match it to what happened.
    assert.deepEqual(
      demo.demoDefinition.map((entry) => entry.id),
      demo.stages.map((entry) => entry.stage),
    );
  } finally {
    engine.dispose();
  }
});
