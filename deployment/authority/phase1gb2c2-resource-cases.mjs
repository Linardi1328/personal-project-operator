import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {signOfflineHostActionProof} from '../../local-operator/software-factory-remote-host-fence.mjs'
import {signedActionFixture} from './action-test-fixture.mjs'
import {POSTGRES_ACTION_SQL as A} from '../../local-operator/software-factory-remote-postgres-action-fence.mjs'
import {RESOURCE_SQL as S,signSyntheticResourceDescriptor,createSyntheticResourceVerifier,createSyntheticResourceFence,inspectSyntheticResourceReceipt} from '../../local-operator/software-factory-postgres-resource-fence.mjs'
const mode='isolated-postgres-resource-fencing-only',sha=s=>createHash('sha256').update(s).digest('hex')
export async function runResourceCases(t,h){
 const {fixture,sql,session,blockedBy,L,query,host,verifier,rawConsume,container}=h
 const bind=(s,a)=>s.replace(/\$([1-3])/gu,(_,i)=>L(a[Number(i)-1]))
 const state=()=>sql("SELECT jsonb_build_object('versions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY version) FROM ppo_authority.resource_versions r),'receipts',(SELECT count(*) FROM ppo_authority.resource_receipts),'nonces',(SELECT count(*) FROM ppo_authority.action_tombstones),'receiptRows',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY operation_id),'[]') FROM ppo_authority.resource_receipts r),'nonceRows',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY operation_id),'[]') FROM ppo_authority.action_tombstones r),'operationRows',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY operation_id),'[]') FROM ppo_authority.resource_operations r));")
 const apply=o=>"SELECT ppo_authority.apply_resource_operation("+L(o.operationId)+"::uuid,"+L(o.descriptorHash)+");"
 async function setup(x,options={}){
  if(!options.initialized)await sql('SELECT ppo_authority.initialize_resource();','ppo_action_admin')
  const f=options.f??x.f,registered=options.registered??x.registered
  const snapshot=(await query('ppo_resource_verifier')(S.read,[registered.ticket])).rows[0].context,c=snapshot.context,r=snapshot.resource,p=c.proof,a=c.request
  const payload='synthetic value',d={version:1,operationId:randomUUID(),ticket:registered.ticket,ticketHash:sha(registered.ticket),contextHash:snapshot.contextHash,sourceId:c.sourceId,targetId:c.targetId,generation:c.generation,
   hostId:p.hostId,hostFingerprint:c.hostFingerprint,hostEpoch:p.hostEpoch,workerId:a.workerId,capability:a.capability,requestHash:c.requestHash,claimHash:c.claimHash,proofHash:c.proofHash,
   runId:a.runId,runVersion:a.expectedVersion,status:'implementation_in_progress',branch:a.branch,baseSha:a.baseSha,headSha:a.headSha,resourceId:r.resource_id,expectedVersion:r.version,expectedRef:r.ref,action:p.actionType,path:p.actionPath,payloadHash:sha(payload)}
  const v=createSyntheticResourceVerifier({mode,query:query('ppo_resource_verifier'),publicKey:f.keys.coordinator.publicKey})
  const register=desc=>v.register(signSyntheticResourceDescriptor(JSON.stringify(desc),f.keys.coordinator.privateKey),payload)
  return {d,payload,register,o:await register(d),f}
 }
 async function client(name,hook=async(s,fn)=>fn()){
  const c=session(name,'ppo_resource_consumer');await c.ready()
  const q=async(s,args)=>hook(s,async()=>{
   if(['BEGIN','ROLLBACK','COMMIT'].includes(s)){await c.send(s+';');return {rows:[]}}
   return {rows:[JSON.parse(await c.send('SELECT row_to_json(q) FROM ('+bind(s,args)+') q;'))]}
  },c)
  return {close:c.close,api:createSyntheticResourceFence({mode,query:q})}
 }
 await t.test('resource signed descriptor and payload bindings deny tampering before effect',()=>fixture(async x=>{
  const {d,register,payload}=await setup(x),before=await state()
  for(const change of [{hostEpoch:2},{resourceId:randomUUID()},{expectedVersion:1},{expectedRef:'a'.repeat(64)},{headSha:'a'.repeat(40)},{requestHash:'f'.repeat(64)},{ticketHash:'f'.repeat(64)},{sourceId:randomUUID()},{generation:'4'},{workerId:'antigravity'},{contextHash:'a'.repeat(64)},{proofHash:'a'.repeat(64)}])await assert.rejects(register({...d,operationId:randomUUID(),...change}))
  const v=createSyntheticResourceVerifier({mode,query:query('ppo_resource_verifier'),publicKey:x.f.keys.coordinator.publicKey})
  await assert.rejects(v.register(signSyntheticResourceDescriptor(JSON.stringify({...d,operationId:randomUUID()}),x.f.keys.coordinator.privateKey),payload+'!'))
  const bad=signSyntheticResourceDescriptor(JSON.stringify(d),x.f.keys.coordinator.privateKey);await assert.rejects(v.register({...bad,signature:'a'.repeat(86)},payload))
  assert.equal(await state(),before)
 }))
 await t.test('resource effect nonce and exact receipt commit atomically; diagnostic consumption cannot be reused',()=>fixture(async x=>{
  const {o}=await setup(x),c=await client('resource-positive')
  try{const result=await c.api.apply(o);assert.equal(result.status,'consumed-diagnostic');assert.equal(result.grant,false);assert.equal(result.receipt.after_state.version,1)}finally{await c.close()}
  const after=await state();assert.equal(JSON.parse(await sql(apply(o),'ppo_resource_consumer')).applied,false);assert.equal(await state(),after)
  assert.equal((await inspectSyntheticResourceReceipt({mode,operation:o,query:query('ppo_resource_consumer')})).status,'committed-synthetic-effect')
  const f=signedActionFixture(x.run,{keys:x.f.keys,epoch:2});await host(f,1);const registered=await verifier(f).register(f.input)
  const next=await setup(x,{initialized:true,f,registered});await sql(rawConsume(registered.ticket),'ppo_action_consumer')
  const before=await state();assert.equal(JSON.parse(await sql(apply(next.o),'ppo_resource_consumer')).applied,false);assert.equal(await state(),before)
 }))
 // D2 probes use the actual clock deadline, never a sleep to choose a race winner.
 const deadline=f=>new Date(Math.min(Date.parse(f.request.expiresAt),Date.parse(f.claim.leaseExpiresAt),Date.parse(f.proof.expiresAt))).toISOString()
 const waitPastExpiry=f=>"SELECT pg_sleep(greatest(0,extract(epoch FROM ("+L(deadline(f))+"::timestamptz-clock_timestamp())))+0.02);"
 const check=o=>"SELECT ppo_authority.check_action("+L(o.ticket)+"::uuid,"+L(o.operationId)+"::uuid,false);"
 async function assertAtomic(before,o){
  const prior=JSON.parse(before),after=JSON.parse(await state()),receipt=after.receiptRows.find(r=>r.operation_id===o.operationId),nonce=after.nonceRows.find(r=>r.operation_id===o.operationId)
  assert.equal(after.versions.length,prior.versions.length+1);assert.equal(after.receipts,prior.receipts+1);assert.equal(after.nonces,prior.nonces+1)
  assert.deepEqual(after.versions.slice(0,-1),prior.versions);assert.deepEqual(after.operationRows,prior.operationRows)
  assert.deepEqual(after.receiptRows.filter(r=>r.operation_id!==o.operationId),prior.receiptRows)
  assert.deepEqual(after.nonceRows.filter(r=>r.operation_id!==o.operationId),prior.nonceRows)
  assert.equal(receipt.ticket,o.ticket);assert.equal(receipt.descriptor_hash,o.descriptorHash)
  assert.deepEqual(receipt.before_state,prior.versions.at(-1));assert.deepEqual(receipt.after_state,after.versions.at(-1))
  assert.equal(receipt.after_state.ref,sha(receipt.after_state.value));assert.equal(nonce.ticket,o.ticket)
  const evidence=await inspectSyntheticResourceReceipt({mode,operation:o,query:query('ppo_resource_consumer')})
  assert.equal(evidence.status,'committed-synthetic-effect');assert.equal(evidence.grant,false);assert.equal(evidence.canExecute,false);assert.equal(evidence.releaseAuthorized,false)
  const unchanged=await state();assert.equal(JSON.parse(await sql(apply(o),'ppo_resource_consumer')).applied,false);assert.equal(await state(),unchanged)
 }
 await t.test('D2 ordinary resource roles deny valid direct DML with exact SQLSTATE and private helper isolation',()=>fixture(async x=>{
  const {o}=await setup(x)
  assert.equal(JSON.parse(await sql(apply(o),'ppo_resource_consumer')).applied,true)
  // A distinct valid registered operation gives receipt INSERT a real FK target.
  const fresh={...x.f,input:{...x.f.input,signedProof:signOfflineHostActionProof({...x.f.proof,actionId:randomUUID().replaceAll('-','')},x.f.keys.host.privateKey)}}
  const registered=await verifier(fresh).register(fresh.input),next=await setup(x,{initialized:true,f:fresh,registered}),current=JSON.parse(await state()).versions.at(-1)
  const value='permission-positive-control',after={...current,version:current.version+1,ref:sha(value),value},newId=randomUUID(),descriptor={...next.d,operationId:newId},text=JSON.stringify(descriptor)
  const inserts={
   resource_versions:'INSERT INTO ppo_authority.resource_versions(resource_id,version,project,path,ref,value) VALUES('+[L(after.resource_id)+'::uuid',L(after.version),L(after.project),L(after.path),L(after.ref),L(after.value)].join(',')+');',
   resource_operations:'INSERT INTO ppo_authority.resource_operations(operation_id,ticket,descriptor,payload,descriptor_hash) VALUES('+[L(newId)+'::uuid',L(next.o.ticket)+'::uuid',L(text)+'::jsonb',L(next.payload),L(sha(text))].join(',')+');',
   resource_receipts:'INSERT INTO ppo_authority.resource_receipts(operation_id,ticket,before_state,after_state,descriptor_hash) VALUES('+[L(next.o.operationId)+'::uuid',L(next.o.ticket)+'::uuid',L(JSON.stringify(current))+'::jsonb',L(JSON.stringify(after))+'::jsonb',L(next.o.descriptorHash)].join(',')+');'
  }
  const before=await state()
  // These are constraint-valid INSERTs, not INSERT...SELECT from protected tables.
  await sql('BEGIN;'+Object.values(inserts).join('')+'ROLLBACK;');assert.equal(await state(),before)
  const roles=JSON.parse(await sql("SELECT jsonb_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname IN ('ppo_authority_writer','ppo_authority_reader','ppo_authority_importer','ppo_rehearsal_controller','ppo_rehearsal_source','ppo_rehearsal_target','ppo_action_consumer','ppo_action_verifier','ppo_action_admin','ppo_resource_verifier','ppo_resource_consumer','ppo_admission_verifier');"))
  assert.equal(roles.length,await sql("SELECT to_regrole('ppo_admission_verifier') IS NOT NULL;")==='t'?12:11)
  const privateCalls=[
   ['resource_bindings_valid(jsonb,jsonb,jsonb)',"resource_bindings_valid('{}'::jsonb,'{}'::jsonb,'{}'::jsonb)"],
   ['action_bindings_valid(jsonb)',"action_bindings_valid('{}'::jsonb)"],
   ['action_commit_freshness()','action_commit_freshness()'],['refuse_history_mutation()','refuse_history_mutation()'],
   ['rehearsal_apply(text,text)',"rehearsal_apply('{}'::text,'control'::text)"],
   ['admission_commit_core(text,integer,text,text)',"admission_commit_core('x'::text,-1,NULL::text,'{}'::text)"],
   ['admission_import_core(text,text)',"admission_import_core('x'::text,'[]'::text)"],
   ['admission_rehearsal_core(text,text)',"admission_rehearsal_core('{}'::text,'control'::text)"]
  ]
  const existing=[]
  for(const [signature,call] of privateCalls)if(await sql('SELECT to_regprocedure('+L('ppo_authority.'+signature)+') IS NOT NULL;')==='t')existing.push([signature,call])
  const tableStatements=Object.entries(inserts).map(([table,insert])=>[table,[insert,'UPDATE ppo_authority.'+table+' SET '+(table==='resource_versions'?'value=value':'descriptor_hash=descriptor_hash')+';','DELETE FROM ppo_authority.'+table+';','TRUNCATE TABLE ppo_authority.'+table+' CASCADE;']])
  // Privileged EXPLAIN resolves all column names/types once, before denials.
  for(const [,statements] of tableStatements)for(const statement of statements.slice(0,3))await sql('EXPLAIN (COSTS OFF) '+statement)
  for(const role of roles){
   const checks=[['schema',"has_schema_privilege("+L(role)+",'ppo_authority','USAGE')",true]]
   for(const table of Object.keys(inserts))for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])checks.push([table+':'+privilege,'has_table_privilege('+L(role)+','+L('ppo_authority.'+table)+','+L(privilege)+')',false])
   for(const [signature] of existing)checks.push([signature,'has_function_privilege('+L(role)+','+L('ppo_authority.'+signature)+",'EXECUTE')",false])
   for(const [signature,allowed] of [['initialize_resource()','ppo_action_admin'],['read_resource_context(uuid)','ppo_resource_verifier'],['register_resource_operation(text,text,text)','ppo_resource_verifier'],['apply_resource_operation(uuid,text)','ppo_resource_consumer'],['read_resource_receipt(uuid,text)','ppo_resource_consumer']])checks.push([signature,'has_function_privilege('+L(role)+','+L('ppo_authority.'+signature)+",'EXECUTE')",role===allowed])
   assert.deepEqual(JSON.parse(await sql('SELECT jsonb_build_object('+checks.map(([name,expression])=>L(name)+','+expression).join(',')+');')),Object.fromEntries(checks.map(([name,,expected])=>[name,expected])),role+' privilege matrix')
   for(const [table,statements] of tableStatements)for(const statement of statements)await assert.rejects(sql('\\set VERBOSITY verbose\n'+statement,role),error=>new RegExp('ERROR:\\s+42501:\\s+permission denied for table '+table+'\\b').test(error.message),role+' '+statement)
   for(const [signature,call] of existing)await assert.rejects(sql('\\set VERBOSITY verbose\nSELECT ppo_authority.'+call+';',role),error=>new RegExp('ERROR:\\s+42501:\\s+permission denied for function '+signature.split('(')[0]+'\\b').test(error.message))
  }
  assert.equal(await state(),before)
 }))
 await t.test('D2 early deferred trigger is not an unconditional expiry boundary for a raw transaction',()=>fixture(async x=>{
  const f=signedActionFixture(x.run,{keys:x.f.keys,epoch:2,lifetime:5000});await host(f,1);const registered=await verifier(f).register(f.input),{o}=await setup(x,{f,registered}),before=await state(),c=session('resource-d2-early-expiry','ppo_resource_consumer')
  try{
   await c.ready();assert.equal(JSON.parse(await c.send('BEGIN;'+apply(o))).applied,true)
   await c.send('SET CONSTRAINTS ALL IMMEDIATE;');assert.equal(JSON.parse(await c.send(check(o))).fresh,true)
   await c.send(waitPastExpiry(f));assert.equal(JSON.parse(await c.send(check(o))).fresh,false)
   // No pending deferred event remains: this synthetic commit may finish late.
   await c.send('COMMIT;')
  }finally{await c.close()}
  await assertAtomic(before,o)
 }))
 for(const change of ['host-revoke','key-rotate','claim-revoke'])await t.test('D2 combined trusted roles can change '+change+' after early deferred execution',()=>fixture(async x=>{
  const {o}=await setup(x),before=await state()
  // Deliberately unsafe combination exists only in this disposable test role.
  await sql('CREATE ROLE ppo_d2_combined_ci NOLOGIN; GRANT ppo_resource_consumer,ppo_action_admin TO ppo_d2_combined_ci;')
  const c=session('resource-d2-combined-'+change,'ppo_d2_combined_ci')
  try{
   for(const role of ['ppo_resource_consumer','ppo_action_admin'])assert.equal(await sql('SELECT pg_has_role(\'ppo_d2_combined_ci\','+L(role)+",'USAGE');"),'t')
   assert.equal(await sql("SELECT pg_has_role('ppo_resource_consumer','ppo_action_admin','MEMBER');"),'f')
   await c.ready();assert.equal(JSON.parse(await c.send('BEGIN;'+apply(o))).applied,true)
   await c.send('SET CONSTRAINTS ALL IMMEDIATE;');assert.equal(JSON.parse(await c.send(check(o))).fresh,true)
   const mutation=change==='claim-revoke'?"SELECT ppo_authority.revoke_action_context('claim',"+L(x.f.claimHash)+');':"SELECT ppo_authority.configure_action_host('lab-action-host',1,"+L(JSON.stringify({...x.f.policy,...(change==='host-revoke'?{status:'revoked'}:{keyFingerprint:'e'.repeat(64)})}))+');'
   await c.send(mutation);assert.equal(JSON.parse(await c.send(check(o))).fresh,false);await c.send('COMMIT;')
  }finally{await c.close();await sql('DROP ROLE ppo_d2_combined_ci;')}
  await assertAtomic(before,o)
 }))
 for(const stage of ['precommit','commit-gap'])await t.test('D2 controlled resource transaction with early checks denies '+stage+' freshness without an executable grant',()=>fixture(async x=>{
  const f=signedActionFixture(x.run,{keys:x.f.keys,epoch:2,lifetime:5000});await host(f,1);const registered=await verifier(f).register(f.input),{o}=await setup(x,{f,registered}),before=await state()
  const c=await client('resource-d2-controlled-'+stage,async(s,fn,connection)=>{
   if((stage==='precommit'&&s===A.precommit)||(stage==='commit-gap'&&s==='COMMIT')){
    await connection.send('SET CONSTRAINTS ALL IMMEDIATE;');assert.equal(JSON.parse(await connection.send(check(o))).fresh,true)
    await connection.send(waitPastExpiry(f))
   }
   return fn()
  })
  try{
   const result=await c.api.apply(o);assert.equal(result.grant,false);assert.equal(result.canExecute,false);assert.equal(result.releaseAuthorized,false)
   assert.equal(result.status,stage==='precommit'?'denied':'expired-or-stale');assert.equal(result.consumed===true,stage==='commit-gap')
  }finally{await c.close()}
  if(stage==='precommit')assert.equal(await state(),before)
  else await assertAtomic(before,o)
 }))
 await t.test('independent resource CAS and duplicate operations serialize with exactly one effect',()=>fixture(async x=>{
  const {o}=await setup(x)
  const f={...x.f,input:{...x.f.input,signedProof:signOfflineHostActionProof({...x.f.proof,actionId:randomUUID().replaceAll('-','')},x.f.keys.host.privateKey)}}
  const registered=await verifier(f).register(f.input),other=(await setup(x,{initialized:true,f,registered})).o,a=session('resource-race-a','ppo_resource_consumer'),b=session('resource-race-b','ppo_resource_consumer')
  try{await a.ready();await b.ready();assert.equal(JSON.parse(await a.send('BEGIN;'+apply(o))).applied,true)
   const waiting=b.send(apply(other));await blockedBy(b,a);await a.send('COMMIT;');assert.equal(JSON.parse(await waiting).applied,false)
  }finally{await a.close();await b.close()}
  const s=JSON.parse(await state());assert.equal(s.versions.length,2);assert.equal(s.receipts,1);assert.equal(s.nonces,1)
 }))
 await t.test('resource mutation boundary rechecks host ownership catalog and actual ref with positive rollback control',()=>fixture(async x=>{
  const {o}=await setup(x)
  assert.equal(JSON.parse(await sql('BEGIN;'+apply(o)+'ROLLBACK;','ppo_resource_consumer')).applied,true)
  for(const mutation of ["UPDATE ppo_authority.action_hosts SET epoch=epoch+1;","UPDATE ppo_authority.action_hosts SET policy=jsonb_set(policy,'{status}','\"revoked\"');","UPDATE ppo_authority.action_hosts SET policy=jsonb_set(policy,'{keyFingerprint}',to_jsonb(repeat('a',64)));","UPDATE ppo_authority.rehearsal_owner SET target_id=gen_random_uuid();","UPDATE ppo_authority.rehearsal_owner SET generation=generation+1;","INSERT INTO ppo_authority.resource_versions SELECT resource_id,1,project,path,encode(sha256(convert_to('external','UTF8')),'hex'),'external' FROM ppo_authority.current_resource;","ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; UPDATE ppo_authority.run_versions SET record=jsonb_set(record,'{status}','\"cancelled\"');"]){
   const before=await state();assert.equal(JSON.parse(await sql('BEGIN;'+mutation+' SET LOCAL ROLE ppo_resource_consumer;'+apply(o)+'ROLLBACK;')).applied,false);assert.equal(await state(),before)
  }
 }))
 await t.test('resource expiry at wait mutation commit and acknowledgment preserves atomic parity',()=>fixture(async x=>{
  await sql('SELECT ppo_authority.initialize_resource();','ppo_action_admin')
  let epoch=1
  for(const stage of ['wait','mutation','commit','actualcommit','ack']){
   const f=signedActionFixture(x.run,{keys:x.f.keys,epoch:++epoch,lifetime:2500});await host(f,epoch-1);const registered=await verifier(f).register(f.input),{o}=await setup(x,{initialized:true,f,registered})
   const before=await state()
   if(stage==='wait'){
    const a=session('resource-expiry-leader','postgres'),b=session('resource-expiry-waiter','ppo_resource_consumer')
    try{await a.ready();await b.ready();await a.send('BEGIN; UPDATE ppo_authority.gate SET revision=revision+1;');const waiting=b.send(apply(o));await blockedBy(b,a);await a.send('SELECT pg_sleep(2.6); COMMIT;');assert.equal(JSON.parse(await waiting).applied,false)}finally{await a.close();await b.close()}
   }else{
    if(stage==='actualcommit')await sql("CREATE FUNCTION ppo_authority.test_resource_commit_delay() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN PERFORM pg_sleep(2.6); RETURN NEW; END $b$; CREATE CONSTRAINT TRIGGER zz_resource_commit_delay AFTER INSERT ON ppo_authority.resource_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ppo_authority.test_resource_commit_delay();")
    if(stage==='mutation')await sql("CREATE FUNCTION ppo_authority.test_resource_delay() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN PERFORM pg_sleep(2.6); RETURN NEW; END $b$; CREATE TRIGGER test_resource_delay AFTER INSERT ON ppo_authority.resource_versions FOR EACH ROW EXECUTE FUNCTION ppo_authority.test_resource_delay();")
    const c=await client('resource-expiry-'+stage,async(s,fn)=>{if(stage==='commit'&&s==='COMMIT')await sql('SELECT pg_sleep(2.6);');const result=await fn();if(stage==='ack'&&s==='COMMIT')await sql('SELECT pg_sleep(2.6);');return result})
    try{const result=await c.api.apply(o);assert.equal(result.grant,false);assert.equal(result.consumed===true,['ack','actualcommit'].includes(stage))}finally{await c.close()}
    if(stage==='actualcommit')await sql('DROP TRIGGER zz_resource_commit_delay ON ppo_authority.resource_receipts;')
    if(stage==='mutation')await sql('DROP TRIGGER test_resource_delay ON ppo_authority.resource_versions;')
   }
   if(!['ack','actualcommit'].includes(stage))assert.equal(await state(),before)
   else await assertAtomic(before,o)
  }
 }))
 await t.test('stale resource transactions rollback termination restart and ambiguous receipts never grant retry',()=>fixture(async x=>{
  const {o}=await setup(x)
  for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){
   const c=session('resource-stale','ppo_resource_consumer');try{await c.ready();await c.send('BEGIN ISOLATION LEVEL '+isolation+'; SELECT 1 FROM pg_class LIMIT 1;');await sql('UPDATE ppo_authority.gate SET revision=revision+1;');await assert.rejects(c.send(apply(o)),/40001/)}finally{await c.close()}
  }
  const before=await state(),pending=session('resource-kill','ppo_resource_consumer');await pending.ready();await pending.send('BEGIN;'+apply(o));await sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='resource-kill';");await pending.close();assert.equal(await state(),before)
  const c=await client('resource-lost',async(s,fn)=>{const r=await fn();if(s==='COMMIT')throw Error('lost');return r})
  try{assert.equal((await c.api.apply(o)).status,'unknown');await assert.rejects(c.api.apply(o))}finally{await c.close()}
  assert.equal(spawnSync('docker',['kill','--signal=KILL',container]).status,0);assert.equal(spawnSync('docker',['start',container]).status,0)
  for(let i=0;i<60;i++){if(spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','ppo_authority_ci']).status===0)break;await new Promise(r=>setTimeout(r,100))}
  const r=await inspectSyntheticResourceReceipt({mode,operation:o,query:query('ppo_resource_consumer')});assert.equal(r.status,'committed-synthetic-effect');assert.equal(r.grant,false)
  const after=await state();assert.equal(JSON.parse(await sql(apply(o),'ppo_resource_consumer')).applied,false);assert.equal(await state(),after)
  assert.equal((await inspectSyntheticResourceReceipt({mode,operation:{...o,descriptorHash:'a'.repeat(64)},query:query('ppo_resource_consumer')})).status,'unknown')
 }))
}
