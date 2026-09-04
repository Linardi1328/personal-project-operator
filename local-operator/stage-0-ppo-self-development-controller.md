# Stage 0 - Local PPO Self-Development Controller

Stage 0 bootstraps one fixed, local-only path for developing Personal Project Operator through its own reviewed Phase 6B–6G lifecycle.

## Commands

Run only on the approved Customer Zero macOS controller:

```text
ppo-self-development start
ppo-self-development status <run-id>
ppo-self-development continue <run-id>
ppo-self-development recover <run-id>
ppo-self-development cancel <run-id>
ppo-self-development cancel-confirm <run-id> <version> cancel-personal-project-operator-run --local-owner-confirmed
```

`start` reads the fixed `projects/personal-project-operator.md`, `ROADMAP.md`, and GitHub read-only snapshot. It accepts no task, repository, SHA, branch, runtime, policy, provider, or deployment input.

`continue` advances at most one existing Phase 6B–6G boundary and stops at `merged`. It uses the fixed macOS source checkout, managed workspace root, Codex runtime, independent reviewer, and five-step PPO validation policy.

`recover` performs one read-only Phase 6C–6G observation. It does not retry, repair, mutate the run, invoke Codex, run tests, write GitHub state, deploy, or roll back.

Cancellation is allowed only from the existing quiescent status set. Staging is read-only. Confirmation is bound to the observed run id and version and requires the exact local-owner confirmation. It never interrupts a process, cleans a workspace, deletes a branch, closes a PR, or affects production.

## Validation parity

PPO self-development uses `deployment/scripts/run-ppo-development-quality.mjs` for exactly five gates:

1. JavaScript and shell syntax.
2. Full parallel regression.
3. Full serial regression.
4. Two critical lifecycle stability rounds.
5. Integrated acceptance.

The GitHub `PPO PR validation` workflow invokes the same gate runner, preventing local/CI command drift.

## Boundary

- Repository identity is fixed to `Linardi1328/personal-project-operator`.
- Runtime is fixed to the approved Customer Zero macOS paths.
- The ordinary six-project registry is unchanged.
- `/ppo start`, `/ppo continue`, `/ppo recover`, `/ppo runs`, `/ppo run`, `/ppo cancel`, and `/ppo cancel-confirm` still refuse or omit PPO self-development.
- The OpenClaw bridge imports no Stage 0 controller module and exposes no self-development command.
- Stage 0 performs no production deployment, verification, rollback, service control, public signup, authentication, billing, or SaaS provisioning.
