import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  MAX_DEVELOPMENT_RUN_RECORD_BYTES, MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES,
  parseDevelopmentRunRecord, isDevelopmentRunTerminalStatus
} from "./development-run-state.mjs"
import {
  MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED, MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES
} from "./development-run-catalog.mjs"
import { softwareFactoryRunConsumesWip } from "./software-factory-admission.mjs"

// B2b2a: pure, bounded source preflight. No filesystem, DB, environment,
// live export, repair, import, or authority-switch interface.
const MODE = "synthetic-migration-preflight-only"
const TASK_PREFIX = "RIC-157 shared authority synthetic:"
const MAX_FILES = MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED * (MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES + 1)
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const RECORD = /^records\/([A-Za-z0-9_-]{43})\.json$/u
const MARKER = /^versions\/([A-Za-z0-9_-]{43})\/([0-9]{6})\.json$/u
const sha = value => createHash("sha256").update(value).digest("hex")
const decoder = new TextDecoder("utf-8", {fatal:true,ignoreBOM:true})
const hashJSON = value => sha(JSON.stringify(value))
function reject() { throw new Error("Synthetic migration snapshot unavailable or exceeds preflight bounds.") }

function compatible(value) {
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\u0000")
  if (value && typeof value === "object") return Object.entries(value).every(([k,v]) => compatible(k) && compatible(v))
  return true
}
function parse(bytes, runId) {
  const source = decoder.decode(bytes)
  // Preserve the raw archive's last-key-wins value contract, but inspect
  // every original literal for unsupported encoding, even overwritten ones.
  // Canonical text transports enforce unique names at their own boundary.
  JSON.parse(source)
  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"/gsu)) {
    if (!compatible(JSON.parse(match[0]))) return {code:"unsupported_encoding"}
  }
  const r = parseDevelopmentRunRecord(source,runId)
  if (!r.task.startsWith(TASK_PREFIX)) return {code:"out_of_scope"}
  if (!compatible(r)) return {code:"unsupported_encoding"}
  const last=r.history.at(-1)
  if (r.branch!==last.branch || r.headSha!==last.headSha ||
      r.history.some(event=>event.project!==r.project.id||event.repo!==r.project.fullName)) {
    return {code:"history_identity_conflict"}
  }
  return {record:r}
}
function classification(group) {
  const markers=[...group.markers.values()].sort((a,b)=>a.version-b.version)
  const canonical=group.canonical
  const result={runId:group.runId,code:"canonical_current",recoveryRequired:false,
    canonical:canonical?.provenance??null,markers:markers.map(m=>m.provenance),
    latest:null}
  const stop=code=>({...result,code,recoveryRequired:true})
  if (group.duplicate) return stop("duplicate_path")
  if ([canonical,...markers].some(x=>x?.code==="out_of_scope")) return stop("out_of_scope")
  if ([canonical,...markers].some(x=>x?.code==="unsupported_encoding")) return stop("unsupported_encoding")
  if ([canonical,...markers].some(x=>x?.code==="history_identity_conflict")) return stop("history_identity_conflict")
  if (canonical?.code || markers.some(m=>m.code)) return stop("record_invalid")
  if (markers.length===0) return stop("marker_missing")
  if (markers.some((m,i)=>m.version!==i||m.record.version!==i)) return stop("marker_gap_or_version_mismatch")
  for(let i=1;i<markers.length;i++){
    const prior=markers[i-1].record,next=markers[i].record
    if (next.history[i].previousHistoryHash!==prior.historyHash ||
        !isDeepStrictEqual(next.history.slice(0,i),prior.history) ||
        !isDeepStrictEqual(next.project,prior.project) ||
        next.task!==prior.task || next.baseSha!==prior.baseSha ||
        next.timestamps.createdAt!==prior.timestamps.createdAt) return stop("marker_history_conflict")
  }
  const latest=markers.at(-1).record
  result.latest={version:latest.version,historyHash:latest.historyHash,projectId:latest.project.id,
    status:latest.status,terminal:isDevelopmentRunTerminalStatus(latest.status)}
  if (!canonical) return stop("canonical_missing")
  if (!markers[canonical.record.version] ||
      !isDeepStrictEqual(canonical.record,markers[canonical.record.version].record)) return stop("canonical_conflict")
  if (canonical.record.version!==latest.version) return stop("canonical_behind")
  return result
}

/**
 * Caller supplies a complete immutable file inventory from an isolated
 * synthetic snapshot, relative to development-runs/. No paths are opened.
 * Exact bytes are hashed before parsing. Completeness of the source inventory
 * and quiescence are NOT established by this function.
 */
export function rehearseSyntheticMigrationPreflight({mode,entries}={}) {
  if(mode!==MODE||!Array.isArray(entries)||entries.length>MAX_FILES)reject()
  let totalBytes=0
  const groups=new Map(), seen=new Set(), inventory=[], unknown=[]
  for(let index=0;index<entries.length;index++){
    const entry=entries[index]
    if(!entry||typeof entry.relativePath!=="string"||entry.relativePath.length>240||!entry.relativePath.isWellFormed()||
        !Buffer.isBuffer(entry.bytes)||entry.bytes.length>MAX_DEVELOPMENT_RUN_RECORD_BYTES)reject()
    const path=entry.relativePath,bytes=Buffer.from(entry.bytes)
    totalBytes+=bytes.length
    if(totalBytes>MAX_TOTAL_BYTES)reject()
    // Do not emit arbitrary path names or raw content even for invalid files.
    const provenance={pathHash:sha(path),sha256:sha(bytes),byteLength:bytes.length}
    inventory.push(provenance)
    const duplicate=seen.has(path)
    seen.add(path)
    const exact=pattern=>{const m=pattern.exec(path);return m?.[0]===path?m:null}
    const canonical=exact(RECORD),marker=exact(MARKER)
    if(!canonical&&!marker){
      unknown.push({...provenance,code:duplicate?"duplicate_unknown_path":"unrecognized_entry"})
      continue
    }
    const runId=(canonical||marker)[1]
    if(!groups.has(runId))groups.set(runId,{runId,canonical:null,markers:new Map(),duplicate:false})
    if(groups.size>MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED)reject()
    const group=groups.get(runId)
    if(duplicate){group.duplicate=true;continue}
    let decoded
    try{decoded=parse(bytes,runId)}catch{decoded={code:"record_invalid"}}
    if(canonical)group.canonical={...decoded,provenance}
    else{
      const version=Number(marker[2])
      group.markers.set(version,{...decoded,version,provenance:{...provenance,version}})
    }
  }
  // Ordinal ASCII, identical to PostgreSQL COLLATE "C" for hex digests.
  const ascii=(a,b)=>a<b?-1:a>b?1:0
  const order=(a,b)=>ascii(a.pathHash,b.pathHash)||ascii(a.sha256,b.sha256)||a.byteLength-b.byteLength
  inventory.sort(order)
  unknown.sort(order)
  const runs=[...groups.values()].map(classification).sort((a,b)=>ascii(a.runId,b.runId))
  const active=runs.filter(r=>r.latest&&softwareFactoryRunConsumesWip(r.latest))
  const projects=[...new Set(active.map(r=>r.latest.projectId))].sort()
  const invalid=runs.filter(r=>r.code!=="canonical_current").length
  const legacyCatalogTruncated=runs.length>MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES
  const duplicateActiveProject=active.length!==projects.length
  const overWipLimit=projects.length>2
  const emptyInventory=inventory.length===0
  const readyForRehearsal=!emptyInventory&&invalid===0&&unknown.length===0&&!legacyCatalogTruncated&&!duplicateActiveProject&&!overWipLimit
  return {
    schemaVersion:1,mode:MODE,
    // This digest binds only supplied file identities and exact byte hashes.
    // It is not a source completeness assertion, signature or approval.
    inventoryHash:hashJSON(inventory),
    fileCount:inventory.length,totalBytes,inventory,runs,unknown,
    diagnostics:{runs:runs.length,invalid,unknown:unknown.length,emptyInventory,legacyCatalogTruncated,
      activeProjects:projects,duplicateActiveProject,overWipLimit},
    readyForRehearsal,importAuthorized:false,cutoverAuthorized:false
  }
}
