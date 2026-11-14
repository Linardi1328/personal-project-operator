// Disposable preparation component. No execution grant or production gateway.
import {constants} from 'node:fs'
import {lstat,mkdir,open,readdir,realpath,rmdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

const MODE='isolated-external-incarnation-anchor-only'
const MAX_RECORDS=128,MAX_BYTES=16384,MAX_OPERATIONS=32
const flags=Object.freeze({grant:false,canExecute:false,releaseAuthorized:false})
const sha=text=>createHash('sha256').update(text).digest('hex')
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v)
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v)
const copy=x=>JSON.parse(JSON.stringify(x))
function deny(){throw Error('External incarnation laboratory denied or quarantined.')}
function exact(o,keys){if(!o||Object.getPrototypeOf(o)!==Object.prototype||Object.keys(o).sort().join('|')!==[...keys].sort().join('|')||Object.values(Object.getOwnPropertyDescriptors(o)).some(d=>!Object.hasOwn(d,'value')))deny()}
function identity(x){exact(x,['anchorId','authorityId','ownerId']);if(Object.values(x).some(v=>!uuid(v)))deny();return copy(x)}
function descriptor(x){
 exact(x,['operationId','kind','subjectHash','inputHash'])
 if(!uuid(x.operationId)||!['consume-action','revoke-host'].includes(x.kind)||!hash(x.subjectHash)||!hash(x.inputHash))deny()
 return copy(x)
}
async function syncDirectory(path){const f=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await f.sync()}finally{await f.close()}}
async function privateDirectory(path){
 const s=await lstat(path)
 if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700||s.uid!==process.getuid()||await realpath(path)!==path)deny()
 return {dev:s.dev,ino:s.ino}
}
async function unchangedDirectory(path,pin){const now=await privateDirectory(path);if(now.dev!==pin.dev||now.ino!==pin.ino)deny()}
function validateState(s){
 exact(s,['identity','incarnation','status','instanceId','checkpoint','lastReceiptHash','pending','operations'])
 identity(s.identity)
 if(!Number.isSafeInteger(s.incarnation)||s.incarnation<0||s.incarnation>1e9||!['quarantined','open'].includes(s.status)||!(s.instanceId===null||uuid(s.instanceId))||!hash(s.checkpoint)||!(s.lastReceiptHash===null||hash(s.lastReceiptHash))||!Array.isArray(s.operations)||s.operations.length>MAX_OPERATIONS)deny()
 const ids=new Set(),subjects=new Set()
 for(const o of s.operations){descriptor(o);if(ids.has(o.operationId)||subjects.has(o.subjectHash))deny();ids.add(o.operationId);subjects.add(o.subjectHash)}
 if(s.pending!==null){
  exact(s.pending,['operation','incarnation','instanceId','beforeCheckpoint'])
  descriptor(s.pending.operation)
  if(s.pending.incarnation!==s.incarnation||s.pending.instanceId!==s.instanceId||s.pending.beforeCheckpoint!==s.checkpoint||!s.operations.some(o=>isDeepStrictEqual(o,s.pending.operation)))deny()
 }
 if(s.status==='open'&&(s.incarnation<1||!uuid(s.instanceId)||s.pending!==null))deny()
}
function validateTransition(prior,next,event){
 validateState(next)
 if(!prior){if(event!=='initialize'||next.incarnation!==0||next.status!=='quarantined'||next.instanceId!==null||next.lastReceiptHash!==null||next.pending!==null||next.operations.length)deny();return}
 if(!isDeepStrictEqual(prior.identity,next.identity))deny()
 const expected=copy(prior)
 if(event==='quarantine'){expected.status='quarantined'}
 else if(event==='activate'){
  if(prior.status!=='quarantined'||prior.pending!==null||next.incarnation!==prior.incarnation+1||!uuid(next.instanceId)||next.instanceId===prior.instanceId)deny()
  expected.incarnation=next.incarnation;expected.instanceId=next.instanceId;expected.status='open'
 }else if(event==='reserve'){
  if(prior.status!=='open'||prior.pending!==null||prior.operations.length>=MAX_OPERATIONS||next.operations.length!==prior.operations.length+1)deny()
  const operation=descriptor(next.operations.at(-1))
  if(prior.operations.some(o=>o.operationId===operation.operationId||o.subjectHash===operation.subjectHash))deny()
  expected.operations.push(operation);expected.status='quarantined';expected.pending={operation,incarnation:prior.incarnation,instanceId:prior.instanceId,beforeCheckpoint:prior.checkpoint}
 }else if(event==='committed'){
  if(prior.pending===null||!hash(next.checkpoint)||next.checkpoint===prior.checkpoint||!hash(next.lastReceiptHash))deny()
  expected.checkpoint=next.checkpoint;expected.lastReceiptHash=next.lastReceiptHash;expected.pending=null;expected.status='quarantined'
 }else deny()
 if(!isDeepStrictEqual(expected,next))deny()
}

/**
 * Trusted local witness only: caller owns its OS directory and fixed DB adapter.
 * Returned reservation/evidence is diagnostic and cannot authorize execution.
 * No stale-lock deletion, journal repair, reset, takeover or history pruning.
 */
export async function openExternalIncarnationAnchor({mode,path,pinnedIdentity,initializeCheckpoint}={}){
 if(mode!==MODE||typeof path!=='string'||!path.startsWith('/')||path!==resolve(path))deny()
 const pinned=identity(pinnedIdentity),root=await privateDirectory(path),lockPath=join(path,'service.lock'),recordsPath=join(path,'records')
 // A killed owner leaves this directory behind. An uncertain owner is never stolen.
 await mkdir(lockPath,{mode:0o700});await syncDirectory(path)
 const lock=await privateDirectory(lockPath)
 let broken=false,closed=false,state,head='0'.repeat(64),sequence=0,queue=Promise.resolve()
 const names=await readdir(path)
 if(names.some(n=>!['service.lock','records'].includes(n)))deny()
 if(initializeCheckpoint!==undefined){
  if(!hash(initializeCheckpoint)||names.includes('records'))deny()
  await mkdir(recordsPath,{mode:0o700});await syncDirectory(path)
 }else if(!names.includes('records'))deny()
 const records=await privateDirectory(recordsPath)
 const checkPaths=async()=>{await unchangedDirectory(path,root);await unchangedDirectory(lockPath,lock);await unchangedDirectory(recordsPath,records)}
 const files=(await readdir(recordsPath)).sort()
 if(files.length>MAX_RECORDS||files.some((name,i)=>name!==String(i+1).padStart(8,'0')+'.json'))deny()
 for(const name of files){
  await checkPaths()
  const file=await open(join(recordsPath,name),constants.O_RDONLY|constants.O_NOFOLLOW)
  let text
  try{const s=await file.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.uid!==process.getuid()||s.size>MAX_BYTES)deny();text=await file.readFile('utf8')}finally{await file.close()}
  const record=JSON.parse(text)
  exact(record,['version','sequence','previousHash','event','state','hash'])
  const {hash:recordHash,...body}=record
  if(record.version!==1||record.sequence!==sequence+1||record.previousHash!==head||recordHash!==sha(JSON.stringify(body))||JSON.stringify(record)!==text)deny()
  validateTransition(state,record.state,record.event)
  state=record.state;head=recordHash;sequence++
 }
 if(state&&!isDeepStrictEqual(state.identity,pinned))deny()
 const append=async(event,next)=>{
  if(broken||closed||sequence>=MAX_RECORDS)deny()
  validateTransition(state,next,event);await checkPaths()
  const body={version:1,sequence:sequence+1,previousHash:head,event,state:next},record={...body,hash:sha(JSON.stringify(body))},text=JSON.stringify(record)
  if(Buffer.byteLength(text)>MAX_BYTES)deny()
  try{
   const f=await open(join(recordsPath,String(sequence+1).padStart(8,'0')+'.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
   try{await f.writeFile(text);await f.sync()}finally{await f.close()}
   await checkPaths();await syncDirectory(recordsPath)
  }catch(error){broken=true;throw error}
  state=copy(next);head=record.hash;sequence++
 }
 if(!state){if(initializeCheckpoint===undefined)deny();await append('initialize',{identity:pinned,incarnation:0,status:'quarantined',instanceId:null,checkpoint:initializeCheckpoint,lastReceiptHash:null,pending:null,operations:[]})}
 else await append('quarantine',{...state,status:'quarantined'})
 const run=fn=>{
  const result=queue.then(async()=>{if(closed||broken)deny();try{await checkPaths();return await fn()}catch(error){broken=true;throw error}})
  queue=result.catch(()=>{});return result
 }
 const evidence=()=>({...flags,sequence,recordHash:head,...copy(state)})
 const binding=b=>{
  exact(b,['anchorId','authorityId','ownerId','incarnation','instanceId','checkpoint'])
  if(!isDeepStrictEqual({anchorId:b.anchorId,authorityId:b.authorityId,ownerId:b.ownerId},pinned)||b.incarnation!==state.incarnation||b.instanceId!==state.instanceId||b.checkpoint!==state.checkpoint)deny()
 }
 return Object.freeze({
  inspect:()=>run(()=>evidence()),
  activate:({checkpoint,expectedRecordHash}={})=>run(async()=>{
   if(state.pending!==null||state.status!=='quarantined'||checkpoint!==state.checkpoint||expectedRecordHash!==head)deny()
   await append('activate',{...state,incarnation:state.incarnation+1,instanceId:randomUUID(),status:'open'});return evidence()
  }),
  reserve:({binding:bound,operation}={})=>run(async()=>{
   binding(bound);const o=descriptor(operation)
   if(state.status!=='open'||state.pending!==null||state.operations.length>=MAX_OPERATIONS||state.operations.some(prior=>prior.operationId===o.operationId||prior.subjectHash===o.subjectHash))deny()
   await append('reserve',{...state,status:'quarantined',operations:[...state.operations,o],pending:{operation:o,incarnation:state.incarnation,instanceId:state.instanceId,beforeCheckpoint:state.checkpoint}})
   return evidence()
  }),
  // Only the trusted fixed adapter may supply independently read positive commit evidence.
  // Absence, rollback or an unverifiable result has no resolution endpoint.
  recordCommitted:({binding:bound,operation,checkpoint,receiptHash}={})=>run(async()=>{
   binding(bound);const o=descriptor(operation)
   if(!state.pending||!isDeepStrictEqual(state.pending.operation,o)||!hash(checkpoint)||checkpoint===state.checkpoint||!hash(receiptHash))deny()
   await append('committed',{...state,checkpoint,lastReceiptHash:receiptHash,pending:null,status:'quarantined'});return evidence()
  }),
  quarantine:()=>run(async()=>{await append('quarantine',{...state,status:'quarantined'});return evidence()}),
  close:()=>queue.then(async()=>{
   if(closed)return
   // A pending/uncertain owner deliberately leaves its persistent lock in place.
   if(!broken&&state.pending===null){await append('quarantine',{...state,status:'quarantined'});await checkPaths();await rmdir(lockPath);await syncDirectory(path)}
   closed=true
  })
 })
}

export const EXTERNAL_INCARNATION_LAB_LIMITS=Object.freeze({records:MAX_RECORDS,recordBytes:MAX_BYTES,operations:MAX_OPERATIONS})
