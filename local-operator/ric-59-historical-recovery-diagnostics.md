# RIC-59 historical review recovery diagnostics

This is a read-only assessment, not a recovery, historical compatibility rule,
retirement authorization or proof that an earlier recovery was justified. Live
recovery and ordinary history validation are unchanged.

## Owner command (existing private backup only)

Use a separate checkout of this PR. Keep the existing backup offline and private;
never upload the backup, its records, logs or evidence. The backup must have been
copied during a quiet window as described in `ric-59-owner-runbook.md`. The tool
cannot establish that a directory is actually a backup or that its creation was
consistent. Do not point it at the live PPO store.

With `PPO_RIC59_BACKUP` already set to the absolute copied write-data directory:

```bash
: "${PPO_RIC59_BACKUP:?Set this to the existing absolute private backup}"
node deployment/scripts/diagnose-ppo-historical-recovery.mjs \
  --backup-dir "$PPO_RIC59_BACKUP" \
  --run-id mbd-YnAdRpZoCjdmXKZc1mz1m9hn7RZuO9ewsKctfZ4 --events 14,17,20
```

The script rejects relative paths, symlinked ancestors/files, and a backup whose
root or immediate enclosing wrapper is not owned by the current user with no
access for group/others. This supports the existing private mode-700 outer
backup wrapper even when `cp -pR` preserves source permissions on `write-data`.
On macOS use the physical path (a symlink such as `/var` is deliberately refused).
No permissions or contents are changed. Exit 0 means assessment completed, **not**
valid history. Exit 1 means unavailable/unsafe observation; exit 2 means invalid
CLI arguments. Output contains only fixed codes, event indices, booleans and
explicit unknown/not-assessed/unverified states. It is safe to share that output.

## Interpretation

Each candidate is evaluated using only evidence and counters reconstructed from
its preceding prefix. Structural integrity, hashes, ordering, timestamps, stage,
project/repository and attempt counters must validate before reconstruction can
advance. A structurally intact but policy-rejected transition marks subsequent
prefixes as unresolved; bounded local assessment continues without accepting it.
Structural corruption stops reconstruction rather than trusting supplied counters.
Final aggregated evidence never establishes an earlier event's eligibility.

- `localRecoveryContractMatches`: a matching current state-level recovery
  contract, or a strictly matching legacy runtime-failure shape. Orphan candidates
  also require a recorded age of at least 60 seconds. This is not authorization.
- `legacyRuntimeShapeMatches`: exact runtime-recovery envelope, preceding
  SHA/attempt/owner-action binding, absent classification field, zero counts,
  matching empty findings and their content hash, and the hash of the historical
  fixed failure summary. Present but invalid classification is never legacy.
- Orphan candidates use the exact orphan envelope, latest unfinished/ambiguous
  attempt, SHA/attempt binding and recorded age. Runtime-summary/findings checks
  are `not_assessed` for orphan recovery, not implicitly passed.
- `precedingImplementationEvidenceMatches` and `precedingTestPassEvidenceMatches`
  report the current review reconciler's evidence checks on the prefix. They do
  not establish historical workspace cleanliness or operational execution.
- `historicalReplayValid` remains governed by current rules and required marker
  agreement. Later candidates cannot be replay-valid across event 14 if that
  transition fails. A local match does not override this result.
- `immutableVersionMarkersAgree` compares every required version from zero through
  the event with the canonical history prefix and each marker's own derived
  summary. Whole-record agreement requires all versions and canonical/latest
  agreement. Missing/malformed/conflicting markers fail this check.
- `independentProvenance` is always `unverified`. Historical worker quiescence,
  workspace reconciliation and owner confirmation are always `unknown`. No CLI
  flag, metadata object or caller assertion can turn these into proof.

Up to 10 distinct event indices (1–99), 100 version-directory entries and 128 KiB
per record are inspected. Unexpected directory entries (including leftover temp
files) fail closed. Every observed marker and canonical file is rechecked, along
with directory identity and ancestor path safety, before returning assessments.
An offline backup is still required: these checks are not a lock against writers.

## Evidence required before any compatibility proposal

For **each** event, independently retained deployment/build records must identify
the actual PPO revision. Contemporaneous recovery/worker/workspace audit records
or a separately retained pre-upgrade backup must corroborate the exact run,
review attempt, failure or orphan condition, and confirmed recovery. For orphan
recoveries, absence of active workers and workspace reconciliation at the time
cannot be inferred from this history. Hashes and actor strings are not signatures;
old-validator acceptance and the fixed summary hash alone are insufficient.

PR #48 (`f11f32a`, 25 August 2026) supported unclassified runtime retries. Commit
`ac13718` (5 September 2026) required `runtimeFailureClass` for new recovery and
historical replay without changing schema version 1. Commit dates do not prove
owner deployment dates. Missing classification is consistent with older records,
not proof of provenance or of a genuine runtime failure.

Any compatibility or reconciliation proposal requires separate review and owner
approval. This diagnostic adds no exception and never starts workers, probes live
processes, invokes workspace commands, repairs history or performs retirement.
