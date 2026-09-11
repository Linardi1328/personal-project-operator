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

Stage 2 implementation handoff — joint acceptance pending.

## Last known status

Stage 1 local and macOS fixture acceptance passed at fd83d37ab9cb3ee5ade45df9a76ad6fba8c24842. Stage 2A completed managed exact-SHA tests and independent review at 4fa8aa743fbabc3fc514683f70e93b50e0076c9c in run Z1VdSpMAI4g8yTl_vvozjS5j66-ReF7ZZkMyWLE_X8Q, then merged at 8ea179fde72258f45fc1993244530863b5ae19e6. The combined Stage 2B–2E implementation candidate now provides deterministic provider contracts, legacy run/evidence ownership compatibility, bounded read-only metrics, an integrated inspection facade, and exact-revision handoff instructions. Independent review, CI, merge, and joint Stage 2 acceptance remain pending; no production provider integration or tenant-isolation claim has been made.

PR #79 quality-gate enforcement is merged and owner Mac validation passed. Stage 1
now includes fixed policy metadata for the six ordinary projects and combined
local validation. Remote workflows, host readiness, and deployment providers for
those projects remain explicitly unverified, not inferred from policy parity.

PR #78 delivered the fixed read-only capability validator at abd42304ded9d8f807b6ca515b19d7d0e23b9935. GitHub validation and owner-run macOS validation passed. This stage runs that validator before every approved quality-gate workload so configuration drift fails delivery checks automatically.

The capability-manifest foundation and reviewer-runtime readiness/recovery are merged. PR #76 delivered the disposable recovery acceptance runner at f24c57719beb93c46d742dcd4089c0d2f6daf42f. CI and owner-run macOS acceptance passed on PR head 304cc9ed1dd3714b1c6d71047263e4296ecd7b6a. The owner also reported critical-lifecycle passing on merged main on 2026-09-07 with Node v24.20.0. An intermittent readiness failure remains undiagnosed; passing reruns do not establish a fix. The diagnostics follow-up preserves bounded failure reasons in matrix output and adds deterministic pre-readiness failure coverage.

## Next action

No next action for implementation. Review and merge the combined Stage 2B–2E candidate, then follow local-operator/customer-zero-stage2-acceptance.md with the owner; joint exact-revision owner acceptance remains pending.

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
