# /start

## Command name

`/ppo start <project>`

`start <project>`

## Purpose

Create one planned ordinary development run for an approved project through the reviewed Phase 6B planner API.

## Input format

```text
/ppo start <project>
```

Terminal wrapper:

```text
node local-operator/ppo-command.mjs start <project>
node local-operator/ppo-command.mjs /ppo start <project>
```

The only accepted caller input is one exact project id from:

```text
khlim-assist
ledgerpilot-ai
spy-market-agent
portfolio
rbl-content-engine
```

## Expected output

On a validated planned outcome, Phase 7A returns bounded metadata:

```text
PPO Development Start
Project: khlim-assist
Run: <run-id>
Status: planned
Next stage: implementation
Base SHA: <base-sha>
Next command: /ppo continue <run-id>
```

If Phase 6B returns `owner_action_required`, no run is created and the output contains only the bounded project/outcome/reason fields. If the Phase 6B planned result is malformed or inconsistent, Phase 7A returns bounded `ROUTE_UNAVAILABLE` owner-action output and does not print a continuation command.

## Safety boundary

Phase 7A reuses `createPlannedDevelopmentRun(projectId)` with only the approved internal Phase 6B invocation and does not create another planner, run-state store, GitHub client, source reader, or planning engine.

Before returning success, the route requires the requested project, plan project, and run project to match the same allowlisted id; the run status to be exactly `planned`; the next stage to be exactly `planning` or `implementation`; the run id to be a valid 43-character id; the plan and run base SHA to be valid and equal; and the run head SHA to match that base SHA.

It rejects unknown projects, missing projects, extra arguments, malformed whitespace/envelopes, control characters, paths, repo names, task text, SHAs, versions, branches, policies, runtime options, confirmations, and actions.

It does not automatically call `/ppo continue`, create a workspace, invoke Codex, run tests or review, push, create a PR, merge, deploy, verify production, rollback, add a new OpenClaw tool, or use model interpretation.
