# Phase 6Q - Full Phase 6 Integrated Acceptance and Closure

Phase 6Q adds no new production capability. It converts the reviewed Phase 6A-6P and Phase 7A user surfaces into one explicit non-production acceptance gate in `PPO PR validation`.

## Closure rule

Phase 6Q is accepted only when the exact PR head passes all of the following in GitHub Actions:

1. Node syntax checks.
2. Shell syntax checks.
3. Full regression with normal Node test scheduling.
4. Full regression serialized with `--test-concurrency=1`.
5. Two repeated critical Phase 6 lifecycle stability rounds.
6. The dedicated `Phase 6Q integrated user acceptance` test set.
7. Git whitespace checks.

A SHA change invalidates the result and requires the checks to run again.

## User-facing acceptance matrix

| User surface | Primary automated acceptance | Required |
| --- | --- | --- |
| `/ppo status` | `github-ppo-status.test.mjs` + bridge | PASS |
| `/ppo menu`, `/ppo help` | `test-bridge.mjs` | PASS |
| `/ppo repo <project>`, `/ppo pr <project>` | `github-ppo-commands.test.mjs` + bridge | PASS |
| `/ppo codex <project> <task>` | `codex-prompt-generator.test.mjs` + bridge | PASS |
| `/ppo codex-budget`, `/ppo prompt-size`, `/ppo split-task` | `codex-planning-tools.test.mjs` + bridge | PASS |
| `/ppo issue-create`, `/ppo issue-confirm` | `github-issue-approval.test.mjs` + bridge | PASS |
| `/ppo note-add`, `/ppo note-confirm` | `project-note-approval.test.mjs` + bridge | PASS |
| `/ppo start <project>` | `development-start-route.test.mjs` + bridge | PASS |
| `/ppo runs`, `/ppo run <run-id>` | `development-run-catalog-route.test.mjs` + bridge | PASS |
| `/ppo cancel`, `/ppo cancel-confirm` | `development-run-cancellation*.test.mjs` + bridge | PASS |
| `/ppo continue <run-id>` | `development-continue-orchestrator.test.mjs` + bridge | PASS |
| `/ppo recover <run-id>` | `development-recovery-route.test.mjs` + bridge | PASS |
| terminal `issue-create` | `github-issue-create.test.mjs` | PASS |
| terminal `note-add` | `project-note-add.test.mjs` | PASS |
| terminal `state-promote` | `project-state-promote.test.mjs` | PASS |
| local-only `ppo-self-development` | `development-self-controller.test.mjs` | PASS |

## Phase 6 lifecycle matrix

| Phase | Acceptance suite | Required |
| --- | --- | --- |
| 6A durable run state | `development-run-state.test.mjs` | PASS |
| 6B deterministic planning | `development-next-stage-planner.test.mjs` | PASS |
| 6C isolated workspace | `development-workspace-manager.test.mjs` | PASS |
| 6D bounded Codex execution | `development-codex-execution-adapter.test.mjs` | PASS |
| 6E exact-SHA tests | `development-test-runner.test.mjs` | PASS |
| 6F independent review + hardening | `development-review-agent.test.mjs`, `development-hardening-orchestrator.test.mjs` | PASS |
| 6G acceptance + GitHub delivery | `github-delivery-agent.test.mjs` | PASS |
| 6H exact-SHA deployment boundary | `development-deployment-agent.test.mjs` | PASS |
| 6I read-only production verification boundary | `development-production-verification-agent.test.mjs` | PASS |
| 6J exact previous-SHA rollback boundary | `development-rollback-agent.test.mjs` | PASS |
| 6K controlled continuation | `development-continue-orchestrator.test.mjs` | PASS |
| 6L unified read-only recovery | `development-recovery-coordinator.test.mjs` | PASS |
| 6M recovery route | `development-recovery-route.test.mjs` | PASS |
| 6N run catalog | `development-run-catalog.test.mjs` | PASS |
| 6O catalog routes | `development-run-catalog-route.test.mjs` | PASS |
| 6P quiescent cancellation | `development-run-cancellation.test.mjs`, `development-run-cancellation-approval.test.mjs` | PASS |
| 7A controlled start route | `development-start-route.test.mjs` | PASS |

## Explicitly gated live checks

The automated Phase 6Q step is intentionally non-production. It must not SSH to a host, call `systemctl`, deploy an exact SHA, execute the production verifier, or invoke rollback. Disposable live GitHub delivery E2E and production deployment/verification/rollback acceptance remain separate owner-approved operations, as required by the roadmap.

This means Phase 6Q can prove repository behavior, route coverage, safety contracts, deterministic test/review/deploy/rollback boundaries, and bridge integration without mutating production. Live environment health remains a separate smoke-test concern.
