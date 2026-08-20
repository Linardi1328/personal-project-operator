# Phase 5E Local Project-State Promotion

Phase 5E adds one terminal-only controlled project-state mutation path to the local operator.

## Command

```bash
node local-operator/ppo-command.mjs state-promote <project> <note-id> <field>
```

Allowed fields:

- `current-phase`
- `last-known-status`
- `next-action`

The source note must be a durable Phase 5C/5D note for the same allowlisted project and must use the 43-character opaque note-id format.

## Confirmation

A mutation requires the exact confirmation tuple:

```bash
PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>
```

Missing or mismatched confirmation performs zero project-state mutation.

## Git safety preflight

Before mutation, Phase 5E:

- refuses to run on `main`;
- refuses when the target `projects/<project>.md` is dirty;
- validates that the target is a regular local file;
- records the expected before hash;
- rechecks git safety and the target hash immediately before replacement.

The Phase 5E runtime path uses git only for read-only `rev-parse` and `status` checks. It does not run git add, commit, push, merge, checkout, reset, or branch operations.

## Replacement and audit

Only the selected level-two Markdown section body is replaced. All bytes outside that section remain unchanged.

The replacement uses a same-directory temporary file, fsync, atomic rename, and directory fsync. The dedicated audit is metadata-only and includes project, field, note id, status, timestamps, and before/after SHA-256 hashes. It excludes note text, confirmation values, tokens, secrets, and raw failures.

Attempted audit must be durable before mutation. A post-mutation durability or success-audit uncertainty returns an ambiguous result and must not be retried automatically. Successful prior promotion of the same project/note/field tuple is refused as a duplicate, and a dangling attempted record blocks automatic retry.

## Routing boundary

Phase 5E is terminal-only. `/ppo state-promote` remains unsupported, so OpenClaw and Telegram cannot mutate project-state files through this phase.

Phase 5E adds no GitHub API writes, model calls, deployments, or new OpenClaw permissions.
