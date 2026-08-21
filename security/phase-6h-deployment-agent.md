# Phase 6H Security Boundary

Phase 6H covers exact-SHA deployment for the Personal Project Operator service after Phase 6G has merged an approved PR. It deliberately stops at `deployed`; verification and rollback belong to later phases.

## Trusted Inputs

Trusted inputs are limited to:

- the Phase 6A run record
- metadata-only Phase 6D, 6E, 6F, and 6G evidence
- the fixed `personal-project-operator` deployment profile
- read-only facts from the fixed deployment checkout

The deployment SHA must come only from Phase 6G merged evidence and must equal the Phase 6G merge commit SHA. Caller input, task text, chat, environment variables, command-line text, project Markdown, repository-controlled configuration, and model output cannot choose the deployment target.

## Allowed Writes

Allowed writes are strictly limited to:

- transition a valid run from `merged` to `deploy_in_progress`
- switch the fixed PPO checkout to the exact Phase 6G merge SHA
- restore approved checkout ownership and permissions
- run the approved runtime preflight
- restart only `ppo-openclaw.service`
- transition to `deploy_failed` or `deployed` with metadata-only evidence

No other deployment, rollback, production verification, health validation, route, credential, GitHub, issue, comment, label, release, tag, branch-protection, branch-deletion, or workflow-dispatch write is allowed.

## Process Boundary

Node process execution uses trusted executable paths, explicit argv, `shell: false`, bounded timeout/output, and sanitized environment.

The trusted shell deployment primitive uses:

- `set -Eeuo pipefail`
- fixed command shapes
- fixed repository identity
- fixed installation and state paths
- fixed service identity
- malformed SHA rejection
- no `eval`
- no arbitrary remotes
- no arbitrary service names
- no caller-controlled command strings

The final deployment selection is an exact SHA checkout. `git pull` must not decide the deployed revision.

## Reconciliation

Ambiguous deployment outcomes include timeout, signal, process interruption, killed process, output overflow, uncertain checkout completion, uncertain service restart completion, and uncertain filesystem durability.

After ambiguity, Phase 6H preserves the open attempt and requires read-only reconciliation. Reconciliation may report that the exact checkout SHA is installed, but it must not infer full deployment success unless durable evidence proves the approved preflight and fixed restart completed. It must not restart the service, mutate the repo, or retry deployment.

## Persistence

Deployment evidence is metadata-only. It may persist bounded policy, attempt, expected SHA, previous installed SHA, checkout SHA, service identity, timestamp, result class, and outcome metadata.

It must not persist tokens, credentials, authorization headers, SSH material, environment dumps, raw stdout/stderr, raw process failures, arbitrary absolute paths, shell command strings, or unbounded errors.
