# Phase 6H Deployment Agent

Phase 6H adds the exact-SHA deployment boundary after Phase 6G. It starts only from a Phase 6A run in `merged` and stops at `deployed`.

## Module

```text
local-operator/development-deployment-agent.mjs
```

Primary entry points:

- `executeDevelopmentDeployment(runId, { expectedVersion })`
- `reconcileDevelopmentDeployment(runId)`

## Entry Gate

Deployment requires:

- run status exactly `merged`
- exact current `expectedVersion`
- valid Phase 6G `merged` evidence for exactly `run.headSha`
- valid Phase 6D implementation evidence for `run.headSha`
- valid Phase 6E PASS evidence for `run.headSha`
- valid Phase 6F local approval for `run.headSha`
- valid Phase 6G remote approval for `run.headSha`
- Phase 6G merge evidence proving `mainSha === mergeCommitSha`

The deployment target is the Phase 6G merge commit SHA. It is not accepted from caller input, task text, chat, environment variables, project Markdown, command-line text, repository-controlled configuration, or model output.

## Run Origination

Personal Project Operator self-development runs use an explicit local-only Phase 6A run-state capability fixed to:

- id: `personal-project-operator`
- owner: `Linardi1328`
- repo: `personal-project-operator`
- fullName: `Linardi1328/personal-project-operator`

Ordinary `resolveDevelopmentRunProject()` and ordinary `createDevelopmentRun()` still reject `personal-project-operator`. The shared five-project registry, Telegram project resolution, OpenClaw project resolution, and ordinary PPO project commands are not expanded.

## Trusted Profile

Phase 6H supports only the `personal-project-operator` deployment profile:

- repository: `Linardi1328/personal-project-operator`
- install directory: `/opt/personal-project-operator`
- service: `ppo-openclaw.service`
- remote: fixed `origin`
- deployment primitive: `/opt/personal-project-operator/deployment/scripts/deploy-exact-sha.sh`
- runtime preflight: `/opt/personal-project-operator/deployment/scripts/preflight-openclaw-runtime.sh`
- service control: `/opt/personal-project-operator/deployment/scripts/service-control.sh`

The shared five-project development registry is not expanded by Phase 6H.

## Deployment Flow

1. Read the run and reject stale versions.
2. Verify the durable Phase 6G exact-SHA chain.
3. Inspect the fixed deployment checkout read-only.
4. Transition `merged -> deploy_in_progress` and reserve one metadata-only attempt.
5. Invoke the fixed exact-SHA deployment primitive with explicit argv and `shell: false`.
6. Reinspect checkout state.
7. Transition `deploy_in_progress -> deployed` only when checkout HEAD equals the Phase 6G merge SHA and the approved preflight and fixed service restart completed.

Definitive failure transitions to `deploy_failed`. Ambiguous outcome leaves the run in `deploy_in_progress`.

## Reconciliation

`reconcileDevelopmentDeployment()` is read-only. It reports:

- run id and status
- expected deployment SHA
- recorded deployment attempt
- current deployment checkout SHA
- whether the exact target SHA is installed
- whether local deployment evidence proves completion
- whether owner action is required

It does not retry deployment, mutate the repository, restart the service, run production health checks, or infer full success after an interrupted service restart.

## Out Of Scope

Phase 6H does not:

- deploy arbitrary projects
- deploy by branch name
- deploy latest `main`
- use `git pull` as final deployment selection
- automatically rollback
- perform production verification or health validation
- add `/ppo continue`
- add Telegram/OpenClaw routing
- alter credentials or authentication
- accept arbitrary repository URLs, install paths, service names, executable paths, remotes, or shell command strings

Read-only production verification belongs to Phase 6I. Rollback remains a separately deferred boundary.
