# RIC-157 Batch 2A disposable resource matrix

This is a test-only evidence candidate for the merged D1 authority. M-03 is
still incomplete. It changes no authority semantics, deployment settings,
retention behavior, executable grants, or pilot approval. Batch 2D and
RIC-59/RIC-61 remain blocked; `grant`, `canExecute`, and `releaseAuthorized`
remain false. The approved operation-specific architecture is a separate
implementation dependency. Five seconds is only a candidate policy, not a
limit established or enabled by this matrix.

Run on Node 24 with the existing local `postgres:16` image:

```sh
caffeinate -i node deployment/scripts/measure-ppo-authority-matrix.mjs
# A single independent case is also supported:
node deployment/scripts/measure-ppo-authority-matrix.mjs operations
```

The only case names are `catalog20`, `history100`, `catalog2000`, `operations`,
and `retention`. The runner uses the existing image ID, without pulling,
mounting a host directory, publishing ports, selecting a Docker context, or
accepting a DSN. Every case creates a fresh network-none database. Each
container is capped at 2 GiB memory, no additional swap, two CPUs, 128 PIDs,
and 12 PostgreSQL connections. Private cidfiles and an independent operation
label identify the exact container to remove. An uncertain ownership or
cleanup outcome fails and is reported; a pre-existing named container is
never adopted. No real authority is read, pruned, reset, or migrated.

Each invocation prints a private temporary evidence directory containing
`matrix.json`, per-case JSON, stdout/stderr logs, and cidfiles. JSON is written
even on workload failure. Failures stop the matrix, preserve evidence, and
remove the owned disposable container. SIGINT/SIGTERM terminate the child
and retain evidence. The harness imposes fixed 15-second statements,
one-second lock and idle-transaction timeouts, a 20-second client-session
lifetime, and a six-minute case deadline. Timeout probes deliberately use
100 milliseconds. These are test controls, not production budgets. No
timeout is enlarged after a failure. PostgreSQL 16 has no native
`transaction_timeout`; application cancellation and connection disposal
exercise the application-owned transaction boundary instead.

The catalog fixtures execute the existing run creation, lifecycle transition,
and progress APIs in a fresh filesystem scratch directory. Every current
record has all prior normalized versions. Every accepted catalog passes the
entire existing semantic validator both before loading and after PostgreSQL
normalization. Bulk INSERT is privileged fixture loading, not authenticated
mutation throughput. The separate signed resource workload uses the existing
signatures, verifier, dedicated transaction adapter, and receipt inspector;
its apply timing includes the durable transaction path. Its payload reaches
the supported 4096-byte resource payload bound.

`catalog20` chooses a conservative complete-history depth from a real
100-version probe. It records actual transport/native bound bytes, validates
the whole catalog, and denies a real certified attempt to create run 21.
This is the largest tested accepted cohort, not a proof of an absolute
maximum over every supported payload. `history100` separately validates a
complete active 100-version run and rejects an otherwise valid next progress
operation with `RUN_HISTORY_LIMIT_REACHED` before any state write.
`catalog2000` actually generates 20 complete 100-version
histories. Every individual complete history is validated, all IDs are
unique, all runs are terminal, and native readback is compared exactly.
The native byte bound determines whether the whole catalog can pass;
oversized corpora must return `catalog_truncated`, and certified mutations
must deny. Per-run validity does not turn an oversized aggregate into a
supported valid catalog. Thus count and byte maxima are not silently
presented as simultaneously attainable.

The retention case seeds one genuine signed resource effect, then explicitly
uses privileged storage replicas. Replicas do not prove authentication or
authorization. They populate 10,000 certificates, 1000 contexts, tombstones
and operations, 1000 resource versions, and 2000 revocations. One initialized
resource has version 0 and at most 999 effects, so only 999 receipts are
populated; a claimed 1000th effect receipt would exceed the supported
single-resource history. A deferred freshness trigger is disabled only while
loading historical tombstone storage replicas, then restored. Actual public
certificate, revocation, and matching-context admission calls test exhaustion
denial against the exact same inputs that succeed in rollback-only controls
before population. Before filling the last privileged tombstone, a fresh
signed resource descriptor binds exact current version 998 and current ref.
The matrix proves its action/resource bindings are valid and its ticket is
unused, then executes the genuine signed final append to version 999.
The real signer rejects an expectedVersion-999 descriptor; a same-shape
control changing only expectedVersion to 998 signs successfully. The
supported signer/verifier ceiling therefore denies before native SQL;
native apply's version guard is not independently isolated. A separate
retained resource replay tests duplicate denial. With 1000 contexts and 1000
unique-ticket tombstones there is no unused context left, so a separately
fresh tombstone-cap test is not claimed. Nothing deletes old evidence to make
room.

Each measured SELECT has three `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)`
plans and wall timings. The first run is after fixture loading; PostgreSQL
and OS caches have not been evicted. The next two runs are warm repeats.
Security-definer function plans expose the outer function call, not all
internal statement plans; this matrix does not claim nested plan visibility.
Server settings, database size, `pg_stat_database` temp counters,
`pg_stat_wal`, WAL LSN, sampled WAL/base directory allocation, cgroup current
and kernel peak memory, OOM events, Node RSS and process peak RSS are retained.
Node peak includes fixture generation and validation, not just query work.
Peak cgroup memory includes PostgreSQL and charged page cache. The sampler
can miss short-lived disk peaks; cumulative temp/WAL counters supplement it.
Database statistics can lag, and WAL allocation is not the same measurement
as WAL generated. Docker CLI/process overhead is included in wall timings.

The accepted near-cap catalog contains one active tail. Both it and the
99-version active-history fixture execute a genuine certified positive
progress append. The history fixture thereby reaches exactly 100 versions
before testing the next progress denial. Admission preparation transport,
certificate transport, whole end-to-end progress, and the dedicated native
transaction through durable COMMIT are timed separately. The last interval
is a conservative upper bound including uncontended gate acquisition,
native validation, COMMIT and psql round trips; it excludes JS semantic
prevalidation. Total preflight/validation latency must not be compared to an
approved candidate for only the gated critical section.

The operational case observes the actual gate blocker before releasing a
revocation, checks lock and statement SQLSTATEs, cancels an application-owned
transaction, terminates an idle transaction, and verifies gate reuse after
disposal. It kills a backend after an uncommitted genuine resource effect and
requires nonce/receipt rollback parity. It injects loss of an acknowledged
COMMIT and requires exact durable receipt reconciliation, no adapter replay,
and no duplicate effect. It fills all 12 connections, requires the thirteenth
to deny, disposes them, and checks a new connection succeeds. Revocation
timing is a measured synthetic gate delay, not a global worst-case bound.

## Retention and admission policy candidate

The existing laboratory ceilings are hard refusal boundaries, not an
approved production lifetime policy. A deployment must reserve capacity
before accepting a new operation, deny when authority, certificate, history,
nonce, receipt, or resource-version capacity is exhausted, and preserve
durable history until an independently approved archival/retention process
can preserve reconciliation and anti-replay guarantees. There is no
automatic deletion, ceiling increase, or retirement endpoint here. Run 21
cannot become an unnoticed production lifetime failure: deployment and pilot
admission remain blocked pending an approved lifetime/capacity design.

A concrete operating policy still requires owner-approved memory, storage,
concurrency, maximum operation duration, cancellation and recovery limits,
clock uncertainty, load envelope, and retention procedure. This matrix does
not select them from one machine's measurements. A fresh protected operation
must still pass final freshness **after durable journal reservation**, and an
unaccepted expired operation may never make its first effect via recovery.
The synthetic PostgreSQL receipt model is not filesystem/Git enforcement.

## Preserved development failures

All failures below were harness bugs and remain on disk. No assertion was
removed, test skipped, or timeout widened:

| Evidence suffix | Failure | Correction |
| --- | --- | --- |
| `ppo-budget-matrix-1UEyVk` | PostgreSQL rejects expression-valued `SET application_name` | Use `set_config`, as in the existing transport |
| `ppo-budget-matrix-hTx6JU` | Progress is not allowed during planning | Execute the complete lifecycle through implementation before progress |
| `ppo-budget-matrix-DWcihz` | Missing SQL terminator let psql emit the marker before EXPLAIN | Terminate the EXPLAIN statement |
| `ppo-budget-matrix-8HUkJm` | Ordinary administrator cannot SELECT the private revocation table in a rollback control | Assert successful public revocation completion; retain private-table denial |
| `ppo-budget-matrix-uFXNX6` | The real signer intentionally rejects expectedVersion 999 before SQL | Prove the supported 998→999 signed append, then isolate the signer ceiling with a same-shape control |

The third run already validated a 20-run, 1180-version cohort (59 versions
each): native bound 31,621,040 bytes, transport 31,580,124 bytes, Node peak
902,480 KiB. Its later EXPLAIN failure means it is partial evidence only.
Complete exact-head results and remaining coverage gaps must accompany this
candidate before treating any row as verified.
