# state-promote

## Command name

`state-promote <project> <note-id> <field>`

## Purpose

Promote one durable Phase 5C/5D project note verbatim into exactly one approved section of `projects/<project>.md`.

Phase 5E is terminal-only. `/ppo state-promote` is unsupported.

## Input format

```text
node local-operator/ppo-command.mjs state-promote <project> <note-id> <field>
```

Allowed fields only:

- `current-phase` → `## Current phase`
- `last-known-status` → `## Last known status`
- `next-action` → `## Next action`

The project must be in the fixed six-project connected registry. The note id must be the 43-character opaque id returned by Phase 5C/5D note creation, and the durable note must belong to the selected project.

## Terminal confirmation

The command requires an exact environment confirmation:

```text
PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>
```

Missing or mismatched confirmation performs zero project-state mutation.

## Mutation boundary

The stored note text is promoted verbatim. There is no summarization and no model call.

Only the body of the selected approved level-two Markdown section may be replaced. All bytes outside that section are preserved. Identity, repo, current role, OpenClaw priority, Codex fit, Do not change, Known risks, and every other non-selected section remain immutable through this command.

The command refuses on `main` and refuses when the selected `projects/<project>.md` already has uncommitted changes. It does not run `git add`, `git commit`, `git push`, `git merge`, `git checkout`, `git reset`, or `git branch`.

The replacement is written to a same-directory temporary file, fsynced, atomically renamed over the target, and followed by a directory fsync.

## Audit

Phase 5E writes a dedicated metadata-only audit trail under the PPO write-data directory. Records include project, field, note id, status, timestamp, and before/after SHA-256 hashes.

Audit records never include note text, confirmation values, tokens, or raw failures. A confirmed promotion fails closed before mutation if its `attempted` audit record cannot be established. If the target is changed but the final `succeeded` audit cannot be written, the command reports an ambiguous warning and must not be retried automatically.

A note that already has a successful promotion record for the same project and field is refused as a duplicate. A dangling attempted record for the same tuple is treated as ambiguous and also blocks automatic retry.

## Safety boundary

Phase 5E does not add Telegram or OpenClaw routing, GitHub API writes, issue or PR mutations, branch/commit/merge operations, deployments, or model calls.
