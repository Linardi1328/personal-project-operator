# Phase 6D Codex Execution Adapter

Phase 6D adds a bounded local Codex execution adapter foundation:

```text
local-operator/development-codex-execution-adapter.mjs
```

The adapter accepts one Phase 6A run only when it is already in `implementation_in_progress` and has a verified Phase 6C isolated workspace.

## Inputs

Codex execution requires:

- a Phase 6A run id
- exact expected run-state version
- a trusted Phase 6C project workspace registry
- trusted local Codex executable/configuration
- a verified Phase 6C workspace for the run

Codex executable paths, argv, timeouts, and environment values come from trusted local configuration only. They do not come from user text, task text, planner output, project Markdown, GitHub facts, or chat.

## Behavior

The adapter:

- reloads the Phase 6A run and requires `implementation_in_progress`
- requires exact expected-version optimistic concurrency
- reconciles the Phase 6C workspace before execution
- refuses missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, or outside-managed-root workspaces
- requires workspace HEAD to equal `run.headSha` or `run.baseSha` before Codex starts
- builds a deterministic bounded prompt from run task and planning evidence metadata
- includes explicit no-push, no-merge, no-deploy, no-credential-change, no-destructive-operation boundaries in the prompt
- invokes Codex with explicit argv, `shell: false`, bounded timeout, bounded output capture, and `cwd` set to the verified isolated workspace
- does not store prompt contents or raw Codex stdout/stderr
- treats timeout, signal, killed, interrupted, overflow, or uncertain completion as ambiguous
- independently verifies Git state after a successful Codex exit
- requires a clean worktree and a new local implementation commit
- requires final HEAD to be a full SHA descended from the run base SHA
- requires the isolated branch to remain unchanged by name
- verifies the source/default worktree and remote-tracking state are unchanged locally
- transitions `implementation_in_progress -> implementation_ready` only after verification
- updates `run.headSha` to the verified implementation SHA
- records metadata-only SHA-pinned implementation evidence

The adapter contract requires a local commit. Codex prose claiming success is ignored.

## Recovery

`reconcileCodexExecution()` is read-only. It reports whether the workspace is still at the expected run head, has advanced to a descendant implementation commit, or is mismatched.

If execution is ambiguous, the run state is left unchanged and owner reconciliation is required before retry.

## Boundary

Phase 6D does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, automated test execution, independent review, hardening loop, PR automation, GitHub write, push, merge, deployment, rollback, production verification, service control, or `/ppo continue`.
