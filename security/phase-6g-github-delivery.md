# Phase 6G Security Boundary

Phase 6G covers acceptance gates, GitHub delivery, exact-head remote PR review, and SHA-pinned auto-merge. It deliberately stops at `merged`; Phase 6H owns the separate exact-SHA deployment boundary, and verification belongs to a later phase.

## Trusted Inputs

Trusted inputs are limited to:

- the fixed five-project registry
- the Phase 6A run record
- canonical Phase 6C workspace facts
- metadata-only Phase 6D, 6E, and 6F evidence
- bounded GitHub PR/CI/branch/merge facts fetched through fixed operations
- trusted local reviewer configuration

Task text, model output, chat input, repository-controlled scripts, raw CI logs, raw API bodies, raw stdout/stderr, and arbitrary command strings cannot grant acceptance or choose GitHub behavior.

## Acceptance

The acceptance gate is deterministic. It returns delivery allowed only when the exact expected run version is supplied and all SHA-pinned evidence and workspace facts match `run.headSha`.

The reviewed SHA, tested SHA, implementation SHA, and workspace HEAD must be identical. Any SHA movement invalidates delivery and merge readiness.

## GitHub Writes

Allowed writes are strictly limited to:

- push the approved implementation SHA to the approved Phase 6C branch
- create the approved PR from that branch to `main`, or reuse the unique existing exact PR
- merge the approved PR with expected-head-SHA protection

Disallowed writes include issues, labels, comments, releases, workflow dispatch, branch deletion, repository settings, branch protection changes, force pushes, tags, arbitrary endpoints, deployment, rollback, and service control.

Git and GitHub calls use trusted executables, explicit argv, and `shell: false`. Phase 6G does not accept caller-supplied git command strings, remote names, remote URLs, merge methods, or PR targets.

## Reconciliation

Network writes can complete remotely while the local process times out. Phase 6G handles this by read-only reconciliation:

- push ambiguity is resolved by remote branch SHA
- PR creation ambiguity is resolved by unique exact branch/base PR lookup
- merge ambiguity is resolved by PR merged state, merge commit SHA, and `main`

Unexpected SHA or conflicting state fails closed for owner action. The agent does not blindly repeat ambiguous writes.

## Remote Review

Remote PR review reuses Phase 6F reviewer boundaries:

- read-only workspace, source checkout, and Git state
- no outbound network
- explicit argv
- `shell: false`
- sanitized environment
- bounded timeout and output
- strict structured JSON decision

Remote `APPROVED` requires exact PR-head SHA, `mergeAllowed=true`, exact-head CI PASS, and empty blockers/security findings/tests required. `CHANGES_REQUESTED` and `OWNER_ACTION_REQUIRED` cannot merge.

Remote technical changes may re-enter the existing Phase 6F hardening lifecycle through explicit `review_changes_requested` evidence. Every new implementation SHA must repeat local tests, local review, remote branch update, exact-head CI, and remote review.

## Persistence

Delivery and merge evidence is metadata-only. It may persist bounded policy, branch, PR, CI, review, and merge identifiers.

It must not persist credentials, tokens, authorization headers, SSH material, raw API responses, raw CI logs, raw stdout/stderr, raw errors, arbitrary executable paths, or unbounded text.
