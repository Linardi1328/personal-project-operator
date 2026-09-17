# Customer Zero Stage 2 acceptance

## Recorded joint acceptance

Stage 2 was jointly accepted on the owner Mac on 2026-09-17 at exact merged
revision `304685483d01da15afa8c618a4493158458c4562` with Node v24.20.0.

- The focused ownership and Stage 2 suite passed 14 of 14 tests.
- Syntax, parallel regression, serial regression, critical lifecycle, and
  integrated acceptance all exited zero.
- The recovery regression suite passed 25 of 25 tests, and the revision-bound
  recovery matrix exited zero with no required SKIP.
- HEAD remained at the accepted revision and the working tree remained clean.
- The retained owner log basenames are
  `ppo-stage2-serial-20260911-174654.log`,
  `ppo-stage2-final-gates-20260917-163912.log`, and
  `ppo-stage2-recovery-20260917-165437.log`.

The six ordinary-project `remote-and-host-acceptance` observations remain explicit
SKIP because local policy parity is not remote/host evidence. They are Stage 3
readiness work and were not required recovery-matrix cases. This acceptance does
not prove public multi-tenancy, live Antigravity or Vercel availability, production
deployment, provider cost, or ordinary-project host readiness.

## Status and boundary

The procedure below verifies the merged Stage 2 ownership, provider-contract,
run-compatibility, metrics, and integration foundations on the approved owner Mac. It is
performed after implementation review, CI, and merge. Passing implementation tests alone
does not record joint owner acceptance, production provider readiness, or tenant isolation.

Stage 2 adds no public authentication, tenant onboarding, billing, dashboard, live
Antigravity/Lovable/Vercel adapter, preview deployment, production deployment, parallel
RunUnits, new lifecycle state, credential handling, telemetry service, or `/ppo develop`
route. Existing production authority and owner confirmation remain unchanged.

## Exact-revision Mac procedure

Start from the canonical checkout. Do not continue if the tree is dirty or `main` is not
equal to `origin/main`.

```sh
cd /Users/richie/personal-project-operator
git switch main
git pull --ff-only
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
PPO_STAGE2_REVISION="$(git rev-parse HEAD)"
node --version
```

Run the Stage 2 contract and compatibility suite first:

```sh
node --test --test-concurrency=1 \
  local-operator/ownership-context.test.mjs \
  local-operator/customer-zero-stage2.test.mjs
```

Then run all five reviewed quality gates:

```sh
node deployment/scripts/run-ppo-development-quality.mjs syntax
node deployment/scripts/run-ppo-development-quality.mjs parallel-regression
node deployment/scripts/run-ppo-development-quality.mjs serial-regression
node deployment/scripts/run-ppo-development-quality.mjs critical-lifecycle
node deployment/scripts/run-ppo-development-quality.mjs integrated-acceptance
```

Exercise the existing recovery fixtures against that same revision:

```sh
node --test --test-concurrency=1 local-operator/phase-6-recovery-acceptance.test.mjs
node local-operator/phase-6-recovery-acceptance.mjs \
  --expected-revision "$PPO_STAGE2_REVISION"
```

Finally prove that no command moved or dirtied the tested revision:

```sh
test "$(git rev-parse HEAD)" = "$PPO_STAGE2_REVISION"
test -z "$(git status --porcelain)"
```

Record the exact revision, Node version, each gate result, recovery matrix, and any SKIP.
Any failure or required SKIP leaves joint Stage 2 acceptance incomplete. Do not infer live
provider availability, remote-host parity, cost, deployment success, or production safety
from a local PASS.

## Compatibility guarantees

- The existing development-run store remains canonical and is not rewritten.
- Legacy runs resolve only through the fixed Customer Zero binding; ambiguity fails closed.
- Explicit run/evidence ownership must match the same fixed project context.
- Existing run versions, SHAs, attempts, evidence, recovery, cancellation, and delivery
  state are not mutated by Stage 2 inspection or metrics.
- Codex is the only available provider contract. Antigravity is explicitly unavailable;
  Lovable and Vercel are disabled; no provider silently falls back.
- Metrics are bounded recorded-metadata projections. Missing facts and costs stay unknown.
