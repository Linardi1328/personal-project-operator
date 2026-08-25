# Safety Rules

## Read-only first

The operator must inspect, summarize, plan, and generate prompts before it is allowed to mutate anything.

## Always blocked in Phase 0

- Merge PRs.
- Push code.
- Delete branches.
- Deploy production changes.
- Send customer messages.
- Expose secrets.
- Change credentials.
- Execute trades.
- Make paid API calls without explicit approval.
- Perform destructive file operations.
- Register live Telegram commands.
- Scrape Codex usage.

## Phase 1 local simulator boundary

Phase 1 may run the local Node.js simulator for `/status`, `/menu`, and `/help`.

Phase 1.5 may run the local `/ppo` wrapper for OpenClaw Telegram routing preparation.

The simulator and wrapper must use local fixture files only and must not:

- call GitHub APIs
- call Telegram APIs
- scrape Codex usage
- deploy to VPS
- store secrets
- write to external systems
- edit `~/.openclaw`
- override OpenClaw built-in commands

## Phase 2A GitHub read-only boundary

Phase 2A may run terminal-only GitHub read-only validation for the fixed connected-candidate repos.

The GitHub client must:

- resolve project ids through a fixed allowlist before any API call
- reject future, paused, unknown, arbitrary repo, or injection-style input before any API call
- use local `gh api --method GET` only
- use Node `execFile` without a shell
- normalize compact repo, commit, PR, issue, and snapshot objects
- keep `/ppo repo`, `/ppo pr`, and other GitHub Telegram commands disabled until Phase 2B approval

The GitHub client must not store or log credentials, create branches, create comments, change labels, review, approve, close, merge, dispatch workflows, commit code, or push code in target project repos.

## Approval rules for future phases

Future write actions require:

- explicit user approval
- clear command name
- clear target project
- clear intended change
- documented danger level
- audit trail

## Phase 5A controlled terminal issue-create boundary

Phase 5A allows exactly one terminal-only write action:

```text
node local-operator/ppo-command.mjs issue-create <project> <title> [body...]
```

The command must:

- resolve project ids only through the existing six-project registry
- permit only `POST /repos/<approved repo>/issues`
- send only `title` and `body` fields
- require exact `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>` before any network write
- show a deterministic preview and refuse the write when confirmation is missing or mismatched
- create a credential-free durable audit trail for refused, attempted, succeeded, and failed write actions
- fail closed before confirmed writes if audit logging cannot be established

Phase 5A must not route `issue-create` through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It must not create or update PRs, comments, labels, branches, commits, merges, workflow dispatches, project-state files, VPS deployment, or any other GitHub write.

## Phase 5B approval-gated chat issue-create boundary

Phase 5B allows exactly two `/ppo` chat commands through the existing `ppo_local` direct-tool path:

```text
/ppo issue-create <project> <title> [--body <body>]
/ppo issue-confirm <request-id>
```

`/ppo issue-create` must not call GitHub. It validates the project id, title, and body using the Phase 5A rules, prints the deterministic issue preview, stores the exact normalized intent in the private local pending store, and returns only `/ppo issue-confirm <request-id>`.

`/ppo issue-confirm` must atomically claim one matching unexpired request before any network write. Claiming consumes the id, and the persisted request content is deleted before the Phase 5A writer is invoked. Unknown, expired, already-consumed, malformed, or replayed request ids must not perform GitHub writes.

The chat path must not accept or print terminal write confirmation environment values. Confirmation is internal to the local operator process. Pending request directories must be `0700`, pending files must be `0600`, request ids must be cryptographically random and opaque, and requests expire after 10 minutes.

Phase 5B must not add a model turn, new OpenClaw tools, provider access, arbitrary GitHub endpoints, comments, labels, assignees, milestones, PR/branch/commit/merge/workflow writes, project-state mutations, deployment behavior, or any write other than creating one approved GitHub issue after single-use confirmation.

## Phase 5C controlled terminal project-note boundary

Phase 5C allows exactly one terminal-only local write action:

```text
node local-operator/ppo-command.mjs note-add <project> <note...>
```

The command must:

- resolve project ids only through the existing six-project registry
- treat note text as inert data
- reject empty, oversized, terminal-control, or escape-sequence input
- require exact `PPO_NOTE_WRITE_CONFIRM=add-note:<project>` before appending a note
- show a deterministic preview and refuse the append when confirmation is missing or mismatched
- store notes under `${PPO_WRITE_DATA_DIR}/project-notes`
- use private `0700` directories and `0600` files
- append one durable fsynced note record per confirmed action
- assign a cryptographically random opaque note id plus timestamp/project metadata
- create credential/content-free audit records for refused, attempted, succeeded, and failed actions
- fail closed before note mutation if the attempted audit record cannot be established
- warn that the note may have been written if append succeeds but success audit fails

Phase 5C must not route `note-add` through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It must not call GitHub APIs, create issues, comments, labels, PRs, branches, commits, merges, workflow dispatches, project-state mutations, deployment behavior, model calls, or new OpenClaw tools.

## Phase 5D approval-gated chat project-note boundary

Phase 5D allows exactly two `/ppo` chat commands through the existing `ppo_local` direct-tool path:

```text
/ppo note-add <project> <note...>
/ppo note-confirm <request-id>
```

`/ppo note-add` must not append a note. It validates the project id and note using Phase 5C rules, rejects chat input containing `PPO_NOTE_WRITE_CONFIRM`, prints a deterministic preview with project/repo/note length but not note text, stores the exact normalized intent in the private local pending store, and returns only `/ppo note-confirm <request-id>`.

`/ppo note-confirm` must atomically claim one matching unexpired request before any note write. Claiming consumes the id, and the persisted request content is deleted before the Phase 5C writer is invoked with internal `add-note:<project>` confirmation. Unknown, expired, already-consumed, malformed, or replayed request ids must not append notes.

Pending request directories must be `0700`, pending files must be `0600`, request ids must be cryptographically random and opaque, and requests expire after 10 minutes. The note audit trail must remain metadata-only and must not include note text, Phase 5D request ids, terminal confirmation values, tokens, or raw failures.

Phase 5D must not add a model turn, new OpenClaw tools, GitHub API writes, comments, labels, issues, PR/branch/commit/merge/workflow writes, project-state mutations, deployment behavior, or any write other than appending one approved local note after single-use confirmation.

## Phase 6A development run-state boundary

Phase 6A allows one local-only storage foundation:

```text
local-operator/development-run-state.mjs
```

The store must:

- resolve projects through the existing six-project registry only
- generate cryptographically random opaque run ids
- store records under `${PPO_WRITE_DATA_DIR}/development-runs`
- create `0700` directories and `0600` files
- maintain one canonical run record with project, bounded task, status, stage, base SHA, optional branch/head SHA, attempt counters, timestamps, structured evidence metadata, and transition history
- use fsynced temp-file writes, atomic rename, and directory fsync for canonical replacement
- use durable version guards and expected-version checks so stale agents cannot overwrite newer state
- reject invalid, skipped, terminal, and backward lifecycle transitions outside the explicit transition graph
- bound input, metadata, evidence, record, history, and attempt sizes
- reject secrets, raw credentials, raw errors, raw stdout/stderr, stack traces, terminal confirmation values, and terminal control input
- return deterministic safe errors

Phase 6A must not add planner logic, model calls, Codex execution, test execution, GitHub writes, PR automation, branch/commit/merge operations, deployment/service control, rollback, `/ppo continue`, Telegram/OpenClaw routes, or new OpenClaw tools.

## Phase 6B next-stage planner boundary

Phase 6B allows one local-only deterministic planner foundation:

```text
local-operator/development-next-stage-planner.mjs
```

The planner must:

- resolve project ids through the existing six-project registry only
- read only the fixed selected `projects/<project>.md`, `ROADMAP.md`, and Phase 2 GitHub read-only snapshot facts
- reject arbitrary repo names, arbitrary paths, traversal, globs, and unsupported source locations
- return bounded structured output with project, current state, source-backed next task, next stage, base SHA, source evidence, and planner outcome
- return `owner_action_required` for missing, malformed, contradictory, ambiguous, already-complete, product-choice-dependent, unsafe, unsupported, or missing-GitHub-fact state
- reuse Phase 6A run-state primitives for run creation and transitions
- transition runs only through `created -> planning_in_progress -> planned`
- require exact expected-version checks for existing-run planning
- attach metadata-only SHA-pinned planning evidence without secrets or raw logs

Phase 6B must not add workspace creation, branch/worktree operations, Codex execution, model calls, automated tests, review automation, PR automation, GitHub writes, merges, deployment/service control, rollback, `/ppo continue`, Telegram/OpenClaw routes, or new OpenClaw tools.

## Phase 6C isolated workspace manager boundary

Phase 6C allows one local-only workspace preparation foundation:

```text
local-operator/development-workspace-manager.mjs
```

The manager must:

- resolve projects through the existing six-project registry only
- reuse Phase 6A run-state records and accept only `planned` runs
- require exact expected-version checks before run-state transition
- read repository locations only from a trusted configured project workspace registry
- reject repository paths from user text, task text, planner output, project Markdown, or arbitrary traversal
- verify source repository identity and `run.baseSha` before creating a branch or worktree
- refuse missing, unsafe, symlinked, non-Git, dirty, identity-mismatched, or base-SHA-missing source repos
- generate a deterministic bounded branch name and validate it with Git
- create the branch exactly at `run.baseSha`
- create the worktree only under a PPO-managed workspace root
- reject path traversal, symlink escapes, nested source/workspace roots, duplicate ownership, and collisions
- use explicit argv Git execution without shell interpolation
- transition only `planned -> implementation_in_progress` after branch/worktree verification
- attach metadata-only SHA-pinned implementation evidence
- provide read-only inspection for restart recovery
- fail closed on ambiguous mutation outcomes

Phase 6C must not invoke Codex or models, edit implementation files, run tests, automate review, call GitHub writes, push, merge, deploy, restart services, roll back, add `/ppo continue`, add Telegram/OpenClaw routes, or add new OpenClaw tools.

## Phase 6D Codex execution adapter boundary

Phase 6D allows one local-only Codex execution foundation:

```text
local-operator/development-codex-execution-adapter.mjs
```

The adapter must:

- reuse Phase 6A run-state records and Phase 6C workspace reconciliation
- accept only `implementation_in_progress` runs
- require exact expected-version checks before run-state transition
- refuse missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, or outside-managed-root workspaces
- require workspace HEAD to match the run head/base state before Codex starts
- read Codex executable path, explicit sandbox backend configuration, Git executable path, argv, timeout, and environment only from trusted local configuration
- establish and verify the no-outbound-network native command sandbox before spawning Codex
- use the Linux network-namespace backend for Ubuntu 24.04 production only when a sandboxed preflight proves non-root execution, zero effective capabilities, and `NoNewPrivs: 1`
- keep Git wrapper/env remote-write denial only as defense in depth
- invoke fixed `codex exec` argv with `shell: false`, bounded timeout/output capture, and `cwd` set only to the verified workspace while generated commands remain sandboxed
- generate a deterministic bounded prompt with no-push, no-merge, no-deploy, no-credential-change, no-destructive-operation, and isolated-workspace boundaries
- record bounded implementation attempts durably in the Phase 6A run record
- treat timeout, signal, killed/interrupted process, output overflow, or uncertain completion as ambiguous
- create the local commit only after successful sandboxed edits and verify resulting Git state independently rather than trusting Codex prose
- require a clean workspace and a new local descendant implementation commit
- transition only `implementation_in_progress -> implementation_ready` after verification
- attach metadata-only SHA-pinned implementation evidence
- provide read-only reconciliation for interrupted execution

Phase 6D must not add automated test execution, independent review, hardening loops, PR automation, GitHub writes, push, merge, deployment/service control, rollback, production verification, `/ppo continue`, Telegram/OpenClaw routes, or new OpenClaw tools.

## Phase 6E automated test runner boundary

Phase 6E allows one local-only automated test foundation:

```text
local-operator/development-test-runner.mjs
```

The runner must:

- reuse Phase 6A run-state records and Phase 6C workspace reconciliation
- accept initial execution only after `implementation_ready`
- require exact expected-version checks before run-state transition
- require Phase 6D implementation evidence SHA to equal `run.headSha`
- refuse missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, outside-managed-root, dirty, or head-mismatched workspaces
- require workspace branch and HEAD to match `run.headSha` before and after tests
- read tests only from a trusted local per-project policy registry
- refuse arbitrary command strings, shell interpolation, package-manager scripts, untrusted executables, and secret-bearing env values
- invoke test commands through explicit argv, `shell: false`, bounded timeout/output capture, sanitized env, and `cwd` set only to the verified workspace
- establish and verify the no-outbound-network command sandbox before executing tests
- record bounded testing attempts durably in the Phase 6A run record
- treat timeout, signal, killed/interrupted process, output overflow, or uncertain completion as ambiguous
- transition only to `tests_passed` after all required tests pass for the exact implementation SHA
- attach metadata-only SHA-pinned test evidence
- provide read-only reconciliation for interrupted testing and pass-evidence validity

Phase 6E may invoke the local `codex sandbox linux` helper only to enforce the reviewed test command boundary; it must not invoke `codex exec`, models, automated review, hardening loops, GitHub writes, push, PR creation, merge, deployment, service restart, rollback, production verification, new `/ppo continue` routing, Telegram/OpenClaw routes, or new OpenClaw tools.

## Phase 6F independent review and bounded hardening boundary

Phase 6F allows one local-only independent exact-SHA review and bounded hardening foundation:

```text
local-operator/development-review-agent.mjs
local-operator/development-hardening-orchestrator.mjs
```

The agent must:

- reuse Phase 6A run-state records and Phase 6C workspace reconciliation
- accept initial execution only after `tests_passed`
- require exact expected-version checks before run-state transition
- require Phase 6D implementation evidence SHA to equal `run.headSha`
- require Phase 6E PASS evidence SHA to equal `run.headSha`
- refuse missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, outside-managed-root, dirty, or head-mismatched workspaces
- require workspace branch, HEAD, and clean tree to match `run.headSha` before and after review
- invoke only a trusted locally configured reviewer executable
- refuse arbitrary reviewer command strings, shell interpolation, package-manager scripts, untrusted reviewer executables, implementation adapters as reviewer commands, GitHub write tools, push/merge/deploy tooling, OpenClaw, and secret-bearing env values
- invoke the reviewer through explicit argv, `shell: false`, bounded timeout/output capture, sanitized env, and `cwd` set only to the verified workspace
- establish and verify an explicit no-outbound-network plus read-only workspace/source OS/process sandbox before executing review
- on macOS, deny reviewer file writes under the verified workspace, workspace Git state, and canonical source checkout with `sandbox-exec`
- on Linux, require a trusted read-only workspace/source mount/bind/mount-namespace wrapper or equivalent OS boundary
- verify local read access, workspace file-write denial, source working-tree file-write denial, local Git mutation denial, and outbound-network denial before reserving a review attempt
- generate a deterministic bounded prompt from bounded task text, metadata-only evidence, bounded local diff/file facts, and approved security/scope requirements
- state in the review prompt that `APPROVED` requires `mergeAllowed=true` and empty blockers/security findings/tests required, while `CHANGES_REQUESTED` and `OWNER_ACTION_REQUIRED` require `mergeAllowed=false`
- validate only strict structured reviewer output and fail closed on malformed, contradictory, oversized, uncertain, unparseable, or wrong-SHA output
- record bounded review attempts durably in the Phase 6A run record
- treat timeout, signal, killed/interrupted process, output overflow, or uncertain completion as ambiguous
- transition only to `review_passed` after valid approval for the exact implementation SHA
- transition to `review_changes_requested` for valid blockers or owner/product/security ambiguity
- attach metadata-only SHA-pinned review evidence
- provide read-only reconciliation for interrupted review and exact-SHA approval validity
- start hardening only from valid `review_changes_requested` evidence for exactly `run.headSha`
- derive remediation context only from durable validated review evidence, never chat, user input, model prose, repository commands, or shell strings
- include every validated remediation item and all mandatory isolated-workspace, no-push, no-merge, no-deploy, no-credential, and no-destructive-operation boundaries in Phase 6D hardening prompts; trim only optional task/planning context or fail closed
- reuse Phase 6D implementation, Phase 6E testing, and Phase 6F review engines without parallel engines
- require each remediation to produce a new verified descendant implementation SHA
- invalidate prior test and review evidence after every implementation SHA change
- rerun tests and independent review for the new exact SHA
- cap automatic hardening at three durable rounds and record owner-action-required evidence on non-convergence
- stop on ambiguous Codex, test, or review outcomes until reconciliation

Phase 6F must not create parallel implementation/test/review engines, accept arbitrary remediation text, harden beyond the three-round cap, call GitHub writes, push, create PRs, merge, deploy, restart services, roll back, perform production verification, add `/ppo continue`, add Telegram/OpenClaw routes, or add new OpenClaw tools.

## Phase 6G acceptance and GitHub delivery boundary

Phase 6G allows deterministic exact-SHA delivery after local Phase 6F approval:

- accept only exact-version `review_passed` runs whose implementation, tests, local review, and workspace HEAD all match `run.headSha`
- push only the approved implementation SHA to the approved Phase 6C branch on fixed `origin`
- create or reuse one approved PR to `main`
- require exact-head `PPO PR validation`
- run independent exact-head remote PR review inside the Phase 6F no-network/read-only review sandbox
- transition to `merge_ready` only after all gates pass
- merge only with a fixed method and GitHub expected-head-SHA protection
- reconcile ambiguous push, PR creation, and merge writes read-only

Phase 6G must not deploy, restart services, roll back, perform production verification, add `/ppo continue`, add Telegram/OpenClaw routes, alter credentials, or merge an unreviewed SHA.

## Phase 6H exact-SHA deployment boundary

Phase 6H allows one local deployment boundary for the PPO service:

- create and consume PPO self-development run-state records only through the explicit fixed `personal-project-operator` capability
- accept only exact-version `merged` runs
- require valid Phase 6G merged evidence for exactly `run.headSha`
- derive the deployment target only from the Phase 6G merge commit SHA
- support only the fixed `personal-project-operator` deployment profile
- reject arbitrary repository URLs, install paths, remotes, service names, executable paths, command strings, and caller-supplied SHAs
- transition `merged -> deploy_in_progress` before mutation
- use trusted executable paths, explicit argv, `shell: false`, bounded timeout/output, and sanitized environment
- check out exactly the approved SHA, not branch names or latest `main`
- run only the approved runtime preflight
- restart only `ppo-openclaw.service`
- transition to `deployed` only after exact checkout and restart postconditions are proven
- transition definitive failures to `deploy_failed`
- preserve ambiguous attempts for read-only reconciliation

Phase 6H must not deploy arbitrary projects, use `git pull` as final deployment selection, automatically rollback, run production verification or health checks, add `/ppo continue`, add Telegram/OpenClaw routes, alter credentials, or broaden GitHub write permissions.

## Phase 6I read-only production verification boundary

Phase 6I allows one local read-only production verification boundary for the PPO service after Phase 6H:

- accept only exact-version `deployed` PPO self-development runs
- require valid Phase 6H `deployed` evidence and the Phase 6G merge-to-deploy SHA chain
- derive the verification target only from the Phase 6H deployed SHA
- reuse only the fixed Phase 6H `personal-project-operator` production profile
- reject arbitrary repositories, install paths, services, commands, executables, policies, refs, branches, and caller-supplied SHAs
- transition `deployed -> verification_in_progress` before production checks
- run only the fixed read-only verification primitive with explicit argv, `shell: false`, bounded timeout/output, sanitized environment, and strict bounded result schema validation
- transition to `verified` only after the full approved read-only contract is proven
- transition definitive failures to `verification_failed`
- preserve ambiguous attempts for read-only reconciliation

Phase 6I must not deploy, redeploy, rollback, fetch, pull, checkout, switch, reset, mutate files, change permissions, change configuration, restart services, perform GitHub writes, invoke Codex or models, add `/ppo continue`, add Telegram/OpenClaw routes, alter credentials, or expand project registry support.

## Financial and trading boundary

SPY Market Agent may support research, summaries, simulation, and backtesting. It must not execute trades or connect to brokerage execution without a separate approved safety design.

## Customer communication boundary

The operator may draft messages in future phases. It must not send customer, staff, or public messages automatically in early phases.

## Paid API boundary

Any paid API call must require explicit approval unless a future budget and allowlist are documented.
