# Phase 6G GitHub Delivery

Phase 6G is a library-only delivery foundation for Phase 6A development runs that have already reached `review_passed` through Phase 6F.

Modules:

```text
local-operator/development-acceptance-gate.mjs
local-operator/github-delivery-agent.mjs
```

## Acceptance Gate

`development-acceptance-gate.mjs` is deterministic and read-only. It requires:

- exact expected run version
- `run.status === "review_passed"`
- project membership in the fixed six-project registry
- canonical, clean Phase 6C workspace
- workspace branch and HEAD equal to the run branch and `run.headSha`
- Phase 6D implementation evidence for `run.headSha`
- Phase 6E PASS evidence for `run.headSha`
- Phase 6F APPROVED evidence for `run.headSha`
- `mergeAllowed=true`
- no blockers, security findings, required tests, open ambiguous attempts, owner-action hardening, non-convergence, default branch, or SHA mismatch

No model call can grant acceptance. Any SHA change invalidates the gate and requires fresh Phase 6E tests, Phase 6F local review, updated remote branch, exact-head CI, and remote PR review.

## Delivery Flow

`github-delivery-agent.mjs` performs the Phase 6G sequence:

1. Assert deterministic acceptance.
2. Push only `<approved SHA>:refs/heads/<approved Phase 6C branch>` to fixed `origin`.
3. Create or reuse exactly one PR from the approved branch to `main`.
4. Re-fetch and validate the PR repo, base, source branch, open/non-draft state, and head SHA.
5. Require exact-head `PPO PR validation` success.
6. Run independent exact-head remote PR review inside the Phase 6F reviewer sandbox.
7. Transition `review_passed -> merge_ready`.
8. Re-fetch PR, CI, remote approval, and mergeability; refuse a PR reported as `behind` before reserving a merge attempt.
9. Merge with a fixed method and GitHub expected-head-SHA protection.
10. Verify the merge commit and `main`.
11. Delete the exact PPO implementation branch only when it still points to the approved SHA.
12. Transition `merge_ready -> merged`, recording whether cleanup succeeded or requires owner follow-up.

## Ambiguous Writes

External writes are reconciled before retry:

- ambiguous push: read remote branch; exact SHA recovers, absent branch may allow one safe retry, unexpected SHA fails closed
- ambiguous PR creation: re-query open PRs for the exact branch/base; recover only one exact match
- ambiguous merge: re-fetch PR merged state, merge commit SHA, and `main`; recover only if GitHub proves the expected PR/exact head was merged
- ambiguous branch deletion: re-read the remote ref; only an absent ref proves cleanup succeeded

The agent never force-pushes, never merges by branch name alone, and never blindly repeats an ambiguous write.

A `behind` PR is deterministic base drift, not an ambiguous merge. PPO fails closed before `merge_started` and does not update the branch because a new commit would invalidate the approved SHA's local tests, local review, CI, and remote review. The unmerged run must be retired through the bounded self-development recovery path, when applicable, and restarted from current `main`.

Branch cleanup is shared by every allowlisted project. It is limited to the run's
`ppo/<project>/implementation/<run>` branch after the exact PR merge is proven. A missing
branch is already clean, while a branch moved to any other SHA is preserved and recorded
as `cleanup_required`. Cleanup failure never changes a verified merge into a failed run.

## Evidence

Phase 6G adds backward-compatible `merge` evidence in the Phase 6A run record. Evidence is metadata-only and bounded. It may include policy id/hash, implementation SHA, pushed SHA, remote branch SHA, PR number/head SHA, CI run identity/result, remote reviewed SHA/decision, merge method, merge commit SHA, timestamps, and bounded outcomes.

It must not include tokens, authorization headers, credentials, SSH material, raw API bodies, raw CI logs, raw stdout/stderr, arbitrary executable paths, or unbounded errors.

## Boundary

Phase 6G ends at `merged`.

It does not deploy, restart services, roll back production, perform production verification, add `/ppo continue`, add Telegram/OpenClaw routes, change credentials/authentication, permit model-generated GitHub commands, permit implementer self-approval, skip Phase 6E/6F evidence, or merge an unreviewed SHA.
