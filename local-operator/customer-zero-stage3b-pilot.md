# Customer Zero Stage 3B — first controlled KHLIM Assist task

Stage 3B adds one fixed owner-host launcher for the first real KHLIM Assist PPO task.

## Fixed task

The pilot task is:

> Add deterministic regression tests for Phase 2 multilingual GREEN/YELLOW/RED classification, including malformed and empty inputs, without changing classification logic, retrieval behavior, or participant auto-reply settings.

The launcher accepts no caller-selected project, task, repository, ref, branch, provider,
deployment target, or customer-messaging option.

## Preconditions

Before creating a run, the launcher:

- executes the Stage 3A KHLIM Assist readiness observer and requires every observation to PASS;
- requires the Stage 3A exact revision to remain the current GitHub default-branch head;
- snapshots the approved KHLIM Assist project document and ROADMAP planning source;
- requires the approved `Next action` text to equal the fixed Stage 3B task;
- preflights the Phase 6B planner against the same pinned source and GitHub snapshot;
- checks the read-only run catalog for an existing canonical pilot or another active KHLIM Assist run.

A catalog truncation, stale/recovery-required run, duplicate pilot run, task drift, planner
drift, revision movement, or missing readiness fact stops with
`owner_action_required`.

## Lifecycle

A successful launch calls the existing ordinary Phase 6B run creator. The resulting run
must be:

- project `khlim-assist`;
- status `planned`;
- implementation task exactly equal to the fixed pilot task;
- `baseSha` and `headSha` exactly equal to the fresh Stage 3A revision.

The launcher does not automatically continue the run. The normal ordinary lifecycle remains:

```text
planned
-> implementation
-> exact-SHA automated tests
-> independent review
-> bounded hardening if required
-> reviewed GitHub delivery
-> expected-head merge
-> merged
```

Ordinary `/ppo continue` still stops at `merged`.

## Authority boundary

Stage 3B does not authorize deployment, production verification, rollback, provider
fallback, participant auto-replies, credential changes, or customer/staff messaging.
The pilot launcher does not select a frontend provider and does not use Antigravity or
Vercel.

## Owner-host launch

After this increment is independently reviewed and merged, run from the canonical PPO
checkout on the approved owner host:

```bash
node deployment/scripts/run-customer-zero-stage3b-pilot.mjs
```

The command accepts no arguments. On success it returns the canonical run id and the next
ordinary command:

```text
/ppo continue <run-id>
```

If the pilot already exists, the launcher returns that canonical run instead of creating
another one.
