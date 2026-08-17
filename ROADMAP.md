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
- Allow only the four connected-candidate project ids.
- Fetch and normalize repo metadata, recent commits, open PRs, and open issues.
- Build compact project snapshots for terminal validation.
- Keep all GitHub requests explicit `GET`.
- Keep Phase 2A terminal-only; do not expose `/ppo repo` or `/ppo pr` through Telegram yet.
- Keep all GitHub write actions disabled.

### Phase 2B - Telegram GitHub read-only routing

- Route `/ppo repo <project>` through `ppo_local` to the Phase 2A read-only client.
- Route `/ppo pr <project>` through `ppo_local` to the Phase 2A read-only client.
- Keep `/ppo status` fixture-backed.
- Keep OpenClaw dispatch deterministic and tool-based, without a model turn.
- Do not add new GitHub endpoint families, GraphQL, or write actions.
- Do not add README/tree/CI/changed-file/review enrichment yet.

### Later Phase 2 work

- Fetch repo metadata.
- Fetch recent commits.
- Fetch open PRs.
- Fetch issues.
- Summarize project state.
- Add richer read-only repo/PR detail only after separate approval.
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
