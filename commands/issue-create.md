# issue-create

## Command name

`issue-create <project> <title> [body...]`

`/ppo issue-create <project> <title> [--body <body>]`

## Purpose

Create one GitHub issue for an approved project after explicit approval.

Phase 5A supports a trusted terminal path. Phase 5B adds a Telegram/OpenClaw staging path that performs no GitHub write until the returned request id is confirmed.

## Input format

Terminal-only Phase 5A:

```text
node local-operator/ppo-command.mjs issue-create <project> <title> [body...]
```

The title should be quoted when it contains spaces. Body text is optional.

Telegram/OpenClaw Phase 5B:

```text
/ppo issue-create <project> <title> [--body <body>]
```

The body delimiter is the literal `--body` token. Text after the first body delimiter is treated as inert body data.

## Terminal Confirmation

Without exact confirmation, the command prints a deterministic preview and refuses the write:

```text
PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>
```

Example confirmed terminal invocation:

```bash
PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist node local-operator/ppo-command.mjs issue-create khlim-assist "Document provider validation"
```

Do not paste the terminal confirmation environment variable into chat.

## Chat Approval

`/ppo issue-create` never calls GitHub. It validates the project, title, and body, prints the same deterministic preview, stores the normalized intent in a private local pending store, and returns:

```text
/ppo issue-confirm <request-id>
```

Request ids are cryptographically random, opaque, single-use, and expire after 10 minutes.

## Allowed scope

Phase 5A and Phase 5B allow only:

- project ids from the fixed six-project connected registry
- `POST /repos/<approved repo>/issues`
- `title` and `body` fields
- local `gh api` invoked via Node `execFile` with `shell: false`, fixed argv shape, bounded timeout, and bounded output buffer
- credential-free JSONL audit records under `local-operator/audit/` locally or the configured VPS audit path
- private pending request files under `local-operator/write-data/` locally or the configured VPS write-data path

## Safety boundary

Phase 5B routes only through the existing `ppo_local` direct-tool path. It does not add a model turn, new OpenClaw tools, generic GitHub tools, provider access, comments, labels, assignees, milestones, project-state writes, or deployment behavior.

Phase 5A and Phase 5B must not create or update pull requests, comments, labels, branches, commits, merges, workflow dispatches, project-state files, VPS deployment, or any other GitHub write.
