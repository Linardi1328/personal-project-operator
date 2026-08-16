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
/ppo codex-usage
/ppo menu
```

Outputs should be compact enough to read on a phone but complete enough to support a decision.

When routed through OpenClaw and Telegram, Personal Project Operator uses the custom `/ppo` namespace so it does not override OpenClaw built-in commands:

```text
/ppo status
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

For the manual OpenClaw owner test, load the local skill in place from [openclaw/skills/ppo](openclaw/skills/ppo) so its `{baseDir}` path resolves back to the existing wrapper. See [openclaw/skills/ppo/install-local.md](openclaw/skills/ppo/install-local.md).

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

Phase 0 was documentation only. Phase 1 adds a local-only simulator for `/status`, `/menu`, and `/help`. Phase 1.5 adds a local-only `/ppo` wrapper for OpenClaw Telegram routing preparation.

The project still does not implement:

- live GitHub API calls
- live OpenClaw bot actions
- Telegram API registration
- VPS deployment
- real Codex usage scraping
- customer messaging
- production deployment
- trading execution
- credential storage
- automatic OpenClaw config edits
