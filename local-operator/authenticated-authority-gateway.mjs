// RIC-177 disposable authenticated authority gateway. Two fixed diagnostic
// operations only; every result keeps grant/canExecute/releaseAuthorized false.
// Trusted server infrastructure: the injected external witness, pin registry
// and connection factory are never request properties or client callbacks.
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {EXTERNAL_INCARNATION_LAB_LIMITS} from './development-external-incarnation-anchor.mjs'

const MODE='isolated-authenticated-authority-gateway-only'
const FLAGS=Object.freeze({grant:false,canExecute:false,releaseAuthorized:false})
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,HASH=/^[a-f0-9]{64}$/u,LAB=/^lab-[a-z0-9-]{1,60}$/u
const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v)
const epoch=v=>Number.isSafeInteger(v)&&v>=1&&v<1e9
const sha=text=>createHash('sha256').update(text,'utf8').digest('hex')
const result=(status,extra={})=>({...FLAGS,status,...extra})
function fail(){throw Error('Authenticated authority gateway denied or unavailable.')}
function exact(o,keys){return !!o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===[...keys].sort().join('|')}

export const AUTHORITY_GATEWAY_SQL=Object.freeze({
 state:'SELECT ppo_authority.gateway_state() AS state',
 consume:'SELECT ppo_authority.gateway_consume_action($1::uuid,$2::uuid,$3::text) AS receipt',
 revoke:'SELECT ppo_authority.gateway_revoke_host($1::uuid,$2::text,$3::bigint,$4::text) AS receipt',
 receipt:'SELECT ppo_authority.gateway_receipt($1::uuid) AS evidence'
})
// Reserve, committed evidence, one pin-change quarantine and a clean close.
// Deny before reservation rather than strand closure/reconciliation evidence.
export const GATEWAY_RECORD_RESERVE=4
// Consumption additionally leaves one host revocation possible (activation,
// reserve, committed evidence and one operation slot) so routine traffic
// cannot exhaust the emergency revocation path.
export const GATEWAY_REVOCATION_RESERVE=Object.freeze({records:3,operations:1})
const G=AUTHORITY_GATEWAY_SQL,WRITE=['BEGIN','COMMIT','ROLLBACK']
const KINDS={'/v1/gateway/consume':'consume-action','/v1/gateway/revoke-host':'revoke-host'}
const ROUTES=Object.freeze({
 '/v1/gateway/state':{peers:['coordinator','administrator'],keys:[],statements:[G.state]},
 '/v1/gateway/consume':{peers:['coordinator'],keys:['operationId','ticket','expected'],statements:[G.state,G.consume,G.receipt,...WRITE]},
 '/v1/gateway/revoke-host':{peers:['administrator'],keys:['operationId','hostId','expectedEpoch','expected'],statements:[G.state,G.revoke,G.receipt,...WRITE]},
 '/v1/gateway/reconcile':{peers:['coordinator','administrator'],keys:['operationId'],statements:[G.state,G.receipt]}
})
const expectedBinding=e=>exact(e,['incarnation','instanceId','checkpoint'])&&epoch(e.incarnation)&&uuid(e.instanceId)&&hash(e.checkpoint)
// Shape only. Exact client expectations are compared with the independently
// read witness; they are never accepted as attestations.
export function authorityGatewayRoute(path,body){
 const spec=Object.hasOwn(ROUTES,path)&&ROUTES[path]
 if(!spec||!exact(body,spec.keys))fail()
 if(spec.keys.includes('operationId')&&!uuid(body.operationId))fail()
 if(path==='/v1/gateway/consume'&&(!uuid(body.ticket)||!expectedBinding(body.expected)))fail()
 if(path==='/v1/gateway/revoke-host'&&(typeof body.hostId!=='string'||!/^lab-[a-z0-9-]{1,59}$/u.test(body.hostId)||!epoch(body.expectedEpoch)||!expectedBinding(body.expected)))fail()
 return spec
}
export const gatewaySubjectHash=(kind,key)=>sha('ppo-ric177-gateway-subject-v1|'+kind+'|'+key)
// Revocation subject binds host AND expected epoch, so a denied stale-epoch
// attempt cannot burn the host's ability to be revoked at its real epoch.
export const gatewayOperationSubject=(kind,key,detail)=>gatewaySubjectHash(kind,detail===''?key:key+':'+detail)
export function gatewayInputText({kind,operationId,key,detail,binding:b}){
 return ['ppo-ric177-gateway-input-v1',kind,operationId,key,detail,b.anchorId,b.authorityId,b.ownerId,String(b.incarnation),b.instanceId,b.checkpoint,
  b.peerIdentity,String(b.peerEpoch),b.peerFingerprint,b.serviceIdentity,String(b.serviceEpoch)].join('|')
}
function one(r,key){if(!Array.isArray(r?.rows)||r.rows.length!==1||!Object.hasOwn(r.rows[0],key))fail();return r.rows[0][key]}
const subjectKey=(kind,o)=>kind==='consume-action'?{key:o.ticket,detail:''}:{key:o.hostId,detail:String(o.expectedEpoch)}

export function createAuthenticatedAuthorityGateway({mode,witness,pinnedIdentity,attestation,pins,serviceIdentity}={}){
 if(mode!==MODE||!exact(pinnedIdentity,['anchorId','authorityId','ownerId'])||Object.values(pinnedIdentity).some(v=>!uuid(v))||!hash(attestation)||
    !witness||['inspect','reserve','recordCommitted','quarantine','activate'].some(k=>typeof witness[k]!=='function')||
    typeof pins?.read!=='function'||typeof pins?.subscribe!=='function'||typeof serviceIdentity!=='string'||!LAB.test(serviceIdentity)||pins.read(serviceIdentity)?.kind!=='gateway-service')fail()
 const identity=Object.freeze({...pinnedIdentity})
 let locked=false,detached=false
 const waiters=[]
 const release=()=>{const next=waiters.shift();if(next)next();else locked=false}
 // One witness-touching path at a time. A request denies at once rather than
 // queueing a delayed mutation; a queued pin-change quarantine runs before any
 // later request can take the lock.
 async function exclusive(fn){if(locked||detached)return result('unavailable');locked=true;try{return await fn()}finally{release()}}
 // Rotation is unsupported in this profile and pins are process-local, so any
 // coordinator/administrator/gateway pin change durably quarantines an open
 // witness. It is serialized with activation, so it cannot stale an
 // activation's expected record hash, and it never spends a record on an
 // already-quarantined witness (preserving the reserved close record).
 // Only a trusted explicit activation against the current checkpoint reopens
 // it; a restart likewise reopens quarantined.
 const unsubscribe=pins.subscribe(entry=>{
  if(!['coordinator','administrator'].includes(entry?.kind)&&entry?.identity!==serviceIdentity)return
  void (locked?new Promise(r=>waiters.push(r)):(locked=true,Promise.resolve())).then(async()=>{try{if((await witness.inspect()).status==='open')await witness.quarantine()}catch{}finally{release()}})
 })
 const sameIdentity=e=>isDeepStrictEqual(e?.identity,identity)
 function dbState(s){
  if(!exact(s,['profile','anchorId','authorityId','ownerId','lastIncarnation','sealedAttestation','attestation','checkpoint'])||s.profile!=='ric177-disposable-authority-gateway-v1'||
     !hash(s.checkpoint)||!Number.isSafeInteger(s.lastIncarnation))fail()
  return s.anchorId===identity.anchorId&&s.authorityId===identity.authorityId&&s.ownerId===identity.ownerId&&s.attestation===attestation&&s.sealedAttestation===attestation
 }
 // Exact positive evidence only: the receipt, its digest, the native
 // effect/denial and the pending reservation must all agree.
 function exactEvidence(ev,pending){
  if(!exact(ev,['receiptText','receiptHash','native','checkpoint','attestation','sealedAttestation'])||typeof ev.receiptText!=='string'||sha(ev.receiptText)!==ev.receiptHash||
     !hash(ev.checkpoint)||ev.checkpoint===pending.beforeCheckpoint||ev.attestation!==attestation||ev.sealedAttestation!==attestation)return null
  let r;try{r=JSON.parse(ev.receiptText)}catch{return null}
  const o=pending.operation,b=r?.binding
  if(!exact(r,['operation_id','kind','subject_hash','input_hash','outcome','incarnation','instance_id','before_checkpoint','binding','evidence','transaction_id'])||
     r.operation_id!==o.operationId||r.kind!==o.kind||r.subject_hash!==o.subjectHash||r.input_hash!==o.inputHash||r.incarnation!==pending.incarnation||r.instance_id!==pending.instanceId||
     r.before_checkpoint!==pending.beforeCheckpoint||!exact(b,['anchorId','authorityId','ownerId','incarnation','instanceId','checkpoint','peerIdentity','peerEpoch','peerFingerprint','serviceIdentity','serviceEpoch','subjectHash','inputHash'])||
     b.anchorId!==identity.anchorId||b.authorityId!==identity.authorityId||b.ownerId!==identity.ownerId||b.incarnation!==pending.incarnation||b.instanceId!==pending.instanceId||
     b.checkpoint!==pending.beforeCheckpoint||b.subjectHash!==o.subjectHash||b.inputHash!==o.inputHash)return null
  const x=r.evidence,n=ev.native
  if(o.kind==='consume-action'){
   if(!uuid(x?.ticket)||gatewayOperationSubject(o.kind,x.ticket,'')!==o.subjectHash||sha(gatewayInputText({kind:o.kind,operationId:o.operationId,key:x.ticket,detail:'',binding:b}))!==o.inputHash)return null
   if(r.outcome==='consumed'&&(n?.operation_id!==o.operationId||n.ticket!==x.ticket||x.precommit?.fresh!==true))return null
   if(r.outcome==='denied'&&(n!==null||x.core?.consumed!==false))return null
   if(!['consumed','denied'].includes(r.outcome))return null
  }else{
   if(typeof x?.hostId!=='string'||!epoch(x.expectedEpoch)||gatewayOperationSubject(o.kind,x.hostId,String(x.expectedEpoch))!==o.subjectHash||sha(gatewayInputText({kind:o.kind,operationId:o.operationId,key:x.hostId,detail:String(x.expectedEpoch),binding:b}))!==o.inputHash)return null
   if(r.outcome==='revoked'&&(n?.host_id!==x.hostId||n.epoch!==x.expectedEpoch+1||n.policy?.status!=='revoked'||!isDeepStrictEqual(n,x.after)))return null
   if(r.outcome==='denied'&&x.before?.host_id!=null&&!isDeepStrictEqual(n,x.before))return null
   if(!['revoked','denied'].includes(r.outcome))return null
  }
  return {receipt:r,receiptHash:ev.receiptHash,checkpoint:ev.checkpoint}
 }
 const outcomeStatus=(kind,outcome)=>outcome==='denied'?'gateway-denied':kind==='consume-action'?'gateway-consumed':'gateway-revoked'
 async function mutate(path,body,ctx){
  const kind=KINDS[path],{key,detail}=subjectKey(kind,body)
  let reserved=false,begun=false,committed=false
  try{
   const e=await witness.inspect()
   if(e.status!=='open'||e.pending!==null||!sameIdentity(e)||e.incarnation!==body.expected.incarnation||e.instanceId!==body.expected.instanceId||e.checkpoint!==body.expected.checkpoint)return result('denied')
   const subjectHash=gatewayOperationSubject(kind,key,detail)
   if(e.operations.some(o=>o.operationId===body.operationId||o.subjectHash===subjectHash))return result('denied')
   const keep=kind==='consume-action'?GATEWAY_REVOCATION_RESERVE:{records:0,operations:0}
   if(EXTERNAL_INCARNATION_LAB_LIMITS.records-e.sequence<GATEWAY_RECORD_RESERVE+keep.records||e.operations.length>=EXTERNAL_INCARNATION_LAB_LIMITS.operations-keep.operations)return result('unavailable')
   const s=one(await ctx.query(G.state,[]),'state')
   // Native state diverged from the external anchor: stale restore, clone
   // or out-of-band write. Latch durable quarantine; never reserve.
   // A DB incarnation floor at or above the witness incarnation means another
   // owner already used this incarnation: deny cleanly before reservation.
   if(!dbState(s)||s.checkpoint!==e.checkpoint||s.lastIncarnation>=e.incarnation){await witness.quarantine();return result('denied')}
   if(!ctx.live())return result('denied')
   const binding={...identity,incarnation:e.incarnation,instanceId:e.instanceId,checkpoint:e.checkpoint}
   const full={...binding,peerIdentity:ctx.peer.identity,peerEpoch:ctx.peer.epoch,peerFingerprint:ctx.peer.fingerprint,serviceIdentity:ctx.service.identity,serviceEpoch:ctx.service.epoch,subjectHash}
   full.inputHash=sha(gatewayInputText({kind,operationId:body.operationId,key,detail,binding:full}))
   const operation={operationId:body.operationId,kind,subjectHash,inputHash:full.inputHash}
   reserved=true // an interrupted durable append is itself ambiguous
   await witness.reserve({binding,operation})
   // Revalidate the exact durable reservation at the mutation boundary; the
   // transport rechecks both pins before every statement and PostgreSQL
   // rechecks session, attestation, owner, incarnation and checkpoint.
   const pending=(await witness.inspect()).pending
   if(!isDeepStrictEqual(pending,{operation,incarnation:e.incarnation,instanceId:e.instanceId,beforeCheckpoint:e.checkpoint}))return result('unknown',{operation})
   await ctx.query('BEGIN',[]);begun=true
   one(await ctx.query(kind==='consume-action'?G.consume:G.revoke,kind==='consume-action'?[body.operationId,body.ticket,JSON.stringify(full)]:[body.operationId,body.hostId,body.expectedEpoch,JSON.stringify(full)]),'receipt')
   committed=true // dispatched COMMIT may commit even if acknowledgement is lost
   await ctx.query('COMMIT',[])
   const proof=exactEvidence(one(await ctx.query(G.receipt,[body.operationId]),'evidence'),pending)
   if(!proof)return result('unknown',{operation})
   await witness.recordCommitted({binding,operation,checkpoint:proof.checkpoint,receiptHash:proof.receiptHash})
   return result(outcomeStatus(kind,proof.receipt.outcome),{operation,outcome:proof.receipt.outcome,receiptHash:proof.receiptHash,incarnation:e.incarnation,instanceId:e.instanceId})
  }catch{
   if(begun&&!committed)try{await ctx.query('ROLLBACK',[])}catch{}
   // Before durable reservation nothing can have mutated. Afterwards the
   // exact operation stays latched; absence never proves noncommit.
   return result(reserved?'unknown':'denied')
  }
 }
 // Read-only reconciliation: reads exact receipt/native evidence and records
 // matching positive evidence. It never invokes consumption or revocation.
 async function reconcile(body,ctx){
  try{
   const e=await witness.inspect()
   if(!e.pending||e.pending.operation.operationId!==body.operationId||!sameIdentity(e))return result('denied')
   const proof=exactEvidence(one(await ctx.query(G.receipt,[body.operationId]),'evidence'),e.pending)
   if(!proof)return result('unknown',{operation:e.pending.operation})
   const binding={...identity,incarnation:e.pending.incarnation,instanceId:e.pending.instanceId,checkpoint:e.pending.beforeCheckpoint}
   await witness.recordCommitted({binding,operation:e.pending.operation,checkpoint:proof.checkpoint,receiptHash:proof.receiptHash})
   return result('reconciled',{operation:e.pending.operation,outcome:proof.receipt.outcome,receiptHash:proof.receiptHash})
  }catch{return result('unknown')}
 }
 async function state(ctx){
  const e=await witness.inspect(),s=one(await ctx.query(G.state,[]),'state')
  // Report only a stable witness observation; an overlapping change is unavailable.
  if((await witness.inspect()).recordHash!==e.recordHash)return result('unavailable')
  const consistent=dbState(s)&&s.checkpoint===e.checkpoint
  return result('gateway-state',{binding:{...identity,incarnation:e.incarnation,instanceId:e.instanceId,checkpoint:e.checkpoint},witness:e.status,pending:e.pending?.operation.operationId??null,consistent})
 }
 return Object.freeze({
  serviceIdentity,pins,
  async handle(path,body,ctx){
   if(detached)return result('unavailable')
   if(path==='/v1/gateway/state')return state(ctx)
   if(path==='/v1/gateway/reconcile')return exclusive(()=>reconcile(body,ctx))
   return exclusive(()=>mutate(path,body,ctx))
  },
  // Trusted local administration only (no network route): reopen a
  // quarantined witness when the probed gateway session reads exactly the
  // witnessed checkpoint and sealed attestation. Never resolves pending work.
  // Leaves records for a pin-change quarantine and the clean close.
  activate(query){
   return exclusive(async()=>{
    const e=await witness.inspect()
    if(e.status!=='quarantined'||e.pending!==null||!sameIdentity(e)||EXTERNAL_INCARNATION_LAB_LIMITS.records-e.sequence<3)return result('denied')
    const s=one(await query(G.state,[]),'state')
    // Both the database read and this witness reread are asynchronous, and
    // shutdown may begin during either: observe first, then check detached
    // synchronously immediately before the reopen so it can never follow detach.
    const again=await witness.inspect()
    if(detached||!dbState(s)||s.checkpoint!==e.checkpoint||again.recordHash!==e.recordHash)return result('denied')
    const a=await witness.activate({checkpoint:s.checkpoint,expectedRecordHash:e.recordHash})
    // The reopen is itself an awaited transition: shutdown can begin while it is
    // in flight, and the check above cannot cover that. Never leave an open
    // witness behind a detached gateway; re-quarantine it. A failure here is
    // thrown (not swallowed), so the caller and close() observe it.
    if(detached){await witness.quarantine();return result('denied')}
    return result('activated',{binding:{...identity,incarnation:a.incarnation,instanceId:a.instanceId,checkpoint:a.checkpoint}})
   })
  },
  detach(){detached=true;unsubscribe()}
 })
}
export const AUTHORITY_GATEWAY_MODE=MODE
