# RIC-157 — Phase 1G-A: offline transactional fencing contract

## Scope and non-goals

This slice introduces an **explicit transaction contract** for the Phase 1F \`consumeActionFence\` callback. It uses the exact previously authenticated Phase 1F bound action context and demands a serializable final check of *every* mutable authority before the same transaction atomically consumes the single-use action ID.

**This is NOT a database implementation and does not establish multi-host durability.** The tests use an in-memory serialized fake transaction and synthetic keys. The callback supplied to \`createOfflineTransactionFenceAdapter({mode:"offline-transaction-contract-only",transact})\` is trusted test infrastructure, not a verified live database. There is no network, Mac/VPS, key enrollment, agent launch, PPO canonical run mutation, GitHub write, production deployment or operational route.

## Transactional boundary contract

The future driver must expose one **durable, linearizable** \`transact(async tx => {...})\` that locks/serializes all the following rows or equivalent authoritative records *through commit*:

1. Pinned host ID, signing-key fingerprint, active status, strictly monotonic epoch and exact host-epoch-to-claim hash.
2. Authenticated worker claim record: status claimed, exact claim/request digests, run ID/version, worker/host binding, and claim/lease issued and expiresAt (evaluated using the server/database time in the same transaction).
3. Exact reviewed coordinator request: request hash, run/version/project/role, branch/base/head Git SHAs, unexpired request, allowed permit set and path prefixes.
4. PPO **canonical** run and expected version/current Git refs. There must not be a second independently writable run source-of-truth. If the current file-backed PPO run cannot participate in the same authoritative CAS/fencing protocol, the operation must **BLOCK** until that boundary is rearchitected.
5. Full valid catalog admission including zero invalid historical entries, active project lane set with at most two unique projects, **including the exact target project** at the action boundary (the project must not have lost its active lane).
6. Single-use \`(hostId, actionId)\` uniqueness/reservation, tied to the exact request/claim/run/epoch, written in that same commit. Retain nonce tombstones across crashes and never accept stale host epochs or claim reuse.

**Freshness is part of the final transaction contract (151-A).** Boundary timestamps `issuedAt`, `expiresAt`, and `requestExpiresAt` must be canonical ISO-8601 strings (151-B); mutable Date instances or wrappers are rejected before invoking the driver. The adapter first checks the trusted clock, then checks it again after its locked authority reads. The mandatory `tryConsumeFreshOnce` driver operation receives immutable scalar proof/request/claim deadlines and not-before bounds. It MUST enforce those limits using authoritative current time in the same nonce-CAS/commit boundary, including time spent waiting for the insert or commit; a transaction-start timestamp, a second JavaScript read, or a separately timed INSERT alone is insufficient. If a backend cannot make the required freshness guarantee through the acknowledged grant's linearization point, it must deny. A failed/expired transaction must not acknowledge a nonce grant. Real database semantics, rollback, and clock behavior must be demonstrated in Phase 1G-B, not inferred from these mock tests. Every later side effect must independently honor its current fence and expiry.

The driver must invoke and await the authority callback exactly once per adapter invocation; an acknowledgment without successful callback completion, a swallowed validation failure or an attempted repeated callback must be rejected. Any retry requires a new reviewed call, not an implicit driver retry; ambiguous committed nonces remain non-reusable. Only a fully acknowledged commit returns exact \`true\` to Phase 1F; any false, unavailability, partial or ambiguous outcome denies. Do not blindly retry after an unknown commit. The modeled callback itself never grants permission to execute: Phase 1F still always returns \`canExecute:false, releaseAuthorized:false\`.

A transaction implemented by a regular callback, one local lock, a temporary directory, an OS process snapshot or a check-then-insert on separate stores does **not** meet this contract. A real DB adapter must use database-enforced constraints, transaction isolation/row locking, authenticated tenant/actor roles, audit records, verified backup/restore and crash/partition tests. Cross-service action writers must honor the fencing state at **every actual write/side-effect boundary**, not just at claim time.

## Tests

    node --test local-operator/software-factory-remote-transaction-fence.test.mjs

Adversarial fixtures cover duplicate/concurrent nonce consumption, a recreated adapter reading the same in-memory mock state (NOT disk restart), revoked host/key/epoch, claim expiry, wrong SHA/run version, invalid catalog/WIP, wrong permit and path, Date millisecond precision for trusted clocks, rejection of mutable external timestamp values, expiry during authority reads/conditional consume/commit, malicious getters, unavailable transactions and lost COMMIT acknowledgment. The single-process fake does **not** prove storage durability, distributed locking, crash recovery, Mac trust or production security.

## Next Phase 1G-B acceptance (not delivered here)

- Choose and independently review a shared transactional authority and *how* PPO canonical run mutation, catalog admission and all dispatch/write gateways integrate with its CAS/epoch. Avoid shadow canonical state.
- Implement and test real migrations, row-level permissions, server-only transaction function, fixed privileges, monotonic epoch and nonce uniqueness, journal/audit and revoke/rotation under concurrent writers. Prove the final authoritative expiry condition under lock/commit delays. Recheck host-specific project and capability grants against the approved enrollment policy and enforce live Git-ref CAS (or equivalent side-effect validation); neither is established by matching stored request/run SHAs alone.
- Use isolated test infrastructure to prove crash/restart/partition and ambiguous commit behavior with a second competing worker, stale Mac session, outdated Git refs, key compromise, unmatched workspace, and remote delivery.
- Recheck the action fence at the side-effect boundary; no generic terminal/command runner or skip-permissions execution.
- Only after distinct host security and owner maintenance approval consider an outbound-only Mac pilot. Keep RIC-59 and RIC-61 retirement/invalid catalog work separate.

PR quality gates: full GitHub CI, CodeRabbit findings, exact-head verification and owner-authorized squash merge. Source merge is never deployment.
