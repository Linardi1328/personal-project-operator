import { parseUniqueJson } from "./unique-json.mjs"
import {
  normalizeDevelopmentRunId, parseDevelopmentRunRecord, MAX_DEVELOPMENT_RUN_RECORD_BYTES
} from "./development-run-state.mjs"

// Phase 1G-B2a: trusted server storage seam, not an execution API.
// The client is an injected, parameter-binding PostgreSQL driver. No DSN,
// environment fallback, file-store mirroring or production wiring.
const MODE = "isolated-postgres-canonical-authority"
const TASK_PREFIX = "RIC-157 shared authority synthetic:"
const HASH = /^[a-f0-9]{64}$/u
const COMMIT = "SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::text) AS accepted"
const READ = "SELECT ppo_authority.read_run($1::text) AS record"
const HISTORY = "SELECT ppo_authority.read_versions($1::text) AS records"

function deny() { throw new Error("Canonical authority unavailable or invalid.") }
function postgresCompatible(value) {
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\u0000")
  if (value && typeof value === "object") return Object.entries(value).every(([key,entry]) => postgresCompatible(key) && postgresCompatible(entry))
  return true
}
function validate(serialized, id = null) {
  if (typeof serialized !== "string") deny()
  // Fresh canonical submissions must be unambiguous. Legacy filesystem/raw
  // archive parsing retains its separately documented last-key-wins contract.
  parseUniqueJson(serialized,{maxBytes:MAX_DEVELOPMENT_RUN_RECORD_BYTES})
  const r = parseDevelopmentRunRecord(serialized, id)
  const last = r.history.at(-1)
  // Retain exact Git-ref binding even if the underlying record parser does
  // not compare these summary fields with the final history event.
  if (!r.task.startsWith(TASK_PREFIX) || r.branch !== last.branch ||
      r.headSha !== last.headSha ||
      r.history.some(event => event.project !== r.project.id || event.repo !== r.project.fullName) ||
      !postgresCompatible(r) || Buffer.byteLength(JSON.stringify(r),"utf8") > MAX_DEVELOPMENT_RUN_RECORD_BYTES) deny()
  return r
}
function one(result) {
  if (!Array.isArray(result?.rows) || result.rows.length !== 1) deny()
  return result.rows[0]
}

export function createPostgresCanonicalAuthority({mode, query} = {}) {
  if (mode !== MODE || typeof query !== "function") deny()
  async function commitRecord(serialized, expectedVersion, expectedHistoryHash) {
    const r = validate(serialized)
    if (!Number.isInteger(expectedVersion) || expectedVersion < -1 ||
        expectedVersion >= 99 || r.version !== expectedVersion + 1 ||
        (expectedVersion === -1 ? expectedHistoryHash !== null :
          typeof expectedHistoryHash !== "string" || !HASH.test(expectedHistoryHash))) deny()
    // Re-serialize the normalized, validated snapshot. The DB writer is
    // trusted; ordinary clients must never receive this role or query seam.
    // query must resolve only after acknowledged autocommit or COMMIT.
    // A function result from an open transaction is NOT a committed result.
    // Unknown acknowledgment propagates; no automatic retry or file fallback.
    const row = one(await query(COMMIT,[r.runId,expectedVersion,expectedHistoryHash,JSON.stringify(r)]))
    if (row.accepted !== true && row.accepted !== false) deny()
    return row.accepted
  }
  async function readRun(runId) {
    const id = normalizeDevelopmentRunId(runId)
    const row = one(await query(READ,[id]))
    return row.record === null ? null : validate(JSON.stringify(row.record),id)
  }
  async function readVersions(runId) {
    const id = normalizeDevelopmentRunId(runId)
    const row = one(await query(HISTORY,[id]))
    if (!Array.isArray(row.records) || row.records.length > 100) deny()
    const records = row.records.map((r,i)=>{
      const parsed = validate(JSON.stringify(r),id)
      if (parsed.version !== i) deny()
      return parsed
    })
    for (let i=1;i<records.length;i++){
      const current=records[i], prior=records[i-1]
      if (current.history[i].previousHistoryHash !== prior.historyHash ||
          JSON.stringify(current.history.slice(0,i)) !== JSON.stringify(prior.history)) deny()
    }
    return records
  }
  return Object.freeze({commitRecord,readRun,readVersions})
}
