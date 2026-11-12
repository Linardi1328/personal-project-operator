# RIC-157 — Phase 1G-B1: durable transaction laboratory

**Scope:** isolated single-host SQLite experiment, not the final shared authority, a production migration, or a live authorization service. This is a new implementation slice after the merged 1G-A contract and trusted Mac enrollment design.

## Why this slice exists

PPO's current development-run-state.mjs is file-authoritative: commitRecord writes an exclusive durable version marker first, then writes the canonical JSON record. readDevelopmentRunInternal may repair JSON from the newest authoritative marker. Creation, transition, progress and recovery can all write through these primitives. development-run-catalog.mjs inspects the separate filesystem records and history. A database transaction that locks only a nonce table while reading that live file store would have a check/use race. Neither a mirrored run row nor a process-local lock fixes it.

This laboratory uses only fresh synthetic run records generated using PPO's existing state-machine APIs in a disposable scratch directory; that scratch directory is deleted before the database is populated. The laboratory database is the **sole** authority for those synthetic records, never a second writable copy of real PPO state. It validates full records including history with parseDevelopmentRunRecord, derives WIP membership using the current admission policy, and rejects duplicate active runs per project, corrupt or incomplete catalog state and more than two active projects. This is not yet full production catalog/recovery validation.

## Implemented experiment

- Node's built-in SQLite (Node 22.13+ with node:sqlite and SQLite subsecond clock support; POSIX only). No external packages, service, credentials, migration of real data or new production process.
- Fresh private temporary directory and database, random lab marker, version/application ID check, explicit reopen; no environment-selected or caller-provided production database path. The trusted local fixture writer exists only in the test file. Lab host IDs are prefixed lab- and run records must have a synthetic task label. This is accidental-use isolation, not protection against a malicious local administrator or arbitrary code with access to the test database.
- Separate tables for synthetic host, claim, request, full run records and consumed action IDs. STRICT tables, matching record keys, unique (host_id, action_id) and immutable nonce triggers. Host project/capability allowlists are checked independently of request scope.
- BEGIN IMMEDIATE serializes writers to the same local SQLite database; WAL, synchronous=FULL, no automatic retry on contention. The 1G-A adapter runs within this actual transaction. The final insert uses SQLite's current subsecond clock in its predicate and a unique constraint; JavaScript does not manufacture a successful insert.
- Check freshness before commit and again after acknowledged COMMIT. If expiry passes before commit, roll back. If commit succeeds but acknowledgment is late/ambiguous, **deny the grant and retain the tombstone**. It is unsafe to promise rollback after an acknowledged or uncertain commit. Observed clock regression denies; this is not proof of clock monotonicity across processes or hosts. A read of the clock after commit is conservative under a trusted non-regressing clock, not a magical atomic wall-clock commit guarantee.
- No filesystem/Git action gateway, dispatch, production route, enrollment or agent launch. The callback returns only the existing offline diagnostic success; Phase 1F still denies execution and release. No live callers are wired to this lab.

## Verification

Run `node --test local-operator/software-factory-remote-sqlite-fence-lab.test.mjs` on supported Node. Full regression CI discovers the new test. Tests use real database files and separate Node processes: uniqueness after reopening, competing consumption, writer exclusion, SIGKILL before commit with rollback/recovery, lost response after real commit and replay denial, revocation and changed run version, host-policy denial, invalid/incomplete catalog and WIP overflow, real clock expiry before commit, and rejected non-lab paths/tokens.

This establishes only the tested single-host behavior. A subprocess kill is not a power-loss, filesystem-corruption, backup/restore or distributed-partition test. The test uses trusted synthetic row writers; no production database roles, tenant policy, monotonic host-lifecycle service or full signed-envelope integration are implemented.

## Next integration gate (Phase 1G-B2)

1. Inventory every canonical store writer and reader, including creation, version markers, transition/progress/recovery, catalog, admission, cancellations, dispatch/recovery/remote delivery and maintenance. Use a storage boundary that preserves full record/history validation and existing CAS/append-only semantics.
2. Select a **server-owned, shared** transactional authority with independent credentials/permissions, schema migrations and server-side authorization. Move canonical run/history, host/claim/request, catalog/admission and nonce authority into one reviewed transaction domain (or prove an equivalent fencing protocol). SQLite WAL on a network share is not this architecture. The lab is not a backend selection.
3. Prove migration on synthetic snapshots: immutable provenance, exact run/history/hash/version parity, no invalid records lost or invented, explicit ownership handoff, and no remaining writer to the former canonical store. Never dual-write independent authorities. No live migration without separate owner approval, verified quiescence, backup/restore and rollback evidence. In particular RIC-59 and RIC-61 remain holds.
4. Prove authoritative current-time and commit/ack expiry semantics, serialized revocation and host policy, durable nonce uniqueness, fail-closed partitions, crash/restart and ambiguous outcomes with independent clients. Prove database privileges and server-only mutations; connect Phase 1F to the real authority only after these gates. Actual filesystem/Git/other mutations must independently honor revocation and fencing at their linearization points. Disable unsupported action types.
5. Only later implement reviewed enrollment and a separately approved controlled Mac pilot. No production execution is authorized by merging this slice.

Review gates: exact-head CI, CodeRabbit or documented independent review substitution, owner approval and squash merge. RIC-157 stays open until the real shared authority integration is delivered. No change to RIC-59/RIC-61.
