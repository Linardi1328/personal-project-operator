# note-add

## Command name

`note-add <project> <note...>`

## Purpose

Append one durable local project note after exact terminal confirmation.

Phase 5C is terminal-only. There is no `/ppo note-add` command.

## Input format

```text
node local-operator/ppo-command.mjs note-add <project> <note...>
```

The note is inert text. It must be non-empty, 2000 characters or fewer, and must not contain terminal control characters or escape sequences.

## Terminal Confirmation

Without exact confirmation, the command prints a deterministic preview and refuses the append:

```text
PPO_NOTE_WRITE_CONFIRM=add-note:<project>
```

Example confirmed terminal invocation:

```bash
PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist node local-operator/ppo-command.mjs note-add khlim-assist "Record owner-visible project context"
```

Do not route this command through chat. `/ppo note-add` remains unsupported.

## Storage

Notes are stored under:

```text
${PPO_WRITE_DATA_DIR}/project-notes
```

Local default:

```text
local-operator/write-data/project-notes
```

VPS default through systemd:

```text
/var/lib/personal-project-operator/write-data/project-notes
```

Directories are `0700`, files are `0600`, and confirmed actions append exactly one fsynced JSONL record. Each note record includes a random opaque note id, timestamp, project metadata, and the exact note text.

## Audit

The audit trail records metadata only for refused, attempted, succeeded, and failed actions. Audit records must not include note text, confirmation values, request ids, tokens, or raw failures.

Confirmed writes fail closed before note mutation if the attempted audit record cannot be established. If a note append succeeds but the success audit record fails, the command returns an explicit "note may have been written" result so the store can be inspected before retrying.

## Safety boundary

Phase 5C must not route `note-add` through `/ppo`, `ppo_local`, OpenClaw, or Telegram. It must not call GitHub APIs, create issues, comments, labels, PRs, branches, commits, merges, workflow dispatches, deployments, model calls, or modify `projects/*.md` or any project-state file.
