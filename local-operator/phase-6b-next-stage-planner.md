# Phase 6B Next-Stage Planner

Phase 6B adds a deterministic local planner foundation:

```text
local-operator/development-next-stage-planner.mjs
```

The planner reads only fixed approved sources:

- `projects/<allowlisted-project>.md`
- `ROADMAP.md`
- existing Phase 2 GitHub read-only snapshot facts

It does not accept arbitrary repo names, file paths, source globs, or filesystem traversal input.

## Output

The planner returns a bounded structured result with:

- planner outcome
- allowlisted project metadata
- current phase/status/next action from project state
- next supported stage and exact source-backed task when safe
- base Git SHA from GitHub read-only facts
- bounded source evidence references
- metadata-only source hashes
- owner-action-required reason when planning is unsafe

The only successful Phase 6B next stages are:

```text
planning
implementation
```

Missing, contradictory, ambiguous, completed, product-choice-dependent, unsafe, unsupported, or malformed state returns `owner_action_required`.

## Run-State Integration

Phase 6B reuses the Phase 6A store:

```text
local-operator/development-run-state.mjs
```

It can create a new Phase 6A run, then transition it:

```text
created -> planning_in_progress -> planned
```

It can also transition an existing `created` run through the same path using exact expected-version checks. Planning evidence is stored as Phase 6A `planning` evidence with a Git SHA, plan hash, source hashes, counts, and no raw logs or secrets.

## Boundary

Phase 6B does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, planner chat command, `/ppo continue`, workspace creation, branch creation, Codex execution, automated test execution, review automation, PR automation, merge, deployment, rollback, service control, or GitHub write.

It does not mutate `projects/*.md`, `ROADMAP.md`, target repositories, branches, commits, PRs, deployments, services, or OpenClaw config at runtime.
