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

Stage 3A — KHLIM Assist pilot readiness.

## Last known status

Stage 2 is closed. Stage 2A completed managed exact-SHA tests and independent review at 4fa8aa743fbabc3fc514683f70e93b50e0076c9c, then merged at 8ea179fde72258f45fc1993244530863b5ae19e6. The combined Stage 2B–2E implementation passed CI and merged in PR #87. Joint owner-Mac acceptance passed on 2026-09-17 at exact revision 304685483d01da15afa8c618a4493158458c4562 with Node v24.20.0: 14 focused tests, all five quality gates, 25 recovery tests, and the revision-bound recovery matrix passed; HEAD and the working tree remained exact and clean. Six ordinary-project remote/host observations remain explicit SKIP for Stage 3 readiness. No live Antigravity/Vercel integration, production deployment, public multi-tenancy, or provider-cost claim was established.

PR #79 quality-gate enforcement is merged and owner Mac validation passed. Stage 1
now includes fixed policy metadata for the six ordinary projects and combined
local validation. Remote workflows, host readiness, and deployment providers for
those projects remain explicitly unverified, not inferred from policy parity.

PR #78 delivered the fixed read-only capability validator at abd42304ded9d8f807b6ca515b19d7d0e23b9935. GitHub validation and owner-run macOS validation passed. This stage runs that validator before every approved quality-gate workload so configuration drift fails delivery checks automatically.

The capability-manifest foundation and reviewer-runtime readiness/recovery are merged. PR #76 delivered the disposable recovery acceptance runner at f24c57719beb93c46d742dcd4089c0d2f6daf42f. CI and owner-run macOS acceptance passed on PR head 304cc9ed1dd3714b1c6d71047263e4296ecd7b6a. The owner also reported critical-lifecycle passing on merged main on 2026-09-07 with Node v24.20.0. An intermittent readiness failure remains undiagnosed; passing reruns do not establish a fix. The diagnostics follow-up preserves bounded failure reasons in matrix output and adds deterministic pre-readiness failure coverage.

## Next action

Add the Stage 3A KHLIM Assist pilot-readiness boundary described in CUSTOMER_ZERO_STAGE3_PLAN.md: non-mutating fixed-project checks for repository identity, clean exact revision, approved runtime and tool policy, GitHub validation workflow presence, required host dependencies, and explicit PASS/FAIL/SKIP evidence. It grants no execution or mutation authority and excludes Codex or provider invocation, GitHub changes, preview operations, production operations, and customer messaging.

## Codex fit

Good fit for small, backend-oriented orchestration changes. Preserve existing exact-SHA evidence, sandboxing, bounded attempts, reconciliation, GitHub delivery, and owner production authority.

## Do not change

- Do not expose PPO self-development through ordinary `/ppo` or OpenClaw routes.
- Do not permit caller-selected repositories, runtimes, policies, providers, or deployment targets.
- Do not add public signup, authentication, billing, teams, or production SaaS infrastructure.
- Do not weaken exact-SHA evidence, bounded remediation, reconciliation, or owner approval.
- Keep acceptance fixtures separate from existing development runs, managed workspaces, credentials, GitHub writes, and production.
- Do not treat a Stage 3 plan, SKIP, provider contract, merged PR, or preview as production approval.
- Keep KHLIM Assist participant auto-replies disabled throughout the first pilot.

## Known risks

- Self-modification can weaken the operator's own safety controls if repository identity is not fixed.
- Runtime and validation drift can allow locally accepted changes to fail in GitHub CI.
- Credential-presence checks can report a revoked Codex refresh token as logged in unless readiness includes a live authenticated probe.
- Broad architecture work can hide unrelated behavior changes and make review ineffective.
- Remote/host policy parity can be mistaken for observed readiness unless every SKIP remains explicit.
- Provider adapters can leak credentials, broaden network authority, or hide fallback unless each integration is separately bounded and tested.
- A real internal task can affect KHLIM operations if the no-auto-send and owner-release boundaries are weakened.
