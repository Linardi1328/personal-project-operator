# note-confirm

## Command name

`/ppo note-confirm <request-id>`

## Purpose

Confirm one pending `/ppo note-add` request.

## Input format

```text
/ppo note-confirm <request-id>
```

`<request-id>` is the opaque id returned by `/ppo note-add`.

Bare terminal `note-confirm` is unsupported.

## Behavior

The command atomically claims one matching unexpired pending request before any note write. The id is single-use, and the pending content is consumed before the Phase 5C note writer runs with internal `add-note:<project>` confirmation.

Unknown, expired, already-consumed, malformed, or replayed ids perform zero note writes.

## Safety boundary

This command must not accept or print terminal write confirmation environment values. It must not call GitHub, create issues, comments, labels, assignees, milestones, PR writes, branch writes, commits, merges, workflow dispatches, project-state mutations, deployments, model calls, new OpenClaw tools, or arbitrary endpoints.
