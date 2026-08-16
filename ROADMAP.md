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

## Phase 2 - GitHub Read-Only Integration

- Fetch repo metadata.
- Fetch recent commits.
- Fetch open PRs.
- Fetch issues.
- Summarize project state.
- Keep all GitHub write actions disabled.

## Phase 3 - Codex Prompt Generator

- Generate compact Codex prompts.
- Estimate task size.
- Split large tasks.
- Prepare hardening prompts.
- Use project docs and read-only repo state as prompt context.

## Phase 4 - VPS Deployment

- Deploy OpenClaw to Ubuntu VPS.
- Add health checks.
- Add restart strategy.
- Add safe environment variable handling.
- Test `/vps-health`.

## Phase 5 - Controlled Write Actions

Only after explicit approval:

- Create GitHub issues.
- Create project notes.
- Update project state files.
- Never auto-merge or deploy.

Phase 5 write actions must be individually reviewed, permissioned, and auditable.
