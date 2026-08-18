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
- Keep OpenClaw dispatch deterministic and tool-based, without a model turn.
- Do not add new GitHub endpoint families, GraphQL, or write actions.
- Do not add README/tree/CI/changed-file/review enrichment yet.

### Phase 2C - Live GitHub project status

- Route `/ppo status` through `ppo_local` to the Phase 2A read-only client.
- Summarize the four connected projects in registry order.
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
- Leave Phase 3C as the separate review point for arbitrary text routing.

### Later Phase 3 work

- Review arbitrary text routing for Telegram/OpenClaw separately in Phase 3C.
- Add richer budget, prompt compression, and splitting workflows only after separate approval.

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
