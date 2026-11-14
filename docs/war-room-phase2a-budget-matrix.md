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
Connections use the existing privileged psql transport and then `SET ROLE`;
the 12-backend server ceiling does not establish capacity for 12 ordinary
authenticated service logins or account for their reserved-slot constraints.
Node's old-space limit is 2048 MiB; it is not a hard bound on total Node RSS.

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
This partial run is superseded by the complete measured run below.

## Exact implementation evidence

All five independent cases passed on implementation head
`e0c9129493297c9a5d9e007f497ef451a176ac75`, from
`2026-11-14T08:05:51Z` to `08:11:47Z`. Node was `v24.20.0`; PostgreSQL was
`16.14 (Debian 16.14-1.pgdg13+1)`, arm64, local image ID
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`.
All five workloads exited zero; all cgroups reported zero OOM/kill events,
and all containers were removed by exact owned ID.

An exact repository-reviewable copy is retained as
[raw matrix evidence](evidence/ric-157-phase2a-budget-matrix.json), including
all five per-case JSON objects. Original files remain in
`/var/folders/4x/g6s09jds5hq19dzprk3pvy780000gn/T/ppo-budget-matrix-kzMCSo`.
The `matrix.json` SHA-256 is
`c22c97f3e8bf16a5c51d911456d05fb52284d6ba4a855e92561eb01fcecd5c05`.
It embeds all per-case evidence, sampling, settings, plans, failure status,
cleanup, and these measured source hashes:

| Source | SHA-256 |
| --- | --- |
| `measure-ppo-authority-matrix.mjs` | `1763d20bd8cfd6fdea9c97a0227a2db39691916031f2c1fa31e497cae75f0470` |
| `phase2a-budget-matrix.mjs` | `b57913d0da13fa54748d0eb385868cd319ba4c10a5b211829c4e33a85026b34e` |

| Case | Observed result | Node peak KiB | PG cgroup peak bytes | Temp-counter increase bytes |
| --- | --- | ---: | ---: | ---: |
| catalog20 | 20 runs, 1180 versions valid; genuine append reaches 1181 | 1,106,496 | 801,013,760 | 1,685,955,631 |
| history100 | active 99→100 versions commits; next progress denies | 415,616 | 188,006,400 | 17,433,748 |
| catalog2000 | complete individual histories/native parity; aggregate byte-denied | 737,008 | 185,044,992 | 13,270,062 |
| operations | contention, recovery, cancellation and connection checks pass | 83,392 | 125,091,840 | 0 |
| retention | all stated storage counts, same-input controls and exhaustion checks pass | 83,760 | 119,656,448 | 0 cumulative |

The accepted 1180-version catalog measured 31,621,104 native bound bytes and
31,580,188 transport bytes. A 21st run projects to 31,625,116 native bytes,
below the byte cap, and introduces only a second active project: its refusal
isolates the run-count ceiling. The actual 2000-version corpus measures
87,567,180 native bound bytes and returns only a 61-byte truncated envelope;
its denied mutation does not isolate the count ceiling. These measurements
describe this corpus, not a mathematical minimum over every valid history.

The near-cap catalog's three native EXPLAIN execution times were
515.972 / 604.938 / 530.092 ms (first-after-load / warm / warm); corresponding
Docker/psql wall times were 588.529 / 684.157 / 597.097 ms. Complete semantic
validation wall times were 6.435 / 8.166 / 8.734 seconds. The genuine positive
append measured admission preparation transport 12.335 seconds, certificate
transport 101.129 ms, the dedicated native transaction through durable COMMIT
2.875 seconds, and whole state-API operation 23.027 seconds. Those are
different intervals. The 2.875-second uncontended observation does not prove
a five-second worst-case critical-section budget. The JSON metadata field
`limits.applicationMs:20000` names the 20-second **individual client-session
lifetime**, not a whole multi-session operation deadline; the explicit
application-cancellation test uses 100 ms. No overall 20-second progress
completion guarantee is claimed.

Near-cap post-load workload WAL increased by 103,968 bytes; its fresh-case
cumulative `pg_stat_wal.wal_bytes` reached 15,618,993. Retention cumulative
WAL reached 20,796,029 bytes. Allocated WAL at the last samples was 16,392 KiB
for catalog20 and 32,776 KiB for retention. The valid catalog's filesystem
fixture ended at 28,240 KiB allocated, with 26,389,724 live logical bytes and
51,107,184 logical record bytes written cumulatively. Atomic-write transient
disk peaks are not captured by that end-of-generation allocation.

Observed revocation gate wait was 69.134 ms under one deliberately held
gate. Signed resource registration measured 74.332 ms; the dedicated signed
apply with injected lost acknowledgment measured 20.854 ms and reconciled
one durable effect. At retention, signed final-version registration measured
74.778 ms and actual 998→999 native apply 91.573 ms. Native retained receipt
reads measured 0.865 / 1.010 / 0.901 ms, and context reads 1.976 / 1.658 /
2.209 ms. These are limited synthetic observations, not percentile or tail
latency guarantees.

Retention ended at 10,000 certificates; 1000 contexts, tombstones,
operations, and resource versions; 999 receipts; and 2000 revocations. Both
signed effects used 4096-byte payloads. Storage replicas used repetitive
payloads: maximum field length and count coverage does not establish
incompressible distinct-payload disk/WAL worst cases. The matrix also does
not establish simultaneous unused-context/tombstone maxima, isolate the
native expectedVersion-999 guard, expose every nested SQL plan, or measure
all possible shared-gate queue disciplines. Timeout and cancellation denial
checks passed; the helper records timings only for successful measured
calls, so failed timeout probes have passing SQLSTATE checks rather than
elapsed-time samples. These gaps keep full M-03 open.

## Local standard gates and preserved environment failures

All seven standard gates have successful local results against implementation
head `e0c9129493297c9a5d9e007f497ef451a176ac75`. The evidence follow-up changes
only this document and the exact raw JSON copy; measured executable sources
remain unchanged. Hosted CI is separate and must run on the published head.

| Gate | Successful local result | Environment |
| --- | --- | --- |
| syntax | exit 0, 12.439 s | original Node 24.20.0 |
| PostgreSQL canonical | 66 pass, 0 fail/skip/cancel, 381.734 s | disposable network-none PG 16.14 |
| parallel regression | exit 0, 109.948 s | original Node 24.20.0, child-only `TMPDIR=/private/tmp` |
| serial regression | exit 0, 325.639 s | official task-local Node 24.20.0, child-only `TMPDIR=/private/tmp` |
| critical lifecycle | exit 0, 221.654 s | original Node 24.20.0 |
| integrated acceptance | exit 0, 231.360 s | original Node 24.20.0 |
| whitespace | exit 0 | base-to-head and final working diff checks |

The first parallel/serial runs each failed two existing tests:
`requires private backup permissions and explicit bounded requests` and
`canonical private executable candidate is accepted`. macOS supplied
`/var/folders/.../T`, whose realpath is `/private/var/folders/.../T` and whose
mode is 0700. One fixture requires a canonical executable path; the other
requires a nonprivate parent so chmod 0755 actually removes the private
backup guarantee. Using canonical public `/private/tmp` (1777) only for the
child test environment resolved both assumptions; a focused 69-test run
passed first. No source, assertion, file permission policy, or timeout was
changed. Initial failures remain in
`/tmp/ric157-matrix-gate-parallel-regression.log` and
`/tmp/ric157-matrix-gate-serial-regression.log`.

During the canonical-temp serial rerun, an external Homebrew runtime upgrade
removed the original Node 24.20.0 path. Many subsequent test workers failed
to start. That failure remains in
`/tmp/ric157-matrix-canonical-temp-serial-regression.log`; a subsequent direct
launch returned exit 127, retained in `/tmp/ric157-matrix-homebrew-drift.log`.
The final full serial gate passed using the task-local official runtime at
`/private/tmp/ric157-node-runtime/node-v24.20.0-darwin-arm64/bin/node`.
The official archive SHA-256
`40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8`
matches the downloaded Node SHASUMS manifest; the executable SHA-256 is
`9d050fd455b56426e25d4d603c7c501cbb2630348e836cf221dcce748e90588a`.
No system libraries or global installations were modified for recovery.
Runtime drift occurred after all matrix measurements had finished.

Successful gate summaries remain in `/tmp/ric157-matrix-gates.json`,
`/tmp/ric157-matrix-gates-canonical-temp.json`, and
`/tmp/ric157-matrix-official-serial.json`; the latter also records the pinned
runtime path and hash. Failed attempts remain visible alongside successful
reruns. These are local checks, not a claim of hosted CI completion.


## Post-measurement runner corrections

CodeRabbit reviewed exact `4788cfb1157a3394eaaa65f9ed957494bd683c2d`
and found two valid lifecycle defects. A startup signal could set `stopping`
while no child existed, then still allow a scenario launch. The readiness
probe could also accept the official image's temporary socket-only server.
The corrected runner checks interruption during readiness, immediately
before scenario spawn and before success, retaining failing status and
exact owned-container cleanup. Readiness now uses authenticated TCP to
container loopback; it preserves the bounded startup retries. The workload
has no mutation retry or deadline change.

Three fake-Docker lifecycle regressions reproduce both startup-signal
windows and a temporary socket server that is ready before the final TCP
server. All three failed against the old runner and pass after correction.
They assert no scenario launch after interruption, failing status, exact
owned-ID cleanup, authenticated TCP selection and a failed first final-server
probe followed by success. The deliberately failing fake workload is not
PostgreSQL or measurement evidence. The first fixture construction attempt
had a generated JavaScript newline error; its output is separately retained
rather than counted as the intended RED reproduction.

The original five-case raw artifact and source hashes above remain unchanged.
These runner-only corrections postdate those measurements; they do not
remeasure or relabel them. Focused lifecycle tests and a fresh disposable
real `operations` case validate the corrected runner separately; exact-head
results are recorded in the PR. New full seven-gate CI is required for the
corrected head. No capacity, workload, authority, payload, timeout or grant
semantics changed.
