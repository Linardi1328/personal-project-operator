# Roadmap

## Phase 0 - Documentation Foundation

- Create repo structure.
- Create project docs.
- Create command docs.
- Define safety rules.
- Create OpenClaw command registry.
- Design Telegram command menu.
- Design manual Codex usage tracking.

Phase 0 is documentation-only. It must not perform live API calls, bot registration, deployment, usage scraping, or write actions.

## Phase 1 - Local OpenClaw Test Foundation

- Add a local command simulator.
- Add local project state fixtures.
- Add local command catalog fixtures.
- Test `/status`, `/menu`, and `/help` output from the command line.
- Prepare Telegram local test notes without registering Telegram commands.
- Keep GitHub disconnected.
- Confirm phone-friendly output formatting.

Phase 1 does not install OpenClaw in this repo. OpenClaw should be installed separately on the user's MacBook when local chat routing is tested.

Phase 1 must not call GitHub APIs, Telegram APIs, Codex usage screens, VPS services, or any write-enabled integration.

## Phase 1.5 - OpenClaw Telegram Routing Preparation

- Keep OpenClaw installed outside this repo.
- Keep Telegram connected through the user's local OpenClaw setup.
- Add a `/ppo` command namespace so Personal Project Operator does not override OpenClaw built-ins.
- Add a local wrapper for `/ppo status`, `/ppo menu`, and `/ppo help`.
- Add OpenClaw skill scaffold docs under `openclaw/skills/ppo/`.
- Add Telegram examples for `/ppo status`, `/ppo menu`, and `/ppo help`.
- Do not modify `~/.openclaw` automatically.
- Do not add dependencies, secrets, API calls, VPS deployment, or write actions.

## Phase 2 - GitHub Read-Only Integration

### Phase 2A - Local read-only foundation

- Add a deterministic GitHub read-only client using local `gh`.
- Allow only the fixed connected-candidate project ids.
- Fetch and normalize repo metadata, recent commits, open PRs, and open issues.
- Build compact project snapshots for terminal validation.
- Keep all GitHub requests explicit `GET`.
- Keep Phase 2A terminal-only; do not expose `/ppo repo` or `/ppo pr` through Telegram yet.
- Keep all GitHub write actions disabled.

### Phase 2B - Telegram GitHub read-only routing

- Route `/ppo repo <project>` through `ppo_local` to the Phase 2A read-only client.
- Route `/ppo pr <project>` through `ppo_local` to the Phase 2A read-only client.
- Keep OpenClaw dispatch deterministic and tool-based, without a model turn.
- Do not add new GitHub endpoint families, GraphQL, or write actions.
- Do not add README/tree/CI/changed-file/review enrichment yet.

### Phase 2C - Live GitHub project status

- Route `/ppo status` through `ppo_local` to the Phase 2A read-only client.
- Summarize the connected projects in registry order.
- Show only observable GitHub facts: repo, default branch, latest returned commit, bounded PR counts, conservative bounded issue counts, and updated timestamp.
- Keep menu/help fixture-backed with Phase 2C wording.
- Do not add `/ppo next`, recommendations, Codex prompt generation, new endpoint families, GraphQL, or write actions.

### Later Phase 2 work

- Fetch repo metadata.
- Fetch recent commits.
- Fetch open PRs.
- Fetch issues.
- Summarize project state.
- Add stale-project detection or next-action ranking only after separate approval.
- Add richer read-only repo/PR detail only after separate approval.
- Keep all GitHub write actions disabled.

## Phase 3 - Codex Prompt Generator

### Phase 3A - Local Codex prompt generator foundation

- Add terminal-only `node local-operator/ppo-command.mjs codex <project> <task>`.
- Generate compact text prompts only; do not invoke Codex or any model.
- Use fixed project doc mappings plus approved GitHub read-only facts.
- Include deterministic task-size estimates and hardening emphasis where applicable.
- Keep `/ppo codex` out of OpenClaw/Telegram routing.
- Do not add new GitHub endpoint families, writes, deployments, or target repo changes.

### Phase 3B - Local Codex planning tools

- Add terminal-only `codex-budget <project> <task>`.
- Add terminal-only `prompt-size <draft>`.
- Add terminal-only `split-task <task>`.
- Keep all Phase 3B output deterministic and text-only.
- Do not invoke Codex, ChatGPT, OpenAI APIs, or another model.
- Do not execute generated plans, mutate repositories, create GitHub writes, or deploy services.
- Keep `/ppo codex`, `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` out of OpenClaw/Telegram routing.
- Leave Phase 3C as the separate review point for the approved `/ppo` text command envelopes.

### Phase 3C - OpenClaw text routing

- Route `/ppo codex <project> <task>` through `ppo_local`.
- Route `/ppo codex-budget <project> <task>` through `ppo_local`.
- Route `/ppo prompt-size <draft>` through `ppo_local`.
- Route `/ppo split-task <task>` through `ppo_local`.
- Keep OpenClaw direct tool dispatch with no model interpretation turn.
- Parse only the command envelope in the bridge; treat task and draft text as inert data.
- Preserve multiline `prompt-size` drafts as one wrapper argv value.
- Limit routing to the four approved Phase 3C command envelopes; richer arbitrary-text workflows require separate review.
- Keep all existing Phase 2/3A/3B security boundaries: no new GitHub endpoints, no writes, no Codex/model invocation, no deployment, and no new OpenClaw tools or permissions.

### Later Phase 3 work

- Add richer budget, prompt compression, and splitting workflows only after separate approval.

## Phase 4 - VPS Deployment

### Phase 4A - VPS deployment foundation

- Add Ubuntu 24.04 LTS deployment/bootstrap documentation.
- Target a 2 vCPU / 4 GB RAM class VPS.
- Add guarded VPS-local scripts for OS/runtime dependencies, a non-root service user, repo install/update, systemd service control, firewall/SSH-key hardening, rollback, and read-only health checks.
- Add a systemd unit template for the foreground OpenClaw gateway using the existing PPO wrapper and existing `ppo_local` tool.
- Use the official OpenClaw `install-cli.sh` local-prefix runtime under `/home/ppo/.local/openclaw` rather than Ubuntu 24.04 apt Node.
- Keep the PPO checkout root-owned and read-only to the runtime user.
- Add safe environment-variable and secrets handling guidance.
- Add deterministic/static tests for deployment files.
- Do not perform live SSH, live VPS deployment, Telegram API changes, GitHub writes, model calls, or new OpenClaw permissions.
- Keep `/ppo vps-health` routing deferred; Phase 4A provides only the local health-check foundation.

### Later Phase 4 work

- Owner-run deployment to the reviewed VPS.
- Verify systemd boot recovery and restart behavior on the live host.
- Route `/ppo vps-health` only after separate review.
- Add alerting only after explicit approval.

## Phase 5 - Controlled Write Actions

### Phase 5A - Terminal-only controlled GitHub issue creation

- Add terminal-only `node local-operator/ppo-command.mjs issue-create <project> <title> [body...]`.
- Resolve `<project>` only through the existing six-project GitHub registry.
- Permit only `POST /repos/<approved repo>/issues` with `title` and `body` fields.
- Require exact `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>` before any network write.
- Show a deterministic preview and refuse the write when confirmation is missing or mismatched.
- Write a credential-free audit trail for refused, attempted, succeeded, and failed write actions.
- Keep OpenClaw/Telegram unchanged; do not route `issue-create` through `ppo_local`.
- Do not add PR writes, comments, labels, branches, commits, merges, workflow dispatches, project-state mutations, or deployment behavior.

### Phase 5B - Approval-gated Telegram issue creation

- Add `/ppo issue-create <project> <title> [--body <body>]` through the existing `ppo_local` direct-tool path.
- Add `/ppo issue-confirm <request-id>` through the same `ppo_local` tool.
- Keep `issue-create` as staging only: validate through the existing six-project registry and Phase 5A title/body limits, show the deterministic preview, persist the normalized intent locally, and return the confirmation command.
- Generate cryptographically random opaque one-time request ids and expire pending requests after 10 minutes.
- Keep pending request storage private and configurable with `PPO_WRITE_DATA_DIR`, defaulting to `local-operator/write-data/` for local use and `/var/lib/personal-project-operator/write-data` in systemd.
- Make `issue-confirm` atomically claim one unexpired request before any network write, consume it before invoking the writer, and make replay, expired, malformed, unknown, or already-consumed ids perform zero GitHub writes.
- Reuse the Phase 5A issue writer with its internal exact confirmation value; do not accept or expose terminal write confirmation environment values through chat.
- Preserve the credential-free attempted/succeeded/failed audit trail, with `PPO_GITHUB_WRITE_AUDIT_PATH` configured to `/var/lib/personal-project-operator/audit/github-write-audit.ndjson` on the VPS.
- Do not add a model turn, new OpenClaw tools, provider access, arbitrary GitHub endpoints, comments, labels, assignees, milestones, PR/branch/commit/merge/workflow writes, project-state mutations, or deployments.

### Phase 5C - Terminal-only controlled project notes foundation

- Add terminal-only `node local-operator/ppo-command.mjs note-add <project> <note...>`.
- Resolve `<project>` only through the existing six-project registry.
- Validate note text as inert terminal data: non-empty, maximum 2000 characters, and no terminal control or escape input.
- Require exact `PPO_NOTE_WRITE_CONFIRM=add-note:<project>` before appending a note.
- Show a deterministic preview and refuse the write when confirmation is missing or mismatched.
- Store append-only note records under `${PPO_WRITE_DATA_DIR}/project-notes`, defaulting to `local-operator/write-data/` locally and using `/var/lib/personal-project-operator/write-data` on the VPS.
- Use private `0700` directories and `0600` files, append one fsynced durable note record per confirmed action, and assign a cryptographically random opaque note id plus timestamp/project metadata.
- Write credential/content-free audit records for refused, attempted, succeeded, and failed note actions.
- Fail closed before note mutation if the attempted audit record cannot be established.
- Return an explicit duplicate-warning result if the note append succeeds but the success audit record cannot be written.
- Keep Phase 5C terminal-only; do not route `note-add` through `/ppo`, `ppo_local`, OpenClaw, or Telegram.
- Do not call GitHub APIs, modify `projects/*.md` or project-state files, create comments, labels, issues, PRs, branches, commits, merges, workflow dispatches, deployments, model calls, or new OpenClaw tools.

### Phase 5D - Approval-gated Telegram project notes

- Add `/ppo note-add <project> <note...>` through the existing `ppo_local` direct-tool path.
- Add `/ppo note-confirm <request-id>` through the same `ppo_local` tool.
- Keep `/ppo note-add` as staging only: resolve the project through the existing six-project registry, reuse Phase 5C note validation and the 2000-character limit, reject chat input containing `PPO_NOTE_WRITE_CONFIRM`, perform zero note writes, show project/repo/note length without note text, persist the normalized intent locally, and return the confirmation command.
- Generate cryptographically random opaque one-time request ids and expire pending requests after 10 minutes.
- Store pending note requests under `${PPO_WRITE_DATA_DIR}/pending-project-notes` using private `0700` directories and `0600` files. Persist note text only temporarily for the pending request and delete consumed or expired content.
- Make `/ppo note-confirm` atomically claim and consume one unexpired request before invoking the Phase 5C writer with internal `add-note:<project>` confirmation. Unknown, expired, malformed, already-consumed, or replayed ids perform zero note writes.
- Preserve Phase 5C metadata-only note audit records and do not include Phase 5D request ids, note text, terminal confirmation values, tokens, or raw failures.
- Keep the existing `ppo_local` tool only, direct command dispatch only, and bare terminal `note-add` behavior unchanged. Bare terminal `note-confirm` remains unsupported.
- Do not call GitHub APIs, modify `projects/*.md` or project-state files, create comments, labels, issues, PRs, branches, commits, merges, workflow dispatches, deployments, model calls, or new OpenClaw tools.

### Phase 5E - Terminal-only controlled project-state promotion foundation

- Add terminal-only `node local-operator/ppo-command.mjs state-promote <project> <note-id> <field>`.
- Allow exactly `current-phase`, `last-known-status`, and `next-action` as project-state fields.
- Resolve the project only through the existing six-project registry and require the durable Phase 5C/5D note to belong to that project.
- Require the exact `PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>` confirmation before mutation.
- Refuse on `main`, refuse when the selected project-state file is dirty, and re-check the target hash immediately before replacement.
- Replace only the selected level-two Markdown section body and preserve all other bytes.
- Use same-directory temporary-file write, file fsync, atomic rename, and directory fsync for durable replacement.
- Record metadata-only attempted/succeeded/failed/refused audit entries with project, field, note id, timestamps, and before/after hashes; never record note text, confirmation values, tokens, or raw failures.
- Fail closed before mutation when the attempted audit cannot be established; report ambiguous outcomes when mutation may have occurred but durability or final success audit cannot be confirmed.
- Refuse duplicate promotion of the same project/note/field tuple and block automatic retry after a dangling attempted record.
- Keep Phase 5E terminal-only. `/ppo state-promote` remains unsupported and Telegram/OpenClaw project-state promotion is deferred to a separately reviewed later stage.
- Do not add GitHub API writes, model calls, deployment actions, or git add/commit/push/merge/checkout/reset/branch operations to the runtime path.

### Later Phase 5 work

Only after separate explicit approval:

- Add approval-gated Telegram/OpenClaw project-state promotion.
- Add richer note summarization/promotion only with separately reviewed deterministic or model boundaries.
- Never auto-merge or deploy as part of Phase 5 project-state mutation work.

Phase 5 write actions must be individually reviewed, permissioned, and auditable.

## Phase 6 - Autonomous Development Orchestration Foundations

### Phase 6A - Durable autonomous-development run-state foundation

- Add a local-only `local-operator/development-run-state.mjs` store for future PPO development runs.
- Resolve projects only through the existing six-project registry.
- Generate cryptographically random opaque run ids.
- Store one canonical run record under `${PPO_WRITE_DATA_DIR}/development-runs` with private `0700` directories and `0600` files.
- Include project metadata, bounded task text, lifecycle status, derived stage, immutable base SHA, optional branch/head SHA, per-stage attempt counters, timestamps, structured SHA-pinned planning/implementation/review/test/deploy/verification/rollback evidence metadata, and immutable transition history.
- Define explicit lifecycle statuses and allowed transitions for planning, implementation, testing, review, merge, deploy, verification, rollback, cancellation, and failure.
- Reject invalid, skipped, terminal, and backward transitions unless they are explicit retry transitions in the state graph.
- Require every transition to supply an expected version; stale or concurrent writers must be refused.
- Use durable version guards plus fsynced temp-file write, atomic rename, and directory fsync for canonical record replacement.
- Support restart recovery when a version guard committed but canonical refresh did not complete.
- Bound task, metadata, evidence, record, history, and attempt sizes.
- Reject secret-like evidence, raw errors, raw stdout/stderr, credentials, tokens, terminal confirmation values, and terminal control input.
- Keep Phase 6A as a library foundation only. Do not add planner logic, model calls, Codex execution, test execution, GitHub writes, branch/commit/merge operations, deployment/service control, rollback, `/ppo continue`, or Telegram/OpenClaw routes.

### Phase 6B - Deterministic autonomous next-stage planner foundation

- Add a local-only `local-operator/development-next-stage-planner.mjs` planner.
- Resolve projects only through the existing six-project registry.
- Read only the fixed project Markdown file for the selected project, `ROADMAP.md`, and existing Phase 2 GitHub read-only snapshot facts.
- Reject arbitrary repo names, arbitrary file paths, traversal, globs, model inputs, and unsupported source locations.
- Deterministically classify the exact project-state `## Next action` into one supported next stage only when source state is complete and unambiguous.
- Allow successful Phase 6B planner output only for `planning` and `implementation` next stages.
- Return a bounded structured result with project, current phase/status, exact source-backed task, next stage, base SHA, GitHub read-only facts, source evidence references, source hashes, planner outcome, and owner-action reason when blocked.
- Return `owner_action_required` for missing, malformed, contradictory, ambiguous, already-complete, product-choice-dependent, unsafe, unsupported, or missing-GitHub-fact state.
- Reuse the Phase 6A run-state store. Do not create a second run-state system.
- Support creating a new Phase 6A run and planning an existing `created` run only through `created -> planning_in_progress -> planned`.
- Require exact expected-version checks for existing-run planning and refuse stale versions.
- Attach metadata-only SHA-pinned `planning` evidence with plan/source hashes and bounded counts.
- Keep Phase 6B as a library foundation only. Do not add workspace creation, branch operations, Codex execution, automated tests, review/hardening automation, PR automation, merge, deployment, rollback, `/ppo continue`, or Telegram/OpenClaw routes.

### Phase 6C - Isolated workspace/worktree manager foundation

- Add a local-only `local-operator/development-workspace-manager.mjs` workspace manager.
- Resolve projects only through the existing six-project registry.
- Reuse the Phase 6A run-state store and accept only runs already in `planned` status.
- Require exact expected-version checks before transitioning run state.
- Read repository locations only from an explicit configured project workspace registry; reject paths from user/task text, planner output, project Markdown, and arbitrary filesystem traversal.
- Verify the configured source path is canonical, local, not a symlink, a Git repository root, clean, and identity-matched to the allowlisted project.
- Verify `run.baseSha` exists locally before any workspace mutation.
- Generate a deterministic bounded branch name from project, implementation stage, base SHA, and opaque run-id material; validate it through Git.
- Create the branch exactly at `run.baseSha` and create the worktree only under a PPO-managed workspace root.
- Protect against path traversal, symlink escapes, nested source/workspace roots, duplicate workspace ownership, and collisions.
- Use explicit argv Git execution with no shell interpolation and only the minimum read/preflight, branch/worktree create, verification, and definite cleanup command shapes.
- Re-check branch/worktree HEAD before transitioning `planned -> implementation_in_progress`.
- Attach metadata-only SHA-pinned `implementation` evidence with project, repo identity, base SHA, branch, workspace id/reference, and timestamps.
- Add read-only inspection helpers for restart recovery and recorded-workspace reconciliation.
- Fail closed on ambiguous branch/worktree creation outcomes; clean up only when the partial outcome is definite.
- Keep Phase 6C as a library foundation only. Do not add Codex execution, implementation-file edits, test execution, automated review/hardening, PR automation, GitHub writes, push, merge, deployment, rollback, `/ppo continue`, or Telegram/OpenClaw routes.

### Phase 6D - Bounded Codex execution adapter foundation

- Add a local-only `local-operator/development-codex-execution-adapter.mjs` Codex execution adapter.
- Reuse the Phase 6A run-state store and Phase 6C workspace manager; do not create a second orchestration store.
- Accept only runs already in `implementation_in_progress`.
- Require exact expected-version checks before transitioning run state.
- Reconcile the Phase 6C workspace before execution and refuse missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, or outside-managed-root workspaces.
- Require workspace HEAD to match the run head/base state before Codex starts.
- Read Codex executable path, explicit sandbox backend configuration, Git executable path, argv, timeout, and environment only from trusted local configuration.
- Require an active no-outbound-network sandbox for model-generated commands before spawning Codex; fail closed if it cannot be established or verified.
- Support explicit platform-capable sandbox backends: macOS `sandbox-exec` for local validation and Codex's native Linux command sandbox for the Ubuntu 24.04 VPS runtime.
- For the production Linux backend, run fixed non-interactive `codex exec` argv while generated commands use the fixed `:workspace` permission profile with network disabled.
- Verify before attempt reservation that sandboxed local Git works and that direct network, direct SSH transport, absolute Git with sanitized env, and ordinary `git push` cannot reach the host listener.
- Keep Git wrapper/env remote-write denial as defense in depth and let PPO create the local commit after successful sandboxed edits.
- Invoke fixed `codex exec` argv with `shell: false`, bounded timeout/output capture, and `cwd` set only to the verified isolated workspace while generated commands remain sandboxed.
- Generate a deterministic bounded prompt from the run task and planning evidence metadata, including explicit no-push, no-merge, no-deploy, no-credential-change, no-destructive-operation, and isolated-workspace boundaries.
- Durably record bounded implementation execution attempts in the Phase 6A run record using exact expected-version checks.
- Treat timeout, signal, killed/interrupted process, output overflow, or uncertain completion as ambiguous and require reconciliation before retry.
- Do not store prompt contents, raw Codex stdout/stderr, raw failures, credentials, tokens, confirmation values, arbitrary paths, or unbounded logs in run state.
- Verify Git state independently after a successful Codex exit: same managed worktree, same isolated branch, source/default worktree unchanged locally, full resulting SHA, descendant of run base SHA, clean worktree, and at least one local implementation commit.
- Transition only `implementation_in_progress -> implementation_ready` after verification and update `run.headSha` to the verified implementation SHA.
- Attach metadata-only SHA-pinned `implementation` evidence with adapter id, attempt number, branch, workspace id/reference, prompt hash, timestamps, and bounded outcome metadata.
- Add read-only reconciliation helpers for interrupted Codex execution.
- Keep Phase 6D as a library foundation only. Do not add automated test execution, independent review, hardening loops, PR automation, GitHub writes, push, merge, deployment, rollback, production verification, `/ppo continue`, or Telegram/OpenClaw routes.

### Phase 6E - Deterministic automated test runner foundation

- Add a local-only `local-operator/development-test-runner.mjs` automated test runner.
- Reuse the Phase 6A run-state store and Phase 6C workspace manager; do not create a second orchestration store.
- Accept the first test attempt only after Phase 6D has transitioned the run to `implementation_ready`.
- Require exact expected-version checks before any run-state transition.
- Reconcile the Phase 6C workspace before testing and refuse missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, outside-managed-root, dirty, or head-mismatched workspaces.
- Require workspace branch and HEAD to equal `run.headSha`.
- Require Phase 6D implementation evidence SHA to equal `run.headSha`.
- Read test commands only from a trusted local per-project test-policy registry; never from task text, model output, chat, project Markdown, repository scripts, package-manager scripts, or user-supplied shell.
- Require explicit executable path plus argv for every test step, invoke with `shell: false`, and set `cwd` only to the verified workspace.
- Enforce a fixed trusted executable allowlist, fixed bounded test-step count, bounded timeout, and bounded stdout/stderr capture per step.
- Sanitize the test environment and deny secret, auth, credential, confirmation, inherited Git, and prompt/askpass propagation.
- Preserve the Phase 6D no-outbound-network sandbox boundary for tests by default and fail closed if the sandbox cannot be verified active before execution.
- Transition `implementation_ready -> tests_in_progress` before executing tests and reserve bounded durable testing attempts.
- On full pass, re-check workspace HEAD and cleanliness immediately before transitioning `tests_in_progress -> tests_passed`.
- On definitive failure, remain in `tests_in_progress` with metadata-only failed test evidence.
- On timeout, signal, interruption, killed process, output overflow, or ambiguous outcome, leave an open attempt requiring reconciliation before retry.
- Store only metadata-only test results: test id, policy id/hash, implementation SHA, exit status class, duration, timestamps, attempt, and aggregate outcome.
- Do not store raw stdout/stderr, raw failures, secrets, credentials, environment dumps, arbitrary absolute paths, sandbox paths, or unbounded logs.
- Add read-only reconciliation helpers for interrupted testing and prior PASS evidence validity.
- Keep Phase 6E as a library foundation only. Do not add automated review, hardening loops, PR automation, GitHub writes, push, merge, deployment, rollback, production verification, `/ppo continue`, or Telegram/OpenClaw routes.

### Phase 6F - Independent Review + Bounded Hardening Pipeline

- Add a local-only `local-operator/development-review-agent.mjs` independent review agent.
- Add a local-only `local-operator/development-hardening-orchestrator.mjs` bounded hardening orchestrator.
- Reuse the Phase 6A run-state store and Phase 6C workspace manager; do not create a second orchestration store.
- Accept initial review only after Phase 6E has transitioned the run to `tests_passed`.
- Require exact expected-version checks before any run-state transition.
- Reconcile the Phase 6C workspace before review and refuse missing, mismatched, detached, wrong-branch, wrong-project, non-canonical, outside-managed-root, dirty, or head-mismatched workspaces.
- Require workspace branch and HEAD to equal `run.headSha` and require a clean tree before and after review.
- Require valid Phase 6D implementation evidence for exactly `run.headSha`.
- Require valid Phase 6E PASS evidence for exactly `run.headSha`; stale PASS evidence is not eligible.
- Preserve independent review separation: never reuse implementation completion, test pass status, Codex output, task text, chat, or repository-controlled commands as approval.
- Read reviewer execution policy only from trusted local configuration, with a trusted absolute executable, fixed explicit argv, `shell: false`, fixed `cwd` set to the verified workspace, bounded timeout, and bounded output.
- Preserve the Phase 6D no-outbound-network sandbox boundary by default, add reviewer read-only isolation for the verified workspace, Git state, and canonical source checkout, and fail closed if either boundary cannot be verified before execution.
- For macOS review, deny file writes under the verified workspace, workspace Git state, and source checkout with `sandbox-exec`; for Linux review, require a trusted read-only workspace/source mount/bind/mount-namespace wrapper or equivalent OS boundary.
- Build a deterministic bounded prompt from bounded task text, metadata-only implementation/test evidence, bounded local diff/file facts, and approved security/scope requirements.
- State the review decision contract in the prompt: `APPROVED` requires `mergeAllowed=true` and empty blockers/security findings/tests required; `CHANGES_REQUESTED` and `OWNER_ACTION_REQUIRED` require `mergeAllowed=false`.
- Exclude secrets, credentials, environment dumps, raw stdout/stderr, arbitrary logs, and arbitrary paths from prompts and evidence.
- Validate strict bounded structured reviewer output only: `APPROVED`, `CHANGES_REQUESTED`, or `OWNER_ACTION_REQUIRED` with exact `reviewedSha`, `mergeAllowed`, blockers, security findings, tests required, and summary.
- Require `APPROVED` decisions to have `mergeAllowed=true`, zero blockers, zero unresolved security findings, no additional required tests, and valid exact-SHA Phase 6E PASS evidence.
- Treat malformed, contradictory, oversized, uncertain, unparseable, or wrong-SHA reviewer output as fail-closed owner action.
- Transition `tests_passed -> review_in_progress` before review execution and reserve bounded durable review attempts.
- Transition `review_in_progress -> review_passed` only on valid exact-SHA approval.
- Transition `review_in_progress -> review_changes_requested` on valid blockers or owner/product/security ambiguity.
- Leave timeout, signal, interruption, killed process, output overflow, or ambiguous outcome as an open attempt requiring read-only reconciliation before retry.
- Store metadata-only SHA-pinned review evidence; do not store reviewer raw output, raw failures, prompt contents, executable paths, argv, credentials, or unbounded logs.
- Permit automated hardening only from valid `review_changes_requested` evidence for exactly `run.headSha`, with `decision=CHANGES_REQUESTED`, `mergeAllowed=false`, and at least one validated bounded blocker or security finding.
- Build remediation context only from durable Phase 6F review evidence: original task, reviewed SHA, bounded blockers, bounded security findings, and bounded required tests.
- Reuse the Phase 6D Codex adapter, Phase 6E automated test runner, and Phase 6F reviewer; do not create parallel implementation, test, or review engines.
- Extend Phase 6D only enough to consume trusted durable Phase 6F remediation context; do not accept caller-supplied arbitrary remediation prompts.
- Ensure Phase 6D hardening prompt assembly never drops validated remediation findings or mandatory isolated-workspace, no-push, no-merge, no-deploy, no-credential, and no-destructive-operation boundaries; trim only lower-priority optional task/planning context or fail closed.
- Require every remediation to produce a new verified descendant implementation SHA and update `run.headSha`.
- Invalidate all prior test PASS and review approval/findings evidence after any implementation SHA change.
- Rerun Phase 6E for the new SHA, and rerun Phase 6F review only after exact-SHA tests pass for that new SHA.
- Keep implementer and reviewer independent: implementation cannot self-approve, and review cannot modify files.
- Cap automatic hardening at three durable rounds per development run; if the cap is exhausted, record metadata-only owner-action-required evidence and stop.
- Treat timeout, signal, interruption, killed process, output overflow, or uncertain Codex/test/review outcomes as ambiguous and stop until the appropriate read-only reconciliation path is used.
- Add read-only hardening reconciliation that reports current round, current SHA, latest review decision, remediation pending/in progress, test/review evidence validity, and non-convergence.
- Keep Phase 6F as a library foundation only. Do not add Phase 6G acceptance gates, PR automation, GitHub writes, push, merge, deployment, rollback, production verification, `/ppo continue`, or Telegram/OpenClaw routes.

### Phase 6G - Acceptance + GitHub Delivery + Exact-Head Remote Review + SHA-Pinned Auto-Merge

- Add deterministic local acceptance gates for a Phase 6A run that has reached `review_passed` through Phase 6F.
- Require exact expected-version checks and refuse any stale run-state mutation.
- Allow delivery only when Phase 6D implementation evidence, Phase 6E PASS evidence, Phase 6F APPROVED evidence, the Phase 6C workspace HEAD, and the reviewed/tested implementation SHA all equal `run.headSha`.
- Reconcile the canonical Phase 6C workspace before delivery and refuse missing, non-canonical, dirty, wrong-branch, wrong-repo, default-branch, detached, or moved-head state.
- Keep acceptance deterministic. No model call may grant acceptance, and any SHA change invalidates the gate.
- Add a trusted GitHub delivery agent that operates only on the fixed six-project registry, exact Phase 6C branch, fixed `origin`, and fixed `main` PR base.
- Push only `<approved implementation SHA>:refs/heads/<approved Phase 6C branch>` with trusted executable argv, `shell: false`, no force push, no arbitrary remotes/URLs, and no caller-supplied command strings.
- Before and after push, reconcile the remote branch read-only. If a push outcome is ambiguous, do not blindly retry: recover success only when the remote branch is already the expected SHA; allow a bounded safe retry only when the branch is absent; fail closed on unexpected remote SHA.
- Create or reuse exactly one PR from the approved Phase 6C branch to `main`. Re-query after ambiguous PR creation and recover only a unique exact matching PR; never create duplicates blindly.
- Require the remote PR repo, base, source branch, open/non-draft state, and head SHA to match the approved implementation SHA before CI or final review.
- Require the existing `PPO PR validation` workflow for exactly the remote PR head SHA, including successful Node syntax checks, shell syntax checks, full regression suite, and diff whitespace checks. Older-SHA CI, pending CI, missing CI, and failed CI must not merge.
- Add exact-head remote PR review that reuses Phase 6F reviewer sandbox primitives: read-only workspace/source/Git state, no outbound network, explicit argv, `shell: false`, sanitized env, bounded prompt/output, and strict structured output.
- Remote review approval must have `reviewedSha` equal to the current PR head SHA, `mergeAllowed=true`, empty blockers/security findings/tests required, exact-head CI PASS, and a still-valid original acceptance gate.
- Remote `CHANGES_REQUESTED` or `OWNER_ACTION_REQUIRED` must not merge. Technical changes may re-enter the existing Phase 6F hardening lifecycle through explicit `review_changes_requested` evidence; every resulting implementation SHA requires fresh Phase 6E tests, Phase 6F local review, remote branch update, exact-head CI, and remote PR review.
- Transition `review_passed -> merge_ready` only after acceptance PASS, exact SHA push, PR reconciliation, remote head exactness, exact-head CI PASS, remote review APPROVED, `mergeAllowed=true`, and no unresolved findings.
- From `merge_ready`, re-fetch PR state, head SHA, base, mergeability, exact-head CI, and remote approval evidence immediately before merging.
- Merge only with a fixed approved method and GitHub expected-head-SHA protection. Never merge by branch name alone, never merge "latest", and refuse head movement.
- On ambiguous merge, do not blindly merge again. Re-fetch PR, merged state, merge commit SHA, and `main`; recover only when GitHub proves the expected PR/exact head was merged.
- Preserve metadata-only `merge` evidence for policy id/hash, implementation SHA, pushed SHA, remote branch SHA, PR number, PR head SHA, CI identity/result, remote reviewed SHA/decision, merge method, merge commit SHA, timestamps, and bounded outcomes.
- Never persist tokens, authorization headers, credentials, SSH material, raw API bodies, raw CI logs, raw stdout/stderr, arbitrary executable paths, or unbounded errors.
- Phase 6G ends at `merged`. It must not deploy, restart services, roll back production, perform production verification, add `/ppo continue`, add Telegram/OpenClaw routes, alter credentials/authentication, or merge an unreviewed SHA.

### Phase 6H - Exact-SHA Deployment Agent Foundation

- Add a trusted local deployment agent for a Phase 6A run that has reached exactly `merged` through Phase 6G.
- Require an exact expected version before any state transition and reject stale writers.
- Add an explicit local-only Personal Project Operator self-development run-state capability fixed to `personal-project-operator` / `Linardi1328/personal-project-operator`, while ordinary development-run creation and the public project resolver continue to use only the existing six-project registry.
- Support only the reviewed `personal-project-operator` deployment profile; do not automatically generalize deployment to the six-project registry.
- Read the deployment target SHA only from durable Phase 6G `merged` evidence. The target must equal the Phase 6G merge commit SHA and must not come from caller input, task text, chat, environment variables, project Markdown, command-line text, repository-controlled configuration, or model output.
- Preserve the Phase 6G SHA chain: implementation SHA, tested SHA, local reviewed SHA, remote reviewed SHA, merged implementation SHA, and deployment target SHA must all point to the approved development result through durable evidence.
- Add a narrowly scoped exact-SHA deployment primitive for the PPO checkout. It verifies the fixed profile, fixed installation path, fixed repository identity, fixed origin, expected commit existence, expected commit reachability from approved `main`, previous installed revision when available, checkout HEAD after mutation, approved runtime preflight, and restart of only the fixed PPO service.
- Use trusted executable paths, explicit argv, `shell: false`, bounded timeout/output, and sanitized process environment from Node. Trusted shell scripts must use `set -Eeuo pipefail`, fixed command shapes, fixed paths, fixed repository identity, malformed-SHA rejection, no `eval`, no arbitrary remotes, no arbitrary services, and no caller-controlled shell command strings.
- Do not use `git pull` as final deployment selection. A fetch may refresh the fixed origin, but final checkout selection must be the exact approved SHA.
- Transition `merged -> deploy_in_progress` before deployment mutation and reserve durable metadata-only deployment attempt evidence.
- Transition `deploy_in_progress -> deployed` only after deterministic postconditions prove the approved deployment operation completed, the deployment repository identity is correct, deployed checkout HEAD equals the Phase 6G merge SHA, approved runtime preflight passed, and the fixed service restart command completed.
- On definitive deployment failure, transition `deploy_in_progress -> deploy_failed` with metadata-only failure classification. Do not automatically rollback.
- Treat timeout, signal, process interruption, killed process, output overflow, uncertain checkout completion, uncertain service restart completion, and uncertain filesystem durability as ambiguous. Preserve the open deployment attempt and require read-only reconciliation before retry.
- Add read-only deployment reconciliation that reports current run status, expected deployment SHA, recorded attempt, current checkout SHA, exact target installation state, evidence completeness, and owner-action requirement. Reconciliation must not mutate the repo, restart the service, retry deployment, or infer full success when service restart completion cannot be proven.
- Store only bounded metadata such as project, deployment agent id, policy id/hash, attempt, expected deployment SHA, previous installed SHA when available, checkout SHA, service identity, timestamps, result classes, and outcome.
- Never persist tokens, authorization headers, credentials, SSH material, environment dumps, raw stdout/stderr, raw process failures, arbitrary absolute paths, shell command strings, or unbounded errors.
- Phase 6H stops at `deployed`. It must not automatically rollback, perform production verification, run health validation, add `/ppo continue`, add Telegram/OpenClaw routes, alter credentials/authentication, or modify production except through the fixed exact-SHA deployment operation.

### Phase 6I - Read-Only Production Verification Agent Foundation

- Add a trusted local production verification agent for a Phase 6A PPO self-development run that has reached exactly `deployed` through Phase 6H.
- Require an exact expected version before any state transition and reject stale writers.
- Reuse the fixed Phase 6H PPO deployment profile. Do not accept caller-selected repositories, install paths, services, commands, executables, policies, refs, branches, or target SHAs.
- Read the verification target SHA only from durable valid Phase 6H `deployed` evidence. The target must equal the Phase 6G merge commit SHA and must not come from latest `main`, caller input, task text, chat, environment variables, project Markdown, repository-controlled configuration, or model output.
- Transition `deployed -> verification_in_progress` before executing verification and reserve durable metadata-only verification attempt evidence.
- Use a fixed read-only production verification primitive with explicit argv, `shell: false`, bounded timeout/output, sanitized environment, and strict bounded result schema validation.
- Verify at minimum fixed repository origin, exact detached checkout SHA, clean worktree, previous revision marker when recorded, runtime preflight, OpenClaw executable version, fixed systemd service enabled/active/running state and identity, reviewed unit match, permission contract, and read-only `ppo_local help` bridge execution.
- On complete deterministic success, re-read the run, require the same deployed SHA, and transition `verification_in_progress -> verified` with metadata-only evidence.
- On definitive verification failure, transition `verification_in_progress -> verification_failed` with only a bounded safe failure classification. Do not rollback, redeploy, or restart services.
- Treat timeout, signal, interruption, killed process, output overflow, uncertain child completion, or malformed verification output as ambiguous. Preserve the open verification attempt and require read-only reconciliation before another coordinated attempt.
- Add read-only verification reconciliation that reports current run status, expected deployed SHA, recorded attempt, current checkout SHA, fixed service state, evidence completeness, and owner-action requirement. Reconciliation must not mutate production or transition to `verified` merely because a subset of checks passes.
- Store only bounded metadata such as project, verification agent id, policy id/hash, attempt, deployment SHA, observed checkout SHA, service identity, service active/running booleans, result classes, timestamps, and aggregate outcome.
- Never persist tokens, authorization headers, credentials, SSH material, environment dumps, journal contents, OpenClaw output, raw stdout/stderr, raw process failures, arbitrary absolute paths, shell command strings, or unbounded errors.
- Phase 6I stops at `verified` or `verification_failed`. It must not automatically rollback, deploy, restart services, refresh Git refs, add `/ppo continue`, add Telegram/OpenClaw routes, alter credentials/authentication, or broaden GitHub write permissions.

### Phase 6J - Exact Previous-SHA Rollback Agent Foundation

- Add a local-only rollback agent for a Phase 6A PPO self-development run that reached `verification_failed` after a successful Phase 6H deployment and Phase 6I verification attempt.
- Require exact expected-version checks and a fixed explicit owner rollback confirmation before any run-state transition or production mutation.
- Start rollback only from `verification_failed`; do not rollback from `verified`, `deployed`, `deploy_failed`, ambiguous deployment states, or arbitrary lifecycle states.
- Reuse the fixed Phase 6H PPO production profile without changing the Phase 6H profile, policy id, or policy hash semantics.
- Derive the failed deployment SHA only from valid durable Phase 6H `deployed` evidence and the rollback target only from that same evidence's full-SHA `previousInstalledSha`.
- Require the trusted evidence chain: fixed PPO identity, valid Phase 6G merged evidence, valid Phase 6H deployed evidence and policy id/hash, distinct full previous SHA, and latest valid Phase 6I `verification_failed` evidence for the same deployment SHA and attempt.
- Add a separate `rollback-exact-sha.sh` primitive for the evidence-bound Phase 6J rollback. Stage a fixed, hash-verified read-only recovery artifact under `/var/lib/personal-project-operator/phase6j-control` before checkout mutation so post-crash reconciliation does not depend on the mutable production checkout. Keep `rollback-repo.sh` as the earlier manual Phase 4 recovery primitive based on `last-good-revision`.
- Perform zero network refresh. Do not fetch, pull, call GitHub, SSH elsewhere, invoke a model, or accept caller-selected repos, paths, services, commands, refs, branches, or SHAs.
- Before mutation, require fixed repository origin, current detached checkout exactly at the failed deployment SHA, clean worktree using the Phase 6I read-only Git cleanliness boundary, matching Phase 6H previous-revision marker, and local existence of the rollback commit.
- Switch only to the exact detached rollback SHA, restore the reviewed runtime checkout permission contract, run fixed OpenClaw runtime preflight as `ppo`, restart only `ppo-openclaw.service`, and prove final detached checkout plus active/running service with nonzero MainPID.
- Transition `verification_failed -> rollback_in_progress` before production mutation and reserve metadata-only rollback-started evidence. On deterministic success transition `rollback_in_progress -> rolled_back`; on definitive failure transition `rollback_in_progress -> rollback_failed`.
- Treat timeout, signal, interruption, killed process, output overflow, uncertain checkout/restart completion, malformed output, or similar uncertainty as ambiguous. Preserve the open rollback attempt, do not retry, do not restart again, and require read-only reconciliation.
- Add read-only rollback reconciliation through the staged host recovery artifact that reports run status, expected deployment and rollback SHAs, attempt, current checkout, detached/clean marker state, runtime class, fixed service state, evidence completeness, apparent application state, retry owner-action requirement, and completion proof. Treat `inspect-rollback-readonly.sh` as a manual diagnostic only, not the post-crash trust root.
- Store only bounded metadata-only rollback evidence: project, agent, policy id/hash, attempt, deployment SHA, rollback SHA, fixed service identity, bounded result classes/booleans, timestamps, and outcome. Never store owner confirmation, raw stdout/stderr, stack traces, command strings, arbitrary paths, environment dumps, journal/OpenClaw output, credentials, tokens, or secrets.
- Phase 6J must not add automatic rollback after verification failure, rollback from `verified`, rollback from `deploy_failed`, arbitrary historical-SHA rollback, latest-main rollback, branch rollback, GitHub writes, Codex/model calls, Telegram/OpenClaw routes, `/ppo continue`, credential/auth changes, or ordinary-project registry expansion.

### Phase 6K - Controlled `/ppo continue` Orchestrator

- Add `/ppo continue <run-id>` through the existing `ppo_local` direct-tool route and terminal wrapper.
- Accept exactly one caller-controlled value: the existing opaque 43-character Phase 6A development run id. Reject caller-supplied expected versions, project ids, statuses, actions, branches, SHAs, repositories, workspaces, commands, services, deployment targets, rollback targets, confirmations, and environment overrides.
- Scope the command to the existing ordinary six-project registry only. Refuse `personal-project-operator`; PPO deployment, verification, and rollback remain local-only.
- Reuse the existing Phase 6A run-state store and existing Phase 6B-6G public APIs. Do not add statuses, evidence kinds, attempt counters, a second store, or parallel planner/workspace/Codex/test/review/hardening/delivery logic.
- At invocation start, read the durable run, capture its version, classify the current status, then re-read immediately before invoking a mutating child phase and pass that current version internally as `expectedVersion`.
- Invoke at most one reviewed high-level boundary per call: `created` planning, `planned` workspace preparation, safe `implementation_in_progress` Codex execution, `implementation_ready` tests, safe `tests_in_progress` retry, `tests_passed` review, `review_changes_requested` bounded hardening, `review_passed` Phase 6G delivery, or `merge_ready` SHA-pinned merge.
- Fail closed on open or ambiguous durable attempts such as `execution_started`, `testing_started`, `review_started`, planning/review in-progress states, and unsupported recovery statuses. Do not infer success from workspace observations alone.
- Stop at `merged`. For `merged`, production statuses, rollback statuses, `verified`, `cancelled`, and `failed`, perform zero deployment, verification, rollback, service, or production mutation and return bounded status metadata.
- Keep routing deterministic: the bridge parses only `/ppo continue <run-id>` and invokes the fixed wrapper argv `["continue", "<run-id>"]` with `shell: false`, bounded output, and no model interpretation.
- Do not add background execution, polling, queues, recursive continue, new OpenClaw tools, GitHub delivery reimplementation, production routes, `/ppo start`, `/ppo develop`, run listing, run search, or broader recovery workflows.

### Phase 6L - Unified Read-Only Development Recovery

- Add a local-only `development-recovery-coordinator.mjs` for ambiguous or interrupted ordinary six-project Phase 6 development runs.
- Accept exactly one logical caller-controlled value: the existing opaque 43-character Phase 6A development run id. Reject caller-selected projects, statuses, actions, versions, SHAs, repositories, workspaces, commands, policies, services, deployment targets, rollback targets, confirmations, and environment overrides.
- Reuse the existing Phase 6A run-state store and existing reviewed read-only Phase 6C-6G recovery APIs: workspace inspection, Codex execution reconciliation, automated testing reconciliation, independent review reconciliation, and GitHub delivery reconciliation.
- Keep Phase 6G partial-delivery recovery inside the existing GitHub delivery reconciler, including bounded observations for delivery not started, branch, PR, exact-head CI, remote review, merge-ready, and remote-merged states.
- Dispatch strictly by durable run status and invoke at most one read-only reconciliation boundary per call. Do not build a loop, retry work, infer completion from observations, or mutate state.
- Keep recovery possible without the full Phase 6K mutation-runtime readiness gate. Reuse the fixed Phase 6K workspace and Phase 6E policy definitions through a recovery-only helper that does not run Codex/test/reviewer/sandbox readiness probes.
- Re-read the run after child reconciliation and fail closed if the durable run changed during observation.
- Return only bounded metadata for owner diagnosis. Do not expose raw child output, evidence objects, transition history, GitHub responses, prompts, logs, paths, credentials, tokens, or secrets.
- Do not add `/ppo recover`, `/ppo recovery`, `/ppo reconcile`, `/ppo resume`, `/ppo repair`, `/ppo retry`, a new OpenClaw tool, or automatic Phase 6K recovery calls in this phase.
- Do not execute Codex, tests, reviewers, pushes, PR writes, merges, deployments, production verification, rollback, service control, model calls, or production inspection.

### Phase 6M - Controlled /ppo recover Route

- Expose the reviewed Phase 6L coordinator through the existing `ppo_local` direct-tool route and terminal PPO wrapper as `/ppo recover <run-id>`.
- Accept exactly one caller-controlled value: the existing opaque 43-character Phase 6A development run id. Reject caller-selected expected versions, projects, statuses, actions, SHAs, branches, repositories, workspaces, PR numbers, commands, policies, deployment targets, rollback targets, confirmations, environment overrides, extra arguments, and control-character input.
- Keep Phase 6L semantics and policy hash inputs unchanged. Phase 6L remains the reviewed read-only recovery engine with `routeExposed: false`; Phase 6M is a separate route adapter that validates input, invokes Phase 6L once, and returns bounded formatted output.
- Keep the route diagnostic and read-only. Do not repair state, retry work, invoke `/ppo continue`, create or transition runs, record progress, execute Codex/tests/reviewers, push, create or modify PRs, submit reviews, merge, deploy, verify production, rollback, poll, or run background work.
- Keep production recovery out of scope. PPO self-development and production lifecycle statuses continue to return bounded out-of-scope results and do not expose Phase 6H deployment, Phase 6I production verification, or Phase 6J rollback reconciliation.
- Keep OpenClaw deterministic: do not add a new OpenClaw tool or model turn. The bridge maps only `/ppo recover <run-id>` to fixed wrapper argv `["recover", "<run-id>"]` with `shell: false` and bounded output.

### Phase 6N - Read-Only Development Run Catalog Foundation

- Add a local-only `development-run-catalog.mjs` for discovering and summarizing existing ordinary Phase 6 development runs.
- Scope the catalog to the existing ordinary six-project registry only. Do not expand the registry and do not expose PPO self-development runs through the ordinary catalog.
- Add a separate non-mutating run-state snapshot reader that reuses the Phase 6A validated record parser but does not call `ensureStore`, create directories, chmod paths, refresh canonical records, or invoke any run-state mutation API.
- Read only fixed `records/<run-id>.json` and `versions/<run-id>/<version>.json` locations under `${PPO_WRITE_DATA_DIR}/development-runs`. Require regular files, no symlinks, valid run-id filenames, valid version-marker filenames, bounded file sizes, and no scans outside the fixed store.
- Return explicit canonical-state classifications such as current, behind, missing, conflict, invalid, missing store, unavailable store, or stale observation. Never silently repair lagging canonical records or missing canonical records.
- Return only bounded metadata summaries: run id, ordinary project id, status, stage, version, safe SHA fields, timestamps, terminal flag, and canonical state. Do not expose task text, branch filesystem paths, evidence, transition history, prompts, review findings, test details, raw PR/GitHub state, production metadata, paths, stdout/stderr, raw errors, environment data, credentials, tokens, or secrets.
- Bound each catalog call to at most 100 inspected canonical run records and at most 20 summaries. Use a fixed active-first, updated-at-descending, run-id-ascending ordering with no caller-selected filters or sort expressions.
- Treat a missing development-run store as an empty catalog for listing and a bounded not-found result for exact inspection. Treat corrupt entries as invalid diagnostics without compromising valid entries.
- Do not add `/ppo runs`, `/ppo run`, `/ppo run-status`, `/ppo list-runs`, `/ppo cancel`, `/ppo retry`, `/ppo resume`, a new OpenClaw tool, or bridge exposure in this phase.
- Do not invoke recovery, continuation, cancellation, retry, repair, deployment, production verification, rollback, subprocesses, network tools, GitHub APIs, service control, or any production filesystem inspection.

### Phase 6O - Controlled Read-Only Development Run Catalog Routes

- Expose the reviewed Phase 6N catalog through the existing terminal PPO wrapper and existing `ppo_local` direct-tool route as `/ppo runs` and `/ppo run <run-id>`.
- Keep Phase 6N as the sole catalog engine. Reuse its policy identity/hash, read-only snapshot reader, self-development exclusion, canonical-state reconciliation, sorting, fixed bounds, summary schema, and formatters without duplicating catalog traversal or record validation logic.
- `/ppo runs` accepts no caller-controlled values: no project, status, stage, limit, offset, filter, search text, sort, terminal/active flag, expected version, SHA, branch, repository, path, action, confirmation, or extra token.
- `/ppo run <run-id>` accepts exactly one caller-controlled value: the existing opaque 43-character Phase 6A run id. Reject missing ids, extra arguments, control characters, leading/trailing run-id whitespace, malformed ids, option syntax, project/status/SHA/action/path inputs, and arbitrary values before catalog access.
- Keep output metadata-only and bounded by both Phase 6N formatters and a Phase 6O route ceiling. Do not expose task text, evidence, transition history, workspace paths, raw Git/GitHub state, test output, review findings, production metadata, stdout/stderr, raw errors, environment data, credentials, tokens, or secrets.
- Preserve Phase 6N behavior through the routes: ordinary six-project scope, at most 100 inspected records, at most 20 summaries, active-first ordering, corrupt-content isolation, unsafe-filesystem fail-closed behavior, stale-observation fail-closed behavior, zero canonical repair, and PPO self-development omission.
- Keep OpenClaw deterministic. Do not add a new OpenClaw tool or model turn. The bridge maps only `/ppo runs` to `["runs"]` and `/ppo run <run-id>` to `["run", "<run-id>"]` with `shell: false`, bounded output, and strict malformed-input rejection before wrapper execution.
- Do not add cancellation, retry, repair, resume, run creation, arbitrary filters/search/sort, automatic recovery, automatic continue, deployment, production verification, rollback, subprocess/network/model calls, background work, or any run-state mutation.

### Phase 6P - Controlled Quiescent Development Run Cancellation

- Add a local cancellation engine with fixed identity `phase-6p-quiescent-development-run-cancellation` and a deterministic policy hash. The policy binds the ordinary six-project allowlist, exact eligible status allowlist, `canonical_current` requirement, expected-version requirement, target status `cancelled`, fixed actor `phase-6p-quiescent-cancellation`, fixed reason `owner_requested_quiescent_cancellation`, no evidence, no cleanup, no process interruption, no GitHub actions, and no production actions.
- Allow cancellation only from `created`, `planned`, `implementation_ready`, `tests_failed`, `tests_passed`, and `review_changes_requested`. Refuse `planning_in_progress`, `implementation_in_progress`, `tests_in_progress`, and `review_in_progress` as `state_not_quiescent`; refuse `review_passed`, `merge_ready`, and `merged` as delivery out of scope; refuse deployment, verification, and rollback states as production out of scope; refuse terminal states as terminal.
- Stage `/ppo cancel <run-id>` through a cancellation-specific approval store under `${PPO_WRITE_DATA_DIR}/pending-development-run-cancellations/{pending,claimed}`. Store only request id, timestamps, policy id/hash, run id, expected version, project id, and before status. Use 43-character random request ids, 10-minute TTL, private modes, regular files only, no symlink following, exclusive creation, and atomic pending-to-claimed consumption.
- Confirm `/ppo cancel-confirm <request-id>` by claiming the request before mutation, reinspecting the run once through the reviewed Phase 6N exact read-only path, requiring the same project, status, version, and `canonical_current`, then performing exactly one `transitionDevelopmentRun` to `cancelled` with the fixed actor and reason.
- Do not accept caller-controlled project, status, version, SHA, branch, path, evidence, actor, reason, target status, action, cleanup option, service, production profile, command, executable, or confirmation value.
- Do not interrupt Codex/tests/review, remove worktrees, delete local or remote branches, close PRs, revert merges, reset repositories, delete run records or history, remove version markers, invoke recovery, invoke continue, retry, repair, deploy, verify production, roll back production, add a new OpenClaw tool, or use model interpretation.

### Phase 7A - Controlled `/ppo start <project>` Route

- Expose the reviewed Phase 6B `createPlannedDevelopmentRun(projectId)` capability through the existing terminal wrapper and the existing `ppo_local` OpenClaw/Telegram path.
- Accept exactly one caller-controlled value: one project id from the existing six-project registry (`khlim-assist`, `ledgerpilot-ai`, `spy-market-agent`, `portfolio`, `rbl-content-engine`, or `khlim-digital-ecosystem`).
- Reject unknown projects, missing project, extra arguments, malformed whitespace/envelopes, control characters, paths, repo names, task text, SHAs, versions, branches, policies, runtime options, confirmations, and actions before planning.
- Add a separate Phase 7A route/policy id and deterministic policy hash covering caller input, fixed project scope, Phase 6B reuse, no caller-option forwarding, strict planned-result validation, zero production actions, zero model routing, and zero automatic continuation.
- Reuse the existing Phase 6B planner, Phase 6A run-state store, and Phase 2 GitHub read-only behavior. Do not create another planner, run-state store, GitHub client, source reader, or planning engine.
- On a valid planned Phase 6B result, create exactly one run through `createPlannedDevelopmentRun` and return bounded output with project, run id, status, next stage, base SHA, and `/ppo continue <run-id>` as the next command.
- If Phase 6B returns `owner_action_required`, create no run and return only bounded safe planner outcome/reason information.
- Fail closed on malformed planned Phase 6B results unless requested project, plan project, and run project match; run status is exactly `planned`; the run id is valid; the next stage is exactly `planning` or `implementation`; plan/run base SHA match; and run head SHA matches the base SHA.
- Keep OpenClaw deterministic. Do not add a new OpenClaw tool or model turn. The bridge maps only exact `/ppo start <project>` command shapes to `["start", "<project>"]` with `shell: false` and rejects malformed start envelopes without normalization.
- Do not automatically call `/ppo continue`, create a workspace, invoke Codex, run tests, run review/hardening, push, create a PR, merge, deploy, verify production, rollback, run background work, poll, or perform any production action.

### Stage 0 - Local PPO Self-Development Controller

- Add one terminal-only controller fixed to `personal-project-operator` / `Linardi1328/personal-project-operator` on the approved Customer Zero macOS host.
- Reuse the Phase 6B planner, Phase 6A run state, and Phase 6C–6G workspace, Codex, test, review, hardening, delivery, and merge engines. Do not create parallel lifecycle implementations.
- Separate internally approved self-development from the ordinary six-project public scope. Keep every existing `/ppo` and OpenClaw route unchanged and self-development-excluding.
- Advance at most one Phase 6B–6G boundary per `continue` invocation and stop at `merged`. Never route deployment, production verification, rollback, or service control.
- Add read-only status and recovery inspection that require current canonical state and disclose only bounded metadata.
- Add exact-version, exact-confirmation cancellation for the existing quiescent status set only. Do not interrupt processes, clean workspaces, delete branches, close PRs, or mutate production.
- Bind PPO self-development testing to the same five-gate runner used by GitHub PR validation: syntax, parallel regression, serial regression, repeated critical lifecycle, and integrated acceptance.
- Refuse Linux self-development, arbitrary repositories, caller-selected tasks, paths, SHAs, branches, runtimes, policies, providers, commands, executables, environments, and production targets.

### Phase 6Q - Full Phase 6 Integrated Acceptance and Closure Validation

- Add no new feature by default.
- Validate Phases 6A-6P together with complete automated regression, durable run-state behavior, planning, workspace creation, Codex execution, automated tests, independent review, bounded hardening, GitHub delivery, exact-SHA merge, deployment, production verification, rollback, `/ppo continue`, `/ppo recover`, `/ppo runs`, `/ppo run`, `/ppo cancel`, and `/ppo cancel-confirm`.
- Include disposable GitHub end-to-end coverage and production tests only after explicit owner approval.
- Produce a PASS/FAIL acceptance matrix and close Phase 6 only after the required acceptance tests pass.
- Do not deploy anything or execute production acceptance checks without separate explicit owner approval.

### Later Phase 6 work

Only after separate explicit approval:

- Add broader run-state mutation only after a separate explicit approval and review.
- Do not combine run discovery with retry, continue, recovery, cancellation, or repair mutation.
- Add broader `/ppo` recovery and run-management workflows only after separate review.
