# PPO × RBL War Room: read-only Linear issue preview (RIC-145)

## Purpose

One phone-readable command, `/ppo issue RIC-145`, retrieves **only an issue preview** from Linear into PPO's already-reviewed `/ppo` OpenClaw local bridge. This is a small Milestone C slice of RIC-137, distinct from Phase 1C's unmerged durable claim ledger and distinct from a live remote Mac worker.

The issue description is external, **untrusted task context**. No Linear text may grant execution, permits, agent/model selection, repository paths, GitHub writes, approvals, owner identity, or a PPO development-run transition. Nothing in this slice stages a dispatch or starts Codex/Antigravity. PPO remains the sole canonical owner of development-run state. RIC-59/RIC-61 operational holds remain unchanged.

## Command and output

- In the existing phone route: `/ppo issue RIC-145`
- Locally: `node local-operator/ppo-command.mjs issue RIC-145`
- Only canonical RBL issue IDs `RIC-<positive integer>` are accepted. No filters, free-form task content, URLs, extra flags, commands, role/project/permission overrides, or path input.
- Output is a bounded issue ID, title, state, Linear URL and a short sanitized description excerpt, explicitly marked **READ ONLY**. It does not print raw GraphQL errors or credentials.
- The existing `/ppo issue-create` and `/ppo issue-confirm` GitHub-issue workflow is unrelated and unchanged.

## Dedicated credential and live readiness

PPO reads **only** `PPO_LINEAR_READ_API_KEY` from the trusted execution process environment. It does not fall back to `LINEAR_API_KEY` or any broader tool/service token. Create a separately scoped, least-privilege **read-only** Linear personal API key limited to the needed RBL team where supported. Configure it outside source control on the trusted Mac runtime, not in a Telegram message, task/issue body, PR, shell history or source file. Never commit a real key. The adapter refuses to query Linear when this credential is unavailable or malformed.

The adapter uses a fixed HTTPS GraphQL endpoint (`https://api.linear.app/graphql`) and a fixed **query** only, with variables `{id:"RIC-145"}`. It refuses HTTP redirects, has a 6.5-second timeout and accepts at most 64 KiB of response data. It fails closed on malformed JSON, GraphQL errors, mismatched issue IDs, invalid data shape, untrusted URLs, missing authentication, or rate limiting. Linear currently documents the official GraphQL endpoint and personal-key `Authorization: <API_KEY>` header at https://linear.app/developers/graphql.

**Runtime connectivity and credential provisioning have not been confirmed.** A passing mocked test does not prove phone-to-Linear operation. The integration needs explicit trusted-runtime configuration and an owner-observed smoke test using a non-sensitive issue before it can be declared live.

## Verification

`node --test local-operator/war-room-linear-issue-preview.test.mjs local-operator/war-room-linear-issue-preview-integration.test.mjs`

GitHub's existing PR syntax, parallel regression, serial regression, critical lifecycle, Phase 6Q and whitespace gates must pass on the exact PR head. The OpenClaw bridge integration tests assert that malformed requests never reach the wrapper and the command never accepts caller-controlled execution scope.

## Not in scope

No Mac/VPS connection, transport listener, execution sandbox, source/branch/commit mutation, worktree creation, Linear mutation, GitHub issue/PR write, approval, persistent state, run start/continue, worker claim, auto-merge, deployment, release or production action. No changes to RIC-59/RIC-61 catalog/retirement guards or RIC-144's pending PR #146.