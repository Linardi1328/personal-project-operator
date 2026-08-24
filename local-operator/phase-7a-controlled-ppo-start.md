# Phase 7A Controlled PPO Start Route

Phase 7A adds a narrow route adapter:

```text
local-operator/development-start-route.mjs
node local-operator/ppo-command.mjs start <project>
/ppo start <project>
```

## Boundary

The route accepts exactly one caller-controlled value: one existing five-project id.

Allowed project ids:

```text
khlim-assist
ledgerpilot-ai
spy-market-agent
portfolio
rbl-content-engine
```

The route reuses the reviewed Phase 6B API:

```text
createPlannedDevelopmentRun(projectId)
```

It does not create another planner, run-state store, GitHub client, source reader, or planning engine.

## Output

Successful planning creates one run through Phase 6B and returns bounded output with:

- project id
- run id
- status
- next stage
- base SHA
- `/ppo continue <run-id>` as the next command

If Phase 6B returns `owner_action_required`, no run is created and output is limited to bounded planner outcome/reason information.

## Blocked

Phase 7A must not accept task text, repo names, paths, SHAs, branches, versions, policies, runtime options, confirmations, actions, malformed whitespace, control characters, or extra arguments.

Phase 7A must not automatically call `/ppo continue`, create workspaces, invoke Codex, run tests, run review/hardening, push, create PRs, merge, deploy, verify production, rollback, add a new OpenClaw tool, or use model interpretation.
