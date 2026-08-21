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

- resolve project ids only through the existing five-project registry
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

- resolve project ids only through the existing five-project registry
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

- resolve projects through the existing five-project registry only
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

## Financial and trading boundary

SPY Market Agent may support research, summaries, simulation, and backtesting. It must not execute trades or connect to brokerage execution without a separate approved safety design.

## Customer communication boundary

The operator may draft messages in future phases. It must not send customer, staff, or public messages automatically in early phases.

## Paid API boundary

Any paid API call must require explicit approval unless a future budget and allowlist are documented.
