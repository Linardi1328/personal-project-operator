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
- establish and verify Codex's no-outbound-network command sandbox before implementation starts, including the fixed native Linux `:workspace` profile for Ubuntu 24.04 production
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
- establish and verify the no-outbound-network command sandbox before tests execute
- invoke trusted test executables through explicit argv with `shell: false` and `cwd` set to the verified workspace
- record bounded testing attempts in the Phase 6A run record
- transition the run only through `implementation_ready -> tests_in_progress -> tests_passed`
- store metadata-only SHA-pinned test evidence
- inspect interrupted automated testing state read-only

Allowed in Phase 6F only as independent exact-SHA review and bounded hardening:

- read one Phase 6A run after Phase 6E PASS evidence is present
- reconcile one verified Phase 6C workspace
- require workspace branch and HEAD to equal `run.headSha`
- require a clean workspace before and after review
- require Phase 6D implementation evidence and Phase 6E PASS evidence to match `run.headSha`
- establish and verify an explicit no-outbound-network plus read-only workspace/source OS/process sandbox before review executes
- deny reviewer writes to the workspace, workspace Git state, and canonical source checkout on macOS through `sandbox-exec`, and require a trusted read-only mount namespace wrapper or equivalent over the same paths on Linux
- invoke one trusted locally configured reviewer executable through explicit argv with `shell: false` and `cwd` set to the verified workspace
- pass only a deterministic bounded review prompt without secrets, raw outputs, arbitrary paths, or credentials, with a decision contract that matches parser validation
- validate strict bounded structured reviewer output
- record bounded review attempts in the Phase 6A run record
- transition the run only through `tests_passed -> review_in_progress -> review_passed` or `review_changes_requested`
- store metadata-only SHA-pinned review evidence
- inspect interrupted independent review state and exact-SHA approval validity read-only
- start hardening only from valid `review_changes_requested` evidence for exactly `run.headSha`
- derive remediation context only from durable validated review evidence
- include all validated remediation items and mandatory safety boundaries in Phase 6D hardening prompts, trimming only optional task/planning context or failing closed
- reuse Phase 6D implementation, Phase 6E testing, and Phase 6F review engines
- run at most three durable hardening rounds per development run
- require fresh test PASS and fresh independent review after every new implementation SHA
- record owner-action-required evidence and stop on non-convergence
- inspect hardening status read-only

Allowed in Phase 6G only as deterministic acceptance, GitHub delivery, remote review, and exact-head merge:

- accept only exact-version `review_passed` runs with matching Phase 6D implementation, Phase 6E PASS, Phase 6F approval, and clean Phase 6C workspace evidence for `run.headSha`
- push only the approved implementation SHA to the approved Phase 6C branch on fixed `origin`
- create or reuse exactly one PR from the approved branch to `main`
- require exact-head `PPO PR validation`
- run the exact-head remote PR reviewer inside the Phase 6F no-network/read-only sandbox boundary
- transition only through `review_passed -> merge_ready -> merged`
- merge only with the fixed method and expected-head-SHA protection
- reconcile ambiguous push, PR creation, and merge outcomes read-only
- store metadata-only delivery and merge evidence

Allowed in Phase 6H only as exact-SHA PPO deployment:

- create/read/transition Personal Project Operator self-development runs only through the explicit fixed run-state capability for `personal-project-operator` / `Linardi1328/personal-project-operator`
- accept only exact-version `merged` runs
- require Phase 6G merged evidence for exactly `run.headSha`
- derive the deployment target only from the Phase 6G merge commit SHA
- use only the fixed `personal-project-operator` deployment profile
- transition only through `merged -> deploy_in_progress -> deployed` or `deploy_failed`
- switch only the fixed PPO checkout to the exact Phase 6G merge SHA
- run the approved runtime preflight
- restart only `ppo-openclaw.service`
- inspect ambiguous deployment state read-only without retrying, mutating, restarting, or verifying production
- store metadata-only deployment evidence

Allowed in Phase 6I only as read-only PPO production verification:

- accept only exact-version `deployed` Personal Project Operator self-development runs
- require valid Phase 6H deployed evidence for the exact deployed SHA
- require the deployed SHA to equal the Phase 6G merge commit SHA
- use only the fixed Phase 6H `personal-project-operator` production profile
- transition only through `deployed -> verification_in_progress -> verified` or `verification_failed`
- inspect fixed production repository, checkout, runtime, systemd, unit, permission, and bridge facts read-only
- reconcile ambiguous verification state read-only without retrying mutation or inferring success from partial checks
- store metadata-only verification evidence

Blocked unless explicitly approved in a later write-enabled phase:

- push code outside the Phase 6G approved-branch exact-SHA push boundary
- create branches outside the Phase 6C isolated workspace manager
- delete branches outside definite Phase 6C cleanup
- create issues outside the Phase 5A terminal path or Phase 5B approval-gated chat path
- create project notes outside the Phase 5C terminal path or Phase 5D approval-gated chat path
- modify `projects/*.md` or project-state files outside the Phase 5E terminal promotion path
- comment on PRs
- comment on issues
- change labels
- approve PRs
- merge PRs outside the Phase 6G expected-head-SHA merge boundary
- change repo settings
- execute planner behavior beyond Phase 6B deterministic next-stage planning
- execute Codex outside the Phase 6D bounded execution adapter
- execute automated tests outside the Phase 6E trusted test runner
- execute automated review outside the Phase 6F trusted independent review agent
- execute automated hardening outside the Phase 6F bounded hardening orchestrator
- execute deployment agents outside the Phase 6H exact-SHA PPO deployment boundary
- execute production verification agents outside the Phase 6I read-only PPO verification boundary
- execute rollback agents from Phase 6A run-state records
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

- restart services outside the fixed Phase 6H PPO service restart
- deploy code outside the Phase 6H exact-SHA PPO deployment boundary
- rotate credentials
- change firewall rules
- run destructive file operations
