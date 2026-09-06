# Personal Project Operator

## Project

Personal Project Operator

## Repo

`Linardi1328/personal-project-operator`

## Connection status

Connected candidate.

## Current role

Safety-first development orchestration and delivery control plane for Customer Zero projects.

## OpenClaw priority

High.

## Current phase

Stage 1B — Customer Zero Phase 6 recovery acceptance.

## Last known status

The capability-manifest foundation and reviewer-runtime readiness/recovery are merged. PR #73 added exact operation leases and bounded orphan recovery for Phases 6D, 6E, and 6F at 002f47afc45b6eeadfb98d232d88b6e074a66339. Automated quality gates passed; live macOS interruption acceptance remains pending.

## Next action

Add a disposable Customer Zero Phase 6D/6E/6F recovery acceptance runner following local-operator/phase-6-recovery-acceptance.md. Exercise real child-process interruption and existing recovery APIs in isolated fixtures, emit a bounded PASS/FAIL/SKIP matrix, and preserve exact-SHA evidence, attempt limits, and all existing safety boundaries.

## Codex fit

Good fit for small, backend-oriented orchestration changes. Preserve existing exact-SHA evidence, sandboxing, bounded attempts, reconciliation, GitHub delivery, and owner production authority.

## Do not change

- Do not expose PPO self-development through ordinary `/ppo` or OpenClaw routes.
- Do not permit caller-selected repositories, runtimes, policies, providers, or deployment targets.
- Do not add public signup, authentication, billing, teams, or production SaaS infrastructure.
- Do not weaken exact-SHA evidence, bounded remediation, reconciliation, or owner approval.
- Keep acceptance fixtures separate from existing development runs, managed workspaces, credentials, GitHub writes, and production.

## Known risks

- Self-modification can weaken the operator's own safety controls if repository identity is not fixed.
- Runtime and validation drift can allow locally accepted changes to fail in GitHub CI.
- Credential-presence checks can report a revoked Codex refresh token as logged in unless readiness includes a live authenticated probe.
- Broad architecture work can hide unrelated behavior changes and make review ineffective.
