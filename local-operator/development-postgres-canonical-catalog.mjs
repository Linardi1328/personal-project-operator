import { isDeepStrictEqual } from "node:util"
import { rehearseSyntheticMigrationPreflight } from "./development-migration-preflight.mjs"
import { parseDevelopmentRunRecord, DEVELOPMENT_RUN_ID_PATTERN, isDevelopmentRunTerminalStatus } from "./development-run-state.mjs"
import { DEVELOPMENT_RUN_CATALOG_ID, MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES } from "./development-run-catalog.mjs"

const MODE="isolated-postgres-canonical-catalog"
const READ="SELECT ppo_authority.read_catalog_snapshot() AS snapshot"
const MAX_BYTES=32*1024*1024
const validRevision=r=>typeof r==="string"&&/^(0|[1-9][0-9]{0,18})$/u.test(r)&&BigInt(r)<=9223372036854775807n
const keys=(v,k)=>v&&typeof v==="object"&&!Array.isArray(v)&&isDeepStrictEqual(Object.keys(v).sort(),k.sort())
const failure=(code,revision=null,invalid=0)=>({ok:false,code,revision,summaries:[],summary:null,
  diagnostics:{invalid,truncated:code==="catalog_truncated"}})
const summary=r=>({schemaVersion:1,catalog:DEVELOPMENT_RUN_CATALOG_ID,runId:r.runId,project:r.project.id,
  status:r.status,stage:r.stage,version:r.version,baseSha:r.baseSha,headSha:r.headSha,
  createdAt:r.timestamps.createdAt,updatedAt:r.timestamps.updatedAt,
  terminal:isDevelopmentRunTerminalStatus(r.status),canonicalState:"canonical_current",recoveryRequired:false})
const order=(a,b)=>Number(a.terminal)-Number(b.terminal)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||a.runId.localeCompare(b.runId)

// Compare native decimal values before binary64 rounding can conceal a
// changed database value. JSON syntax is checked first. Strings stay strings;
// numeric tokens become canonical coefficient/exponent strings for deep
// comparison independent of key order and PostgreSQL's expanded notation.
function exactNumbers(serialized){
  JSON.parse(serialized)
  return JSON.parse(serialized.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/gu,token=>{
    if(token.startsWith('"'))return token
    const [mantissa,exponent="0"]=token.toLowerCase().split("e")
    const negative=mantissa.startsWith("-")
    const unsigned=negative?mantissa.slice(1):mantissa
    const fraction=unsigned.includes(".")?unsigned.length-unsigned.indexOf(".")-1:0
    const coefficient=unsigned.replace(".","").replace(/^0+/u,"")
    if(!coefficient)return '"decimal:0"'
    const digits=coefficient.replace(/0+$/u,"")
    const power=BigInt(exponent)-BigInt(fraction)+BigInt(coefficient.length-digits.length)
    return JSON.stringify("decimal:"+(negative?"-":"")+digits+"e"+power)
  }))
}

// Explicit synthetic read seam. No environment, filesystem or production
// callers. The transport executes this exact statement with parameter binding,
// read-committed autocommit, and a bounded response; never retries/falls back.
export function createPostgresCanonicalCatalog({mode,query}={}){
  if(mode!==MODE||typeof query!=="function")throw Error("Isolated canonical catalog required.")
  async function observe(expectedRevision){
    if(expectedRevision!==undefined&&!validRevision(expectedRevision))return failure("stale_observation")
    let snapshot
    try{
      const result=await query(READ,[])
      if(!Array.isArray(result?.rows)||result.rows.length!==1||!keys(result.rows[0],["snapshot"]))throw Error()
      snapshot=result.rows[0].snapshot
      if(!keys(snapshot,["revision","code","entries"])||!validRevision(snapshot.revision)||
        !Array.isArray(snapshot.entries)||snapshot.entries.length>10100||
        Buffer.byteLength(JSON.stringify(snapshot))>MAX_BYTES)throw Error()
    }catch{return failure("store_unavailable")}
    const {revision,code}=snapshot
    let entries=snapshot.entries
    if(expectedRevision!==undefined&&revision!==expectedRevision)return failure("stale_observation",revision)
    if(code==="catalog_truncated"&&entries.length===0)return failure(code,revision)
    if(code!=="ok")return failure("store_unavailable")
    let manifest,records
    try{
      let bytes=0
      entries=entries.map(e=>{
        if(!keys(e,["path","serialized"])||typeof e.path!=="string"||typeof e.serialized!=="string")throw Error()
        const record=JSON.parse(e.serialized)
        const serialized=JSON.stringify(record)
        const normalized=parseDevelopmentRunRecord(serialized)
        // Never discard extensions, malformed original values or normalization
        // loss from the canonical database before validating the full chain.
        if(!isDeepStrictEqual(normalized,record)||!isDeepStrictEqual(exactNumbers(e.serialized),exactNumbers(JSON.stringify(normalized))))throw Error()
        return {path:e.path,record:normalized}
      })
      const inventory=entries.map(e=>{
        const buffer=Buffer.from(JSON.stringify(e.record))
        bytes+=buffer.length
        if(bytes>MAX_BYTES)throw Error()
        return {relativePath:e.path,bytes:buffer}
      })
      manifest=rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:inventory})
      if(manifest.diagnostics.invalid||manifest.unknown.length)throw Error()
      records=entries.filter(e=>e.path.startsWith("records/")).map(e=>e.record)
      if(manifest.diagnostics.duplicateActiveProject||manifest.diagnostics.overWipLimit)return failure("catalog_invalid",revision,1)
    }catch{return failure("catalog_invalid",revision,1)}
    if(manifest.diagnostics.legacyCatalogTruncated||records.length>MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES)return failure("catalog_truncated",revision)
    return {ok:true,code:"ok",revision,records,entries,summaries:records.map(summary).sort(order),diagnostics:{invalid:0,truncated:false}}
  }
  async function list({expectedRevision}={}){
    const result=await observe(expectedRevision)
    if(!result.ok)return result
    const {records,entries,...catalog}=result
    return {...catalog,active:catalog.summaries.filter(s=>!s.terminal),terminal:catalog.summaries.filter(s=>s.terminal)}
  }
  async function inspect(runId,{expectedRevision}={}){
    if(typeof runId!=="string"||!DEVELOPMENT_RUN_ID_PATTERN.test(runId))return failure("invalid_run_id")
    const result=await observe(expectedRevision)
    if(!result.ok)return result
    const record=result.records.find(r=>r.runId===runId)
    if(!record)return failure("run_not_found",result.revision)
    const versions=result.entries.filter(e=>e.path.startsWith("versions/"+runId+"/")).map(e=>e.record).sort((a,b)=>a.version-b.version)
    return {ok:true,code:"canonical_current",revision:result.revision,summary:summary(record),record,versions,diagnostics:result.diagnostics}
  }
  return Object.freeze({list,inspect})
}
