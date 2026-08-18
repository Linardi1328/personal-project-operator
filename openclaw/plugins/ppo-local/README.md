# PPO Local OpenClaw Plugin

This local plugin registers one OpenClaw tool:

```text
ppo_local
```

The tool is the deterministic bridge for PPO commands:

```text
/ppo ... -> ppo_local -> local-operator/ppo-command.mjs
```

## Scope

The plugin:

- accepts the approved PPO command surface through Phase 3C, including deterministic Codex text commands
- invokes only `local-operator/ppo-command.mjs`
- passes arguments as an argv array through `execFile`
- does not use a shell
- routes `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` to the Phase 2A GitHub read-only client
- does not call Telegram APIs
- does not use secrets
- does not mutate files
- does not add GitHub writes or generic GitHub tools
- accepts `codex ...`, `codex-budget ...`, `prompt-size ...`, and `split-task ...` through OpenClaw/Telegram in Phase 3C as text-only direct routes
- parses only the command envelope; task and draft text is inert data

## Supported Raw Inputs

```text
status
menu
help
menu project
menu codex
menu system
repo khlim-assist
repo ledgerpilot-ai
repo spy-market-agent
repo portfolio
repo rbl-content-engine
pr khlim-assist
pr ledgerpilot-ai
pr spy-market-agent
pr portfolio
pr rbl-content-engine
codex khlim-assist add provider validation tests
codex ledgerpilot-ai add invoice import workflow
codex spy-market-agent harden research error handling
codex portfolio harden contact form error handling
codex rbl-content-engine organize source asset workflow
codex-budget khlim-assist add provider validation tests
codex-budget ledgerpilot-ai add invoice import workflow
codex-budget spy-market-agent harden research error handling
codex-budget portfolio harden contact form error handling
codex-budget rbl-content-engine organize source asset workflow
prompt-size Goal: build one focused feature
split-task add GitHub integration and Telegram routing
```

The bridge also accepts full `/ppo ...` payloads for local validation, but OpenClaw `command-arg-mode: raw` normally forwards only the text after `/ppo`.

## Local Tests

From the repo root:

```bash
node openclaw/plugins/ppo-local/test-bridge.mjs
```
