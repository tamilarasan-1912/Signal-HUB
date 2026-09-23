import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_RED_MS,
  AMBER_MS,
  MAX_GREEN_MS,
  MIN_GREEN_MS,
} from './policy.js';
import {
  approachStatesFor,
  createSignalGroup,
  createSimulatedSignalController,
  describeController,
  validateApproachStates,
} from './signals.js';

/**
 * A manual scheduler: timers are queued and fired explicitly, so a phase
 * transition is proven rather than waited for. Without this the safety
 * assertions would be racing a real clock.
 */
function manualScheduler() {
  let queue = [];
  return {
    setTimer(fn, ms) {
      const handle = { fn, ms };
      queue.push(handle);
      return handle;
    },
    clearTimer(handle) {
      queue = queue.filter((item) => item !== handle);
    },
    /** Fire the next pending timer, advancing the clock by its delay. */
    fireNext() {
      const next = queue.shift();
      if (!next) return null;
      now += next.ms;
      next.fn();
      return next;
    },
    /** Fire every pending timer up to a step limit. */
    drain(steps = 20) {
      const fired = [];
      for (let i = 0; i < steps; i += 1) {
        const stepped = this.fireNext();
        if (!stepped) break;
        fired.push(stepped);
      }
      return fired;
    },
    get pending() {
      return queue.length;
    },
  };
}

let now = 0;
const clock = () => now;

function controllerWithScheduler() {
  now = 0;
  const scheduler = manualScheduler();
  const controller = createSimulatedSignalController({
    intersectionId: 'INT-001',
    clock,
    scheduler,
  });
  return { controller, scheduler };
}

test('a fresh controller holds green on NS and red elsewhere', () => {
  const { controller } = controllerWithScheduler();
  const signal = controller.getSignalState();
  assert.equal(signal.group, 'NS');
  assert.equal(signal.phase, 'green');
  assert.equal(signal.states.N, 'green');
  assert.equal(signal.states.S, 'green');
  assert.equal(signal.states.E, 'red');
  assert.equal(signal.states.W, 'red');
  controller.dispose();
});

test('approachStatesFor never lights both axes, in any phase', () => {
  for (const group of ['NS', 'EW']) {
    for (const phase of ['green', 'amber', 'all-red', 'fault']) {
      const states = approachStatesFor(group, phase);
      const check = validateApproachStates(states);
      assert.equal(check.ok, true, `${group}/${phase}: ${check.reason}`);
    }
  }
});

test('validateApproachStates rejects a conflicting-green map and malformed states', () => {
  assert.deepEqual(
    validateApproachStates({ N: 'green', S: 'red', E: 'green', W: 'red' }),
    { ok: false, reason: 'conflicting green on NS and EW' },
  );
  // Green against amber is a conflict too: amber clears, it does not yield.
  assert.equal(
    validateApproachStates({ N: 'green', S: 'red', E: 'red', W: 'amber' }).ok,
    false,
  );
  assert.equal(
    validateApproachStates({ N: 'green', S: 'green', E: 'red', W: 'red' }).ok,
    true,
  );
  assert.equal(validateApproachStates(null).ok, false);
  assert.equal(
    validateApproachStates({ N: 'blue', S: 'red', E: 'red', W: 'red' }).ok,
    false,
  );
});

test('createSignalGroup refuses an unknown group, phase or missing id', () => {
  assert.throws(() => createSignalGroup({ intersectionId: '' }), /requires an intersection id/);
  assert.throws(
    () => createSignalGroup({ intersectionId: 'INT-001', group: 'NE' }),
    /Unknown phase group/,
  );
  assert.throws(
    () => createSignalGroup({ intersectionId: 'INT-001', phase: 'ultraviolet' }),
    /Unknown controller phase/,
  );
});

test('the automatic cycle passes through amber and all-red before the crossing green', () => {
  const { controller, scheduler } = controllerWithScheduler();
  const observed = [controller.getSignalState().phase + '/' + controller.getSignalState().group];
  for (let i = 0; i < 6; i += 1) {
    scheduler.fireNext();
    const signal = controller.getSignalState();
    observed.push(`${signal.phase}/${signal.group}`);
    assert.equal(
      validateApproachStates(signal.states).ok,
      true,
      `step ${i} produced a conflict`,
    );
  }
  assert.deepEqual(observed, [
    'green/NS',
    'amber/NS',
    'all-red/NS',
    'green/EW',
    'amber/EW',
    'all-red/EW',
    'green/NS',
  ]);
  controller.dispose();
});

test('a crossing request for green is queued behind amber and all-red, never applied directly', () => {
  const { controller } = controllerWithScheduler();
  const result = controller.setPhase({ group: 'EW', phase: 'green' });
  assert.equal(result.ok, true);
  assert.match(result.reason, /amber and all-red clearance/);
  // The immediate state is the terminating NS amber — the conflicting axis did
  // NOT turn green.
  assert.equal(result.signal.group, 'NS');
  assert.equal(result.signal.phase, 'amber');
  assert.equal(result.signal.states.E, 'red');
  assert.equal(result.signal.states.W, 'red');
  assert.deepEqual(
    result.pending.map((step) => `${step.phase}/${step.group}`),
    ['all-red/NS', 'green/EW'],
  );
  controller.dispose();
});

test('a same-axis phase change applies directly without a clearance interval', () => {
  const { controller } = controllerWithScheduler();
  const result = controller.setPhase({ group: 'NS', phase: 'green', greenMs: 40000 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.signal.greenMs, 40000);
  controller.dispose();
});

test('extendGreen and shortenGreen respect the configured bounds', () => {
  const { controller, scheduler } = controllerWithScheduler();
  assert.equal(controller.extendGreen(20000).signal.greenMs, 50000);
  // Past the ceiling it clamps rather than growing without limit.
  assert.equal(controller.extendGreen(999999).signal.greenMs, MAX_GREEN_MS);
  assert.equal(controller.shortenGreen(999999).signal.greenMs, MIN_GREEN_MS);
  assert.equal(controller.extendGreen(-5).ok, false);
  assert.equal(controller.shortenGreen(0).ok, false);
  // Once the phase leaves green neither verb applies.
  scheduler.fireNext();
  assert.equal(controller.getSignalState().phase, 'amber');
  assert.match(controller.extendGreen(1000).reason, /not in green/);
  assert.match(controller.shortenGreen(1000).reason, /not in green/);
  controller.dispose();
});

test('setCycle splits the cycle across both axes and keeps each at a legal minimum', () => {
  const { controller } = controllerWithScheduler();
  const result = controller.setCycle({ cycleMs: 120000 });
  assert.equal(result.ok, true);
  assert.equal(result.signal.greenMs, (120000 - 2 * (AMBER_MS + ALL_RED_MS)) / 2);
  // A tiny cycle cannot drive either green below the floor.
  assert.equal(controller.setCycle({ cycleMs: 1000 }).signal.greenMs, MIN_GREEN_MS);
  assert.equal(controller.setCycle({ cycleMs: -1 }).ok, false);
  controller.dispose();
});

test('emergency preemption terminates the conflicting green through amber, not instantly', () => {
  const { controller } = controllerWithScheduler();
  // NS is green; the ambulance needs EW.
  const result = controller.setEmergencyPriority({ axis: 'EW', reason: 'ambulance' });
  assert.equal(result.ok, true);
  // The moment after the request the conflicting axis is still red.
  assert.equal(result.signal.states.E, 'red');
  assert.equal(result.signal.states.W, 'red');
  assert.equal(result.signal.phase, 'amber');
  assert.deepEqual(
    result.pending.map((step) => `${step.phase}/${step.group}`),
    ['all-red/NS', 'green/EW'],
  );
  assert.deepEqual(controller.getHealth().preempted, true);
  controller.dispose();
});

test('preemption reaches the priority axis green only after amber and all-red have run', () => {
  const { controller, scheduler } = controllerWithScheduler();
  controller.setEmergencyPriority({ axis: 'EW', reason: 'ambulance' });
  scheduler.fireNext(); // amber -> all-red
  let signal = controller.getSignalState();
  assert.equal(signal.phase, 'all-red');
  assert.equal(signal.states.E, 'red', 'the priority axis is not green during all-red');
  scheduler.fireNext(); // all-red -> EW green
  signal = controller.getSignalState();
  assert.equal(signal.group, 'EW');
  assert.equal(signal.phase, 'green');
  assert.equal(signal.states.E, 'green');
  assert.equal(signal.states.W, 'green');
  controller.dispose();
});

test('every state a preemption produces is conflict-free', () => {
  const { controller, scheduler } = controllerWithScheduler();
  controller.setEmergencyPriority({ axis: 'EW', reason: 'fire engine' });
  for (let i = 0; i < 10; i += 1) {
    const signal = controller.getSignalState();
    assert.equal(
      validateApproachStates(signal.states).ok,
      true,
      `preemption step ${i} (${signal.phase}/${signal.group}) conflicted`,
    );
    scheduler.fireNext();
  }
  controller.dispose();
});

test('preemption is already satisfied when the priority axis holds green', () => {
  const { controller } = controllerWithScheduler();
  const result = controller.setEmergencyPriority({ axis: 'NS', reason: 'police' });
  assert.equal(result.ok, true);
  assert.match(result.reason, /already green/);
  assert.equal(result.signal.states.N, 'green');
  assert.deepEqual(result.pending, []);
  controller.dispose();
});

test('a second preemption keeps the original restore target rather than nesting', () => {
  const { controller } = controllerWithScheduler();
  controller.setEmergencyPriority({ axis: 'EW', reason: 'ambulance 1' });
  controller.setEmergencyPriority({ axis: 'EW', reason: 'ambulance 2' });
  // Two preemptions must not stack: one release returns the intersection to a
  // normal phase, not to a state that remembers only the second vehicle.
  const released = controller.returnToNormal({ signal: false });
  assert.equal(released.ok, true);
  assert.deepEqual(controller.pendingPhaseSteps, []);
  // A second release is refused, proving the first was the only one outstanding.
  assert.equal(controller.returnToNormal({ signal: false }).ok, false);
  controller.dispose();
});

test('returnToNormal refuses while the vehicle is still on the approach', () => {
  const { controller } = controllerWithScheduler();
  controller.setEmergencyPriority({ axis: 'EW', reason: 'ambulance' });
  const held = controller.returnToNormal({ signal: true });
  assert.equal(held.ok, false);
  assert.match(held.reason, /still on the approach/);
  const released = controller.returnToNormal({ signal: false });
  assert.equal(released.ok, true);
  controller.dispose();
});

test('returnToNormal terminates a priority green through amber', () => {
  const { controller, scheduler } = controllerWithScheduler();
  controller.setEmergencyPriority({ axis: 'EW', reason: 'ambulance' });
  scheduler.fireNext();
  scheduler.fireNext();
  assert.equal(controller.getSignalState().states.E, 'green');
  const restored = controller.returnToNormal({ signal: false });
  assert.equal(restored.ok, true);
  // The priority green is being cleared, not abandoned mid-green.
  assert.equal(restored.signal.phase, 'amber');
  assert.equal(restored.signal.states.E, 'amber');
  controller.dispose();
});

test('returnToNormal without an active preemption is a no-op', () => {
  const { controller } = controllerWithScheduler();
  assert.equal(controller.returnToNormal().ok, false);
  assert.match(controller.returnToNormal().reason, /no active preemption/);
  controller.dispose();
});

test('an unknown priority axis is refused and leaves the controller untouched', () => {
  const { controller } = controllerWithScheduler();
  const before = controller.getSignalState();
  const result = controller.setEmergencyPriority({ axis: 'UP' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown priority axis/);
  assert.deepEqual(controller.getSignalState().states, before.states);
  controller.dispose();
});

test('a fault shows all-red and refuses every control verb', () => {
  const { controller } = controllerWithScheduler();
  controller.setFault('controller offline');
  const signal = controller.getSignalState();
  assert.equal(signal.phase, 'fault');
  for (const direction of ['N', 'S', 'E', 'W'])
    assert.equal(signal.states[direction], 'red');
  assert.equal(controller.setPhase({ group: 'EW' }).ok, false);
  assert.equal(controller.extendGreen(5000).ok, false);
  assert.equal(controller.shortenGreen(5000).ok, false);
  assert.equal(controller.setCycle({ cycleMs: 90000 }).ok, false);
  assert.equal(controller.setEmergencyPriority({ axis: 'EW' }).ok, false);
  assert.equal(controller.getHealth().status, 'FAULT');
  controller.dispose();
});

test('clearFault restores normal control from a safe state', () => {
  const { controller } = controllerWithScheduler();
  controller.setFault('offline');
  assert.equal(controller.clearFault().ok, true);
  assert.equal(controller.getSignalState().phase, 'green');
  assert.equal(validateApproachStates(controller.getSignalState().states).ok, true);
  assert.equal(controller.clearFault().ok, false);
  controller.dispose();
});

test('health reports DEGRADED once the heartbeat goes stale', () => {
  const { controller } = controllerWithScheduler();
  assert.equal(controller.getHealth().status, 'OK');
  now += 20000;
  assert.equal(controller.getHealth().status, 'DEGRADED');
  controller.heartbeat();
  assert.equal(controller.getHealth().status, 'OK');
  controller.dispose();
});

test('health reports PREEMPTED while priority is active', () => {
  const { controller } = controllerWithScheduler();
  controller.setEmergencyPriority({ axis: 'EW', reason: 'ambulance' });
  const health = controller.getHealth();
  assert.equal(health.status, 'PREEMPTED');
  assert.equal(health.preempted, true);
  assert.ok(health.transitions > 0);
  controller.dispose();
});

test('describeController names the simulator honestly and reports no hardware', () => {
  const { controller } = controllerWithScheduler();
  const described = describeController(controller);
  assert.equal(described.kind, 'simulator');
  assert.equal(described.authorized, false);
  assert.match(described.label, /SIMULATED/);
  assert.match(described.label, /no hardware attached/);
  // describeController must never claim a controller it was not given.
  assert.equal(describeController(null).intersectionId, 'unknown');
  controller.dispose();
});

test('a long run of automatic cycles never produces a conflicting state', () => {
  const { controller, scheduler } = controllerWithScheduler();
  for (let i = 0; i < 400; i += 1) {
    const signal = controller.getSignalState();
    assert.equal(
      validateApproachStates(signal.states).ok,
      true,
      `cycle step ${i} (${signal.phase}/${signal.group}) conflicted`,
    );
    scheduler.fireNext();
  }
  controller.dispose();
});

test('interleaving preemption with automatic cycles stays conflict-free', () => {
  const { controller, scheduler } = controllerWithScheduler();
  for (let i = 0; i < 40; i += 1) {
    assert.equal(validateApproachStates(controller.getSignalState().states).ok, true);
    if (i % 7 === 3)
      controller.setEmergencyPriority({
        axis: i % 14 === 3 ? 'EW' : 'NS',
        reason: 'interleaved test',
      });
    if (i % 11 === 5) controller.returnToNormal({ signal: false });
    scheduler.fireNext();
  }
  controller.dispose();
});
