# Phase 6A Development Run-State Safety Boundary

Phase 6A adds one local-only storage foundation: a durable state-machine record for future PPO autonomous-development runs.

This phase does not add an executable autonomous-development workflow.

## Allowed

Phase 6A may:

- resolve projects through the existing five-project registry only
- create cryptographically random opaque run ids
- store run-state records under `${PPO_WRITE_DATA_DIR}/development-runs`
- create private `0700` directories and `0600` files
- atomically replace the canonical run record with fsynced temp-file write, rename, and directory fsync
- use durable version guards for optimistic concurrency and restart recovery
- reject stale expected versions
- reject skipped, invalid, terminal, and backward lifecycle transitions outside the explicit transition graph
- store bounded SHA-pinned evidence metadata for implementation, review, test, deploy, and verification stages
- maintain immutable hash-chained transition history inside the canonical record

## Protected Data

Run-state evidence must be metadata only.

It must not store:

- raw credentials
- access tokens
- passwords
- authorization headers
- terminal confirmation values
- raw stdout or stderr
- raw exception objects
- stack traces
- unbounded logs
- terminal control or escape sequences

Errors returned by the store must be deterministic safe PPO errors with stable codes and safe messages.

## Blocked

Phase 6A must not:

- add planner logic
- invoke Codex
- call OpenAI or another model
- execute tests
- create branches
- create commits
- push code
- open or update PRs
- approve, close, or merge PRs
- call GitHub write APIs
- run deployment commands
- restart services
- perform rollback
- route `/ppo continue`
- add Telegram/OpenClaw autonomous-development commands
- weaken Phase 5A, 5B, 5C, 5D, or 5E confirmation, audit, and route boundaries
