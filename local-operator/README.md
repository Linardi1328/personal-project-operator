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

Phase 2A is terminal-only. Do not add these commands to the OpenClaw/Telegram `/ppo` allowlist until Phase 2B is approved.

## Files

- `project-state.json`: local mock project state for current and placeholder projects.
- `commands.json`: local command catalog and menu grouping.
- `simulate-command.mjs`: dependency-free Node.js ESM simulator.
- `ppo-command.mjs`: dependency-free Node.js ESM wrapper for `/ppo` routing.
- `github-project-registry.mjs`: narrow Phase 2A GitHub repo allowlist.
- `github-readonly.mjs`: dependency-free GitHub read-only client using local `gh api --method GET`.
- `github-readonly-cli.mjs`: terminal-only Phase 2A validation CLI.
- `github-readonly.test.mjs`: fake-runner tests that do not require live GitHub network access.

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

## OpenClaw handoff shape

Future OpenClaw routing can treat this simulator as the command behavior reference:

```text
incoming /ppo chat text -> OpenClaw route -> local operator wrapper -> phone-style response
```

Phase 1 proves the command output shape only. Live integrations belong to later phases.
