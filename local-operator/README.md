# Local Operator Simulator

This folder contains the Phase 1 local-only command simulator for Personal Project Operator.

It lets you test phone-style command outputs before OpenClaw routes real chat messages.

## What it supports

Phase 1 terminal simulator:

```bash
node local-operator/simulate-command.mjs /status
node local-operator/simulate-command.mjs /menu
node local-operator/simulate-command.mjs /menu project
node local-operator/simulate-command.mjs /menu codex
node local-operator/simulate-command.mjs /menu system
node local-operator/simulate-command.mjs /help
```

Phase 1.5 OpenClaw Telegram routing wrapper:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
```

OpenClaw/Telegram should use `/ppo status`, `/ppo menu`, `/ppo menu project`, `/ppo menu codex`, `/ppo menu system`, and `/ppo help` instead of overriding OpenClaw built-ins.

Phase 2A GitHub read-only terminal validation:

```bash
node local-operator/github-readonly-cli.mjs repo khlim-assist
node local-operator/github-readonly-cli.mjs commits khlim-assist
node local-operator/github-readonly-cli.mjs prs khlim-assist
node local-operator/github-readonly-cli.mjs issues khlim-assist
node local-operator/github-readonly-cli.mjs snapshot khlim-assist
```

Phase 2A is terminal-only.

Phase 2B OpenClaw Telegram routing adds:

```bash
node local-operator/ppo-command.mjs repo khlim-assist
node local-operator/ppo-command.mjs pr khlim-assist
```

OpenClaw/Telegram can route `/ppo repo <project>` and `/ppo pr <project>` through the existing `ppo_local` direct tool path.

Phase 2C upgrades `/ppo status` to GitHub read-only:

```bash
node local-operator/ppo-command.mjs status
```

`/ppo menu` and `/ppo help` remain fixture-backed wrapper output with Phase 2C wording adaptation.

Phase 3A adds terminal Codex prompt generation:

```bash
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
```

Phase 3C routes `/ppo codex <project> <task>` through OpenClaw/Telegram using the same deterministic text generator.

Phase 3B adds terminal Codex planning tools:

```bash
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build one focused feature"
node local-operator/ppo-command.mjs split-task "add GitHub integration and Telegram routing"
```

Phase 3C routes `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` through OpenClaw/Telegram. The bridge parses only the command envelope and treats task/draft text as inert data.

Phase 5A adds terminal-only controlled GitHub issue creation:

```bash
node local-operator/ppo-command.mjs issue-create khlim-assist "issue title" "optional body"
```

This Phase 5A terminal command is not the `/ppo` chat command. It refuses to write unless `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>` exactly matches the target project.

Phase 5B adds approval-gated issue creation through the existing `/ppo` -> `ppo_local` direct-tool path:

```bash
node local-operator/ppo-command.mjs "/ppo issue-create khlim-assist issue title --body optional body"
node local-operator/ppo-command.mjs "/ppo issue-confirm <request-id>"
```

`/ppo issue-create` never calls GitHub. It validates the project, title, and body, writes one private pending request, and returns the confirmation command. `/ppo issue-confirm` atomically claims and consumes one unexpired request before invoking the Phase 5A writer with internal confirmation.

Phase 5C adds terminal-only controlled project note creation:

```bash
node local-operator/ppo-command.mjs note-add khlim-assist "project note text"
```

This command is not routed through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It refuses to append unless `PPO_NOTE_WRITE_CONFIRM=add-note:<project>` exactly matches the target project. Notes are stored under `${PPO_WRITE_DATA_DIR}/project-notes`, with local default `local-operator/write-data/` and VPS default configured by systemd at `/var/lib/personal-project-operator/write-data`.

Phase 5D adds approval-gated note creation through the existing `/ppo` -> `ppo_local` direct-tool path:

```bash
node local-operator/ppo-command.mjs "/ppo note-add khlim-assist project note text"
node local-operator/ppo-command.mjs "/ppo note-confirm <request-id>"
```

`/ppo note-add` stages only and performs zero note writes. It rejects chat input containing `PPO_NOTE_WRITE_CONFIRM`, stores one private pending request under `${PPO_WRITE_DATA_DIR}/pending-project-notes`, and returns `/ppo note-confirm <request-id>`. `/ppo note-confirm` atomically consumes one unexpired request before invoking the Phase 5C writer with internal confirmation.

Phase 5E adds terminal-only controlled project-state promotion:

```bash
node local-operator/ppo-command.mjs state-promote <project> <note-id> <current-phase|last-known-status|next-action>
```

It requires exact `PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>`, promotes one durable Phase 5C/5D note verbatim into exactly one approved project-state section, refuses `main` and dirty targets, rechecks the target hash before mutation, uses atomic durable replacement, and writes metadata-only promotion audit records. `/ppo state-promote` remains unsupported. See [phase-5e-project-state-promotion.md](phase-5e-project-state-promotion.md).

Phase 6A adds a local-only development run-state library:

```text
local-operator/development-run-state.mjs
```

It stores durable run records under `${PPO_WRITE_DATA_DIR}/development-runs` with explicit lifecycle transitions, optimistic expected-version checks, atomic canonical replacement, restart recovery from version guards, and bounded SHA-pinned evidence metadata. Phase 6A adds no terminal command, `/ppo` route, OpenClaw tool, Codex execution, GitHub write, git mutation, deployment action, or `/ppo continue`. See [phase-6a-development-run-state.md](phase-6a-development-run-state.md).

## Files

- `project-state.json`: local mock project state for current and placeholder projects.
- `commands.json`: local command catalog and menu grouping.
- `simulate-command.mjs`: dependency-free Node.js ESM simulator.
- `ppo-command.mjs`: dependency-free Node.js ESM wrapper for `/ppo` routing.
- `github-project-registry.mjs`: narrow Phase 2A GitHub repo allowlist.
- `github-readonly.mjs`: dependency-free GitHub read-only client using local `gh api --method GET`.
- `github-readonly-cli.mjs`: terminal-only Phase 2A validation CLI.
- `github-ppo-commands.mjs`: Phase 2B phone-friendly `/ppo repo` and `/ppo pr` formatter.
- `github-ppo-status.mjs`: Phase 2C live GitHub read-only `/ppo status` formatter.
- `github-issue-create.mjs`: Phase 5A terminal-only, confirmation-gated GitHub issue creation.
- `github-issue-approval.mjs`: Phase 5B local pending-request store and `/ppo issue-create`/`/ppo issue-confirm` handlers.
- `project-note-add.mjs`: Phase 5C terminal-only, confirmation-gated append-only project note storage.
- `project-note-approval.mjs`: Phase 5D local pending-request store and `/ppo note-add`/`/ppo note-confirm` handlers.
- `project-state-promote.mjs`: Phase 5E terminal-only, confirmation-gated controlled project-state promotion.
- `phase-5e-project-state-promotion.md`: Phase 5E local usage and safety boundary.
- `development-run-state.mjs`: Phase 6A local-only durable autonomous-development run-state store.
- `phase-6a-development-run-state.md`: Phase 6A local usage and safety boundary.
- `codex-prompt-generator.mjs`: Phase 3A local Codex prompt text generator, routed through `/ppo codex` in Phase 3C.
- `codex-planning-tools.mjs`: Phase 3B deterministic Codex planning helpers, routed through `/ppo` in Phase 3C.
- `audit/`: local credential-free GitHub write audit records; JSONL files are ignored by git.
- `write-data/`: local ignored Phase 5B/5D pending request stores and Phase 5C/5D project note store; runtime directories/files are private.
- `github-readonly.test.mjs`: fake-runner tests that do not require live GitHub network access.
- `github-issue-create.test.mjs`: fake-writer and fake-runner tests for Phase 5A write gating and audit behavior.
- `github-issue-approval.test.mjs`: fake-writer tests for Phase 5B staging, expiry, single-use confirmation, concurrency, and safe errors.
- `project-note-add.test.mjs`: local temp-store tests for Phase 5C allowlisting, confirmation, private modes, append-only notes, metadata audit, safe failure handling, and terminal behavior.
- `project-note-approval.test.mjs`: temp-store tests for Phase 5D staging, expiry, single-use confirmation, concurrency, metadata audit preservation, safe errors, `ppo_local` routing, and Phase 5C terminal regression.
- `project-state-promote.test.mjs`: Phase 5E tests for allowlisting, field restrictions, confirmation, git safety, byte preservation, atomic replacement, metadata audit, duplicate/ambiguous behavior, and Phase 5C/5D regressions.
- `development-run-state.test.mjs`: Phase 6A tests for project allowlisting, run ids, private permissions, lifecycle transitions, stale/concurrent writes, recovery, history integrity, bounded inputs, evidence metadata, safe errors, and Phase 5 regressions.
- `github-ppo-commands.test.mjs`: fake-client tests for Phase 2B command formatting and safe errors.
- `github-ppo-status.test.mjs`: fake-client tests for Phase 2C status formatting, bounded reads, and partial failures.
- `codex-prompt-generator.test.mjs`: fake-doc and fake-client tests for deterministic prompt generation.
- `codex-planning-tools.test.mjs`: network-free tests for budget estimates, prompt-size review, task splitting, and terminal/Phase 3C routing boundaries.

## Requirements

- Node.js installed locally.
- GitHub CLI installed locally for Phase 2A live terminal validation.
- No npm install required.
- No OpenClaw dependency is installed in this repo.

OpenClaw should be installed separately during local testing.

Check Phase 2A local GitHub prerequisites with:

```bash
gh --version
gh auth status
```

If authentication is missing, run `gh auth login` outside this repository and retry `gh auth status`. Do not paste tokens or credentials into this repository, tests, fixtures, Markdown, logs, or chat.

## Safety boundary

The simulator is local-only and read-only.

It does not:

- call GitHub APIs
- call Telegram APIs
- scrape Codex usage
- deploy to a VPS
- store secrets
- write to external systems
- modify OpenClaw local config

The Phase 2A GitHub read-only client is also read-only:

- it queries only the fixed allowlist of connected-candidate repos
- it rejects arbitrary owner/repo strings before any GitHub request
- its `gh` transport rejects endpoints outside Phase 2A repo metadata, commits, pulls, and issues before execution
- it invokes `gh` through Node `execFile` without a shell
- it sends only `gh api --method GET` requests
- it uses small bounded page sizes
- it normalizes responses into compact objects
- it sanitizes GitHub-sourced text before values can reach terminal output
- it filters pull requests out of the GitHub issues endpoint
- it does not store or log credentials
- it does not create branches, comments, labels, reviews, approvals, closes, merges, workflow dispatches, commits, or pushes

Phase 2A failure modes:

- `GITHUB_CLI_UNAVAILABLE`: `gh` is not installed or not on `PATH`; verify with `gh --version`.
- `GITHUB_CLI_UNAUTHENTICATED`: `gh` is installed but not authenticated; verify with `gh auth status`.
- `GITHUB_REPO_UNAVAILABLE`: the project is allowlisted, but the repo is unavailable or permission is denied.
- `GITHUB_API_FAILED`: the GitHub API call failed after the local `gh` and project checks passed.
- `MALFORMED_GITHUB_RESPONSE`: `gh` returned non-JSON or an unexpected response shape.

Phase 2B uses the same read-only client for `/ppo repo <project>` and `/ppo pr <project>`. It does not add README, contents/tree, language, workflow, branch, collaborator, release, changed-file, CI/check, review, comment, diff, recommendation, GraphQL, or write endpoints.

Phase 2C uses the same read-only client for `/ppo status`. Issue counts are conservative when the raw bounded issues page hits the page limit after pull requests are filtered out. It does not add recommendations, stale-project detection, `/ppo next`, Codex prompt generation, new endpoint families, GraphQL, or write actions.

Phase 3A generates local prompt text only. It reads only fixed mapped project docs plus approved GitHub read-only context. It does not invoke Codex, call OpenAI APIs, create commits, open PRs, or change target repos.

Phase 3B generates local planning text only. `codex-budget`, `prompt-size`, and `split-task` do not invoke Codex, call OpenAI APIs, call another model, execute plans, inspect Codex usage, add GitHub endpoints, mutate repositories, or deploy services. Planning task and draft text is inert data; shell-looking punctuation and paths are not executed or interpreted.

Phase 3C routes `/ppo codex`, `/ppo codex-budget`, `/ppo prompt-size`, and `/ppo split-task` through `ppo_local`. It preserves direct OpenClaw tool dispatch with no model turn, no new OpenClaw tools, no new permissions, no writes, and no new GitHub endpoints.

Phase 5A allows exactly one write action from the terminal wrapper: `issue-create <project> <title> [body...]`. The command:

- resolves projects through the existing five-project registry only
- permits only `POST /repos/<approved repo>/issues`
- sends only `title` and `body` fields
- invokes `gh` through `execFile` with `shell: false`, fixed argv shape, bounded timeout, and bounded output buffer
- rejects arbitrary repos, endpoints, methods, unsafe input, oversized input, comments, labels, branches, commits, PR writes, merges, workflow dispatches, project-state updates, and deployment behavior
- requires exact `PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>` before any network write
- records a credential-free local audit trail without title/body contents, tokens, or environment values
- fails closed before confirmed writes if auditing cannot be established

Phase 5B adds exactly one approval-gated chat write workflow through the existing `ppo_local` tool. `/ppo issue-create <project> <title> [--body <body>]` stages only and performs zero GitHub writes. `/ppo issue-confirm <request-id>` atomically claims one matching unexpired request, consumes the id and pending content before any network write, and then reuses the Phase 5A writer with internal confirmation. Unknown, expired, already-consumed, malformed, or replayed ids perform zero GitHub writes. The chat path must not accept or expose terminal write confirmation environment values.

Pending issue requests default to `local-operator/write-data/` for local use. Set `PPO_WRITE_DATA_DIR` to move the private pending store. Set `PPO_GITHUB_WRITE_AUDIT_PATH` to move the credential-free audit trail.

Phase 5C project notes use the same `PPO_WRITE_DATA_DIR` root and append note records under `${PPO_WRITE_DATA_DIR}/project-notes`. The command creates private `0700` directories and `0600` files, appends one fsynced durable record per confirmed action, and never edits, deletes, or replaces prior notes. Each record includes a random opaque note id, timestamp, project metadata, and the note text. The separate note audit trail is metadata-only and excludes note text, confirmation values, request ids, tokens, and raw failures. If attempted audit cannot be established, no note is appended; if append succeeds but success audit fails, the command warns that the note may have been written and should be inspected before retrying.

Phase 5C does not route `note-add` through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It does not call GitHub, create issues, comments, labels, branches, PRs, commits, merges, workflow dispatches, deployments, model calls, or mutate `projects/*.md` or project-state files.

Phase 5D adds exactly one approval-gated chat note workflow through the existing `ppo_local` tool. `/ppo note-add <project> <note...>` stages only and performs zero note writes. `/ppo note-confirm <request-id>` atomically claims one matching unexpired request, consumes the id and pending content before any note write, and then reuses the Phase 5C writer with internal confirmation. Unknown, expired, already-consumed, malformed, or replayed ids perform zero note writes. The chat path must not accept or expose terminal note confirmation environment values.

Pending note requests use `${PPO_WRITE_DATA_DIR}/pending-project-notes`. The store uses private `0700` directories and `0600` files, persists note text only temporarily for the pending request, and deletes consumed or expired content. The Phase 5C note audit remains metadata-only and does not include Phase 5D request ids.

Phase 5E allows exactly one terminal-only project-state mutation workflow. `state-promote <project> <note-id> <field>` accepts only `current-phase`, `last-known-status`, or `next-action`, requires the durable note to belong to the selected allowlisted project, and requires exact tuple-specific `PPO_PROJECT_STATE_CONFIRM` confirmation. It refuses `main` and dirty targets, rechecks target bytes before mutation, preserves all bytes outside the selected section, and performs atomic durable replacement with metadata-only audit. It adds no `/ppo state-promote`, GitHub API writes, model calls, deployments, or mutating git command path.

Phase 6A adds only local run-state storage for future autonomous-development coordination. It creates private records under `${PPO_WRITE_DATA_DIR}/development-runs`, rejects arbitrary run ids and non-allowlisted projects, bounds records/history/evidence, enforces explicit lifecycle transitions with expected-version optimistic concurrency, and stores only structured SHA-pinned metadata. It adds no command route, model call, Codex execution, test execution, GitHub write, git mutation, deployment/service control, rollback, Telegram/OpenClaw route, or `/ppo continue`.

Owner test plan after branch review:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs repo khlim-assist
node local-operator/ppo-command.mjs repo rbl-content-engine
node local-operator/ppo-command.mjs pr khlim-assist
node local-operator/ppo-command.mjs pr rbl-content-engine
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
node local-operator/ppo-command.mjs codex rbl-content-engine "organize source asset workflow"
node local-operator/ppo-command.mjs codex portfolio "harden contact form error handling"
node local-operator/ppo-command.mjs codex khlim-assist "add GitHub integration, Telegram routing, VPS deployment, and write actions"
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build the whole operator. Add GitHub integration. Add Telegram routing. Add VPS deployment. Add write actions. Repeat all background and future phases."
node local-operator/ppo-command.mjs split-task "add GitHub integration, Telegram bot, Codex prompt generator, VPS deployment, and write actions"
node local-operator/ppo-command.mjs "/ppo split-task add GitHub integration and Telegram routing"
node local-operator/ppo-command.mjs "/ppo prompt-size Goal: keep line structure
Requirements:
- preserve multiline input"
node local-operator/ppo-command.mjs issue-create khlim-assist "owner review test issue"
node local-operator/ppo-command.mjs note-add khlim-assist "owner review local note"
node local-operator/ppo-command.mjs "/ppo issue-create khlim-assist owner review test issue --body created only after confirmation"
node local-operator/ppo-command.mjs "/ppo note-add khlim-assist owner review staged note"
```

Then through OpenClaw/Telegram after review:

```text
/ppo status
/ppo repo khlim-assist
/ppo repo rbl-content-engine
/ppo pr khlim-assist
/ppo pr rbl-content-engine
/ppo codex rbl-content-engine organize source asset workflow
/ppo codex-budget ledgerpilot-ai add invoice import workflow
/ppo prompt-size Goal: keep line structure
Requirements:
- preserve multiline input
/ppo split-task add GitHub integration and Telegram routing
/ppo issue-create khlim-assist owner review test issue --body created only after confirmation
/ppo issue-confirm <request-id>
/ppo note-add khlim-assist owner review staged note
/ppo note-confirm <request-id>
```

Phase 5E remains terminal-only; do not add `/ppo state-promote` to the OpenClaw/Telegram owner test until a later separately reviewed phase.

## OpenClaw handoff shape

Future OpenClaw routing can treat this simulator as the command behavior reference:

```text
incoming /ppo chat text -> OpenClaw route -> local operator wrapper -> phone-style response
```

Phase 1 proves the command output shape only. Live integrations belong to later phases.
