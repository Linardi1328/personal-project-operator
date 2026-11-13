import { createHash, randomUUID, KeyObject } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { remotePayloadDigest, verifyRemoteEnvelope } from "./software-factory-remote-contract.mjs"
import { verifyOfflineHostActionSignature } from "./software-factory-remote-host-fence.mjs"
import { createPostgresCanonicalCatalog } from "./development-postgres-canonical-catalog.mjs"
import { parseUniqueJson } from "./unique-json.mjs"
const MODE="isolated-postgres-action-fencing-only"
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const HASH=/^[a-f0-9]{64}$/u
const uuid=v=>typeof v==="string"&&UUID.test(v)
const sha=v=>createHash("sha256").update(v).digest("hex")
const denied=()=>Object.freeze({grant:false,canExecute:false,releaseAuthorized:false})
function fail(){throw Error("Isolated action fence denied or unavailable.")}
function one(result,key){if(!Array.isArray(result?.rows)||result.rows.length!==1||!Object.hasOwn(result.rows[0],key))fail();return result.rows[0][key]}
function fp(key){if(!(key instanceof KeyObject)||key.type!=="public"||key.asymmetricKeyType!=="ed25519")fail();return sha(key.export({type:"spki",format:"der"}))}
export const POSTGRES_ACTION_SQL=Object.freeze({
 snapshot:"SELECT ppo_authority.read_action_snapshot() AS snapshot",
 register:"SELECT ppo_authority.register_action_context($1::uuid,$2::text) AS accepted",
 consume:"SELECT ppo_authority.consume_action($1::uuid,$2::uuid) AS evidence",
 precommit:"SELECT ppo_authority.check_action($1::uuid,$2::uuid,true) AS evidence",
 observe:"SELECT ppo_authority.check_action($1::uuid,$2::uuid,false) AS evidence"
})
// Trusted server verifier only: actual signed Phase1B/1F formats and complete
// existing semantic/history validator. Authenticated transport/key custody is
// absent. The consumer role cannot manufacture these immutable attestations.
export function createIsolatedPostgresActionVerifier({mode,query,coordinatorPublicKey,workerPublicKey,hostPublicKey}={}){
 if(mode!==MODE||typeof query!=="function")fail()
 const fingerprints={coordinatorFingerprint:fp(coordinatorPublicKey),workerFingerprint:fp(workerPublicKey),hostFingerprint:fp(hostPublicKey)}
 return Object.freeze({async register({signedRequest,signedClaim,signedProof,ticket=randomUUID()}={}){
  if(!uuid(ticket))fail()
  const request=verifyRemoteEnvelope(signedRequest,"ppo-control-plane",coordinatorPublicKey)
  if(request.kind!=="dispatch-request")fail()
  const claim=verifyRemoteEnvelope(signedClaim,request.workerId,workerPublicKey)
  const proof=verifyOfflineHostActionSignature(signedProof,hostPublicKey)
  const p=proof.payload,requestHash=remotePayloadDigest(request),claimHash=remotePayloadDigest(claim)
  if(claim.kind!=="worker-claim"||claim.requestId!==request.requestId||claim.requestHash!==requestHash||p.requestHash!==requestHash||p.claimHash!==claimHash||
   p.runId!==request.runId||claim.runId!==request.runId||p.expectedVersion!==request.expectedVersion||claim.expectedVersion!==request.expectedVersion||
   p.workerId!==request.workerId||claim.workerId!==request.workerId||claim.hostId!==p.hostId||!p.hostId.startsWith("lab-")||p.hostEpoch>1000000000||
   Date.parse(p.issuedAt)<Date.parse(request.issuedAt)||Date.parse(p.expiresAt)>Date.parse(request.expiresAt)||
   Date.parse(claim.claimedAt)<Date.parse(request.issuedAt)||Date.parse(claim.leaseExpiresAt)>Date.parse(request.expiresAt)||
   p.actionPath.split("/").includes(".")||!request.scope.permits.includes(p.actionType)||!request.scope.allowedPaths.some(path=>p.actionPath===path||p.actionPath.startsWith(path.replace(/\/$/u,"")+"/")))fail()
  const s=one(await query(POSTGRES_ACTION_SQL.snapshot,[]),"snapshot")
  if(!s||Buffer.byteLength(JSON.stringify(s))>70*1024*1024||s.phase!=="target"||!uuid(s.targetId)||!uuid(s.sourceId)||s.targetId===s.sourceId||
   typeof s.generation!=="string"||!/^[1-9][0-9]{0,9}$/u.test(s.generation)||BigInt(s.generation)>1000000000n||
   typeof s.catalogText!=="string"||typeof s.entriesText!=="string")fail()
  const catalog=parseUniqueJson(s.catalogText,{maxBytes:32*1024*1024})
  if(!isDeepStrictEqual(parseUniqueJson(s.entriesText,{maxBytes:32*1024*1024}),catalog.entries))fail()
  const valid=await createPostgresCanonicalCatalog({mode:"isolated-postgres-canonical-catalog",query:async()=>({rows:[{snapshot:catalog}]})}).list()
  if(!valid.ok)fail()
  const context={targetId:s.targetId,sourceId:s.sourceId,generation:s.generation,catalogDigest:sha(s.entriesText),
   ...fingerprints,request,claim,proof:p,requestHash,claimHash,proofHash:sha(JSON.stringify(proof))}
  if(one(await query(POSTGRES_ACTION_SQL.register,[ticket,JSON.stringify(context)]),"accepted")!==true)fail()
  return Object.freeze({ticket,targetId:s.targetId,generation:s.generation,proofHash:context.proofHash})
 }})
}
// One dedicated consumer connection per instance, exclusively owned through
// BEGIN/pre-COMMIT/acknowledged COMMIT and fresh post-COMMIT read. No callbacks,
// DSN, driver, environment routing, retry, fallback or executable grant.
export function createIsolatedPostgresActionFence({mode,query}={}){
 if(mode!==MODE||typeof query!=="function")fail()
 let used=false
 return Object.freeze({async consume({ticket,operationId=randomUUID()}={}){
  if(used||!uuid(ticket)||!uuid(operationId))fail()
  used=true // even a missing row/failed BEGIN cannot authorize automatic replay
  const operation=Object.freeze({ticket,operationId})
  let committed=false
  try{
   await query("BEGIN",[])
   const e=one(await query(POSTGRES_ACTION_SQL.consume,[ticket,operationId]),"evidence")
   if(e?.consumed!==true||e.ticket!==ticket||e.operationId!==operationId){await query("ROLLBACK",[]);return {...denied(),status:"denied",operation}}
   const before=one(await query(POSTGRES_ACTION_SQL.precommit,[ticket,operationId]),"evidence")
   if(!evidence(before,operation)||before.fresh!==true){await query("ROLLBACK",[]);return {...denied(),status:"denied",operation}}
   await query("COMMIT",[]);committed=true
   const after=one(await query(POSTGRES_ACTION_SQL.observe,[ticket,operationId]),"evidence")
   if(!evidence(after,operation)||after.targetId!==before.targetId||after.generation!==before.generation||after.contextHash!==before.contextHash||BigInt(after.observedMicros)<BigInt(before.observedMicros))fail()
   // Ordinary PostgreSQL offers clock observations, not an atomic wall-clock
   // grant through commit/ack. The strict 1G-A grant contract stays BLOCKED.
   return {...denied(),status:after.fresh?"consumed-diagnostic":"expired-or-stale",consumed:true,operation,evidence:after}
  }catch{
   if(!committed)try{await query("ROLLBACK",[])}catch{}
   return {...denied(),status:"unknown",operation}
  }
 }})
}
function evidence(e,o){return e?.consumed===true&&e.ticket===o.ticket&&e.operationId===o.operationId&&uuid(e.targetId)&&
 typeof e.generation==="string"&&/^[1-9][0-9]{0,9}$/u.test(e.generation)&&BigInt(e.generation)<=1000000000n&&
 typeof e.observedMicros==="string"&&/^[1-9][0-9]{0,18}$/u.test(e.observedMicros)&&
 typeof e.contextHash==="string"&&HASH.test(e.contextHash)&&typeof e.fresh==="boolean"}
// Inspection only. A missing tombstone never establishes noncommit; a positive
// tombstone also NEVER revives a delayed grant or Phase1F execution permission.
export async function inspectIsolatedActionConsumption({mode,query,operation}={}){
 if(mode!==MODE||typeof query!=="function"||!uuid(operation?.ticket)||!uuid(operation?.operationId))fail()
 const e=one(await query(POSTGRES_ACTION_SQL.observe,[operation.ticket,operation.operationId]),"evidence")
 return {...denied(),status:evidence(e,operation)?"consumed":"unknown",operation,...(evidence(e,operation)?{evidence:e}:{})}
}
