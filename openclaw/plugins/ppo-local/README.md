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

- accepts the approved PPO command surface through Phase 6K
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
- routes `/ppo continue <run-id>` to the controlled Phase 6K one-boundary development continue orchestrator for ordinary five-project runs only
- does not call Telegram APIs
- does not use secrets
- mutates only the private local pending stores for Phase 5B issue and Phase 5D note approval requests, plus the approved local note store after `/ppo note-confirm`
- does not add generic GitHub tools or arbitrary GitHub endpoints
- accepts `codex ...`, `codex-budget ...`, `prompt-size ...`, and `split-task ...` through OpenClaw/Telegram in Phase 3C as text-only direct routes
- parses only the command envelope; task, draft, title, body, and note text is inert data
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
pr khlim-assist
pr ledgerpilot-ai
pr spy-market-agent
pr portfolio
pr rbl-content-engine
codex khlim-assist add provider validation tests
codex ledgerpilot-ai add invoice import workflow
codex spy-market-agent harden research error handling
codex portfolio harden contact form error handling
codex rbl-content-engine organize source asset workflow
codex-budget khlim-assist add provider validation tests
codex-budget ledgerpilot-ai add invoice import workflow
codex-budget spy-market-agent harden research error handling
codex-budget portfolio harden contact form error handling
codex-budget rbl-content-engine organize source asset workflow
prompt-size Goal: build one focused feature
split-task add GitHub integration and Telegram routing
issue-create khlim-assist Add provider validation issue
issue-create khlim-assist Add provider validation issue --body Include failing fixture details
issue-confirm <request-id>
note-add khlim-assist Record owner-visible project context
note-confirm <request-id>
continue <run-id>
```

The bridge also accepts full `/ppo ...` payloads for local validation, but OpenClaw `command-arg-mode: raw` normally forwards only the text after `/ppo`.

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

## Phase 6K development continue

Phase 6K adds `/ppo continue <run-id>` through this same plugin. The bridge accepts only the exact opaque run id and maps to wrapper argv `["continue", "<run-id>"]`. The wrapper reads the durable Phase 6A run and delegates to at most one existing Phase 6B-6G child operation. It does not accept project, status, SHA, action, workspace, service, deployment, rollback, or confirmation input from chat.

## Local Tests

From the repo root:

```bash
node openclaw/plugins/ppo-local/test-bridge.mjs
node local-operator/github-issue-approval.test.mjs
node local-operator/project-note-add.test.mjs
node local-operator/project-note-approval.test.mjs
```
