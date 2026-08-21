# Phase 6F Independent Review and Bounded Hardening Pipeline

Phase 6F adds a deterministic local independent review agent and bounded hardening foundation:

```text
local-operator/development-review-agent.mjs
local-operator/development-hardening-orchestrator.mjs
```

The agent accepts a Phase 6A run only after Phase 6E has transitioned it to `tests_passed` with exact-SHA PASS evidence. It uses the existing Phase 6C workspace registry to find the isolated workspace and invokes only a trusted locally configured review executable.

The hardening orchestrator accepts a run only after the reviewer has transitioned it to `review_changes_requested` with valid durable `CHANGES_REQUESTED` findings for exactly `run.headSha`. It coordinates the existing Phase 6D Codex adapter, Phase 6E test runner, and Phase 6F reviewer; it does not implement parallel execution engines.

## Inputs

Independent review requires:

- a Phase 6A run id
- exact expected run-state version
- a trusted Phase 6C project workspace registry
- trusted local reviewer executable configuration
- trusted explicit no-outbound-network and read-only-workspace OS/process sandbox configuration
- a Phase 6D implementation evidence record whose SHA equals `run.headSha`
- a Phase 6E PASS evidence record whose SHA equals `run.headSha`
- a verified clean Phase 6C workspace whose branch and HEAD equal `run.headSha`

Reviewer configuration is trusted local configuration. It must not be built from task text, model output, chat, project Markdown, repository scripts, package-manager scripts, or user-supplied shell strings.

## Reviewer Policy Shape

The reviewer policy contains a fixed reviewer id/version, one trusted absolute executable path, explicit argv, sanitized environment additions, sandbox backend, bounded timeout, and bounded output capture.

The agent refuses arbitrary command strings, `shell: true`, shell interpreters, Codex implementation adapters, GitHub write tools, push/merge/deploy tooling, OpenClaw, secret-looking env keys, untrusted executables, unbounded timeouts, and unbounded output.

Reviewer sandbox configuration must also enforce read-only access to the verified workspace while preserving local read access. On macOS, PPO generates a `sandbox-exec` profile that denies `file-write*` under the verified workspace/repo. On Linux, PPO requires a trusted read-only workspace mount/bind/mount-namespace wrapper before privilege drop. Review fails closed if local read access, workspace file-write denial, local Git mutation denial, or no-outbound-network denial cannot be verified before the review attempt is reserved.

## Prompt

The review prompt is deterministic and bounded. It may include:

- bounded task text from the run
- implementation SHA and Phase 6D metadata-only evidence facts
- Phase 6E test policy/result metadata
- bounded local diff and file facts derived from Git
- approved security and scope requirements
- the strict structured output schema

The prompt must not include secrets, raw stdout/stderr, raw failures, credentials, environment dumps, arbitrary logs, arbitrary absolute paths, or unbounded file contents.

The generated prompt must align with the strict parser:

- `APPROVED` means `mergeAllowed=true` and `blockers`, `securityFindings`, and `testsRequired` are all empty.
- `CHANGES_REQUESTED` means `mergeAllowed=false`.
- `OWNER_ACTION_REQUIRED` means `mergeAllowed=false`.

It must not show a schema example that hard-codes `mergeAllowed=false` for `APPROVED`.

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
- verifies the no-outbound-network and read-only-workspace process sandbox before reserving an attempt
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
- sandbox id, no-network status, and read-only workspace status
- bounded validated blocker, security finding, and required-test items for remediation

It must not include prompt contents, reviewer raw stdout/stderr, raw failures, credentials, tokens, terminal confirmation values, environment dumps, arbitrary absolute paths, executable paths, argv, sandbox executable paths, Linux namespace paths, read-only wrapper paths, or unbounded logs.

## Hardening

`executeBoundedHardening()` starts only from `review_changes_requested` and requires exact expected-version optimistic concurrency. The latest independent review decision evidence must:

- belong to `run.headSha`
- have `decision=CHANGES_REQUESTED`
- have `mergeAllowed=false`
- include matching bounded durable findings evidence
- include at least one validated blocker or security finding

Remediation context is deterministic and derived only from durable review evidence:

- original task from the run record
- reviewed SHA
- validated blockers
- validated security findings
- validated tests required

Caller-supplied remediation text, chat text, task updates, model prose, repository commands, and shell strings are ignored. Oversized, malformed, contradictory, control-character, or secret-like findings are refused.

Each hardening round performs the full lifecycle:

```text
review_changes_requested
-> implementation_in_progress
-> implementation_ready
-> tests_in_progress
-> tests_passed
-> review_in_progress
-> review_passed OR review_changes_requested
```

The implementation step reuses the Phase 6D Codex adapter. Phase 6D consumes only trusted durable remediation context, preserves the no-outbound-network sandbox, and must produce a new verified local descendant commit. The new implementation SHA becomes `run.headSha`.

Phase 6D hardening prompt construction is fail-safe. Every validated blocker, security finding, and required test from durable review evidence must reach Codex, along with the mandatory isolated-workspace, no-push, no-merge, no-deploy, no-credential, and no-destructive-operation boundaries. Only lower-priority optional task/planning context may be trimmed to fit the fixed prompt bound. If required remediation or safety content cannot fit, prompt construction fails closed.

Every implementation SHA change invalidates prior test PASS and review evidence. Phase 6E must run again for the new SHA, and Phase 6F review may run only after the new SHA has exact PASS evidence.

Automatic hardening is capped at three durable rounds per development run. If the cap is exhausted without exact-SHA approval, PPO records metadata-only `owner_action_required` evidence and stops. It does not continue implementation, testing, review, merge, deployment, rollback, or verification.

Timeout, signal, killed/interrupted process, output overflow, or uncertain Codex/test/review outcomes stop the loop and leave the run in the appropriate in-progress state. The existing read-only reconciliation path must be used before any later continuation.

## Recovery

`reconcileIndependentReview()` is read-only. It reports whether an attempt is open, whether implementation/test evidence still matches `run.headSha`, whether the workspace still matches `run.headSha`, whether dirty or changed workspace state invalidates approval, and whether prior approval evidence is still valid for the exact current workspace HEAD.

`reconcileBoundedHardening()` is read-only. It reports current round, current SHA, latest review decision, whether remediation is pending or in progress, test evidence validity, review evidence validity, and owner-action/non-convergence state. It performs no mutation.

If workspace HEAD changes after approval, the old review evidence is invalid for the changed workspace and reconciliation reports approval as not valid.

## Boundary

Phase 6F does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, parallel implementation/test/review engines, unbounded hardening/remediation loop, GitHub write, PR automation, push, merge, deployment, rollback, production verification, service control, or `/ppo continue`.
