# Example Telegram PPO Status

Telegram message:

```text
/ppo status
```

Expected OpenClaw local route:

```bash
node local-operator/ppo-command.mjs status
```

Expected reply:

```text
Project Status
Source: GitHub read-only

KHLIM Assist
- Repo: Linardi1328/khlim-assist
- Default: main
- Latest: 1dd9e08 Merge pull request #5
- Open PRs: none
- Open issues: none
- Updated: 2026-08-16T19:09:45Z

LedgerPilot AI
- Repo: Linardi1328/ledgerpilot-ai
- Default: main
- Latest: none returned
- Open PRs: 1
- Open issues: 1
- Updated: 2026-08-16T20:00:00Z

SPY Market Agent
- Repo: Linardi1328/spy-market-agent
- Default: main
- Latest: abcdef1 Refresh market notes
- Open PRs: 4
- Open issues: 4
- Updated: 2026-08-16T21:00:00Z

Portfolio Website
- Repo: Linardi1328/richie-linardi-portfolio-website
- Default: main
- Latest: aaabbbb Polish case study
- Open PRs: 5+
- Open issues: 5+
- Updated: 2026-08-16T22:00:00Z

RBL Content Engine
- Repo: Linardi1328/rbl-content-engine
- Default: main
- Latest: rbl1234 Update rbl-content-engine
- Open PRs: none
- Open issues: none
- Updated: 2026-08-16T23:00:00Z
```

Safety:

- GitHub read-only calls only.
- No Telegram API calls from repo code.
- No write actions.
