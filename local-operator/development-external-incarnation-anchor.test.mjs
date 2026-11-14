import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,chmod,rm,readFile,writeFile,rename,symlink,mkdir,readdir,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {openExternalIncarnationAnchor,EXTERNAL_INCARNATION_LAB_LIMITS} from './development-external-incarnation-anchor.mjs'

const mode='isolated-external-incarnation-anchor-only',hash=x=>createHash('sha256').update(x).digest('hex')
const binding=e=>({...e.identity,incarnation:e.incarnation,instanceId:e.instanceId,checkpoint:e.checkpoint})
const operation=()=>({operationId:randomUUID(),kind:'consume-action',subjectHash:hash(randomUUID()),inputHash:hash(randomUUID())})
async function fixture(t){
 const path=await realpath(await mkdtemp(join(tmpdir(),'ppo-external-anchor-')));await chmod(path,0o700)
 let witness
 t.after(async()=>{try{await witness?.close()}finally{await rm(path,{recursive:true,force:true})}})
 const pinnedIdentity={anchorId:randomUUID(),authorityId:randomUUID(),ownerId:randomUUID()},config={mode,path,pinnedIdentity},checkpoint=hash('initial')
 witness=await openExternalIncarnationAnchor({...config,initializeCheckpoint:checkpoint})
 return {path,config,witness,checkpoint}
}
async function activate(witness){const e=await witness.inspect();return witness.activate({checkpoint:e.checkpoint,expectedRecordHash:e.recordHash})}
function noGrant(e){for(const k of ['grant','canExecute','releaseAuthorized'])assert.equal(e[k],false)}

test('external witness starts quarantined and exact activation advances durable incarnation',async t=>{
 const {witness,config,checkpoint}=await fixture(t),initial=await witness.inspect()
 assert.equal(initial.status,'quarantined');assert.equal(initial.incarnation,0);noGrant(initial)
 const active=await activate(witness);assert.equal(active.status,'open');assert.equal(active.incarnation,1);noGrant(active)
 await witness.close()
 const reopened=await openExternalIncarnationAnchor(config);t.after(()=>reopened.close())
 const quarantined=await reopened.inspect();assert.equal(quarantined.status,'quarantined');assert.equal(quarantined.checkpoint,checkpoint)
 const next=await activate(reopened);assert.equal(next.incarnation,2);assert.notEqual(next.instanceId,active.instanceId)
 await assert.rejects(reopened.reserve({binding:binding(active),operation:operation()}),/denied|quarantined/)
})

test('exclusive witness ownership rejects concurrent opening and reinitialization',async t=>{
 const {config,witness,checkpoint}=await fixture(t)
 await assert.rejects(openExternalIncarnationAnchor(config),/EEXIST/)
 await witness.close()
 await assert.rejects(openExternalIncarnationAnchor({...config,initializeCheckpoint:checkpoint}),/denied|quarantined/)
})

test('one pending immutable identity blocks competing work and exact positive evidence is durable',async t=>{
 const {witness,config}=await fixture(t),active=await activate(witness),op=operation()
 const reserved=await witness.reserve({binding:binding(active),operation:op});assert.equal(reserved.status,'quarantined');assert.deepEqual(reserved.pending.operation,op);noGrant(reserved)
 const receiptHash=hash('exact-receipt'),checkpoint=hash('post-operation')
 const committed=await witness.recordCommitted({binding:binding(active),operation:op,checkpoint,receiptHash})
 assert.equal(committed.pending,null);assert.equal(committed.status,'quarantined');assert.equal(committed.lastReceiptHash,receiptHash)
 const next=await activate(witness);assert.equal(next.incarnation,2)
 await witness.close();const reopened=await openExternalIncarnationAnchor(config);t.after(()=>reopened.close())
 assert.equal((await reopened.inspect()).lastReceiptHash,receiptHash)
 const current=await activate(reopened)
 await assert.rejects(reopened.reserve({binding:binding(current),operation:{...op,operationId:randomUUID()}}),/denied|quarantined/)
})

test('pending or mismatched evidence cannot clear uncertainty or create another owner',async t=>{
 const {witness,config}=await fixture(t),active=await activate(witness),op=operation()
 await witness.reserve({binding:binding(active),operation:op})
 await assert.rejects(witness.recordCommitted({binding:binding(active),operation:{...op,inputHash:hash('other')},checkpoint:hash('after'),receiptHash:hash('receipt')}),/denied|quarantined/)
 await witness.close();await assert.rejects(openExternalIncarnationAnchor(config),/EEXIST/)
})

test('a second operation cannot displace a pending reservation',async t=>{
 const {witness,path}=await fixture(t),active=await activate(witness),op=operation()
 await witness.reserve({binding:binding(active),operation:op})
 const names=await readdir(join(path,'records'))
 await assert.rejects(witness.reserve({binding:binding(active),operation:operation()}),/denied|quarantined/)
 assert.deepEqual(await readdir(join(path,'records')),names)
})

test('restored checkpoints and different authority or owner bindings deny',async t=>{
 for(const field of ['checkpoint','ownerId','authorityId','anchorId','instanceId','incarnation']){
  const {witness}=await fixture(t),active=await activate(witness),bound=binding(active)
  bound[field]=field==='checkpoint'?hash('rollback'):field==='incarnation'?0:randomUUID()
  await assert.rejects(witness.reserve({binding:bound,operation:operation()}),/denied|quarantined/)
 }
})

test('partial append and changed journal bytes fail closed without repair',async t=>{
 for(const corruption of ['partial','changed','symlink']){
  const {witness,path,config}=await fixture(t);await witness.close()
  const names=(await readdir(join(path,'records'))).sort(),target=join(path,'records',names.at(-1))
  if(corruption==='partial')await writeFile(join(path,'records',String(names.length+1).padStart(8,'0')+'.json'),'{',{mode:0o600})
  if(corruption==='changed'){const record=JSON.parse(await readFile(target,'utf8'));record.state.checkpoint=hash('tampered');await writeFile(target,JSON.stringify(record))}
  if(corruption==='symlink'){await rename(target,target+'.moved');await symlink(target+'.moved',target)}
  await assert.rejects(openExternalIncarnationAnchor(config))
  await assert.rejects(openExternalIncarnationAnchor(config),/EEXIST/)
 }
})

test('root and journal directory substitution and permissive ownership deny',async t=>{
 for(const target of ['root','records','permissions']){
  const {witness,path}=await fixture(t)
  if(target==='permissions')await chmod(path,0o755)
  else if(target==='records'){await rename(join(path,'records'),join(path,'old-records'));await mkdir(join(path,'records'),{mode:0o700})}
  else {await rename(path,path+'.moved');await mkdir(path,{mode:0o700});t.after(()=>rm(path+'.moved',{recursive:true,force:true}))}
  await assert.rejects(witness.inspect(),/denied|quarantined/)
 }
})

test('process termination leaves a persistent lock; another process cannot steal it',{timeout:10000},async t=>{
 const path=await realpath(await mkdtemp(join(tmpdir(),'ppo-external-anchor-kill-')));await chmod(path,0o700);t.after(()=>rm(path,{recursive:true,force:true}))
 const config={mode,path,pinnedIdentity:{anchorId:randomUUID(),authorityId:randomUUID(),ownerId:randomUUID()}}
 const script=`import {openExternalIncarnationAnchor} from ${JSON.stringify(new URL('./development-external-incarnation-anchor.mjs',import.meta.url).href)}; await openExternalIncarnationAnchor({...JSON.parse(process.argv[1]),initializeCheckpoint:${JSON.stringify(hash('initial'))}}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`
 const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{stdio:['ignore','pipe','pipe']})
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')})
 await once(child.stdout,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited
 await assert.rejects(openExternalIncarnationAnchor(config),/EEXIST/)
})

test('bounded immutable history exhausts without deleting earlier reservations',async t=>{
 const {witness,path}=await fixture(t)
 for(let i=0;i<EXTERNAL_INCARNATION_LAB_LIMITS.operations;i++){
  const active=await activate(witness),op=operation()
  await witness.reserve({binding:binding(active),operation:op})
  await witness.recordCommitted({binding:binding(active),operation:op,checkpoint:hash('checkpoint-'+i),receiptHash:hash('receipt-'+i)})
 }
 const active=await activate(witness),before=await readdir(join(path,'records'))
 assert.equal(active.operations.length,EXTERNAL_INCARNATION_LAB_LIMITS.operations)
 await assert.rejects(witness.reserve({binding:binding(active),operation:operation()}),/denied|quarantined/)
 assert.deepEqual(await readdir(join(path,'records')),before)
})
