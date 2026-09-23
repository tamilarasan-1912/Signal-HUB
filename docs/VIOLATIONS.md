# Violations

The rule engine, evidence records, plate confidence handling, and the review
workflow that stands between a detection and anything resembling enforcement.

## The governing principle

**The platform never issues a fine.** It detects a possible violation, captures
evidence, and opens a case for a human. Everything else — the penalty
calculation, the escalation rules — is configuration that a review workflow
*displays*, not machinery that acts.

This is enforced in three places rather than stated once in a doc:

1. Every default rule has `reviewRequired: true`.
2. The engine reports `automatedEnforcement: false`, and the API surfaces it.
3. There is a test asserting that every configured rule requires human review.

## Rules are data, not code

A traffic law is a jurisdiction's business, so it is not compiled into a model.
`DEFAULT_RULES` holds seven rule definitions, and `createRuleSet(rules)` accepts
a different set entirely.

```js
{
  ruleId: 'RED_LIGHT',
  description: 'Vehicle crossed the stop line while the signal showed red',
  requiredEvidence: ['frame', 'timestamp', 'signalState', 'stopLineCrossing'],
  detectionMethod: 'signal-state-at-crossing',
  confidenceThreshold: 0.85,
  jurisdiction: 'default',
  reviewRequired: true,
  penalty: {
    penaltyAmount: 1000,
    currency: 'INR',
    effectiveFrom: '2026-01-01',
    escalationRules: ['repeat within 12 months escalates'],
    reviewRequired: true,
  },
}
```

`requiredEvidence` is the important field. It is the list of things that must be
present for the rule to fire at all — a red-light violation is not a violation
unless the signal state **at the moment of crossing** was captured. Making that
explicit means the rule cannot fire on a detection alone.

`createRuleSet` validates on load rather than at first use: a missing
`description`, an empty `requiredEvidence`, a threshold outside `(0, 1]`, a
missing `detectionMethod` or `jurisdiction`, or a duplicate `ruleId` all throw
immediately. A misconfigured rule is a startup failure, not a silently weaker
check at 3am.

### The default rule set

| `ruleId` | Detection method | Threshold |
| --- | --- | --- |
| `RED_LIGHT` | `signal-state-at-crossing` | 0.85 |
| `STOP_LINE` | `stop-line-position` | 0.85 |
| `ILLEGAL_TURN` | `trajectory-vs-permitted-movement` | 0.8 |
| `WRONG_WAY` | `heading-vs-road-direction` | 0.85 |
| `LANE_VIOLATION` | `lane-membership` | 0.75 |
| `SPEED` | `speed-vs-limit` | 0.9 |
| `HELMET` | `rider-head-region` | 0.8 |

These are illustrative defaults. The penalty amounts are placeholders and the UI
labels them accordingly (see [Penalties](#penalties)).

## The red-light pipeline

The full sequence, with what is real and what is simulated at each step:

```text
1. Camera observes a vehicle                        simulated frame
2. A detection is produced                          simulated detector
3. The tracker assigns a stable trackId             real logic
4. The vehicle crosses the stop line                simulated position
5. The signal state at that instant is read         real controller state
6. The rule evaluates: state RED + crossing +        real rule evaluation
   confidence ≥ threshold
7. Evidence is assembled                            real construction
8. A violation record is created                    real
9. Plate read is attempted                          simulated adapter
10. The case opens as PENDING REVIEW                real, and not bypassable
```

Steps 3, 5, 6, 7, 8 and 10 are real computation. The value of the prototype is
that this half works and is tested; swapping in real frames and a real model
makes the other half real without touching this half.

### What the record holds

```text
Violation ID:         VIO-2026-000123
Rule:                 RED_LIGHT
Vehicle:              Detected vehicle (track TRK-00042)
Plate:                TN XXXX XXXX        ← capability-gated
Plate confidence:     0.96
Intersection:         INT-021
Camera:               CAM-021
Timestamp:            2026-09-23 14:42:17
Signal state:         RED
Evidence:             frame reference, stop-line crossing position
Detection confidence: 0.94
Review status:        PENDING
```

The signal state is recorded as a value in the record rather than looked up
later. A record that said "the signal was red" without storing what the signal
actually reported at that instant would not be evidence of anything.

## Plate confidence

Plate handling is where an enforcement system is most likely to do real harm, so
it is the most defensive part of the codebase. The full mechanics are in
[VISION.md](VISION.md); the enforcement-relevant rules are:

- **A plate is never invented.** A character below its confidence floor becomes
  `?`, and a single `?` makes the entire result unreadable. The record stores
  `null` and the UI shows `PLATE UNREADABLE`.
- **Low confidence is a first-class outcome**, not an error to be swallowed. The
  violation still exists — a violation does not require a plate — but the plate
  field is empty and the reason is visible.
- **No characters are fabricated for display.** `TN1?76` is never shown, because
  an operator would read it as `TN1076` and the platform would have invented the
  character that identifies a person's vehicle.

### Plate is capability-gated, everywhere

Plate text is gated by the `violations:plate` capability:

- `GET /api/violations` strips the plate for a caller without it and reports
  `plateVisible: false`.
- `GET /api/violations/:id` does the same.
- `POST /api/enforcement/plate` requires the capability outright.
- **Plate text is never rendered on the map.** Not at any zoom, not in any mode.

There are tests for each: a traffic controller is refused the plate endpoint, an
operator's violation list contains `plate: null`, and an enforcement reviewer
sees it.

## Evidence

Every violation carries an evidence record:

```js
{
  violationId,
  ruleId,
  cameraId,
  intersectionId,
  at,                      // timestamp
  signalState,             // 'red' — captured at the moment of crossing
  trackId,                 // ties the detection to the plate read
  evidence: {
    frameRef,              // a reference, not the frame bytes
    stopLineCrossing,      // position relative to the stop line
    detectionConfidence,
    plateResult,           // full plate result including confidence
    retainUntil,           // when this evidence may be purged
  },
  reviewStatus: 'pending',
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  mode: 'simulated',
}
```

Evidence stores a **frame reference** rather than image bytes. The record stays
small, and the retention policy has something to act on.

### Audit trail

Creating a violation, reading a plate, and reviewing a case all publish events,
so the audit log contains the whole chain with its actor:

```js
audit.record({
  action: `violations.${status}`,
  role,                    // who decided
  intersectionId,
  outcome: 'applied',
  mode: DATA_MODES.simulated,
  reason: note || `review ${status}`,
  before: { reviewStatus: 'pending' },
  after:  { reviewStatus: 'approved' },
})
```

`before`/`after` rather than just the new value: an audit entry that records only
the outcome cannot show whether the change was what was intended.

## The review workflow

```text
        ┌─────────┐
        │ PENDING │  ← every violation starts here
        └────┬────┘
             │
     ┌───────┼───────────┐
     ▼       ▼           ▼
┌──────────┐ ┌──────────┐ ┌───────────┐
│ APPROVED │ │ REJECTED │ │ ESCALATED │
└──────────┘ └──────────┘ └───────────┘
```

`REVIEW_STATES` is `['pending', 'approved', 'rejected', 'escalated']`. `pending`
cannot be set as a decision — a reviewer cannot return a case to the queue by
"deciding" pending, which would erase the fact that they had looked at it.

### The decision vocabulary

The API accepts operator-facing words and maps them to record states:

| Decision | State |
| --- | --- |
| `approve`, `approved`, `accept` | `approved` |
| `reject`, `rejected`, `decline` | `rejected` |
| `escalate`, `escalated` | `escalated` |

An unrecognised decision is a `400` with the supported list, and **the record is
not touched**. A refused decision is not a partial write. There is a test for
exactly that.

This mapping exists because it was a bug when it did not. The API once passed
`decision: 'approved'` to an engine expecting `status:`, so every review request
returned `400` — the entire review workflow was unreachable through the API while
the domain itself was fine. The server tests now cover the review path end to
end, because a unit test on the engine would not have caught it.

### Reviewing

```bash
curl -X POST http://127.0.0.1:12001/api/violations/VIO-2026-000123/review \
  -H "authorization: Bearer $ENFORCEMENT_TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"approve","note":"Signal state and crossing both confirmed."}'
```

Requires `violations:review`. Records the reviewer, the timestamp and the note.

A reviewer may reverse an earlier decision — reality includes mistakes — and each
change is a separate audit entry, so the reversal is visible rather than
overwriting the original.

## Penalties

The penalty engine **calculates** a configured amount. It does not charge
anyone.

```js
{
  ruleId,
  jurisdiction,
  effectiveFrom,
  penaltyAmount,
  currency,
  escalationRules,
  reviewRequired,
}
```

`calculatePenalty(rule, { priorOffences })` returns the configured figure **and a
warning**, and the signature makes dropping the warning awkward rather than
natural:

```js
{
  amount: 1000,               // null when nothing is configured
  currency: 'INR',
  escalationApplied: false,
  reviewRequired: true,
  disclaimer: 'Configured penalty — verify against current jurisdiction rules before any notice is issued.',
}
```

When escalation rules are configured and there are prior offences, the multiplier
is `min(3, 1 + priorOffences * 0.5)` and `escalationApplied` is set, so the
increase is visible rather than silently folded into the amount.

`effectiveFrom` is stored on the penalty configuration so an amount that changed
on a date can be applied to the right violations; a real integration would
resolve it per violation date.

The UI always displays the amount with the disclaimer:

```text
RED LIGHT VIOLATION
Configured penalty: ₹1000
Configured penalty — verify against current jurisdiction rules.
```

The caveat is not decoration. A hardcoded fine amount displayed without it is a
statement about the law that the platform is not entitled to make, and the
placeholder amounts in `DEFAULT_RULES` are not real law anywhere.

For a production system, the enforcement outcome would integrate with an
authorized government system. The prototype does not, and says so.

## Retention

- Every evidence record carries `retainUntil`.
- `purgeExpired()` drops evidence past its window.
- **Open cases are never purged**: a `pending` case survives regardless of age,
  because silently deleting an unreviewed accusation is worse than keeping it.

## Privacy

Vehicle and plate processing exists only for this workflow, and only behind the
plate capability. Specifically:

- No face recognition, no person detection, no named-person search.
- No plate exposure on the map or in any unauthenticated view.
- No persistent vehicle identity — tracking is scene-local and short-lived
  (see [VISION.md](VISION.md)).
- Plate data is returned only to a caller holding `violations:plate`.

## API reference

| Route | Capability | Purpose |
| --- | --- | --- |
| `GET /api/violations` | `violations:view` | list; plate stripped without `violations:plate` |
| `GET /api/violations/:id` | `violations:view` | one record; plate gated the same way |
| `POST /api/violations/:id/review` | `violations:review` | record a decision |
| `GET /api/enforcement/rules` | `violations:view` | the configured rule set, including penalties |
| `POST /api/enforcement/plate` | `violations:plate` | run the ANPR adapter |

## Testing

- Rule validation rejects a malformed rule at load, including a duplicate ID.
- Every default rule has `reviewRequired: true`.
- `automatedEnforcement` is `false` and surfaced by the API.
- A red-light violation requires the signal state to have been red at crossing.
- A low-confidence plate yields `null` text rather than guessed characters.
- The plate is stripped from the list for a caller without the capability.
- An unrecognised review decision is refused and leaves the record untouched.
- Reviewing records the reviewer, the timestamp, and an audit entry.
- Reviewing an unknown violation is a `404`.
- A decision can be reversed, with both decisions audited.
- The full demo leaves at least one violation pending review.

## See also

- [VISION.md](VISION.md) — plate confidence mechanics in detail
- [SECURITY.md](SECURITY.md) — roles, capabilities, retention, privacy policy
- [SIMULATION.md](SIMULATION.md) — the violation scenario
