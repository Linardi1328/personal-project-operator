# Phase 6A Local Development Run State

Phase 6A adds a local-only durable state-machine store for future autonomous-development coordination.

The module is:

```text
local-operator/development-run-state.mjs
```

It is an imported library only. Phase 6A does not add a terminal command, `/ppo` route, OpenClaw tool, model call, Codex execution, GitHub write, git mutation, deployment action, rollback action, service control, or Telegram route.

## Storage

Run records are stored under:

```text
${PPO_WRITE_DATA_DIR}/development-runs/
```

Local development defaults to `local-operator/write-data/`. VPS configuration can keep using the existing non-secret `PPO_WRITE_DATA_DIR` root.

Directories are created as `0700`. Files are created as `0600`.

Each run has one canonical record:

```text
development-runs/records/<run-id>.json
```

Version guard records are stored under:

```text
development-runs/versions/<run-id>/<version>.json
```

The version guards make optimistic concurrency durable. A stale agent with an older expected version cannot overwrite a newer transition. If a process exits after a version guard is durable but before the canonical record is refreshed, `readDevelopmentRun()` recovers the canonical record from the newest valid guard.

## Record Shape

The canonical record contains:

- opaque random run id
- allowlisted project metadata
- bounded task text
- lifecycle status and derived stage
- immutable base SHA
- optional branch metadata
- optional head SHA
- per-stage attempt counters
- created/updated/status/terminal timestamps
- SHA-pinned implementation, review, test, deploy, and verification evidence metadata
- immutable hash-chained transition history

Evidence metadata is structured and bounded. It rejects secret-like values, raw errors, stdout/stderr, stack traces, credentials, tokens, passwords, and terminal control input.

## Lifecycle

Allowed statuses are explicit:

```text
created
planning_in_progress
planned
implementation_in_progress
implementation_ready
tests_in_progress
tests_failed
tests_passed
review_in_progress
review_changes_requested
review_passed
merge_ready
merged
deploy_in_progress
deploy_failed
deployed
verification_in_progress
verification_failed
verified
cancelled
failed
```

Only the transitions exported by `ALLOWED_DEVELOPMENT_RUN_TRANSITIONS` are accepted. Skipped, backward, and terminal-state transitions are refused unless they are one of the explicit retry transitions in the state graph.

Every transition requires `expectedVersion`. The store checks the latest canonical/guarded version before writing and commits the next version through a durable version guard plus atomic canonical replacement.

## Boundary

Phase 6A is only the run-state foundation.

It must not:

- plan work
- invoke Codex or any model
- execute tests
- create branches or commits
- push code
- open, update, approve, close, or merge PRs
- call GitHub write APIs
- deploy or restart services
- perform rollback
- route `/ppo continue`
- add Telegram/OpenClaw autonomous-development commands
