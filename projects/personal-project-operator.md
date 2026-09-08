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

Stage 1C — Read-only Customer Zero capability validation.

## Last known status

The capability-manifest foundation and reviewer-runtime readiness/recovery are merged. PR #76 delivered the disposable recovery acceptance runner at f24c57719beb93c46d742dcd4089c0d2f6daf42f. CI and owner-run macOS acceptance passed on PR head 304cc9ed1dd3714b1c6d71047263e4296ecd7b6a. The owner also reported critical-lifecycle passing on merged main on 2026-09-07 with Node v24.20.0. An intermittent readiness failure remains undiagnosed; passing reruns do not establish a fix. The diagnostics follow-up preserves bounded failure reasons in matrix output and adds deterministic pre-readiness failure coverage.

## Next action

Owner action required: review the read-only PPO capability validator and run `node capabilities/validate-ppo.mjs` on the approved macOS checkout after delivery. The diagnostics follow-up was merged in PR #77 at 3401036 and all 25 focused tests passed on macOS. Do not repeat completed implementation tasks. Define broader project support only after this fixed PPO validator is accepted.

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
