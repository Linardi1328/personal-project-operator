# PPO RIC-141: Phase 1B offline remote-dispatch contracts

This slice defines an **unwired, offline-only** prototype. It does not create a new PPO state store or invoke any Codex, Antigravity, Mac, VPS, Telegram, network or production API. It is a request/claim/evidence/review model, not a service.

## Contract v1

- `dispatch-request`: a PPO coordinator-signed, single-use, time-bound description of the approved canonical development run (`runId`, `expectedVersion`, project, branch, base/head SHA, backend/frontend role, selected worker), a Linear issue with revision/content hash, bounded paths/permits, owner approval ID, nonce and idempotency key. Raw prompts, credentials and unrestricted command strings are absent.
- `worker-claim`: a worker-signed request hash, worker/host identity and short lease tied to the same run version. An in-memory mock only permits one claim and rejects replay, mismatched worker/host, expiry and stale run state.
- `execution-evidence`: worker-signed bounded outcome, changed paths, denied tools, output digest and sanitized summary, bound to the exact claim and request. Denied tool operations cannot count as success.
- `review-decision`: separate mock reviewer-signed bounded decision bound to the exact evidence hash. A review may never authorize a merge, deployment or other release operation.

Wire payloads have strict schemas, max sizes and Ed25519 signatures. The protocol validators and mock harness are separate and deliberately not imported by PPO production handlers.

## Execution model and assumptions

The synthetic harness is **memory-only** and explicitly requires `mode: "offline-mock-only"`, a `readRun` adapter, PPO's canonical `resolveSoftwareFactoryTaskRole`, a fixed clock, a project allowlist, and independently pinned coordinator, worker and reviewer public keys. Its locks prevent duplicate claims in one process, **not** competing hosts or multiple durable processes.

The next slice must replace memory state with a transactional, crash-safe PPO-owned store and host fencing; authenticate owner approvals instead of merely carrying a signed coordinator assertion; implement host registration/revocation, an outbound-only channel, canonical WIP admission, scoped filesystem and symlink checks, log redaction at the actual tool boundary, measured quota controls and a tested no-execution default. Until then no real task may be dispatched.

## Tests

`node --test local-operator/software-factory-remote-mock.test.mjs local-operator/software-factory-remote-role-integration.test.mjs`

Tests cover backend and frontend role assignment, signed complete synthetic lifecycle, request/claim/evidence/review binding, forged host/signature, duplicate and concurrent claims, stale version/SHA, project and scope mismatches, expiry, offline worker, denied tools, out-of-scope changes, review rejection and no release authority. **Passing tests do not prove a remote Mac service safe.**

## Shipping gates

Open a draft PR against `main` and obtain CI + CodeRabbit review. No merge, deployment, service activation or real remote worker until separately authorized. RIC-59/RIC-61 catalog and quiescence holds remain in effect.