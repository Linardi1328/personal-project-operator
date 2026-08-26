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

The reviewed TypeScript monorepo foundation and shared TypeScript configuration foundation are merged. The repository now contains pinned Node.js, pnpm, Turborepo, and TypeScript root tooling; the planned mobile, admin, API, shared-package, and Prisma boundaries; reusable base, Node.js, Next.js, and Expo compiler configurations; minimal consumer TypeScript configurations; deterministic foundation tests; and the PPO pull-request validation workflow.

## Next action

Add one focused shared ESLint flat-configuration foundation. Populate `packages/eslint-config` with bounded reusable configurations for TypeScript, Node.js, Next.js, and Expo, add only minimal consumer `eslint.config.mjs` files proving reuse, and extend `tests/foundation.test.mjs` with deterministic guardrail checks.

## Codex fit

Good fit for the approved shared ESLint configuration task. Keep application features, data models, authentication, deployment, and broader tooling changes split into separate small or medium runs.

## Do not change

- Do not repeat or replace the merged monorepo or shared TypeScript configuration foundations.
- Do not expand the next run beyond shared ESLint flat configuration, minimal consumers, and deterministic foundation checks.
- Do not expose or deploy production systems without review.
- Do not weaken parent/guardian, coach, administrator, or athlete authorization boundaries.
- Do not add credentials or real participant data.
- Do not implement autonomous coaching or unrestricted messaging.

## Known risks

- The platform may process information about minors.
- Role and relationship mistakes could expose private athlete or family data.
- Broad foundation tasks could prematurely couple mobile, admin, API, data, and infrastructure concerns.
- Future notification, reward, event, and AI features need explicit consent, audit, and abuse-prevention boundaries.
