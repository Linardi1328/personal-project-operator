# Phase 6C Isolated Workspace Manager

Phase 6C adds a deterministic local workspace manager foundation:

```text
local-operator/development-workspace-manager.mjs
```

The manager accepts one Phase 6A run only when it is already in `planned` status. It verifies the run project, approved repository identity, and exact `baseSha` before creating an isolated implementation branch and Git worktree.

## Inputs

Workspace preparation requires:

- a Phase 6A run id
- exact expected run-state version
- a trusted project workspace registry supplied by local operator configuration
- a source repository path from that registry
- a PPO-managed workspace root from that registry or `${PPO_WRITE_DATA_DIR}/development-workspaces`

Repository paths do not come from user text, tasks, planner output, project Markdown, or GitHub facts.

## Behavior

The manager:

- resolves projects through the existing six-project registry
- refuses any run not in `planned`
- reloads the run and checks the exact expected version
- verifies the configured source path is canonical, local, not a symlink, and a Git repository root
- verifies `origin` matches the allowlisted `owner/repo`
- verifies the run `baseSha` exists locally
- refuses a dirty source repository working tree
- generates a deterministic bounded branch name from project, implementation stage, base SHA, and opaque run-id material
- validates the branch through Git
- creates the branch exactly at `run.baseSha`
- creates the worktree only under the PPO-managed workspace root
- verifies branch and worktree HEAD before updating run state
- transitions the run through `planned -> implementation_in_progress` with exact expected-version checking
- records metadata-only `implementation` evidence in the Phase 6A run

Workspace evidence includes project, repo identity, base SHA, branch, workspace id, bounded workspace reference, and verification timestamp. It does not store credentials, raw Git output, raw failures, arbitrary user-controlled paths, or task text.

## Recovery

`inspectImplementationWorkspace()` is read-only. It reloads the run, recomputes the expected workspace identity, and reports whether the recorded workspace exists and still matches the expected branch and base SHA.

If a Git mutation outcome is ambiguous, the manager fails closed and requires reconciliation before retry. If a partial failure is definite, the manager attempts bounded cleanup of the branch/worktree it created.

## Boundary

Phase 6C does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, Codex execution, model call, implementation-file edit, automated test execution, review automation, PR automation, GitHub write, push, merge, deployment, rollback, service control, or `/ppo continue`.
