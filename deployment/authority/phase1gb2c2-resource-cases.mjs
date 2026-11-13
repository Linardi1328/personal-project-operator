import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {signOfflineHostActionProof} from '../../local-operator/software-factory-remote-host-fence.mjs'
import {signedActionFixture} from './action-test-fixture.mjs'
import {RESOURCE_SQL as S,signSyntheticResourceDescriptor,createSyntheticResourceVerifier,createSyntheticResourceFence,inspectSyntheticResourceReceipt} from '../../local-operator/software-factory-postgres-resource-fence.mjs'
const mode='isolated-postgres-resource-fencing-only',sha=s=>createHash('sha256').update(s).digest('hex')
export async function runResourceCases(t,h){
 const {fixture,sql,session,blockedBy,L,query,host,verifier,rawConsume,container}=h
 const bind=(s,a)=>s.replace(/\$([1-3])/gu,(_,i)=>L(a[Number(i)-1]))
 const state=()=>sql("SELECT jsonb_build_object('versions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY version) FROM ppo_authority.resource_versions r),'receipts',(SELECT count(*) FROM ppo_authority.resource_receipts),'nonces',(SELECT count(*) FROM ppo_authority.action_tombstones));")
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
  })
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
  for(const role of ['ppo_action_consumer','ppo_action_verifier','ppo_action_admin','ppo_resource_verifier','ppo_resource_consumer','ppo_rehearsal_target'])for(const table of ['resource_versions','resource_receipts','resource_operations'])for(const command of ['DELETE FROM '+table,'UPDATE '+table+' SET operation_id=gen_random_uuid()','TRUNCATE '+table])await assert.rejects(sql(command.replace(table,'ppo_authority.'+table)+';',role),/permission denied|does not exist/)
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
   else {const r=JSON.parse(await state()),prior=JSON.parse(before);assert.equal(r.receipts,prior.receipts+1);assert.equal(r.nonces,prior.nonces+1);assert.equal(r.versions.length,prior.versions.length+1)}
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
