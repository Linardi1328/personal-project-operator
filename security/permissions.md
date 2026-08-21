# Permissions

## Default posture

Personal Project Operator is read-only by default.

Phase 0 allows:

- reading local documentation
- displaying command help
- formatting expected outputs
- planning future integrations
- generating prompt templates

Phase 0 does not allow:

- live GitHub API calls
- live OpenClaw bot actions
- Telegram API registration
- VPS deployment
- Codex usage scraping
- customer messaging
- production deployment
- trading execution
- credential storage

## GitHub permissions

Future GitHub access should start read-only.

Allowed in future read-only phases:

- repo metadata read
- recent commit read
- PR read
- issue read
- check status read

Allowed in Phase 5A only from a trusted terminal with exact confirmation and audit:

- create one GitHub issue in an approved project repo through `issue-create <project> <title> [body...]`

Allowed in Phase 5B only through the existing `ppo_local` direct-tool path with local approval state:

- stage one issue-create request with `/ppo issue-create <project> <title> [--body <body>]`
- create one GitHub issue only after `/ppo issue-confirm <request-id>` atomically claims and consumes one unexpired request

Allowed in Phase 5C only from a trusted terminal with exact confirmation and private local write-data storage:

- append one local project note under `${PPO_WRITE_DATA_DIR}/project-notes` through `note-add <project> <note...>`

Allowed in Phase 5D only through the existing `ppo_local` direct-tool path with local approval state:

- stage one note-add request with `/ppo note-add <project> <note...>`
- append one local project note only after `/ppo note-confirm <request-id>` atomically claims and consumes one unexpired request

Allowed in Phase 5E only from a trusted terminal with exact confirmation, git safety preflights, and metadata-only audit:

- promote one durable local project note into exactly one approved `projects/<project>.md` section through `state-promote <project> <note-id> <field>`

Allowed in Phase 6A only as local private run-state storage:

- create and transition durable development run records under `${PPO_WRITE_DATA_DIR}/development-runs`
- store bounded SHA-pinned planning, implementation, review, test, deploy, and verification evidence metadata
- reject stale expected versions and invalid lifecycle transitions

Allowed in Phase 6B only as deterministic local next-stage planning:

- read the fixed selected project doc, `ROADMAP.md`, and Phase 2 GitHub read-only snapshot facts
- return a bounded plan or owner-action-required result
- create or plan a Phase 6A run only through `created -> planning_in_progress -> planned`
- store metadata-only SHA-pinned planning evidence

Allowed in Phase 6C only as deterministic local workspace preparation:

- read one `planned` Phase 6A run
- read source repository facts from a configured project workspace registry
- create one deterministic branch from exactly `run.baseSha`
- create one worktree under a PPO-managed workspace root
- remove that branch/worktree only during definite cleanup
- transition the run only through `planned -> implementation_in_progress`
- store metadata-only SHA-pinned implementation workspace evidence

Blocked unless explicitly approved in a later write-enabled phase:

- push code
- create branches outside the Phase 6C isolated workspace manager
- delete branches outside definite Phase 6C cleanup
- create issues outside the Phase 5A terminal path or Phase 5B approval-gated chat path
- create project notes outside the Phase 5C terminal path or Phase 5D approval-gated chat path
- modify `projects/*.md` or project-state files outside the Phase 5E terminal promotion path
- comment on PRs
- comment on issues
- change labels
- approve PRs
- merge PRs
- change repo settings
- execute planner behavior beyond Phase 6B deterministic next-stage planning
- execute Codex, test, review, merge, deployment, rollback, or verification agents from Phase 6A run-state records
- mutate files inside Phase 6C workspaces

## Chat platform permissions

Allowed:

- receive commands
- send operator replies to the user

Blocked in early phases:

- send customer messages
- reply in business chats without confirmation
- broadcast messages
- auto-post content

## VPS permissions

Future VPS checks should be read-only by default.

Blocked unless explicitly approved:

- restart services
- deploy code
- rotate credentials
- change firewall rules
- run destructive file operations
