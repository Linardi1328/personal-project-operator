# RIC-157 — Phase 1G-B2b1: direct canonical state-machine writers

**Scope:** synthetic-only PostgreSQL integration, no production routing change or migration.

## Implementation

Phase 1G-B2a stored validated full snapshots through a fixed PostgreSQL CAS operation. Its fixtures built snapshots using temporary filesystem stores first. This slice adds an explicit isolated state-machine entrypoint to generate and persist the next record directly through the authority.

- Existing creation, transition, progress and both guarded Phase 6F review-recovery implementations share the same lifecycle rules, evidence construction, timestamps, history hashing, attempt limits and transition validation. Cancellation is the existing ordinary transition; no retirement authorization is implied.
- Only the explicit createIsolatedCanonicalRunState factory supplies the storage capability to private mutation functions. Existing exported filesystem APIs still select the original store. Caller options on those APIs cannot activate this new path. No live command, bridge, runtime profile, delivery agent or deployment is switched.
- The isolated factory requires an explicit mode and trusted read/commit methods. It captures those methods once and accepts only synthetic tasks with the existing prefix. It uses the ordinary approved project registry; PPO self-development is not enabled. The factory is trusted server infrastructure, not an authenticated client API. Its injected clock, random generator and storage methods must not be controlled by remote callers.
- Every read and generated mutation validates the full record, including history, and uses the existing file-serialization byte limit. The actual PostgreSQL adapter additionally binds every event's project/repo and Git summary fields. The database serializes version/hash CAS and prospective admission in the existing transaction domain.
- A false database result is a rejection (could be stale version, ID collision or admission), never a successful write. An exception or unexpected acknowledgment is unknown, not assumed rollback or success. No automatic retry, new ID, filesystem fallback or dual write. The error contains bounded candidate run ID/version/history hash for authoritative read-only reconciliation; it does not set stateCommitted. A transport must acknowledge the actual transaction commit. A later read may establish that candidate was committed but absence alone does not establish that an in-flight uncertain transaction cannot still commit. Production reconciliation and retry policy remain future work.

## Verification

The existing PostgreSQL CI integration gate now exercises actual state-machine calls directly on the disposable database. A deterministic synthetic filesystem oracle compares every generated record and history hash, including progress, guarded orphan recovery, guarded runtime failure recovery and cancellation. No real records are copied; separate synthetic oracle state is deleted. A temporary default filesystem directory is checked for absence of fallback writes. Independent writers observe the same prior version before submitting different transitions; exactly one may commit. Negative checks cover stale/invalid transitions, admission, non-synthetic tasks, lost acknowledgment after actual commit (including creation), and preserved exact history. Unit tests verify legacy APIs ignore injected authority options, selected methods cannot be redirected, invalid records are rejected, and unknown/false outcomes do not retry.

## Explicitly remaining

This is the first B2b implementation slice, not complete integration/cutover. Next inventory and integrate catalog/inspection/recovery orchestration and every actual writer/reader, with explicit backend ownership and no independent dual writers. Rehearse migration using synthetic version-marker histories, original bytes and hashes, invalid/recovery-required entries, and exact canonical parity; include project allowlists and unsupported encodings. Do not copy, repair, retire, or delete real PPO data. The production filesystem remains sole authority until independently reviewed migration, quiescence, backup/restore, owner approval and cutover. B2c must integrate host/claim/nonce/freshness in the same authority and actual resource-side fencing. No Mac/VPS connection or worker execution; RIC-59 and RIC-61 remain held.

Review exact-head CI, CodeRabbit/independent security review and owner merge authorization. RIC-157 remains In Progress.

## Cross-writer clock behavior

An isolated mutation chooses the later of its trusted local clock and the already validated canonical updatedAt. The same time is used for its event and evidence, including both guarded recovery operations. Equal timestamps are valid; CAS orders mutations. This is a logical history timestamp, not authoritative wall-clock freshness, lease evidence or permission to execute. The legacy filesystem path retains its original timing behavior. PostgreSQL integration exercises a second writer with an earlier clock through transition, progress and both recoveries.
