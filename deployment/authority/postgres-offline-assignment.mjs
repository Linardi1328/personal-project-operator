import { createHash, KeyObject } from "node:crypto"
import { certifyCatalogMutation } from "../../local-operator/development-catalog-certified-query.mjs"
import { createPostgresCanonicalAuthority } from "../../local-operator/development-postgres-canonical-authority.mjs"
import { createPostgresCanonicalCatalog } from "../../local-operator/development-postgres-canonical-catalog.mjs"
import { createIsolatedCanonicalRunState } from "../../local-operator/development-run-state.mjs"
import { resolveSoftwareFactoryTaskRole } from "../../local-operator/software-factory-plan-contract.mjs"
import { serializeRemoteAssignment, verifyRemoteEnvelope } from "../../local-operator/software-factory-remote-contract.mjs"
import { isValidOfflineAssignmentProjectAllowlist, preflightOfflineAssignment } from "../../local-operator/war-room-assignment-preflight.mjs"

const MODE = "disposable-postgres-offline-assignment"
const SIGNER = "ppo-control-plane"
const ACTOR = "postgres-offline-assignment-bind"
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const HASH = /^[a-f0-9]{64}$/u
const FLAGS = Object.freeze({ grant: false, canExecute: false, releaseAuthorized: false })
const digest = value => createHash("sha256").update(value).digest("hex")

export const OFFLINE_ASSIGNMENT_SQL = Object.freeze({
  bind: "SELECT ppo_authority.bind_offline_assignment($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text) AS accepted",
  observe: "SELECT ppo_authority.read_offline_assignment($1::uuid,$2::text,$3::text,$4::integer,$5::text) AS receipt"
})

function failure(code, observation) {
  const error = new Error("Disposable PostgreSQL assignment: " + code + ".")
  error.code = code
  if (observation) error.observation = observation
  return error
}

function column(result, name) {
  if (!Array.isArray(result?.rows) || result.rows.length !== 1 || !Object.hasOwn(result.rows[0] ?? {}, name)) {
    throw failure("OFFLINE_ASSIGNMENT_RESPONSE_INVALID")
  }
  return result.rows[0][name]
}

function pinnedAuthority({ mode, authorityId, coordinatorPublicKey, readerQuery } = {}) {
  if (mode !== MODE || typeof authorityId !== "string" || !UUID.test(authorityId) ||
      !(coordinatorPublicKey instanceof KeyObject) || coordinatorPublicKey.type !== "public" ||
      coordinatorPublicKey.asymmetricKeyType !== "ed25519" || typeof readerQuery !== "function") {
    throw failure("OFFLINE_ASSIGNMENT_CONFIG_INVALID")
  }
  const keyHash = digest(coordinatorPublicKey.export({ type: "spki", format: "der" }))
  function authenticate(signed) {
    try {
      const payload = verifyRemoteEnvelope(signed, SIGNER, coordinatorPublicKey)
      const { request, scope } = serializeRemoteAssignment(payload)
      return { payload, request, scope, requestHash: digest(request), scopeHash: digest(scope) }
    } catch {
      throw failure("OFFLINE_ASSIGNMENT_SIGNATURE_INVALID")
    }
  }
  return { authorityId, keyHash, authenticate }
}

/**
 * Read-only reconciliation from a separately scoped reader, including after
 * restart. Absence describes the current observation and never permits retry.
 */
export function createPostgresOfflineAssignmentObserver(config) {
  const { authorityId, keyHash, authenticate } = pinnedAuthority(config)
  const { readerQuery } = config
  return async function observe(signed) {
    const { payload, requestHash } = authenticate(signed)
    const { runId, expectedVersion } = payload
    try {
      const receipt = column(await readerQuery(OFFLINE_ASSIGNMENT_SQL.observe,
        [authorityId, keyHash, runId, expectedVersion, requestHash]), "receipt")
      if (receipt === null) return Object.freeze({ outcome: "unobserved", runId, expectedVersion, requestHash, ...FLAGS })
      if (receipt.version !== expectedVersion + 1 || typeof receipt.historyHash !== "string" || !HASH.test(receipt.historyHash)) {
        throw failure("OFFLINE_ASSIGNMENT_RESPONSE_INVALID")
      }
      return Object.freeze({ outcome: "bound-offline", runId, expectedVersion, requestHash,
        version: receipt.version, historyHash: receipt.historyHash, ...FLAGS })
    } catch {
      throw failure("OFFLINE_ASSIGNMENT_OBSERVATION_UNAVAILABLE")
    }
  }
}

/**
 * Trusted composition for the standalone disposable profile. The three
 * transports are pre-bound to distinct server roles on the same authority.
 * commitQuery executes the one bind statement in autocommit and resolves
 * only after acknowledged commit. Never expose its role or SQL to callers.
 */
export function createPostgresOfflineAssignmentBinder(config) {
  const { authorityId, keyHash, authenticate } = pinnedAuthority(config)
  const { readerQuery, verifierQuery, commitQuery, coordinatorPublicKey, approvedProjects, now,
    readIssue, resolveIssueProject, readRepo, verifyOwnerApproval } = config
  if (!isValidOfflineAssignmentProjectAllowlist(approvedProjects) ||
      [verifierQuery, commitQuery, now, readIssue, resolveIssueProject, readRepo, verifyOwnerApproval]
        .some(callback => typeof callback !== "function")) throw failure("OFFLINE_ASSIGNMENT_CONFIG_INVALID")
  const projects = Object.freeze([...approvedProjects])
  const reader = createPostgresCanonicalAuthority({ mode: "isolated-postgres-canonical-authority", query: readerQuery })
  const catalogReader = createPostgresCanonicalCatalog({ mode: "isolated-postgres-canonical-catalog", query: readerQuery })

  return async function bind(signed) {
    const { payload, request, scope, requestHash, scopeHash } = authenticate(signed)
    const { runId, expectedVersion } = payload
    const envelope = Object.freeze({ signerId: SIGNER, payload, signature: signed.signature })
    let run, catalog
    await preflightOfflineAssignment(envelope, {
      mode: "offline-preflight-only", coordinatorPublicKey, approvedProjects: projects, now,
      readIssue, resolveIssueProject, readRepo, verifyOwnerApproval, resolveRole: resolveSoftwareFactoryTaskRole,
      readRun: async id => (run = await reader.readRun(id)),
      readCatalogAdmission: async () => ({ valid: (catalog = await catalogReader.list()).ok }),
      listActiveProjects: () => catalog.active.map(entry => entry.project)
    })

    const observation = Object.freeze({ runId, expectedVersion, requestHash })
    let submitted = false
    const authority = {
      readRun: () => run,
      async commitRecord(serialized, version, historyHash) {
        const valid = await certifyCatalogMutation({
          query: readerQuery, verifierQuery, kind: "direct",
          payload: { serialized, expectedVersion: version, expectedHash: historyHash }
        })
        if (!valid) return false
        submitted = true
        const accepted = column(await commitQuery(OFFLINE_ASSIGNMENT_SQL.bind,
          [authorityId, SIGNER, keyHash, request, scope, historyHash, serialized]), "accepted")
        if (accepted !== true && accepted !== false) throw failure("OFFLINE_ASSIGNMENT_RESPONSE_INVALID")
        return accepted
      }
    }
    const state = createIsolatedCanonicalRunState({ mode: "isolated-postgres-canonical-authority", authority, now })
    try {
      const bound = await state.progress(runId, {
        expectedVersion, status: "implementation_in_progress", actor: ACTOR,
        evidence: [{
          kind: "planning", sha: payload.headSha, source: ACTOR, summary: "Bound a synthetic PostgreSQL assignment reservation.",
          metadata: { requestHash, scopeHash, signerId: SIGNER, coordinatorKeyHash: keyHash,
            ownerId: payload.approval.ownerId, approvalId: payload.approval.approvalId,
            issueRevisionHash: payload.taskSource.revisionHash, reservedVersion: expectedVersion }
        }]
      })
      return Object.freeze({ outcome: "bound-offline", ...observation, version: bound.version,
        historyHash: bound.historyHash, ...FLAGS })
    } catch (error) {
      if (error.code === "AUTHORITY_COMMIT_UNKNOWN") {
        throw submitted ? failure("OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN", observation) : failure("OFFLINE_ASSIGNMENT_UNAVAILABLE")
      }
      if (error.code === "AUTHORITY_COMMIT_REJECTED") throw failure("OFFLINE_ASSIGNMENT_DENIED")
      throw error
    }
  }
}
