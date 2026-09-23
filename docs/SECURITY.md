# Security and Privacy

Authentication, authorization, secrets, audit, retention, and the privacy
boundaries this platform is built to respect.

## Threat model, briefly

This platform handles traffic-camera metadata, enforcement records and control
commands. The realistic threats, in rough order of severity:

| Threat | Consequence | Mitigation |
| --- | --- | --- |
| Unauthorized control action | a simulated preemption someone should not have made; with hardware, a real one | server-side capability checks on every mutating route |
| Plate data exposure | a privacy harm, and potentially a legal one | plate data gated behind a separate capability; never on the map |
| Secret leakage | a paid provider key used by a third party | keys read server-side only; never serialized |
| Audit tampering | a consequential action with no trace | the audit log is written by the server process, never by a client |
| Evidence over-retention | data kept beyond what is defensible | bounded retention; open cases preserved |
| Prototype credentials in production | total compromise | a boot-time guard that refuses to start |

## Authentication

`server/auth.mjs` implements a session authority. It issues a **signed opaque
token** for a named operator:

```js
createSessionAuthority({ secret, now })
  .login(handle, password)   → { ok, token, session } | { ok: false, reason }
  .resolve(token)            → session (falls back to anonymous viewer)
  .can(session, capability)  → boolean
  .listRoles()               → the role/capability matrix, for the UI
```

The token is a signed payload (`base64url(body).base64url(hmac)`), verified with
`createHmac('sha256', secret)`. `verify` returns `null` for anything malformed,
mis-signed or expired and **never throws** — a bad token is a `401`, not a `500`.

### Unauthenticated callers

An anonymous request resolves to a **viewer** session, not to an error. That is
deliberate: the read-only views should work for a local demonstration without a
sign-in. It is safe because authorization is by capability, and the viewer
capability set contains only reads.

### The prototype credentials

Five accounts, for local demonstration:

| Handle | Password | Role |
| --- | --- | --- |
| `viewer` | `viewer` | `viewer` |
| `operator` | `operator` | `operator` |
| `control` | `control` | `traffic-control` |
| `enforcement` | `enforcement` | `enforcement-review` |
| `admin` | `admin` | `administrator` |

Password comparison is length-checked and `timingSafeEqual`-based even for demo
accounts, so the prototype does not set a bad example for whoever copies this
code.

## Authorization

Authorization is **capability-based and server-side**. The matrix lives in
`src/traffic-control/policy.js`:

| Capability | viewer | operator | traffic-control | enforcement-review | administrator |
| --- | :-: | :-: | :-: | :-: | :-: |
| `city:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `traffic:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `simulation:run` | | ✓ | ✓ | | ✓ |
| `violations:view` | | ✓ | | ✓ | ✓ |
| `signals:control` | | | ✓ | | ✓ |
| `signals:preempt` | | | ✓ | | ✓ |
| `violations:review` | | | | ✓ | ✓ |
| `violations:plate` | | | | ✓ | ✓ |
| `audit:read` | | | | | ✓ |

Three design points:

**Plate access is separate from violation access.** An operator can see that a
violation exists without seeing whose vehicle it was. Reviewing plates is a
distinct duty and a distinct capability.

**Preemption is separate from signal control.** An operator with ordinary signal
control does not automatically hold emergency preemption authority.

**Audit reads are administrator-only.** The audit log names operators and their
decisions; reading it is itself privileged.

### Enforcement is in the route table, not the UI

Every mutating route names a capability:

```js
{ method: 'POST', pattern: /^\/api\/simulation\/start$/, capability: CAPABILITIES.runSimulation, handler }
```

The UI hides what you cannot do, but **hiding is cosmetic**. The route table
enforces regardless, which is what stops a direct API call bypassing the UI. The
server test suite asserts the refusals per role:

- An anonymous caller is refused `POST /api/simulation/start`.
- A viewer is refused simulation, optimization, emergency, plate and audit.
- A traffic controller is refused the audit log **and** plate reads, despite
  holding signal control.
- A caller without `violations:plate` sees `plate: null` in the violation list.
- A missing capability is a `403`, never a silent empty success.

That last one matters: returning an empty list for an unauthorized request would
be indistinguishable from "there are no violations", which is a security bug
wearing a usability costume.

## Secrets

**No secret appears in client code, and none is serialized into a response.**

| Secret | Read where | Exposed to the client as |
| --- | --- | --- |
| `TOMTOM_API_KEY` | `server/index.mjs` | `liveTrafficProvider: true/false` |
| `CESIUM_ION_TOKEN` | `server/index.mjs` | `cesiumIonToken: true/false` |
| `SIGNAL_HUB_SESSION_SECRET` | `server/index.mjs` | never |
| `SIGNAL_HUB_*` config | `server/index.mjs` | selected non-sensitive values |

The client only ever requests `/api/*` on its own origin. There is no code path
by which a key could reach a bundle: the API layer returns booleans describing
*which mode is active*, never the credential itself.

`SIGNAL_HUB_SESSION_SECRET` defaults to a random 32-byte value per process. That
is fine locally — tokens do not survive a restart, which is a feature for a demo
— and the production guard requires it to be set explicitly.

## The production guard

`assertProductionConfig(env)` refuses to boot in production with an insecure
configuration:

```js
// SIGNAL_HUB_ENV=production
if (!env.SIGNAL_HUB_SESSION_SECRET) {
  problems.push('SIGNAL_HUB_SESSION_SECRET must be set in production (prototype demo accounts are otherwise active)');
}
if (String(env.SIGNAL_HUB_ALLOW_DEMO_ACCOUNTS).toLowerCase() === 'true') {
  problems.push('SIGNAL_HUB_ALLOW_DEMO_ACCOUNTS must not be enabled in production');
}
```

The point is that insecure demo defaults **cannot silently follow the code into a
real environment**. The process reports the problem and exits rather than starting
with credentials everyone can read from the repository.

## Audit

Every consequential action is audited:

```js
audit.record({
  action: 'violations.approved',
  role,                    // which role acted
  intersectionId,
  outcome: 'applied',
  mode: DATA_MODES.simulated,
  reason,
  before: { reviewStatus: 'pending' },
  after:  { reviewStatus: 'approved' },
})
```

Properties that make it an audit trail rather than a log:

- **Written by the server process.** A client cannot write, forge, drop or
  reorder an entry, because the client never writes one.
- **`before`/`after`.** An entry recording only the outcome cannot show whether
  the change was intended.
- **Actor and role.** "Something changed" is not accountability.
- **Fed by the same event bus that feeds the UI.** The timeline and the audit
  log cannot disagree, because they read the same stream. A separate audit call
  at each mutation site would drift the moment one site forgot it.
- **Mirrored to a store** via `mirrorEngineRecords`, also by subscription.

`GET /api/audit` requires `audit:read`.

## Rate limiting

A per-session request budget (`RATE_LIMIT` = 60 requests per 1000 ms window)
bounds a session's request rate. The event stream is fed from the engine's own
bus rather than polled, so live updates do not consume the budget.

## Input handling

- **Body size is bounded** (`MAX_BODY_BYTES` = 256 KB) so a malformed request
  cannot exhaust memory.
- **Numeric input is validated, not coerced.** Plate `quality` goes through
  `clamp01`, so a non-numeric value becomes `0` rather than `NaN` leaking into a
  confidence.
- **Enumerated input is checked against the domain's own vocabulary.** Review
  decisions are mapped through a table built from the engine's `REVIEW_STATES`,
  and the mapping is validated at module load — a decision that mapped to a state
  the engine does not know would be a startup failure, not a `400` for every
  reviewer.
- **Unknown routes are `404`**, and a route whose domain validation fails returns
  `400` with a reason rather than a generic error.

## Privacy

This is the section with the least room for interpretation.

### What the platform does not do

- **No face recognition.** No face model is loaded, and no adapter interface
  accepts a face.
- **No person detection.** `vehicleClass` has no person category.
- **No person tracking.** Tracking is scene-local and short-lived
  (`TRACK_TTL_MS` = 2.5 s), with no cross-camera identity. A vehicle that leaves
  and returns is a new track, so no movement history accumulates.
- **No named-person search.** There is no entity a name could attach to.
- **No general plate exposure.** Plates are not rendered on the map at any zoom,
  in any mode, for any role.

These are architectural, not policy statements that could be flipped by a
configuration change. Adding face recognition would require new adapter
interfaces, a new data model and a new capability — not a flag.

### Plate handling

Plate processing exists **only** for the authorized enforcement workflow:

- Gated behind `violations:plate`, a capability separate from violation viewing.
- Stripped from the list and detail responses for callers without it
  (`plateVisible: false`).
- Never displayed on the map.
- Never invented: a character below its confidence floor becomes `?`, and one `?`
  makes the whole plate unreadable (see [VISION.md](VISION.md)).

The reason the refusal matters is that a wrong plate is worse than a missing one.
A missing plate means "review manually"; a wrong plate names someone who was not
there.

## Retention

- Every evidence record carries `retainUntil`.
- `purgeExpired()` drops evidence past its window.
- **Open cases are never purged.** A `pending` case survives regardless of age,
  because silently deleting an unreviewed accusation is worse than keeping it.
- The retention window is configuration, so a jurisdiction can set it without a
  code change.

A production deployment would add: encrypted storage, access logging on evidence
reads, and a documented deletion procedure that reaches backups. None of those
exist here, and the prototype does not claim they do.

## Enforcement safeguards

Stated together, because they are the platform's central safety property:

1. **Every default rule has `reviewRequired: true`.**
2. **The engine reports `automatedEnforcement: false`**, surfaced in the API.
3. **Every violation opens as `PENDING`.**
4. **Penalties are calculated, never charged**, and always displayed with
   "Configured penalty — verify against current jurisdiction rules before any
   notice is issued."
5. **An unrecognised decision changes nothing** — a refused decision is not a
   partial write.

The prototype does not issue a legally binding fine, and there is no code path
that could without an authorized government integration and a legal workflow.

## Control safety

- **No hardware integration exists.** `describeController` returns
  `authorized: false`, and the field exists so a false claim would be visible.
- **Conflicting greens are refused at the domain level.** A crossing-axis green
  is routed through amber and all-red rather than applied.
- **The clearance intervals are constants**, not tunables — `ALL_RED_MS` is the
  interval during which nothing moves and the box clears.
- **Recommendations do not auto-apply.** Applying requires an explicit `apply`
  flag or an operator click.
- **Preemption requires a separate capability** and an audit entry.

See [TRAFFIC-CONTROL.md](TRAFFIC-CONTROL.md) and
[EMERGENCY-CORRIDOR.md](EMERGENCY-CORRIDOR.md).

## What a production deployment needs

Not implemented here, and listed so nobody assumes otherwise:

1. **An identity provider.** The demo accounts are not a user directory, and
   there is no password policy, MFA, lockout or rotation.
2. **A real session secret** from a secret manager, and rotation.
3. **HTTPS terminated in front.** The API is plain HTTP; TLS is a deployment
   concern, and nothing here enforces it.
4. **Encrypted evidence storage** and access logging on reads.
5. **A documented retention and deletion procedure** that reaches backups.
6. **A legal basis for camera and plate processing** in each jurisdiction.
7. **Rate limiting at the edge**, beyond the per-session in-process budget.
8. **A hardware control capability** separate from `signals:control`, with
   explicit operator confirmation and an audit entry per action.

## Reporting

This is a prototype. If you find a security issue in it, the useful thing is to
report it rather than to demonstrate it — it is not running anywhere that matters,
and the fix is more valuable than the proof.

## See also

- [VIOLATIONS.md](VIOLATIONS.md) — the enforcement workflow and its safeguards
- [DATA-SOURCES.md](DATA-SOURCES.md) — key handling per source
- [TRAFFIC-CONTROL.md](TRAFFIC-CONTROL.md) — control safety
