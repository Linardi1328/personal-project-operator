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

Blocked unless explicitly approved in a later write-enabled phase:

- push code
- create branches
- delete branches
- create issues
- comment on PRs
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

