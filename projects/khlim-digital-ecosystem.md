# KHLIM Super App

## Project

KHLIM Super App

## Repo

`Linardi1328/khlim-digital-ecosystem`

## Connection status

Connected candidate.

## Current role

Production-oriented athlete-development and club-operations platform for KHLIM Basketball, with a sport-aware core that can support additional sports later.

## OpenClaw priority

High.

## Current phase

Phase 1 technology and engineering foundation preparation.

## Last known status

The repository contains the product, architecture, security, UX, roadmap, and decision-record foundation. The planned TypeScript monorepo and application packages have not been scaffolded yet.

## Next action

Review and approve one focused Phase 1 monorepo-scaffolding task, then add reviewed source-path and automated-test policies before enabling ordinary PPO development runs.

## Codex fit

Good fit for small, reviewable foundation tasks after the first scaffold is explicitly approved. Keep mobile, admin, API, data, security, and deployment work split into separate tasks.

## Do not change

- Do not enable `/ppo start` until fixed source paths and test policies are reviewed.
- Do not expose or deploy production systems without review.
- Do not weaken parent/guardian, coach, administrator, or athlete authorization boundaries.
- Do not add credentials or real participant data.
- Do not implement autonomous coaching or unrestricted messaging.

## Known risks

- The platform may process information about minors.
- Role and relationship mistakes could expose private athlete or family data.
- A broad initial scaffold could prematurely couple mobile, admin, API, data, and infrastructure concerns.
- Future notification, reward, event, and AI features need explicit consent, audit, and abuse-prevention boundaries.
