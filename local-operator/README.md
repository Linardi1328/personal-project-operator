# Local Operator Simulator

This folder contains the Phase 1 local-only command simulator for Personal Project Operator.

It lets you test phone-style command outputs before OpenClaw routes real chat messages.

## What it supports

Phase 1 terminal simulator:

```bash
node local-operator/simulate-command.mjs /status
node local-operator/simulate-command.mjs /menu
node local-operator/simulate-command.mjs /menu project
node local-operator/simulate-command.mjs /menu codex
node local-operator/simulate-command.mjs /menu system
node local-operator/simulate-command.mjs /help
```

Phase 1.5 OpenClaw Telegram routing wrapper:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
```

OpenClaw/Telegram should use `/ppo status`, `/ppo menu`, `/ppo menu project`, `/ppo menu codex`, `/ppo menu system`, and `/ppo help` instead of overriding OpenClaw built-ins.

Phase 2A GitHub read-only terminal validation:

```bash
node local-operator/github-readonly-cli.mjs repo khlim-assist
node local-operator/github-readonly-cli.mjs commits khlim-assist
node local-operator/github-readonly-cli.mjs prs khlim-assist
node local-operator/github-readonly-cli.mjs issues khlim-assist
node local-operator/github-readonly-cli.mjs snapshot khlim-assist
```

Phase 2A is terminal-only.

Phase 2B OpenClaw Telegram routing adds:

```bash
node local-operator/ppo-command.mjs repo khlim-assist
node local-operator/ppo-command.mjs pr khlim-assist
```

OpenClaw/Telegram can route `/ppo repo <project>` and `/ppo pr <project>` through the existing `ppo_local` direct tool path.

Phase 2C upgrades `/ppo status` to GitHub read-only:

```bash
node local-operator/ppo-command.mjs status
```

`/ppo menu` and `/ppo help` remain fixture-backed wrapper output with Phase 2C wording adaptation.

Phase 3A adds terminal Codex prompt generation:

```bash
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
```

Phase 3C routes `/ppo codex <project> <task>` through OpenClaw/Telegram using the same deterministic text generator.

Phase 3B adds terminal Codex planning tools:

```bash
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build one focused feature"
node local-operator/ppo-command.mjs split-task "add GitHub integration and Telegram routing"
```

Phase 3C routes `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` through OpenClaw/Telegram. The bridge parses only the command envelope and treats task/draft text as inert data.

Phase 5A adds terminal-only controlled GitHub issue creation:

```bash
node local-operator/ppo-command.mjs issue-create khlim-assist "issue title" "optional body"
```

This Phase 5A terminal command is not the `/ppo` chat command. It refuses to write unless `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>` exactly matches the target project.

Phase 5B adds approval-gated issue creation through the existing `/ppo` -> `ppo_local` direct-tool path:

```bash
node local-operator/ppo-command.mjs "/ppo issue-create khlim-assist issue title --body optional body"
node local-operator/ppo-command.mjs "/ppo issue-confirm <request-id>"
```

`/ppo issue-create` never calls GitHub. It validates the project, title, and body, writes one private pending request, and returns the confirmation command. `/ppo issue-confirm` atomically claims and consumes one unexpired request before invoking the Phase 5A writer with internal confirmation.

Phase 5C adds terminal-only controlled project note creation:

```bash
node local-operator/ppo-command.mjs note-add khlim-assist "project note text"
```

This command is not routed through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It refuses to append unless `PPO_NOTE_WRITE_CONFIRM=add-note:<project>` exactly matches the target project. Notes are stored under `${PPO_WRITE_DATA_DIR}/project-notes`, with local default `local-operator/write-data/` and VPS default configured by systemd at `/var/lib/personal-project-operator/write-data`.

Phase 5D adds approval-gated note creation through the existing `/ppo` -> `ppo_local` direct-tool path:

```bash
node local-operator/ppo-command.mjs "/ppo note-add khlim-assist project note text"
node local-operator/ppo-command.mjs "/ppo note-confirm <request-id>"
```

`/ppo note-add` stages only and performs zero note writes. It rejects chat input containing `PPO_NOTE_WRITE_CONFIRM`, stores one private pending request under `${PPO_WRITE_DATA_DIR}/pending-project-notes`, and returns `/ppo note-confirm <request-id>`. `/ppo note-confirm` atomically consumes one unexpired request before invoking the Phase 5C writer with internal confirmation.

Phase 5E adds terminal-only controlled project-state promotion:

```bash
node local-operator/ppo-command.mjs state-promote <project> <note-id> <current-phase|last-known-status|next-action>
```

It requires exact `PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>`, promotes one durable Phase 5C/5D note verbatim into exactly one approved project-state section, refuses `main` and dirty targets, rechecks the target hash before mutation, uses atomic durable replacement, and writes metadata-only promotion audit records. `/ppo state-promote` remains unsupported. See [phase-5e-project-state-promotion.md](phase-5e-project-state-promotion.md).

Phase 6A adds a local-only development run-state library:

```text
local-operator/development-run-state.mjs
```

It stores durable run records under `${PPO_WRITE_DATA_DIR}/development-runs` with explicit lifecycle transitions, optimistic expected-version checks, atomic canonical replacement, restart recovery from version guards, and bounded SHA-pinned evidence metadata. Phase 6A adds no terminal command, `/ppo` route, OpenClaw tool, Codex execution, GitHub write, git mutation, deployment action, or `/ppo continue`. See [phase-6a-development-run-state.md](phase-6a-development-run-state.md).

Phase 6B adds a local-only next-stage planner library:

```text
local-operator/development-next-stage-planner.mjs
```

It reads only fixed project docs, `ROADMAP.md`, and Phase 2 GitHub read-only snapshot facts. It returns a bounded structured plan or `owner_action_required`, and can create or plan a Phase 6A run only through `created -> planning_in_progress -> planned`. Phase 6B adds no terminal command, `/ppo` route, OpenClaw tool, workspace creation, branch operation, Codex execution, GitHub write, test/review automation, deployment action, or `/ppo continue`. See [phase-6b-next-stage-planner.md](phase-6b-next-stage-planner.md).

Phase 6C adds a local-only isolated workspace manager library:

```text
local-operator/development-workspace-manager.mjs
```

It accepts only a Phase 6A run in `planned` status, verifies the configured allowlisted source repo and exact base SHA, creates one deterministic branch/worktree under a PPO-managed workspace root, verifies the result, and transitions the run to `implementation_in_progress`. Phase 6C adds no terminal command, `/ppo` route, OpenClaw tool, Codex execution, implementation-file edit, test/review automation, GitHub write, PR automation, merge, deployment, rollback, or `/ppo continue`. See [phase-6c-isolated-workspace-manager.md](phase-6c-isolated-workspace-manager.md).

Phase 6D adds a local-only bounded Codex execution adapter library:

```text
local-operator/development-codex-execution-adapter.mjs
```

It accepts only a Phase 6A run in `implementation_in_progress` with a verified Phase 6C workspace, requires an active no-outbound-network Codex command sandbox, and uses fixed non-interactive `codex exec` argv for the Ubuntu 24.04 production backend. The Codex controller remains online while generated commands run inside the native `:workspace` permission profile. PPO durably records bounded implementation attempts, creates the fixed local commit after successful sandboxed edits, verifies the new descendant commit, and transitions the run to `implementation_ready`. Phase 6D adds no terminal command, `/ppo` route, OpenClaw tool, automated test execution, review automation, hardening loop, GitHub write, PR automation, merge, deployment, rollback, production verification, or `/ppo continue`. See [phase-6d-codex-execution-adapter.md](phase-6d-codex-execution-adapter.md).

Phase 6E adds a local-only deterministic automated test runner library:

```text
local-operator/development-test-runner.mjs
```

It accepts a Phase 6A run after Phase 6D has transitioned it to `implementation_ready`, requires exact expected-version checks, verifies Phase 6D implementation evidence and Phase 6C workspace branch/HEAD against `run.headSha`, runs only fixed trusted per-project test policy steps through an active no-outbound-network sandbox with explicit argv and `shell: false`, stores metadata-only SHA-pinned test evidence, and transitions to `tests_passed` only when every required test passes for that exact SHA. Phase 6E adds no terminal command, `/ppo` route, OpenClaw tool, Codex/model call, automated review, hardening loop, GitHub write, PR automation, merge, deployment, rollback, production verification, or `/ppo continue`. See [phase-6e-automated-test-runner.md](phase-6e-automated-test-runner.md).

Phase 6F adds a local-only independent exact-SHA review and bounded hardening library:

```text
local-operator/development-review-agent.mjs
local-operator/development-hardening-orchestrator.mjs
```

It accepts a Phase 6A run after Phase 6E has transitioned it to `tests_passed`, requires exact expected-version checks, verifies Phase 6D implementation evidence and Phase 6E PASS evidence for exactly `run.headSha`, reconciles the Phase 6C workspace branch/HEAD/clean tree, invokes only a trusted locally configured review executable through a verified no-outbound-network plus read-only-workspace sandbox with explicit argv and `shell: false`, validates strict structured reviewer output, stores metadata-only SHA-pinned review evidence, and transitions to `review_passed` only for valid exact-SHA approval. macOS review denies writes to the workspace, workspace Git state, and canonical source checkout with `sandbox-exec`; Linux review requires a trusted read-only mount wrapper over the same path set. Valid blockers or owner/security ambiguity transition to `review_changes_requested`.

The bounded hardening orchestrator starts only from valid `review_changes_requested` evidence for `run.headSha`, derives remediation context only from durable validated Phase 6F blocker/security/test findings, and coordinates the existing Phase 6D Codex adapter, Phase 6E test runner, and Phase 6F reviewer. Phase 6D hardening prompts must include every validated remediation item and all mandatory isolated-workspace, no-push, no-merge, no-deploy, no-credential, and no-destructive-operation boundaries; only optional task/planning context may be trimmed. Each implementation change must produce a new descendant SHA, rerun Phase 6E tests for that SHA, and rerun independent review for that SHA. Automatic hardening is capped at three durable rounds; non-convergence records owner-action-required evidence and stops. Phase 6F adds no terminal command, `/ppo` route, OpenClaw tool, unbounded hardening loop, GitHub write, PR automation, push, merge, deployment, rollback, production verification, or `/ppo continue`. See [phase-6f-independent-review-agent.md](phase-6f-independent-review-agent.md).

Phase 6G adds deterministic acceptance gates and trusted GitHub delivery libraries:

```text
local-operator/development-acceptance-gate.mjs
local-operator/github-delivery-agent.mjs
```

The acceptance gate is read-only and model-free. It accepts only an exact-version `review_passed` run whose Phase 6D implementation evidence, Phase 6E PASS evidence, Phase 6F APPROVED evidence, and canonical clean Phase 6C workspace all point at the same `run.headSha`. It refuses stale versions, non-allowlisted projects, default branches, dirty or moved workspaces, stale approvals, open ambiguous Codex/test/review/hardening attempts, unresolved blockers/security findings/tests required, owner-action hardening, and non-convergence.

The delivery agent then pushes only `<approved SHA>:refs/heads/<approved Phase 6C branch>` to fixed `origin`, creates or reuses exactly one PR from that branch to `main`, requires the remote PR head to equal the approved SHA, requires exact-head `PPO PR validation`, performs an independent exact-head remote PR review inside the Phase 6F no-network/read-only reviewer sandbox, and transitions to `merge_ready` only after every gate passes. Immediately before reserving a merge attempt, it refuses a PR reported as `behind`; it never updates an approved PR branch in place because that would invalidate SHA-bound tests and reviews. It merges only with GitHub expected-head-SHA protection. Ambiguous push, PR creation, and merge writes are reconciled read-only before retry or completion. Metadata-only `merge` evidence stores bounded policy/branch/PR/CI/review/merge facts and excludes credentials, raw logs, raw API bodies, raw stdout/stderr, and arbitrary executable paths. Phase 6G ends at `merged`; it does not deploy, roll back, verify production, add `/ppo continue`, add Telegram/OpenClaw routes, or alter credentials. See [phase-6g-github-delivery.md](phase-6g-github-delivery.md).

Phase 6H adds a local-only exact-SHA deployment agent foundation:

```text
local-operator/development-deployment-agent.mjs
```

It accepts only a Phase 6A run in `merged` status, requires exact expected-version checks, and reads the deployment target solely from durable Phase 6G `merged` evidence. PPO self-development runs originate through an explicit local-only run-state capability fixed to `personal-project-operator` / `Linardi1328/personal-project-operator`; ordinary project resolution and ordinary run creation still use only the six-project registry. The deployment target must be the Phase 6G merge commit SHA, not caller input, latest `main`, branch name, task text, chat, environment variables, repository configuration, or model output. The agent supports only the trusted `personal-project-operator` profile with fixed repository identity, fixed install directory, fixed origin, fixed exact-SHA deployment script, fixed runtime preflight, and fixed `ppo-openclaw.service` restart target.

The agent transitions `merged -> deploy_in_progress` before mutation, invokes only trusted deployment operations with explicit argv, `shell: false`, bounded timeout/output, and metadata-only evidence, and transitions to `deployed` only after the deployed checkout HEAD equals the Phase 6G merge SHA and the approved preflight and fixed restart completed. Definitive failures transition to `deploy_failed`. Ambiguous outcomes remain open and require read-only reconciliation; reconciliation does not mutate the checkout, restart the service, retry deployment, or infer production verification. Phase 6H stops at `deployed` and does not automatically rollback, run health checks, perform production verification, add `/ppo continue`, or add Telegram/OpenClaw routes. See [phase-6h-deployment-agent.md](phase-6h-deployment-agent.md).

Phase 6I adds a local-only read-only production verification agent foundation:

```text
local-operator/development-production-verification-agent.mjs
deployment/scripts/verify-production-readonly.sh
```

It accepts only a Phase 6A PPO self-development run in `deployed`, requires exact expected-version checks, derives the verification target solely from valid durable Phase 6H `deployed` evidence, and requires that SHA to equal the Phase 6G merge commit. The agent reuses the fixed Phase 6H PPO deployment profile and rejects caller-supplied repositories, services, install paths, commands, executables, policies, or target SHAs.

The agent transitions `deployed -> verification_in_progress` before running checks, invokes only the trusted read-only verification primitive with explicit argv, `shell: false`, bounded timeout/output, sanitized env, and strict bounded JSON output validation, then transitions to `verified` only after the full contract passes. Definitive failures transition to `verification_failed`; ambiguous outcomes remain open and require read-only reconciliation. Phase 6I does not deploy, rollback, restart services, refresh Git refs, mutate files, invoke Codex/models, write to GitHub, add `/ppo continue`, or add Telegram/OpenClaw routes. See [phase-6i-production-verification-agent.md](phase-6i-production-verification-agent.md).

Phase 6K adds a controlled `/ppo continue <run-id>` orchestrator:

```text
local-operator/development-continue-orchestrator.mjs
```

It accepts only an existing opaque Phase 6A run id for one of the ordinary six projects, reads the durable run state, captures the current version, re-reads immediately before dispatch, and passes that version internally to the existing reviewed Phase 6B-6G child API for the current status. It advances at most one outer boundary per invocation and stops at `merged`. It refuses PPO self-development runs, caller-selected versions/projects/actions/SHAs/workspaces/policies, ambiguous open attempts, production statuses, and all Phase 6H/6I/6J deployment, verification, and rollback operations.

Phase 6L adds a unified read-only development recovery coordinator:

```text
local-operator/development-recovery-coordinator.mjs
```

It accepts only an existing opaque Phase 6A run id for one of the ordinary six projects, dispatches at most one existing read-only Phase 6C-6G inspection/reconciliation boundary for the current durable status, and returns bounded owner-diagnostic metadata. Phase 6G recovery remains owned by the GitHub delivery reconciler and reports delivery not started, branch, PR, exact-head CI, remote review, merge-ready, and remote-merged observations without writes. It does not retry work, mutate run state, create/remove workspaces, execute Codex/tests/reviewers, push, create or modify PRs, merge, deploy, verify production, rollback, or add a `/ppo` route.

Phase 6M adds a controlled read-only recovery route around Phase 6L:

```text
local-operator/development-recovery-route.mjs
node local-operator/ppo-command.mjs recover <run-id>
/ppo recover <run-id>
```

The route accepts only the existing opaque run id, invokes Phase 6L once, returns `formatDevelopmentRecoveryResult(...)`, and performs no repair, retry, state mutation, `/ppo continue`, Codex/test/reviewer execution, GitHub write, deployment, production verification, rollback, new OpenClaw tool, or model interpretation. PPO self-development production recovery remains local-only and out of scope for the route.

### Phase 6N - Read-Only Development Run Catalog Foundation

Phase 6N adds a local-only ordinary-run catalog foundation:

```text
local-operator/development-run-catalog.mjs
```

It lists and inspects only existing ordinary Phase 6 runs for the fixed six-project registry. It uses a new non-mutating run-state snapshot reader, performs only bounded local filesystem reads under the fixed `development-runs` store layout, and never calls the existing `readDevelopmentRun(...)` recovery path. Missing stores are empty for listing and bounded not-found for exact inspection; lagging or missing canonical records are reported with explicit canonical-state classifications and are never repaired by the catalog.

Catalog summaries include only metadata: opaque run id, ordinary project id, status, stage, version, safe SHA fields, timestamps, terminal flag, and canonical-state classification. They exclude task text, filesystem paths, evidence, transition history, prompts, review findings, test details, PR raw state, GitHub responses, production metadata, stdout/stderr, raw errors, environment data, credentials, tokens, and secrets. PPO self-development runs are out of scope for the ordinary catalog and are omitted without exposing their run id, status, SHA, or production lifecycle metadata.

Phase 6N adds no `/ppo` route, no OpenClaw tool, no recovery invocation, no continue invocation, no cancellation, no retry, no repair, no run-state mutation, no subprocess/network execution, and no production inspection/deployment/verification/rollback.

### Phase 6O - Controlled Read-Only Development Run Catalog Routes

Phase 6O exposes the reviewed Phase 6N catalog through the existing PPO terminal wrapper and existing `ppo_local` direct-tool route:

```text
local-operator/development-run-catalog-route.mjs
node local-operator/ppo-command.mjs runs
node local-operator/ppo-command.mjs run <run-id>
/ppo runs
/ppo run <run-id>
```

`/ppo runs` accepts no caller-controlled filters, search text, sort fields, limits, offsets, project/status/stage selectors, paths, actions, confirmations, or production inputs. `/ppo run <run-id>` accepts exactly one opaque 43-character Phase 6A run id. Both routes invoke the Phase 6N catalog once, use only the Phase 6N formatters, and add a separate Phase 6O output ceiling.

The routes remain read-only and metadata-only. They preserve Phase 6N's ordinary six-project scope, fixed 100-record inspection bound, 20-summary return bound, active-first ordering, corrupt-content isolation, unsafe-filesystem fail-closed behavior, stale-observation fail-closed behavior, zero canonical repair, and PPO self-development exclusion. They do not expose task text, evidence, transition history, paths, raw Git/GitHub state, production lifecycle metadata, stdout/stderr, raw errors, environment data, credentials, tokens, or secrets.

Phase 6O does not add cancellation, retry, repair, resume, run creation, arbitrary filters/search/sort, recovery invocation, continue invocation, deployment, production verification, rollback, a new OpenClaw tool, or model interpretation.

### Phase 6P - Controlled Quiescent Development Run Cancellation

Phase 6P adds confirmation-gated cancellation for existing ordinary six-project development runs:

```text
local-operator/development-run-cancellation.mjs
local-operator/development-run-cancellation-approval.mjs
node local-operator/ppo-command.mjs cancel <run-id>
node local-operator/ppo-command.mjs cancel-confirm <request-id>
/ppo cancel <run-id>
/ppo cancel-confirm <request-id>
```

`/ppo cancel <run-id>` stages only. It validates the raw 43-character Phase 6A run id, inspects the run once through the reviewed Phase 6N exact summary path, requires `canonical_current`, and stores a private single-use approval request bound to run id, ordinary project id, current status, and expected version. Requests use 43-character random ids, a fixed 10-minute TTL, and the cancellation-specific `${PPO_WRITE_DATA_DIR}/pending-development-run-cancellations/{pending,claimed}` store.

Cancellation is eligible only from `created`, `planned`, `implementation_ready`, `tests_failed`, `tests_passed`, and `review_changes_requested`. In-progress, delivery, production, terminal, stale, missing, corrupt, unsafe, or self-development runs fail closed with bounded output.

`/ppo cancel-confirm <request-id>` atomically claims the request before mutation, reinspects the run once, requires the same project/status/version and `canonical_current`, and then performs exactly one fixed `transitionDevelopmentRun` to `cancelled` with actor `phase-6p-quiescent-cancellation` and reason `owner_requested_quiescent_cancellation`.

Phase 6P does not interrupt Codex/tests/review, remove worktrees, delete branches, close PRs, reset repositories, delete run records/history/version markers, invoke recovery, invoke continue, retry, repair, deploy, verify production, roll back production, add a new OpenClaw tool, or use model interpretation.

### Phase 7A - Controlled PPO Start Route

Phase 7A exposes the reviewed Phase 6B planned-run creator through the existing PPO terminal wrapper and existing `ppo_local` direct-tool route:

```text
local-operator/development-start-route.mjs
node local-operator/ppo-command.mjs start <project>
/ppo start <project>
```

The route accepts exactly one project id from the existing six-project registry and rejects missing projects, unknown projects, repo names, paths, task text, SHAs, versions, branches, policies, runtime options, confirmations, actions, extra arguments, malformed whitespace, and control-character input before planning. It calls `createPlannedDevelopmentRun(projectId)` once with only the approved internal Phase 6B invocation. A planned outcome creates one Phase 6A run through the Phase 6B lifecycle and returns bounded output with project, run id, status, next stage, base SHA, and `/ppo continue <run-id>` as the next command only if the child result is internally consistent for project, `planned` status, `planning` or `implementation` next stage, equal plan/run base SHA, and matching run head SHA.

If Phase 6B returns `owner_action_required` or a malformed planned result, Phase 7A returns only bounded owner-action/route-unavailable information and never prints a continuation command for that result. It does not create workspaces, invoke Codex, run tests, run review/hardening, push, create PRs, merge, deploy, verify production, rollback, call `/ppo continue`, add a new OpenClaw tool, or use model interpretation.

### Stage 0 - Local PPO Self-Development Controller

Stage 0 adds `ppo-self-development` as a separate terminal-only macOS controller fixed to `Linardi1328/personal-project-operator`. It reuses the Phase 6B–6G engines, advances at most one boundary per continuation, stops at `merged`, provides read-only status/recovery, and requires exact-version local confirmation for quiescent cancellation or a structurally valid open self-test attempt that has remained stale for at least 30 minutes. A structurally valid stale unmerged `merge_ready` or `merge_started` state uses a separate exact confirmation so a base-advanced run can be retired without weakening SHA binding. `review-retry <run-id> <version> <head-sha> retry-phase6f-review-runtime-failure-v1 --local-owner-confirmed` is limited to a confirmed Phase 6F reviewer-runtime failure; it preserves the clean implementation SHA and exact-SHA test PASS evidence, returns the run to `tests_passed`, and does not reserve a hardening round.

The controller is not imported by `ppo-command.mjs` or the OpenClaw bridge. The ordinary six-project registry and all `/ppo` routes remain unchanged. See `stage-0-ppo-self-development-controller.md`.

Immediately before Phase 6F review or bounded hardening dispatch, the fixed runtime profile performs an ephemeral live Codex model request. Cached `codex login status` alone is not accepted as readiness. Authentication failures are reported separately from other runtime failures, and neither class is treated as a reviewer finding or allowed to reserve review/hardening work during readiness.

Phase 6D, 6E, and 6F continuation now use a private exact-run operation lease bound to phase, attempt, implementation SHA, owner process, and start time. A concurrent continuation refuses a live lease. If the owner disappears, the next continuation waits for the bounded orphan threshold and performs exactly one reconciliation step: Phase 6D commits and verifies recoverable exact-start edits or records a definitive retry boundary, Phase 6E records an ambiguous failed aggregate against the unchanged exact-SHA workspace before retry, and Phase 6F restores the retained exact-SHA implementation/test evidence to `tests_passed`. Mismatched leases, workspaces, SHAs, attempts, or run versions fail closed. Recovery never fabricates PASS or approval evidence and never consumes a hardening round.

## Files

- `project-state.json`: local mock project state for current and placeholder projects.
- `commands.json`: local command catalog and menu grouping.
- `simulate-command.mjs`: dependency-free Node.js ESM simulator.
- `ppo-command.mjs`: dependency-free Node.js ESM wrapper for `/ppo` routing.
- `github-project-registry.mjs`: narrow Phase 2A GitHub repo allowlist.
- `github-readonly.mjs`: dependency-free GitHub read-only client using local `gh api --method GET`.
- `github-readonly-cli.mjs`: terminal-only Phase 2A validation CLI.
- `github-ppo-commands.mjs`: Phase 2B phone-friendly `/ppo repo` and `/ppo pr` formatter.
- `github-ppo-status.mjs`: Phase 2C live GitHub read-only `/ppo status` formatter.
- `github-issue-create.mjs`: Phase 5A terminal-only, confirmation-gated GitHub issue creation.
- `github-issue-approval.mjs`: Phase 5B local pending-request store and `/ppo issue-create`/`/ppo issue-confirm` handlers.
- `project-note-add.mjs`: Phase 5C terminal-only, confirmation-gated append-only project note storage.
- `project-note-approval.mjs`: Phase 5D local pending-request store and `/ppo note-add`/`/ppo note-confirm` handlers.
- `project-state-promote.mjs`: Phase 5E terminal-only, confirmation-gated controlled project-state promotion.
- `phase-5e-project-state-promotion.md`: Phase 5E local usage and safety boundary.
- `development-run-state.mjs`: Phase 6A local-only durable autonomous-development run-state store.
- `phase-6a-development-run-state.md`: Phase 6A local usage and safety boundary.
- `development-next-stage-planner.mjs`: Phase 6B deterministic local next-stage planner.
- `phase-6b-next-stage-planner.md`: Phase 6B local usage and safety boundary.
- `development-workspace-manager.mjs`: Phase 6C deterministic local isolated workspace manager.
- `phase-6c-isolated-workspace-manager.md`: Phase 6C local usage and safety boundary.
- `development-codex-execution-adapter.mjs`: Phase 6D bounded local Codex execution adapter.
- `phase-6d-codex-execution-adapter.md`: Phase 6D local usage and safety boundary.
- `development-test-runner.mjs`: Phase 6E deterministic local automated test runner.
- `phase-6e-automated-test-runner.md`: Phase 6E local usage and safety boundary.
- `development-review-agent.mjs`: Phase 6F independent exact-SHA review agent.
- `development-hardening-orchestrator.mjs`: Phase 6F bounded hardening coordinator that reuses Phase 6D, 6E, and 6F engines.
- `phase-6f-independent-review-agent.md`: Phase 6F local usage and safety boundary.
- `development-acceptance-gate.mjs`: Phase 6G deterministic exact-SHA acceptance gate.
- `github-delivery-agent.mjs`: Phase 6G trusted GitHub delivery, exact-head remote review, and SHA-pinned merge agent.
- `phase-6g-github-delivery.md`: Phase 6G local usage and safety boundary.
- `development-deployment-agent.mjs`: Phase 6H exact-SHA PPO deployment agent.
- `phase-6h-deployment-agent.md`: Phase 6H local usage and safety boundary.
- `development-production-verification-agent.mjs`: Phase 6I read-only PPO production verification agent.
- `phase-6i-production-verification-agent.md`: Phase 6I local usage and safety boundary.
- `development-continue-orchestrator.mjs`: Phase 6K controlled `/ppo continue <run-id>` orchestrator for ordinary six-project runs.
- `development-operation-lease.mjs`: private exact-run Phase 6D/6E/6F owner leases and stale-owner inspection.
- `development-recovery-coordinator.mjs`: Phase 6L local-only read-only development recovery coordinator for ordinary six-project runs.
- `development-recovery-route.mjs`: Phase 6M controlled `/ppo recover <run-id>` route adapter around the Phase 6L coordinator.
- `development-run-catalog.mjs`: Phase 6N local-only read-only development run catalog foundation for ordinary six-project runs.
- `development-run-catalog-route.mjs`: Phase 6O controlled `/ppo runs` and `/ppo run <run-id>` route adapter around the Phase 6N catalog.
- `development-run-cancellation.mjs`: Phase 6P quiescent cancellation engine for exactly eligible ordinary-run statuses.
- `development-run-cancellation-approval.mjs`: Phase 6P single-use `/ppo cancel` and `/ppo cancel-confirm` approval store and handlers.
- `development-start-route.mjs`: Phase 7A controlled `/ppo start <project>` route adapter around the Phase 6B planned-run creator.
- `phase-7a-controlled-ppo-start.md`: Phase 7A local usage and safety boundary.
- `development-self-controller.mjs`: Stage 0 fixed-repository self-development start, status, continuation, recovery, and cancellation composition.
- `development-self-cancellation.mjs`: Stage 0 read-only staging and exact-version local confirmation for quiescent self-development cancellation, including 30-minute stale open self-test and stale unmerged delivery exceptions with no process interruption or GitHub mutation.
- `ppo-self-development-command.mjs`: strict terminal-only Stage 0 command parser.
- `stage-0-ppo-self-development-controller.md`: Stage 0 usage, validation, and safety boundary.
- `codex-prompt-generator.mjs`: Phase 3A local Codex prompt text generator, routed through `/ppo codex` in Phase 3C.
- `codex-planning-tools.mjs`: Phase 3B deterministic Codex planning helpers, routed through `/ppo` in Phase 3C.
- `audit/`: local credential-free GitHub write audit records; JSONL files are ignored by git.
- `write-data/`: local ignored Phase 5B/5D pending request stores and Phase 5C/5D project note store; runtime directories/files are private.
- `github-readonly.test.mjs`: fake-runner tests that do not require live GitHub network access.
- `github-issue-create.test.mjs`: fake-writer and fake-runner tests for Phase 5A write gating and audit behavior.
- `github-issue-approval.test.mjs`: fake-writer tests for Phase 5B staging, expiry, single-use confirmation, concurrency, and safe errors.
- `project-note-add.test.mjs`: local temp-store tests for Phase 5C allowlisting, confirmation, private modes, append-only notes, metadata audit, safe failure handling, and terminal behavior.
- `project-note-approval.test.mjs`: temp-store tests for Phase 5D staging, expiry, single-use confirmation, concurrency, metadata audit preservation, safe errors, `ppo_local` routing, and Phase 5C terminal regression.
- `project-state-promote.test.mjs`: Phase 5E tests for allowlisting, field restrictions, confirmation, git safety, byte preservation, atomic replacement, metadata audit, duplicate/ambiguous behavior, and Phase 5C/5D regressions.
- `development-run-state.test.mjs`: Phase 6A tests for project allowlisting, run ids, private permissions, lifecycle transitions, stale/concurrent writes, recovery, history integrity, bounded inputs, evidence metadata, safe errors, and Phase 5 regressions.
- `development-next-stage-planner.test.mjs`: Phase 6B tests for deterministic planning, source-state refusal modes, GitHub read-only boundaries, Phase 6A integration, stale expected-version refusal, and route/execution exclusions.
- `development-workspace-manager.test.mjs`: Phase 6C tests for planned-run gating, repo identity/base SHA preflight, dirty repo refusal, managed workspace path safety, branch/worktree creation, run-state transition, reconciliation, cleanup, ambiguous outcomes, and execution-boundary regressions.
- `development-codex-execution-adapter.test.mjs`: Phase 6D tests for implementation-run gating, workspace reconciliation, trusted Codex config, macOS/Linux no-outbound-network sandbox backend contracts, remote-write and direct-network bypass denial, durable attempt accounting, prompt bounds, ambiguous execution, independent Git verification, implementation evidence, reconciliation, and route/execution-boundary regressions.
- `development-test-runner.test.mjs`: Phase 6E tests for implementation-ready gating, exact expected-version checks, workspace/branch/head reconciliation, Phase 6D implementation evidence matching, trusted test policy enforcement, explicit argv and `shell: false`, sanitized env, no-network sandbox enforcement, bounded attempts, pass/failure/ambiguous outcomes, dirty/changed workspace refusal, reconciliation, SHA-pinned metadata-only evidence, and route/execution-boundary regressions.
- `development-review-agent.test.mjs`: Phase 6F tests for tests-passed gating, exact expected-version checks, workspace/branch/head/clean reconciliation, exact Phase 6D/6E evidence requirements, trusted reviewer config, no-network plus read-only workspace/source sandbox enforcement, explicit argv and `shell: false`, bounded prompt/output, strict review schema validation, approval/blocker/owner-action outcomes, ambiguous reconciliation, SHA-pinned metadata-only evidence, no workspace or source mutation, and route/execution-boundary regressions.
- `development-hardening-orchestrator.test.mjs`: Phase 6F hardening tests for review-changes gating, exact expected-version checks, validated durable findings, remediation context derivation, fail-safe hardening prompt bounds, Phase 6D/6E/6F reuse, new descendant SHAs, fresh tests and review, three-round cap, owner escalation, ambiguous-stop reconciliation, metadata-only evidence, and route/execution-boundary regressions.
- `github-delivery-agent.test.mjs`: Phase 6G tests for deterministic acceptance, exact SHA push, origin/repo identity, no-force/idempotent push, ambiguous push reconciliation, PR create/reuse/refusal/recovery, remote head validation, exact-head CI, independent remote review, merge-ready gating, expected-head merge, ambiguous merge reconciliation, metadata-only evidence, optimistic state, and route/deployment/write-surface exclusions.
- `development-deployment-agent.test.mjs`: Phase 6H tests for merged-run gating, exact Phase 6G evidence, trusted PPO deployment profile, exact merge-SHA checkout, success/failure transitions, ambiguous deployment reconciliation, metadata-only evidence, and route/rollback/verification exclusions.
- `development-production-verification-agent.test.mjs`: Phase 6I tests for deployed-run gating, exact Phase 6H evidence, fixed PPO profile reuse, read-only verification result validation, success/failure transitions, ambiguous reconciliation, metadata-only evidence, and route/rollback/deployment/model exclusions.
- `development-continue-orchestrator.test.mjs`: Phase 6K tests for one-boundary dispatch, run-id parsing, caller-option refusal, stale-state handling, open-attempt refusal, production cutoff, bounded output, concurrency, and static production exclusions.
- `development-recovery-coordinator.test.mjs`: Phase 6L tests for status recovery dispatch, read-only child composition, policy identity reuse, durable-state change detection, bounded output, and static mutation/production exclusions.
- `development-recovery-route.test.mjs`: Phase 6M tests for strict recover routing, bounded output, Phase 6L single invocation, terminal parser rejection, self-development out-of-scope handling, and static continue/production exclusions.
- `development-run-catalog.test.mjs`: Phase 6N tests for run-id discovery, exact bounded summaries, terminal status derivation, self-development exclusion, canonical-state classifications, corrupt/unsafe store handling, fixed catalog bounds, formatter boundaries, static no-route/no-mutation exclusions, and zero filesystem mutation sentinels.
- `development-run-catalog-route.test.mjs`: Phase 6O tests for route adapter composition, strict wrapper parsing, bridge-safe command exposure, real catalog invariants through `/ppo runs` and `/ppo run <run-id>`, bounded output, stale/fail-closed behavior, and static recovery/continue/production exclusions.
- `development-run-cancellation.test.mjs`: Phase 6P tests for exact status eligibility, read-only preflight, successful cancellation invariants, formatter hardening, self-development exclusion, and static recovery/continue/production exclusions.
- `development-run-cancellation-approval.test.mjs`: Phase 6P tests for request TTL/id policy, private pending/claimed store safety, single-use and concurrent confirmation, stale-state handling, wrapper parsing, and self-development confidentiality.
- `development-start-route.test.mjs`: Phase 7A tests for all six projects, Phase 6B single-run creation, owner-action-required zero-write behavior, strict terminal parsing, bounded output, and static no-model/no-production/no-new-tool exclusions.
- `github-ppo-commands.test.mjs`: fake-client tests for Phase 2B command formatting and safe errors.
- `github-ppo-status.test.mjs`: fake-client tests for Phase 2C status formatting, bounded reads, and partial failures.
- `codex-prompt-generator.test.mjs`: fake-doc and fake-client tests for deterministic prompt generation.
- `codex-planning-tools.test.mjs`: network-free tests for budget estimates, prompt-size review, task splitting, and terminal/Phase 3C routing boundaries.

## Requirements

- Node.js installed locally.
- GitHub CLI installed locally for Phase 2A live terminal validation.
- No npm install required.
- No OpenClaw dependency is installed in this repo.

OpenClaw should be installed separately during local testing.

Check Phase 2A local GitHub prerequisites with:

```bash
gh --version
gh auth status
```

If authentication is missing, run `gh auth login` outside this repository and retry `gh auth status`. Do not paste tokens or credentials into this repository, tests, fixtures, Markdown, logs, or chat.

## Safety boundary

The simulator is local-only and read-only.

It does not:

- call GitHub APIs
- call Telegram APIs
- scrape Codex usage
- deploy to a VPS
- store secrets
- write to external systems
- modify OpenClaw local config

The Phase 2A GitHub read-only client is also read-only:

- it queries only the fixed allowlist of connected-candidate repos
- it rejects arbitrary owner/repo strings before any GitHub request
- its `gh` transport rejects endpoints outside Phase 2A repo metadata, commits, pulls, and issues before execution
- it invokes `gh` through Node `execFile` without a shell
- it sends only `gh api --method GET` requests
- it uses small bounded page sizes
- it normalizes responses into compact objects
- it sanitizes GitHub-sourced text before values can reach terminal output
- it filters pull requests out of the GitHub issues endpoint
- it does not store or log credentials
- it does not create branches, comments, labels, reviews, approvals, closes, merges, workflow dispatches, commits, or pushes

Phase 2A failure modes:

- `GITHUB_CLI_UNAVAILABLE`: `gh` is not installed or not on `PATH`; verify with `gh --version`.
- `GITHUB_CLI_UNAUTHENTICATED`: `gh` is installed but not authenticated; verify with `gh auth status`.
- `GITHUB_REPO_UNAVAILABLE`: the project is allowlisted, but the repo is unavailable or permission is denied.
- `GITHUB_API_FAILED`: the GitHub API call failed after the local `gh` and project checks passed.
- `MALFORMED_GITHUB_RESPONSE`: `gh` returned non-JSON or an unexpected response shape.

Phase 2B uses the same read-only client for `/ppo repo <project>` and `/ppo pr <project>`. It does not add README, contents/tree, language, workflow, branch, collaborator, release, changed-file, CI/check, review, comment, diff, recommendation, GraphQL, or write endpoints.

Phase 2C uses the same read-only client for `/ppo status`. Issue counts are conservative when the raw bounded issues page hits the page limit after pull requests are filtered out. It does not add recommendations, stale-project detection, `/ppo next`, Codex prompt generation, new endpoint families, GraphQL, or write actions.

Phase 3A generates local prompt text only. It reads only fixed mapped project docs plus approved GitHub read-only context. It does not invoke Codex, call OpenAI APIs, create commits, open PRs, or change target repos.

Phase 3B generates local planning text only. `codex-budget`, `prompt-size`, and `split-task` do not invoke Codex, call OpenAI APIs, call another model, execute plans, inspect Codex usage, add GitHub endpoints, mutate repositories, or deploy services. Planning task and draft text is inert data; shell-looking punctuation and paths are not executed or interpreted.

Phase 3C routes `/ppo codex`, `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` through `ppo_local`. It preserves direct OpenClaw tool dispatch with no model turn, no new OpenClaw tools, no new permissions, no writes, and no new GitHub endpoints.

Phase 5A allows exactly one write action from the terminal wrapper: `issue-create <project> <title> [body...]`. The command:

- resolves projects through the six-project connected registry only
- permits only `POST /repos/<approved repo>/issues`
- sends only `title` and `body` fields
- invokes `gh` through `execFile` with `shell: false`, fixed argv shape, bounded timeout, and bounded output buffer
- rejects arbitrary repos, endpoints, methods, unsafe input, oversized input, comments, labels, branches, commits, PR writes, merges, workflow dispatches, project-state updates, and deployment behavior
- requires exact `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>` before any network write
- records a credential-free local audit trail without title/body contents, tokens, or environment values
- fails closed before confirmed writes if auditing cannot be established

Phase 5B adds exactly one approval-gated chat write workflow through the existing `ppo_local` tool. `/ppo issue-create <project> <title> [--body <body>]` stages only and performs zero GitHub writes. `/ppo issue-confirm <request-id>` atomically claims one matching unexpired request, consumes the id and pending content before any network write, and then reuses the Phase 5A writer with internal confirmation. Unknown, expired, already-consumed, malformed, or replayed ids perform zero GitHub writes. The chat path must not accept or expose terminal write confirmation environment values.

Pending issue requests default to `local-operator/write-data/` for local use. Set `PPO_WRITE_DATA_DIR` to move the private pending store. Set `PPO_GITHUB_WRITE_AUDIT_PATH` to move the credential-free audit trail.

Phase 5C project notes use the same `PPO_WRITE_DATA_DIR` root and append note records under `${PPO_WRITE_DATA_DIR}/project-notes`. The command creates private `0700` directories and `0600` files, appends one fsynced durable record per confirmed action, and never edits, deletes, or replaces prior notes. Each record includes a random opaque note id, timestamp, project metadata, and the note text. The separate note audit trail is metadata-only and excludes note text, confirmation values, request ids, tokens, and raw failures. If attempted audit cannot be established, no note is appended; if append succeeds but success audit fails, the command warns that the note may have been written and should be inspected before retrying.

Phase 5C does not route `note-add` through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It does not call GitHub, create issues, comments, labels, branches, PRs, commits, merges, workflow dispatches, deployments, model calls, or mutate `projects/*.md` or project-state files.

Phase 5D adds exactly one approval-gated chat note workflow through the existing `ppo_local` tool. `/ppo note-add <project> <note...>` stages only and performs zero note writes. `/ppo note-confirm <request-id>` atomically claims one matching unexpired request, consumes the id and pending content before any note write, and then reuses the Phase 5C writer with internal confirmation. Unknown, expired, already-consumed, malformed, or replayed ids perform zero note writes. The chat path must not accept or expose terminal note confirmation environment values.

Pending note requests use `${PPO_WRITE_DATA_DIR}/pending-project-notes`. The store uses private `0700` directories and `0600` files, persists note text only temporarily for the pending request, and deletes consumed or expired content. The Phase 5C note audit remains metadata-only and does not include Phase 5D request ids.

Phase 5E allows exactly one terminal-only project-state mutation workflow. `state-promote <project> <note-id> <field>` accepts only `current-phase`, `last-known-status`, or `next-action`, requires the durable note to belong to the selected allowlisted project, and requires exact tuple-specific `PPO_PROJECT_STATE_CONFIRM` confirmation. It refuses `main` and dirty targets, rechecks target bytes before mutation, preserves all bytes outside the selected section, and performs atomic durable replacement with metadata-only audit. It adds no `/ppo state-promote`, GitHub API writes, model calls, deployments, or mutating git command path.

Phase 6A adds only local run-state storage for future autonomous-development coordination. It creates private records under `${PPO_WRITE_DATA_DIR}/development-runs`, rejects arbitrary run ids and non-allowlisted projects, bounds records/history/evidence, enforces explicit lifecycle transitions with expected-version optimistic concurrency, and stores only structured SHA-pinned metadata. It adds no command route, model call, Codex execution, test execution, GitHub write, git mutation, deployment/service control, rollback, Telegram/OpenClaw route, or `/ppo continue`.

Phase 6B adds deterministic local next-stage planning only. It reads the fixed project doc for one allowlisted project, `ROADMAP.md`, and Phase 2 GitHub read-only snapshot facts, then returns either a bounded plan for a `planning` or `implementation` next stage or a safe `owner_action_required` result. It may use Phase 6A primitives to create or plan a run through `created -> planning_in_progress -> planned`; it does not skip lifecycle states and does not add a wrapper command, `/ppo` route, model call, Codex execution, tests, review automation, GitHub writes, branch/worktree operations, deployment/service control, rollback, or `/ppo continue`.

Phase 6C adds deterministic local workspace preparation only. It accepts a Phase 6A run only in `planned`, requires exact expected-version checks, reads source repository locations only from a trusted project workspace registry, verifies repo identity and base SHA before mutation, creates one isolated branch/worktree under `${PPO_WRITE_DATA_DIR}/development-workspaces` or an explicitly configured PPO-managed workspace root, and transitions only `planned -> implementation_in_progress` after verification. It does not add a wrapper command, `/ppo` route, model call, Codex execution, implementation-file edit, test execution, review automation, GitHub writes, PR automation, merge, deployment/service control, rollback, or `/ppo continue`.

Phase 6D adds bounded local Codex execution only. It accepts a Phase 6A run only in `implementation_in_progress`, requires exact expected-version checks, reconciles the Phase 6C workspace before execution, and uses fixed `codex exec` argv with the native no-network `:workspace` Linux command sandbox on the Ubuntu 24.04 VPS. It records bounded implementation attempts durably, creates the local commit only after successful sandboxed edits, verifies a new clean descendant commit, and transitions only `implementation_in_progress -> implementation_ready`. It does not add a wrapper command, `/ppo` route, automated test execution, review automation, hardening loop, GitHub writes, PR automation, merge, deployment/service control, rollback, production verification, or `/ppo continue`.

Phase 6E adds bounded local automated testing only. It accepts a Phase 6A run after `implementation_ready`, requires exact expected-version checks, verifies Phase 6D implementation evidence and Phase 6C workspace HEAD against `run.headSha`, runs only trusted per-project test policy steps with explicit argv and `shell: false`, keeps tests in a verified no-outbound-network sandbox, refuses dirty/changed workspaces, records metadata-only test evidence, and transitions only `tests_in_progress -> tests_passed` after all required tests pass. It does not add a wrapper command, `/ppo` route, Codex/model call, automated review, hardening loop, GitHub writes, PR automation, merge, deployment/service control, rollback, production verification, or `/ppo continue`.

Phase 6F adds bounded local independent review and hardening only. It accepts a Phase 6A run after `tests_passed`, requires exact expected-version checks, verifies Phase 6D implementation evidence and Phase 6E PASS evidence against `run.headSha`, runs only a trusted locally configured review executable with explicit argv and `shell: false`, keeps review inside the verified no-outbound-network plus read-only sandbox covering the workspace, workspace Git state, and canonical source checkout, refuses dirty/changed workspaces, validates strict structured reviewer output, records metadata-only review evidence, and transitions only `review_in_progress -> review_passed` after valid exact-SHA approval. Valid blockers or owner/security ambiguity transition to `review_changes_requested`. A valid `CHANGES_REQUESTED` run may enter at most three automatic hardening rounds, each reusing Phase 6D implementation, Phase 6E testing, and Phase 6F review. Every new implementation SHA invalidates prior tests and review; fresh tests and fresh independent review are required. It does not add a wrapper command, `/ppo` route, unbounded hardening loop, GitHub writes, PR automation, push, merge, deployment/service control, rollback, production verification, or `/ppo continue`.

Owner test plan after branch review:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs repo khlim-assist
node local-operator/ppo-command.mjs repo rbl-content-engine
node local-operator/ppo-command.mjs pr khlim-assist
node local-operator/ppo-command.mjs pr rbl-content-engine
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
node local-operator/ppo-command.mjs codex rbl-content-engine "organize source asset workflow"
node local-operator/ppo-command.mjs codex portfolio "harden contact form error handling"
node local-operator/ppo-command.mjs codex khlim-assist "add GitHub integration, Telegram routing, VPS deployment, and write actions"
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build the whole operator. Add GitHub integration. Add Telegram routing. Add VPS deployment. Add write actions. Repeat all background and future phases."
node local-operator/ppo-command.mjs split-task "add GitHub integration, Telegram bot, Codex prompt generator, VPS deployment, and write actions"
node local-operator/ppo-command.mjs "/ppo split-task add GitHub integration and Telegram routing"
node local-operator/ppo-command.mjs "/ppo prompt-size Goal: keep line structure
Requirements:
- preserve multiline input"
node local-operator/ppo-command.mjs issue-create khlim-assist "owner review test issue"
node local-operator/ppo-command.mjs note-add khlim-assist "owner review local note"
node local-operator/ppo-command.mjs "/ppo issue-create khlim-assist owner review test issue --body created only after confirmation"
node local-operator/ppo-command.mjs "/ppo note-add khlim-assist owner review staged note"
node local-operator/ppo-command.mjs /ppo start khlim-assist
node local-operator/ppo-command.mjs /ppo runs
node local-operator/ppo-command.mjs /ppo run <run-id>
node local-operator/ppo-command.mjs /ppo cancel <run-id>
node local-operator/ppo-command.mjs /ppo cancel-confirm <request-id>
node local-operator/ppo-command.mjs /ppo continue <run-id>
node local-operator/ppo-command.mjs /ppo recover <run-id>
```

Phase 6K adds `/ppo continue <run-id>` for existing ordinary development runs. Phase 6M adds `/ppo recover <run-id>` for one read-only Phase 6L recovery observation. Phase 6O adds `/ppo runs` and `/ppo run <run-id>` for the reviewed Phase 6N read-only ordinary-run catalog. Phase 6P adds confirmation-gated `/ppo cancel <run-id>` and `/ppo cancel-confirm <request-id>` for quiescent ordinary-run cancellation only. Phase 7A adds `/ppo start <project>` for controlled Phase 6B planned-run creation only. Phase 6H deployment, Phase 6I production verification, and Phase 6J rollback remain local-only and are not routed through OpenClaw/Telegram.

Then through OpenClaw/Telegram after review:

```text
/ppo status
/ppo repo khlim-assist
/ppo repo rbl-content-engine
/ppo pr khlim-assist
/ppo pr rbl-content-engine
/ppo codex rbl-content-engine organize source asset workflow
/ppo codex-budget ledgerpilot-ai add invoice import workflow
/ppo prompt-size Goal: keep line structure
Requirements:
- preserve multiline input
/ppo split-task add GitHub integration and Telegram routing
/ppo issue-create khlim-assist owner review test issue --body created only after confirmation
/ppo issue-confirm <request-id>
/ppo note-add khlim-assist owner review staged note
/ppo note-confirm <request-id>
/ppo start khlim-assist
/ppo runs
/ppo run <run-id>
/ppo cancel <run-id>
/ppo cancel-confirm <request-id>
/ppo continue <run-id>
/ppo recover <run-id>
```

Phase 5E remains terminal-only; do not add `/ppo state-promote` to the OpenClaw/Telegram owner test until a later separately reviewed phase.

Phase 7A `/ppo start <project>` creates at most one planned Phase 6B development run and never calls `/ppo continue`. Phase 6M `/ppo recover <run-id>` is diagnostic/read-only and never calls `/ppo continue`. Phase 6O `/ppo runs` and `/ppo run <run-id>` are read-only catalog routes and never call `/ppo recover` or `/ppo continue`. Phase 6P `/ppo cancel <run-id>` stages only and `/ppo cancel-confirm <request-id>` performs only one confirmed quiescent cancellation; they never interrupt processes, clean workspaces, recover, continue, retry, repair, or touch production. Do not add `/ppo develop`, run search, arbitrary run filters/sorts, automatic continuation after start, process-interruption cancellation, retry, repair, production deployment, production verification, rollback, or broader recovery workflows to the OpenClaw/Telegram owner test until later separately reviewed phases.

## OpenClaw handoff shape

Future OpenClaw routing can treat this simulator as the command behavior reference:

```text
incoming /ppo chat text -> OpenClaw route -> local operator wrapper -> phone-style response
```

Phase 1 proves the command output shape only. Live integrations belong to later phases.
