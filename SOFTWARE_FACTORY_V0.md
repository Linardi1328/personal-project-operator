# PPO Software Factory V0

## Purpose

PPO is evolving from a Codex-centric personal project operator into the control plane for the owner's standardized AI software-development stack.

Software Factory V0 does not replace PPO's proven development lifecycle. It adds deterministic routing policy above that lifecycle so PPO can decide which approved capability should act next, whether that worker has capacity, which reasoning tier is sufficient, and when owner authority is required.

## Preserved invariants

The existing PPO development-run system remains authoritative for:

- durable run state and optimistic version checks;
- isolated implementation workspaces;
- exact-SHA implementation, test, review, CI, and merge evidence;
- bounded remediation and retry behavior;
- ambiguous-outcome reconciliation;
- independent review;
- GitHub as the canonical code record; and
- explicit owner authority for production release boundaries.

Software Factory V0 must not weaken those guarantees.

## Current stack policy

The initial control-plane policy reflects the standardized engineering stack:

| Capability | Primary worker | Model class | Required skill / policy |
| --- | --- | --- | --- |
| repository inspection | ChatGPT | economy | none |
| planning | ChatGPT | standard | none |
| architecture | ChatGPT | deep | none |
| backend implementation | Antigravity | standard | none |
| frontend implementation | Antigravity | standard | `ui-ux-pro-max` |
| deterministic tests | GitHub CI | none | repository test policy |
| browser E2E | Playwright | none | repository test policy |
| debugging | Antigravity | standard | `debugging-and-error-recovery` |
| runtime browser inspection | Chrome DevTools | none | runtime evidence |
| code review | CodeRabbit | none | review evidence |
| frontend review | Vercel Web Design Guidelines | none | `web-design-guidelines` |
| security review | ChatGPT | deep | independent review |
| release review | ChatGPT | deep | independent review |
| preview deployment | Vercel | none | exact reviewed SHA |
| production deployment | Vercel | none | owner approval required |

This table is policy metadata only. It does not claim that every worker has a live PPO adapter.

## Model classes

PPO uses abstract model classes instead of hard-coding vendor model names:

- `none`: deterministic tool; no reasoning model should be consumed;
- `economy`: low-cost retrieval, inspection, and summarization work;
- `standard`: normal planning, implementation, and debugging;
- `deep`: architecture, security, release review, or escalated difficult work.

Provider-specific adapters may map these classes to current models later. This keeps routing policy stable when model catalogs change.

Escalation is deterministic:

- economy work escalates to standard after one failed attempt;
- standard work escalates to deep after two failed attempts;
- high-risk reasoning work uses deep immediately;
- deterministic tool work remains `none` regardless of retries.

## Capacity semantics

Workers report one of:

- `available`;
- `degraded`;
- `exhausted`;
- `rate_limited`;
- `unavailable`; or
- `unknown`.

An exhausted or rate-limited worker produces `blocked_capacity` with `consumeAttempt=false`. Quota pressure is therefore not treated as an implementation failure.

An unavailable, unknown, or unconfigured worker fails closed instead of silently selecting a different implementation provider.

## Authority boundary

Routine approved engineering work may eventually be dispatched automatically after its worker adapter is reviewed.

Production deployment remains owner-gated. Future destructive migrations, authentication-architecture changes, new paid infrastructure, production-secret changes, and other high-impact actions must receive separate explicit authority policies rather than inheriting routine implementation permissions.

## V0 boundaries

This first slice is intentionally side-effect free. It does not:

- invoke Antigravity, ChatGPT, Vercel, CodeRabbit, Playwright, or Chrome DevTools;
- replace the existing Codex execution adapter;
- change development-run statuses or evidence schemas;
- add parallel workers;
- deploy anything;
- enable automatic production release; or
- claim live capacity observations that PPO cannot currently verify.

## Next integration target

The next increment should connect reviewed runtime observations to this control-plane policy, beginning with implementation-provider capacity. Once Antigravity has a reviewed adapter/readiness boundary, an ordinary PPO run should be able to remain queued as `blocked_capacity` when Antigravity is exhausted and resume without rebuilding task context or consuming a failed implementation attempt.

The first Customer Zero target should be a real priority-project task, not a synthetic demonstration.
