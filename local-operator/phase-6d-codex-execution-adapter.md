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
- trusted local Codex-native command sandbox configuration
- trusted local Git wrapper/env remote-write denial configuration for defense in depth
- a verified Phase 6C workspace for the run

Codex executable paths, sandbox executable paths, Git executable paths, argv, timeouts, environment values, and defense-in-depth remote-write policy settings come from trusted local configuration only. They do not come from user text, task text, planner output, project Markdown, GitHub facts, or chat.

Supported sandbox backends are explicit and platform-capable:

- `macos-sandbox-exec` for local macOS validation.
- `codex-native-linux` for the supported Ubuntu 24.04 VPS runtime.
- `linux-network-namespace` remains available only for legacy regression coverage.

The production Linux backend invokes `codex exec` directly so the Codex controller can authenticate and reach OpenAI, while Codex applies its native `:workspace` Linux sandbox to model-generated commands. PPO preflights that boundary through `codex sandbox linux`, requires Bubblewrap, disables command network access, and keeps remote Git operations denied through the adapter Git wrapper. Because Codex protects `.git` in workspace-write mode, PPO creates the fixed local implementation commit only after the Codex process exits successfully and the workspace remains within the verified isolated branch.

## Behavior

The adapter:

- reloads the Phase 6A run and requires `implementation_in_progress`
- requires exact expected-version optimistic concurrency
- reconciles the Phase 6C workspace before execution
- refuses missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, or outside-managed-root workspaces
- requires workspace HEAD to equal `run.headSha` or `run.baseSha` before Codex starts
- builds a deterministic bounded prompt from run task and planning evidence metadata
- when coordinated by Phase 6F hardening, appends only trusted durable remediation context derived from validated Phase 6F review evidence
- never drops validated hardening blockers, security findings, required tests, or mandatory isolated-workspace/no-push/no-merge/no-deploy/no-credential/no-destructive-operation boundaries from the prompt; only optional task/planning context may be trimmed, and required-content overflow fails closed
- includes explicit no-push, no-merge, no-deploy, no-credential-change, no-destructive-operation boundaries in the prompt
- establishes and verifies the no-outbound-network command sandbox before Codex starts and fails closed if the sandbox is unavailable, inactive, or platform-incompatible
- for Linux, uses Codex's native Linux sandbox and a fixed `:workspace` permission profile for generated commands
- verifies sandboxed local Git operations still work before Codex starts
- verifies sandboxed outbound network probes are denied, including direct network, direct SSH transport, absolute Git with sanitized Git policy env, and ordinary `git push`
- invokes `codex exec` with explicit fixed argv, `gpt-5.6-sol`, `shell: false`, bounded timeout, bounded output capture, policy-controlled environment, and `cwd` set to the verified isolated workspace
- records each definitive implementation attempt durably in the Phase 6A run record with exact expected-version checks and a small explicit maximum
- does not store prompt contents or raw Codex stdout/stderr
- treats timeout, signal, killed, interrupted, overflow, or uncertain completion as ambiguous
- creates one fixed local implementation commit after a successful sandboxed edit turn
- independently verifies Git state after that commit
- requires a clean worktree and a new local implementation commit
- requires final HEAD to be a full SHA descended from the run base SHA
- requires the isolated branch to remain unchanged by name
- verifies the source/default worktree is unchanged locally
- transitions `implementation_in_progress -> implementation_ready` only after verification
- updates `run.headSha` to the verified implementation SHA
- records metadata-only SHA-pinned implementation evidence

The adapter contract requires a local commit, but the production backend creates it itself because Codex's workspace-write sandbox keeps `.git` read-only. Codex prose claiming success is ignored. The native command sandbox is the primary boundary for model-generated commands; the adapter Git wrapper/env remains defense in depth, and PPO independently verifies the resulting branch, ancestry, source checkout, and clean worktree.

## Recovery

`reconcileCodexExecution()` is read-only. It reports whether the workspace is still at the expected run head, has advanced to a descendant implementation commit, or is mismatched.

If execution is ambiguous, the run remains in `implementation_in_progress` with the reserved attempt recorded as open, and owner reconciliation is required before retry. Definitive failures record bounded metadata-only failure evidence so a later retry must use the new expected version and increments the persistent implementation attempt counter.

## Boundary

Phase 6D does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, automated test execution, independent review, hardening loop, PR automation, GitHub write, push, merge, deployment, rollback, production verification, service control, or `/ppo continue`.
