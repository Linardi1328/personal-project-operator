# Phase 6I Security Boundary

Phase 6I covers read-only production verification for the Personal Project Operator service after Phase 6H has deployed an exact SHA. It deliberately does not deploy, restart, rollback, or repair production.

## Trusted Inputs

Trusted inputs are limited to:

- the Phase 6A run record
- metadata-only Phase 6G merge evidence
- metadata-only Phase 6H deployed evidence
- the fixed Phase 6H PPO deployment profile
- read-only facts from the fixed production checkout and fixed systemd service

The verification target SHA must come only from Phase 6H `deployed` evidence and must equal the Phase 6G merge commit SHA. Caller input, task text, chat, environment variables, project Markdown, repository configuration, and model output cannot choose the target.

## Allowed Writes

Allowed writes are strictly limited to Phase 6A run-state transitions and metadata-only verification evidence:

- `deployed -> verification_in_progress`
- `verification_in_progress -> verified`
- `verification_in_progress -> verification_failed`

No production write is allowed.

## Process Boundary

Node process execution uses trusted executable paths, explicit argv, `shell: false`, bounded timeout/output, and sanitized environment.

The trusted shell verification primitive uses:

- `set -Eeuo pipefail`
- fixed absolute paths
- fixed repository and service identities
- malformed-SHA rejection
- strict bounded JSON result classes
- no `eval`
- no arbitrary command strings
- no caller-selected paths, services, repositories, refs, commands, executables, or policies

It must not run Git network refreshes, Git checkout mutations, filesystem mutations, service mutations, rollback, package installation, GitHub writes, Codex/model execution, SSH, or secret-exposing commands.

## Reconciliation

Ambiguous verification outcomes include timeout, signal, process interruption, killed process, output overflow, uncertain child completion, and malformed verification output.

After ambiguity, Phase 6I preserves the open attempt and requires read-only reconciliation. Reconciliation can report observable checkout and service state, but it must not transition to `verified` unless durable evidence already proves the full approved verification contract.

## Persistence

Verification evidence is metadata-only. It may persist bounded policy, attempt, deployment SHA, observed checkout SHA, fixed service identity, service active/running booleans, result classes, timestamp, and aggregate outcome metadata.

It must not persist tokens, credentials, authorization headers, SSH material, environment dumps, raw stdout/stderr, journal contents, OpenClaw output, raw process failures, arbitrary absolute paths, shell command strings, or unbounded errors.
