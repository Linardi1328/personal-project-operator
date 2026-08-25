# Phase 6B Next-Stage Planner Safety Boundary

Phase 6B adds one local deterministic planner foundation:

```text
local-operator/development-next-stage-planner.mjs
```

It determines whether one allowlisted project has enough approved source state to create a Phase 6A planned run.

## Allowed

Phase 6B may:

- resolve project ids through the existing six-project registry only
- read the fixed project Markdown file for that project
- read `ROADMAP.md`
- read existing Phase 2 GitHub read-only snapshot facts
- classify the exact `## Next action` text into a supported next stage only when unambiguous
- return a bounded structured plan
- return `owner_action_required` for unsafe or incomplete state
- create a Phase 6A run through the existing run-state store
- transition a run only through `created -> planning_in_progress -> planned`
- attach metadata-only SHA-pinned planning evidence

## Owner Action Required

The planner must stop with `owner_action_required` for:

- missing project state
- malformed source state
- contradictory project state
- ambiguous next action
- already-complete state
- product-choice-dependent state
- unsupported stages
- missing GitHub read-only facts
- unsafe source text

## Blocked

Phase 6B must not:

- invent phases or tasks absent from approved source state
- read arbitrary paths or repos
- mutate `projects/*.md`
- mutate `ROADMAP.md`
- create workspaces
- create branches
- create commits
- push code
- open, update, approve, close, or merge PRs
- call GitHub write APIs
- invoke Codex
- call OpenAI or another model
- run automated tests
- perform review automation
- deploy, restart services, or roll back
- add `/ppo continue`
- add Telegram/OpenClaw routes or new OpenClaw tools

Errors and owner-action outcomes must be deterministic and safe. Planner evidence must not include secrets, credentials, terminal confirmation values, raw stdout/stderr, raw exceptions, stack traces, or unbounded logs.
