# note-add

## Command name

`note-add <project> <note...>`

`/ppo note-add <project> <note...>`

## Purpose

Append one durable local project note after exact terminal confirmation, or stage one Telegram/OpenClaw note request for later confirmation.

Phase 5C remains the trusted terminal path. Phase 5D adds the `/ppo` staging path through the existing `ppo_local` direct-tool route.

## Input format

```text
node local-operator/ppo-command.mjs note-add <project> <note...>
```

Telegram/OpenClaw Phase 5D:

```text
/ppo note-add <project> <note...>
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

Do not paste `PPO_NOTE_WRITE_CONFIRM` into chat. `/ppo note-add` rejects chat input containing that environment variable name.

## Telegram/OpenClaw approval

`/ppo note-add` performs staging only and performs zero note writes. It validates the project and note, prints project/repo/note length without note text, stores the normalized intent in a private pending store, and returns:

```text
/ppo note-confirm <request-id>
```

Request ids are random, opaque, single-use, and expire after 10 minutes. See [note-confirm.md](note-confirm.md).

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

Phase 5D pending note requests are stored temporarily under `${PPO_WRITE_DATA_DIR}/pending-project-notes` with private `0700` directories and `0600` files. Pending note text is deleted when the request is confirmed or expires.

## Audit

The audit trail records metadata only for refused, attempted, succeeded, and failed actions. Audit records must not include note text, confirmation values, request ids, tokens, or raw failures.

Confirmed writes fail closed before note mutation if the attempted audit record cannot be established. If a note append succeeds but the success audit record fails, the command returns an explicit "note may have been written" result so the store can be inspected before retrying.

## Safety boundary

Phase 5D routes only `/ppo note-add` staging and `/ppo note-confirm` approval through the existing `ppo_local` tool. It must not call GitHub APIs, create issues, comments, labels, PRs, branches, commits, merges, workflow dispatches, deployments, model calls, add OpenClaw tools, or modify `projects/*.md` or any project-state file.
