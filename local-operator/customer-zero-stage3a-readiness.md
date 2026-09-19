# Customer Zero Stage 3A — KHLIM Assist readiness observation

Stage 3A adds one read-only readiness boundary fixed to KHLIM Assist.

## Scope

The observer is `local-operator/customer-zero-stage3a-readiness.mjs`. It accepts no
caller-selected project, repository, ref, workflow, source path, provider, deployment
target, or production target.

It observes only:

- the fixed KHLIM Assist registry identity;
- the reviewed Phase 6K runtime profile and fixed KHLIM Assist quality policy;
- required local host dependencies through the existing read-only runtime probes;
- the canonical KHLIM Assist checkout identity, exact HEAD, and cleanliness;
- bounded GitHub read-only repository facts;
- freshness of the GitHub observation;
- equality between canonical local HEAD and the observed GitHub default-branch HEAD;
- the fixed active `.github/workflows/ppo-pr-validation.yml` workflow.

## Evidence

The result is metadata-only and uses deterministic `PASS`, `FAIL`, and `SKIP`
observations. The report may include the exact revision SHA and fixed policy/workflow
identifiers. It does not include source paths, workspace paths, executable paths,
credentials, environment values, command output, raw GitHub payloads, logs, prompts, or
task bodies.

Missing GitHub, workflow, or checkout facts remain `SKIP` or `FAIL`. Local policy
parity never upgrades missing remote evidence to `PASS`.

## Authority boundary

Stage 3A does not create or mutate a PPO run, workspace, branch, issue, pull request,
provider session, preview, deployment, production resource, credential, or customer
message. It does not invoke a model. A successful Stage 3A observation is readiness
evidence only; it does not authorize Stage 3B execution by itself.

Stage 3B remains a separate controlled KHLIM Assist task and requires the normal exact-SHA
test, independent review, GitHub delivery, and owner acceptance boundaries defined in
`CUSTOMER_ZERO_STAGE3_PLAN.md`.
