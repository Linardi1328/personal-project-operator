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
