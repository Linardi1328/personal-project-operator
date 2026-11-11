# RIC-150 — PPO × War Room Phase 1E offline staging proof

## Purpose and call boundary

This slice composes the merged Phase 1D signed issue-to-run preflight with the merged Phase 1C durable single-reservation ledger. The only entrypoint is the standalone Node module function stageOfflineAssignment(signed, config). The required mode is **offline-staging-proof-only**; the two nested configurations must use the exact existing **offline-preflight-only** and **offline-durable-proof-only** modes.

The module is deliberately **not wired to /ppo issue, /ppo assign, Telegram, OpenClaw, a Mac/VPS worker, Linear's live API, PPO factory cycles or any canonical run transition**. Tests use temporary private local directories and generated Ed25519 keys. A passing diagnostic never means a real agent may act.

## Sequence

1. Reject wrong mode or contradictory injected authorities: preflight and ledger must share the same coordinator signing public-key object, clock function, canonical PPO readRun and resolveRole functions, and approved-project allowlist reference. All other injected callbacks and local paths remain trusted synthetic fixtures; the module does not prove their authenticity.
2. Verify and freeze an independent snapshot of the coordinator-signed dispatch before any asynchronous reads, preventing caller mutation from swapping the payload during preflight/reservation.
3. Run Phase 1D preflight **before any filesystem write**, checking current canonical run/version/SHA, raw Linear issue revision, independently mapped project, owner approval, reviewed isolated repository observation, catalog admission, role and two-project WIP policy.
4. Run the actual Phase 1C append-only ledger reserve (not a fake reservation callback). This stores only the versioned signed request and replay tombstones in the explicitly configured private test directory.
5. Repeat the full preflight **after** reservation. If the issue, run, role, owner approval, repository, catalog or WIP snapshot changed, reject without claiming success. Crucially, leave the reservation directory and replay indexes as non-reusable tombstones; never clean up, reclaim, auto-retry or infer permission from a partial result.
6. Re-inspect the durable reservation against its exact request digest and current canonical run. Only then return a frozen minimal diagnostic: outcome staged-offline, request ID/hash, run ID/version, issue revision hash, and **canExecute:false, releaseAuthorized:false**.

## Security and consistency limitations

- The preflight's issue/approval/catalog/WIP reads and the ledger's filesystem reservation are **not one atomic transaction**. A change after the last preflight can still occur. Do not use this result as a real assignment acceptance, WIP admission, claim authorization, production dispatch, or tool-execution fence.
- The ledger itself is a **single-host, crash-conscious offline proof** with permanent replay tombstones and no multi-host transactional identity authority. A crash after reserve but before final preflight can permanently consume a run version. Failed post-checks deliberately trade availability for safety. A trusted recovery/owner challenge protocol must be separately reviewed before any operational use.
- There is no real authenticated owner challenge, signature revocation, live Linear read proof, trusted Mac/VPS registry, permission sandbox, agent command, host identity, atomic PPO state transition, signed evidence, lease-enforced action gateway, or production credential configured here.
- Repo/sandbox assertions in Phase 1D are injected trusted observations; this slice does not inspect local paths or establish durable write-action safety.
- RIC-59 invalid historical catalog and RIC-61 two-host quiescence holds remain blocking. No owner Mac service, VPS process, legacy run, production event, agent session or factory cycle is touched.

## Validation and merge

Run the dedicated test with:

    node --test local-operator/war-room-offline-staging.test.mjs

GitHub PR validation must pass syntax, parallel and serial regression, critical lifecycle, integrated Phase 6Q acceptance, and whitespace. Apply actionable CodeRabbit review findings, revalidate on the final commit, and follow the agreed owner-approved squash-merge process. A successful source merge **does not** authorize activation or deployment.

Related merged foundations: RIC-141 Phase 1B signed contracts, RIC-144 Phase 1C durable ledger, RIC-146 Phase 1D preflight, and RIC-145 read-only Linear issue preview.
