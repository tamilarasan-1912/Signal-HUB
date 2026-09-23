/**
 * @file Signal-controller abstraction and its built-in simulator.
 *
 * {@link createSimulatedSignalController} is a complete implementation of the
 * interface a real traffic-signal controller API would satisfy. Nothing here
 * talks to hardware: `authorized: false` is fixed, and {@link describeController}
 * reports that honestly so the UI can say "simulator" rather than implying a
 * live intersection.
 *
 * Safety is enforced by construction rather than by discipline:
 *
 *  - Phase transitions always pass through amber, then all-red. There is no
 *    code path that moves from one green to a conflicting green.
 *  - {@link createSignalGroup} refuses a state map whose two approaches on one
 *    axis disagree, so an internally inconsistent intersection cannot exist.
 *  - An emergency preemption request records the phase it interrupted so
 *    `returnToNormal()` restores that phase rather than a guess.
 *
 * @module traffic-control/signals
 */

import {
  ALL_RED_MS,
  AMBER_MS,
  CONTROLLER_PHASES,
  DEFAULT_GREEN_MS,
  EMERGENCY_HOLD_MS,
  MAX_GREEN_MS,
  MIN_GREEN_MS,
  PHASE_GROUP_APPROACHES,
  SIGNAL_STATES,
  approachAxis,
} from './policy.js';
import { clamp, isFiniteNumber } from './geometry.js';

/** @const {number} ms between controller health checks before a fault. */
export const HEARTBEAT_TIMEOUT_MS = 15000;

/**
 * Build the per-approach signal state for a controller phase.
 *
 * This is the only function that decides which lamps are lit, so the conflict
 * invariant has exactly one place to be true in.
 * @param {'NS'|'EW'} group - The axis currently holding green.
 * @param {'green'|'amber'|'all-red'|'fault'} phase
 * @returns {{N:string,S:string,E:string,W:string}}
 */
export function approachStatesFor(group, phase) {
  const states = { N: 'red', S: 'red', E: 'red', W: 'red' };
  if (phase === 'fault') return states;
  const greenAxis = phase === 'green' ? 'green' : phase === 'amber' ? 'amber' : null;
  if (!greenAxis) return states; // all-red: everything red, nothing conflicts
  for (const direction of PHASE_GROUP_APPROACHES[group]) {
    states[direction] = greenAxis;
  }
  return states;
}

/**
 * Validate that a state map cannot show a conflicting green.
 *
 * Two approaches on different axes both showing green (or green + amber) is
 * the condition this project must never produce, in simulation or otherwise.
 * @param {{N:string,S:string,E:string,W:string}} states
 * @returns {{ok:boolean, reason:string|null}}
 */
export function validateApproachStates(states) {
  if (!states || typeof states !== 'object')
    return { ok: false, reason: 'missing approach states' };
  for (const direction of ['N', 'S', 'E', 'W']) {
    if (!SIGNAL_STATES.includes(states[direction]))
      return { ok: false, reason: `invalid state for ${direction}` };
  }
  const litAxis = (value) => (value === 'green' || value === 'amber');
  const ns = litAxis(states.N) || litAxis(states.S);
  const ew = litAxis(states.E) || litAxis(states.W);
  if (ns && ew) return { ok: false, reason: 'conflicting green on NS and EW' };
  return { ok: true, reason: null };
}

/**
 * Compose an intersection's signal group from a phase and an axis.
 * @param {object} options
 * @param {string} options.intersectionId
 * @param {'NS'|'EW'} [options.group]
 * @param {'green'|'amber'|'all-red'|'fault'} [options.phase]
 * @param {number} [options.greenMs]
 * @returns {object} A frozen signal group.
 */
export function createSignalGroup({
  intersectionId,
  group = 'NS',
  phase = 'green',
  greenMs = DEFAULT_GREEN_MS,
} = {}) {
  if (typeof intersectionId !== 'string' || !intersectionId)
    throw new TypeError('A signal group requires an intersection id');
  if (!Object.hasOwn(PHASE_GROUP_APPROACHES, group))
    throw new TypeError(`Unknown phase group: ${group}`);
  if (!CONTROLLER_PHASES.includes(phase))
    throw new TypeError(`Unknown controller phase: ${phase}`);
  const states = approachStatesFor(group, phase);
  const check = validateApproachStates(states);
  if (!check.ok) throw new Error(`Conflicting signal group: ${check.reason}`);
  return Object.freeze({
    intersectionId,
    group,
    phase,
    greenMs: clamp(greenMs, MIN_GREEN_MS, MAX_GREEN_MS),
    states: Object.freeze(states),
  });
}

/**
 * Build the command interface every signal controller implements.
 *
 * `clock` and `scheduler` are injectable so the unit tests drive phase
 * transitions deterministically instead of sleeping.
 * @param {object} [options]
 * @param {string} [options.intersectionId='INT-000']
 * @param {() => number} [options.clock]
 * @param {{setTimer:(fn:Function,ms:number)=>unknown, clearTimer:(h:unknown)=>void}} [options.scheduler]
 * @returns {object} A signal controller.
 */
export function createSimulatedSignalController({
  intersectionId = 'INT-000',
  clock = () => Date.now(),
  scheduler = {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
  },
} = {}) {
  /** @type {object} */
  let signal = createSignalGroup({ intersectionId });
  let phaseStartedAt = clock();
  let phaseTimer = null;
  let faultReason = null;
  let lastHeartbeatAt = clock();
  /** @type {object|null} The phase an emergency preemption interrupted. */
  let preemption = null;
  /** @type {number} Monotonic count of transitions, for the audit trail. */
  let transitions = 0;

  const clearPhaseTimer = () => {
    if (phaseTimer === null) return;
    scheduler.clearTimer(phaseTimer);
    phaseTimer = null;
  };

  const commit = (group, phase, greenMs = signal.greenMs) => {
    clearPhaseTimer();
    signal = createSignalGroup({ intersectionId, group, phase, greenMs });
    phaseStartedAt = clock();
    transitions += 1;
    return signal;
  };

  /**
   * Schedule the automatic follow-on for the phase we just entered.
   *
   * green → amber → all-red → green on the OTHER axis. The all-red hop is the
   * safety interval; skipping it is what produces a real-world crash, so it is
   * not configurable.
   */
  const advance = () => {
    const other = signal.group === 'NS' ? 'EW' : 'NS';
    if (signal.phase === 'green') {
      commit(signal.group, 'amber');
      return;
    }
    if (signal.phase === 'amber') {
      commit(signal.group, 'all-red');
      return;
    }
    if (signal.phase === 'all-red') {
      // An all-red during preemption is followed by the priority axis's green,
      // not the normal alternation — the preemption owns the next move, and it
      // carries its own hold duration.
      if (preemption) commit(preemption.axis, 'green', preemption.holdMs);
      else commit(other, 'green');
      return;
    }
    // A fault holds until an operator clears it; nothing self-heals.
  };

  const scheduleAdvance = (ms) => {
    clearPhaseTimer();
    phaseTimer = scheduler.setTimer(() => {
      phaseTimer = null;
      advance();
      scheduleAdvance(nextPhaseMs());
    }, Math.max(0, ms));
  };

  /** How long the CURRENT phase should hold before its next transition. */
  const nextPhaseMs = () => {
    if (signal.phase === 'green') {
      if (preemption) return Math.min(signal.greenMs, EMERGENCY_HOLD_MS);
      return signal.greenMs;
    }
    if (signal.phase === 'amber') return AMBER_MS;
    if (signal.phase === 'all-red') return ALL_RED_MS;
    return HEARTBEAT_TIMEOUT_MS;
  };

  // Arm the first automatic transition. Without this a freshly-built controller
  // would sit on its initial green forever unless a caller happened to issue a
  // command, which is a controller that only works by accident.
  scheduleAdvance(nextPhaseMs());

  const controller = {
    intersectionId,

    /** @returns {object} The current signal group (never null). */
    getSignalState() {
      return signal;
    },

    /**
     * Set the controller's active phase.
     *
     * A request that would green a conflicting axis does not take effect
     * directly: it routes through amber → all-red first, exactly as the
     * automatic alternation does.
     * @param {{group?:string, phase?:string, greenMs?:number}} next
     * @returns {{ok:boolean, reason:string|null, signal:object}}
     */
    setPhase(next = {}) {
      if (faultReason) return { ok: false, reason: 'controller in fault', signal };
      const group = next.group ?? signal.group;
      const phase = next.phase ?? 'green';
      if (!Object.hasOwn(PHASE_GROUP_APPROACHES, group))
        return { ok: false, reason: `unknown phase group: ${group}`, signal };
      if (!CONTROLLER_PHASES.includes(phase))
        return { ok: false, reason: `unknown phase: ${phase}`, signal };
      const greenMs = isFiniteNumber(next.greenMs)
        ? clamp(next.greenMs, MIN_GREEN_MS, MAX_GREEN_MS)
        : signal.greenMs;

      // Same axis, direct phase change inside that axis: no clearance needed.
      if (group === signal.group) {
        commit(group, phase, greenMs);
        scheduleAdvance(nextPhaseMs());
        return { ok: true, reason: null, signal };
      }

      // Crossing axis. A direct jump to green is refused; the caller gets a
      // queue of the safe intermediate phases instead.
      if (phase === 'green') {
        const clearing = signal.group;
        commit(clearing, 'amber');
        scheduleAdvance(AMBER_MS);
        return {
          ok: true,
          reason: 'queued behind amber and all-red clearance',
          signal,
          pending: [
            { group: clearing, phase: 'all-red', ms: ALL_RED_MS },
            { group, phase: 'green', ms: greenMs },
          ],
        };
      }
      commit(group, phase, greenMs);
      scheduleAdvance(nextPhaseMs());
      return { ok: true, reason: null, signal };
    },

    /**
     * Extend the current green by a number of milliseconds.
     * @param {number} ms
     * @returns {{ok:boolean, reason:string|null, signal:object}}
     */
    extendGreen(ms) {
      if (faultReason) return { ok: false, reason: 'controller in fault', signal };
      if (signal.phase !== 'green')
        return { ok: false, reason: 'not in green', signal };
      if (!isFiniteNumber(ms) || ms <= 0)
        return { ok: false, reason: 'a positive duration is required', signal };
      const greenMs = clamp(signal.greenMs + ms, MIN_GREEN_MS, MAX_GREEN_MS);
      const elapsed = clock() - phaseStartedAt;
      commit(signal.group, 'green', greenMs);
      scheduleAdvance(Math.max(0, greenMs - elapsed));
      return { ok: true, reason: null, signal };
    },

    /**
     * Shorten the current green, never below {@link MIN_GREEN_MS}.
     * @param {number} ms
     * @returns {{ok:boolean, reason:string|null, signal:object}}
     */
    shortenGreen(ms) {
      if (faultReason) return { ok: false, reason: 'controller in fault', signal };
      if (signal.phase !== 'green')
        return { ok: false, reason: 'not in green', signal };
      if (!isFiniteNumber(ms) || ms <= 0)
        return { ok: false, reason: 'a positive duration is required', signal };
      const greenMs = clamp(signal.greenMs - ms, MIN_GREEN_MS, MAX_GREEN_MS);
      const elapsed = clock() - phaseStartedAt;
      commit(signal.group, 'green', greenMs);
      scheduleAdvance(Math.max(0, greenMs - elapsed));
      return { ok: true, reason: null, signal };
    },

    /**
     * Replace the whole cycle: both greens sum to the requested cycle length.
     * @param {{cycleMs:number}} options
     * @returns {{ok:boolean, reason:string|null, signal:object}}
     */
    setCycle({ cycleMs } = {}) {
      if (faultReason) return { ok: false, reason: 'controller in fault', signal };
      if (!isFiniteNumber(cycleMs) || cycleMs <= 0)
        return { ok: false, reason: 'a positive cycle duration is required', signal };
      // Each axis gets half the cycle, minus the clearance intervals the
      // controller will spend transitioning between them.
      const perAxis = (cycleMs - 2 * (AMBER_MS + ALL_RED_MS)) / 2;
      const greenMs = clamp(perAxis, MIN_GREEN_MS, MAX_GREEN_MS);
      commit(signal.group, signal.phase, greenMs);
      scheduleAdvance(nextPhaseMs());
      return { ok: true, reason: null, signal };
    },

    /**
     * Begin an emergency preemption on one axis.
     *
     * The transition is the same safe sequence as any other phase change:
     * the current green terminates, amber and all-red clear the box, and only
     * then does the priority axis turn green. `pending` names those steps so
     * the UI can narrate them.
     * @param {{axis:string, reason:string, holdMs?:number}} request
     * @returns {{ok:boolean, reason:string|null, signal:object, pending:object[]}}
     */
    setEmergencyPriority({ axis, reason = 'emergency vehicle', holdMs = EMERGENCY_HOLD_MS } = {}) {
      if (faultReason)
        return { ok: false, reason: 'controller in fault', signal, pending: [] };
      if (!Object.hasOwn(PHASE_GROUP_APPROACHES, axis))
        return { ok: false, reason: `unknown priority axis: ${axis}`, signal, pending: [] };
      const hold = isFiniteNumber(holdMs) ? clamp(holdMs, 0, MAX_GREEN_MS) : EMERGENCY_HOLD_MS;
      // Remember what to restore, but never overwrite an active preemption with
      // a second one — a nested request keeps the ORIGINAL restore target so
      // two ambulances cannot strand the intersection in permanent priority.
      if (!preemption)
        preemption = { axis, reason, holdMs: hold, restore: { group: signal.group, phase: 'green', greenMs: signal.greenMs } };
      else preemption.axis = axis;
      lastHeartbeatAt = clock();

      if (signal.group === axis && signal.phase === 'green') {
        commit(axis, 'green', hold);
        scheduleAdvance(hold);
        return {
          ok: true,
          reason: 'already green on the priority axis',
          signal,
          pending: [],
        };
      }
      commit(signal.group, 'amber');
      scheduleAdvance(AMBER_MS);
      return {
        ok: true,
        reason: null,
        signal,
        pending: [
          { group: signal.group, phase: 'all-red', ms: ALL_RED_MS },
          { group: axis, phase: 'green', ms: hold },
        ],
      };
    },

    /**
     * End an emergency preemption and restore ordinary adaptive control.
     * @param {{signal?:string}} [options]
     * @returns {{ok:boolean, reason:string|null, signal:object}}
     */
    returnToNormal({ signal: observed = null } = {}) {
      if (!preemption)
        return { ok: false, reason: 'no active preemption', signal };
      if (observed !== null) {
        // The caller may hold the intersection until the vehicle clears; a
        // truthy observation means "still passing through".
        lastHeartbeatAt = clock();
        if (observed) return { ok: false, reason: 'emergency vehicle still on the approach', signal };
      }
      const restore = preemption.restore;
      const axis = preemption.axis;
      preemption = null;
      if (signal.group === axis && signal.phase === 'green') {
        // Safe restore: terminate the priority green through amber first.
        commit(axis, 'amber');
        scheduleAdvance(AMBER_MS);
        return { ok: true, reason: 'restoring after amber clearance', signal };
      }
      commit(restore.group, 'green', restore.greenMs);
      scheduleAdvance(nextPhaseMs());
      return { ok: true, reason: null, signal };
    },

    /**
     * Controller health, as an operator would read it.
     * @returns {{status:string, fault:string|null, lastHeartbeat:number,
     *   msSinceHeartbeat:number, transitions:number, preempted:boolean}}
     */
    getHealth() {
      const since = clock() - lastHeartbeatAt;
      const status = faultReason
        ? 'FAULT'
        : preemption
          ? 'PREEMPTED'
          : since > HEARTBEAT_TIMEOUT_MS
            ? 'DEGRADED'
            : 'OK';
      return {
        status,
        fault: faultReason,
        lastHeartbeat: lastHeartbeatAt,
        msSinceHeartbeat: since,
        transitions,
        preempted: Boolean(preemption),
      };
    },

    /** Refresh the heartbeat, as a live controller's own poll would. */
    heartbeat() {
      lastHeartbeatAt = clock();
      return controller.getHealth();
    },

    /**
     * Put the controller into a fault, the way a real signal failure does.
     * A faulty controller shows all-red and refuses control commands.
     * @param {string} [reason]
     */
    setFault(reason = 'signal controller offline') {
      faultReason = reason;
      clearPhaseTimer();
      signal = createSignalGroup({ intersectionId, group: 'NS', phase: 'fault', greenMs: signal.greenMs });
      transitions += 1;
      return { ok: true, reason, signal };
    },

    /** Clear a fault, returning the intersection to ordinary control. */
    clearFault() {
      if (!faultReason) return { ok: false, reason: 'no fault', signal };
      faultReason = null;
      preemption = null;
      lastHeartbeatAt = clock();
      commit('NS', 'green');
      scheduleAdvance(nextPhaseMs());
      return { ok: true, reason: null, signal };
    },

    /** Stop the controller's timers. Called by the owning engine on dispose. */
    dispose() {
      clearPhaseTimer();
    },

    /** True when the pending phase steps this controller would run next. */
    get pendingPhaseSteps() {
      return preemption
        ? [{ axis: preemption.axis, reason: preemption.reason }]
        : [];
    },
  };

  return controller;
}

/**
 * Describe a controller for an operator, naming its nature honestly.
 * @param {object} controller
 * @returns {{intersectionId:string, kind:string, authorized:boolean, label:string}}
 */
export function describeController(controller) {
  return {
    intersectionId: controller?.intersectionId || 'unknown',
    kind: 'simulator',
    authorized: false,
    label: 'SIMULATED — built-in signal simulator (no hardware attached)',
  };
}
