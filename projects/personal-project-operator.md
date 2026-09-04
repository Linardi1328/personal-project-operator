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

Stage 0 — local PPO self-development controller.

## Last known status

The local-only self-development controller is available for the fixed PPO repository and reuses the reviewed Phase 6B–6G lifecycle without exposing PPO self-development through ordinary OpenClaw commands.

## Next action

Add the Customer Zero project capability manifest foundation. Define versioned repository identity, runtime preparation, local quality gates, required GitHub checks, and deployment-provider metadata while preserving all existing project behavior and safety boundaries.

## Codex fit

Good fit for small, backend-oriented orchestration changes. Preserve existing exact-SHA evidence, sandboxing, bounded attempts, reconciliation, GitHub delivery, and owner production authority.

## Do not change

- Do not expose PPO self-development through ordinary `/ppo` or OpenClaw routes.
- Do not permit caller-selected repositories, runtimes, policies, providers, or deployment targets.
- Do not add public signup, authentication, billing, teams, or production SaaS infrastructure.
- Do not weaken exact-SHA evidence, bounded remediation, reconciliation, or owner approval.

## Known risks

- Self-modification can weaken the operator's own safety controls if repository identity is not fixed.
- Runtime and validation drift can allow locally accepted changes to fail in GitHub CI.
- Broad architecture work can hide unrelated behavior changes and make review ineffective.
