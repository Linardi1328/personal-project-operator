# War Room multi-provider collaboration contract (RIC-181, offline slice 1, revision 2)

Status: offline contract, deterministic simulation and tests only. This slice grants no
execution authority. It does not dispatch Claude Code, Codex or Antigravity, does not
enroll hosts, does not read or write canonical PPO run records, and does not change
RIC-157, RIC-177, RIC-158, RIC-59 or RIC-61 holds. Every output is explicitly
non-authorizing.

Baseline: `main` at `3152378d9523455fdb31249109029db7eab34821`.

Revision 3 is a targeted correction to the finding ledger only (review item P2-03: finding identity and disposition
consistency across successive reviews). Nothing else in the revision 2 architecture changed.

Revision 2 responds to the independent review (REQUEST CHANGES on revision 1, combined hash
`ed58d69b…aa694`): finding accountability for mixed-area reviews, and a reassessment that separates
reusable contracts from disposable simulation fixtures. See section 2.2 for the before-and-after inventory.

## 1. What this proves and what it does not

It shows that the existing software factory vocabulary can express a safe handoff between
a backend worker, a frontend worker, deterministic tests, an independent reviewer and the
owner, with fake adapters only. It does not show that any real provider can be driven
safely. See section 8 for the compatibility unknowns and section 9 for prerequisites.

## 2. Reuse of existing architecture

No competing orchestrator, state store, queue, dashboard or service was added. No existing file was
modified. The candidate has two layers with a one-way dependency.

**Reusable contract layer** (pure functions, no state, no lifecycle; what a future real coordinator would call):

- `software-factory-collaboration-contract.mjs` — envelope, trusted registry, approved scope, workspace guard, task-owned cleanup verifier.
- `software-factory-collaboration-routing.mjs` — provider-aware role routing.
- `software-factory-collaboration-handoff-rules.mjs` — run-context checks, finding accountability ledger, owner approval binding.

Its direct imports are `node:crypto` and the control-plane capacity vocabulary only. A test pins the exact import
list of each file and forbids imports of run state, hardening, release, admission, plan contract, the autonomous
runner, dispatch checkpoint, and any simulation file.

**Test-only simulation layer** (disposable fixtures; never imported by anything except collaboration tests):

- `software-factory-collaboration-simulation-model.mjs` — in-memory run model (renamed from `coordinator`; every file header says TEST-ONLY).
- `software-factory-collaboration-simulation.mjs` — fake adapters, synthetic fixtures, scenarios, and the harness that drives the **existing** autonomous runner.

### 2.1 Existing PPO components, reassessed

| Existing component | Decision | What changed or why it could not be reused |
| --- | --- | --- |
| `software-factory-autonomous-run.mjs` | **Reused directly.** The simulation constructs `createSoftwareFactoryAutonomousRunner` with all four injectable dependencies (`listRuns`, `readRun`, `continueRun`, `buildReleasePackage`) replaced by in-memory fakes. | The v1 stepping loop, step guard, checkpoint handling and release stop were re-implemented in the simulation. They are gone. The runner's catalog gate, stale-state retry, no-progress detection, 16-step limit and `merge_ready` release stop now apply unchanged. The default runner, which reads canonical state, is never constructed (static test). |
| `software-factory-dispatch-checkpoint.mjs` | **Not reusable as-is; mirrored in the test-only model.** | It is file-backed and async and keyed by `SOFTWARE_FACTORY_WORKERS`, which has no Claude worker. Using it needs a worker-catalog change, which is outside this slice. The model's in-memory checkpoint and trusted capacity observation are explicit stand-ins. The capacity vocabulary and outcome names (`blocked_capacity`, `blocked_external`, `owner_action_required`) are reused so results surface as the runner's own outcomes. |
| `development-hardening-orchestrator.mjs` | **Constant reused; loop not duplicated in the reusable layer.** | `MAX_HARDENING_ROUNDS` (3) bounds corrections. The orchestrator's review-to-correction loop is bound to canonical run evidence and a Codex-only adapter, so the model keeps a minimal stand-in. |
| `software-factory-release-package.mjs` | **Authority block and head-SHA binding mirrored; builder not called.** | The real builder requires a canonical `merge_ready` run with PR delivery and CI facts that this slice does not have. The simulated package is test-only and additionally lists the finding accounting. |
| `software-factory-release-approval.mjs` | **TTL constant reused. Binding rule extracted as a pure function.** | The real approval flow is a file-backed request and confirm store. The exact-package, head and scope binding is now `assessOwnerReleaseApproval` in the reusable layer, with no store. |
| `development-run-state.mjs` | **Transition table reused (read-only).** | The model uses `ALLOWED_DEVELOPMENT_RUN_TRANSITIONS` so it cannot invent a lifecycle. No canonical read or write function is imported. |
| `software-factory-admission.mjs` | **Reused directly.** | `assessSoftwareFactoryAdmission` enforces the catalog trust check and WIP limits. |
| `software-factory-plan-contract.mjs`, `software-factory-control-plane.mjs`, `software-factory-antigravity-execution.mjs` | **Reused as before.** | Plan validation, capacity vocabulary, and the unchanged backend-ownership refusal. |
| `software-factory-remote-contract.mjs` | **Conventions mirrored.** | Its kinds are execution transport kinds, so collaboration messages remain a separate contract. |

### 2.2 Before and after

| | Revision 1 | Revision 2 |
| --- | --- | --- |
| Lifecycle code | one 856-line `coordinator` module, plus a hand-written stepping loop in the simulation | 871-line test-only run model (`simulation-model`); the stepping loop is deleted and the existing autonomous runner drives it |
| Run-context checks (project, run, version, plan, scope, base, assignment, step, type) | inside the coordinator | `assessCollaborationEnvelopeContext` in the reusable rules module |
| Candidate, contract-evidence and reviewer-independence checks | inside the coordinator | reusable rules module |
| Finding handling | first area's findings only; others dropped | accountability ledger; every finding is open, addressed, resolved or noted |
| Owner approval binding | inside the coordinator | reusable pure function; the model only records the result |
| Envelope schema | version 1 | version 2, adds `resolvedFindings` |
| Simulation driver | hand-written loop | existing `createSoftwareFactoryAutonomousRunner` with injected fakes |
| Naming | "coordinator" | "simulation run model", header TEST-ONLY |

Size, stated plainly: the run model did not shrink (856 to 871 lines). Roughly 90 lines of rules moved out to the reusable
layer, and about the same amount of new logic for finding accountability was added to it. The reduction is in
responsibility, not line count: the loop, step guard and release stop are no longer re-implemented, and every
remaining lifecycle line is fenced into a file that is test-only by name, header and import direction. Total candidate
size grew from 4,320 to about 5,200 lines, mostly new tests and the finding ledger.

Retained complexity, and why: the run model still contains an in-memory run, assignment issuance, checkpoint
entry, workspace quarantine, hash-chained event log, release package assembly and simulated owner decision. Each
exists only to give a required safety test something to run against (ordering, writer discipline, quarantine,
append-only evidence, exact-candidate approval, contract reconciliation, budget exhaustion). None can be promoted:
it is unreachable from any non-test module, names itself TEST-ONLY, and a static test enforces that direction.

New files under `local-operator/`, plus this document. Test files: `-contract`, `-routing`, `-handoff-rules`, `-adversarial`, `-simulation` (`*.test.mjs`), discovered by the existing regression gates with no runner change.

## 3. Collaboration contract

Contract id `software-factory-collaboration-handoff-v2`, schema version 2 (revision 1 was version 1). Messages are
untrusted data. They are never commands and never authorization.

### 3.1 Envelope fields (exactly these, no others)

`schemaVersion`, `messageType`, `projectId`, `runId`, `expectedRunVersion`, `stepId`,
`attemptNumber`, `correlationId`, `idempotencyKey`, `sender {role, providerId}`,
`recipient {role, providerId}`, `planHash`, `scopeDigest`, `baseSha`, `candidateSha`,
`contractDigest`, `evidence[]`, `findings[]`, `resolvedFindings[]`, `reviewDecision`, `reasonCode`,
`requestedAction`, `summary`.

- `idempotencyKey` is derived (SHA-256) from project, run, step, attempt, type, sender,
  recipient, base and candidate. A sender cannot choose it, and edits to the summary or
  evidence do not change it, so a replay with altered content is a conflict, not a new message.
- `evidence[]` entries are `{kind, ref, digest, sizeBytes, candidateSha}`. `ref` is an opaque
  id (`[a-z0-9][a-z0-9_-]{0,63}`) that PPO resolves from its own store. It cannot be a path.
  At most 8 refs, 64 KiB each, 256 KiB total. Evidence bound to a different candidate SHA is rejected.
- `resolvedFindings[]` lists finding codes a reviewer says are now fixed. It is valid only on `review_finding`, at most 5 codes, unique, and disjoint from `findings[]`. It is a claim; the finding ledger (section 3.5) decides whether it is eligible.
- `requestedAction` is a closed vocabulary label, not text.
- `summary` is at most 200 characters of inert text. It is rejected, not sanitized, if it
  contains control characters, secrets, command syntax, paths or URLs, or instruction-like or
  authority-claiming phrases. File references belong in evidence refs, not prose.
- The whole envelope is at most 8192 bytes. Input must be plain JSON data (no accessors,
  prototypes, sparse arrays or shared references) and is snapshotted before validation.

### 3.2 Message types and legal routes

Agents speak only to PPO. PPO relays. There are no agent-to-agent channels.

| Type | Sender → recipient | Requires |
| --- | --- | --- |
| `contract_ready` | backend → PPO; PPO → frontend (relay) | candidate SHA, contract digest, `contract` evidence |
| `implementation_ready` | backend or frontend → PPO | candidate SHA, contract digest, `implementation` evidence |
| `review_finding` | reviewer → PPO | candidate SHA, explicit `approved`/`changes_requested`, `review` evidence. Approving cannot carry P0/P1. A change request needs at least one finding |
| `correction_requested` | PPO → backend or frontend | candidate SHA, findings in the recipient's own area, `review` or `test` evidence |
| `provider_unavailable` | agent → PPO; PPO → owner | reviewed reason code, `provider_status` evidence |
| `task_blocked` | agent → PPO; PPO → owner | reviewed reason code |
| `owner_decision_required` | PPO → owner | reviewed reason code |
| `release_package_ready` | PPO → owner | candidate SHA, contract digest, `release_package`, `test` and `review` evidence |

### 3.3 Trusted registry

`createTrustedCollaborationRegistry` is the only way to obtain a registry the validators
accept (a brand check rejects look-alikes). Default registry:

- `ppo`: coordinator. `owner`: owner (receives only).
- `codex`: backend implementer, independent reviewer (established).
- `claude`: backend implementer, independent reviewer, **status `evaluation`**. Each role must be
  listed in `trialApprovedRoles` by the owner before routing will use it. Claude is not promoted.
- `antigravity`: frontend implementer only.
- Construction rejects any provider holding both backend and frontend implementation
  assignments, any non-PPO coordinator, unbacked assignments and unknown keys.

### 3.4 Approved scope

An existing structured plan classifies mixed work as `debugging` (ownership unresolved), and
that stays true. The owner-approved decomposition (`buildCollaborationScope`) splits it into
single-role steps `backend`, `frontend`, `review` bound to the plan hash. Its digest is carried
in every message. Extending the plan contract to express the decomposition natively is a later slice.

### 3.5 Handoff rules and finding accountability

`assessCollaborationEnvelopeContext` (reusable, pure) checks, in a fixed order: project → run → correlation →
checkpoint state → exact run version → plan hash → scope digest → base SHA → an assignment exists → sender is the
assigned provider and role for this step and attempt → message type is the expected one (or a status message from
the assigned sender). Before it, the caller has validated the schema and registry identity, matched the claimed
sender to the transport-authenticated one, and handled duplicates and idempotency conflicts. Type-specific rules
follow: a candidate SHA must be new, contract evidence must match the declared digest, a frontend may not build on
another contract, a backend contract change needs matching contract evidence, and a reviewer may not have
implemented the candidate. Every rejection in the test-only model is preserved as an append-only `message_rejected`
event holding only the fixed code, never the rejected content. Events are hash-chained and a verifier detects
tampering, deletion and reordering.

**Finding accountability.** Every finding a reviewer raises stays on the ledger until the independent reviewer
explicitly resolves it:

- `open` → `addressed` when an implementation for that finding's area is accepted.
- `addressed` → `resolved` only when a later review names the code in `resolvedFindings`.
- `noted` is a non-blocking P2/P3 remark made on an approving review.
- A review cannot resolve an unknown code (`COLLAB_FINDING_UNKNOWN`), cannot resolve a finding whose area was never corrected (`COLLAB_FINDING_NOT_ADDRESSED`), and cannot approve while any finding is open or addressed (`COLLAB_FINDINGS_UNRESOLVED`). An approving review cannot re-raise an unresolved finding.
- A changes-requested review that stays silent about an addressed finding leaves it pending, not closed. A re-raised finding reopens with its history.
- With mixed backend and frontend findings, the backend (contract owner) is corrected first, then the frontend, and only then do tests and re-review run. Each correction spends one round of the bounded budget, so mixed findings can exhaust it. Exhaustion escalates to the owner with the unaddressed finding still on record. The release package lists the final status of every finding and cannot be prepared with any unresolved one.

Identity and disposition consistency across reviews:

- A finding code has one area for the whole run. Reusing a code for the other area is rejected (`COLLAB_FINDING_AREA_CONFLICT`); ownership is never transferred and the ledger is left unchanged.
- An approving review may add only notes with fresh codes. Reusing any existing code, including a resolved or noted one, is rejected, so a resolved finding's area, severity, addressed SHA and resolution SHA cannot be overwritten.
- Reopening a finding in the same area (a changes-requested review that raises its code again) appends its previous disposition to the entry's `history` instead of erasing it, and the finding must be addressed and resolved again.
- A review is validated in full before any entry changes, so a rejected review never leaves a partially updated ledger.

These are rules over untrusted model claims. The ledger, not the reviewer's statement, decides eligibility.

### 3.6 Routing policy

`routeCollaborationStep` is a pure decision. It never starts a provider or grants anything.

- Backend: `codex` first; `claude` only if listed and owner-approved for that role. Frontend: `antigravity` only, no fallback.
- Independent review excludes every provider that implemented any part of the candidate. If none remains, the result is a checkpoint (`NO_ELIGIBLE_REVIEWER`). The review is never bypassed.
- Capacity states map to outcomes: available/degraded → ready; exhausted/rate_limited → `blocked_capacity` (retryable); unavailable → `blocked_external` (retryable); unknown or no observation → `blocked_external` (not retryable).
- A `paid_api` or `unknown` billing path, an unconfigured integration, or an unapproved trial role makes a provider ineligible. Unavailability never adds permissions, spend or a different role.
- `debugging` (mixed or unresolved) and any capability that does not match the role go to the owner. Frontend steps can never be filled for a backend capability, or the reverse.
- An agent's own "I am unavailable" claim can only restrict later routing. Only a trusted observation restores capacity. After a mid-step stop, the workspace is reused only if trusted inspection shows the exact previous head and a clean tree; otherwise it is quarantined for the owner.
- Timeout or ambiguous completion is never success, is never retried, and quarantines the workspace.
- After 3 corrections the run checkpoints for an owner decision.
- A changed API contract is not adopted. The run checkpoints until the owner reconciles it against the exact proposed digest.

### 3.7 Owner escalation

Owner action is required for: scope or architecture exceptions, security exceptions, budget,
sensitive data, ambiguous execution, an exhausted correction budget, unresolved P0/P1, a
changed contract, no eligible provider or reviewer, and every release decision. A model
approval is never an authorization; the simulated owner decision is bound to the exact package
hash, head SHA and scope digest, expires after the existing release-approval TTL, and performs no merge.

## 4. Operational safety rules for future adapters

- A future adapter must record the task-owned PID plus start token, port and workspace path it created, and may clean up only those. `verifyTaskOwnedCleanupTarget` shows the intended shape: the target has no field for process name, pattern or signal, so name matching is structurally impossible, and a match is eligibility only, never authorization.
- Machine-wide `pkill`, `killall` or broad process matching is not a normal cleanup mechanism. A test confirms these strings occur only inside the message rejection pattern.
- Every destructive operation needs verified ownership and separate explicit authorization.
- Failed attempts and rejections are preserved. Nothing is deleted or rewritten to hide a failure.
- One writer per workspace. Readers (reviewers) are refused while a writer is active.

## 5. Simulation

Run: `node --test local-operator/software-factory-collaboration-simulation.test.mjs`

The stepping loop is the existing autonomous runner (`createSoftwareFactoryAutonomousRunner`) with all four
dependencies injected as fakes. Each continuation is one handoff, one test run, or the release package. The runner
stops at `release_ready` (`merge_ready`, reason `human_release_approval_required`) or at its own
`blocked_capacity`, `blocked_external` or `owner_action_required` outcome. A resume is simply the next runner call
after a trusted capacity observation.

Deterministic scenarios in `software-factory-collaboration-simulation.mjs`, using only fake adapters and a synthetic project:

1. `full_lifecycle_with_correction`: approved task → Codex backend contract → Antigravity frontend → test evidence → Claude (trial reviewer) requests a correction → Antigravity corrects → old implementation/test/review evidence invalidated → tests and review repeated on the new head → release package bound to the new head → stops awaiting the owner.
2. `mixed_area_findings_two_corrections`: a review raises one backend and one frontend finding → backend then frontend correction, with no test or review of an incomplete candidate between them → tests → re-review explicitly resolves both → release package that lists both findings as resolved.
3. `codex_quota_alternate_routing`: Codex exhausted → backend routed to the owner-approved trial alternate → mandatory reviewer unavailable, so the runner returns `blocked_capacity` and escalates → a trusted capacity observation → next runner call resumes with Codex as reviewer → release package → stops awaiting the owner.

All end at `merge_ready` in the simulated record only, with `ownerDecision: null`, or at an unrecovered checkpoint.
Nothing outside collaboration tests imports the simulation (static test).

## 6. Test matrix

| Requirement | Test file and area |
| --- | --- |
| Forged identity | adversarial: forged sender, not-assigned sender; contract: identity untrusted, registry untrusted |
| Unauthorized role | contract: unauthorized roles; adversarial: mis-assigned senders |
| Duplicate and replay | adversarial: duplicate/replay and idempotency conflict |
| Wrong project/run/version | adversarial: project, run, correlation, version, plan, scope, base |
| Wrong or stale candidate | adversarial: stale/replayed candidate; contract: stale evidence |
| Out-of-order | adversarial: out-of-order |
| Conflicting writer | adversarial: writer conflict, writer discipline; contract: workspace guard |
| Invalid or changed contract | adversarial: invalid contract, owner reconciliation |
| Untrusted command/path | contract and adversarial: command, path, URL rejection |
| Missing/oversized evidence | contract: evidence bounds; adversarial: missing/oversized/conflicting |
| Sensitive data, injection | contract: sensitive data, prompt injection; adversarial: not echoed into the record |
| Same agent implements and reviews | routing: independence; adversarial: implementer cannot review |
| Quota exhaustion | routing: capacity states, trial approval, paid/unknown billing; adversarial: pre-dispatch checkpoint, claim-only-restricts; simulation: alternate routing |
| Unavailable mandatory reviewer | routing and adversarial: checkpoint and owner escalation; simulation |
| Timeout and ambiguous completion | adversarial: quarantine, no retry |
| Exhausted correction budget | adversarial: budget exhausted |
| Stale owner approval | adversarial: package, head, scope, expiry, future, wrong owner |
| Invalid catalog and WIP | adversarial: admission reuses existing policy |
| Mixed-area findings stay accounted for | rules: finding ledger; adversarial: backend correction alone cannot complete, unavailable frontend, exhausted budget; simulation: mixed scenario |
| Reuse and layering | simulation: runner is the existing runner; layering tests pin reusable-layer imports and test-only isolation |
| No side effects | simulation: static import scan, fetch trap, env check, no canonical store use |

## 7. Evidence limits

Tests prove the model rejects what it is told to reject and that nothing in these modules performs
I/O. Direct imports are minimal, but the transitive import graph includes existing modules that import
`node:child_process`, `node:net` and `node:fs`, and the simulation now loads the existing autonomous runner and
its dependencies. They are loaded, not invoked; the evidence is behavioral (tests pass with process spawn and file
writes denied by the Node permission model, and with network operations denied by an OS-level `sandbox-exec`
profile). Node's permission flag alone does not establish network denial. They do not prove that a real provider honors any of these boundaries. The
transport-authenticated sender in tests (`channel.providerId`) is a stand-in for the future
authenticated gateway (RIC-177) and trusted host enrollment (RIC-158).

## 8. Runtime compatibility matrix

Documentation-based and read from this repository. Nothing was installed, authenticated or
executed. Claude interface facts come from the public Claude Code documentation
(`code.claude.com/docs/en/headless` and `/sandboxing`) as read during this task; they were not
verified by running anything and may change.

| Item | Existing Codex adapter | Existing Antigravity adapter | Proposed Claude Code execution adapter | Proposed Claude read-only review adapter |
| --- | --- | --- | --- | --- |
| Interface | `codex exec --ephemeral --sandbox … --ignore-user-config --ignore-rules --strict-config --model …` via `development-codex-execution-adapter.mjs` | Reviewed `agy` executable paths; `agy models`, then an execution call with `--model`, `--sandbox`, `--print-timeout` (`software-factory-antigravity-*.mjs`) | Documented non-interactive CLI `claude -p` (`--output-format json` or `stream-json`, `--json-schema`, `--allowedTools`, `--permission-mode`, `--permission-prompts none`, `--bare`) and an Agent SDK for Python and TypeScript | Same CLI or SDK, restricted to read-only tools |
| Sandbox | PPO-enforced no-outbound-network profile (macOS `sandbox-exec` or Codex native; Linux network namespace), clean env, forbidden env keys, task-owned worktree | Antigravity `--sandbox`; reviewed automation settings validated against the managed workspace root; sanitized env | Documented Seatbelt (macOS) and bubblewrap (Linux), off by default, file tools and MCP servers/hooks run outside it, reads are open by default, network goes through an allowlisting proxy. PPO's own network-denied sandbox would still need to wrap it | A distinct read-only sandbox mode is **not documented**. Read-only would have to be built from a deny-all tool list plus `denyRead` rules inside PPO's existing read-only reviewer sandbox |
| Authentication | Existing CLI login handled outside the adapter. Adapter classifies an `authentication` failure and strips credential-like env keys (including `OPENAI` and `ANTHROPIC`) | CLI login. Readiness probe treats auth text as unconfigured | Subscription login or API key. `--bare` mode does **not** use the subscription login and needs `ANTHROPIC_API_KEY` or a key helper | Same |
| Quota handling | `usage_limit` failure class with bounded retry-after; no blind retry | Quota/rate text parsed into exhausted or rate_limited; readiness gate before dispatch | Documented retry events and error categories (`rate_limit`, `billing_error`, `authentication_failed`…) in stream output. Mapping to PPO capacity states is not built | Same |
| Billing | Not asserted by this repo | Not asserted by this repo | **Unknown.** The documentation reviewed does not say whether subscription plans may be used for automation. API-key use is metered, and cost fields are documented as client-side estimates. Do not assume a subscription authorizes unattended automation | **Unknown**, same |
| Process ownership | Task-owned process, timeouts, orphan recovery | Task-owned process, orphan recovery | Documented SIGTERM behavior (exit 143, process tree of running shell commands terminated) and background-task waits. PPO-owned PID/port tracking is not built | Same |
| Status | Implemented, live-gated | Implemented, live-gated | **Not implemented.** Gap list below | **Not implemented.** Gap list below |

Exact Claude adapter gaps: no executable path pinning or version policy; no PPO sandbox
wrapper profile; no env allowlist for Claude's variables; no output-schema validation of
results; no capacity-state classifier for Claude errors; no task-owned PID/port/workspace
ledger; no read-only review profile; no billing and plan decision from the owner; no
registration in `SOFTWARE_FACTORY_WORKERS` or the capability policy; no readiness probe or
dispatch authorization like the Antigravity pair; no live failure-class tests.

## 9. Remaining prerequisites before any real use

- Owner decision on Claude billing path and whether it may be used unattended.
- RIC-177 authenticated authority gateway and incarnation anchor, so message senders are authenticated rather than asserted.
- RIC-158 trusted host enrollment, and the RIC-157 transactional fence integrated with the coordinator, replacing the in-memory version and writer guard.
- A canonical home for the owner-approved decomposition (plan contract extension) and for collaboration events (extend the existing evidence kinds, not a new store).
- RIC-59 and RIC-61 holds resolved before any live collaborative run.
- A separately approved replacement for the canceled CodeRabbit review policy.
- The PostgreSQL canonical-authority CI gate is CI-only and refuses to run locally; it remains an outstanding gate for this candidate.
- Adding Claude to `SOFTWARE_FACTORY_WORKERS` would let the real dispatch-checkpoint mechanism replace the test-only capacity mirror.

## 10. Proposed next bounded slice

Read-only Claude reviewer adapter contract and fake: define its sandbox profile, tool deny list,
env allowlist, output schema and failure-class mapping to PPO capacity states, with fixtures
only and a conformance suite that both the fake and any future real adapter must pass. Still
no credentials, no provider calls and no canonical writes.
