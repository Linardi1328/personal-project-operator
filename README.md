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
/ppo codex spy-market-agent hardening (future Telegram routing)
/ppo codex-usage
/ppo menu
```

Outputs should be compact enough to read on a phone but complete enough to support a decision.

When routed through OpenClaw and Telegram, Personal Project Operator uses the custom `/ppo` namespace so it does not override OpenClaw built-in commands:

```text
/ppo status
/ppo repo <project>
/ppo pr <project>
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

`/ppo repo <project>` returns repository metadata and a small bounded recent-commit list. `/ppo pr <project>` returns a bounded open-PR summary. Both use only the Phase 2A endpoint families already listed above.

Phase 2B does not add README, contents/tree, languages, workflow, branch, collaborator, release, changed-file, CI/check, review, comment, diff, recommendation, GraphQL, or write endpoints.

## Phase 2C Live GitHub Project Status

Phase 2C upgrades `/ppo status` to a live GitHub read-only summary through the same deterministic direct-tool route:

```text
/ppo status -> ppo_local -> local-operator/ppo-command.mjs -> GitHub status formatter -> Phase 2A client
```

The command covers exactly the four connected project ids in registry order and reports observable GitHub facts only:

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

The command accepts exactly the four connected project ids, bounds task text to 1000 characters, includes a simple deterministic task-size estimate, and adds hardening emphasis for explicit hardening or error-boundary tasks.

Telegram/OpenClaw exposure is deferred. `/ppo codex ...` is not accepted by the `ppo_local` bridge in Phase 3A.

## Supported Projects

Current connected candidates:

- KHLIM Assist: `Linardi1328/khlim-assist`
- LedgerPilot AI: `Linardi1328/ledgerpilot-ai`
- SPY Market Agent: `Linardi1328/spy-market-agent`
- Portfolio Website: `Linardi1328/richie-linardi-portfolio-website`

Future placeholder projects:

- RBL Content Engine: not connected yet
- ProofLab: not connected yet
- Jom Jelajah: not connected yet

See [PROJECTS.md](PROJECTS.md) and the files in [projects/](projects/) for project-level state docs.

## Planned VPS Deployment

Phase 4 plans for an Ubuntu VPS running OpenClaw continuously with:

- SSH access
- firewall enabled
- environment variables for secrets
- process manager or restart strategy
- `/vps-health` checks

No deployment is implemented in Phase 0.

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

Phase 0 was documentation only. Phase 1 adds a local-only simulator for `/status`, `/menu`, and `/help`. Phase 1.5 adds a local-only `/ppo` wrapper for OpenClaw Telegram routing preparation. Phase 2A adds terminal-only GitHub read-only retrieval and normalization. Phase 2B routes `/ppo repo <project>` and `/ppo pr <project>` to that read-only layer through `ppo_local`. Phase 2C routes `/ppo status` to a live GitHub read-only project status summary. Phase 3A adds terminal-only local Codex prompt generation.

The project still does not implement:

- GitHub commands beyond `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>`
- Telegram/OpenClaw routing for `/ppo codex`
- `/ppo next` or status-based recommendations
- live OpenClaw bot actions
- Telegram API registration
- VPS deployment
- real Codex usage scraping
- customer messaging
- production deployment
- trading execution
- credential storage
- automatic OpenClaw config edits
