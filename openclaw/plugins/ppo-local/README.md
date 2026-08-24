# PPO Local OpenClaw Plugin

This local plugin registers one OpenClaw tool:

```text
ppo_local
```

The tool is the deterministic bridge for PPO commands:

```text
/ppo ... -> ppo_local -> local-operator/ppo-command.mjs
```

## Scope

The plugin:

- accepts the approved PPO command surface through Phase 7A
- accepts the Phase 5B approval commands `issue-create` and `issue-confirm`
- accepts the Phase 5D approval commands `note-add` and `note-confirm`
- invokes only `local-operator/ppo-command.mjs`
- passes arguments as an argv array through `execFile`
- does not use a shell
- routes `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` to the Phase 2A GitHub read-only client
- routes `/ppo issue-create` to local pending-request staging only; staging never calls GitHub
- routes `/ppo issue-confirm` to atomically claim one unexpired local request before invoking the Phase 5A issue writer
- routes `/ppo note-add` to local pending-request staging only; staging never appends a note
- routes `/ppo note-confirm` to atomically claim one unexpired local request before invoking the Phase 5C note writer
- routes `/ppo start <project>` to the controlled Phase 7A planned-run creation path for ordinary five-project runs only
- routes `/ppo runs` and `/ppo run <run-id>` to the controlled Phase 6O read-only catalog routes for ordinary five-project runs only
- routes `/ppo cancel <run-id>` and `/ppo cancel-confirm <request-id>` to the controlled Phase 6P quiescent cancellation approval path for ordinary five-project runs only
- routes `/ppo continue <run-id>` to the controlled Phase 6K one-boundary development continue orchestrator for ordinary five-project runs only
- routes `/ppo recover <run-id>` to the controlled Phase 6M read-only recovery route for ordinary five-project runs only
- does not call Telegram APIs
- does not use secrets
- mutates only the private local pending stores for Phase 5B issue, Phase 5D note, and Phase 6P cancellation approval requests, plus the approved local note store after `/ppo note-confirm`, the single confirmed Phase 6P `cancelled` run transition, and the single Phase 7A planned-run creation through Phase 6B; Phase 6M recovery and Phase 6O catalog routes are read-only
- does not add generic GitHub tools or arbitrary GitHub endpoints
- accepts `codex ...`, `codex-budget ...`, `prompt-size ...`, and `split-task ...` through OpenClaw/Telegram in Phase 3C as text-only direct routes
- parses only the command envelope; task, draft, title, body, note text, project id, and run id are inert data
- accepts no catalog filters, search text, sort fields, limits, offsets, actions, cleanup options, confirmations, or production inputs
- does not accept or expose terminal write confirmation environment values through chat
- does not mutate `projects/*.md` or update project-state files
- does not route PPO production deployment, production verification, rollback, rollback reconciliation, service control, or VPS mutation

## Supported Raw Inputs

```text
status
menu
help
menu project
menu codex
menu system
repo khlim-assist
repo ledgerpilot-ai
repo spy-market-agent
repo portfolio
repo rbl-content-engine
repo khlim-digital-ecosystem
pr khlim-assist
pr ledgerpilot-ai
pr spy-market-agent
pr portfolio
pr rbl-content-engine
pr khlim-digital-ecosystem
codex khlim-assist add provider validation tests
codex ledgerpilot-ai add invoice import workflow
codex spy-market-agent harden research error handling
codex portfolio harden contact form error handling
codex rbl-content-engine organize source asset workflow
codex khlim-digital-ecosystem review the Phase 1 scaffold plan
codex-budget khlim-assist add provider validation tests
codex-budget ledgerpilot-ai add invoice import workflow
codex-budget spy-market-agent harden research error handling
codex-budget portfolio harden contact form error handling
codex-budget rbl-content-engine organize source asset workflow
codex-budget khlim-digital-ecosystem review the Phase 1 scaffold plan
prompt-size Goal: build one focused feature
split-task add GitHub integration and Telegram routing
issue-create khlim-assist Add provider validation issue
issue-create khlim-assist Add provider validation issue --body Include failing fixture details
issue-confirm <request-id>
note-add khlim-assist Record owner-visible project context
note-confirm <request-id>
start khlim-assist
start ledgerpilot-ai
start spy-market-agent
start portfolio
start rbl-content-engine
runs
run <run-id>
cancel <run-id>
cancel-confirm <request-id>
continue <run-id>
recover <run-id>
```

The bridge also accepts full `/ppo ...` payloads for local validation, but OpenClaw `command-arg-mode: raw` normally forwards only the text after `/ppo`.

`khlim-digital-ecosystem` is connected for read-only and deterministic planning commands. It is intentionally absent from the `start` list until fixed source paths and automated-test policies are reviewed.

## Phase 5B/5D write-data

Pending issue requests default to:

```text
local-operator/write-data
```

On the VPS, systemd sets:

```text
PPO_WRITE_DATA_DIR=/var/lib/personal-project-operator/write-data
PPO_GITHUB_WRITE_AUDIT_PATH=/var/lib/personal-project-operator/audit/github-write-audit.ndjson
```

Pending directories are created with `0700`, pending files with `0600`, and request ids expire after 10 minutes.

## Phase 5C/5D notes

Phase 5C adds `node local-operator/ppo-command.mjs note-add <project> <note...>` for trusted terminal note appends. Phase 5D adds `/ppo note-add <project> <note...>` staging and `/ppo note-confirm <request-id>` approval through this plugin. Pending note requests use `${PPO_WRITE_DATA_DIR}/pending-project-notes`; confirmed notes use `${PPO_WRITE_DATA_DIR}/project-notes`.

## Phase 7A development start

Phase 7A adds `/ppo start <project>` through this same plugin. The bridge accepts only exact raw command shapes for the existing five project ids and maps to wrapper argv `["start", "<project>"]` with `shell: false`; malformed whitespace, envelopes, repo names, paths, task text, SHAs, branches, versions, policies, runtime options, confirmations, actions, and extra arguments are rejected before wrapper execution. The wrapper invokes the reviewed Phase 6B `createPlannedDevelopmentRun(projectId)` once with only the approved internal invocation. A validated planned outcome creates one run and returns `/ppo continue <run-id>` as the next command. Owner-action-required or malformed planned outcomes create no continuation command.

Phase 7A never calls `/ppo continue` automatically, creates workspaces, invokes Codex, runs tests/review, pushes, creates PRs, merges, deploys, verifies production, rolls back, adds a new OpenClaw tool, or uses model interpretation.

## Phase 6K development continue

Phase 6K adds `/ppo continue <run-id>` through this same plugin. The bridge accepts only the exact opaque run id and maps to wrapper argv `["continue", "<run-id>"]`. The wrapper reads the durable Phase 6A run and delegates to at most one existing Phase 6B-6G child operation. It does not accept project, status, SHA, action, workspace, service, deployment, rollback, or confirmation input from chat.

## Phase 6M development recovery

Phase 6M adds `/ppo recover <run-id>` through this same plugin. The bridge accepts only the exact opaque run id and maps to wrapper argv `["recover", "<run-id>"]`. The wrapper invokes the reviewed Phase 6L read-only recovery coordinator once and returns only bounded formatted diagnostics. It does not accept project, status, SHA, action, workspace, policy, service, deployment, rollback, confirmation, command, executable, or environment input from chat, and it never calls `/ppo continue`.

## Phase 6O development run catalog

Phase 6O adds `/ppo runs` and `/ppo run <run-id>` through this same plugin. The bridge maps only `/ppo runs` to wrapper argv `["runs"]` and only `/ppo run <run-id>` to wrapper argv `["run", "<run-id>"]`. The wrapper invokes the reviewed Phase 6N catalog once and returns only bounded metadata summaries for ordinary five-project development runs. It accepts no project, status, stage, filter, search, sort, limit, offset, expected version, SHA, branch, path, action, service, production, confirmation, command, executable, or environment input from chat, and it never calls `/ppo continue` or `/ppo recover`.

## Phase 6P development run cancellation

Phase 6P adds `/ppo cancel <run-id>` and `/ppo cancel-confirm <request-id>` through this same plugin. The bridge maps only `/ppo cancel <run-id>` to wrapper argv `["cancel", "<run-id>"]` and only `/ppo cancel-confirm <request-id>` to wrapper argv `["cancel-confirm", "<request-id>"]`. The wrapper stages a 10-minute single-use cancellation request for an eligible quiescent ordinary run, then confirms by atomically claiming the request and performing one fixed `cancelled` transition after expected-version revalidation. It accepts no project, status, SHA, branch, path, action, cleanup, service, production, confirmation, command, executable, or environment input from chat, and it never interrupts processes, removes workspaces, calls `/ppo continue`, calls `/ppo recover`, retries, repairs, deploys, verifies production, or rolls back.

## Local Tests

From the repo root:

```bash
node openclaw/plugins/ppo-local/test-bridge.mjs
node local-operator/github-issue-approval.test.mjs
node local-operator/project-note-add.test.mjs
node local-operator/project-note-approval.test.mjs
node --test --test-concurrency=1 local-operator/development-start-route.test.mjs
```
