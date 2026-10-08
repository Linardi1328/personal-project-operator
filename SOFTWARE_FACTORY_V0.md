# PPO Software Factory V0

## Purpose

PPO is evolving from a Codex-centric personal project operator into the control plane for the owner's standardized AI software-development stack.

Software Factory V0 does not replace PPO's proven development lifecycle. It adds deterministic routing policy above that lifecycle so PPO can decide which approved capability should act next, whether that worker has capacity, which reasoning tier is sufficient, and when owner authority is required.

## Preserved invariants

The existing PPO development-run system remains authoritative for:

- durable run state and optimistic version checks;
- isolated implementation workspaces;
- exact-SHA implementation, test, review, CI, and merge evidence;
- bounded remediation and retry behavior;
- ambiguous-outcome reconciliation;
- independent review;
- GitHub as the canonical code record; and
- explicit owner authority for production release boundaries.

Software Factory V0 must not weaken those guarantees.

## Current stack policy

The initial control-plane policy reflects the standardized engineering stack:

| Capability | Primary worker | Model class | Required skill / policy |
| --- | --- | --- | --- |
| repository inspection | ChatGPT | economy | none |
| planning | ChatGPT | standard | none |
| architecture | ChatGPT | deep | none |
| backend implementation | Antigravity | standard | none |
| frontend implementation | Antigravity | standard | `ui-ux-pro-max` |
| deterministic tests | GitHub CI | none | repository test policy |
| browser E2E | Playwright | none | repository test policy |
| debugging | Antigravity | standard | `debugging-and-error-recovery` |
| runtime browser inspection | Chrome DevTools | none | runtime evidence |
| code review | CodeRabbit | none | review evidence |
| frontend review | Antigravity | standard | `web-design-guidelines` |
| security review | ChatGPT | deep | independent review |
| release review | ChatGPT | deep | independent review |
| preview deployment | Vercel | none | exact reviewed SHA |
| production deployment | Vercel | none | owner approval required |

This table is policy metadata only. It does not claim that every worker has a live PPO adapter.

## Model classes

PPO uses abstract model classes instead of hard-coding vendor model names:

- `none`: deterministic tool; no reasoning model should be consumed;
- `economy`: low-cost retrieval, inspection, and summarization work;
- `standard`: normal planning, implementation, and debugging;
- `deep`: architecture, security, release review, or escalated difficult work.

Provider-specific adapters may map these classes to current models later. This keeps routing policy stable when model catalogs change.

Escalation is deterministic:

- economy work escalates to standard after one failed attempt;
- economy or standard reasoning work escalates to deep after two failed attempts;
- high-risk reasoning work uses deep immediately;
- deterministic tool work remains `none` regardless of retries.

## Capacity semantics

Workers report one of:

- `available`;
- `degraded`;
- `exhausted`;
- `rate_limited`;
- `unavailable`; or
- `unknown`.

An exhausted or rate-limited worker produces `blocked_capacity` with `consumeAttempt=false`. Quota pressure is therefore not treated as an implementation failure.

An unavailable, unknown, or unconfigured worker fails closed instead of silently selecting a different implementation provider.

## Authority boundary

Routine approved engineering work may eventually be dispatched automatically after its worker adapter is reviewed.

Production deployment remains owner-gated. Future destructive migrations, authentication-architecture changes, new paid infrastructure, production-secret changes, and other high-impact actions must receive separate explicit authority policies rather than inheriting routine implementation permissions.

## V0 boundaries

This first slice is intentionally side-effect free. It does not:

- invoke Antigravity, ChatGPT, Vercel, CodeRabbit, Playwright, or Chrome DevTools;
- replace the existing Codex execution adapter;
- change development-run statuses or evidence schemas;
- add parallel workers;
- deploy anything;
- enable automatic production release; or
- claim live capacity observations that PPO cannot currently verify.

## Next integration target

The next increment should connect reviewed runtime observations to this control-plane policy, beginning with implementation-provider capacity. Once Antigravity has a reviewed adapter/readiness boundary, an ordinary PPO run should be able to remain queued as `blocked_capacity` when Antigravity is exhausted and resume without rebuilding task context or consuming a failed implementation attempt.

The first Customer Zero target should be a real priority-project task, not a synthetic demonstration.


## V0.2 durable dispatch checkpoints

The capacity-checkpoint layer keeps quota and worker-readiness state outside the proven Phase 6 development-run lifecycle.

A development run remains at its existing status while a separate private append-only checkpoint records:

- the exact development run id and version;
- the reviewed capability, selected worker, model class, and required skills;
- a bounded capacity observation with a reviewed source id and timestamp;
- the resulting dispatch outcome and whether a worker attempt may be consumed.

Checkpoint publication is versioned and atomic. A complete private temporary file is fsynced before it is linked into the next numbered checkpoint slot. Stale or concurrent writers cannot overwrite an existing version.

Capacity observations expire after a bounded interval. A stale observation is treated as unknown and cannot produce a ready dispatch decision. A fresh observation may be assessed read-only before a new checkpoint is recorded.

This allows:

```text
planned development run
        |
Antigravity exhausted
        v
blocked_capacity checkpoint
(run status and attempts unchanged)
        |
fresh capacity observation
        v
ready assessment
        |
new checkpoint
        v
implementation may begin
```

V0.2 still does not invoke Antigravity or another worker. A reviewed provider/readiness adapter remains the next execution boundary.


## V0.3 trusted Antigravity readiness

V0.3 introduces the first trusted live-worker readiness boundary without granting worker execution authority.

The reviewed Antigravity readiness adapter:

- validates the Antigravity CLI executable against a fixed reviewed path set;
- refuses symlinked or group/world-writable executables;
- runs a cheap integration probe with `agy models`;
- then attempts the official `/usage` quota command through non-interactive CLI mode;
- classifies only reviewed states: available, degraded, exhausted, rate-limited, unavailable, or unknown;
- never treats successful model listing alone as capacity evidence;
- refuses oversized or sensitive probe output;
- creates `reviewed-runtime-probe` provenance internally rather than accepting it from a caller; and
- remains fail-closed when the quota surface cannot be consumed headlessly.

Current Antigravity documentation exposes quota through `/usage`; there is no assumed undocumented quota API in PPO.

### Dispatch authorization

A historical checkpoint is not execution authority.

PPO can issue a short-lived in-memory Antigravity dispatch authorization only when all of the following are true:

1. the development run id and version are still current and non-terminal;
2. the caller names the exact latest checkpoint version;
3. the checkpoint capability and worker still match reviewed policy;
4. the checkpoint outcome is `ready` with `consumeAttempt=true`;
5. checkpoint provenance is `reviewed-runtime-probe`;
6. the checkpoint observation is still within its freshness window; and
7. a second fresh trusted Antigravity probe still reports available or degraded capacity.

Authorization validity is tied to the adapter instance's private in-memory identity set. A serialized or reconstructed object cannot be replayed as valid authorization.

V0.3 still does not invoke Antigravity for implementation work. The next execution slice must consume this authorization at the execution boundary and independently preserve PPO's exact-run, workspace, attempt, and evidence guarantees.


## V0.4 sandboxed Antigravity implementation execution

V0.4 introduces the first Antigravity implementation executor while preserving the existing PPO development-run lifecycle.

Execution requires all of the following before an implementation attempt is consumed:

- a current short-lived authorization from the reviewed Antigravity readiness adapter;
- an exact current `implementation_in_progress` run version;
- a matching prepared PPO isolated workspace at the expected HEAD;
- a canonical reviewed Antigravity and Git executable;
- Antigravity settings with `toolPermission: "always-proceed"`;
- explicit `read_file(*)` and `write_file(*)` allow rules;
- the PPO workspace inside an Antigravity trusted workspace; and
- non-workspace access not enabled.

PPO does not change those global Antigravity settings automatically.

The executor invokes Antigravity in non-interactive print mode with `--sandbox`. It never passes `--dangerously-skip-permissions`.

The prompt forbids remote Git mutation, deployment, infrastructure mutation, credentials changes, unrelated refactors, and commits. PPO independently preserves successful changes in a local commit, verifies that the protected source repository did not change, verifies that the resulting HEAD descends from the authorized start SHA, and records only bounded structured evidence.

If Antigravity fails after the implementation attempt begins, PPO verifies the protected source repo and restores the disposable isolated workspace to the authorized start SHA before recording a definitive failure. This prevents failed attempts from leaving a dirty worktree that blocks future recovery.

V0.4 intentionally does not yet replace the existing Continue orchestrator's Codex execution route. The adapter must first pass repository CI and independent review. The next slice will route implementation through readiness → checkpoint → authorization → Antigravity execution, while preserving capacity blocks as non-attempt conditions.


## V0.5 Continue orchestration through Antigravity

V0.5 connects the existing Phase 6 Continue loop to the reviewed Software Factory implementation path for ordinary projects.

For a new ordinary `implementation_in_progress` run, Continue now performs:

```text
current run
   |
deterministic capability selection
   |
trusted Antigravity readiness probe
   |
durable dispatch checkpoint
   |
ready? ---- no ----> blocked_capacity / blocked_external
   |                         |
  yes                        +--> no implementation attempt consumed
   |
second fresh dispatch authorization
   |
sandboxed Antigravity implementation
   |
implementation_ready
```

Capability selection is deterministic. Explicit frontend/browser/UI impact is frontend-biased, explicit debugging work uses the debugging capability, and remaining bounded implementation work uses backend implementation.

The public Phase 6D Continue action label is preserved for compatibility, but the ordinary-project worker behind that boundary is now the Software Factory Antigravity coordinator. PPO self-development continues to use the legacy Codex implementation route until a separate self-development migration is reviewed.

### Legacy and orphan recovery

V0.5 preserves legacy Codex in-flight recovery. New Antigravity attempts record distinct evidence under the Antigravity execution adapter.

An interrupted Antigravity attempt is recoverable only when:

- the current run, version, implementation attempt, and expected head SHA match the open evidence;
- the operation lease is no longer active and matches the exact attempt;
- the protected source repository remains clean at the expected start SHA; and
- the disposable PPO workspace can be restored to the expected start SHA.

Successful orphan recovery records a definitive runtime failure without incrementing the implementation attempt again, then allows a later Continue call to retry through a fresh readiness/checkpoint/authorization cycle.

Protected source-repository drift or unverifiable state remains fail-closed and requires owner/reconciliation action.

### Runtime profile

Ordinary Antigravity Phase 6D dispatch no longer requires Codex executable/authentication readiness. Its trusted runtime profile is reduced to the reviewed project source/workspace registry and Git boundary required by the Software Factory path. Later test/review/hardening phases retain their existing reviewed runtimes.


## V0.6 bounded autonomous run driver

The Software Factory can now drive an ordinary PPO development run through multiple already-reviewed Continue boundaries in one bounded invocation.

`/ppo factory-run <run-id>`:

- reuses the existing one-boundary Continue orchestrator for every state transition;
- uses the same trusted runtime profile, readiness, workspace, test, review, and delivery policies;
- stops immediately on capacity, external, stale-loop, or owner-action blockers;
- enforces a fixed maximum number of automatic steps;
- detects successful responses that make no durable run progress;
- allows one stale-state refresh before failing closed on repeated staleness;
- treats existing merged/verified runs as complete;
- never routes deployment, verification, or rollback; and
- stops at `merge_ready` with `release_ready` so the final merge remains a human release decision.

The existing `/ppo continue <run-id>` route remains available for one-boundary manual control and diagnosis.

The V0.6 driver does not add new implementation, testing, or review logic. It removes manual message-passing by composing the existing reviewed boundaries.


## V0.7 autonomous deterministic test remediation

Software Factory V0.7 closes the deterministic test-failure loop without treating worker quota pressure as an implementation failure.

A required test command that returns a verified nonzero exit now commits `tests_failed` with the existing metadata-only Phase 6E evidence. Raw stdout and stderr remain discarded.

The factory then follows this bounded path:

```text
implementation_ready
        |
deterministic tests
        v
tests_failed
        |
validate exact trusted test evidence
        |
probe Antigravity debugging readiness
   +----+----+
   |         |
blocked     ready
   |         |
stay        v
tests_failed implementation_in_progress
(no attempt)  + test-remediation marker
                  |
                  v
          Antigravity debugging
                  |
                  v
          implementation_ready
                  |
                  v
              retest
```

The remediation marker binds the debugging attempt to the failed implementation SHA and trusted test attempt. While that SHA remains current, normal Software Factory implementation routing must select the `debugging` capability and its `debugging-and-error-recovery` skill.

Antigravity receives only bounded failure metadata: the source test attempt, failed/total counts, and up to five reviewed test IDs. Raw test output, stack traces, credentials, and arbitrary failure text are never forwarded.

Existing persistent implementation/test attempt caps and the V0.6 autonomous-run step limit remain authoritative. Production actions remain outside this loop.


## V0.8 Antigravity review remediation

Ordinary-project review remediation now uses the same trusted Software Factory implementation path as normal implementation and failed-test recovery.

When independent review returns validated `CHANGES_REQUESTED` evidence, PPO:

1. verifies the exact reviewed SHA and bounded review-finding contract;
2. enforces the existing maximum of three hardening rounds;
3. records a hardening marker and transitions to `implementation_in_progress`;
4. routes the marker deterministically to the `debugging` capability;
5. performs trusted Antigravity readiness, checkpointing, short-lived authorization, and sandboxed execution;
6. passes only validated bounded blocker/security/test-requirement items into the Antigravity prompt;
7. reruns deterministic tests and independent review; and
8. repeats only while the reviewed round cap permits.

If Antigravity is quota-blocked or externally unavailable, the hardening loop stops before tests and returns the capacity/external blocker without fabricating review progress.

PPO self-development and legacy recovery retain the existing Codex-backed hardening default. Production deployment and final merge authority remain outside autonomous remediation.


## V1.0 live model routing

Antigravity execution now binds the abstract Software Factory model class to a concrete model from the live `agy models` catalog before an implementation attempt begins.

The routing policy is intentionally version-tolerant:

- `economy` prefers the newest reviewed Flash Medium tier, then other reviewed lightweight/Flash tiers;
- `standard` prefers the newest reviewed Flash High tier, with reviewed medium/deeper fallbacks;
- `deep` requires a reviewed Pro High or reasoning/deep tier and fails closed when only lightweight models are available.

PPO pins the selected slug with `--model`. It never relies on Antigravity's interactive/default model choice for factory execution, and it does not silently downgrade a `deep` task to a lightweight model.

Model discovery and routing happen before `attempts.implementation` is incremented. An unavailable, malformed, or insufficient catalog therefore blocks dispatch without consuming an implementation attempt or model-generation tokens.

Only the selected bounded model slug is stored in implementation evidence. Raw `agy models` output is not persisted.


## V1.2 deterministic release candidate evidence package

The Software Factory release gate now produces one bounded manager-facing evidence package when an ordinary run reaches `merge_ready`.

The package is constructed only from persisted reviewed evidence. It fails closed unless the current exact head SHA has:

- completed reviewed implementation evidence from an approved executor;
- deterministic Phase 6E tests with zero failed or ambiguous results;
- local independent Phase 6F approval with zero blockers, security findings, or additional test requirements;
- remote exact-head PR review approval with the same zero-finding requirements;
- exact-head PPO PR validation evidence for the reviewed workflow contract; and
- Phase 6G merge-ready evidence binding the pull request, branch, base, CI run, remote-reviewed SHA, and approved squash merge method.

The package contains bounded metadata only. It excludes raw prompts, model output, test logs, review prose, credentials, and secrets.

A deterministic SHA-256 package hash binds the complete manager handoff. Rebuilding the package from unchanged run evidence yields the same hash.

`/ppo factory-run <run-id>` now attaches this package automatically to a `release_ready` outcome. If a merge-ready run cannot produce a valid package, the factory fails closed instead of presenting the release as ready.

V1.2 does not grant merge or production authority. The package explicitly records:

- merge: owner approval required;
- production deployment: not authorized.


## V1.3 package-bound owner release approval

The final merge boundary is now an explicit two-step owner approval bound to the immutable V1.2 release package.

```text
factory-run
  ↓
release_ready + package hash
  ↓
/ppo release <run-id>
  ↓
10-minute single-use approval request
  ↓
owner explicitly confirms request id
  ↓
package is rebuilt and exact bindings revalidated
  ↓
existing Phase 6G SHA-pinned squash merge
  ↓
merged
```

The staged request binds the run id and version, project, exact head SHA, pull request number, package hash, and approved squash merge method. Confirmation atomically consumes the request before any merge action. Expired, replayed, stale, malformed, or changed release state fails closed.

V1.3 grants no automatic approval and no production authority. Production deployment, verification, rollback, and service mutation remain outside the Software Factory release approval boundary.


## V1.4 manager objective intake

V1.4 removes the normal requirement for the owner to first edit project-state documents before starting factory work.

The manager-facing entry point is:

```text
/ppo factory-start <project> <objective>
```

The objective is bounded to the existing development-task limit and treated as inert owner-supplied task text. PPO refuses control characters, sensitive-looking values, unknown projects, contradictory GitHub identity, malformed current-head data, and projects with any open pull request.

A successful intake:

1. reads the approved project's current GitHub default branch and latest commit through the reviewed read-only client;
2. refuses ambiguous open-PR state before creating any run;
3. creates exactly one durable development run pinned to that default-branch SHA;
4. records owner-origin planning evidence containing only bounded metadata and an objective hash;
5. transitions the run through `planning_in_progress` to `planned`; and
6. hands the durable run id directly to the existing bounded autonomous runner.

The owner objective authorizes the named task only. It does not authorize architecture replacement, new paid infrastructure, destructive migration, production deployment, secrets changes, or automatic merge approval.

If the autonomous run later blocks on worker capacity or an external dependency, the created run remains durable and the result includes its run id for later `/ppo factory-run <run-id>` resumption.

The release boundary remains unchanged: a successful factory run stops at `release_ready` with the deterministic release package and still requires explicit package-bound owner merge approval.


## V1.5 structured planning contract

V1.5 makes planning a validated artifact rather than an unstructured sentence carried into implementation.

Every manager-objective run now records a versioned plan bound to:

- the durable development run id;
- approved project id;
- exact base SHA;
- hash of the owner objective; and
- hash of the complete bounded plan.

The deterministic baseline plan contains:

- a goal that preserves the owner objective as the source of truth;
- explicit acceptance criteria;
- implementation constraints;
- explicit exclusions;
- a capability hint; and
- a conservative risk classification.

The baseline plan does not invent product requirements. It adds only PPO's already-reviewed execution, quality, review, release, workspace, and authority boundaries.

Before use, the plan contract validates exact fields, sizes, arrays, sensitive/control text, project/run/SHA bindings, objective binding, reviewed capability/risk vocabulary, and its content hash.

The latest valid structured plan is consumed by the implementation coordinator for capability routing and risk-aware model policy, and by the Antigravity execution adapter as bounded prompt context. Invalid or stale plan metadata is never treated as authority; existing task-based routing remains the fail-closed compatibility fallback.

This contract is provider-neutral. A future planning worker may enrich the plan only by producing the same validated schema while remaining bound to the original owner objective. Adding a live paid/model-backed planning provider remains a separate architecture and cost decision.


## V1.6 WIP admission and backpressure

Manager-objective intake now enforces the owner's Software Factory WIP policy before any GitHub snapshot, model discovery, readiness probe, or worker execution occurs.

The admission policy is:

- at most two active ordinary projects globally;
- at most one active development run per project;
- a `merge_ready` run still consumes WIP until the owner resolves the release boundary;
- terminal runs do not consume WIP;
- any recovery-required active run blocks new admission until reconciled; and
- incomplete or truncated run-catalog state fails closed.

This control exists to protect both management bandwidth and AI/model quota. A new manager objective cannot create another run merely because execution capacity exists.

V1.6 intentionally does not yet persist waiting objectives. A later queue slice may retain blocked objectives safely and admit them only when a WIP slot becomes available.
