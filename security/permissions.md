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

Allowed in Phase 6D only as bounded local Codex execution:

- read one `implementation_in_progress` Phase 6A run
- reconcile one verified Phase 6C workspace
- establish and verify an explicit no-outbound-network OS/process sandbox before Codex starts, including the Linux network-namespace privilege-drop backend for Ubuntu 24.04 production
- invoke trusted locally configured Codex through that sandbox with explicit argv, `shell: false`, and `cwd` set to the verified workspace
- pass a deterministic bounded prompt without secrets or confirmation values
- record bounded implementation attempts in the Phase 6A run record
- verify a new clean local descendant commit
- transition the run only through `implementation_in_progress -> implementation_ready`
- store metadata-only SHA-pinned implementation evidence
- inspect interrupted Codex execution state read-only

Allowed in Phase 6E only as deterministic local automated testing:

- read one Phase 6A run after Phase 6D implementation evidence is present
- reconcile one verified Phase 6C workspace
- require workspace branch and HEAD to equal `run.headSha`
- read test steps only from a trusted local per-project policy registry
- establish and verify an explicit no-outbound-network OS/process sandbox before tests execute
- invoke trusted test executables through explicit argv with `shell: false` and `cwd` set to the verified workspace
- record bounded testing attempts in the Phase 6A run record
- transition the run only through `implementation_ready -> tests_in_progress -> tests_passed`
- store metadata-only SHA-pinned test evidence
- inspect interrupted automated testing state read-only

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
- execute Codex outside the Phase 6D bounded execution adapter
- execute automated tests outside the Phase 6E trusted test runner
- execute review, merge, deployment, rollback, or verification agents from Phase 6A run-state records
- mutate files inside Phase 6C workspaces outside the Phase 6D bounded execution adapter

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
