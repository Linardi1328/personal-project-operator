# PPO Local OpenClaw Plugin

This local plugin registers one OpenClaw tool:

```text
ppo_local
```

The tool is the deterministic bridge for Phase 1.5:

```text
/ppo ... -> ppo_local -> local-operator/ppo-command.mjs -> local simulator output
```

## Scope

The plugin:

- accepts only the approved Phase 1.5 PPO command surface
- invokes only `local-operator/ppo-command.mjs`
- passes arguments as an argv array through `execFile`
- does not use a shell
- does not call GitHub APIs
- does not call Telegram APIs
- does not use secrets
- does not mutate files
- does not implement Phase 2

## Supported Raw Inputs

```text
status
menu
help
menu project
menu codex
menu system
```

The bridge also accepts full `/ppo ...` payloads for local validation, but OpenClaw `command-arg-mode: raw` normally forwards only the text after `/ppo`.

## Local Tests

From the repo root:

```bash
node openclaw/plugins/ppo-local/test-bridge.mjs
```
