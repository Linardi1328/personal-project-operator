# RIC-157 pilot campaign — resource measurement baseline

This opt-in instrument runs the unchanged synthetic authority suite in its own network-none PostgreSQL container. It is preparatory evidence for original M-03, **not completion of M-03 or a production budget**. No host, DSN, existing container, record path or credentials can be selected. A collision with another container name fails rather than adopting or deleting it.

Run explicitly from a verified checkout:

```sh
CI=true GITHUB_ACTIONS=true GITHUB_RUN_ID=15720261113 GITHUB_RUN_ATTEMPT=41 \
  node deployment/scripts/profile-ppo-postgres-authority.mjs
```

The command prints a private temporary artifact directory containing the exact SHA/platform/image, unchanged suite output, per-Node-process peak RSS, PostgreSQL container cgroup memory peak, sampled database/temporary-file/WAL size, connections, lock waiters and oldest transaction age. Raw samples and output are bounded. A 20-minute whole-profile watchdog, 32 MiB log cap and 2 MiB sample cap terminate the owned attempt; no assertion or per-statement timeout is raised. Normal CI does not preload instrumentation. The container has explicit experimental 512 MiB/2 CPU, 16-connection, 32 MiB shared-buffer and 4 MiB work-memory settings. Those are **experiment inputs**, not recommended operating settings.

`--baseline-2g` selects the only alternate experiment: a 2 GiB container with every other setting unchanged. This exists to compare against a retained 512 MiB pressure failure, not to hide it or assign a production budget. Unrecognized options, DSNs and container selection are rejected. Server logs are retained before owned-container teardown, including evidence of crash recovery.

Peak RSS is per Node process, not aggregate simultaneous Node memory. Cgroup memory includes PostgreSQL, observer clients, page cache and kernel accounting; it is not pure PostgreSQL process RSS. Five-second samples can miss transient waits and temporary disk peaks. The suite deliberately kills/restarts its container, so observer gaps must be retained and reported. No missing sample is replaced by zero or interpreted as proof of no contention. Sample counts/error counts and incomplete Node-profile markers are retained. An incomplete or failed instrumented suite cannot qualify a resource budget.

Measurement definitions: Node's [resourceUsage](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage) and the Linux kernel's [cgroup v2 memory controller](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory) documentation. Record the actual local Node/kernel/image versions with each run; these references do not make cross-platform observations equivalent.

## Required qualification beyond this baseline

The existing suite includes a valid near-32-MiB native catalog and 100-version exhaustion but does not populate every supported simultaneous retention extreme. Before assigning production limits, separately exercise valid 20-run/2,000-version catalogs, 10,000 admission certificates, 1,000 action contexts/tombstones/resource operations/receipts, 1,000 resource versions and 2,000 revocations at representative maximum record sizes; retain actual execution plans and measured query/transport latency. Include 1/2/N competing connections, gate queueing, revocation latency, statement/lock/idle/whole-transaction cancellation, client loss, memory/disk/WAL pressure and restart recovery. Peak process memory needs a platform-specific process measurement in addition to cgroup accounting. Cold/warm plans, repeat counts, hardware/runtime settings and observer overhead must be stated. Do not extrapolate a localhost Docker result into a Mac/VPS production guarantee.

The current 20-run and immutable-history/certificate/nonce/receipt ceilings are fail-closed laboratory lifetime limits. Cancelled/completed runs retain their slots; version/byte exhaustion can prevent cancellation. No history, consumed nonce or operation receipt may be pruned to reopen admission. A production retention/capacity policy needs separately reviewed expansion or archive/epoch transitions with externally anchored anti-rollback identity, immutable reconciliation evidence, backup integrity and exclusive ownership; until implemented and measured, production admission remains blocked. Never silently carry the 20-run lab ceiling into a production lifetime policy.

All executable grant flags remain false. RIC-157 remains In Progress, RIC-59/RIC-61 remain held, and owner approval is required for each merge. No production routing, real credentials, enrollment, connectivity, dispatch, actual filesystem/Git effects or pilot activation is provided.
