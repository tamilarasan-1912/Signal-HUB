/**
 * @file Configurable traffic-rule engine, violation pipeline, evidence
 * packages, review workflow and the penalty engine.
 *
 * THE RULE THAT SHAPES THIS FILE. A detected violation is a *claim*, not a
 * finding. Nothing here issues a fine. Every violation that passes its
 * confidence threshold lands in `pending` and waits for a human; only an
 * explicitly authorized enforcement integration plus a legal workflow could
 * ever change that, and this prototype has neither. See
 * {@link createViolationEngine} and {@link AUTOMATED_ENFORCEMENT_ENABLED}.
 *
 * Laws are configuration, not code. A rule is a record with a detection method
 * and a confidence threshold; the red-light pipeline is one consumer of that
 * record, not a hardcoded behaviour inside a model. A jurisdiction with
 * different rules supplies different records.
 *
 * @module traffic-control/violations
 */

import {
  AUTOMATED_ENFORCEMENT_ENABLED,
  DATA_MODES,
  EVIDENCE_RETENTION_MINUTES,
  PLATE_MIN_CONFIDENCE,
  REVIEW_STATES,
  SIGNAL_STATES,
} from './policy.js';
import { clamp, isFiniteNumber } from './geometry.js';
import { SEVERITY, sequenceGenerator } from './events.js';

/**
 * The violation catalogue shipped with the prototype.
 *
 * These are DEFAULTS, not law. Each entry states what evidence it needs and
 * whether a human must review it, because that is what makes a rule
 * configurable rather than implied.
 * @const {object[]}
 */
export const DEFAULT_RULES = Object.freeze([
  Object.freeze({
    ruleId: 'RED_LIGHT',
    description: 'Vehicle crossed the stop line while the signal showed red',
    requiredEvidence: Object.freeze(['frame', 'timestamp', 'signalState', 'stopLineCrossing']),
    detectionMethod: 'signal-state-at-crossing',
    confidenceThreshold: 0.85,
    jurisdiction: 'default',
    reviewRequired: true,
    penalty: Object.freeze({
      penaltyAmount: 1000,
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      escalationRules: Object.freeze(['repeat within 12 months escalates']),
      reviewRequired: true,
    }),
  }),
  Object.freeze({
    ruleId: 'STOP_LINE',
    description: 'Vehicle came to rest beyond the stop line',
    requiredEvidence: Object.freeze(['frame', 'timestamp', 'stopLinePosition']),
    detectionMethod: 'stop-line-position',
    confidenceThreshold: 0.8,
    jurisdiction: 'default',
    reviewRequired: true,
    penalty: Object.freeze({
      penaltyAmount: 500,
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      escalationRules: Object.freeze([]),
      reviewRequired: true,
    }),
  }),
  Object.freeze({
    ruleId: 'ILLEGAL_TURN',
    description: 'Vehicle turned against a posted turn restriction',
    requiredEvidence: Object.freeze(['frame', 'timestamp', 'trajectory', 'restriction']),
    detectionMethod: 'trajectory-vs-restriction',
    confidenceThreshold: 0.8,
    jurisdiction: 'default',
    reviewRequired: true,
    penalty: Object.freeze({
      penaltyAmount: 500,
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      escalationRules: Object.freeze([]),
      reviewRequired: true,
    }),
  }),
  Object.freeze({
    ruleId: 'WRONG_WAY',
    description: 'Vehicle travelled against the mapped one-way direction',
    requiredEvidence: Object.freeze(['frame', 'timestamp', 'trajectory', 'roadDirection']),
    detectionMethod: 'trajectory-vs-oneway',
    confidenceThreshold: 0.85,
    jurisdiction: 'default',
    reviewRequired: true,
    penalty: Object.freeze({
      penaltyAmount: 1000,
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      escalationRules: Object.freeze([]),
      reviewRequired: true,
    }),
  }),
  Object.freeze({
    ruleId: 'LANE_VIOLATION',
    description: 'Vehicle crossed a lane marking into a restricted lane',
    requiredEvidence: Object.freeze(['frame', 'timestamp', 'laneMarking']),
    detectionMethod: 'lane-crossing',
    confidenceThreshold: 0.85,
    jurisdiction: 'default',
    reviewRequired: true,
    penalty: Object.freeze({
      penaltyAmount: 500,
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      escalationRules: Object.freeze([]),
      reviewRequired: true,
    }),
  }),
  Object.freeze({
    ruleId: 'SPEED',
    description: 'Vehicle exceeded the posted limit by more than the tolerance',
    requiredEvidence: Object.freeze(['frame', 'timestamp', 'speedEstimate', 'speedLimit']),
    detectionMethod: 'speed-vs-limit',
    // Deliberately the strictest threshold in the table: a speed estimate from
    // a single camera is the weakest measurement this platform can make, so it
    // needs the most confidence before it is even worth a reviewer's time.
    confidenceThreshold: 0.95,
    jurisdiction: 'default',
    reviewRequired: true,
    penalty: Object.freeze({
      penaltyAmount: 1000,
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      escalationRules: Object.freeze([]),
      reviewRequired: true,
    }),
  }),
  Object.freeze({
    ruleId: 'HELMET',
    description: 'Rider detected without a helmet where one is required',
    requiredEvidence: Object.freeze(['frame', 'timestamp']),
    detectionMethod: 'rider-headwear',
    confidenceThreshold: 0.9,
    jurisdiction: 'default',
    reviewRequired: true,
    penalty: Object.freeze({
      penaltyAmount: 500,
      currency: 'INR',
      effectiveFrom: '2026-01-01',
      escalationRules: Object.freeze([]),
      reviewRequired: true,
    }),
  }),
]);

/**
 * Validate a rule record, because a malformed rule is a silent enforcement
 * hole: a rule with no threshold would admit every detection.
 * @param {object} rule
 * @returns {boolean}
 */
export function validateRule(rule) {
  if (!rule || typeof rule.ruleId !== 'string' || !rule.ruleId)
    throw new TypeError('A rule requires a ruleId');
  if (typeof rule.description !== 'string' || !rule.description)
    throw new TypeError(`Rule ${rule.ruleId} requires a description`);
  if (!Array.isArray(rule.requiredEvidence) || !rule.requiredEvidence.length)
    throw new TypeError(`Rule ${rule.ruleId} requires evidence requirements`);
  if (
    !isFiniteNumber(rule.confidenceThreshold) ||
    rule.confidenceThreshold <= 0 ||
    rule.confidenceThreshold > 1
  )
    throw new TypeError(`Rule ${rule.ruleId} requires a confidence threshold in (0, 1]`);
  if (typeof rule.detectionMethod !== 'string' || !rule.detectionMethod)
    throw new TypeError(`Rule ${rule.ruleId} requires a detection method`);
  if (!rule.jurisdiction)
    throw new TypeError(`Rule ${rule.ruleId} requires a jurisdiction`);
  return true;
}

/**
 * A rule set: the configurable catalogue, keyed by jurisdiction.
 * @param {object[]} [rules]
 * @returns {object}
 */
export function createRuleSet(rules = DEFAULT_RULES) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const rule of rules) {
    validateRule(rule);
    if (byId.has(rule.ruleId))
      throw new Error(`Duplicate rule id: ${rule.ruleId}`);
    byId.set(rule.ruleId, Object.freeze({ ...rule }));
  }
  return Object.freeze({
    /** @param {string} ruleId @returns {object|null} */
    get(ruleId) {
      return byId.get(ruleId) || null;
    },
    /**
     * Rules applicable in a jurisdiction, including `default` rules.
     * @param {string} jurisdiction
     * @returns {object[]}
     */
    forJurisdiction(jurisdiction) {
      return [...byId.values()].filter(
        (rule) => rule.jurisdiction === jurisdiction || rule.jurisdiction === 'default',
      );
    },
    /** @returns {object[]} */
    list() {
      return [...byId.values()];
    },
    /** @returns {number} */
    get size() {
      return byId.size;
    },
  });
}

/**
 * Evaluate the red-light rule from an observation.
 *
 * Kept as a separate, explicitly named function rather than a generic rule
 * evaluator because the red-light case is the one an acceptance test names, and
 * an explicit function is what a reader can check. It reads a rule record, so
 * changing the threshold is configuration.
 * @param {object} observation
 * @param {string} observation.signalState - The state at the moment of crossing.
 * @param {boolean} observation.crossedStopLine
 * @param {number} observation.confidence
 * @param {number} [observation.stopLineOffsetM]
 * @param {object} rule
 * @returns {{violated:boolean, reason:string, confidence:number}}
 */
export function evaluateRedLight(observation, rule) {
  const threshold = rule?.confidenceThreshold ?? 0.85;
  if (!observation?.crossedStopLine)
    return { violated: false, reason: 'vehicle did not cross the stop line', confidence: 0 };
  if (observation.signalState !== 'red')
    return {
      violated: false,
      reason: `signal was ${observation.signalState || 'unknown'} at crossing`,
      confidence: 0,
    };
  const confidence = isFiniteNumber(observation.confidence)
    ? clamp(observation.confidence, 0, 1)
    : 0;
  if (confidence < threshold)
    return {
      violated: false,
      reason: `confidence ${confidence.toFixed(2)} below rule threshold ${threshold}`,
      confidence,
    };
  return {
    violated: true,
    reason: 'vehicle crossed the stop line while the signal showed red',
    confidence,
  };
}

/**
 * Build an evidence package for a violation.
 *
 * The package is the unit a reviewer opens. It records what was observed and
 * from where, so a decision can be reproduced without re-running inference.
 * Retention is stamped here so a purge has a field to read.
 * @param {object} input
 * @param {string} input.ruleId
 * @param {object} input.detection
 * @param {object} [input.plate]
 * @param {string} input.cameraId
 * @param {string} input.intersectionId
 * @param {number} input.at
 * @param {string} [input.signalState]
 * @param {string} [input.frameRef]
 * @param {object} [input.rule]
 * @returns {object}
 */
export function createEvidence({
  ruleId,
  detection,
  plate = null,
  cameraId,
  intersectionId,
  at,
  signalState = null,
  frameRef = null,
  rule = null,
} = {}) {
  const required = rule?.requiredEvidence || [];
  const present = [];
  if (frameRef) present.push('frame');
  if (at) present.push('timestamp');
  if (signalState) present.push('signalState');
  if (isFiniteNumber(detection?.stopLineOffsetM)) present.push('stopLineCrossing');
  const missing = required.filter((need) => !present.includes(need));
  return Object.freeze({
    ruleId,
    detection: detection || null,
    plate: plate
      ? Object.freeze({
          // Plate text is carried ONLY on the evidence record — never on the
          // map, never in the event stream. See the privacy note in vision.js.
          plate: plate.plate || null,
          display: plate.display || 'PLATE UNREADABLE',
          confidence: plate.confidence ?? null,
          readable: Boolean(plate.readable),
          jurisdiction: plate.jurisdiction || '',
        })
      : null,
    cameraId: cameraId || null,
    intersectionId: intersectionId || null,
    at: at ?? null,
    signalState,
    frameRef: frameRef || null,
    createdAt: Date.now(),
    retainUntil: Date.now() + EVIDENCE_RETENTION_MINUTES * 60_000,
    complete: missing.length === 0,
    missingEvidence: Object.freeze(missing),
    mode: DATA_MODES.simulated,
  });
}

/**
 * Calculate a configured penalty.
 *
 * It returns the configured figure AND a warning, because the figure is a
 * configuration value in this repository rather than a statement of law. A
 * caller that dropped the warning would be presenting a prototype constant as a
 * legal amount.
 * @param {object} rule
 * @param {object} [options]
 * @param {number} [options.priorOffences=0]
 * @returns {{amount:number|null, currency:string|null, disclaimer:string,
 *   escalationApplied:boolean, reviewRequired:boolean}}
 */
export function calculatePenalty(rule, { priorOffences = 0 } = {}) {
  const penalty = rule?.penalty;
  if (!penalty || !isFiniteNumber(penalty.penaltyAmount)) {
    return {
      amount: null,
      currency: null,
      disclaimer: 'No configured penalty for this rule.',
      escalationApplied: false,
      reviewRequired: rule?.reviewRequired ?? true,
    };
  }
  const escalationApplied = priorOffences > 0 && penalty.escalationRules?.length > 0;
  const multiplier = escalationApplied ? Math.min(3, 1 + priorOffences * 0.5) : 1;
  return {
    amount: Math.round(penalty.penaltyAmount * multiplier),
    currency: penalty.currency || null,
    disclaimer:
      'Configured penalty — verify against current jurisdiction rules before any notice is issued.',
    escalationApplied,
    reviewRequired: penalty.reviewRequired ?? rule.reviewRequired,
  };
}

/**
 * Create the violation engine: rule evaluation, evidence, and the review queue.
 * @param {object} options
 * @param {() => number} [options.clock]
 * @param {(event:object) => void} [options.emit]
 * @param {object} [options.rules] - A rule set from {@link createRuleSet}.
 * @param {object} [options.audit]
 * @returns {object}
 */
export function createViolationEngine({
  clock = () => Date.now(),
  emit = null,
  rules = createRuleSet(),
  audit = null,
} = {}) {
  /** @type {Map<string, object>} */
  const violations = new Map();
  let nextId = sequenceGenerator('VIO', 6);
  let year = new Date(clock()).getUTCFullYear();

  const publish = (event) => {
    try {
      emit?.(event);
    } catch (error) {
      console.error('Violation event sink failed', error);
    }
  };

  const engine = {
    /** @returns {object} The rule set in force. */
    rules,

    /**
     * Register a detection as a candidate violation.
     *
     * The candidate carries its evaluation; a rule that did not fire produces
     * no violation at all, so the queue only ever holds claims that met their
     * own threshold.
     * @param {object} input
     * @param {string} input.ruleId
     * @param {object} input.detection
     * @param {string} input.cameraId
     * @param {string} input.intersectionId
     * @param {object} input.observation - Passed to the rule evaluator.
     * @param {object} [input.plate]
     * @param {string} [input.frameRef]
     * @param {number} [input.at]
     * @returns {{created:boolean, violation:object|null, reason:string}}
     */
    record({ ruleId, detection, cameraId, intersectionId, observation, plate = null, frameRef = null, at = null } = {}) {
      const rule = rules.get(ruleId);
      if (!rule) return { created: false, violation: null, reason: `unknown rule ${ruleId}` };
      let evaluation;
      if (rule.detectionMethod === 'signal-state-at-crossing') {
        evaluation = evaluateRedLight(observation, rule);
      } else {
        // A generic rule reads the same fields; a jurisdiction supplies its own
        // evaluators for anything more specific.
        evaluation = {
          violated: Boolean(observation?.violated),
          reason: observation?.reason || 'rule condition not met',
          confidence: isFiniteNumber(observation?.confidence) ? observation.confidence : 0,
        };
        if (evaluation.violated && evaluation.confidence < rule.confidenceThreshold) {
          evaluation = {
            violated: false,
            reason: `confidence ${evaluation.confidence.toFixed(2)} below rule threshold ${rule.confidenceThreshold}`,
            confidence: evaluation.confidence,
          };
        }
      }
      if (!evaluation.violated)
        return { created: false, violation: null, reason: evaluation.reason };

      const timestamp = at ?? clock();
      if (new Date(timestamp).getUTCFullYear() !== year)
        year = new Date(timestamp).getUTCFullYear();
      const id = `VIO-${year}-${nextId().slice(4)}`;
      const evidence = createEvidence({
        ruleId,
        detection,
        plate,
        cameraId,
        intersectionId,
        at: timestamp,
        signalState: observation?.signalState ?? null,
        frameRef,
        rule,
      });
      const penalty = calculatePenalty(rule);
      const record = Object.freeze({
        id,
        ruleId,
        ruleDescription: rule.description,
        detection: detection || null,
        plate: evidence.plate,
        cameraId,
        intersectionId,
        at: timestamp,
        signalState: observation?.signalState ?? null,
        confidence: evaluation.confidence,
        reason: evaluation.reason,
        evidence,
        penalty,
        // Always `pending`. `AUTOMATED_ENFORCEMENT_ENABLED` is false and the
        // engine has no branch that would change this, by design.
        reviewStatus: 'pending',
        automatedEnforcement: AUTOMATED_ENFORCEMENT_ENABLED,
        jurisdiction: rule.jurisdiction,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        mode: DATA_MODES.simulated,
      });
      violations.set(id, record);
      publish({
        category: 'violation',
        type: 'violation-detected',
        severity: SEVERITY.warning,
        message: `${rule.ruleId.replace(/_/g, ' ')} — ${intersectionId}`,
        mode: DATA_MODES.simulated,
        detail: {
          violationId: id,
          ruleId,
          intersectionId,
          cameraId,
          confidence: Number(evaluation.confidence.toFixed(2)),
          reviewStatus: 'pending',
          // The plate is deliberately NOT in the stream detail. The stream is
          // the map's companion; plate data belongs to the review workflow.
          plateReadable: Boolean(evidence.plate?.readable),
        },
      });
      return { created: true, violation: record, reason: evaluation.reason };
    },

    /**
     * Record a violation from a plate reading, applying the reading's own
     * confidence rules. A low-confidence plate is attached as UNREADABLE — it
     * is never guessed, and it does not block the violation.
     * @param {object} input
     * @returns {{created:boolean, violation:object|null, reason:string}}
     */
    recordWithPlate(input) {
      const plate = input.plate || null;
      const usable = plate && plate.readable && plate.confidence >= PLATE_MIN_CONFIDENCE;
      return engine.record({
        ...input,
        plate: usable ? plate : null,
      });
    },

    /** @param {string} id @returns {object|null} */
    get(id) {
      return violations.get(id) || null;
    },

    /**
     * List violations.
     * @param {object} [options]
     * @param {string} [options.reviewStatus]
     * @param {string} [options.intersectionId]
     * @param {number} [options.limit=100]
     * @param {boolean} [options.includePlate=true] - False for a role without
     *   the plate capability; the plate field is dropped, not masked.
     * @returns {object[]}
     */
    list({ reviewStatus = null, intersectionId = null, limit = 100, includePlate = true } = {}) {
      let out = [...violations.values()];
      if (reviewStatus) out = out.filter((v) => v.reviewStatus === reviewStatus);
      if (intersectionId) out = out.filter((v) => v.intersectionId === intersectionId);
      const bounded = Math.max(0, Math.floor(limit));
      out = out.slice(Math.max(0, out.length - bounded));
      return Object.freeze(
        out.map((violation) =>
          includePlate ? violation : Object.freeze({ ...violation, plate: null }),
        ),
      );
    },

    /**
     * Move a violation through the review workflow.
     *
     * A reviewer decision is the ONLY way a violation leaves `pending`, and it
     * is audited. This is the enforcement gate: there is no automated path.
     * @param {object} options
     * @param {string} options.id
     * @param {'approved'|'rejected'|'escalated'} options.status
     * @param {string} options.role
     * @param {string} [options.note]
     * @returns {{ok:boolean, reason:string|null, violation:object|null}}
     */
    review({ id, status, role, note = null } = {}) {
      const violation = violations.get(id);
      if (!violation) return { ok: false, reason: 'unknown violation', violation: null };
      if (!REVIEW_STATES.includes(status) || status === 'pending')
        return { ok: false, reason: `invalid review status: ${status}`, violation };
      const updated = Object.freeze({
        ...violation,
        reviewStatus: status,
        reviewedBy: role || null,
        reviewedAt: clock(),
        reviewNote: note,
      });
      violations.set(id, updated);
      audit?.record({
        action: `violations.${status}`,
        role,
        intersectionId: violation.intersectionId,
        outcome: 'applied',
        mode: DATA_MODES.simulated,
        reason: note || `review ${status}`,
        before: { reviewStatus: violation.reviewStatus },
        after: { reviewStatus: status },
      });
      publish({
        category: 'violation',
        type: 'violation-reviewed',
        severity: SEVERITY.notice,
        message: `${id} ${status.toUpperCase()} by ${role || 'unknown role'}`,
        mode: DATA_MODES.simulated,
        detail: { violationId: id, status, role: role || null },
      });
      return { ok: true, reason: null, violation: updated };
    },

    /**
     * Drop evidence past its retention window.
     * @returns {number} Count purged.
     */
    purgeExpired() {
      const now = clock();
      let purged = 0;
      for (const [id, violation] of violations) {
        if (!violation.evidence?.retainUntil) continue;
        if (violation.evidence.retainUntil > now) continue;
        if (violation.reviewStatus === 'pending') continue; // never purge open cases
        violations.delete(id);
        purged += 1;
      }
      return purged;
    },

    /** @returns {object} Counts by review status. */
    summary() {
      const counts = Object.fromEntries(REVIEW_STATES.map((state) => [state, 0]));
      for (const violation of violations.values()) counts[violation.reviewStatus] += 1;
      return {
        ...counts,
        total: violations.size,
        automatedEnforcement: AUTOMATED_ENFORCEMENT_ENABLED,
        mode: DATA_MODES.simulated,
      };
    },

    clear() {
      violations.clear();
    },
  };
  return Object.freeze(engine);
}

/**
 * The signal states that can support a red-light claim, for documentation and
 * for the UI's explanation of why a crossing did or did not qualify.
 * @returns {string[]}
 */
export function enforcedSignalStates() {
  return SIGNAL_STATES.filter((state) => state === 'red');
}
