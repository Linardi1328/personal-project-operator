# Phase 7A Controlled PPO Start Safety Boundary

Phase 7A exposes one controlled run-creation route:

```text
/ppo start <project>
```

## Policy Identity

The route has its own Phase 7A route id, policy id, and deterministic policy hash in:

```text
local-operator/development-start-route.mjs
```

The policy hash covers:

- caller input limited to one project id
- the fixed ordinary six-project scope
- reuse of Phase 6B `createPlannedDevelopmentRun(projectId)`
- no forwarding of caller-controlled route options into Phase 6B
- strict validation of planned child results before returning a continuation command
- zero production actions
- zero model routing
- zero automatic continuation

## Allowed

Phase 7A may:

- validate one exact allowlisted project id
- call the existing Phase 6B planned-run creator once with only the approved internal invocation
- create exactly one Phase 6A planned run when Phase 6B returns a valid planned outcome
- return bounded project/run/status/next-stage/base-SHA output
- return `/ppo continue <run-id>` only as the next manual command
- return bounded `owner_action_required` reason information without creating a run

Before returning success, Phase 7A must require the requested project, plan project, and run project to match the same allowlisted id; `run.status` to equal `planned`; the run id to be a valid 43-character id; the next stage to be exactly `planning` or `implementation`; plan/run base SHA values to be valid and equal; and the run head SHA to be valid and equal to that base SHA. Malformed planned child results fail closed with bounded `ROUTE_UNAVAILABLE` owner-action output and no continuation command.

## Blocked

Phase 7A must not:

- accept unknown projects, missing projects, extra arguments, malformed whitespace/envelopes, control characters, paths, repo names, task text, SHAs, versions, branches, policies, runtime options, confirmations, or actions
- create a second planner, run-state store, GitHub client, source reader, or planning engine
- automatically call `/ppo continue`
- create workspaces
- invoke Codex, OpenAI, ChatGPT, or another model
- run tests or review/hardening
- push, create PRs, merge, or call GitHub write APIs
- deploy, verify production, rollback, restart services, or mutate VPS state
- add a new OpenClaw tool or route through model interpretation

Planner owner-action outcomes and safe failures must not expose secrets, credentials, raw source text, raw stdout/stderr, stack traces, environment data, terminal confirmation values, or unbounded logs.
