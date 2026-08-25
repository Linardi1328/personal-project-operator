# Phase 6E Automated Test Runner Safety Boundary

Phase 6E adds one local automated test runner foundation:

```text
local-operator/development-test-runner.mjs
```

It runs approved project tests only inside a verified Phase 6C isolated workspace for a Phase 6A run that Phase 6D has already advanced to `implementation_ready`.

## Allowed

Phase 6E may:

- read one Phase 6A run from `${PPO_WRITE_DATA_DIR}/development-runs`
- require exact expected-version optimistic concurrency
- reuse Phase 6C workspace location and reconciliation checks
- require Phase 6D implementation evidence SHA to equal `run.headSha`
- read test policy only from a trusted local per-project registry
- establish and verify the trusted no-outbound-network command sandbox before tests execute; production Linux uses the local `codex sandbox linux` helper without a model call
- use explicit executable path plus argv test steps with `shell: false`
- set `cwd` only to the verified Phase 6C workspace
- run a fixed bounded number of required test steps
- bound timeout and stdout/stderr capture per step
- use sanitized environment values and deny secret/auth/confirmation propagation
- reserve bounded durable testing attempts in the Phase 6A run record
- transition only `implementation_ready -> tests_in_progress -> tests_passed` on full pass
- record metadata-only SHA-pinned test evidence
- inspect interrupted testing state read-only

## Blocked

Phase 6E must not:

- accept test commands from task text, model output, chat, project Markdown, repository scripts, package-manager scripts, or user-supplied shell
- run arbitrary command strings, shell interpolation, or `shell: true`
- run untrusted executables, shell interpreters, GitHub write tools, Git push/merge tooling, deployment tools, OpenClaw, or Codex as test commands
- execute tests outside the verified Phase 6C workspace
- persist raw stdout/stderr, raw failures, secrets, credentials, terminal confirmation values, environment dumps, arbitrary absolute paths, sandbox executable paths, Linux namespace paths, or unbounded logs
- pass evidence if workspace branch or HEAD differs from `run.headSha`
- pass evidence if the workspace is dirty before or after tests
- treat a timeout, signal, interruption, killed process, output overflow, or uncertain result as a definitive pass or failure
- invoke `codex exec`, ChatGPT, OpenAI APIs, another model, automated review, or hardening loops
- call GitHub writes, create PRs, push, merge, rebase, reset, cherry-pick, deploy, restart services, roll back, or perform production verification
- add `/ppo continue`
- add Telegram/OpenClaw routes or new OpenClaw tools

The default Phase 6E policy is no outbound network. A network-enabled test policy is outside this phase unless a later separately reviewed trusted policy and sandbox boundary explicitly approves it.
