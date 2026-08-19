# issue-confirm

## Command name

`/ppo issue-confirm <request-id>`

## Purpose

Confirm one pending `/ppo issue-create` request.

## Input format

```text
/ppo issue-confirm <request-id>
```

`<request-id>` is the opaque id returned by `/ppo issue-create`.

## Behavior

The command atomically claims one matching unexpired pending request before any GitHub write. The id is single-use and the pending content is consumed before the Phase 5A issue writer runs with internal confirmation.

Unknown, expired, already-consumed, malformed, or replayed ids perform zero GitHub writes.

## Safety boundary

This command must not accept or print terminal write confirmation environment values. It must not add comments, labels, assignees, milestones, PR writes, branch writes, commits, merges, workflow dispatches, project-state mutations, deployments, new OpenClaw tools, provider access, or arbitrary GitHub endpoints.
