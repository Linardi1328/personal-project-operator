# RIC-157 pilot campaign — resource measurement baseline

This opt-in instrument runs the unchanged synthetic authority suite in its own network-none PostgreSQL container. It is preparatory evidence for original M-03, **not completion of M-03 or a production budget**. No host, DSN, existing container, record path or credentials can be selected. A collision with another container name fails rather than adopting or deleting it.

Creation and startup are separate steps. A private cidfile and random operation label preserve ownership if creation/start acknowledgment fails or times out. Recovery removes only the cidfile's full container ID after validating its exact operation label; it never adopts a name collision. If creation is uncertain and no matching evidence is available, the report records uncertainty and failed cleanup for operator reconciliation; absence is not interpreted as noncreation and creation is not retried. The operator must retain the report's name/operation identity when the Docker daemon itself is unavailable.

Run explicitly from a verified checkout:

```sh
CI=true GITHUB_ACTIONS=true GITHUB_RUN_ID=15720261113 GITHUB_RUN_ATTEMPT=41 \
  node deployment/scripts/profile-ppo-postgres-authority.mjs
```

The command prints a private temporary artifact directory containing the exact SHA/platform/image, unchanged suite output, per-Node-process peak RSS, PostgreSQL container cgroup memory peak, sampled database/temporary-file/WAL size, connections, lock waiters and oldest transaction age. Raw samples and output are bounded. A 20-minute whole-profile watchdog, 32 MiB log cap and 2 MiB sample cap terminate the owned attempt; no assertion or per-statement timeout is raised. Normal CI does not preload instrumentation. The container has explicit experimental 512 MiB/2 CPU, 16-connection, 32 MiB shared-buffer and 4 MiB work-memory settings. Those are **experiment inputs**, not recommended operating settings.

`--baseline-2g` selects the only alternate experiment: a 2 GiB container with every other setting unchanged. This exists to compare against a retained 512 MiB pressure failure, not to hide it or assign a production budget. Unrecognized options, DSNs and container selection are rejected. Bounded server-log capture is attempted before owned-container teardown; unavailable diagnostics are explicitly reported.

## Retained first measurements

Both experiments used macOS arm64 Node v24.20.0 and PostgreSQL 16.14, the same synthetic suite and unchanged statement/transport deadlines. Reports retain their actual source SHAs and image digest:

| Observation | 512 MiB pressure experiment | 2 GiB comparison experiment |
| --- | --- | --- |
| Source | `aa547c742a448823af59d43ff257ae4979b36b23` | `37fc79a1c60e12690b8e48f6375735b1550d2c70` |
| Tests | 9 passed / 57 failed after cluster recovery interrupted the near-limit case and fixture cleanup | 66 passed / zero failed or skipped |
| Container memory high water | 536,870,912 bytes | 822,079,488 bytes sampled cgroup high water |
| OOM kills | 2 recorded | 0 recorded |
| Node process peak RSS | 869,968 KiB | 1,065,248 KiB |
| Sampled temporary-byte counter maximum | 1,439,399,096 bytes | 4,873,935,582 bytes |
| Wall time | 99.271 seconds (failed) | 383.712 seconds |

Original [pressure report](evidence/ric-157-pilot-resource-pressure-512m.json) and [comparison report](evidence/ric-157-pilot-resource-baseline-2g.json) are retained unchanged. The pressure failure's first reported exception is fixture teardown encountering PostgreSQL recovery; subsequent role-exists failures are a cascade, not independent regressions. Cgroup OOM counters establish memory pressure and kills, but this run did not retain the killed backend PID. The comparison reports `serverLogUnavailable:true` without retaining its cause; it must not be represented as complete server diagnostics or diagnosed as a specific capture error. The final observer-only patch combines stdout/stderr and records an unavailable reason for future captures, with the same explicit bound; the retained measurements predate that patch.

The 512 MiB limit is insufficient for this tested near-limit workload. The 2 GiB success does **not** establish a safe production allocation: Node is outside that container limit; its peak alone exceeded 1 GiB, and the PostgreSQL temporary-byte counter is cumulative generation rather than peak simultaneous disk. These measurements do not fill the worst-case/retention/plan/latency/queueing matrix below. Production M-03 remains blocked. No deadline was enlarged to turn the failed profile green.

The subsequent lifecycle correction moves image inspection after owned container startup, covers startup/readiness/version with the whole-profile watchdog, and rejects suite startup once cancellation has begun. Three deterministic fake-Docker tests establish cold-image cleanup, cancellation during version discovery and deadline during startup without creating real containers. The retained measured source revisions predate this correction; their wall-time fields cover the suite rather than the newer whole-profile interval. Those source/evidence differences remain explicit.

Independent review additionally reproduced a startup-failure ownership leak: the previous combined `docker run` could create a container and then reject before the ID assignment. Four further fake-Docker regressions now cover failed start, failed creation acknowledgment, command timeout after creation and collision without adopting/removing another container. All seven lifecycle cases retain output reports and require no suite startup after stop/failure. These are lifecycle tests, not additional PostgreSQL resource measurements.

Peak RSS is per Node process, not aggregate simultaneous Node memory. Cgroup memory includes PostgreSQL, observer clients, page cache and kernel accounting; it is not pure PostgreSQL process RSS. Five-second samples can miss transient waits and temporary disk peaks. The suite deliberately kills/restarts its container, so observer gaps must be retained and reported. No missing sample is replaced by zero or interpreted as proof of no contention. Sample counts/error counts and incomplete Node-profile markers are retained. An incomplete or failed instrumented suite cannot qualify a resource budget.

Measurement definitions: Node's [resourceUsage](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage) and the Linux kernel's [cgroup v2 memory controller](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory) documentation. Record the actual local Node/kernel/image versions with each run; these references do not make cross-platform observations equivalent.

## Required qualification beyond this baseline

The existing suite includes a valid near-32-MiB native catalog and 100-version exhaustion but does not populate every supported simultaneous retention extreme. Before assigning production limits, separately exercise valid 20-run/2,000-version catalogs, 10,000 admission certificates, 1,000 action contexts/tombstones/resource operations/receipts, 1,000 resource versions and 2,000 revocations at representative maximum record sizes; retain actual execution plans and measured query/transport latency. Include 1/2/N competing connections, gate queueing, revocation latency, statement/lock/idle/whole-transaction cancellation, client loss, memory/disk/WAL pressure and restart recovery. Peak process memory needs a platform-specific process measurement in addition to cgroup accounting. Cold/warm plans, repeat counts, hardware/runtime settings and observer overhead must be stated. Do not extrapolate a localhost Docker result into a Mac/VPS production guarantee.

The current 20-run and immutable-history/certificate/nonce/receipt ceilings are fail-closed laboratory lifetime limits. Cancelled/completed runs retain their slots; version/byte exhaustion can prevent cancellation. No history, consumed nonce or operation receipt may be pruned to reopen admission. A production retention/capacity policy needs separately reviewed expansion or archive/epoch transitions with externally anchored anti-rollback identity, immutable reconciliation evidence, backup integrity and exclusive ownership; until implemented and measured, production admission remains blocked. Never silently carry the 20-run lab ceiling into a production lifetime policy.

All executable grant flags remain false. RIC-157 remains In Progress, RIC-59/RIC-61 remain held, and owner approval is required for each merge. No production routing, real credentials, enrollment, connectivity, dispatch, actual filesystem/Git effects or pilot activation is provided.
