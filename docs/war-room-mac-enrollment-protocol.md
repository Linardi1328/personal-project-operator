# RIC-158 — Trusted Mac enrollment and key-lifecycle protocol (design v1)

**Status:** REVIEW PROPOSAL ONLY — unimplemented, no actual Mac or VPS device enrolled, no keys issued or registered, no network listener, worker, deployment, factory run or operational approval.

## Security goal and trust boundaries

PPO is the sole authoritative development-run state machine. Enrollment establishes *which reviewed device key may attest to a host identity*; it **does not** establish permission to run Codex, Antigravity, shell commands, GitHub delivery or any filesystem action. Every execution boundary must additionally pass current transactional Phase 1G fencing, canonical PPO run/version/CAS, scope, claim lease, current catalogue and WIP admission. RIC-59 and RIC-61 legacy retirement/quiescence remain independent holds.

**Threat model:** untrusted Telegram/phone messages, Linear issue text, arbitrary client-supplied paths or roles, copied enrollment links, forged or delayed enrollment response, stolen or cloned keys, stale host session/epoch, service impostor, key rollover, sleeping/offline Mac, VPS/network partition, untracked workers and privilege escalation. Do not treat hostname, serial number, IP, OS username, SSH agent, process list or software self-attestation as independent proof of device trust.

## Required architecture

- **Coordinator:** independently authenticated PPO administration service, reviewed operator/public-key registry, monotonic host epoch and key version, pending single-use challenges, signed audit journal, and a revocation authority integrated with the same transactional fence used at action boundaries.
- **Mac:** dedicated least-privilege enrollment helper and outbound-only worker, private signing key retained locally under reviewed macOS access control, checked agent/software revision and canonical repository/worktree map. No arbitrary command runner or inbound public Mac terminal/SSH.
- **Channel:** outbound-only TLS-authenticated HTTPS polling. Validate coordinator TLS/service identity on the Mac; sign a fresh server challenge bound to the exact connection/session, request digest, monotonic epoch and expiration. Mutual TLS can be evaluated, but TLS alone does not replace host challenge verification or per-action fences.
- **Identity separation:** coordinator signing key, worker's claim-signing key and Mac host identity key MUST be distinct. Server stores a pinned public key fingerprint (SHA-256 over DER SubjectPublicKeyInfo) and key version, not a password or private key. Mac worker role is policy-bound: implementation.backend → Codex; implementation.frontend → Antigravity. Client-provided role labels are not authorization.
- **Key custody:** check the actual Apple Keychain/secure-storage API and permissions before implementation. Do not assert Ed25519 private keys are Secure Enclave-backed. A hardware-backed P-256 path would require a separately versioned contract and cryptography review; never silently switch algorithms. No key or whole secret-bearing config in logs, GitHub, Linear or Telegram.

## Protocol

### 1. Owner-initiated pending enrollment (no host authority)

An already authenticated and freshly reauthenticated PPO owner opens a reviewed administrative enrollment flow and chooses: exact host ID, approved worker identity/capabilities, reviewed project IDs, canonical repository/worktree mapping identifier, expected host software revision, and a short activation window. The server returns a cryptographically random, single-use challenge (≥128 bits) expiring in at most five minutes, with a fixed issuance time and registration request ID. Store only its digest and state server-side; lockout/retry rate limits apply. No phone/chat instruction may issue an active host key or edit its mapping.

### 2. Local proof of possession and out-of-band fingerprint

An approved Mac enrollment helper generates a fresh signing key *on the Mac*, protecting the private key against unreviewed processes. The helper signs a canonical, domain-separated enrollment message containing protocol version, challenge/request ID, nonce, coordinator identity, host ID, proposed key version, public-key fingerprint, bounded software revision and approved mapping ID, issue/expiry. The response must be exact-keyed and reject unknown fields, duplicate keys, malformed encoding, stale time, wrong challenge, wrong origin, wrong key type and reused nonce. The owner sees the key fingerprint on the local Mac and compares it with the separately authenticated admin screen; a chat message or screenshot alone is insufficient verification.

### 3. Independent owner approval then activation

The server verifies challenge uniqueness, expiry, pinned coordinator identity, host proof of possession, reviewed mapping and owner fresh authentication. It performs one atomic pending→active enrollment transition, issues a new **monotonic host epoch**, stores only the public key/key fingerprint, approved policy mapping, key version and audit facts, and consumes the enrollment challenge irrevocably. Fail closed on concurrent attempts, ambiguous COMMIT or remote service outage. A completed enrollment yields a status page, **not an action permit**. Do not automatically start a worker.

### 4. Outbound-only authenticated sessions

The registered Mac initiates short-lived authenticated polling over pinned/validated TLS coordinator identity. Each session proves the *current* host key and epoch over a fresh coordinator nonce, request scope and short expiry. Use bounded descriptors, idempotency and transport replay controls; deny incorrect role/project/host/epoch, expired credentials, old software revision, unexpected worktree, unknown route, or protocol downgrade. Authentication may show a host is the registered key holder, but does **not** prove it is the same uncompromised physical machine; key cloning requires explicit threat response.

### 5. Rotation, suspension, revocation and recovery

- Rotation: a new on-device key plus an owner-approved challenge. Require proof under old *and* new keys when old key remains trusted; otherwise require a stronger separate recovery flow. Atomically increment the epoch and key version, pin new fingerprint and invalidate old sessions, active claims and action permits. An old claim **never** inherits a new epoch without explicit transactionally reviewed re-binding.
- Suspension/revocation: server-side active→suspended/revoked transition fences all current claims and future action attempts at the shared authoritative CAS point. Unknown acknowledgment, host offline, key compromise or rollback must deny. Revocation cannot be weakened by a cached local session or JWT expiry window.
- Key loss/reinstall: old identity remains revoked; independent reauthentication, review and a new device identity are mandatory. No silent restore from cloud-synced keychain or automatically migrating active permissions.

## Proposed canonical envelope fields (not live API)

\`enrollment-request-v1\`: requestId, hostId, intendedWorkerIds, approvedProjectIds, canonicalRepoMappingId, expectedSoftwareRevision, coordinatorIdentity, nonce, issuedAt, expiresAt.

\`enrollment-proof-v1\`: protocol, requestId, hostId, coordinatorIdentity, nonce, keyAlgorithm, publicKeySpkiFingerprint, proposedKeyVersion, canonicalRepoMappingId, softwareRevision, issuedAt, expiresAt, signature.

\`host-registry-v1\`: hostId, status(pending|active|suspended|revoked), pinnedKeyFingerprint, keyVersion, epoch, approvedWorkerIds, approvedProjectIds, canonicalRepoMappingId, pinnedSoftwareRevision, registrationAuditId, revokedAt.

Exact serialized schema, transcript domain separation, key-store path, TLS client authentication and owner identity provider must undergo review before code. Avoid storing a copy of PPO canonical run state here.

## Negative test and activation gates

1. **Enrollment:** forged/wrong host or coordinator, wrong challenge/nonce, replay, duplicate simultaneous approval, expired challenge, key mismatch, path or role injection, unapproved admin, copied URL and connection interception.
2. **Lifecycle:** key rotation with an in-flight claim, old-epoch session after revocation, lost acknowledgment after DB commit, crash/restart, unreliable clock, cloned key, stale software/repo mapping, owner account recovery, missing service certificate, offline Mac or VPS and poisoned/ambiguous audit state.
3. **Execution isolation:** even a successfully enrolled Mac must fail until a completely separate current Phase 1G durable transactional action fence, canonical PPO run/version/SHA, audited permit/scope and sandboxed action gateway all verify at each real side-effect.
4. **Operational readiness:** RIC-59 invalid historical catalog and RIC-61 trusted two-host retirement quiescence must be reconciled independently; no factory cycles or old-run retirement. A separate owner-approved maintenance window, isolated low-risk pilot, load/partition tests, manual kill switch, rollback and evidence-based security review are required.

## Implementation order

First review this protocol and accepted identity/cryptography choices. Then implement **offline** challenge/response state machine and tests, followed by audited enrollment store and revocation semantics. Only after Phase 1G-B's real shared transaction authority and canonical PPO action CAS are proven may a scoped outbound Mac connector be separately proposed for activation.

**No Mac credentials, key material, account enrollment, service start/stop, new network listener or production host change are authorized by this document.**
