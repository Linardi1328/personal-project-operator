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

Blocked unless explicitly approved in a later write-enabled phase:

- push code
- create branches
- delete branches
- create issues outside the Phase 5A terminal path or Phase 5B approval-gated chat path
- comment on PRs
- comment on issues
- change labels
- approve PRs
- merge PRs
- change repo settings

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
