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

- accepts only the approved PPO command surface for Phase 2C while Phase 3A `codex` remains terminal-only
- invokes only `local-operator/ppo-command.mjs`
- passes arguments as an argv array through `execFile`
- does not use a shell
- routes `/ppo status`, `/ppo repo <project>`, and `/ppo pr <project>` to the Phase 2A GitHub read-only client
- does not call Telegram APIs
- does not use secrets
- does not mutate files
- does not add GitHub writes or generic GitHub tools
- does not accept `codex ...` through OpenClaw/Telegram in Phase 3A

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
```

The bridge also accepts full `/ppo ...` payloads for local validation, but OpenClaw `command-arg-mode: raw` normally forwards only the text after `/ppo`.

## Local Tests

From the repo root:

```bash
node openclaw/plugins/ppo-local/test-bridge.mjs
```
