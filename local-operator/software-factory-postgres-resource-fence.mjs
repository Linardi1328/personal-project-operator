import {createHash,sign,verify,KeyObject} from 'node:crypto'
import {parseUniqueJson} from './unique-json.mjs'
import {createIsolatedPostgresActionFence,POSTGRES_ACTION_SQL as A} from './software-factory-remote-postgres-action-fence.mjs'
const MODE='isolated-postgres-resource-fencing-only',DOMAIN='ppo-synthetic-resource-operation-v1'
const fields='version operationId ticket ticketHash contextHash sourceId targetId generation hostId hostFingerprint hostEpoch workerId capability requestHash claimHash proofHash runId runVersion status branch baseSha headSha resourceId expectedVersion expectedRef action path payloadHash'.split(' ')
const sha=s=>createHash('sha256').update(s).digest('hex')
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v)
const flags={grant:false,canExecute:false,releaseAuthorized:false}
function fail(){throw Error('Synthetic resource operation denied or unavailable.')}
function parse(text){
 const d=parseUniqueJson(text,{maxBytes:8192})
 if(!d||Object.keys(d).sort().join('|')!==[...fields].sort().join('|')||d.version!==1||fields.some(k=>!['string','number'].includes(typeof d[k])))fail()
 for(const k of ['operationId','ticket','sourceId','targetId','resourceId'])if(!uuid(d[k]))fail()
 for(const k of ['ticketHash','contextHash','hostFingerprint','requestHash','claimHash','proofHash','expectedRef','payloadHash'])if(!/^[a-f0-9]{64}$/u.test(d[k]))fail()
 if(!Number.isSafeInteger(d.hostEpoch)||d.hostEpoch<1||d.hostEpoch>1e9||!Number.isSafeInteger(d.runVersion)||d.runVersion<1||
 !Number.isSafeInteger(d.expectedVersion)||d.expectedVersion<0||d.expectedVersion>998||typeof d.generation!=='string'||!/^[1-9][0-9]{0,9}$/u.test(d.generation)||BigInt(d.generation)>1000000000n||
 d.action!=='workspace.write'||d.path!=='src/synthetic.mjs'||d.status!=='implementation_in_progress')fail()
 return d
}
const message=text=>Buffer.from(JSON.stringify([DOMAIN,text]))
export const RESOURCE_SQL=Object.freeze({read:'SELECT ppo_authority.read_resource_context($1::uuid) AS context',register:'SELECT ppo_authority.register_resource_operation($1::text,$2::text,$3::text) AS accepted',apply:'SELECT ppo_authority.apply_resource_operation($1::uuid,$2::text) AS evidence',receipt:'SELECT ppo_authority.read_resource_receipt($1::uuid,$2::text) AS receipt'})
function one(r,k){if(!Array.isArray(r?.rows)||r.rows.length!==1)fail();return r.rows[0][k]}
// Synthetic signing helper, no enrollment or real key transport.
export function signSyntheticResourceDescriptor(text,key){parse(text);if(key?.type!=='private'||key.asymmetricKeyType!=='ed25519')fail();return {text,signature:sign(null,message(text),key).toString('base64url')}}
export function createSyntheticResourceVerifier({mode,query,publicKey}={}){
 if(mode!==MODE||typeof query!=='function'||!(publicKey instanceof KeyObject)||publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519')fail()
 const fingerprint=sha(publicKey.export({type:'spki',format:'der'}))
 return Object.freeze({async register(signed,payload){
 if(!signed||Object.getPrototypeOf(signed)!==Object.prototype||Object.keys(signed).sort().join('|')!=='signature|text'||Object.values(Object.getOwnPropertyDescriptors(signed)).some(d=>!Object.hasOwn(d,'value')))fail()
 const {text,signature}=signed,d=parse(text)
 if(typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/u.test(signature)||Buffer.from(signature,'base64url').toString('base64url')!==signature||!verify(null,message(text),publicKey,Buffer.from(signature,'base64url'))||typeof payload!=='string'||Buffer.byteLength(payload)>4096||sha(payload)!==d.payloadHash)fail()
 if(one(await query(RESOURCE_SQL.register,[text,payload,fingerprint]),'accepted')!==true)fail()
 return Object.freeze({operationId:d.operationId,ticket:d.ticket,descriptorHash:sha(text)})
 }})
}
function operation(o){if(!uuid(o?.operationId)||!uuid(o?.ticket)||typeof o.descriptorHash!=='string'||!/^[a-f0-9]{64}$/u.test(o.descriptorHash))fail();return {...o}}
export async function inspectSyntheticResourceReceipt({mode,query,operation:raw}={}){
 if(mode!==MODE||typeof query!=='function')fail();const o=operation(raw),r=one(await query(RESOURCE_SQL.receipt,[o.operationId,o.descriptorHash]),'receipt')
 if(r===null)return {...flags,status:'unknown',operation:o}
 if(r?.operation_id!==o.operationId||r.ticket!==o.ticket||r.descriptor_hash!==o.descriptorHash||!r.before_state||!r.after_state||r.after_state.resource_id!==r.before_state.resource_id||r.after_state.version!==r.before_state.version+1||sha(r.after_state.value)!==r.after_state.ref)fail()
 return {...flags,status:'committed-synthetic-effect',operation:o,receipt:r}
}
export function createSyntheticResourceFence({mode,query}={}){
 if(mode!==MODE||typeof query!=='function')fail();let used=false
 return Object.freeze({async apply(raw){
 const o=operation(raw);if(used)fail();used=true
 const adapter=createIsolatedPostgresActionFence({mode:'isolated-postgres-action-fencing-only',query:async(s,args)=>{
 if(s===A.consume){const e=one(await query(RESOURCE_SQL.apply,[o.operationId,o.descriptorHash]),'evidence');return {rows:[{evidence:{...e,consumed:e?.applied===true}}]}}
 return query(s,args)
 }})
 const result=await adapter.consume(o)
 if(result.consumed!==true)return {...result,operation:o}
 try{const evidence=await inspectSyntheticResourceReceipt({mode,query,operation:o});if(evidence.status!=='committed-synthetic-effect')fail();return {...result,operation:o,receipt:evidence.receipt}}
 catch{return {...flags,status:'unknown',operation:o}}
 }})
}
