# RIC-61 — pinned host-identity witnesses (implementation slice 2)

**Status:** review-only verifier. No host agent exists, no keys are provisioned,
and this verifier is intentionally **not wired** into
`createTwoHostRetirementQuiescenceCoordinator` or
`createDevelopmentRunRetirementSession`.

## Problem and trust boundary

The merged PR #142 introduced an in-memory coordinator with four conditional
ports: writer, mac, vps and delivery. Its port objects cannot authenticate
the actual hosts or prevent uncooperative tasks. Owner-side process and
service snapshots did not establish that the Mac and VPS workers, old
children, workspaces, dispatch queues, or remote GitHub delivery are quiescent.

A later real adapter must first distinguish messages from the two
pre-registered hosts. `development-retirement-host-identity.mjs` supplies
an **offline identity-field verifier only**, not the adapter or fencing.

## Protocol

Only a locally trusted module with pinned host registration may invoke
`verifyRetirementHostIdentityWitness(witness, expected)`.

Expected registration contains a fixed `role` (mac/vps), `hostId`,
absolute `writeDataDir`, deployed source `deploymentSha`, a fresh,
cryptographically random controller `epoch`, a trusted current time and a
pre-registered Ed25519 public key. **None** of those trust anchors may be
selected by a chat command, response body, environment boolean or
untrusted JSON payload. A public key only proves correspondence to a
signature; owner-approved key enrollment and secure on-host private-key
handling are separate prerequisites.

Witness format: exactly `{ payload, signature }`, where each member is
canonical base64url. `payload` is UTF-8 canonical JSON, signed using Ed25519.
Fields are ordered exactly:

```text
protocol, role, hostId, writeDataDir, deploymentSha,
epoch, issuedAtMs, expiresAtMs
```

The verifier checks schema, canonical encoding and field order, identical
expected values, bounded lifetime (up to 30 seconds), current clock
validity and signature using the pinned key. Any discrepancy returns
`retirement_host_identity_unverifiable` with no raw material or secret
values; success returns `retirement_host_identity_verified_only` and
redacted non-secret role/ID. There are no quiescence, exclusive-lock,
dispatch, delivery, approval or release flags in the success object.

## Missing blocking pieces

1. Independently review deployment-specific host identifiers, pinned keys,
   root/administrator-managed key enrollment, key rotation and revocation.
   Keep private keys outside repositories, logs and ChatGPT conversations.
2. Build Mac launchd and VPS systemd host agents whose identity witnesses
   are bound to a runtime authenticated channel and each host's actual
   installed configuration, running revision and pre-registered paths.
3. Build root/OS-enforced, persistent fences and fail-closed restart
   behavior for every PPO state writer, manual CLI, worker, child, workspace
   and queue on both hosts; code not cooperating with a lock must be
   independently excluded. In-flight work must drain or block.
4. Build *independent* GitHub Phase 6G delivery exclusion, including
   credential-bearing tasks and in-flight remote push/PR/merge operations.
5. Provide non-forgeable, held authority throughout the actual
   expected-version/CAS retirement commit. Identity verification alone
   does not show any of (2)-(5).
6. Perform disposable-fixture tests, CI, CodeRabbit, independent security
   review and owner-approved maintenance process before activating anything
   on real hosts. Preserve the private backup, historical run files and
   invalid catalog entry; factory stays blocked.

## Safety restrictions

The verifier does not use file I/O, sockets, commands, process inspection,
service control or GitHub APIs. It cannot prove that a worker is absent and
must never be promoted into the coordinator's `workersQuiescent`,
`deliveryQuiescent` or `exclusive` booleans. It cannot authorize retirement
from a signed message alone.

Focused fixture tests:

```sh
node --test local-operator/development-retirement-host-identity.test.mjs
```

Run standard five repository quality gates before review and merge.
**A green CI/CodeRabbit result for this PR does not authorize production
execution, a factory cycle or any historical run transition.**
