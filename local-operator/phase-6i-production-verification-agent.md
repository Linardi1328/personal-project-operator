# Phase 6I Production Verification Agent

Phase 6I adds a local-only, read-only production verification boundary after Phase 6H. It starts only from a Personal Project Operator self-development run in `deployed` and stops at `verified` or `verification_failed`.

## Scope

Phase 6I supports only the existing fixed PPO production identity:

- project: `personal-project-operator`
- repository: `Linardi1328/personal-project-operator`
- install directory: `/opt/personal-project-operator`
- service: `ppo-openclaw.service`

The agent reuses the Phase 6H deployment profile and derives the immutable verification target only from valid durable Phase 6H `deployed` evidence. It also requires the Phase 6G merge evidence to prove that the deployed SHA is the reviewed merge commit.

## Lifecycle

`executeDevelopmentProductionVerification()`:

1. Reads the Phase 6A run and rejects stale versions.
2. Requires status `deployed`.
3. Validates the latest Phase 6H deployed evidence and the Phase 6G-to-Phase 6H SHA chain.
4. Transitions `deployed -> verification_in_progress` with metadata-only `verification_started` evidence.
5. Runs the fixed read-only production verification primitive with explicit argv, `shell: false`, bounded timeout/output, and sanitized environment.
6. Re-reads the run and requires the same deployment SHA.
7. Transitions to `verified` only after the full approved verification contract passes, or to `verification_failed` on a definitive safe failure class.

Ambiguous outcomes leave the run in `verification_in_progress`.

## Read-Only Contract

The production primitive checks only fixed read-only facts: repository origin, exact detached checkout SHA, clean worktree, previous-revision marker when applicable, runtime preflight, OpenClaw version, fixed systemd service state and identity, reviewed unit match, permission contract, and read-only `ppo_local help` bridge execution.

It does not fetch, pull, checkout, switch, reset, mutate files, change permissions, change configuration, restart services, rollback, install packages, call GitHub writes, invoke Codex, add routes, or expose secrets.

## Reconciliation

`reconcileDevelopmentProductionVerification()` is read-only. It reports current run status, expected deployed SHA, recorded verification attempt, current checkout SHA when observable, fixed service state, verification evidence completeness, and whether retry requires owner action.

Reconciliation never transitions to `verified` merely because a subset of checks passes.

## Out Of Scope

Phase 6I does not:

- deploy or redeploy
- rollback
- restart, reload, enable, or disable services
- refresh Git refs or use latest `main`
- add `/ppo continue`
- add Telegram or OpenClaw routing
- expand ordinary project registry support
- alter GitHub delivery, merge, test, review, or Codex execution behavior
