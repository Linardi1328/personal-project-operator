# Phase 5E Project-State Promotion Safety Boundary

Phase 5E adds one terminal-only controlled mutation: promoting the exact text of a durable Phase 5C/5D project note into one approved project-state section.

## Allowed mutation

Only one of these section bodies in `projects/<project>.md` may change per invocation:

- `## Current phase`
- `## Last known status`
- `## Next action`

The note text is copied verbatim from the local durable note store. No model, summarizer, template expansion, or remote content source participates in the mutation.

## Preconditions

A confirmed mutation requires all of the following:

- project is in the fixed five-project registry
- note id has the Phase 5C/5D 43-character opaque format
- note belongs to the selected project
- field is one of the three approved fields
- exact `PPO_PROJECT_STATE_CONFIRM` value matches the full project/note/field tuple
- current branch is not `main`
- target project file has no uncommitted changes
- target bytes have not changed between preview/preflight and mutation
- attempted audit record is durable before replacement begins

## Protected state

Project identity, repo, connection status, role, OpenClaw priority, Codex fit, Do not change, Known risks, and all other non-selected content are outside the mutation surface. Replacement preserves bytes outside the selected section.

## Durability and ambiguity

The project file is replaced through a same-directory temporary file, file fsync, atomic rename, and directory fsync. A pre-rename failure is a definite failure and may record `failed`. If mutation may already have happened, PPO must report ambiguity instead of claiming a definite failure.

If the final success audit cannot be written after mutation, PPO returns an ambiguous warning and must not automatically retry. Successful prior promotion of the same note/project/field tuple is refused as a duplicate; a dangling attempted record is treated as ambiguous.

## Audit minimization

The promotion audit contains only metadata needed for traceability: project, field, note id, status, timestamps, and before/after hashes. It does not record note text, confirmation values, tokens, secrets, or raw failure details.

## Out of scope

Phase 5E adds no `/ppo`/Telegram/OpenClaw route, GitHub API write, issue/comment/label/PR mutation, git add/commit/push/merge/checkout/reset/branch operation, deployment action, or model call.
