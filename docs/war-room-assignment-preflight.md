# RIC-146 — PPO × War Room offline assignment preflight (Phase 1D)

## What this slice proves

A signed Phase 1B `dispatch-request` can be checked against **independently injected synthetic PPO facts** before any future `/ppo assign` or owner-approval workflow is wired. It requires the coordinator's pinned Ed25519 public key, an exact canonical run/version/project/branch/SHA binding, a fresh raw Linear issue revision hash, a trusted issue-to-project mapping, a reviewed isolated repository observation, current Codex/Antigravity role ownership, PPO's catalog-admission read and the two-project WIP rule. A separate trusted `verifyOwnerApproval` callback must explicitly return `true`.

The hash is SHA-256 over JSON of the fixed ordered array `["ppo-linear-issue-revision-v1", identifier, title, description, updatedAt]`. It uses **raw bounded content** so whitespace and text changes cannot be silently reinterpreted during display sanitation. This is **not** a Linear signature, an authorization source, or proof the source was fetched by an authenticated production client. No credentials, issue body, approval assertion, paths, or permits are returned.

Only `mode: "offline-preflight-only"` is accepted. The result includes `preflightPassed:true` for a successful *diagnostic* and **always** `canExecute:false, releaseAuthorized:false`. Passing this check does not reserve a run or authorize a claim. Calls are intentionally read-only and repeatable; there is no persistent replay prevention, cross-process serialization, lease or worker fencing.

## What is deliberately missing

- No CLI, `/ppo assign`, OpenClaw/Telegram, live Linear API integration, Mac/VPS, network channel, host registration or real Codex/Antigravity execution.
- No durable approval issuance, human identity authentication, signed owner challenge, revocation, request consumption, replay index or immutable audit chain.
- No actual repository path/symlink examination: `reviewedCanonicalPath` and `isolatedWorktree` are **trusted test observations**, not filesystem security controls.
- No transactional WIP admission: an injected snapshot is inherently raceable. A real coordinator must enforce admission and version checks at the atomic state mutation point.
- No authority to change PPO canonical runs, the RIC-59/RIC-61 hold, branch protection, CI, PR, merge, release or deployment.
- No dependence on unmerged PR #146 (offline durable ledger) or #147 (read-only Linear preview). Integrating them requires a subsequent reviewed slice.

## Tests and review gates

`node --test local-operator/war-room-assignment-preflight.test.mjs`

Synthetic fixtures cover correct backend/frontend roles, issue revision changes, forged signature, wrong project, stale run/SHA, unreviewed worktree, missing owner approval, global catalog hold, WIP exhaustion, expired requests, untrusted callback failures, malformed issue, and no-execution outputs. These tests cannot demonstrate production security. Run GitHub Actions on exact branch head, CodeRabbit and separate security/human review before any merge. **Do not merge, deploy, or activate workers without explicit owner authorization.**

Related: RIC-137, RIC-141, RIC-144, RIC-145.
