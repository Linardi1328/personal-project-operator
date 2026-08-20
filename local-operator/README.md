# Local Operator Simulator

This folder contains the local command simulator and deterministic PPO command implementations used before or underneath OpenClaw routing.

For Phase 5E project-state promotion, see [phase-5e-project-state-promotion.md](phase-5e-project-state-promotion.md).

## Phase 5E terminal state promotion

Phase 5E adds:

```bash
node local-operator/ppo-command.mjs state-promote <project> <note-id> <current-phase|last-known-status|next-action>
```

The command is terminal-only and requires exact `PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>`. `/ppo state-promote` remains unsupported. The implementation promotes one durable Phase 5C/5D note verbatim into exactly one approved `projects/<project>.md` section, refuses `main` and dirty targets, rechecks the target hash before mutation, uses atomic durable replacement, and writes metadata-only promotion audit records.

All earlier Phase 1-5D simulator, GitHub read-only, Codex planning, controlled issue, and controlled note behavior remains implemented in the files in this directory. See the repository root README and command/security docs for the complete historical phase details.

## Key files

- `ppo-command.mjs`: terminal and `/ppo` wrapper/dispatcher.
- `github-project-registry.mjs`: fixed five-project allowlist.
- `github-readonly.mjs`: approved GitHub read-only client.
- `github-issue-create.mjs`: Phase 5A terminal-only controlled issue writer.
- `github-issue-approval.mjs`: Phase 5B approval-gated chat issue workflow.
- `project-note-add.mjs`: Phase 5C terminal-only append-only project notes.
- `project-note-approval.mjs`: Phase 5D approval-gated chat project notes.
- `project-state-promote.mjs`: Phase 5E terminal-only controlled project-state promotion.
- `project-state-promote.test.mjs`: Phase 5E allowlist, safety, durability, audit, regression, and routing tests.
- `phase-5e-project-state-promotion.md`: Phase 5E local-operator usage and safety boundary.

## Current safety boundary

Phase 5E permits only one new local mutation: replacing the body of `## Current phase`, `## Last known status`, or `## Next action` with the exact text of a durable note for the same project. It does not add Telegram/OpenClaw project-state mutation, GitHub API writes, model calls, deployment behavior, or mutating git commands.

The broader PPO safety model remains read-only-first with individually reviewed write capabilities. External writes, repository writes, merges, deployments, and additional state mutations remain disabled unless a specific reviewed phase enables them.
