# RIC-157 pilot campaign — Batch 1 integrated verification

Verified starting main: `3207553da0c301adb04618f1b71fa20bbfecf90b`, the squash merge of D1 PR #162. An independent agent executed a separate clean detached checkout at this exact SHA, rather than treating a review of the prior feature branch as merged-main execution evidence. Environment: macOS, Node v24.20.0, Docker 29.9.3, PostgreSQL 16.14 image `postgres@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`.

## Exact merged-main execution

- Focused Phase 1F/1G, canonical/admission/catalog/migration/ownership/corrective/preflight: **172 passed, zero failed/skipped**.
- Separate SQLite durability: **12 passed, zero failed/skipped**.
- Actual network-none disposable PostgreSQL: **66 passed, zero failed/skipped**, 403.146 seconds; teardown confirmed. This includes original suites and the action/resource suite repeated under mandatory D1 certification.
- H-01 remains corrected: 19→20 succeeds, progress/cancellation at 20 remain valid within other limits, 21st total run denies atomically and the catalog remains ready.
- H-02 remains corrected: unrelated privileged disposable history corruption blocks another otherwise-valid admission without mutation.
- The valid 33,440,469-byte native corpus, small successful rollback control, oversized valid append denial and exact native history/raw archive parity pass. Stale isolation, competing writers, ownership, expiry, crash/restart and ambiguous reconciliation remain covered.

Standard gate commands are independently executed on that checkout; broad-gate completion and exact final PR-head CI are recorded in the PR/Linear evidence. Existing policy-validator `remote-and-host-acceptance` SKIP diagnostics mean real hosts are unverified, not that synthetic tests were disabled. No actual host acceptance is claimed.

```sh
node deployment/scripts/run-ppo-development-quality.mjs syntax
CI=true GITHUB_ACTIONS=true GITHUB_RUN_ID=15720261113 GITHUB_RUN_ATTEMPT=31 \
  bash deployment/scripts/test-ppo-postgres-authority.sh
TMPDIR=/private/tmp node --test \
  local-operator/software-factory-remote-host-fence.test.mjs \
  local-operator/software-factory-remote-transaction-fence.test.mjs \
  local-operator/software-factory-remote-postgres-action-fence.test.mjs \
  local-operator/software-factory-postgres-resource-fence.test.mjs \
  local-operator/development-isolated-canonical-run-state.test.mjs \
  local-operator/development-postgres-canonical-catalog.test.mjs \
  local-operator/development-migration-preflight.test.mjs \
  local-operator/development-migration-rehearsal.test.mjs \
  local-operator/development-ownership-rehearsal.test.mjs \
  local-operator/development-catalog-certified-query.test.mjs \
  local-operator/ric-157-corrective-integrity.test.mjs \
  local-operator/war-room-assignment-preflight.test.mjs
TMPDIR=/private/tmp node --test local-operator/software-factory-remote-sqlite-fence-lab.test.mjs
TMPDIR=/private/tmp node deployment/scripts/run-ppo-development-quality.mjs parallel-regression
TMPDIR=/private/tmp node deployment/scripts/run-ppo-development-quality.mjs serial-regression
TMPDIR=/private/tmp node deployment/scripts/run-ppo-development-quality.mjs critical-lifecycle
TMPDIR=/private/tmp node deployment/scripts/run-ppo-development-quality.mjs integrated-acceptance
git diff --check
git diff --check origin/main...HEAD
```

Logs are retained outside the checkout as `/tmp/ric157-pilot-main-{focused,sqlite,postgres,syntax,parallel-regression,serial-regression,critical-lifecycle,integrated-acceptance}.log`. Those paths describe local retained evidence, not portable committed artifacts. Counts, exact commands, failures and hosted URLs belong in the review record. An intermittent failure is retained, investigated and reported separately from any focused/full rerun; passing a later attempt does not erase it. PR #162's successful-case Git cleanup `ENOTEMPTY` and earlier large-snapshot transport deadline remain documented in that PR and are not asserted fixed by D2.

## Wiring and contract boundary

A repository scan of non-test JavaScript callers found the PostgreSQL canonical, D1 certified-query, ownership and resource factories confined to their explicit isolated modules and disposable harnesses. The Phase 1F `consumeActionFence` seam remains injected trusted infrastructure; this batch does not connect the PostgreSQL diagnostic adapter as a successful executable callback. No `grant:true`, `canExecute:true` or `releaseAuthorized:true` assignment was introduced. This is a source-wiring audit of this checkout, not proof about outside processes or real source quiescence.

M-01 tests deliberately execute deferred checks early and then change time or authority. L-01 uses valid resource-table statements, positive shape controls, exact SQLSTATE 42501, role/function privilege introspection and private-boundary probes. These tests preserve synthetic effect/tombstone/receipt parity, rather than claiming a trigger establishes strict durable-commit freshness. Detailed outcomes and any new test-construction failures are retained in the PR evidence.

The [proposed resource authorization contract](war-room-protected-resource-authorization-proposal.md) is an explicit owner decision, not an implementation or an approved interpretation of the original contract. All executable grant flags remain false. M-03 measured operating budgets, authenticated service/key custody, external restore/incarnation trust, actual protected resource enforcement, real source fencing and separate final pilot approval remain blockers. RIC-157 stays In Progress, RIC-59/RIC-61 remain held; no merge, connectivity, enrollment, production change or real factory cycle is authorized.
