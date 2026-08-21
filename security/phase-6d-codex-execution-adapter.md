# Phase 6D Codex Execution Adapter Safety Boundary

Phase 6D adds one local Codex execution adapter foundation:

```text
local-operator/development-codex-execution-adapter.mjs
```

It invokes Codex only inside a verified Phase 6C isolated workspace for a Phase 6A run already in `implementation_in_progress`.

## Allowed

Phase 6D may:

- read one Phase 6A run from `${PPO_WRITE_DATA_DIR}/development-runs`
- require exact expected-version optimistic concurrency
- reuse Phase 6C workspace reconciliation and trusted workspace registry
- invoke a trusted locally configured Codex executable with explicit argv and `shell: false`
- set `cwd` only to the verified Phase 6C workspace
- pass a deterministic bounded prompt to Codex
- capture bounded stdout/stderr for process control only
- verify resulting local Git state independently
- require a clean workspace and a new local descendant commit
- transition only `implementation_in_progress -> implementation_ready`
- attach metadata-only SHA-pinned implementation evidence
- inspect interrupted execution state read-only

## Blocked

Phase 6D must not:

- accept Codex executable/config from user text, task text, planner output, project Markdown, GitHub facts, or chat
- execute Codex outside the verified Phase 6C workspace
- trust Codex prose as implementation evidence
- store prompt contents, raw Codex stdout/stderr, raw failures, credentials, tokens, terminal confirmation values, arbitrary paths, or unbounded logs
- run automated tests beyond adapter-specific Git verification
- perform automated review or hardening loops
- call GitHub writes
- create PRs
- push, merge, rebase, reset, cherry-pick, or mutate remotes
- deploy, restart services, or roll back
- add `/ppo continue`
- add Telegram/OpenClaw routes or new OpenClaw tools

Timeouts, signals, killed/interrupted processes, output overflow, and uncertain completion must fail closed as ambiguous and require reconciliation before retry.
