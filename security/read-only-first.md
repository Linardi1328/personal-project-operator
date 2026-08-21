# Read-Only First

## Principle

Personal Project Operator should begin by reading and summarizing project state. It should not change repos, deployments, accounts, messages, or financial systems by default.

## Phase 0

Allowed:

- local Markdown docs
- command behavior documentation
- prompt templates
- usage tracking design
- safety policy design

Not allowed:

- live GitHub calls
- live OpenClaw actions
- Telegram API setup
- VPS deployment
- usage scraping
- credential storage
- customer messaging
- production deployment
- trading execution

## Phase 1

Allowed:

- local command simulation for `/status`, `/menu`, and `/help`
- local `/ppo` wrapper for OpenClaw Telegram routing preparation
- local JSON fixtures
- phone-style mock output examples
- OpenClaw routing preparation docs

Not allowed:

- live GitHub calls
- Telegram API calls or command registration
- Codex usage scraping
- VPS deployment
- credential storage
- write actions
- automatic edits to `~/.openclaw`
- overriding OpenClaw built-in `/status`, `/menu`, or `/help`

## Phase 2A

Allowed:

- local terminal-only GitHub read-only validation
- repo metadata reads
- recent commit reads
- open PR reads
- open issue reads
- compact project snapshots
- fixed project allowlist lookup

Not allowed:

- Telegram-routed GitHub commands
- arbitrary owner/repo input from external commands
- GitHub write actions
- GitHub API methods other than explicit GET, including POST, PUT, PATCH, or DELETE
- shell execution for `gh`
- credential storage or logging
- branch creation in target project repos
- workflow dispatch
- comments, labels, reviews, approvals, closes, merges, commits, or pushes

## Future read-only integrations

Future safe integrations may read:

- GitHub repo metadata
- recent commits
- open PRs
- issues
- CI/check status
- VPS health status

## Phase 5A controlled write exception

Phase 5A allows one write action only after exact terminal confirmation:

- `issue-create <project> <title> [body...]`

This exception is limited to `POST /repos/<approved repo>/issues` for registry projects, with `title` and `body` fields only. It must write a credential-free audit record and must not be routed through `/ppo`, `ppo_local`, OpenClaw, or Telegram.

## Phase 5B approval-gated chat write exception

Phase 5B allows one chat-routed write workflow through the existing `ppo_local` tool:

- `/ppo issue-create <project> <title> [--body <body>]` stages only and performs no GitHub write.
- `/ppo issue-confirm <request-id>` atomically claims one unexpired pending request, consumes it, and then invokes the Phase 5A issue writer with internal confirmation.

The pending request store is private local write data. Request ids are random, opaque, single-use, and expire after 10 minutes. The chat workflow must not accept or expose terminal write confirmation environment values, and failed, expired, malformed, unknown, or replayed ids must perform zero GitHub writes.

## Phase 5C controlled local note exception

Phase 5C allows one terminal-only local write action after exact confirmation:

- `note-add <project> <note...>`

This exception is limited to append-only local records under `${PPO_WRITE_DATA_DIR}/project-notes`. It must not be routed through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It must not call GitHub, modify `projects/*.md`, update project-state files, create issues/comments/labels/PRs/branches/commits/merges/workflow dispatches, deploy services, or invoke models.

Audit records for note actions must be metadata-only and must not contain note text, confirmation values, request ids, tokens, or raw failures.

## Phase 5D approval-gated chat note exception

Phase 5D allows one chat-routed note workflow through the existing `ppo_local` tool:

- `/ppo note-add <project> <note...>` stages only and performs no note write.
- `/ppo note-confirm <request-id>` atomically claims one unexpired pending request, consumes it, and then invokes the Phase 5C note writer with internal confirmation.

The pending request store is private local write data. Request ids are random, opaque, single-use, and expire after 10 minutes. The chat workflow must not accept or expose terminal note confirmation environment values, and failed, expired, malformed, unknown, or replayed ids must perform zero note writes.

The Phase 5C note audit remains metadata-only and must not contain note text, Phase 5D request ids, confirmation values, tokens, or raw failures.

## Phase 5E controlled project-state promotion exception

Phase 5E allows one terminal-only project-state mutation after exact confirmation:

- `state-promote <project> <note-id> <field>`

This exception is limited to promoting one durable Phase 5C/5D note into exactly one approved project-state section. It must not be routed through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It must not call GitHub, create branches/commits/merges/workflow dispatches, deploy services, invoke models, or mutate unapproved project-state sections.

## Phase 6A local run-state foundation

Phase 6A allows local private storage for future autonomous-development coordination:

- `local-operator/development-run-state.mjs`

This foundation is limited to deterministic run records under `${PPO_WRITE_DATA_DIR}/development-runs`. It may record lifecycle state, optimistic versions, bounded task text, attempt counters, timestamps, SHA-pinned evidence metadata, and immutable transition history.

It must not execute the lifecycle it records. It does not plan, invoke Codex or models, run tests, write GitHub, create branches or commits, merge PRs, deploy, restart services, roll back, route `/ppo continue`, or add Telegram/OpenClaw autonomous-development commands.

## Phase 6B local next-stage planner foundation

Phase 6B allows deterministic local planning against approved state:

- `local-operator/development-next-stage-planner.mjs`

The planner may read the fixed project doc for one allowlisted project, `ROADMAP.md`, and Phase 2 GitHub read-only snapshot facts. It may return a bounded plan or `owner_action_required`, and it may create or plan a Phase 6A run only through `created -> planning_in_progress -> planned`.

It must not execute the plan. It does not create workspaces, create branches, invoke Codex or models, run tests, review changes, write GitHub, create or merge PRs, deploy, restart services, roll back, route `/ppo continue`, or add Telegram/OpenClaw autonomous-development commands.

## Phase 6C isolated workspace exception

Phase 6C allows deterministic local workspace preparation for a planned run:

- `local-operator/development-workspace-manager.mjs`

The manager may read one `planned` Phase 6A run, verify one configured allowlisted source repository, create one deterministic branch from exactly `run.baseSha`, create one worktree under a PPO-managed workspace root, and transition only `planned -> implementation_in_progress` after verification.

This exception does not execute implementation. It does not invoke Codex or models, edit workspace files, run tests, review changes, write GitHub, push, create or merge PRs, deploy, restart services, roll back, route `/ppo continue`, or add Telegram/OpenClaw autonomous-development commands.

## Phase 6D Codex execution exception

Phase 6D allows bounded local Codex execution for an implementation run:

- `local-operator/development-codex-execution-adapter.mjs`

The adapter may read one `implementation_in_progress` Phase 6A run, reconcile one verified Phase 6C workspace, establish an explicit no-outbound-network OS/process sandbox before Codex starts, use the Linux network-namespace privilege-drop backend for Ubuntu 24.04 production, record bounded implementation attempts in the Phase 6A run record, invoke trusted locally configured Codex through that sandbox with `cwd` set to that workspace, verify a new clean local descendant commit, and transition only `implementation_in_progress -> implementation_ready`.

This exception does not run automated tests, review changes, harden in loops, write GitHub, push, create or merge PRs, deploy, restart services, roll back, route `/ppo continue`, or add Telegram/OpenClaw autonomous-development commands.

## Phase 6E automated testing exception

Phase 6E allows bounded local automated testing for an implementation-ready run:

- `local-operator/development-test-runner.mjs`

The runner may read one Phase 6A run after Phase 6D implementation evidence exists, reconcile one verified Phase 6C workspace, require workspace branch and HEAD to equal `run.headSha`, verify a no-outbound-network process sandbox, execute only trusted per-project test policy steps with explicit argv and `shell: false`, record bounded metadata-only test attempts, and transition only to `tests_passed` when all required tests pass for the exact implementation SHA.

This exception does not invoke Codex or models, run automated review, harden in loops, write GitHub, push, create or merge PRs, deploy, restart services, roll back, route `/ppo continue`, or add Telegram/OpenClaw autonomous-development commands.

## Phase 6F independent review and hardening exception

Phase 6F allows bounded local independent review and hardening for a tests-passed run:

- `local-operator/development-review-agent.mjs`
- `local-operator/development-hardening-orchestrator.mjs`

The agent may read one Phase 6A run after Phase 6E PASS evidence exists, reconcile one verified Phase 6C workspace, require workspace branch, HEAD, and clean tree to equal `run.headSha`, verify Phase 6D implementation evidence and Phase 6E PASS evidence for that exact SHA, verify a no-outbound-network plus read-only-workspace process sandbox, invoke only a trusted locally configured reviewer executable with explicit argv and `shell: false`, record bounded metadata-only review attempts, and transition only to `review_passed` after valid exact-SHA approval. Reviewer file writes and local Git mutation attempts must be denied by the sandbox before an attempt is reserved.

The hardening orchestrator may start only from valid exact-SHA `CHANGES_REQUESTED` review evidence, derive remediation context only from durable validated review findings, reuse Phase 6D/6E/6F engines, require a new implementation SHA followed by fresh tests and fresh review, include all validated remediation items and mandatory safety boundaries in the Phase 6D hardening prompt, and stop after at most three durable rounds with owner-action-required evidence.

This exception does not accept arbitrary remediation text, create parallel implementation/test/review engines, harden beyond three rounds, write GitHub, push, create or merge PRs, deploy, restart services, roll back, route `/ppo continue`, or add Telegram/OpenClaw autonomous-development commands.

## Future write actions

Write actions must be treated as separate features, not automatic extensions of read-only commands.

Examples requiring explicit approval:

- creating GitHub issues outside the Phase 5A terminal path or Phase 5B approval-gated chat path
- updating project state files from stored notes
- creating project notes outside the Phase 5C terminal path or Phase 5D approval-gated chat path
- executing planner behavior beyond Phase 6B deterministic next-stage planning
- creating or managing workspaces outside the Phase 6C isolated workspace manager
- executing Codex outside the Phase 6D bounded execution adapter
- executing automated tests outside the Phase 6E trusted test runner
- executing automated review outside the Phase 6F trusted independent review agent
- executing automated hardening outside the Phase 6F bounded hardening orchestrator
- executing merge/deploy/rollback/verification agents from Phase 6A run-state records
- restarting services
- publishing content
- sending messages

## Operator response rule

When a command asks for something blocked, the operator should explain:

- what is blocked
- why it is blocked
- what safe alternative is available
- what approval or future phase would be required
