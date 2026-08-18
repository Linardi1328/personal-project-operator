# codex-budget

## Command name

`codex-budget <project> <task>`

## Purpose

Produce a deterministic local estimate for a Codex-sized development task.

Phase 3B is terminal-only:

```bash
node local-operator/ppo-command.mjs codex-budget <project> <task>
```

Do not expose `/ppo codex-budget` through Telegram/OpenClaw in Phase 3B.

## Example input

```bash
node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai "add invoice import workflow"
```

## Expected output

The output includes:

- project display name
- repository identity from the fixed registry
- inert task text
- deterministic estimate: `Small`, `Medium`, `Large`, or `Too large - split required`
- deterministic reason
- evidence boundary
- suggested action

It does not claim exact token cost, inspect Codex usage, inspect arbitrary repository files, or call live GitHub.

## Safety boundary

This command generates text only. It must not invoke Codex, call OpenAI APIs, call another model, execute generated plans, mutate repositories, create branches, commit, push, create issues, open or merge PRs, deploy services, or edit OpenClaw configuration.

The task string is data only. Shell-looking punctuation, `$()`, backticks, and paths are not executed or interpreted.

## Future upgrade path

- Add richer budget signals only after separate approval.
- Review Telegram/OpenClaw arbitrary-text routing in Phase 3C.
