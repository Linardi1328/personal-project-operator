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
- trusted local explicit no-outbound-network OS/process sandbox configuration
- trusted local Git wrapper/env remote-write denial configuration for defense in depth
- a verified Phase 6C workspace for the run

Codex executable paths, sandbox executable paths, Git executable paths, argv, timeouts, environment values, and defense-in-depth remote-write policy settings come from trusted local configuration only. They do not come from user text, task text, planner output, project Markdown, GitHub facts, or chat.

Supported sandbox backends are explicit and platform-capable:

- `macos-sandbox-exec` for local macOS validation.
- `linux-network-namespace` for the supported Ubuntu 24.04 VPS runtime.

The Linux backend contract uses a trusted `nsenter` executable to enter a root-provisioned/preconfigured no-network namespace, then runs a trusted `setpriv` executable with a configured non-root uid/gid, `no_new_privs`, cleared groups, and no effective capabilities before launching Codex. Codex itself must not run with privilege that can reconfigure or escape the namespace.

## Behavior

The adapter:

- reloads the Phase 6A run and requires `implementation_in_progress`
- requires exact expected-version optimistic concurrency
- reconciles the Phase 6C workspace before execution
- refuses missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, or outside-managed-root workspaces
- requires workspace HEAD to equal `run.headSha` or `run.baseSha` before Codex starts
- builds a deterministic bounded prompt from run task and planning evidence metadata
- includes explicit no-push, no-merge, no-deploy, no-credential-change, no-destructive-operation boundaries in the prompt
- establishes and verifies a no-outbound-network OS/process sandbox before Codex starts and fails closed if the sandbox is unavailable, inactive, or platform-incompatible
- for Linux, verifies the sandboxed process is non-root, has zero effective capabilities, and has `NoNewPrivs: 1`
- verifies sandboxed local Git operations still work before Codex starts
- verifies sandboxed outbound network probes are denied, including direct network, direct SSH transport, absolute Git with sanitized Git policy env, and ordinary `git push`
- invokes Codex through the sandbox with explicit argv, `shell: false`, bounded timeout, bounded output capture, policy-controlled environment, and `cwd` set to the verified isolated workspace
- records each definitive implementation attempt durably in the Phase 6A run record with exact expected-version checks and a small explicit maximum
- does not store prompt contents or raw Codex stdout/stderr
- treats timeout, signal, killed, interrupted, overflow, or uncertain completion as ambiguous
- independently verifies Git state after a successful Codex exit
- requires a clean worktree and a new local implementation commit
- requires final HEAD to be a full SHA descended from the run base SHA
- requires the isolated branch to remain unchanged by name
- verifies the source/default worktree is unchanged locally
- transitions `implementation_in_progress -> implementation_ready` only after verification
- updates `run.headSha` to the verified implementation SHA
- records metadata-only SHA-pinned implementation evidence

The adapter contract requires a local commit. Codex prose claiming success is ignored. PATH wrappers, prompt compliance, local refs, remote-tracking refs, and inherited Git environment are not the primary no-push proof; the primary boundary is the explicit OS/process sandbox that removes outbound network capability before Codex is spawned. Git wrapper/env controls remain defense in depth only.

## Recovery

`reconcileCodexExecution()` is read-only. It reports whether the workspace is still at the expected run head, has advanced to a descendant implementation commit, or is mismatched.

If execution is ambiguous, the run remains in `implementation_in_progress` with the reserved attempt recorded as open, and owner reconciliation is required before retry. Definitive failures record bounded metadata-only failure evidence so a later retry must use the new expected version and increments the persistent implementation attempt counter.

## Boundary

Phase 6D does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, automated test execution, independent review, hardening loop, PR automation, GitHub write, push, merge, deployment, rollback, production verification, service control, or `/ppo continue`.
