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

Phase 3A adds terminal-only Codex prompt generation:

```bash
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
```

Do not route `/ppo codex` through OpenClaw/Telegram in Phase 3A. The bridge intentionally rejects `codex ...` input.

Phase 3B adds terminal-only Codex planning tools:

```bash
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
node local-operator/ppo-command.mjs prompt-size "Goal: build one focused feature"
node local-operator/ppo-command.mjs split-task "add GitHub integration and Telegram routing"
```

Do not route `/ppo codex-budget`, `/ppo prompt-size`, or `/ppo split-task` through OpenClaw/Telegram in Phase 3B. The bridge intentionally rejects these planning commands before wrapper execution.

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
- `codex-prompt-generator.mjs`: Phase 3A terminal-only local Codex prompt text generator.
- `codex-planning-tools.mjs`: Phase 3B terminal-only deterministic Codex planning helpers.
- `github-readonly.test.mjs`: fake-runner tests that do not require live GitHub network access.
- `github-ppo-commands.test.mjs`: fake-client tests for Phase 2B command formatting and safe errors.
- `github-ppo-status.test.mjs`: fake-client tests for Phase 2C status formatting, bounded reads, and partial failures.
- `codex-prompt-generator.test.mjs`: fake-doc and fake-client tests for deterministic prompt generation.
- `codex-planning-tools.test.mjs`: network-free tests for budget estimates, prompt-size review, task splitting, and terminal-only boundaries.

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

Phase 3A generates local prompt text only. It reads only fixed mapped project docs plus approved GitHub read-only context. It does not invoke Codex, call OpenAI APIs, create commits, open PRs, change target repos, or expose Telegram `/ppo codex` routing.

Phase 3B generates local planning text only. `codex-budget`, `prompt-size`, and `split-task` do not invoke Codex, call OpenAI APIs, call another model, execute plans, inspect Codex usage, add GitHub endpoints, mutate repositories, deploy services, or expose Telegram routing. Planning task and draft text is inert data; shell-looking punctuation and paths are not executed or interpreted.

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
```

The final command is expected to be rejected because Phase 3B planning commands are terminal-only.

Then through OpenClaw/Telegram after review:

```text
/ppo status
/ppo repo khlim-assist
/ppo repo rbl-content-engine
/ppo pr khlim-assist
/ppo pr rbl-content-engine
```

## OpenClaw handoff shape

Future OpenClaw routing can treat this simulator as the command behavior reference:

```text
incoming /ppo chat text -> OpenClaw route -> local operator wrapper -> phone-style response
```

Phase 1 proves the command output shape only. Live integrations belong to later phases.
