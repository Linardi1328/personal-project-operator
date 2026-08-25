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

Phase 1 technology and engineering foundation.

## Last known status

The reviewed TypeScript monorepo foundation is merged. The repository now contains pinned Node.js, pnpm, Turborepo, and TypeScript root tooling; the planned mobile, admin, API, shared-package, and Prisma boundaries; a deterministic foundation test; and the PPO pull-request validation workflow.

## Next action

Add one focused shared TypeScript configuration foundation. Populate `packages/typescript-config` with reusable compiler configurations for Node, Next.js, and Expo, add only minimal consumer `tsconfig.json` files proving inheritance, and extend `tests/foundation.test.mjs` with deterministic guardrail checks. Do not add application features, runtime dependencies, authentication, database models, deployment configuration, or production integrations.

## Codex fit

Good fit for the approved shared TypeScript configuration task. Keep later mobile, admin, API, data, security, observability, and deployment work split into separate small or medium runs.

## Do not change

- Do not repeat or replace the merged monorepo scaffold.
- Do not expand the next run beyond shared TypeScript configuration and its deterministic foundation checks.
- Do not expose or deploy production systems without review.
- Do not weaken parent/guardian, coach, administrator, or athlete authorization boundaries.
- Do not add credentials or real participant data.
- Do not implement autonomous coaching or unrestricted messaging.

## Known risks

- The platform may process information about minors.
- Role and relationship mistakes could expose private athlete or family data.
- Broad foundation tasks could prematurely couple mobile, admin, API, data, and infrastructure concerns.
- Future notification, reward, event, and AI features need explicit consent, audit, and abuse-prevention boundaries.
