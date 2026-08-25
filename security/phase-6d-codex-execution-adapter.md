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
- establish and verify the trusted no-outbound-network command sandbox before spawning Codex
- use the Ubuntu 24.04 production backend only through fixed `codex exec` argv plus Codex's native `:workspace` Linux permission profile
- keep Git wrapper/env remote-write denial only as defense in depth
- invoke a trusted locally configured `codex exec` controller with explicit argv and `shell: false`, while generated commands remain inside the native sandbox
- set `cwd` only to the verified Phase 6C workspace
- pass a deterministic bounded prompt to Codex
- consume Phase 6F durable remediation context only when the run contains trusted exact-SHA hardening-start and review-finding evidence
- include every validated hardening remediation item and all mandatory safety boundaries in the Codex prompt, trimming only optional task/planning context or failing closed if required content cannot fit
- capture bounded stdout/stderr for process control only
- reserve bounded implementation attempts durably in the Phase 6A run record
- create the fixed local commit only after sandboxed edits complete successfully
- verify resulting local Git state independently
- require a clean workspace and a new local descendant commit
- transition only `implementation_in_progress -> implementation_ready`
- attach metadata-only SHA-pinned implementation evidence
- inspect interrupted execution state read-only

## Blocked

Phase 6D must not:

- accept Codex executable/config from user text, task text, planner output, project Markdown, GitHub facts, or chat
- spawn Codex if the no-outbound-network command sandbox cannot be established and verified active
- use caller-selected models, permission profiles, approval modes, or Codex argv
- execute Codex outside the verified Phase 6C workspace
- rely on prompt compliance, PATH wrappers, local refs, remote-tracking refs, or inherited Git environment as the primary no-push boundary
- trust Codex prose as implementation evidence
- store prompt contents, raw Codex stdout/stderr, raw failures, credentials, tokens, terminal confirmation values, arbitrary paths, or unbounded logs
- run automated tests beyond adapter-specific Git verification
- perform automated review or hardening loops outside Phase 6F orchestration
- call GitHub writes
- create PRs
- push, merge, rebase, reset, cherry-pick, or mutate remotes
- deploy, restart services, or roll back
- add `/ppo continue`
- add Telegram/OpenClaw routes or new OpenClaw tools

Timeouts, signals, killed/interrupted processes, output overflow, and uncertain completion must fail closed as ambiguous and require reconciliation before retry. Unchanged local refs or remote-tracking refs are not accepted as proof that no remote push occurred. Before any Codex attempt is reserved, the native command-sandbox preflight must prove local Git reads still work and direct network, direct SSH transport, absolute Git with sanitized env, and ordinary `git push` cannot reach the host listener.
