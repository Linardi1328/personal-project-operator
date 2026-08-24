# PPO OpenClaw Skill Scaffold

This directory documents the OpenClaw routing scaffold for Personal Project Operator.

It exists because OpenClaw owns built-in commands such as `/status`, `/menu`, and `/help`. Personal Project Operator must use the custom `/ppo` namespace for Telegram routing.

## Supported local PPO commands

```text
/ppo status
/ppo repo <project>
/ppo pr <project>
/ppo codex <project> <task>
/ppo codex-budget <project> <task>
/ppo prompt-size <draft>
/ppo split-task <task>
/ppo issue-create <project> <title> [--body <body>]
/ppo issue-confirm <request-id>
/ppo note-add <project> <note...>
/ppo note-confirm <request-id>
/ppo start <project>
/ppo runs
/ppo run <run-id>
/ppo cancel <run-id>
/ppo cancel-confirm <request-id>
/ppo continue <run-id>
/ppo recover <run-id>
/ppo menu
/ppo menu project
/ppo menu codex
/ppo menu system
/ppo help
```

## Local command entrypoint

From the repo root:

```bash
node local-operator/ppo-command.mjs status
node local-operator/ppo-command.mjs menu
node local-operator/ppo-command.mjs menu project
node local-operator/ppo-command.mjs menu codex
node local-operator/ppo-command.mjs menu system
node local-operator/ppo-command.mjs help
node local-operator/ppo-command.mjs repo khlim-assist
node local-operator/ppo-command.mjs pr khlim-assist
node local-operator/ppo-command.mjs "/ppo issue-create khlim-assist issue title --body optional body"
node local-operator/ppo-command.mjs "/ppo note-add khlim-assist project note text"
node local-operator/ppo-command.mjs "/ppo note-confirm <request-id>"
node local-operator/ppo-command.mjs /ppo start khlim-assist
node local-operator/ppo-command.mjs /ppo runs
node local-operator/ppo-command.mjs /ppo run <run-id>
node local-operator/ppo-command.mjs /ppo cancel <run-id>
node local-operator/ppo-command.mjs /ppo cancel-confirm <request-id>
node local-operator/ppo-command.mjs /ppo continue <run-id>
node local-operator/ppo-command.mjs /ppo recover <run-id>
```

Phase 5C project notes are terminal-only:

```bash
node local-operator/ppo-command.mjs note-add khlim-assist "project note text"
```

Phase 5D `/ppo note-add` is staging only and rejects `PPO_NOTE_WRITE_CONFIRM` in chat. `/ppo note-confirm <request-id>` consumes one pending request before invoking the Phase 5C writer with internal confirmation.

Phase 6K `/ppo continue <run-id>` accepts only an existing ordinary Phase 6 development run id, advances at most one reviewed Phase 6B-6G boundary, and never routes PPO production deployment, verification, rollback, rollback reconciliation, services, or owner confirmations.

Phase 6M `/ppo recover <run-id>` accepts only an existing ordinary Phase 6 development run id, invokes one reviewed Phase 6L read-only recovery boundary, and never repairs, retries, continues, mutates state, or routes production recovery.

Phase 6O `/ppo runs` and `/ppo run <run-id>` expose only the reviewed Phase 6N read-only ordinary-run catalog. They accept no filters, search, sort, limits, cancellation, retry, repair, recovery, continue, production action, or model interpretation.

Phase 6P `/ppo cancel <run-id>` and `/ppo cancel-confirm <request-id>` are confirmation-gated quiescent cancellation routes for ordinary runs only. They stage first, bind run id/project/status/version, use a 10-minute single-use request id, and never interrupt processes, clean workspaces, retry, repair, recover, continue, or route production cancellation.

Phase 7A `/ppo start <project>` accepts only one existing five-project id, reuses Phase 6B `createPlannedDevelopmentRun(projectId)` once, creates at most one planned run, returns `/ppo continue <run-id>` as the next command, and never continues automatically, creates a workspace, invokes Codex, runs tests/review, pushes, creates PRs, merges, deploys, verifies production, rolls back, adds a tool, or uses model interpretation.

OpenClaw direct command dispatch uses the local plugin tool:

```text
command-dispatch: tool
command-tool: ppo_local
command-arg-mode: raw
```

The `ppo_local` tool is registered by the repo-local plugin at:

```text
openclaw/plugins/ppo-local
```

Manually load the local skill in place by adding the absolute repo path `<ppo-repo>/openclaw/skills` to OpenClaw `skills.load.extraDirs`, manually link the local plugin with `openclaw plugins install -l <ppo-repo>/openclaw/plugins/ppo-local`, and make sure the effective OpenClaw tool policy allows only `ppo_local` for PPO. Under restrictive profiles such as `tools.profile: "coding"`, the plugin can register `ppo_local` while the active tool policy still blocks it.

Do not depend on OpenClaw's current working directory. Do not use a copied plugin install for the owner Telegram test, because the plugin resolves the existing wrapper through its linked repo path.

## Relationship to the simulator

`local-operator/ppo-command.mjs` is a namespace wrapper over `local-operator/simulate-command.mjs`.

The underlying simulator still supports terminal-only commands like `/status` and `/menu`. The wrapper adapts those outputs for OpenClaw and Telegram by showing `/ppo ...` command hints.

## Safety boundary

This scaffold does not:

- install OpenClaw
- install dependencies
- modify `~/.openclaw`
- modify OpenClaw config
- call Telegram APIs
- call GitHub APIs except approved read-only commands and the Phase 5B `/ppo issue-confirm` issue writer
- handle bot tokens
- require API keys, bot tokens, passwords, or other PPO secrets
- deploy to VPS
- add any OpenClaw tool beyond `ppo_local`
- accept or expose terminal write confirmation environment values through chat
- accept rollback confirmations or production targets through chat
- create comments, labels, assignees, milestones, PRs, branches, commits, merges, workflow dispatches, project-state mutations, or deployments
- route `/ppo` through model interpretation
- create notes outside terminal-only `note-add` or the Phase 5D `/ppo note-add` plus `/ppo note-confirm` approval path
- route PPO production deployment, verification, or rollback through `/ppo continue`
- route PPO production deployment, verification, rollback, rollback reconciliation, or service control through `/ppo recover`
- route recovery, continuation, cancellation, retry, repair, or production action through `/ppo runs` or `/ppo run`
- route process interruption, cleanup, recovery, continuation, retry, repair, or production action through `/ppo cancel` or `/ppo cancel-confirm`
- route task text, SHAs, branches, runtime options, confirmations, automatic continuation, workspace creation, Codex/test/review execution, PR/merge behavior, or production action through `/ppo start`
- mutate project-state files from stored notes

Use it as the local routing contract for OpenClaw.
