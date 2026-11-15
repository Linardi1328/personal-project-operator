// Disposable PostgreSQL + external-disk witness evidence, not a production gateway.
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp,chmod,rm,readFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {openExternalIncarnationAnchor} from '../../local-operator/development-external-incarnation-anchor.mjs'
import {createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL as O} from '../../local-operator/development-ownership-rehearsal.mjs'
import {createCatalogCertifiedQuery} from '../../local-operator/development-catalog-certified-query.mjs'
import {createIsolatedPostgresActionVerifier} from '../../local-operator/software-factory-remote-postgres-action-fence.mjs'
import {signedActionFixture} from './action-test-fixture.mjs'
import {admissionProfileSql} from './phase1gd1-profile.mjs'

const container=process.env.PPO_AUTHORITY_TEST_CONTAINER,db='ppo_authority_ci',clone='ppo_authority_clone_ci'
if(process.env.CI!=='true'||!/^ppo-authority-ci-[0-9]+-[0-9]+$/u.test(container||''))throw Error('Dedicated disposable authority container required')
const sha=s=>createHash('sha256').update(s).digest('hex'),flags={grant:false,canExecute:false,releaseAuthorized:false}
const L=v=>v===null?'NULL':typeof v==='number'?String(v):"convert_from(decode('"+Buffer.from(v).toString('base64')+"','base64'),'UTF8')"
function docker(args,input){const r=spawnSync('docker',['exec','-i',container,...args],{input,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr||String(r.error));return r.stdout.trim()}
function sql(text,role='postgres',database=db){assert.ok([db,clone].includes(database));return docker(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],"SET statement_timeout='15s';SET ROLE "+role+';'+text)}
const bind=(s,args)=>s.replace(/\$([1-3])/gu,(_,i)=>L(args[Number(i)-1]))
const query=role=>async(s,args)=>({rows:[JSON.parse(sql('SELECT row_to_json(q) FROM ('+bind(s,args)+') q;',role))]})
const rawConsume=o=>'SELECT ppo_authority.consume_action('+L(o.ticket)+'::uuid,'+L(o.operationId)+'::uuid);'
function checkpoint(database=db){
 // Native PostgreSQL text, all actual schema tables, sorted without JS numeric conversion.
 const tables=JSON.parse(sql("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='ppo_authority';",'postgres',database))
 assert.ok(tables.length>10&&tables.every(name=>/^[a-z_]+$/u.test(name)))
 const parts=tables.map(name=>"SELECT "+L(name)+" AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ppo_authority."+name+' t')
 return sha(sql("SELECT jsonb_agg(q ORDER BY name)::text FROM ("+parts.join(' UNION ALL ')+') q;','postgres',database))
}
const binding=(e,ownerId=e.identity.ownerId,actual=e.checkpoint)=>({...e.identity,ownerId,incarnation:e.incarnation,instanceId:e.instanceId,checkpoint:actual})
async function activate(witness,database=db){const e=await witness.inspect();return witness.activate({checkpoint:checkpoint(database),expectedRecordHash:e.recordHash})}
function dump(){return docker(['pg_dump','-U','postgres','-d',db,'--schema=ppo_authority'])}
function restore(snapshot,database=db){sql('DROP SCHEMA IF EXISTS ppo_authority CASCADE;','postgres',database);sql(snapshot,'postgres',database)}
async function fixture(t,{lifetime}={}){
 for(const file of ['phase1gb2-canonical-postgres.sql','phase1gb2-synthetic-import.sql','phase1gb2-canonical-catalog.sql','phase1gb2-ownership-rehearsal.sql','phase1gb2c-action-fencing.sql','phase1gb2c2-resource.sql'])sql(await readFile(new URL(file,import.meta.url),'utf8'))
 sql(await admissionProfileSql({ownership:true}))
 t.after(()=>{sql('DROP DATABASE IF EXISTS '+clone+';');sql('DROP SCHEMA IF EXISTS ppo_authority CASCADE;DROP OWNED BY ppo_authority_owner;DROP ROLE IF EXISTS ppo_authority_importer,ppo_authority_reader,ppo_authority_writer,ppo_authority_owner,ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target,ppo_action_admin,ppo_action_verifier,ppo_action_consumer,ppo_resource_verifier,ppo_resource_consumer,ppo_admission_verifier;')})
 const roles={[O.read]:'ppo_rehearsal_controller',[O.sourceRead]:'ppo_rehearsal_controller',[O.control]:'ppo_rehearsal_controller',[O.receipt]:'ppo_rehearsal_controller',[O.source]:'ppo_rehearsal_source',[O.target]:'ppo_rehearsal_target'}
 const ownQuery=(s,args)=>createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:query(roles[s]),verifierQuery:query('ppo_admission_verifier')})(s,args)
 const owner=createSyntheticOwnershipRehearsal({mode:'synthetic-ownership-cutover-rehearsal-only',query:ownQuery})
 await owner.seed();await owner.freeze();await owner.import();await owner.activate()
 const observed=await owner.observe(),run=observed.catalog.entries.filter(e=>e.path.startsWith('records/')).map(e=>JSON.parse(e.serialized)).find(r=>r.status==='implementation_in_progress')
 const f=signedActionFixture(run,lifetime===undefined?{}:{lifetime})
 sql('SELECT ppo_authority.configure_action_host('+L(f.proof.hostId)+',0,'+L(JSON.stringify(f.policy))+');','ppo_action_admin')
 const verifier=createIsolatedPostgresActionVerifier({mode:'isolated-postgres-action-fencing-only',query:query('ppo_action_verifier'),...f.config})
 const registered=await verifier.register(f.input),operation={ticket:registered.ticket,operationId:randomUUID()}
 const path=await realpath(await mkdtemp(join(tmpdir(),'ppo-pg-external-anchor-')));await chmod(path,0o700)
 let witness
 t.after(async()=>{try{await witness?.close()}finally{await rm(path,{recursive:true,force:true})}})
 const pinnedIdentity={anchorId:randomUUID(),authorityId:observed.owner.target_id,ownerId:randomUUID()}
 const config={mode:'isolated-external-incarnation-anchor-only',path,pinnedIdentity}
 witness=await openExternalIncarnationAnchor({...config,initializeCheckpoint:checkpoint()})
 return {f,operation,witness,config}
}

// This private adapter exposes only two existing fixed diagnostic SQL operations.
// The injected witness is trusted local infrastructure, never a client-supplied callback.
// Other existing writer entrypoints still bypass it: this is an explicit incomplete-2C proof.
function fixedAdapter({witness,f,ownerId,database=db}){
 async function reserve(kind,input,subject){
  const e=await witness.inspect(),bound=binding(e,ownerId,checkpoint(database))
  const operation={operationId:input.operationId,kind,subjectHash:sha(JSON.stringify([kind,subject])),inputHash:sha(JSON.stringify(input))}
  await witness.reserve({binding:bound,operation});return {bound,operation}
 }
 async function consumedEvidence(o){
  const row=JSON.parse(sql('SELECT to_jsonb(t) FROM ppo_authority.action_tombstones t WHERE operation_id='+L(o.operationId)+'::uuid;','postgres',database)||'null')
  assert.ok(row,'Missing evidence remains unknown; no reconciliation or retry')
  assert.equal(row.operation_id,o.operationId);assert.equal(row.ticket,o.ticket);assert.equal(row.host_id,f.proof.hostId);assert.equal(row.action_id,f.proof.actionId)
  return row
 }
 return Object.freeze({
  async consume(o,{loseAcknowledgment=false,expireAfterReservation=false}={}){
   const reserved=await reserve('consume-action',o,[f.proof.hostId,f.proof.actionId])
   if(expireAfterReservation){
    const deadline=new Date(Math.min(Date.parse(f.request.expiresAt),Date.parse(f.claim.leaseExpiresAt),Date.parse(f.proof.expiresAt))).toISOString()
    sql('SELECT pg_sleep(greatest(0,extract(epoch FROM ('+L(deadline)+'::timestamptz-clock_timestamp())))+0.02);','postgres',database)
   }
   const result=JSON.parse(sql(rawConsume(o),'ppo_action_consumer',database))
   if(result.consumed!==true)return {...flags,status:'denied-pending',reserved}
   if(loseAcknowledgment)return {...flags,status:'unknown',reserved}
   const receipt=await consumedEvidence(o)
   await witness.recordCommitted({binding:reserved.bound,operation:reserved.operation,checkpoint:checkpoint(database),receiptHash:sha(JSON.stringify(receipt))})
   return {...flags,status:'committed-diagnostic'}
  },
  async revokeHost(operationId){
   const policy={...f.policy,status:'revoked'},input={operationId,hostId:f.proof.hostId,expectedEpoch:1,policy},reserved=await reserve('revoke-host',input,f.proof.hostId)
   assert.equal(sql('SELECT ppo_authority.configure_action_host('+L(f.proof.hostId)+',1,'+L(JSON.stringify(policy))+');','ppo_action_admin',database),'2')
   const row=JSON.parse(sql('SELECT to_jsonb(h) FROM ppo_authority.action_hosts h;','postgres',database));assert.equal(row.epoch,2);assert.equal(row.policy.status,'revoked')
   await witness.recordCommitted({binding:reserved.bound,operation:reserved.operation,checkpoint:checkpoint(database),receiptHash:sha(JSON.stringify(row))})
   return {...flags,status:'revoked-diagnostic'}
  },
  async reconcileConsumed(o,reserved){
   const receipt=await consumedEvidence(o)
   return witness.recordCommitted({binding:reserved.bound,operation:reserved.operation,checkpoint:checkpoint(database),receiptHash:sha(JSON.stringify(receipt))})
  }
 })
}

test('2C external witness rejects actual PostgreSQL rollback of nonce consumption and host revocation',{timeout:60000},async t=>{
 const x=await fixture(t),snapshot=dump();await activate(x.witness)
 const adapter=fixedAdapter({...x,ownerId:x.config.pinnedIdentity.ownerId})
 assert.equal((await adapter.consume(x.operation)).status,'committed-diagnostic');await activate(x.witness)
 assert.equal((await adapter.revokeHost(randomUUID())).status,'revoked-diagnostic');await activate(x.witness)
 const retained=await x.witness.inspect();assert.equal(retained.operations.length,2)
 restore(snapshot)
 assert.equal(sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'0')
 assert.equal(sql("SELECT policy->>'status' FROM ppo_authority.action_hosts;"),'active')
 // Honest negative control: raw SQL remains vulnerable without witness integration.
 assert.equal(JSON.parse(sql('BEGIN;'+rawConsume(x.operation)+'ROLLBACK;','ppo_action_consumer')).consumed,true)
 const before=checkpoint()
 await assert.rejects(adapter.consume(x.operation),/denied|quarantined/)
 assert.equal(checkpoint(),before)
 await x.witness.close();await assert.rejects(openExternalIncarnationAnchor(x.config),/EEXIST/)
})

test('2C actual database clone has no externally enrolled owner and cannot reinitialize a witness',{timeout:60000},async t=>{
 const x=await fixture(t),snapshot=dump();sql('CREATE DATABASE '+clone+';');restore(snapshot,clone)
 assert.equal(checkpoint(clone),checkpoint())
 await activate(x.witness)
 const cloneAdapter=fixedAdapter({...x,database:clone,ownerId:randomUUID()}),before=checkpoint(clone)
 await assert.rejects(cloneAdapter.consume(x.operation),/denied|quarantined/)
 assert.equal(checkpoint(clone),before)
 await assert.rejects(openExternalIncarnationAnchor({...x.config,initializeCheckpoint:before}),/EEXIST/)
})

test('2C lost acknowledgment stays pending until exact positive PostgreSQL reconciliation',{timeout:60000},async t=>{
 const x=await fixture(t);await activate(x.witness)
 const adapter=fixedAdapter({...x,ownerId:x.config.pinnedIdentity.ownerId}),unknown=await adapter.consume(x.operation,{loseAcknowledgment:true})
 assert.equal(unknown.status,'unknown');assert.equal((await x.witness.inspect()).pending.operation.operationId,x.operation.operationId)
 const reconciled=await adapter.reconcileConsumed(x.operation,unknown.reserved);assert.equal(reconciled.pending,null);assert.equal(reconciled.status,'quarantined')
 const active=await activate(x.witness);assert.equal(active.operations.length,1)
 assert.equal(JSON.parse(sql(rawConsume(x.operation),'ppo_action_consumer')).consumed,false)
 for(const key of ['grant','canExecute','releaseAuthorized'])assert.equal(reconciled[key],false)
})

test('2C restored missing positive outcome cannot reconcile an outstanding operation',{timeout:60000},async t=>{
 const x=await fixture(t),snapshot=dump();await activate(x.witness)
 const adapter=fixedAdapter({...x,ownerId:x.config.pinnedIdentity.ownerId}),unknown=await adapter.consume(x.operation,{loseAcknowledgment:true})
 restore(snapshot)
 await assert.rejects(adapter.reconcileConsumed(x.operation,unknown.reserved),/Missing evidence remains unknown/)
 assert.equal((await x.witness.inspect()).pending.operation.operationId,x.operation.operationId)
 await x.witness.close();await assert.rejects(openExternalIncarnationAnchor(x.config),/EEXIST/)
})

test('2C expiry after durable reservation cannot produce a first effect or be upgraded by recovery',{timeout:60000},async t=>{
 const x=await fixture(t,{lifetime:5000});await activate(x.witness)
 // Positive rollback control establishes the exact action is valid/fresh
 // before the durable reservation and deadline wait.
 assert.equal(JSON.parse(sql('BEGIN;'+rawConsume(x.operation)+'ROLLBACK;','ppo_action_consumer')).consumed,true)
 const adapter=fixedAdapter({...x,ownerId:x.config.pinnedIdentity.ownerId})
 const denied=await adapter.consume(x.operation,{expireAfterReservation:true})
 assert.equal(denied.status,'denied-pending');assert.equal(sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'0')
 const before=checkpoint(),pending=(await x.witness.inspect()).pending
 await assert.rejects(adapter.reconcileConsumed(x.operation,denied.reserved),/Missing evidence remains unknown/)
 assert.equal(checkpoint(),before);assert.deepEqual((await x.witness.inspect()).pending,pending)
 assert.equal((await x.witness.inspect()).status,'quarantined')
 for(const key of ['grant','canExecute','releaseAuthorized'])assert.equal(denied[key],false)
})
