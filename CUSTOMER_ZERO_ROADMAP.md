# Customer Zero product evolution

## Direction and evidence

This plan implements the owner's 2026-09-10 product-evolution reference. PPO is a
development control plane for solo technical builders. Customer Zero comes first;
public SaaS is a later product decision. These stages are distinct from the older
Phase 0–7 lifecycle implementation numbering in ROADMAP.md.

Stage 1 local implementation and macOS fixture acceptance passed at
fd83d37ab9cb3ee5ade45df9a76ad6fba8c24842 with Node v24.20.0: five quality gates,
eight local parity checks, and fourteen recovery cases. Six ordinary-project
remote/host checks remain unverified. The intermittent readiness root cause is
not proven fixed. These results establish neither tenant isolation nor production
acceptance.

## Existing architecture to reuse

- github-project-registry.mjs defines fixed approved repositories.
- development-continue-runtime-profile.mjs binds reviewed tools and policies.
- development-run-state.mjs owns durable versions, attempts, history and evidence.
- Phase 6C–6G implement isolation, Codex, testing, independent review, bounded
  remediation and exact-SHA GitHub delivery. Preserve these engines.
- Phase 6H–6J have a separate PPO-only production boundary. Ordinary continue
  stops at merged. Do not reinterpret merged as release-ready or deployed.
- No Antigravity provider plan was found in the inspected Markdown sources.
  Its role below is a new explicit contract, not an existing working adapter.

## Stage 2 — SaaS-ready architecture

Status: scoped, implementation pending. One owner and one workspace remain the
only operational configuration. No public authentication, billing, invitations,
tenant onboarding, database rewrite, or new execution authority.

### 2A — Explicit ownership context

Introduce stable owner/workspace/project identifiers and one reviewed Customer
Zero binding. Keep the current registry as the authorization boundary; separate
that binding from reusable validation logic. Accept no caller-selected account,
repository, credential, or workspace root. Test missing, conflicting, unknown,
and cross-workspace bindings with synthetic fixtures. Do not claim production
multi-tenant isolation from those tests.

Exit: existing personal commands retain behavior; reusable context validation has
no dependency on the owner's name, while the deployment binding remains fixed.

### 2B — Integration and provider contracts

Define workspace-owned connection references with no credential values. Codex is
the backend provider; Antigravity is the preferred frontend provider; Lovable is
optional and disabled by default. Reuse the Codex execution adapter. Unsupported
providers return an explicit unavailable result, never a silent fallback.
Define Vercel as the initial future preview/deployment provider, disabled until a
separately tested adapter exists. Contracts grant no network or production access.

Exit: provider selection is deterministic and bound to approved project policy;
unknown, mismatched, or unavailable connections fail closed. No fabricated
Antigravity/Vercel success and no unrestricted GitHub credentials for workers.

### 2C — Run and evidence ownership compatibility

Bind new run context to the existing durable store. Design and test explicit
legacy-record handling before changing stored records. A legacy run may resolve
only to its fixed existing Customer Zero binding; ambiguity requires owner action.
No bulk rewrite or second canonical run store. Preserve versions, exact-SHA
evidence, attempts, recovery and cancellation. Reserve RunUnit/interface-contract
concepts without adding parallel execution or new lifecycle states yet.

Exit: old and new records pass lifecycle regressions; mismatched ownership cannot
reuse evidence or approvals. Any schema migration includes recovery and rollback
tests and a reviewed compatibility strategy.

### 2D — Safe operational metrics

Add bounded read-only projections over existing run metadata: project, provider
when known, attempts, remediation rounds, recorded outcomes, recorded stage
durations and explicit owner interventions. Missing observations stay unknown.
Do not infer cost without billing evidence or collect prompts, source, raw logs,
tokens, credentials or task bodies. Avoid new telemetry services.

Exit: projections do not mutate runs and enforce ownership and output bounds;
malformed/legacy/missing evidence does not fabricate metrics.

### 2E — Integration and handoff

Integrate only the approved foundations into existing entry points. Document the
compatibility guarantees and an exact-revision owner acceptance procedure. Run
all five quality gates and recovery fixtures; review each phase before advancing.
Do not introduce /ppo develop, release-ready state, live provider orchestration,
automatic deployment, or a dashboard as shortcuts to stage completion.

Exit: all implementation reviews resolved, CI green, documented limitations and
Mac test instructions ready. Joint owner acceptance follows implementation and is
recorded separately from implementation completion.

## Execution and review protocol

Use a bounded normal PPO run per subphase. Implementation -> exact-SHA tests ->
independent review -> bounded remediation -> reviewed GitHub delivery. If a
subphase is too large, split it before execution. Stop on ambiguous outcomes;
reconcile through existing APIs. Never mark self-review as independent approval,
manually invent PASS evidence, or bypass a gate to finish the stage.

The first implementation task is 2A only. Advance to 2B after 2A's independent
review and delivery; retain the phase review outcomes and tested revisions.
Runtime access on the approved host is required to execute that lifecycle.

## Later stages — planned, not implemented

| Stage | Purpose | Entry/exit evidence |
| --- | --- | --- |
| 3 — Internal real-world usage | Prove one project first, then broaden. Add verified Antigravity integration where available, contract-first frontend/backend coordination, Vercel preview verification and owner-approved exact-SHA production release in separately reviewed increments. | Stage 2 accepted; real task outcomes, interventions, ambiguity, remediation and measured costs where available. Existing SKIPs remain open until tested. |
| 4 — Design partners | Work with 3–5 technical builders; validate demand and ownership boundaries. | Proven Customer Zero value; explicit external-user security, credential isolation, onboarding and support review before external access. |
| 5 — Private beta | Harden multi-user operation and onboarding for a limited cohort. | Tested tenant isolation, authorization, incident recovery, operational limits and support. |
| 6 — Paid beta | Validate pricing and economics; add billing only when explicitly approved. | Measured usage/cost and customer value; reviewed payment and entitlement behavior. |
| 7 — Public launch | Broaden access after reliability and demand are established. | Agreed launch thresholds, security and operational readiness. Fifty real tasks is a proposed evidence target, not an already-met or final launch requirement. |

GitHub remains the canonical external code record; PPO remains the authority for
execution, evidence and release. Production always requires owner approval.
Netlify and additional provider integrations stay deferred. Stage 3 live testing
is not Stage 2 architectural completion, and a UI is not proof of product value.
