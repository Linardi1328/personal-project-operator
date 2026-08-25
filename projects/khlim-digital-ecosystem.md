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

Add the reviewed Phase 1 monorepo foundation with pinned root workspace configuration, the planned app and package boundaries, and `tests/foundation.test.mjs` as the deterministic foundation check.

## Codex fit

Good fit for the one approved foundation scaffold. After that run merges, refresh this project state and strengthen the test policy before starting product-feature work. Keep mobile, admin, API, data, security, and deployment work split into separate tasks.

## Do not change

- Do not expand the first `/ppo start` run beyond the reviewed monorepo foundation and its deterministic foundation test.
- Do not start later product-feature runs until this PPO project state and test policy are refreshed after the scaffold merges.
- Do not expose or deploy production systems without review.
- Do not weaken parent/guardian, coach, administrator, or athlete authorization boundaries.
- Do not add credentials or real participant data.
- Do not implement autonomous coaching or unrestricted messaging.

## Known risks

- The platform may process information about minors.
- Role and relationship mistakes could expose private athlete or family data.
- A broad initial scaffold could prematurely couple mobile, admin, API, data, and infrastructure concerns.
- Future notification, reward, event, and AI features need explicit consent, audit, and abuse-prevention boundaries.
