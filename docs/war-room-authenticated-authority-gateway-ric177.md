# RIC-177 — authenticated authority gateway (disposable Batch 2B+2C slice)

**Status: implementation candidate for independent review; not merged, not a pilot, not production authority.** Base: main `45216e2ada77636996b0ec3769ee3b94f1960b1f`. It closes the demonstrated raw-SQL restore bypass for the two existing database-only diagnostic effects inside one explicit, freshly installed, sealed disposable profile. Every result keeps `grant:false`, `canExecute:false` and `releaseAuthorized:false`. The Phase 1F success callback stays disconnected. RIC-157 stays In Progress, and RIC-59/RIC-61 stay held. This slice adds no native filesystem/Git effect, Batch 2D, real credential, Mac/VPS connectivity, deployment, migration, enrollment or retirement.

It implements the [approved contract](war-room-protected-resource-authorization-proposal.md) only to the extent stated here. It reuses the [pinned transport](war-room-isolated-service-transport.md) and the [external witness](war-room-external-incarnation-laboratory-phase2c.md); both documents remain authoritative for their own components.

## Causal RED and GREEN

**RED at the exact base.** [`ric177-red-baseline.integration.mjs`](evidence/ric177-red-baseline.integration.mjs) ran against an unchanged checkout at `45216e2`, in a network-none PostgreSQL 16.14 container. It drives the actual 2C witness through a consume, a host revocation and an actual `pg_dump` restore of the earlier state. After the restore the witness denies both the reservation and the activation. Even so, the actual ordinary LOGINs `ppo_red_consumer_login` and `ppo_red_admin_login`, connected as themselves rather than through a superuser `SET ROLE`, still:

- committed `consumed:true` for the already-consumed action, and
- re-advanced the revoked host to `2:active`, overwriting the revoked epoch-2 state with an active one.

The assertion that they are denied fails. The verbatim output is in [the evidence record](evidence/ric177-authority-gateway-red-green.txt).

**Causal control at the candidate.** The integration suite's first case runs the same scenario through the candidate's fixture but leaves the profile *unsealed*. The bypass reproduces. Sealing is the single difference, so the seal is what closes it.

**GREEN.** With the profile sealed, the stale-restore case runs the same actual LOGIN calls after an actual restore. Both are denied with SQLSTATE `42501` before any mutation, and the native checkpoint is unchanged. The same operation succeeds exactly once through the pinned gateway on current state. With the seal, those LOGINs no longer hold the ordinary memberships, so the `SET ROLE` itself is denied; the sealed-inventory case separately proves that the function and schema ACLs deny the same calls even if a membership is re-granted, and a separate case restores a pre-seal image and shows the bypass stays closed.

## Selected profile and seal

[`phase2bc-authority-gateway.sql`](../deployment/authority/phase2bc-authority-gateway.sql) installs inert gateway objects into the fresh `ppo_authority_ci` database. Nothing changes until the trusted bootstrap administrator calls `seal_authority_gateway(anchor, authority, owner)`.

Before the seal, trusted fixture bootstrap runs: ownership import, host epoch 1 and diagnostic context registration. The seal function:

- **Is not granted to anyone.** It requires a superuser in the CI database and the active target authority.
- **Checks the gateway login.** The single `ppo_transport_gateway` LOGIN must be unprivileged, hold exactly one membership (`ppo_authority_gateway`), and the owner role must have no members.
- **Closes ordinary memberships cluster-wide.** It revokes every membership in every ordinary `ppo_*` role (all but the owner and gateway roles) and reads the result back. Role memberships are cluster-global, so restoring a pre-seal or pre-install schema image re-grants ACLs only to roles no LOGIN can assume.
- **Refuses ACL-bypassing predefined roles.** It refuses to seal if any non-superuser role holds `pg_write_all_data`.
- **Revokes every non-owner privilege.** This covers every function, relation and the schema, read back from the actual ACLs, including PUBLIC defaults.
- **Grants exactly four entrypoints to `ppo_authority_gateway`:** `gateway_state`, `gateway_consume_action`, `gateway_revoke_host` and `gateway_receipt`, plus schema `USAGE`.
- **Rereads the effective ACLs** and refuses to seal on any residue.
- **Records the profile.** The pinned external trust domain (anchor, authority, owner) and an OID-free schema/profile attestation are stored in `gateway_profile`. The attestation covers definitions, owners, ACLs, constraints, non-internal triggers, indexes, rewrite rules, row-security flags and policies, per-role/database settings for `ppo_*` roles, default ACLs, schema types and operators, every `ppo_*` role attribute and membership, and the members of `pg_write_all_data` and `pg_read_all_data`. Roles outside `ppo_*` are not attested; the seal and the cluster-wide test checks cover their effective privileges instead.

After the seal, registration, configuration, admission, import, ownership, resource and legacy writers are unreachable to every ordinary credential. This is a disposable profile choice, **not** a claim that those writers participate in the gateway. Whole every-writer coverage remains a separate gate.

## Mutation boundary

Each supported operation runs in a fixed order:

1. **Peer.** The transport authenticates the peer by pinned TLS 1.3 SPKI. The coordinator may consume and the administrator may revoke; other peers and services deny.
2. **Connection.** It opens one fresh, exclusively owned `ppo_transport_gateway` connection and probes its exact login, current role and membership.
3. **Gateway serialization.** The gateway admits one witness-mutating path at a time. A concurrent request receives `unavailable` immediately; it is not queued as a delayed mutation.
4. **Witness preflight (no effect).** The gateway reads the external witness. It must be open, with no pending operation, the pinned identity, and the exact incarnation, instance and checkpoint the client expected; client values are expectations, never attestations. The operation and subject must not have been used before, and capacity must remain. It then reads native state in one statement under the shared gate `FOR SHARE`. If the sealed identity, the attestation or the checkpoint differs from the witness, or the DB incarnation floor is not below the witness incarnation (stale restore, clone, foreign owner, copied owner, out-of-band write), it durably quarantines the witness and denies **without reserving**. The checkpoint renders with pinned UTC, ISO and `C` collation, so it does not depend on session settings or the cluster's default collation.
5. **Durable reservation.** The witness fsyncs a reservation. It binds the operation UUID and kind, a kind-separated subject digest (the ticket, or the host plus its expected epoch), and an input digest over the anchor, authority, owner, incarnation, instance, native pre-state checkpoint, subject/detail, the peer identity/pin epoch/fingerprint and the gateway service identity/epoch.
6. **Revalidation at the boundary.** The gateway rereads the exact pending reservation. The transport rechecks both pins before every statement. Inside the mutation transaction, `gateway_boundary`:
   - runs the session guard (`42501` unless this is the sealed login, after `SET ROLE` to its only membership, unprivileged);
   - takes the **same first `gate` row lock** that every canonical, import, ownership, action and resource writer takes;
   - allows one gateway mutation per transaction;
   - checks the live attestation against the sealed one, then the exact binding and the trust domain;
   - requires an incarnation strictly newer than the DB-recorded floor;
   - rejects a reused operation or subject;
   - recomputes the full native checkpoint and requires it to equal the reserved pre-state.

   Only then does it call the private fixed core: `consume_action` plus its pre-commit freshness check, or `configure_action_host` with a policy that PostgreSQL derives itself as current active policy to `revoked`. A client never supplies a policy. Nothing is cached from the preflight.
7. **Atomic receipt.** The receipt (outcome `consumed`, `revoked` or `denied`) and the incarnation floor commit atomically with the effect. A semantic denial, such as an expired action or a revoked host, commits a denial receipt with no effect. A binding, freshness or integrity failure raises, rolls back and leaves the operation latched.
8. **Exact positive evidence.** After `COMMIT`, a fresh statement under `FOR SHARE` reads the receipt only if `pg_xact_status` reports its transaction committed, then its digest, the native tombstone/host row, the checkpoint and the attestation. They must all agree with the pending reservation before the witness records committed evidence. The witness then stays quarantined; another operation needs explicit trusted activation against the witnessed checkpoint. `activateGateway` is a local method, not a network route.

**Cross-store gap.** PostgreSQL cannot read the external witness, and the witness cannot hold a database lock. The two stores are joined by the reserved native checkpoint, which PostgreSQL rechecks under the shared gate inside the mutating transaction. This is what each failure leads to:

| Failure | Result |
| --- | --- |
| Restore or rollback before reservation | Denied by the preflight checkpoint comparison |
| Restore after reservation, before the mutation boundary | The boundary checkpoint differs; that transaction raises and does not commit; the reservation stays latched |
| Restore after the mutation commits, before the positive-evidence read | The receipt may be erased while the effect already happened; the operation stays `unknown` and latched, and the restore proves nothing about noncommit |
| Database loss, or process death after reservation | No positive evidence; the reservation stays latched; a closed witness keeps its persistent lock |
| Old owner or instance | Fails the witness binding and the DB incarnation floor |
| Second witness with a foreign owner | Fails the sealed trust domain before reservation |

A static DB token or epoch alone cannot prove freshness after rollback. The DB incarnation floor is defence in depth only, because a restore rolls it back too.

## Ambiguity, reconciliation and capacity

- **Before the durable reservation**, failure is `denied` and nothing can have mutated.
- **After it**, any failure without exact positive evidence is `unknown`, and the operation stays latched. This covers a lost acknowledgment, a connection lost before `COMMIT`, cancellation, shutdown and missing or contradictory evidence. While latched, further mutations deny, and activation denies with work pending.
- **Reconciliation** (`/v1/gateway/reconcile`) issues only `gateway_receipt`. It never invokes consumption or revocation. It records evidence only when the receipt, the native row, the digests and the reserved pre-state agree exactly. Absence of evidence never proves noncommit.
- **No automatic recovery.** There is no retry, new-ID replay, takeover, stale-lock removal, reset, pruning or post-expiry first effect.
- **Expiry.** Consumption after expiry commits a `denied` receipt. Reconciliation cannot upgrade it, and the consumed subject cannot be retried under a new ID.
- **Revocation is never disabled by a denial.** A revocation with a stale expected epoch commits a `denied` receipt for that (host, epoch) subject only; revoking at the real epoch still works.
- **Capacity.** The gateway denies with `unavailable` before reserving unless at least `GATEWAY_RECORD_RESERVE = 4` witness records remain: reserve, committed evidence, one pin-change quarantine and a clean close. Consumption also leaves room for one emergency revocation (3 more records and 1 operation slot), so consumption alone cannot exhaust it. A restart (2 records) or a pin change after activation (1 record) is not counted in that reserve and can still leave a revocation `unavailable`; a fixed retention/capacity policy remains a separate gate. Each operation still needs an explicit trusted activation, so an administrator can starve a misbehaving coordinator by revoking its pin. Trusted activation likewise requires 3 free records (activation, pin-change quarantine, close). A pin-change quarantine is serialized with activation and is skipped for an already-quarantined witness, so it cannot stale an activation's expected record hash or spend the close record. The existing 128-record and 32-operation laboratory bounds are unchanged. A full journal cannot reopen; nothing prunes or resets it.

## Pins, restart and rotation

TLS pins remain process-local, and durable pin revocation is **not** implemented. The profile therefore disables the unsupported path instead. Any coordinator, administrator or gateway pin change triggers a durable witness quarantine, and only trusted activation against the current checkpoint reopens it. The quarantine waits behind an in-flight gateway operation (the transport cancels attempts by the changed peer), so it can be deferred until that operation finishes. Rotated and revoked pins deny at the transport.

A clean restart reopens the witness quarantined. Old request expectations, old operation IDs and consumed subjects stay denied. Supplying a stale registry at restart is a trusted-administrator custody error, not something this slice detects.

## Effective SQL privilege inventory

Measured by `has_function_privilege`, `has_table_privilege` and `has_schema_privilege` on PostgreSQL 16, over the eight existing modules plus the gateway profile.

**The eight modules:**

| Module | Mutating entrypoints | Read entrypoints | Private, trigger and legacy helpers |
| --- | --- | --- | --- |
| `phase1gb2-canonical-postgres` | `commit_run` | `read_run`, `read_versions` | `refuse_history_mutation` |
| `phase1gb2-synthetic-import` | `import_synthetic_snapshot` | `read_synthetic_archive` | — |
| `phase1gb2-canonical-catalog` | — | `read_catalog_snapshot` | — |
| `phase1gb2-ownership-rehearsal` | `rehearsal_control`, `rehearsal_source_commit`, `rehearsal_target_commit` | `read_rehearsal*`, `rehearsal_observation` | `rehearsal_apply`, `rehearsal_parity`, `rehearsal_source_digest`, `rehearsal_immutable_marker` |
| `phase1gb2c-action-fencing` | `configure_action_host`, `revoke_action_context`, `register_action_context`, `consume_action` | `read_action_snapshot`, `check_action`¹ | `action_bindings_valid`, `action_commit_freshness` (deferred constraint trigger) |
| `phase1gb2c2-resource` | `initialize_resource`, `register_resource_operation`, `apply_resource_operation` | `read_resource_context`, `read_resource_receipt` | `resource_bindings_valid` |
| `phase1gd1-admission` | `certify_admission`; admission wrappers `commit_run` and `import_synthetic_snapshot` | `prepare_admission` (STABLE) | `admission_commit_core`, `admission_import_core` (legacy cores), `require_admission`, `admission_entries`, `admission_pack` |
| `phase1gd1-ownership-admission` | `rehearsal_apply` wrapper | — | `admission_rehearsal_core` |

¹ `check_action` is VOLATILE but only reads.

**Before the seal**, ordinary NOLOGIN roles held these entrypoints:

- `ppo_action_consumer`: `consume_action`, `check_action`
- `ppo_action_admin`: `configure_action_host`, `revoke_action_context`, `initialize_resource`
- `ppo_action_verifier`: `register_action_context`, `read_action_snapshot`
- `ppo_resource_consumer`: `apply_resource_operation`, `check_action`, `read_resource_receipt`
- `ppo_resource_verifier`: `register_resource_operation`, `read_resource_context`
- `ppo_admission_verifier`: `certify_admission`
- the rehearsal roles: their `rehearsal_*` entrypoints and readers
- the reader, writer and importer roles: readers and `prepare_admission`

Every ordinary role had schema `USAGE`. No ordinary role held direct table privileges.

**After the seal:**

- **Every ordinary `ppo_*` role, and every test LOGIN** (one per role, plus a four-membership mixed login): zero `EXECUTE`, zero table read/write, no schema `USAGE`, no `CREATE` here or on `public`. The LOGINs hold no ordinary membership at all.
- **Cluster-wide:** no non-superuser LOGIN of any name can read or write any schema relation or execute any schema function, and no non-superuser, non-predefined role holds `pg_write_all_data` or `pg_read_all_data`.
- **`ppo_authority_gateway`:** exactly the four entrypoints plus `USAGE`, with no table privileges and no memberships.
- **`ppo_transport_gateway`** (NOINHERIT): exactly one membership, `ppo_authority_gateway`.
- **`ppo_authority_owner`:** owns the objects and has no members. It is trusted database administration, not a runtime credential.

The full `ppo_*` per-role inventory before and after the seal is printed in the integration log (`RIC177_PRIVILEGE_INVENTORY_*`).

**Direct attempts.** The suite makes exactly 175 actual LOGIN attempts (asserted), twice: first against the sealed cluster-global membership closure, then again after an administrator temporarily re-grants every ordinary membership, so that `SET ROLE` succeeds and the schema, function and table ACLs alone must deny each call. Only the escalation attempts to the gateway and owner roles still stop at `SET ROLE` in the second pass, and the suite asserts that count. They cover every pre-seal entrypoint of every ordinary role, raw consume/configure, table and gate writes, gateway entrypoints, escalation to the gateway or owner role, a mixed-role transaction, and the gateway LOGIN calling private cores, helpers, legacy writers, tables, the seal, or anything without `SET ROLE`. All fail with `42501`, and the checkpoint is unchanged. When an administrator temporarily re-grants an ordinary membership, the schema and function ACL layer still denies raw consume and configure with `42501`.

**Escalation by membership change.** Granting the gateway role to an ordinary login is denied by the session guard. The attestation change also makes the gateway refuse activation. Adding a membership to the gateway login is rejected by the transport probe; the test asserts the connection issued only the probe.

## Tested guarantees versus remaining assumptions

All tests below use actual disposable PostgreSQL 16, actual NOINHERIT LOGIN sessions, actual `pg_dump`/restore/`CREATE DATABASE` clone, real loopback TLS 1.3 mutual authentication with disposable certificates, and the real on-disk witness. The integration suite has 14 cases.

| Area | Tested |
| --- | --- |
| Causal control and seal | Unsealed bypass reproduction; sealed inventory and 175 direct denials |
| Exactly-once operation | Peer separation, replay, same/new operation ID and restart replay |
| Restore and clone | Stale restore, pre-seal image restore, clone, foreign owner |
| Pins and revocation | Rotated and revoked pins, durable quarantine; stale-epoch revocation denial followed by a successful real revocation |
| Concurrency | Concurrent requests; two copied-identity owners both observed waiting at the actual gate (exactly one effect, the loser latched `unknown`); a concurrent raw writer |
| Expiry and delay | Post-reservation expiry; delayed older-incarnation requests |
| Ambiguity | Lost acknowledgment with read-only reconciliation; loss before `COMMIT`; contradictory evidence; restore that loses the positive outcome |
| Shutdown and capacity | Shutdown that disposes the actual blocked backend without commit; revocation and closure capacity reserve |

Cases assert the native tombstone, receipt or host state relevant to them. The cases that run gateway mutations also assert exact `COMMIT` counts where the count is the property under test, and drain to opened-equals-disposed session counts. The causal control uses no gateway sessions.

**Assumed, not exercised:**

- **Database authentication and custody.** Container socket `trust` authentication stands in for real database authentication. Production database credentials, OS/service-account separation and key custody are untested.
- **Privileged actors.** A superuser or DB administrator, a privileged host compromise, theft of the `ppo_transport_gateway` credential or a gateway TLS key, or a copied witness directory/identity can bypass or confuse the gateway. Copied identity is exercised only to show at most one effect. The gateway cannot detect a forged binding from a stolen gateway credential against a restored database.
- **Restore scope.** The pre-seal restore case restores a schema image only. A whole-cluster restore of pre-seal globals (role memberships), or a pre-seal image whose ACLs grant directly to a LOGIN-capable role, would bring the bypass back; both are administrator actions. Evidence reads use `pg_xact_status`, so a receipt restored into a different cluster, or older than the commit-log horizon, reads as missing or raises and stays `unknown` (fails closed).
- **Attestation scope.** Event triggers, casts, extensions, settings of non-`ppo_` roles and members of `pg_signal_backend` are not attested; a `pg_signal_backend` member could terminate the gateway backend after reservation, which leaves the operation latched `unknown`. Global default ACLs and database settings are not part of a `--schema` dump, so a cross-cluster restore attests differently and fails closed.
- **Witness storage.** The witness directory is assumed to sit outside every database rollback domain and never be rolled back, with fsync semantics on suitable storage.
- **Clocks and budgets.** The PostgreSQL `clock_timestamp()` checks are unchanged diagnostic samples. There is no new clock or uncertainty policy and no production budget. The strict commit/acknowledgment freshness blocker is unchanged.
- **Race windows.** A pin revocation that races an already-dispatched statement is not an instantaneous cutoff.

## Residual blockers

These remain separate gates:

- the M-03 measured budgets;
- whole every-writer participation (registration, admission, import, ownership, resource, stop/cancel), instead of disabling those writers;
- durable authenticated pin revocation and rotation;
- an approved recovery/takeover protocol for a latched owner;
- a concrete clock/uncertainty policy;
- native resource fences (Batch 2D);
- production custody and database authentication;
- capacity and retention policy beyond the laboratory bounds.

Actual hosts, connectivity, enrollment, live credentials, dispatch, migration, deployment, retirement, hold release and any pilot remain unauthorized. No merge without separate owner approval.
