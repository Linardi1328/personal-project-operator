# Personal Project Operator

Personal Project Operator is a phone-controlled command center for managing personal software projects. It is designed to work with OpenClaw as the chat gateway, GitHub as the project source of truth, Codex as the coding implementation engine, and ChatGPT as the planning/review layer.

## What It Is

Personal Project Operator is the documentation foundation for an OpenClaw-powered project operator that can be controlled from a phone through Telegram or another chat platform.

The intended workflow is:

```text
Phone / Telegram / chat platform
        v
OpenClaw
        v
Personal Project Operator
        v
GitHub project state + project memory + Codex prompt templates
        v
Codex implementation workflow
```

## Why It Exists

The goal is to manage active personal software projects without needing to sit at a laptop for every planning, review, prioritization, and handoff step.

The operator should eventually help answer questions like:

- Which project needs attention first?
- What is the latest known state of a repo or PR?
- What should I ask Codex to implement next?
- Is this task too large for the current Codex usage state?
- What work is safe to trigger from a phone?

## Role Split

```text
ChatGPT = project architect, reviewer, Codex prompt planner
Codex = development implementation engine
GitHub = source of truth for repos, PRs, issues, commits
OpenClaw = always-on phone command center
VPS = keeps OpenClaw online 24/7
```

## Read-Only-First Safety Model

This project is read-only by default. In early phases, the operator should inspect, summarize, rank, and generate prompts. It must not mutate production systems or external services.

Blocked by default:

- GitHub merges
- code pushes
- branch deletion
- production deployment
- customer messaging
- credential changes
- trading execution
- paid API calls without explicit approval

Future write actions must be enabled one by one, documented clearly, and require explicit user approval.

## Phone-First Workflow

The OpenClaw/Telegram command interface is designed for short `/ppo` chat commands such as:

```text
/ppo status
/ppo next
/ppo repo khlim-assist
/ppo pr ledgerpilot-ai
/ppo codex spy-market-agent hardening
/ppo codex-budget ledgerpilot-ai add invoice import workflow
/ppo prompt-size Goal: build one focused feature
/ppo split-task add GitHub integration and Telegram routing
/ppo issue-create khlim-assist Document provider validation --body Add owner-visible context
/ppo issue-confirm <request-id>
/ppo note-add khlim-assist Record owner-visible project context
/ppo note-confirm <request-id>
/ppo codex-usage
/ppo menu
```

Outputs should be compact enough to read on a phone but complete enough to support a decision.

When routed through OpenClaw and Telegram, Personal Project Operator uses the custom `/ppo` namespace so it does not override OpenClaw built-in commands:

```text
/ppo status
/ppo repo <project>
/ppo pr <project>
/ppo issue-create <project> <title> [--body <body>]
/ppo issue-confirm <request-id>
/ppo note-add <project> <note...>
/ppo note-confirm <request-id>
/ppo menu
/ppo menu project
/ppo menu codex
/ppo menu system
/ppo help
```

## Phase 1 Local Simulator

Phase 1 adds a local-only command simulator for testing phone-style outputs before OpenClaw is connected.

Run from the repo root:

```bash
node local-operator/simulate-command.mjs /status
node local-operator/simulate-command.mjs /menu
node local-operator/simulate-command.mjs /menu project
node local-operator/simulate-command.mjs /menu codex
node local-operator/simulate-command.mjs /menu system
node local-operator/simulate-command.mjs /help
```

The simulator uses local fixture files only:

- [local-operator/project-state.json](local-operator/project-state.json)
- [local-operator/commands.json](local-operator/commands.json)

No npm install is required, and OpenClaw is not installed as a repo dependency. OpenClaw should be installed separately on the local MacBook when chat routing is tested.

## Phase 1.5 OpenClaw Telegram Routing Preparation

Phase 1.5 adds a safe wrapper for OpenClaw Telegram routing:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
```

The wrapper maps `/ppo ...` messages to local simulator output and rewrites command hints to the `/ppo` namespace.

OpenClaw owns `/status`, `/menu`, and `/help`. Personal Project Operator should not override them.

For the manual OpenClaw owner test, load the local skill from [openclaw/skills/ppo](openclaw/skills/ppo), link the local plugin from [openclaw/plugins/ppo-local](openclaw/plugins/ppo-local), and allow only `ppo_local` in the effective OpenClaw tool policy if the active profile excludes it. The skill uses direct tool dispatch to `ppo_local`, which invokes the existing wrapper without a model turn. See [openclaw/skills/ppo/install-local.md](openclaw/skills/ppo/install-local.md).

## Phase 2A GitHub Read-Only Local Foundation

Phase 2A adds a local GitHub read-only data layer under [local-operator](local-operator). It uses the locally installed GitHub CLI as the transport and executes `gh api` with `--method GET` only.

Phase 2A terminal validation:

```bash
node local-operator/github-readonly-cli.mjs repo khlim-assist
node local-operator/github-readonly-cli.mjs commits khlim-assist
node local-operator/github-readonly-cli.mjs prs khlim-assist
node local-operator/github-readonly-cli.mjs issues khlim-assist
node local-operator/github-readonly-cli.mjs snapshot khlim-assist
```

Local prerequisites:

```bash
gh --version
gh auth status
```

Authenticate with `gh auth login` outside the repository if needed. Do not paste GitHub tokens into this repository, Markdown, tests, fixtures, logs, or chat.

Allowed Phase 2A projects are fixed in the local read-only registry:

- `khlim-assist` -> `Linardi1328/khlim-assist`
- `ledgerpilot-ai` -> `Linardi1328/ledgerpilot-ai`
- `spy-market-agent` -> `Linardi1328/spy-market-agent`
- `portfolio` -> `Linardi1328/richie-linardi-portfolio-website`
- `rbl-content-engine` -> `Linardi1328/rbl-content-engine`

Allowed GitHub endpoint families:

- `GET /repos/{owner}/{repo}`
- `GET /repos/{owner}/{repo}/commits`
- `GET /repos/{owner}/{repo}/pulls`
- `GET /repos/{owner}/{repo}/issues`

The CLI returns normalized, compact terminal output only. Phase 2A does not add `/ppo repo`, `/ppo pr`, or any other GitHub command to Telegram/OpenClaw routing. GitHub write actions remain disabled.

## Phase 2B Telegram GitHub Read-Only Routing

Phase 2B exposes exactly two GitHub read-only commands through the existing deterministic `/ppo` path:

```text
/ppo repo <project>
/ppo pr <project>
```

The route remains direct tool dispatch:

```text
/ppo ... -> ppo_local -> local-operator/ppo-command.mjs -> GitHub read-only formatter -> Phase 2A client
```

Supported projects remain fixed:

- `khlim-assist`
- `ledgerpilot-ai`
- `spy-market-agent`
- `portfolio`
- `rbl-content-engine`

`/ppo repo <project>` returns repository metadata and a small bounded recent-commit list. `/ppo pr <project>` returns a bounded open-PR summary. Both use only the Phase 2A endpoint families already listed above.

Phase 2B does not add README, contents/tree, languages, workflow, branch, collaborator, release, changed-file, CI/check, review, comment, diff, recommendation, GraphQL, or write endpoints.

## Phase 2C Live GitHub Project Status

Phase 2C upgrades `/ppo status` to a live GitHub read-only summary through the same deterministic direct-tool route:

```text
/ppo status -> ppo_local -> local-operator/ppo-command.mjs -> GitHub status formatter -> Phase 2A client
```

The command covers exactly the five connected project ids in registry order and reports observable GitHub facts only:

- repository full name
- default branch
- latest returned commit
- bounded open PR count
- conservative bounded open issue count
- repository updated timestamp

`/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` are GitHub read-only in Phase 2C. `/ppo menu` and `/ppo help` remain fixture-backed wrapper output with Phase 2C wording adaptation.

Issue counts use `+` or `unknown (page limit hit)` when GitHub's bounded issues page is saturated after pull requests are filtered out, so `/ppo status` does not report a falsely exact issue total.

Phase 2C does not recommend priorities, infer urgency, decide whether Codex is required, generate prompts, or add stale-project detection. It does not add new GitHub endpoint families or GitHub writes.

## Phase 3A Local Codex Prompt Generator Foundation

Phase 3A adds a terminal-only Codex prompt generator:

```bash
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
```

The generator produces text only. It does not invoke Codex, ChatGPT, OpenAI APIs, another model, shell commands, deployment, GitHub writes, or target project repository changes.

Phase 3A prompt context is split into:

- curated project documentation from the fixed `projects/` mapping
- live GitHub read-only facts from the approved Phase 2A endpoint families

The command accepts exactly the five connected project ids, bounds task text to 1000 characters, includes a simple deterministic task-size estimate, and adds hardening emphasis for explicit hardening or error-boundary tasks.

Phase 3A originally kept Telegram/OpenClaw exposure deferred. Phase 3C now routes `/ppo codex ...` through `ppo_local` using direct tool dispatch.

## Phase 3B Local Codex Planning Tools

Phase 3B adds three terminal-only planning commands:

```bash
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build one focused feature"
node local-operator/ppo-command.mjs split-task "add GitHub integration and Telegram routing"
```

These commands produce deterministic text only. They do not invoke Codex, ChatGPT, OpenAI APIs, another model, generated plans, GitHub writes, deployment, or OpenClaw configuration changes.

`codex-budget` reuses the Phase 3A deterministic task-size estimator and does not inspect arbitrary repository files, Codex account usage, or exact token cost. `prompt-size` uses character, word, line, repetition, and breadth checks with safe mechanical compaction only. `split-task` uses fixed domain signals and keeps write-action work permission-gated.

Phase 3B originally kept Telegram/OpenClaw exposure deferred. Phase 3C now routes these text commands through `ppo_local`.

## Phase 3C OpenClaw Text Routing

Phase 3C enables deterministic direct-tool routing for:

```text
/ppo codex <project> <task>
/ppo codex-budget <project> <task>
/ppo prompt-size <draft>
/ppo split-task <task>
```

OpenClaw still dispatches `/ppo` directly to `ppo_local`; there is no model interpretation turn. The bridge parses only the command envelope and passes task or draft text as inert data. `prompt-size` preserves multiline drafts as one wrapper argv value.

These commands remain text-only. Phase 3C does not invoke Codex, ChatGPT, OpenAI APIs, another model, Telegram APIs, GitHub writes, deployment behavior, new GitHub endpoint families, or new OpenClaw tools or permissions.

## Supported Projects

Current connected candidates:

- KHLIM Assist: `Linardi1328/khlim-assist`
- LedgerPilot AI: `Linardi1328/ledgerpilot-ai`
- SPY Market Agent: `Linardi1328/spy-market-agent`
- Portfolio Website: `Linardi1328/richie-linardi-portfolio-website`
- RBL Content Engine: `Linardi1328/rbl-content-engine`

See [PROJECTS.md](PROJECTS.md) and the files in [projects/](projects/) for project-level state docs.

## Phase 4A VPS Deployment Foundation

Phase 4A adds deployment foundation files for a future Ubuntu 24.04 LTS VPS running OpenClaw continuously with the existing PPO local wrapper:

- target 2 vCPU / 4 GB RAM class VPS
- non-root `ppo` service user
- official OpenClaw `install-cli.sh` local-prefix runtime under `/home/ppo/.local/openclaw`, with bundled Node at `/home/ppo/.local/openclaw/tools/node/bin/node`
- `systemd` service template that supervises the foreground gateway with restart-on-failure behavior
- fail-closed OpenClaw runtime preflight before service start
- root-owned `/opt/personal-project-operator` checkout that is read-only to `ppo`
- guarded VPS-local bootstrap/update/service/firewall/rollback scripts
- safe environment-variable and secrets handling guidance
- read-only local health-check foundation

See [deployment/README.md](deployment/README.md) and [openclaw/vps-setup.md](openclaw/vps-setup.md).

Phase 4A does not perform live SSH, deploy to a VPS from tests, add Telegram API behavior, add GitHub writes, add model/Codex invocation, add new OpenClaw tools, or route `/ppo vps-health` yet.

## Phase 5A Controlled Issue Creation

Phase 5A adds one terminal-only GitHub write path:

```bash
node local-operator/ppo-command.mjs issue-create khlim-assist "issue title" "optional body"
```

Without exact confirmation, the command prints a deterministic preview and refuses the write. A confirmed write requires:

```bash
PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist
```

The only permitted network write is `POST /repos/<approved repo>/issues` for the existing five-project registry, with `title` and `body` fields only. The Phase 5A terminal command is not a `/ppo` command.

Phase 5A keeps PR writes, comments, labels, branch creation, commits, merges, workflow dispatches, project-state file updates, VPS deployment, and other GitHub writes disabled. Local audit records are stored under `local-operator/audit/` as credential-free JSONL and are ignored by git.

## Phase 5B Approval-Gated Telegram Issue Creation

Phase 5B adds two `/ppo` commands through the existing `ppo_local` direct-tool path:

```text
/ppo issue-create <project> <title> [--body <body>]
/ppo issue-confirm <request-id>
```

`/ppo issue-create` never calls GitHub. It validates against the existing five-project registry and Phase 5A title/body limits, shows the deterministic preview, writes the normalized intent into a private local pending store, and returns `/ppo issue-confirm <request-id>`.

`/ppo issue-confirm` atomically claims one matching unexpired request before any network write, deletes the pending content, and then invokes the Phase 5A issue writer with internal confirmation. Request ids are cryptographically random, opaque, single-use, and expire after 10 minutes. Unknown, expired, malformed, already-consumed, or replayed ids perform zero GitHub writes.

The chat path must not accept or expose terminal write confirmation environment values. Pending write data defaults to `local-operator/write-data/` locally and is configured to `/var/lib/personal-project-operator/write-data` in systemd. VPS audit records are configured at `/var/lib/personal-project-operator/audit/github-write-audit.ndjson`.

## Phase 5C Controlled Project Notes Foundation

Phase 5C adds one terminal-only local write path:

```bash
node local-operator/ppo-command.mjs note-add khlim-assist "project note text"
```

Without exact confirmation, the command prints a deterministic preview and refuses the note append. A confirmed append requires:

```bash
PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist
```

The command resolves projects only through the existing five-project registry, validates note text as inert terminal data, rejects empty, oversized, or terminal-control input, and stores append-only note records under `${PPO_WRITE_DATA_DIR}/project-notes`. Local write data defaults to `local-operator/write-data/`; systemd sets `PPO_WRITE_DATA_DIR=/var/lib/personal-project-operator/write-data` for the VPS.

Each stored note has a random opaque note id, timestamp, project metadata, and the exact note text. Audit records are metadata-only and must not include note text, confirmation values, tokens, raw failures, or request ids. If the attempted audit record cannot be established, no note is appended. If the append succeeds but success audit fails, the command returns an explicit "note may have been written" result so the store can be inspected before retrying.

Phase 5C is not a `/ppo`, Telegram, OpenClaw, or GitHub API workflow. It does not modify `projects/*.md`, project-state fixtures, issues, comments, labels, PRs, branches, commits, workflow dispatches, deployments, or model calls.

## Phase 5D Approval-Gated Telegram Project Notes

Phase 5D adds two `/ppo` commands through the existing `ppo_local` direct-tool path:

```text
/ppo note-add <project> <note...>
/ppo note-confirm <request-id>
```

`/ppo note-add` never appends a note. It resolves the project through the existing five-project registry, reuses the Phase 5C note validation and 2000-character limit, rejects chat input containing `PPO_NOTE_WRITE_CONFIRM`, shows project/repo/note length without note text, writes the normalized intent into a private local pending store, and returns `/ppo note-confirm <request-id>`.

`/ppo note-confirm` atomically claims and consumes one unexpired request before invoking the Phase 5C writer with internal `add-note:<project>` confirmation. Request ids are cryptographically random, opaque, single-use, and expire after 10 minutes. Unknown, expired, malformed, already-consumed, or replayed ids perform zero note writes.

Pending note requests live under `${PPO_WRITE_DATA_DIR}/pending-project-notes`; confirmed notes remain append-only under `${PPO_WRITE_DATA_DIR}/project-notes`. Phase 5D preserves the Phase 5C metadata-only note audit and does not include note text, request ids, terminal confirmation values, tokens, or raw failures. It does not call GitHub or mutate `projects/*.md` or project-state files.

## Phase 5E Controlled Project-State Promotion Foundation

Phase 5E adds one terminal-only project-state mutation path:

```bash
node local-operator/ppo-command.mjs state-promote <project> <note-id> <current-phase|last-known-status|next-action>
```

A confirmed promotion requires the exact tuple-specific environment value:

```bash
PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>
```

The command promotes one durable Phase 5C/5D note verbatim into exactly one approved section of `projects/<project>.md`. It only allows `## Current phase`, `## Last known status`, or `## Next action`; all other project-state sections are protected. It refuses on `main`, refuses a dirty target file, rechecks the target hash immediately before mutation, uses atomic same-directory replacement with fsync, and writes metadata-only promotion audit records with before/after hashes.

`/ppo state-promote` is intentionally unsupported in Phase 5E. Telegram/OpenClaw project-state promotion remains deferred to a separately reviewed later stage. See [commands/state-promote.md](commands/state-promote.md), [security/phase-5e-project-state-promotion.md](security/phase-5e-project-state-promotion.md), and [local-operator/phase-5e-project-state-promotion.md](local-operator/phase-5e-project-state-promotion.md).

## Phase 6A Durable Development Run-State Foundation

Phase 6A adds a local-only state-machine/store for future PPO autonomous-development runs:

```text
local-operator/development-run-state.mjs
```

The store resolves projects only through the existing five-project registry, creates cryptographically random opaque run ids, and writes private durable records under `${PPO_WRITE_DATA_DIR}/development-runs`. Directories are `0700`; files are `0600`.

Each run has one canonical JSON record containing project metadata, bounded task text, lifecycle status, derived stage, immutable base SHA, optional branch/head SHA, per-stage attempt counters, timestamps, structured SHA-pinned planning/implementation/review/test/deploy/verification evidence metadata, and immutable hash-chained transition history. Writes use fsynced temp files, atomic replacement, directory fsync, and durable version guards so stale agents cannot overwrite newer state.

Phase 6A is a foundation only. It adds no command route, no `/ppo continue`, no planner logic, no Codex execution, no model calls, no test execution, no GitHub writes, no branch/commit/merge operations, no deployment/service control, and no Telegram/OpenClaw autonomous-development route. See [local-operator/phase-6a-development-run-state.md](local-operator/phase-6a-development-run-state.md) and [security/phase-6a-development-run-state.md](security/phase-6a-development-run-state.md).

## Phase 6B Deterministic Next-Stage Planner Foundation

Phase 6B adds a local-only deterministic planner library:

```text
local-operator/development-next-stage-planner.mjs
```

Given one allowlisted project, the planner reads only that fixed `projects/<project>.md` file, `ROADMAP.md`, and existing Phase 2 GitHub read-only snapshot facts. It returns a bounded structured plan with current phase/status, exact source-backed next task, supported next stage, base SHA, source evidence references, and planner outcome.

The only successful Phase 6B next stages are `planning` and `implementation`. Missing, contradictory, ambiguous, already-complete, product-choice-dependent, unsupported, unsafe, or malformed state returns `owner_action_required`.

Phase 6B reuses the Phase 6A run-state store. It can create a new run or plan an existing `created` run only through `created -> planning_in_progress -> planned` with exact expected-version checks and metadata-only SHA-pinned planning evidence. It adds no command route, no `/ppo continue`, no workspace or branch creation, no Codex/model call, no test/review automation, no GitHub writes, no PR automation, no merge, no deployment/service control, and no Telegram/OpenClaw route. See [local-operator/phase-6b-next-stage-planner.md](local-operator/phase-6b-next-stage-planner.md) and [security/phase-6b-next-stage-planner.md](security/phase-6b-next-stage-planner.md).

## Phase 6C Isolated Workspace Manager Foundation

Phase 6C adds a local-only workspace manager foundation:

```text
local-operator/development-workspace-manager.mjs
```

It accepts only a Phase 6A run in `planned` status, verifies the allowlisted project/repo identity and exact base SHA from a configured project workspace registry, creates one deterministic branch/worktree under a PPO-managed workspace root, and then transitions the run to `implementation_in_progress` with metadata-only implementation evidence.

Phase 6C adds no terminal command, `/ppo` route, Codex/model execution, implementation-file edit, automated tests, review automation, PR automation, GitHub write, push, merge, deployment, rollback, or `/ppo continue`. See [local-operator/phase-6c-isolated-workspace-manager.md](local-operator/phase-6c-isolated-workspace-manager.md) and [security/phase-6c-isolated-workspace-manager.md](security/phase-6c-isolated-workspace-manager.md).

## Phase 6D Bounded Codex Execution Adapter Foundation

Phase 6D adds a local-only Codex execution adapter foundation:

```text
local-operator/development-codex-execution-adapter.mjs
```

It accepts only a Phase 6A run in `implementation_in_progress` with a verified Phase 6C workspace. It invokes Codex from trusted local configuration only, sets `cwd` to the verified isolated workspace, uses a deterministic bounded prompt, independently verifies a new local descendant commit, and then transitions the run to `implementation_ready` with metadata-only SHA-pinned implementation evidence.

Phase 6D adds no terminal command, `/ppo` route, automated test execution, review automation, hardening loop, PR automation, GitHub write, push, merge, deployment, rollback, production verification, service control, or `/ppo continue`. See [local-operator/phase-6d-codex-execution-adapter.md](local-operator/phase-6d-codex-execution-adapter.md) and [security/phase-6d-codex-execution-adapter.md](security/phase-6d-codex-execution-adapter.md).

## Command Menu System

Commands are grouped into phone-friendly categories:

- Project Control
- Codex Workflow
- Usage & Limits
- System & Safety
- Expansion

The command registry in [openclaw/command-registry.md](openclaw/command-registry.md) is the single source of truth for command metadata.

## Codex Usage Tracking

Codex usage tracking is manual-first in Phase 0. The operator must not assume that remaining Codex tokens, credits, or limits can always be retrieved automatically.

The user can manually update status with examples like:

```text
/ppo update-usage codex available
/ppo update-usage codex near-limit
/ppo update-usage codex limit-reached
/ppo update-usage credits 12.50
```

The operator should use that status to recommend whether a task should be small, medium, delayed, or split.

## Current Implementation Boundary

Phase 0 was documentation only. Phase 1 adds a local-only simulator for `/status`, `/menu`, and `/help`. Phase 1.5 adds a local-only `/ppo` wrapper for OpenClaw Telegram routing preparation. Phase 2A adds terminal-only GitHub read-only retrieval and normalization. Phase 2B routes `/ppo repo <project>` and `/ppo pr <project>` to that read-only layer through `ppo_local`. Phase 2C routes `/ppo status` to a live GitHub read-only project status summary. Phase 3A adds terminal-only local Codex prompt generation. Phase 3B adds terminal-only local Codex planning tools. Phase 3C routes Codex prompt/planning text commands through `ppo_local`. Phase 4A adds VPS deployment foundation docs, templates, guarded scripts, and local health-check tests only. Phase 5A adds terminal-only controlled GitHub issue creation with exact confirmation and audit logging. Phase 5B adds `/ppo issue-create` staging and `/ppo issue-confirm` single-use confirmation through the existing `ppo_local` tool. Phase 5C adds terminal-only controlled local project note append under private write data. Phase 5D adds `/ppo note-add` staging and `/ppo note-confirm` single-use confirmation through the existing `ppo_local` tool. Phase 5E adds terminal-only controlled promotion of one durable note into one approved project-state section with exact confirmation, git safety preflights, atomic replacement, and metadata-only audit. Phase 6A adds a local-only durable development run-state store with explicit lifecycle transitions and optimistic concurrency. Phase 6B adds a deterministic local next-stage planner that can create or plan a Phase 6A run through the planning lifecycle only. Phase 6C adds a deterministic local workspace manager that can prepare one isolated branch/worktree for a planned run only. Phase 6D adds a bounded local Codex execution adapter that can advance a verified implementation workspace to `implementation_ready` only after independent Git verification; it adds no routing path.

The project still does not implement:

- GitHub `/ppo` commands beyond `/ppo status`, `/ppo repo <project>`, `/ppo pr <project>`, `/ppo issue-create`, and `/ppo issue-confirm`
- richer Telegram/OpenClaw arbitrary text workflows beyond the approved Phase 3C text commands, Phase 5B issue approval commands, and Phase 5D note approval commands
- `/ppo state-promote` or any Telegram/OpenClaw project-state mutation route
- `/ppo continue` or any autonomous-development route
- `/ppo next` or status-based recommendations
- Telegram API registration
- live VPS deployment from this repository
- `/ppo vps-health` routing
- GitHub writes beyond terminal-only `issue-create` or the Phase 5B `/ppo issue-create` plus `/ppo issue-confirm` approval path
- project note writes beyond terminal-only `note-add` or the Phase 5D `/ppo note-add` plus `/ppo note-confirm` approval path
- project-state mutations beyond terminal-only Phase 5E `state-promote` for the three approved fields
- planner behavior beyond deterministic Phase 6B next-stage planning
- workspace creation outside the Phase 6C isolated workspace manager
- Codex execution outside the Phase 6D bounded adapter
- test, review, merge, deployment, rollback, or verification agents coordinated through the Phase 6A run-state store
- issue comments, labels, PR writes, branch writes, commits, merges, or workflow dispatches
- real Codex usage scraping
- customer messaging
- production deployment
- trading execution
- credential storage
- automatic OpenClaw config edits
