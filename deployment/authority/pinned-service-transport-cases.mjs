import assert from 'node:assert/strict'
import https from 'node:https'
import {spawn} from 'node:child_process'
import {randomUUID,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {serviceTlsFixture,finishServiceTestFixture} from './service-transport-test-fixture.mjs'
import {createPostgresTestSession} from './postgres-test-session.mjs'
import {signedActionFixture} from './action-test-fixture.mjs'
import {admissionProfileSql} from './phase1gd1-profile.mjs'
import {createCatalogCertifiedQuery} from '../../local-operator/development-catalog-certified-query.mjs'
import {createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL as O} from '../../local-operator/development-ownership-rehearsal.mjs'
import {createIsolatedPinnedService,createIsolatedPinnedClient,serviceLogin,PINNED_SERVICE_LIMITS} from '../../local-operator/isolated-pinned-service-transport.mjs'
import {POSTGRES_ACTION_SQL as A} from '../../local-operator/software-factory-remote-postgres-action-fence.mjs'
import {signSyntheticResourceDescriptor} from '../../local-operator/software-factory-postgres-resource-fence.mjs'
import {signOfflineHostActionProof} from '../../local-operator/software-factory-remote-host-fence.mjs'
const mode='isolated-pinned-service-transport-only',sha=s=>createHash('sha256').update(s).digest('hex')
const roleMap={actionVerifier:'ppo_action_verifier',resourceVerifier:'ppo_resource_verifier',actionConsumer:'ppo_action_consumer',resourceConsumer:'ppo_resource_consumer',admin:'ppo_action_admin'}
export async function runPinnedServiceTransportCases(t,h){
 const {sql,container,literals:L,installImportAuthority,dropImportAuthority}=h
 const bind=(s,a)=>s.replace(/\$([1-4])/gu,(_,i)=>L(a[Number(i)-1]))
 const query=role=>async(s,a)=>({rows:[JSON.parse(await sql('SELECT row_to_json(q) FROM ('+bind(s,a)+') q;',role))]})
 const ownRoles={[O.read]:'ppo_rehearsal_controller',[O.sourceRead]:'ppo_rehearsal_controller',[O.control]:'ppo_rehearsal_controller',[O.receipt]:'ppo_rehearsal_controller',[O.source]:'ppo_rehearsal_source',[O.target]:'ppo_rehearsal_target'}
 const ownQuery=(s,a)=>createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:query(ownRoles[s]),verifierQuery:query('ppo_admission_verifier')})(s,a)
 const tls=await serviceTlsFixture()
 async function fixture(fn){
  const servers=[],sessions=new Set();let primary,hook=async(_role,_statement,execute)=>execute()
  const counts={opened:0,disposed:0,commits:0},pins=tls.registry()
  await installImportAuthority()
  try{
   for(const name of ['phase1gb2-canonical-catalog.sql','phase1gb2-ownership-rehearsal.sql','phase1gb2c-action-fencing.sql','phase1gb2c2-resource.sql'])await sql(await readFile(new URL(name,import.meta.url),'utf8'))
   await sql(await admissionProfileSql({ownership:true}))
   for(const role of Object.values(roleMap))await sql('CREATE ROLE '+serviceLogin(role)+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT; GRANT '+role+' TO '+serviceLogin(role)+';')
   const c=createSyntheticOwnershipRehearsal({mode:'synthetic-ownership-cutover-rehearsal-only',query:ownQuery})
   await c.seed();await c.freeze();await c.import();await c.activate()
   const o=await c.observe(),run=o.catalog.entries.filter(e=>e.path.startsWith('records/')).map(e=>JSON.parse(e.serialized)).find(r=>r.status==='implementation_in_progress'),f=signedActionFixture(run)
   async function open(role){
    counts.opened++
    const p=spawn('docker',['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',serviceLogin(role),'-d','ppo_authority_ci'],{stdio:['pipe','pipe','pipe']})
    const pg=createPostgresTestSession(p,{timeoutMs:20000,maxStdoutBytes:70*1024*1024});let disposed=false
    const connection={raw:s=>pg.send(s+';'),async query(s,a){return hook(role,s,async()=>{if(s==='COMMIT')counts.commits++;if(['BEGIN','COMMIT','ROLLBACK'].includes(s)){await pg.send(s+';');return {rows:[]}}return {rows:[JSON.parse(await pg.send('SELECT row_to_json(q) FROM ('+bind(s,a)+') q;'))]}})},async dispose(){if(disposed)return;disposed=true;await pg.close();sessions.delete(connection);counts.disposed++}}
    sessions.add(connection)
    try{await pg.send("\\set VERBOSITY verbose\nSET application_name='ppo-pinned-service-ci'; SET statement_timeout='7s'; SET idle_in_transaction_session_timeout='8s'; SET ROLE "+role+';');return connection}catch(e){await connection.dispose();throw e}
   }
   const addresses={}
   for(const service of ['verifier','consumer','administrator']){
    const cert=tls.certs[service],names=service==='verifier'?['actionVerifier','resourceVerifier']:service==='consumer'?['actionConsumer','resourceConsumer']:['admin']
    const s=createIsolatedPinnedService({mode,service,identity:cert.identity,tls:cert.tls,pins,connections:Object.fromEntries(names.map(k=>[k,()=>open(roleMap[k])])),verifierKeys:f.config})
    servers.push(s);addresses[service]=await s.listen()
   }
   const client=(service,peer=service==='administrator'?'admin':'coordinator')=>createIsolatedPinnedClient({mode,service,serverIdentity:tls.certs[service].identity,port:addresses[service].port,tls:tls.certs[peer].tls,pins})
   const call=(service,path,body,peer)=>client(service,peer).send(path,body)
   const configured=await call('administrator','/v1/host/configure',{hostId:f.proof.hostId,expectedEpoch:0,policy:f.policy});assert.equal(configured.status,'updated');assert.equal(configured.epoch,'1')
   const input={...f.input,ticket:randomUUID()},registered=(await call('verifier','/v1/action/register',input)).registration;assert.equal(registered?.ticket,input.ticket)
   const drain=async()=>{for(let i=0;i<100&&sessions.size;i++)await new Promise(r=>setTimeout(r,10));assert.equal(sessions.size,0)}
   await fn({f,run,registered,client,call,addresses,open,counts,pins,drain,setHook:fn=>{hook=fn},tls})
   await drain();assert.equal(counts.opened,counts.disposed)
  }catch(error){primary=error}finally{
   await finishServiceTestFixture([
    ...servers.map(s=>()=>s.close()),
    // Snapshot sessions after server shutdown, which may dispose them itself.
    async()=>finishServiceTestFixture([...sessions].map(s=>()=>s.dispose())),
    ...Object.values(roleMap).map(role=>()=>sql('DROP ROLE IF EXISTS '+serviceLogin(role)+';')),
    ()=>dropImportAuthority()
   ],primary)
  }
 }
 try{
  await t.test('real mutual TLS delegates fixed action verification and consumption through dedicated least-privilege LOGIN roles',()=>fixture(async({registered,call,counts,open,drain})=>{
   const before=await sql("SELECT sha256(convert_to(jsonb_agg(record ORDER BY run_id,version)::text,'UTF8')) FROM ppo_authority.run_versions;"),operation={ticket:registered.ticket,operationId:randomUUID()}
   // A single direct membership can still confer transitive administrator
   // authority. Reject that connection before the still-valid action mutates.
   let expanded
   await sql('GRANT ppo_action_admin TO ppo_action_consumer;')
   try{expanded=await call('consumer','/v1/action/consume',operation)}finally{await sql('REVOKE ppo_action_admin FROM ppo_action_consumer;')}
   assert.equal(expanded.status,'denied');assert.equal(await sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'0')
   const result=await call('consumer','/v1/action/consume',operation);assert.equal(result.status,'consumed-diagnostic');assert.equal(result.grant,false);assert.equal(result.canExecute,false);assert.equal(result.releaseAuthorized,false)
   assert.equal((await call('consumer','/v1/action/inspect',operation)).status,'consumed');assert.equal((await call('consumer','/v1/action/consume',operation)).status,'denied')
   assert.equal(await sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'1');assert.equal(await sql("SELECT sha256(convert_to(jsonb_agg(record ORDER BY run_id,version)::text,'UTF8')) FROM ppo_authority.run_versions;"),before)
   await drain();assert.equal(counts.commits,1)
   for(const statement of ['SET ROLE ppo_action_admin',"SELECT ppo_authority.resource_bindings_valid('{}'::jsonb,'{}'::jsonb,'{}'::jsonb)"]){const s=await open('ppo_resource_consumer');try{await assert.rejects(statement.startsWith('SET ROLE')?s.raw(statement):s.query(statement,[]),/42501/)}finally{await s.dispose()}}
   assert.equal((await call('administrator','/v1/context/revoke',{kind:'claim',hash:'a'.repeat(64)},'coordinator')).status,'denied')
  }))
  await t.test('real TLS signed resource registration effect and exact receipt preserve atomic nonce/version/receipt parity',()=>fixture(async({f,registered,call})=>{
   await sql('SELECT ppo_authority.initialize_resource();','ppo_action_admin')
   const snapshot=(await call('verifier','/v1/resource/context',{ticket:registered.ticket})).context,c=snapshot.context,r=snapshot.resource,p=c.proof,a=c.request,payload='isolated TLS synthetic value'
   const d={version:1,operationId:randomUUID(),ticket:registered.ticket,ticketHash:sha(registered.ticket),contextHash:snapshot.contextHash,sourceId:c.sourceId,targetId:c.targetId,generation:c.generation,hostId:p.hostId,hostFingerprint:c.hostFingerprint,hostEpoch:p.hostEpoch,workerId:a.workerId,capability:a.capability,requestHash:c.requestHash,claimHash:c.claimHash,proofHash:c.proofHash,runId:a.runId,runVersion:a.expectedVersion,status:'implementation_in_progress',branch:a.branch,baseSha:a.baseSha,headSha:a.headSha,resourceId:r.resource_id,expectedVersion:r.version,expectedRef:r.ref,action:p.actionType,path:p.actionPath,payloadHash:sha(payload)}
   const registeredResource=await call('verifier','/v1/resource/register',{signed:signSyntheticResourceDescriptor(JSON.stringify(d),f.keys.coordinator.privateKey),payload});assert.equal(registeredResource.status,'registered')
   const op=registeredResource.registration,result=await call('consumer','/v1/resource/apply',op);assert.equal(result.status,'consumed-diagnostic');assert.equal(result.receipt.after_state.value,payload)
   const inspect=await call('consumer','/v1/resource/inspect',op);assert.equal(inspect.status,'committed-synthetic-effect');assert.equal(inspect.grant,false)
   const state=await sql("SELECT jsonb_build_array((SELECT count(*) FROM ppo_authority.resource_versions),(SELECT count(*) FROM ppo_authority.resource_receipts),(SELECT count(*) FROM ppo_authority.action_tombstones));");assert.deepEqual(JSON.parse(state),[2,1,1]);assert.equal((await call('consumer','/v1/resource/apply',op)).status,'denied');assert.equal(await sql("SELECT jsonb_build_array((SELECT count(*) FROM ppo_authority.resource_versions),(SELECT count(*) FROM ppo_authority.resource_receipts),(SELECT count(*) FROM ppo_authority.action_tombstones));"),state)
  }))
  await t.test('actual committed lost acknowledgment is unknown; exact fresh TLS inspection never permits retry',()=>fixture(async({registered,client,call,setHook,drain,counts})=>{
   const op={ticket:registered.ticket,operationId:randomUUID()};setHook(async(_role,s,execute)=>{const r=await execute();if(s==='COMMIT')throw Error('synthetic lost PostgreSQL acknowledgment');return r})
   const api=client('consumer');assert.equal((await api.send('/v1/action/consume',op)).status,'unknown');await assert.rejects(api.send('/v1/action/consume',op));setHook(async(_role,_s,execute)=>execute());await drain();assert.equal(counts.commits,1)
   assert.equal((await call('consumer','/v1/action/inspect',op)).status,'consumed');assert.equal((await call('consumer','/v1/action/consume',op)).status,'denied');assert.equal(await sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'1')
  }))
  await t.test('maximum legal escaped payloads retain exact positive TLS receipts and reconciliation',()=>fixture(async({f,registered,call})=>{
   await sql('SELECT ppo_authority.initialize_resource();','ppo_action_admin')
   let current=registered
   for(const code of [1,2]){
    if(code===2){const signedProof=signOfflineHostActionProof({...f.proof,actionId:randomUUID().replaceAll('-','')},f.keys.host.privateKey);current=(await call('verifier','/v1/action/register',{...f.input,signedProof,ticket:randomUUID()})).registration}
    const snapshot=(await call('verifier','/v1/resource/context',{ticket:current.ticket})).context,c=snapshot.context,r=snapshot.resource,p=c.proof,a=c.request,payload=String.fromCharCode(code).repeat(4096)
    const d={version:1,operationId:randomUUID(),ticket:current.ticket,ticketHash:sha(current.ticket),contextHash:snapshot.contextHash,sourceId:c.sourceId,targetId:c.targetId,generation:c.generation,hostId:p.hostId,hostFingerprint:c.hostFingerprint,hostEpoch:p.hostEpoch,workerId:a.workerId,capability:a.capability,requestHash:c.requestHash,claimHash:c.claimHash,proofHash:c.proofHash,runId:a.runId,runVersion:a.expectedVersion,status:'implementation_in_progress',branch:a.branch,baseSha:a.baseSha,headSha:a.headSha,resourceId:r.resource_id,expectedVersion:r.version,expectedRef:r.ref,action:p.actionType,path:p.actionPath,payloadHash:sha(payload)}
    const operation=(await call('verifier','/v1/resource/register',{signed:signSyntheticResourceDescriptor(JSON.stringify(d),f.keys.coordinator.privateKey),payload})).registration
    assert.ok(operation)
    const applied=await call('consumer','/v1/resource/apply',operation),inspected=await call('consumer','/v1/resource/inspect',operation)
    assert.equal(await sql('SELECT count(*) FROM ppo_authority.resource_receipts;'),String(code))
    assert.equal(applied.status,'consumed-diagnostic');assert.equal(inspected.status,'committed-synthetic-effect');assert.equal(inspected.receipt.after_state.value,payload)
    assert.equal(inspected.receipt.before_state.value,code===1?'':String.fromCharCode(1).repeat(4096))
    for(const result of [applied,inspected]){const bytes=Buffer.byteLength(JSON.stringify(result));assert.ok(bytes>16384);assert.ok(bytes<=PINNED_SERVICE_LIMITS.responseBytes)}
    assert.deepEqual(inspected.receipt,applied.receipt);assert.equal(inspected.grant,false);assert.equal(inspected.canExecute,false);assert.equal(inspected.releaseAuthorized,false)
   }
  }))
  await t.test('HTTP disconnect disposes the actual in-flight DB session and rolls back uncommitted consumption',()=>fixture(async({registered,addresses,setHook,tls,drain,counts})=>{
   let entered,release;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r),op={ticket:registered.ticket,operationId:randomUUID()}
   setHook(async(_role,s,execute)=>{const r=await execute();if(s===A.consume){entered();await held}return r})
   const text=JSON.stringify(op),req=https.request({host:'127.0.0.1',servername:'localhost',port:addresses.consumer.port,path:'/v1/action/consume',method:'POST',...tls.certs.coordinator.tls,agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(text)}});req.on('error',()=>{});req.end(text)
   try{await ready;req.destroy();await drain();release();assert.equal(counts.commits,0);assert.equal(await sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'0')
    // docker-exec exit is not evidence that the PostgreSQL backend exited.
    const deadline=performance.now()+2000
    let remaining
    do{remaining=await sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='ppo-pinned-service-ci';");if(remaining==='0')break;await new Promise(r=>setTimeout(r,10))}while(performance.now()<deadline)
    assert.equal(remaining,'0')}finally{release();req.destroy()}
  }))
 }finally{await tls.close()}
}
