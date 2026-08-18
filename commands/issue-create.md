# issue-create

## Command name

`issue-create <project> <title> [body...]`

## Purpose

Create one GitHub issue for an approved project from a trusted terminal.

## Input format

```text
node local-operator/ppo-command.mjs issue-create <project> <title> [body...]
```

The title should be quoted when it contains spaces. Body text is optional.

## Confirmation

Without exact confirmation, the command prints a deterministic preview and refuses the write:

```text
PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>
```

Example confirmed terminal invocation:

```bash
PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist node local-operator/ppo-command.mjs issue-create khlim-assist "Document provider validation"
```

## Allowed scope

Phase 5A allows only:

- project ids from the existing five-project registry
- `POST /repos/<approved repo>/issues`
- `title` and `body` fields
- local `gh api` invoked via Node `execFile` with `shell: false`, fixed argv shape, bounded timeout, and bounded output buffer
- credential-free JSONL audit records under `local-operator/audit/`

## Safety boundary

This is terminal-only. It is not a `/ppo` command and must not be routed through `ppo_local`, OpenClaw, or Telegram.

Phase 5A must not create or update pull requests, comments, labels, branches, commits, merges, workflow dispatches, project-state files, VPS deployment, or any other GitHub write.
