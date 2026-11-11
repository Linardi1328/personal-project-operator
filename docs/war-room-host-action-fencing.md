# RIC-153 — Phase 1F: pinned host identity and action-fencing proof

**Status: offline security prototype only. No live host connection, no execution, no release authority.**

This is a narrow prerequisite to PPO × War Room Milestone B. It **does not** complete production host enrollment, network trust, cross-host action fencing, or RIC-61's historical-run retirement quiescence work.

## Security boundary

The new \`verifyOfflineHostActionFence(signedRequest, signedHostProof, config)\` checks one **simulated** action-boundary request without running an action. The only return for a successful verification is a frozen diagnostic containing \`fenceObserved: true\`, \`canExecute: false\` and \`releaseAuthorized: false\`.

All keys are generated in unit tests. The harness neither installs a key nor contacts a Mac, VPS, Telegram, GitHub, Linear or a remote agent. The separate \`signOfflineHostActionProof\` helper is for synthetic fixtures; it is **not** a production key agent or enrollment API.

### Identity and fencing checks

1. Verify the exact Phase 1B Ed25519 coordinator-signed \`dispatch-request\` with a separately supplied pinned coordinator public key. Refuse other request kinds.
2. Require an exact field set in a domain-separated **host-signed** action proof. Fields: version, host ID, host epoch, worker ID, signed request digest, signed claim digest, PPO run ID/version, action nonce, action type, scoped repository-relative path, issued time and expiry. The synthetic host key is distinct from both coordinator and worker keys.
3. Use an independently trusted \`readHost\` callback. Require active host state, exact pinned Ed25519 public key, matching worker, matching **current epoch**, and valid host signature. The trusted host registry must separately bind that epoch to the **exact authorized claim hash**; rotating the key/epoch alone cannot inherit an older claim. Explicit re-pinning in tests models a trusted administrative decision, not automatic real-world recovery. A client-supplied host ID/epoch alone is never trust.
4. Check request-scoped permits and paths; fail closed on unknown actions, traversal, wrong host/worker/digest, future or expired proofs. Proof TTL is at most 60 seconds, and its bounds must stay within the coordinator request expiry.
5. Require trusted admission to report a complete zero-invalid-record catalog snapshot and a valid ≤2-project WIP snapshot. This is a synthetic callback **not yet wired to real PPO catalog normalization**; \`RIC-59\` remains a blocking operational hold.
6. Reuse the *real merged Phase 1C offline ledger*, rather than faking its success. \`checkFence\` verifies the signed persisted worker claim, pinned worker key/host label, unexpired lease, exact run version and canonical PPO run/SHA. \`inspect\` confirms the signed request digest.
7. Require a trusted \`consumeActionFence\` callback returning exactly \`true\`. Its contract is an **atomic compare-and-consume** operation that rechecks current host epoch/key/status, exact epoch-to-claim binding, **fresh signed worker-claim lease**, current PPO run/version/base and head SHAs, request/proof expiry, and **current catalog/WIP admission** in the same linearizable transaction as consuming the action ID. The verifier passes exact immutable request/run/SHA and admission parameters into that callback; these are only claims until a real independently trusted authority enforces them. A failed, missing, unreachable or ambiguous callback fails closed. The tests simulate this using one synchronous in-memory state transition and deliberately inject lease expiry, catalog invalidation and stale run versions at the final consume boundary. **The tests cannot prove the callback contract is truly atomic on a real distributed system**. This module does not provide the durable atomic backend.

This is **not an executable authorization**. The verifier has no tool-launch, filesystem-write, network or action callback; passing one diagnostic does not allow an agent to act.

## Threats tested

Synthetic integration tests create a mode-0700 temporary directory, coordinator/worker/host Ed25519 keys, one signed dispatch request, one persisted durable worker claim and a separately signed host-action proof. Tests cover active host, forged host signature, key rotation/revocation, unknown and unreachable hosts, stale epoch, duplicate and concurrent action IDs, revocation during the consume boundary, wrong worker/run/request/claim, expired proof/lease, stale PPO run, inappropriate action/path, global invalid catalog and WIP denial, missing or failing atomic consume, and forged coordinator request.

Run:

    node --test local-operator/software-factory-remote-host-fence.test.mjs

Required PR validation: syntax, parallel regression, serial regression, critical Phase 6 lifecycle, Phase 6Q integrated acceptance and diff whitespace. Resolve CodeRabbit findings before merging the reviewed source. Do not claim an unavailable re-review passed.

## What must exist before real execution

- A real host-enrollment protocol with operator confirmation, key custody, rotation/revocation, authenticated device-to-service channel, reproducible trusted host/repository/workspace identity, host clock tolerance and auditable identity lifecycle.
- A *durable transactional fencing authority* shared by coordinator, Mac worker and every action writer. It must maintain monotonic epochs and atomic nonce consumption through crashes/restarts, support fencing of in-flight processes, and recheck grant/status at the **actual action/write boundary** (not just before executing an untrusted tool).
- Real action gateways enforcing run/version/SHA, permit/path scope and lease validity **for every filesystem, network, GitHub/PR, state or agent effect**. No untracked direct CLI, OpenClaw, child process or Mac/VPS write path may bypass the fence. A bare signed attestation, PID check, OS lock, \`checkFence\` diagnostic or one-off preflight is insufficient.
- Prove failure semantics for cross-host partitions, stale processes, dropped acknowledgements, host outages, abrupt restart, key compromise, ambiguous writes and half-acquired guards. Add negative integration tests on isolated approved infrastructure before any activation.
- Separately close RIC-59 invalid historical catalog/admission and RIC-61 Mac/VPS retirement quiescence holds. This action-proof module neither authorizes retirement nor enables factory cycles.

**No production keys, service changes, remote connections, deployments, host registration, factory restarts, automated merges, cancellations or operational retirement are part of this PR.**

Related: RIC-137 Milestone B, RIC-141 Phase 1B, RIC-144 Phase 1C, RIC-146 Phase 1D, RIC-150 Phase 1E and RIC-61 historical-run quiescence.
