# Phase 6F Independent Review Agent

Phase 6F adds a deterministic local independent review agent foundation:

```text
local-operator/development-review-agent.mjs
```

The agent accepts a Phase 6A run only after Phase 6E has transitioned it to `tests_passed` with exact-SHA PASS evidence. It uses the existing Phase 6C workspace registry to find the isolated workspace and invokes only a trusted locally configured review executable.

## Inputs

Independent review requires:

- a Phase 6A run id
- exact expected run-state version
- a trusted Phase 6C project workspace registry
- trusted local reviewer executable configuration
- trusted explicit no-outbound-network OS/process sandbox configuration
- a Phase 6D implementation evidence record whose SHA equals `run.headSha`
- a Phase 6E PASS evidence record whose SHA equals `run.headSha`
- a verified clean Phase 6C workspace whose branch and HEAD equal `run.headSha`

Reviewer configuration is trusted local configuration. It must not be built from task text, model output, chat, project Markdown, repository scripts, package-manager scripts, or user-supplied shell strings.

## Reviewer Policy Shape

The reviewer policy contains a fixed reviewer id/version, one trusted absolute executable path, explicit argv, sanitized environment additions, sandbox backend, bounded timeout, and bounded output capture.

The agent refuses arbitrary command strings, `shell: true`, shell interpreters, Codex implementation adapters, GitHub write tools, push/merge/deploy tooling, OpenClaw, secret-looking env keys, untrusted executables, unbounded timeouts, and unbounded output.

## Prompt

The review prompt is deterministic and bounded. It may include:

- bounded task text from the run
- implementation SHA and Phase 6D metadata-only evidence facts
- Phase 6E test policy/result metadata
- bounded local diff and file facts derived from Git
- approved security and scope requirements
- the strict structured output schema

The prompt must not include secrets, raw stdout/stderr, raw failures, credentials, environment dumps, arbitrary logs, arbitrary absolute paths, or unbounded file contents.

## Behavior

The agent:

- reloads the Phase 6A run and requires the exact expected version
- accepts the first attempt only from `tests_passed`
- refuses retry while an open ambiguous attempt requires reconciliation
- requires Phase 6D implementation evidence SHA to equal `run.headSha`
- requires Phase 6E PASS evidence SHA to equal `run.headSha`
- resolves and verifies the Phase 6C workspace from the trusted workspace registry
- requires workspace branch and HEAD to equal `run.headSha`
- refuses dirty workspace state before and after review
- verifies the no-outbound-network process sandbox before reserving an attempt
- transitions `tests_passed -> review_in_progress` before executing review
- records bounded durable review attempts in the Phase 6A run record
- invokes the reviewer with `shell: false`, fixed `cwd` set to the verified workspace, sanitized env, bounded timeout, bounded output capture, and prompt on stdin
- validates only strict structured reviewer output
- treats timeout, signal, killed/interrupted process, output overflow, and uncertain outcomes as ambiguous
- leaves ambiguous attempts open and requires read-only reconciliation before retry
- re-checks workspace HEAD and cleanliness immediately before final approval transition
- transitions `review_in_progress -> review_passed` only on valid exact-SHA approval
- transitions `review_in_progress -> review_changes_requested` on valid blockers, owner action, security ambiguity, malformed output, contradictory output, or wrong reviewed SHA

Phase 6A's canonical review status names are `review_in_progress`, `review_passed`, and `review_changes_requested`.

## Structured Output

Reviewer stdout must be one bounded JSON object with exactly the approved schema:

```json
{
  "decision": "APPROVED",
  "reviewedSha": "0000000000000000000000000000000000000000",
  "mergeAllowed": true,
  "blockers": [],
  "securityFindings": [],
  "testsRequired": [],
  "summary": "bounded summary"
}
```

`decision` must be `APPROVED`, `CHANGES_REQUESTED`, or `OWNER_ACTION_REQUIRED`. `reviewedSha` must equal `run.headSha`.

`APPROVED` requires `mergeAllowed=true`, zero blockers, zero unresolved security findings, zero required follow-up tests, and valid exact-SHA Phase 6E PASS evidence.

`CHANGES_REQUESTED` and `OWNER_ACTION_REQUIRED` must set `mergeAllowed=false`.

Malformed, contradictory, oversized, uncertain, or unparseable reviewer output fails closed. Reviewer prose outside the validated schema is ignored.

## Evidence

Review evidence is stored under Phase 6A `review` evidence and is pinned to the reviewed implementation SHA. It may include:

- reviewer id and reviewer policy hash
- implementation SHA
- prompt hash
- decision
- merge allowed flag
- bounded blocker/security/test counts
- summary hash
- started/ended timestamps
- attempt number
- aggregate outcome
- sandbox id and no-network status

It must not include prompt contents, reviewer raw stdout/stderr, raw failures, credentials, tokens, terminal confirmation values, environment dumps, arbitrary absolute paths, executable paths, argv, sandbox executable paths, Linux namespace paths, or unbounded logs.

## Recovery

`reconcileIndependentReview()` is read-only. It reports whether an attempt is open, whether implementation/test evidence still matches `run.headSha`, whether the workspace still matches `run.headSha`, whether dirty or changed workspace state invalidates approval, and whether prior approval evidence is still valid for the exact current workspace HEAD.

If workspace HEAD changes after approval, the old review evidence is invalid for the changed workspace and reconciliation reports approval as not valid.

## Boundary

Phase 6F does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, implementation-file edit, Codex implementation call, automated hardening/remediation loop, GitHub write, PR automation, push, merge, deployment, rollback, production verification, service control, or `/ppo continue`.
