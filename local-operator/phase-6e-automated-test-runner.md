# Phase 6E Automated Test Runner

Phase 6E adds a deterministic local automated test runner foundation:

```text
local-operator/development-test-runner.mjs
```

The runner accepts a Phase 6A run only after Phase 6D has transitioned it to `implementation_ready` with SHA-pinned implementation evidence. It uses the existing Phase 6C workspace registry to find the isolated workspace and runs only tests from a trusted local per-project test policy registry.

## Inputs

Automated testing requires:

- a Phase 6A run id
- exact expected run-state version
- a trusted Phase 6C project workspace registry
- a trusted local per-project test policy registry
- trusted no-outbound-network command sandbox configuration; production Linux uses the local `codex sandbox` helper without a model call
- a Phase 6D implementation evidence record whose SHA equals `run.headSha`
- a verified clean Phase 6C workspace whose branch and HEAD equal `run.headSha`

The test policy registry is trusted local configuration. It must not be built from task text, model output, chat, project Markdown, repository scripts, or user-supplied shell strings.

## Test Policy Shape

Each project policy contains a fixed policy id/version, trusted executable allowlist, sanitized environment additions, sandbox backend, and one to five explicit test steps.

Each test step is:

- an id
- an absolute trusted executable path from the policy allowlist
- an explicit argv array
- a bounded timeout
- a bounded stdout/stderr byte limit

The runner refuses arbitrary command strings, `shell: true`, package-manager script dispatch, shell interpreters, GitHub/remote/deploy executables, secret-looking env keys, untrusted executables, too many steps, unbounded timeouts, and unbounded output.

## Behavior

The runner:

- reloads the Phase 6A run and requires the exact expected version
- accepts the first attempt only from `implementation_ready`
- supports retry only while `tests_in_progress` after definitive failed metadata closes the prior attempt
- requires Phase 6D implementation evidence SHA to equal `run.headSha`
- resolves and verifies the Phase 6C workspace from the trusted workspace registry
- requires workspace branch and HEAD to equal `run.headSha`
- refuses dirty workspace state before and after testing
- verifies the no-outbound-network command sandbox before reserving an attempt
- transitions `implementation_ready -> tests_in_progress` before executing tests
- records bounded durable test attempts in the Phase 6A run record
- executes each test with `shell: false`, fixed `cwd` set to the verified workspace, sanitized env, bounded timeout, and bounded output capture
- stores only metadata-only test results
- stops on the first required failure
- treats timeout, signal, killed/interrupted process, output overflow, and uncertain outcomes as ambiguous
- leaves ambiguous attempts open and requires read-only reconciliation before retry
- re-checks workspace HEAD and cleanliness immediately before final PASS transition
- transitions `tests_in_progress -> tests_passed` only when every required test passes for exactly `run.headSha`

Phase 6A's canonical status names are `tests_in_progress` and `tests_passed`.

## Evidence

Test evidence is stored under Phase 6A `test` evidence and is pinned to the implementation SHA. It may include:

- test id
- policy id and policy hash
- implementation SHA
- exit status class
- duration
- started/ended timestamps
- attempt number
- aggregate outcome
- sandbox id and no-network status

It must not include raw stdout, raw stderr, raw failures, environment dumps, credentials, tokens, terminal confirmation values, arbitrary absolute paths, sandbox executable paths, Linux namespace paths, or unbounded logs.

## Recovery

`reconcileAutomatedTesting()` is read-only. It reports whether an attempt is open, whether the workspace still matches `run.headSha`, whether a dirty or changed workspace invalidates evidence, and whether prior pass evidence is still valid for the exact current workspace HEAD.

If workspace HEAD changes after a pass, the old pass evidence is invalid for the changed workspace and reconciliation reports it as not valid.

## Boundary

Phase 6E does not add a terminal command, `/ppo` route, OpenClaw route, Telegram route, Codex model call, automated review, hardening loop, GitHub write, PR automation, push, merge, deployment, rollback, production verification, service control, or `/ppo continue`. Production Linux may call the local `codex sandbox` helper only as a sandbox launcher; it does not call a model.
