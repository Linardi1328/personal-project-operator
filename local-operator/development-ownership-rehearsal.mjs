import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { captureSyntheticMigrationRehearsal, createSyntheticMigrationImporter } from "./development-migration-rehearsal.mjs"
import { rehearseSyntheticMigrationPreflight } from "./development-migration-preflight.mjs"
import { createPostgresCanonicalAuthority } from "./development-postgres-canonical-authority.mjs"
import { createPostgresCanonicalCatalog } from "./development-postgres-canonical-catalog.mjs"
import { createIsolatedCanonicalRunState } from "./development-run-state.mjs"

const MODE="synthetic-ownership-cutover-rehearsal-only"
const IMPORT_MODE="synthetic-migration-import-rehearsal-only"
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const HASH=/^[a-f0-9]{64}$/u
const uuid=v=>typeof v==="string"&&UUID.test(v)
const hash=v=>typeof v==="string"&&HASH.test(v)
const decimal=(s,max)=>typeof s==="string"&&/^(0|[1-9][0-9]{0,18})$/u.test(s)&&BigInt(s)<=max
const generation=s=>decimal(s,1000000000n)&&s!=="0"
const revision=s=>decimal(s,9223372036854775807n)
const sha=s=>createHash("sha256").update(s).digest("hex")
export const OWNERSHIP_REHEARSAL_SQL=Object.freeze({
  control:"SELECT ppo_authority.rehearsal_control($1::text) AS evidence",
  source:"SELECT ppo_authority.rehearsal_source_commit($1::text) AS evidence",
  target:"SELECT ppo_authority.rehearsal_target_commit($1::text) AS evidence",
  read:"SELECT ppo_authority.read_rehearsal() AS observation",
  sourceRead:"SELECT ppo_authority.read_rehearsal_source() AS observation",
  receipt:"SELECT ppo_authority.read_rehearsal_receipt($1::uuid,$2::text) AS evidence"
})
const SQL=OWNERSHIP_REHEARSAL_SQL
function deny(code="REHEARSAL_DENIED") {const e=Error("Synthetic ownership rehearsal denied or unavailable.");e.code=code;throw e}
function one(result,key){if(!Array.isArray(result?.rows)||result.rows.length!==1||!Object.hasOwn(result.rows[0],key))deny();return result.rows[0][key]}
function validateEvidence(e,d){
  if(!e||Buffer.byteLength(JSON.stringify(e))>4096||e.operationId!==d.operationId||e.requestHash!==d.requestHash||e.action!==d.action||
    typeof e.accepted!=="boolean"||!uuid(e.sourceId)||e.targetId!==d.targetId||!generation(e.generation)||!revision(e.revision)||
    !hash(e.manifest)||typeof e.imported!=="boolean")deny()
  const increment=["freeze","activate","abort"].includes(d.action)?1n:0n
  if(BigInt(e.generation)!==BigInt(d.generation)+increment||d.action!=="seed"&&e.sourceId!==d.sourceId)deny()
  const phases={seed:["source"],source_commit:["source","aborted"],target_commit:["target"],freeze:["held"],import:["held"],activate:["target"],abort:["aborted"]}
  if(!phases[d.action]?.includes(e.phase)||(["source","target","aborted"].includes(e.phase)?!uuid(e.key):e.key!==null))deny()
  if(["held","target","aborted"].includes(e.phase)&&(!uuid(e.fence)||!uuid(e.attempt)))deny()
  if(e.phase==="source"&&(e.fence!==null||e.attempt!==null||e.imported!==false))deny()
  if(["seed","freeze"].includes(d.action)&&e.imported!==false)deny()
  if(["import","activate","target_commit"].includes(d.action)&&e.imported!==true)deny()
  if(d.action!=="source_commit"&&e.manifest!==d.manifest)deny()
  if(d.action==="freeze"&&e.attempt!==d.operationId)deny()
  if(["import","activate","abort"].includes(d.action)&&(e.attempt!==d.attempt||e.fence!==d.fence))deny()
  return structuredClone(e)
}
// Trusted injected transport executes only these fixed statements, with bound
// parameters and acknowledged COMMIT. Receipt reads must be independent fresh
// autocommit reads, not an old/open transaction or cached response. No driver,
// DSN, environment, filesystem routing or production capability is installed.
export function createSyntheticOwnershipRehearsal({mode,query}={}){
  if(mode!==MODE||typeof query!=="function")deny()
  let permit=null,uncertain=null,last=null,viewVersion=0
  const submitted=new Set()
  async function observe(withTarget=true){
    const o=one(await query(withTarget?SQL.read:SQL.sourceRead,[]),"observation")
    if(!o||Buffer.byteLength(JSON.stringify(o))>40*1024*1024||!o.owner||!uuid(o.owner.target_id)||
      !generation(o.owner.generation)||typeof o.owner.imported!=="boolean"||!revision(o.revision)||!Array.isArray(o.files)||o.files.length>2100||
      !["empty","source","held","target","aborted"].includes(o.owner.phase)||(withTarget?typeof o.parity!=="boolean":o.parity!==null||o.catalog!==null))deny()
    if(permit&&(o.owner.target_id!==permit.targetId||o.owner.source_id!==permit.sourceId))deny("AUTHORITY_REPLACED")
    let bytes=0
    const entries=o.files.map(f=>{
      if(typeof f.path!=="string"||typeof f.bytesBase64!=="string")deny()
      const b=Buffer.from(f.bytesBase64,"base64");bytes+=b.length
      if(bytes>4*1024*1024||b.toString("base64")!==f.bytesBase64)deny()
      return {relativePath:f.path,bytes:b}
    })
    if(o.owner.phase!=="empty"){
      if(!uuid(o.owner.source_id)||!hash(o.digest)||o.digest!==o.owner.manifest)deny()
      const manifest=rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries})
      if(!manifest.readyForRehearsal||manifest.inventoryHash!==o.digest)deny("SOURCE_INVALID")
    }else if(entries.length!==0||o.owner.source_id!==null)deny()
    if(withTarget){
      const catalog=await createPostgresCanonicalCatalog({mode:"isolated-postgres-canonical-catalog",query:async()=>({rows:[{snapshot:o.catalog}]})}).list()
      if(!catalog.ok||catalog.revision!==o.revision)deny("CATALOG_INVALID")
    }
    return structuredClone(o)
  }
  async function apply(action,fields,operationId=randomUUID(),allowAbort=false){
    if(uncertain&&!allowAbort)deny("REHEARSAL_UNCERTAIN")
    if(!uuid(operationId)||submitted.has(operationId)||submitted.size>=(action==="abort"?1000:999))deny()
    const body=JSON.stringify({action,operationId,...fields})
    if(Buffer.byteLength(body)>12*1024*1024)deny()
    const d=Object.freeze({action,operationId,requestHash:sha(body),sourceId:fields.sourceId??null,targetId:fields.targetId,
      generation:fields.generation,manifest:fields.manifest,attempt:fields.attempt??null,fence:fields.fence??null})
    const channel=action==="source_commit"?"source":action==="target_commit"?"target":"control"
    const previousUncertainty=uncertain
    submitted.add(operationId);uncertain=d;last=d;viewVersion++
    try{
      const e=one(await query(SQL[channel],[body]),"evidence")
      if(e?.accepted===false&&!e.operationId){uncertain=previousUncertainty;viewVersion++;return false}
      permit=validateEvidence(e,d);uncertain=null;viewVersion++
      return permit.accepted
    }catch{
      const e=Error("Synthetic ownership commit unknown; reconcile this exact operation before further mutation.")
      e.code="REHEARSAL_COMMIT_UNKNOWN";e.operation=d;throw e
    }
  }
  function pins(){if(!permit)deny();return {sourceId:permit.sourceId,targetId:permit.targetId,generation:permit.generation}}
  async function control(action,{operationId}={}){
    if(uncertain&&action!=="abort")deny("REHEARSAL_UNCERTAIN")
    const o=await observe(action!=="abort")
    // A restarted uncertain controller may explicitly abort using the exact
    // held fence pinned in its durable operation descriptor. This is positive
    // held-ownership evidence plus a conditional generation advance, never
    // source resumption inferred from a missing receipt.
    const holder=permit??(action==="abort"&&uncertain&&["import","activate","abort"].includes(uncertain.action)?uncertain:null)
    if(!holder)deny()
    const p={sourceId:holder.sourceId,targetId:holder.targetId,generation:holder.generation}
    if(o.owner.source_id!==p.sourceId||o.owner.target_id!==p.targetId||o.owner.generation!==p.generation||action==="freeze"&&o.owner.phase!=="source"||
      action!=="freeze"&&(o.owner.phase!=="held"||o.owner.fence!==holder.fence||o.owner.attempt!==holder.attempt))deny()
    if(action==="activate"&&(!o.owner.imported||o.parity!==true))deny("PARITY_INVALID")
    if(action==="import"&&o.owner.imported)deny()
    const fields={...p,revision:o.revision,manifest:o.digest}
    if(action!=="freeze")Object.assign(fields,{fence:holder.fence,attempt:holder.attempt})
    const accepted=await apply(action,fields,operationId,action==="abort")
    if(!accepted)deny("REHEARSAL_REJECTED")
    return Object.freeze({...permit})
  }
  function authority(side){
    return createPostgresCanonicalAuthority({mode:"isolated-postgres-canonical-authority",query:async(statement,values)=>{
      if(uncertain)deny("REHEARSAL_UNCERTAIN")
      const p=pins()
      if(statement.includes("commit_run")){
        if(side==="source"?!["source","aborted"].includes(permit.phase):permit.phase!=="target")deny()
        const accepted=await apply(side+"_commit",{...p,key:permit.key,manifest:permit.manifest,
          runId:values[0],expectedVersion:values[1],expectedHash:values[2],serialized:values[3]})
        return {rows:[{accepted}]}
      }
      const o=await observe(side==="target")
      if(o.owner.generation!==p.generation)deny()
      const entries=side==="source"?o.files.map(f=>({path:f.path,record:JSON.parse(Buffer.from(f.bytesBase64,"base64"))})):
        o.catalog.entries.map(f=>({path:f.path,record:JSON.parse(f.serialized)}))
      if(statement.includes("read_run"))return {rows:[{record:entries.find(e=>e.path==="records/"+values[0]+".json")?.record??null}]}
      if(statement.includes("read_versions"))return {rows:[{records:entries.filter(e=>e.path.startsWith("versions/"+values[0]+"/")).sort((a,b)=>a.path<b.path?-1:1).map(e=>e.record)}]}
      deny()
    }})
  }
  const sourceAuthority=authority("source"),targetAuthority=authority("target")
  return Object.freeze({observe:()=>observe(true),
    pending:()=>uncertain?{...uncertain}:null,
    operation:()=>last?{...last}:null,
    async seed({operationId}={}){
      if(uncertain||permit)deny()
      const observation=await observe()
      if(observation.owner.phase!=="empty")deny()
      const snapshot=await captureSyntheticMigrationRehearsal({mode:IMPORT_MODE})
      // Reuse the complete existing archive validator/normalizer. Its trusted
      // transport is redirected to source bootstrap, never to target import.
      await createSyntheticMigrationImporter({mode:IMPORT_MODE,query:async(statement,args)=>{
        if(statement!=="SELECT ppo_authority.import_synthetic_snapshot($1::text,$2::text) AS accepted")deny()
        const accepted=await apply("seed",{targetId:observation.owner.target_id,generation:observation.owner.generation,
          revision:observation.revision,manifest:args[0],files:JSON.parse(args[1])},operationId)
        return {rows:[{accepted}]}
      }}).rehearse(snapshot).catch(error=>{if(uncertain){const e=Error("Source bootstrap unknown.");e.code="REHEARSAL_COMMIT_UNKNOWN";e.operation={...uncertain};throw e}throw error})
      return Object.freeze({...permit})
    },
    freeze:options=>control("freeze",options),import:options=>control("import",options),
    activate:options=>control("activate",options),abort:options=>control("abort",options),
    async reconcile(operation=uncertain){
      if(!operation||!uuid(operation.operationId)||!hash(operation.requestHash)||!uuid(operation.targetId)||!generation(operation.generation))deny()
      if(uncertain&&!isDeepStrictEqual(uncertain,operation))deny()
      const descriptor=Object.freeze({...operation}),ticket=++viewVersion
      uncertain=descriptor
      const e=one(await query(SQL.receipt,[descriptor.operationId,descriptor.requestHash]),"evidence")
      // An abort or a newer reconciliation may have advanced local state
      // while this independent read was in flight. Never install its old view.
      if(ticket!==viewVersion)return {status:"superseded",operation:{...descriptor}}
      if(e===null)return {status:"unknown",operation:{...descriptor}}
      permit=validateEvidence(e,descriptor);uncertain=null;viewVersion++
      return {status:permit.accepted?"committed":"rejected",evidence:{...permit}}
    },
    sourceAuthority,targetAuthority,
    source:createIsolatedCanonicalRunState({mode:"isolated-postgres-canonical-authority",authority:sourceAuthority}),
    target:createIsolatedCanonicalRunState({mode:"isolated-postgres-canonical-authority",authority:targetAuthority})
  })
}
