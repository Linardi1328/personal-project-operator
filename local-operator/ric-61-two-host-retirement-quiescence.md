# RIC-61: Two-host retirement quiescence integration — review candidate

**Status:** Coordination contract and adversarial fixture tests ONLY. No authenticated
host authorities exist in this repository. **Operational retirement stays blocked.**
Do not merge this as evidence that Mac/VPS or GitHub delivery are quiescent.

## Owner-observed topology (9 October 2026)

- Mac OpenClaw launchd gateway was running (PID observed; process status is a
  point-in-time observation). Its bridge defaults to the per-user app data
  directory unless an effective process-specific override is configured.
- The Mac app-data store contains canonical records for the two exact KHLIM
  Assist retirement targets and the unrelated invalid historical record. All
  three canonical files byte-matched the offline owner backup at observation
  time. Operation leases were not present in the inspected Mac store.
- VPS OpenClaw systemd service was inactive in a separate read-only snapshot.
  The VPS write-data path is a local ext4 mount with no matching target records
  in the earlier file-existence check.
- Neither snapshot proves process ancestry, absence of orphan workers, queued
  dispatch, workspace mutations, independent state writers or remote delivery.
  Missing leases and remote PRs are not proof.

## What the code provides

\`development-retirement-two-host-quiescence.mjs\` is an internal, in-memory
coordinator for **future trusted ports**, ordered:

1. \`writer\`: a cross-host/interprocess gate fencing all run-state writers and
   new dispatch on both hosts before other leases can be acquired.
2. \`mac\`: authenticated ownership and a held lock against legacy Mac workers,
   descendants, workspaces and dispatch queues.
3. \`vps\`: authenticated ownership and a held lock against VPS processes,
   service restarts, queues, workers and workspaces.
4. \`delivery\`: a held GitHub Phase 6G push/PR/review/merge delivery exclusion
   covering all previously started in-flight operations, not merely PR counts.

The coordinator acquires every port with one private random epoch, validates
run ID, explicit absolute store, epoch, port role, exclusivity, quiescence,
zero unknown operations and both lifecycle methods, then checks all held
fences. It rechecks each fence when the retirement session requests
\`assertHeld()\`. Missing ports, unknown claims, rejected acquisitions and
lost fences fail closed. Partial acquisitions release in reverse order.
Failed cleanup poisons that coordinator instance and cannot auto-retry.
Guard release is single-use. This contract makes no files or external calls.

The **integration seam already exists** in
\`createDevelopmentRunRetirementSession({ acquireQuiescenceGuard,
confirmOwner })\`; the coordinator's \`acquireQuiescenceGuard\` may be wired
*only after* the trusted ports and independent owner authentication have been
implemented and reviewed. This PR does not wire it to a route or executable.
The existing \`inspectDevelopmentRunRetirement\` result remains
\`retirement_quiescence_unverifiable\`, even if its target record is otherwise
eligible.

## What is NOT implemented (blocking)

The coordinator cannot create an actual distributed lock, verify identity,
authenticate a remote host, exclude noncooperating scripts/writers, observe
legacy descendants, block launchd/systemd activation, or fence GitHub write
permissions by itself. The returned test-port objects are **not attestations**.
An object with \`quiescent: true\` is only an interface claim; it is never
independent evidence of real host safety.

Before production use, a separate reviewed host/authority implementation must:

- Identify every Mac/VPS entrypoint that can write durable PPO state, start
  workers, resume a factory/manager task or deliver via Phase 6G. Make the
  \`writer\` fence unavoidable on all of them, including direct CLI/library
  invocations, or prove they are disabled under OS-enforced exclusion.
- Have a single trustworthy source of authority for an epoch and a recoverable
  durable exclusion spanning both independent stores, with protection against
  abandoned coordinator processes and remote partitions. A process-local
  mutex and \`ps\` output are insufficient.
- Enforce authenticated remote host identity and pre-registered configuration,
  verified deployment revision, process tree/workspace/queue identity and
  actual held local locks; reject unknown children or task ownership.
- Fence systemd restart and launchd automatic activation for the full hold.
  Never call stop/restart/kill or alter service config without a separate
  owner-approved operational maintenance procedure.
- Fence GitHub delivery even if another host or actor still has credentials:
  in-flight calls and new pushes, PR updates and merges cannot bypass it.
- Return proof-sensitive \`assertHeld\` that rechecks all exclusions until state
  CAS commits, and \`release\` with explicit ambiguity reporting if any site
  cannot be released. An unreachable host, stale generation, timer expiry,
  conflicting state writer or remote delivery actor blocks.
- Bind an independently authenticated one-time owner confirmation to exactly
  one target; preserve run history, all evidence and the unrelated invalid run.
  Do not restore backups, delete leases or permit \`/ppo factory-cycle\`.

## Testing and security boundaries

\`\`\`sh
node --test local-operator/development-retirement-two-host-quiescence.test.mjs
node deployment/scripts/run-ppo-development-quality.mjs syntax
node deployment/scripts/run-ppo-development-quality.mjs parallel-regression
node deployment/scripts/run-ppo-development-quality.mjs serial-regression
node deployment/scripts/run-ppo-development-quality.mjs critical-lifecycle
node deployment/scripts/run-ppo-development-quality.mjs integrated-acceptance
\`\`\`

Tests are synthetic and contain no owner files, real gateways, service changes,
network writes, GitHub writes, run retirement or sensitive stdout. All ordinary
cancellation, recovery, production-history and factory admission rules remain
unchanged. The separate historical-replay provenance failure remains unresolved.

**Review gate:** Complete and independently validate the actual host/writer/
delivery adapters, their installation and rollback procedure and owner session
binding before any operational retirement. Keep both historical run transitions
blocked until those gates and fresh owner authorization are met.
