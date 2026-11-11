# PPO Phase 1C — offline durable reservation / one-claim proof

**Status: review prototype. This implementation is not a remote dispatch service, a production lease manager, a real worker execution gate, or release approval.**

## Purpose and integration boundary

The Phase 1B signed contracts (`dispatch-request` and `worker-claim`) are reused verbatim. The new `createOfflineDurableClaimLedger` persists **synthetic** coordination metadata under an operator-owned, pre-existing, canonical, owner-private local directory. The caller supplies a read-only callback for PPO's **canonical** run state and the existing Phase 1A role classifier. The module does not create/update canonical development-run records, transport work to a host, run a command, access an external service, or authorize release.

`reserve(signedRequest)` checks signature, bounded timestamps, allowlisted project, exact run version / SHA / branch and independently resolved Codex-vs-Antigravity role. It atomically creates a run-version directory. The directory is a non-reusable fence: even if the process crashes before writing all files, the same run version cannot be staged again automatically. A globally append-only index reserves request ID, nonce, approval ID and idempotency key. A durable `.pending` tombstone is created and synced before each public record. The payload is synced under a private temporary name, exclusively hard-linked to the public name, and the directory is synced after linking **and after temporary-payload cleanup while `.pending` still exists**. The successful removal of `.pending` is the final visibility step: no fallible filesystem operation follows it. The removal itself is not separately directory-synced, so a crash may restore `.pending` and permanently block an otherwise valid record; this is an explicit fail-closed availability tradeoff, not permission to replay. Readers refuse records with `.pending` still present. The reservation is usable only after `complete.json` content and its public directory entry have been synced and the pending marker has been removed. No cleanup/reissue is implemented.

`claim(runId, version, signedClaim)` verifies the persisted request signature and current PPO state, pinned synthetic worker signing key and host label, exact request digest, lease duration and expiry. It exclusively creates a global nonce marker and `claim.json`; duplicate or incomplete claims are not replaced. A crash between those two files may irreversibly consume a nonce. This is a deliberate **fail-closed availability tradeoff** in the offline proof, not transactional production durability.

`checkFence(runId, version, claimHash)` re-reads and verifies the stored signed claim, rechecks canonical PPO state and the lease clock, and returns `{current:true, releaseAuthorized:false, canExecute:false}` for matching records. **The response is diagnostic only.** No real process, filesystem, Mac or remote tool may treat it as permission to execute. In particular, this is not yet a fencing token enforced by a transactional action gateway.

## Filesystem and crash model

- The store path must exist, be absolute, canonical, non-symlinked and owner-private (mode 0700). Repository-relative names supplied by the client are never used as storage paths; on-disk names are SHA-256 digests of the validated run ID / version or replay key.
- Files are written using exclusive creation (`O_EXCL | O_NOFOLLOW`), with temporary payload files fsynced **before** atomic exclusive hard-link publication, and with durable `.pending` tombstones gating all readers. The run directory itself and the index directory are synced in the store root; file and parent-directory fsync are required before success. Reads disallow symlinks and parse only bounded regular JSON files. Corruption and incomplete writes block instead of deleting or overwriting records.
- Reservations are **append-only tombstones**. Expired claims or crashed processes do not trigger lock stealing, lease renewal, restart or retry. Reconciliation and audited operator intervention are a separate slice.
- The store is only trustworthy against accidental process crashes and competing processes following this protocol. Other processes running as the **same OS owner** can mutate/delete the files. A production multi-host protocol requires a transactional authority, durable revocation, identity isolation, monotonic fencing enforced at the action gateway, and explicit crash-recovery semantics.
- Persisting individual files, and fsyncing them, is not the same as an all-or-nothing transaction over the run directory and multiple indexes. Crashes during staging may orphan markers or reserve incomplete runs. **Never auto-delete these to regain availability.**

## In-scope checks

`node --test local-operator/software-factory-remote-durable-ledger.test.mjs`

The suite checks an ordinary signed reservation/claim, restart and re-open, two-process atomic reservation, overlapping claims, global replay indexes, forged worker identity and host, stale run version/role, lease expiry, tampering, incomplete records and symlink rejection.

## Explicit exclusions

No Mac/VPS setup or credentials; no listener, network request, Telegram command, real Codex/Antigravity dispatch or tool execution; no durable database/distributed lease, multi-host quorum, auto-expiration, retry or recovery; no live registration, revocation, audit approval, secrets handling or release. RIC-59 and RIC-61 holds remain in force. No production activation or merge is implied by a passing test suite. A later security review must address same-user tampering, durable index transactions, replay under crash/power loss and authoritative fencing before any real host integration.