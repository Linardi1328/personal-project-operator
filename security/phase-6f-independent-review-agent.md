# Phase 6F Independent Review Agent Safety Boundary

Phase 6F adds one local independent exact-SHA review foundation:

```text
local-operator/development-review-agent.mjs
```

It reviews only a verified Phase 6C isolated workspace for a Phase 6A run that Phase 6E has already advanced to `tests_passed`.

## Allowed

Phase 6F may:

- read one Phase 6A run from `${PPO_WRITE_DATA_DIR}/development-runs`
- require exact expected-version optimistic concurrency
- reuse Phase 6C workspace location and reconciliation checks
- require Phase 6D implementation evidence SHA to equal `run.headSha`
- require Phase 6E PASS evidence SHA to equal `run.headSha`
- require workspace branch and HEAD to equal `run.headSha`
- require a clean workspace before and after review
- establish and verify a trusted explicit no-outbound-network OS/process sandbox before review executes
- invoke one trusted locally configured reviewer executable with explicit argv, `shell: false`, and `cwd` set to the verified workspace
- pass a deterministic bounded review prompt without secrets, raw outputs, arbitrary paths, or credentials
- bound timeout and stdout/stderr capture
- use sanitized environment values and deny secret/auth/confirmation propagation
- reserve bounded durable review attempts in the Phase 6A run record
- transition only `tests_passed -> review_in_progress -> review_passed` on exact-SHA approval
- transition `review_in_progress -> review_changes_requested` on valid blockers, owner action, security ambiguity, malformed output, contradictory output, or wrong reviewed SHA
- record metadata-only SHA-pinned review evidence
- inspect interrupted review state and approval validity read-only

## Blocked

Phase 6F must not:

- accept reviewer commands from task text, model output, chat, project Markdown, repository scripts, package-manager scripts, or user-supplied shell
- run arbitrary command strings, shell interpolation, or `shell: true`
- run untrusted executables, shell interpreters, implementation adapters, GitHub write tools, Git push/merge tooling, deployment tools, OpenClaw, or Codex implementation commands
- execute review outside the verified Phase 6C workspace
- modify workspace files, commit, push, merge, create PRs, or open GitHub writes
- persist reviewer raw stdout/stderr, prompt contents, raw failures, secrets, credentials, terminal confirmation values, environment dumps, arbitrary absolute paths, executable paths, argv, sandbox executable paths, Linux namespace paths, or unbounded logs
- pass review if Phase 6D implementation evidence or Phase 6E PASS evidence does not match `run.headSha`
- pass review if workspace branch or HEAD differs from `run.headSha`
- pass review if the workspace is dirty before or after review
- treat a timeout, signal, interruption, killed process, output overflow, or uncertain result as definitive approval
- trust reviewer prose outside the validated structured schema
- approve when blockers, unresolved security findings, or required tests are present
- invoke the implementation adapter, automated hardening loops, or remediation loops
- call GitHub writes, create PRs, push, merge, rebase, reset, cherry-pick, deploy, restart services, roll back, or perform production verification
- add `/ppo continue`
- add Telegram/OpenClaw routes or new OpenClaw tools

The default Phase 6F policy is no outbound network. A network-enabled review policy is outside this phase unless a later separately reviewed trusted policy and sandbox boundary explicitly approves it.
