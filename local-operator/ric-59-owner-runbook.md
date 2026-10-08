# RIC-59: catalog integrity and abandoned-run retirement

Status: review candidate. No runtime record has been accessed or retired by this
change. Merge, production deployment and factory cycles are not authorized.

## What is implemented

- Admission and manager cycles require complete, well-formed diagnostics with
  exactly zero invalid records. Queue admission inherits this gate. Direct
  `factory-run` checks the catalog before every continuation. Existing WIP limits
  remain two projects and one active run per project.
- The display catalog still reports invalid counts; it cannot authorize work
  from the valid subset. Legitimate out-of-scope PPO self-development records
  remain allowed by the diagnostics gate.
- `diagnoseDevelopmentRunHistory` uses the existing read-only file inspector and
  validator. It returns only a validated run ID and a fixed failure code (plus
  `ok`). It inspects canonical state and immutable version markers without
  repairing either. `diagnoseDevelopmentRunCatalog` lists only IDs and codes.
- `createDevelopmentRunRetirementSession` stages a ten-minute, process-local,
  one-time owner challenge for exactly these targets:

| Run | Project | Required status | Required version |
| --- | --- | --- | --- |
| `JKjs4fO20mMh3kwO93uTHx3PMV-X--wWPSv9nedHb7U` | khlim-assist | tests_in_progress | 7 |
| `kqA2X9fEomYXqKy4fZdE_6bilD8KLTGhREhjp-uwRLk` | khlim-assist | review_passed | 13 |

Confirmation consumes the request before any asynchronous operation, including
when authorization is refused or the operation is blocked. Requests cannot
survive a process restart. Caller-mutated previews are not authoritative. The
request binds the explicit store path, complete validated record digest,
status/version and expiry. Confirmation rereads and validates the history and
canonical state while holding a trusted quiescence guard, then uses the existing
`transitionDevelopmentRun` API with an expected version. A successful operation
adds a terminal `cancelled` event with the fixed retirement actor, unique approval
ID, issue reference, issuance time and prior record digest. Prior events, version
markers and evidence are preserved. No test or review is relabelled successful.
Ordinary `/ppo cancel` is unchanged.

## Execution remains blocked on trusted quiescence

**There is no production retirement command or default execution adapter in this
PR. The guarded retirement core is implemented and fixture-tested; operational
retirement is not yet execution-ready.** The current code cannot establish that
legacy orphan children are stopped, nor fence Phase 6G remote delivery. A missing
lease, a dead/old parent PID, no open GitHub PR, or an owner saying “abandoned” is
not proof. Existing leases, including stale leases, always block this path.

`inspectDevelopmentRunRetirement` therefore returns
`retirement_quiescence_unverifiable` for otherwise eligible lease-free targets.
Owner approval cannot override that outcome. Do not copy test guards or call the
state transition API directly to bypass it.

Before exposing execution, a separately reviewed trusted host integration must:

1. Authenticate the owner independently and collect the exact staged challenge
   once for each run. Prior abandonment confirmation does not authorize execution.
2. Establish the identity and complete set of legacy workers, descendants,
   workspace operations/locks, queued dispatches and remote delivery operations.
   Any untracked/unknown operation blocks. Resolving a stale lease is separate
   human intervention; this path never deletes or reclaims leases.
3. Acquire an exclusive guard covering that entire set and prevent new worker,
   workspace and delivery operations until after the state commit. The guard must
   also exclude concurrent state writers. A read-only snapshot is insufficient.
4. Return `workersQuiescent`, `deliveryQuiescent`, `exclusive`, `assertHeld()` and
   `release()` through trusted module dependencies. Never accept these from
   request JSON, CLI booleans, environment assertions or an uploaded certificate.
   `assertHeld()` must validate the held guard, not return a constant.
5. Keep the proof valid through the expected-version transition. Failure to
   release a guard or ambiguity after commit requires read-only inspection and
   human intervention, never automatic retry.

Until such an integration exists, stop at the blocked result. This is an explicit
remaining RIC-59 operational prerequisite, not a successful retirement.

## Owner-side review and read-only diagnosis

Run these only on the owner's Mac, in a separate review worktree. They do not
start PPO, a manager cycle, a worker, or a deployment.

```bash
git fetch origin
git worktree add --detach ../ppo-ric59-review origin/fix/ric-59-safe-run-retirement
cd ../ppo-ric59-review
node --test local-operator/ric-59-catalog-safety.test.mjs local-operator/development-run-diagnostics.test.mjs local-operator/development-run-retirement.test.mjs
```

Before diagnosing the real record, arrange a quiet backup window without new
PPO writes. If a consistent backup cannot be established, stop and ask for local
operator intervention. This PR does not stop processes or disable services.
The following creates a new private backup; do not upload it or print its files:

```bash
: "${PPO_WRITE_DATA_DIR:?Set PPO_WRITE_DATA_DIR to the existing absolute durable write-data path}"
case "$PPO_WRITE_DATA_DIR" in
  /*) ;;
  *) echo "PPO_WRITE_DATA_DIR must be absolute" >&2; exit 1 ;;
esac
test -d "$PPO_WRITE_DATA_DIR/development-runs/records" || exit 1
umask 077
PPO_RIC59_BACKUP="$(mktemp -d "$HOME/ppo-ric59-backup.XXXXXX")" || exit 1
mkdir -m 700 "$PPO_RIC59_BACKUP/write-data" || exit 1
cp -pR "$PPO_WRITE_DATA_DIR/." "$PPO_RIC59_BACKUP/write-data/" || exit 1
PPO_RIC59_BACKUP="$PPO_RIC59_BACKUP/write-data"
```

The private outer directory remains mode 700 even if `cp -pR` preserves a less
restrictive source-directory mode inside it. `PPO_RIC59_BACKUP` points to the
copied write-data directory inside that private wrapper.

The diagnostic requires an explicit absolute backup path. Exit 1 means blocked or
invalid, not a request to retry or repair. Exit 2 means incorrect arguments.

```bash
node deployment/scripts/diagnose-ppo-runs.mjs --write-data-dir "$PPO_RIC59_BACKUP" --run-id mbd-YnAdRpZoCjdmXKZc1mz1m9hn7RZuO9ewsKctfZ4
node deployment/scripts/diagnose-ppo-runs.mjs --write-data-dir "$PPO_RIC59_BACKUP"
node deployment/scripts/diagnose-ppo-runs.mjs --write-data-dir "$PPO_RIC59_BACKUP" --retirement-run JKjs4fO20mMh3kwO93uTHx3PMV-X--wWPSv9nedHb7U
node deployment/scripts/diagnose-ppo-runs.mjs --write-data-dir "$PPO_RIC59_BACKUP" --retirement-run kqA2X9fEomYXqKy4fZdE_6bilD8KLTGhREhjp-uwRLk
```

Share only these bounded results if needed. A more specific history failure code
identifies a failed validation condition, not intent or a proven root cause.
This work has not determined the private record's actual failed condition. Do not
infer its project/status, delete it, rehash it, or quarantine it to clear WIP.
Catalog corruption repair is a separate evidence-backed review after diagnosis.
Retirement of the other two runs must not silently clear this invalid count.

## Validation after a future approved execution

After independent review, owner approval, merge and a reviewed quiescence
integration, make a fresh private backup before each explicit retirement. Request
one new challenge for each target; no batch approval and no automatic retries.
There is deliberately no runnable retirement snippet here while quiescence is
unverifiable.

After each approved operation, use read-only inspection to verify:

- Target A is canonical-current, cancelled, version 8; target B is
  canonical-current, cancelled, version 14.
- Each prior history event, immutable version file and evidence record is
  unchanged; one cancellation event and version file were appended per run.
- The three previously cancelled KHLIM Digital runs and the invalid record are
  unchanged. Ambiguous commits or guard-release failures stop the procedure.
- `/ppo runs` is complete and has invalid count zero **only after separate,
  approved integrity reconciliation**. If it still has invalid entries, factory
  admission/continuation remains blocked. Do not invoke `/ppo factory-cycle`.
- Fixture tests demonstrate that cancelled runs cannot be resumed by the manager,
  and that unresolved catalog corruption blocks queue draining and direct factory
  continuation. There is no need to start a real cycle to validate those cases.

## Local validation commands

```bash
node deployment/scripts/run-ppo-development-quality.mjs syntax
node deployment/scripts/run-ppo-development-quality.mjs parallel-regression
node deployment/scripts/run-ppo-development-quality.mjs serial-regression
node deployment/scripts/run-ppo-development-quality.mjs critical-lifecycle
node deployment/scripts/run-ppo-development-quality.mjs integrated-acceptance
git diff --check
git diff --check origin/main...HEAD
```

The repository has no separate ESLint gate. Its syntax gate checks JavaScript,
shell syntax and policy parity. Remote/host acceptance intentionally reports
SKIP during local policy parity. Linux fixture success does not validate the
owner's Mac processes, private record, backup consistency or remote delivery.

For bounded per-event inspection of legacy runtime and orphan review recoveries
against the existing backup, see
[historical recovery diagnostics](ric-59-historical-recovery-diagnostics.md).
That assessment cannot authorize recovery or establish independent provenance.
