# Phase 7A Controlled PPO Start Route

Phase 7A adds a narrow route adapter:

```text
local-operator/development-start-route.mjs
node local-operator/ppo-command.mjs start <project>
/ppo start <project>
```

## Boundary

The route accepts exactly one caller-controlled value: one existing six-project id.

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

The route does not forward caller-controlled route options into Phase 6B. Runtime/test dependencies are separate trusted internals, and the Phase 6B call receives only the approved internal option allowlist.

## Output

Successful planning creates one run through Phase 6B and returns bounded output only after the child result passes strict validation for:

- project id
- run id
- status
- next stage
- base SHA
- run head SHA matching the base SHA
- `/ppo continue <run-id>` as the next command

If Phase 6B returns `owner_action_required`, no run is created and output is limited to bounded planner outcome/reason information. If Phase 6B returns a malformed planned result, Phase 7A fails closed with bounded `ROUTE_UNAVAILABLE` owner-action output and no continuation command.

## Blocked

Phase 7A must not accept task text, repo names, paths, SHAs, branches, versions, policies, runtime options, confirmations, actions, malformed whitespace, control characters, or extra arguments.

Phase 7A must not automatically call `/ppo continue`, create workspaces, invoke Codex, run tests, run review/hardening, push, create PRs, merge, deploy, verify production, rollback, add a new OpenClaw tool, or use model interpretation.
