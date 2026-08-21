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
- Resolve `<project>` only through the existing five-project GitHub registry.
- Permit only `POST /repos/<approved repo>/issues` with `title` and `body` fields.
- Require exact `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>` before any network write.
- Show a deterministic preview and refuse the write when confirmation is missing or mismatched.
- Write a credential-free audit trail for refused, attempted, succeeded, and failed write actions.
- Keep OpenClaw/Telegram unchanged; do not route `issue-create` through `ppo_local`.
- Do not add PR writes, comments, labels, branches, commits, merges, workflow dispatches, project-state mutations, or deployment behavior.

### Phase 5B - Approval-gated Telegram issue creation

- Add `/ppo issue-create <project> <title> [--body <body>]` through the existing `ppo_local` direct-tool path.
- Add `/ppo issue-confirm <request-id>` through the same `ppo_local` tool.
- Keep `issue-create` as staging only: validate through the existing five-project registry and Phase 5A title/body limits, show the deterministic preview, persist the normalized intent locally, and return the confirmation command.
- Generate cryptographically random opaque one-time request ids and expire pending requests after 10 minutes.
- Keep pending request storage private and configurable with `PPO_WRITE_DATA_DIR`, defaulting to `local-operator/write-data/` for local use and `/var/lib/personal-project-operator/write-data` in systemd.
- Make `issue-confirm` atomically claim one unexpired request before any network write, consume it before invoking the writer, and make replay, expired, malformed, unknown, or already-consumed ids perform zero GitHub writes.
- Reuse the Phase 5A issue writer with its internal exact confirmation value; do not accept or expose terminal write confirmation environment values through chat.
- Preserve the credential-free attempted/succeeded/failed audit trail, with `PPO_GITHUB_WRITE_AUDIT_PATH` configured to `/var/lib/personal-project-operator/audit/github-write-audit.ndjson` on the VPS.
- Do not add a model turn, new OpenClaw tools, provider access, arbitrary GitHub endpoints, comments, labels, assignees, milestones, PR/branch/commit/merge/workflow writes, project-state mutations, or deployments.

### Phase 5C - Terminal-only controlled project notes foundation

- Add terminal-only `node local-operator/ppo-command.mjs note-add <project> <note...>`.
- Resolve `<project>` only through the existing five-project registry.
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
- Keep `/ppo note-add` as staging only: resolve the project through the existing five-project registry, reuse Phase 5C note validation and the 2000-character limit, reject chat input containing `PPO_NOTE_WRITE_CONFIRM`, perform zero note writes, show project/repo/note length without note text, persist the normalized intent locally, and return the confirmation command.
- Generate cryptographically random opaque one-time request ids and expire pending requests after 10 minutes.
- Store pending note requests under `${PPO_WRITE_DATA_DIR}/pending-project-notes` using private `0700` directories and `0600` files. Persist note text only temporarily for the pending request and delete consumed or expired content.
- Make `/ppo note-confirm` atomically claim and consume one unexpired request before invoking the Phase 5C writer with internal `add-note:<project>` confirmation. Unknown, expired, malformed, already-consumed, or replayed ids perform zero note writes.
- Preserve Phase 5C metadata-only note audit records and do not include Phase 5D request ids, note text, terminal confirmation values, tokens, or raw failures.
- Keep the existing `ppo_local` tool only, direct command dispatch only, and bare terminal `note-add` behavior unchanged. Bare terminal `note-confirm` remains unsupported.
- Do not call GitHub APIs, modify `projects/*.md` or project-state files, create comments, labels, issues, PRs, branches, commits, merges, workflow dispatches, deployments, model calls, or new OpenClaw tools.

### Phase 5E - Terminal-only controlled project-state promotion foundation

- Add terminal-only `node local-operator/ppo-command.mjs state-promote <project> <note-id> <field>`.
- Allow exactly `current-phase`, `last-known-status`, and `next-action` as project-state fields.
- Resolve the project only through the existing five-project registry and require the durable Phase 5C/5D note to belong to that project.
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
- Resolve projects only through the existing five-project registry.
- Generate cryptographically random opaque run ids.
- Store one canonical run record under `${PPO_WRITE_DATA_DIR}/development-runs` with private `0700` directories and `0600` files.
- Include project metadata, bounded task text, lifecycle status, derived stage, immutable base SHA, optional branch/head SHA, per-stage attempt counters, timestamps, structured SHA-pinned planning/implementation/review/test/deploy/verification evidence metadata, and immutable transition history.
- Define explicit lifecycle statuses and allowed transitions for planning, implementation, testing, review, merge, deploy, verification, cancellation, and failure.
- Reject invalid, skipped, terminal, and backward transitions unless they are explicit retry transitions in the state graph.
- Require every transition to supply an expected version; stale or concurrent writers must be refused.
- Use durable version guards plus fsynced temp-file write, atomic rename, and directory fsync for canonical record replacement.
- Support restart recovery when a version guard committed but canonical refresh did not complete.
- Bound task, metadata, evidence, record, history, and attempt sizes.
- Reject secret-like evidence, raw errors, raw stdout/stderr, credentials, tokens, terminal confirmation values, and terminal control input.
- Keep Phase 6A as a library foundation only. Do not add planner logic, model calls, Codex execution, test execution, GitHub writes, branch/commit/merge operations, deployment/service control, rollback, `/ppo continue`, or Telegram/OpenClaw routes.

### Phase 6B - Deterministic autonomous next-stage planner foundation

- Add a local-only `local-operator/development-next-stage-planner.mjs` planner.
- Resolve projects only through the existing five-project registry.
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
- Resolve projects only through the existing five-project registry.
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
- Require an active no-outbound-network OS/process sandbox before spawning Codex; fail closed if it cannot be established or verified.
- Support explicit platform-capable sandbox backends: macOS `sandbox-exec` for local validation and Linux network namespace execution for the Ubuntu 24.04 VPS runtime.
- For the Linux backend, enter a root-provisioned/preconfigured no-network namespace, then drop to a configured non-root uid/gid with `no_new_privs` and no effective capabilities before launching Codex.
- Verify before attempt reservation that sandboxed local Git works and that direct network, direct SSH transport, absolute Git with sanitized env, and ordinary `git push` cannot reach the host listener.
- Keep Git wrapper/env remote-write denial only as defense in depth, not as the primary boundary.
- Invoke Codex through the sandbox with explicit argv, `shell: false`, bounded timeout/output capture, and `cwd` set only to the verified isolated workspace.
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
- Preserve the Phase 6D no-outbound-network sandbox boundary by default and fail closed if the review sandbox cannot be verified before execution.
- Build a deterministic bounded prompt from bounded task text, metadata-only implementation/test evidence, bounded local diff/file facts, and approved security/scope requirements.
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
- Require every remediation to produce a new verified descendant implementation SHA and update `run.headSha`.
- Invalidate all prior test PASS and review approval/findings evidence after any implementation SHA change.
- Rerun Phase 6E for the new SHA, and rerun Phase 6F review only after exact-SHA tests pass for that new SHA.
- Keep implementer and reviewer independent: implementation cannot self-approve, and review cannot modify files.
- Cap automatic hardening at three durable rounds per development run; if the cap is exhausted, record metadata-only owner-action-required evidence and stop.
- Treat timeout, signal, interruption, killed process, output overflow, or uncertain Codex/test/review outcomes as ambiguous and stop until the appropriate read-only reconciliation path is used.
- Add read-only hardening reconciliation that reports current round, current SHA, latest review decision, remediation pending/in progress, test/review evidence validity, and non-convergence.
- Keep Phase 6F as a library foundation only. Do not add Phase 6G acceptance gates, PR automation, GitHub writes, push, merge, deployment, rollback, production verification, `/ppo continue`, or Telegram/OpenClaw routes.

### Later Phase 6 work

Only after separate explicit approval:

- Add merge, deploy, rollback, and verification agents one boundary at a time.
- Add `/ppo continue` only after the run-state, approval, execution, and recovery boundaries have independent review.
