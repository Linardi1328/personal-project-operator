# Customer Zero Phase 6 recovery acceptance

## Status

Stage 1B implementation specification. The recovery changes in PR #73 are merged.
Their automated checks passed; this document does not claim live macOS acceptance.
The disposable acceptance runner is `phase-6-recovery-acceptance.mjs`.

## Deliverable

Add one terminal acceptance runner and focused regression coverage. Reuse the
existing operation-lease, run-state, orchestration, and Phase 6D/6E/6F recovery
APIs. Do not implement an alternative recovery engine or change production
recovery thresholds to make acceptance pass.

The runner must create fresh private temporary Git repositories, fixture runs,
and write-data stores. Bind all fixture operations to the exact tested source
revision. Use real owned child processes for lease-owner lifecycle checks and
deterministic adapters at Codex/model, reviewer, and network boundaries. Label
those adapters explicitly: this validates recovery integration, not live model
authentication, model quality, or GitHub delivery.

## Required acceptance matrix

| Boundary | Scenario | Required result |
| --- | --- | --- |
| Ownership | A fixture child holds an exact lease; another continuation arrives | No duplicate operation or run-state mutation |
| Ownership | Fresh, mismatched, malformed, or missing lease | Recovery refused with no fabricated success |
| 6D | Owned child exits after editing the exact starting tree | Supported recovery preserves edits, verifies a clean descendant SHA, and records implementation evidence |
| 6D | Owned child exits after a clean descendant commit | Recovery adopts only the verified descendant without duplicating the commit |
| 6D | Owned child exits without changes | Definitive retry boundary, not implementation success |
| 6D | Unexpected head, mixed committed/uncommitted work, or invalid workspace | Recovery refuses unsafe adoption |
| 6E | Owned child exits with an open testing attempt | Honest ambiguous failure; no PASS evidence; a later bounded attempt can run the full fixed policy |
| 6F | Owned child exits after review reservation | Recovery restores retained exact-SHA test evidence without approval or an extra hardening round |
| 6F | Genuine findings or missing exact-SHA test evidence | No conversion of findings or missing evidence into recovery success |
| Hardening | Parent hardening operation ends during a child phase | Recovery requires matching parent evidence and preserves round accounting |
| Replay | Recovery is repeated or version/SHA changes | At most one accepted transition; stale observations refused |

## Execution boundaries

- Permit interruption only of children created and tracked by this invocation.
  Never locate or terminate user processes with a broad process-name search.
- Require a readiness handshake before interrupting a child; observe its exit
  and enforce bounded waits. No unbounded loops or recursive continuation.
- Cover real process liveness without replacing it with an always-dead probe.
  A fixture clock may exercise age boundaries, but report that clock explicitly.
  Include at least one real-time macOS stale-owner case at the configured threshold.
- Never access or mutate existing user run records, managed workspaces, auth
  files, installed wrappers, GitHub resources, services, or production state.
- Keep Linux fixture coverage separate from macOS host acceptance. Unsupported
  host checks report SKIP, never PASS. Any required SKIP means acceptance is
  incomplete. Unit results alone cannot establish macOS acceptance.
- Emit only bounded case identifiers, outcome, tested revision, platform,
  timing mode, adapter mode, and safe reason classes. Exclude raw output, prompts,
  credentials, and arbitrary environment data.
- Return nonzero for FAIL or incomplete required acceptance. Preserve failed
  fixture evidence for diagnosis; cleanup may remove only validated temporary
  targets created by this invocation after all owned children have exited.

## Completion evidence

Include exact commands in the runner documentation after they are implemented
and verified. Record the full five-gate quality result, the fixture matrix, and
the separate macOS result with the tested revision. Keep the macOS result pending
until the owner executes the runner there. Do not automatically advance the next
project task or mark the stage complete merely because the runner is merged.

## Runner commands

```sh
node --test --test-concurrency=1 local-operator/phase-6-recovery-acceptance.test.mjs
PPO_ACCEPTANCE_REVISION="$(git rev-parse HEAD)"
node local-operator/phase-6-recovery-acceptance.mjs --expected-revision "$PPO_ACCEPTANCE_REVISION"
```

The runner emits one bounded JSON line per case.
Failures include a bounded `reason`; child readiness failures additionally include
the sanitized `childReason` code. Unknown exceptions use `case-failed` without
copying error messages, stacks, paths, or process output. Unsupported cases carry
`unsupported-host` and still make the command exit nonzero. These diagnostics do
not establish that the intermittent readiness failure has been fixed.

Deterministic no-network
adapters validate recovery integration, not live model authentication, model
quality, or GitHub delivery. A required SKIP makes host acceptance incomplete.
Run and retain the five gate results separately; macOS remains pending until an
owner executes the revision-bound runner command on macOS. Start from a clean
checkout of the intended implementation revision. The fixture repositories fetch
that exact revision locally and bind their real run records and leases to it.
The runner interrupts its own children after the real phase API reserves work,
then uses the existing continuation/recovery APIs on those same records.

The model and sandbox boundary is simulated and labelled; these cases do not
prove the external Codex service or sandbox enforcement. Git, run-state, lease,
and recovery operations are real. General cases advance only the fixture clock
by 61 seconds after the child exits. The macOS case waits 61 seconds after an
observed child exit and uses the real clock; it does not wait for the 90-minute
maximum lease age. Linux reports that case as SKIP and exits nonzero.
Child cleanup is enforced in finally and observes process close. Failed private
fixtures remain under the system temporary directory for diagnosis. No existing
run is changed. Output is emitted after each case.

Run the five quality gates separately:

```sh
node deployment/scripts/run-ppo-development-quality.mjs syntax
node deployment/scripts/run-ppo-development-quality.mjs parallel-regression
node deployment/scripts/run-ppo-development-quality.mjs serial-regression
node deployment/scripts/run-ppo-development-quality.mjs critical-lifecycle
node deployment/scripts/run-ppo-development-quality.mjs integrated-acceptance
```
