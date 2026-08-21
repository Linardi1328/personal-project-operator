# Phase 6F Independent Review and Bounded Hardening Safety Boundary

Phase 6F adds one local independent exact-SHA review and bounded hardening foundation:

```text
local-operator/development-review-agent.mjs
local-operator/development-hardening-orchestrator.mjs
```

It reviews only a verified Phase 6C isolated workspace for a Phase 6A run that Phase 6E has already advanced to `tests_passed`. It may automatically harden only after valid exact-SHA `CHANGES_REQUESTED` review evidence.

## Allowed

Phase 6F may:

- read one Phase 6A run from `${PPO_WRITE_DATA_DIR}/development-runs`
- require exact expected-version optimistic concurrency
- reuse Phase 6C workspace location and reconciliation checks
- require Phase 6D implementation evidence SHA to equal `run.headSha`
- require Phase 6E PASS evidence SHA to equal `run.headSha`
- require workspace branch and HEAD to equal `run.headSha`
- require a clean workspace before and after review
- establish and verify a trusted explicit no-outbound-network and read-only-workspace OS/process sandbox before review executes
- deny workspace/repo file writes on macOS with `sandbox-exec`
- require a trusted read-only workspace mount/bind/mount-namespace wrapper or equivalent OS boundary on Linux
- preflight local read access, workspace file-write denial, local Git mutation denial, and outbound-network denial before reserving a review attempt
- invoke one trusted locally configured reviewer executable with explicit argv, `shell: false`, and `cwd` set to the verified workspace
- pass a deterministic bounded review prompt without secrets, raw outputs, arbitrary paths, or credentials
- state the strict decision contract in the prompt: `APPROVED` requires `mergeAllowed=true` and empty blockers/security findings/tests required; non-approval decisions require `mergeAllowed=false`
- bound timeout and stdout/stderr capture
- use sanitized environment values and deny secret/auth/confirmation propagation
- reserve bounded durable review attempts in the Phase 6A run record
- transition only `tests_passed -> review_in_progress -> review_passed` on exact-SHA approval
- transition `review_in_progress -> review_changes_requested` on valid blockers, owner action, security ambiguity, malformed output, contradictory output, or wrong reviewed SHA
- record metadata-only SHA-pinned review evidence
- inspect interrupted review state and approval validity read-only
- start bounded hardening only from valid `review_changes_requested` evidence for exactly `run.headSha`
- derive remediation context only from durable validated review blockers, security findings, and required tests
- require Phase 6D hardening prompts to include all validated remediation items and mandatory safety boundaries, trimming only lower-priority optional task/planning context or failing closed
- reuse the Phase 6D Codex adapter, Phase 6E automated test runner, and Phase 6F reviewer
- transition one remediation round through `review_changes_requested -> implementation_in_progress -> implementation_ready -> tests_in_progress -> tests_passed -> review_in_progress`
- require every remediation to produce a new verified descendant implementation SHA
- require fresh Phase 6E PASS evidence and fresh Phase 6F review for every new implementation SHA
- stop automatically after three hardening rounds and record owner-action-required evidence
- inspect hardening status and non-convergence read-only

## Blocked

Phase 6F must not:

- accept reviewer commands from task text, model output, chat, project Markdown, repository scripts, package-manager scripts, or user-supplied shell
- run arbitrary command strings, shell interpolation, or `shell: true`
- run untrusted executables, shell interpreters, implementation adapters, GitHub write tools, Git push/merge tooling, deployment tools, OpenClaw, or Codex implementation commands as reviewer executables
- execute review outside the verified Phase 6C workspace
- rely on postflight dirty-tree detection as the primary reviewer write boundary
- modify workspace files, commit, push, merge, create PRs, or open GitHub writes
- persist reviewer raw stdout/stderr, prompt contents, raw failures, secrets, credentials, terminal confirmation values, environment dumps, arbitrary absolute paths, executable paths, argv, sandbox executable paths, Linux namespace paths, read-only wrapper paths, or unbounded logs
- pass review if Phase 6D implementation evidence or Phase 6E PASS evidence does not match `run.headSha`
- pass review if workspace branch or HEAD differs from `run.headSha`
- pass review if the workspace is dirty before or after review
- treat a timeout, signal, interruption, killed process, output overflow, or uncertain result as definitive approval
- trust reviewer prose outside the validated structured schema
- show a review prompt/schema example that contradicts parser rules for `mergeAllowed`
- approve when blockers, unresolved security findings, or required tests are present
- accept remediation instructions from chat, task text, user input, model prose, repository commands, or shell strings
- silently drop validated remediation findings or mandatory safety boundaries from a hardening prompt
- create parallel implementation, test, or review engines
- continue hardening after three rounds without owner action
- retry ambiguous Codex, test, or review outcomes without the appropriate reconciliation
- call GitHub writes, create PRs, push, merge, rebase, reset, cherry-pick, deploy, restart services, roll back, or perform production verification
- add `/ppo continue`
- add Telegram/OpenClaw routes or new OpenClaw tools

The default Phase 6F policy is no outbound network for review and hardening execution, and read-only workspace access for reviewer execution. A network-enabled review or hardening policy is outside this phase unless a later separately reviewed trusted policy and sandbox boundary explicitly approves it.
