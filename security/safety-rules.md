# Safety Rules

## Read-only first

The operator must inspect, summarize, plan, and generate prompts before it is allowed to mutate anything.

## Always blocked in Phase 0

- Merge PRs.
- Push code.
- Delete branches.
- Deploy production changes.
- Send customer messages.
- Expose secrets.
- Change credentials.
- Execute trades.
- Make paid API calls without explicit approval.
- Perform destructive file operations.
- Register live Telegram commands.
- Scrape Codex usage.

## Phase 1 local simulator boundary

Phase 1 may run the local Node.js simulator for `/status`, `/menu`, and `/help`.

Phase 1.5 may run the local `/ppo` wrapper for OpenClaw Telegram routing preparation.

The simulator and wrapper must use local fixture files only and must not:

- call GitHub APIs
- call Telegram APIs
- scrape Codex usage
- deploy to VPS
- store secrets
- write to external systems
- edit `~/.openclaw`
- override OpenClaw built-in commands

## Phase 2A GitHub read-only boundary

Phase 2A may run terminal-only GitHub read-only validation for the four connected-candidate repos.

The GitHub client must:

- resolve project ids through a fixed allowlist before any API call
- reject future, paused, unknown, arbitrary repo, or injection-style input before any API call
- use local `gh api --method GET` only
- use Node `execFile` without a shell
- normalize compact repo, commit, PR, issue, and snapshot objects
- keep `/ppo repo`, `/ppo pr`, and other GitHub Telegram commands disabled until Phase 2B approval

The GitHub client must not store or log credentials, create branches, create comments, change labels, review, approve, close, merge, dispatch workflows, commit code, or push code in target project repos.

## Approval rules for future phases

Future write actions require:

- explicit user approval
- clear command name
- clear target project
- clear intended change
- documented danger level
- audit trail

## Financial and trading boundary

SPY Market Agent may support research, summaries, simulation, and backtesting. It must not execute trades or connect to brokerage execution without a separate approved safety design.

## Customer communication boundary

The operator may draft messages in future phases. It must not send customer, staff, or public messages automatically in early phases.

## Paid API boundary

Any paid API call must require explicit approval unless a future budget and allowlist are documented.
