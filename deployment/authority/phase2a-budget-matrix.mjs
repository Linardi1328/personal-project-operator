// Explicit, fixed, disposable-only workload. Not included in ordinary unit tests.
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {createPostgresTestSession} from './postgres-test-session.mjs'
import {createDevelopmentRun,transitionDevelopmentRun,recordDevelopmentRunProgress,createIsolatedCanonicalRunState} from '../../local-operator/development-run-state.mjs'
import {createPostgresCanonicalCatalog} from '../../local-operator/development-postgres-canonical-catalog.mjs'
import {createPostgresCanonicalAuthority} from '../../local-operator/development-postgres-canonical-authority.mjs'
import {createCatalogCertifiedQuery} from '../../local-operator/development-catalog-certified-query.mjs'
import {createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL as O} from '../../local-operator/development-ownership-rehearsal.mjs'
import {signedActionFixture} from './action-test-fixture.mjs'
import {signOfflineHostActionProof} from '../../local-operator/software-factory-remote-host-fence.mjs'
import {createIsolatedPostgresActionVerifier} from '../../local-operator/software-factory-remote-postgres-action-fence.mjs'
import {RESOURCE_SQL as R,signSyntheticResourceDescriptor,createSyntheticResourceVerifier,createSyntheticResourceFence,inspectSyntheticResourceReceipt} from '../../local-operator/software-factory-postgres-resource-fence.mjs'
import {admissionProfileSql} from './phase1gd1-profile.mjs'
const name=process.argv[2],container=process.env.PPO_MATRIX_CONTAINER,output=process.env.PPO_MATRIX_OUTPUT
assert.match(container??'',/^ppo-budget-matrix-[a-f0-9-]{36}$/u)
assert.ok(['catalog20','history100','catalog2000','operations','retention'].includes(name))
assert.ok(output?.startsWith(tmpdir()+'/ppo-budget-matrix-'))
const evidence={name,started:new Date().toISOString(),measurements:[],checks:[],grant:false,canExecute:false,releaseAuthorized:false}
const sessions=new Set(),sha=s=>createHash('sha256').update(s).digest('hex')
const L=v=>v===null?'NULL':Number.isSafeInteger(v)?String(v):typeof v==='string'?"convert_from(decode('"+Buffer.from(v).toString('base64')+"','base64'),'UTF8')":(()=>{throw Error('invalid parameter')})()
function session(label,role='postgres'){
 assert.match(role,/^(postgres|ppo_[a-z_]+)$/u)
 const p=spawn('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','ppo_authority_ci'],{stdio:['pipe','pipe','pipe']})
 const s=createPostgresTestSession(p,{timeoutMs:20000,maxStdoutBytes:72*1024*1024})
 const c={...s,label,ready:()=>s.send("\\set VERBOSITY verbose\nSELECT set_config('application_name',"+L(label)+",false); SET statement_timeout='15s'; SET lock_timeout='1s'; SET idle_in_transaction_session_timeout='1s'; SET ROLE "+role+';')}
 sessions.add(c);return c
}
async function sql(s,role='postgres'){
 const c=session('matrix-query',role);try{await c.ready();return await c.send(s)}finally{await c.close();sessions.delete(c)}
}
const query=role=>async(s,a=[])=>({rows:[JSON.parse(await sql('SELECT row_to_json(q) FROM ('+s.replace(/\$([1-4])/gu,(_,i)=>L(a[+i-1]))+') q;',role))]})
async function measured(label,fn){const start=performance.now();const result=await fn();evidence.measurements.push({label,elapsedMs:performance.now()-start});return result}
async function check(label,fn){await fn();evidence.checks.push(label);console.log(name+': '+label)}
async function install(ownership=false){
 for(const f of ['phase1gb2-canonical-postgres.sql','phase1gb2-synthetic-import.sql','phase1gb2-canonical-catalog.sql',...(ownership?['phase1gb2-ownership-rehearsal.sql','phase1gb2c-action-fencing.sql','phase1gb2c2-resource.sql']:[])])await sql(await readFile(new URL(f,import.meta.url),'utf8'))
 await sql(await admissionProfileSql({ownership}))
}
async function counters(){return JSON.parse(await sql(`SELECT jsonb_build_object('databaseBytes',pg_database_size(current_database()),'walLsn',pg_current_wal_lsn(),'wal',to_jsonb(w),'database',to_jsonb(d),'connections',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database())) FROM pg_stat_wal w CROSS JOIN pg_stat_database d WHERE d.datname=current_database();`))}
async function plans(statements){
 evidence.plans=[]
 for(const [label,statement] of statements){
  const runs=[]
  // First pass is after fresh fixture load (OS/PG caches are NOT evicted).
  for(let i=0;i<3;i++)runs.push(JSON.parse(await measured(label+'-'+i,()=>sql('EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) '+statement+';'))))
  evidence.plans.push({label,cache:'first-after-load, warm1, warm2; not hardware cold',runs})
 }
}
async function history(count,depth,{active=false,lastActive=false,projectId='rivora'}={}){
 const dir=await mkdtemp(join(tmpdir(),'ppo-matrix-history-')),runs=[]
 try{
  for(let i=0;i<count;i++){
   const keepActive=active||(lastActive&&i===count-1)
   let clock=Date.parse('2026-01-01T00:00:00Z');const options={writeDataDir:dir,now:()=>new Date(clock+=1000)},records=[]
   let r=await createDevelopmentRun({projectId,task:'RIC-157 shared authority synthetic: matrix '+i,branch:'feature/matrix',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),actor:'matrix'},options);records.push(r)
   for(const status of ['planning_in_progress','planned','implementation_in_progress']){r=await transitionDevelopmentRun(r.runId,{expectedVersion:r.version,status,actor:'matrix'},options);records.push(r)}
   while(records.length<depth-(keepActive?0:1)){r=await recordDevelopmentRunProgress(r.runId,{expectedVersion:r.version,status:r.status,actor:'matrix',reason:'matrix'},options);records.push(r)}
   if(!keepActive){r=await transitionDevelopmentRun(r.runId,{expectedVersion:r.version,status:'cancelled',actor:'matrix'},options);records.push(r)}
   runs.push(records)
  }
  const allocation=(await promisify(execFile)('du',['-sk',dir],{timeout:10000,encoding:'utf8'})).stdout.trim().split(/\s/u)[0]
  evidence.historyGeneration??=[]
  evidence.historyGeneration.push({count,depth,active,lastActive,liveLogicalBytes:entries(runs).reduce((n,e)=>n+Buffer.byteLength(e.serialized)+1,0),recordBytesWritten:runs.flat().reduce((n,r)=>n+2*(Buffer.byteLength(JSON.stringify(r))+1),0),endAllocationKiB:Number(allocation),diskNote:'end-of-generation live allocation; not transient fsync/atomic-write peak'})
  return runs
 }finally{await rm(dir,{recursive:true,force:true})}
}
const entries=runs=>runs.flatMap(records=>[{path:'records/'+records[0].runId+'.json',serialized:JSON.stringify(records.at(-1))},...records.map(r=>({path:'versions/'+r.runId+'/'+String(r.version).padStart(6,'0')+'.json',serialized:JSON.stringify(r)}))])
async function valid(entries){return createPostgresCanonicalCatalog({mode:'isolated-postgres-canonical-catalog',query:async()=>({rows:[{snapshot:{revision:'0',code:'ok',entries}}]})}).list()}
async function load(runs,{overCapacity=false}={}){
 // Privileged bulk INSERT is restricted to complete state-API histories,
 // validated as an entire catalog before and after native normalization.
 if(overCapacity){
  for(const records of runs)assert.equal((await valid(entries([records]))).ok,true)
  assert.equal(new Set(runs.map(r=>r[0].runId)).size,runs.length)
  assert.ok(runs.every(r=>r.at(-1).status==='cancelled'))
 }else assert.equal((await valid(entries(runs))).ok,true)
 for(const records of runs){
  await sql('INSERT INTO ppo_authority.run_versions(run_id,version,history_hash,record) VALUES '+records.map(r=>'('+[r.runId,r.version,r.historyHash,JSON.stringify(r)].map(L).join(',')+'::jsonb)').join(',')+';')
 }
 const actual=await createPostgresCanonicalCatalog({mode:'isolated-postgres-canonical-catalog',query:query('ppo_authority_reader')}).list()
 const boundBytes=Number(await sql('SELECT coalesce(sum(octet_length(to_json(record::text)::text)+128),0) FROM (SELECT record FROM ppo_authority.current_runs UNION ALL SELECT record FROM ppo_authority.run_versions)x;'))
 if(overCapacity&&boundBytes>33554432){assert.equal(actual.ok,false);assert.equal(actual.code,'catalog_truncated')}
 else{assert.equal(actual.ok,true);assert.equal(actual.summaries.length,runs.length)}
 evidence.catalog={runs:runs.length,versions:runs.reduce((n,r)=>n+r.length,0),maxVersionsPerRun:Math.max(...runs.map(r=>r.length)),transportBytes:Number(await sql('SELECT octet_length(ppo_authority.read_catalog_snapshot()::text);')),nativeBoundBytes:boundBytes,completeSemanticValidation:actual.ok,individualCompleteHistoryValidation:true,globalTerminalAndUnique:overCapacity||undefined,code:actual.code,fixture:'privileged complete normalized state-API history; not authenticated write latency'}
 if(overCapacity){
  for(const records of runs){
   const native=JSON.parse(await sql('SELECT jsonb_agg(record ORDER BY version) FROM ppo_authority.run_versions WHERE run_id='+L(records[0].runId)+';'))
   assert.deepEqual(native,records)
  }
  evidence.catalog.nativeReadbackExact=true
 }
}
async function catalogCase(){
 await install()
 const one=await measured('generate-100-version-probe',()=>history(1,100,{active:name==='history100'}))
 const oneBytes=Buffer.byteLength(JSON.stringify({revision:'0',code:'ok',entries:entries(one)}))
 evidence.simultaneous2000={estimatedTransportBytes:oneBytes*20,limitBytes:33554432,method:'20 times complete 100-version state-API probe; IDs and task indices differ slightly',claim:'candidate feasibility only; no unsupported-state insertion'}
 let runs
 if(name==='history100')runs=await history(1,99,{active:true})
 else if(name==='catalog2000')runs=await measured('generate-actual-2000-versions',()=>history(20,100))
 else{
  // Fixed conservative byte target; only complete generated histories loaded.
  const depth=Math.min(100,Math.max(5,Math.floor(100*Math.sqrt(28*1024*1024/(oneBytes*20)))))
  evidence.selectedDepth=depth;runs=await measured('generate-20-complete-runs',()=>history(20,depth,{lastActive:true}))
 }
 await measured('bulk-load-and-full-native-validation',()=>load(runs,{overCapacity:name==='catalog2000'}))
 evidence.before=await counters()
 await plans([['catalog','SELECT ppo_authority.read_catalog_snapshot()'],['history','SELECT ppo_authority.read_versions('+L(runs[0][0].runId)+')']])
 for(let i=0;i<3;i++)assert.equal((await measured('semantic-catalog-'+i,()=>createPostgresCanonicalCatalog({mode:'isolated-postgres-canonical-catalog',query:query('ppo_authority_reader')}).list())).ok,evidence.catalog.code==='ok')
 const timedQuery=async(s,a)=>{
  if(!s.startsWith('SELECT ppo_authority.commit_run('))return s.startsWith('SELECT ppo_authority.prepare_admission(')?measured('admission-prepare-transport',()=>query('ppo_authority_writer')(s,a)):query('ppo_authority_writer')(s,a)
  const c=session('matrix-native-append','ppo_authority_writer');await c.ready()
  try{
   await c.send('BEGIN;');const start=performance.now()
   const row=JSON.parse(await c.send('SELECT row_to_json(q) FROM ('+s.replace(/\$([1-4])/gu,(_,i)=>L(a[+i-1]))+')q;'))
   await c.send('COMMIT;')
   evidence.measurements.push({label:'native-dedicated-transaction-through-commit-upper-bound',elapsedMs:performance.now()-start,includes:'uncontended gate acquisition, native validation, effect, durable COMMIT, two psql round trips; excludes JS prevalidation'})
   return {rows:[row]}
  }finally{await c.close()}
 }
 const certified=createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:timedQuery,verifierQuery:(s,a)=>measured('admission-certify-transport',()=>query('ppo_admission_verifier')(s,a))})
 const authority=createPostgresCanonicalAuthority({mode:'isolated-postgres-canonical-authority',query:certified})
 if(name==='catalog20'||name==='catalog2000'){
  const extra=(await history(1,5,{projectId:'kynexa'}))[0][0]
  if(name==='catalog20'){
   evidence.run21ProjectedNativeBytes=evidence.catalog.nativeBoundBytes+Number(await sql('SELECT 2*(octet_length(to_json(('+L(JSON.stringify(extra))+'::jsonb)::text)::text)+128);'))
   assert.ok(evidence.run21ProjectedNativeBytes<33554432)
   evidence.run21DenialCause='21-run count; projected native bytes remain under cap and two active projects are permitted'
  }else evidence.run21DenialCause='existing catalog already exceeds native byte cap; not isolated count denial'
  await check('21st run denied by actual certified mutation',async()=>assert.equal(await measured('capacity-denied-create',()=>authority.commitRecord(JSON.stringify(extra),-1,null)),false))
 }
 if(name!=='catalog2000'){
  let r=runs.at(-1).at(-1)
  const state=createIsolatedCanonicalRunState({mode:'isolated-postgres-canonical-authority',authority,now:()=>new Date('2026-11-01T00:00:00Z')})
  await check('genuine certified active progress commits with immutable version parity',async()=>{
   r=await measured('certified-progress-end-to-end',()=>state.progress(r.runId,{expectedVersion:r.version,status:r.status,actor:'matrix',reason:'positive capacity control'}))
   assert.equal(r.version,runs.at(-1).length)
   assert.equal((await authority.readVersions(r.runId)).length,r.version+1)
  })
  evidence.catalogAfterAppend={versions:Number(await sql('SELECT count(*) FROM ppo_authority.run_versions;')),tailVersion:r.version}
  if(name==='history100'){
  await check('100-version ceiling rejects genuine progress before any state write',async()=>{
   const before=await sql('SELECT count(*) FROM ppo_authority.run_versions;')
   await assert.rejects(state.progress(r.runId,{expectedVersion:99,status:r.status,actor:'matrix',reason:'history exhausted'}),error=>error.code==='RUN_HISTORY_LIMIT_REACHED')
   assert.equal(await sql('SELECT count(*) FROM ppo_authority.run_versions;'),before)
  })
  }
 }
 evidence.after=await counters()
}
async function owned(){
 await install(true)
 const roles={[O.read]:'ppo_rehearsal_controller',[O.sourceRead]:'ppo_rehearsal_controller',[O.control]:'ppo_rehearsal_controller',[O.receipt]:'ppo_rehearsal_controller',[O.source]:'ppo_rehearsal_source',[O.target]:'ppo_rehearsal_target'}
 const c=createSyntheticOwnershipRehearsal({mode:'synthetic-ownership-cutover-rehearsal-only',query:(s,a)=>createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:query(roles[s]),verifierQuery:query('ppo_admission_verifier')})(s,a)})
 await c.seed();await c.freeze();await c.import();await c.activate()
 const o=await c.observe(),run=o.catalog.entries.filter(e=>e.path.startsWith('records/')).map(e=>JSON.parse(e.serialized)).find(r=>r.status==='implementation_in_progress')
 const f=signedActionFixture(run)
 await sql('SELECT ppo_authority.configure_action_host('+[f.proof.hostId,0,JSON.stringify(f.policy)].map(L).join(',')+');','ppo_action_admin')
 const registered=await createIsolatedPostgresActionVerifier({mode:'isolated-postgres-action-fencing-only',query:query('ppo_action_verifier'),...f.config}).register(f.input)
 await sql('SELECT ppo_authority.initialize_resource();','ppo_action_admin')
 return {op:await resourceOperation(f,registered),registered,f,run}
}
async function resourceOperation(f,registered){
 const {d,payload}=await resourceDescriptor(registered)
 const op=await measured('signed-resource-register',()=>createSyntheticResourceVerifier({mode:'isolated-postgres-resource-fencing-only',query:query('ppo_resource_verifier'),publicKey:f.keys.coordinator.publicKey}).register(signSyntheticResourceDescriptor(JSON.stringify(d),f.keys.coordinator.privateKey),payload))
 return op
}
async function resourceDescriptor(registered){
 const snap=(await query('ppo_resource_verifier')(R.read,[registered.ticket])).rows[0].context,cx=snap.context,r=snap.resource,p=cx.proof,a=cx.request,payload='matrix value\n'.repeat(400).slice(0,4096)
 const d={version:1,operationId:randomUUID(),ticket:registered.ticket,ticketHash:sha(registered.ticket),contextHash:snap.contextHash,sourceId:cx.sourceId,targetId:cx.targetId,generation:cx.generation,hostId:p.hostId,hostFingerprint:cx.hostFingerprint,hostEpoch:p.hostEpoch,workerId:a.workerId,capability:a.capability,requestHash:cx.requestHash,claimHash:cx.claimHash,proofHash:cx.proofHash,runId:a.runId,runVersion:a.expectedVersion,status:'implementation_in_progress',branch:a.branch,baseSha:a.baseSha,headSha:a.headSha,resourceId:r.resource_id,expectedVersion:r.version,expectedRef:r.ref,action:p.actionType,path:p.actionPath,payloadHash:sha(payload)}
 return {d,payload}
}
async function blocked(waiter,leader){
 const deadline=performance.now()+800
 while(performance.now()<deadline)if(await sql('SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity b ON b.pid=ANY(pg_blocking_pids(w.pid)) WHERE w.application_name='+L(waiter.label)+' AND b.application_name='+L(leader.label)+" AND w.wait_event_type='Lock');")==='t')return
 assert.fail('No observed gate contention')
}
async function operations(){
 const {op}=await owned();evidence.before=await counters()
 const apply='SELECT ppo_authority.apply_resource_operation('+L(op.operationId)+'::uuid,'+L(op.descriptorHash)+');'
 await check('connection termination rolls back uncommitted resource parity',async()=>{
  const s=session('matrix-loss','ppo_resource_consumer');await s.ready();assert.equal(JSON.parse(await s.send('BEGIN;'+apply)).applied,true)
  await sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='matrix-loss';");await s.close()
  assert.equal(await sql('SELECT count(*) FROM ppo_authority.resource_receipts;'),'0');assert.equal(await sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'0')
 })
 await check('lost acknowledged commit reconciles exact durable receipt without replay',async()=>{
  const s=session('matrix-ack','ppo_resource_consumer');await s.ready()
  const q=async(statement,args)=>{
   if(['BEGIN','COMMIT','ROLLBACK'].includes(statement)){await s.send(statement+';');if(statement==='COMMIT')throw Error('synthetic lost commit acknowledgment');return {rows:[]}}
   return {rows:[JSON.parse(await s.send('SELECT row_to_json(q) FROM ('+statement.replace(/\$([1-2])/gu,(_,i)=>L(args[+i-1]))+') q;'))]}
  }
  const fence=createSyntheticResourceFence({mode:'isolated-postgres-resource-fencing-only',query:q})
  const result=await measured('signed-resource-apply-lost-ack',()=>fence.apply(op));assert.equal(result.status,'unknown');assert.equal(result.grant,false);await assert.rejects(fence.apply(op));await s.close()
  const receipt=await inspectSyntheticResourceReceipt({mode:'isolated-postgres-resource-fencing-only',operation:op,query:query('ppo_resource_consumer')});assert.equal(receipt.status,'committed-synthetic-effect');assert.equal(receipt.grant,false)
  assert.equal(JSON.parse(await sql(apply,'ppo_resource_consumer')).applied,false)
  assert.equal(await sql('SELECT count(*) FROM ppo_authority.resource_receipts;'),'1');assert.equal(await sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'1')
 })
 await plans([['resource-receipt','SELECT ppo_authority.read_resource_receipt('+L(op.operationId)+'::uuid,'+L(op.descriptorHash)+')']])
 await check('shared gate bounds lock wait and records revocation delay',async()=>{
  const a=session('matrix-holder'),b=session('matrix-revoke','ppo_action_admin');await a.ready();await b.ready();await a.send('BEGIN; UPDATE ppo_authority.gate SET revision=revision+1;')
  const start=performance.now(),pending=b.send("SELECT ppo_authority.revoke_action_context('request',repeat('e',64));")
  await blocked(b,a);await a.send('COMMIT;');await pending;evidence.measurements.push({label:'revocation-observed-gate-wait',elapsedMs:performance.now()-start});await a.close();await b.close()
  const leader=session('matrix-lock-holder'),waiter=session('matrix-lock-timeout','ppo_action_admin');await leader.ready();await waiter.ready();await leader.send('BEGIN; UPDATE ppo_authority.gate SET revision=revision+1; SET idle_in_transaction_session_timeout=0;')
  await assert.rejects(measured('lock-timeout',()=>waiter.send("SELECT ppo_authority.revoke_action_context('claim',repeat('e',64));")),/55P03/);await leader.send('ROLLBACK;');await leader.close();await waiter.close()
 })
 await check('statement timeout cancels and disposes transaction',async()=>{const s=session('matrix-statement');await s.ready();await assert.rejects(measured('statement-timeout',()=>s.send("SET statement_timeout='100ms'; BEGIN; SELECT pg_sleep(1);")),/57014/);await s.close()})
 await check('idle transaction timeout terminates connection and releases gate',async()=>{const s=session('matrix-idle');await s.ready();await s.send("SET idle_in_transaction_session_timeout='100ms'; BEGIN; UPDATE ppo_authority.gate SET revision=revision+1;");await new Promise(r=>setTimeout(r,250));await assert.rejects(s.send('SELECT 1;'));await s.close();await sql('UPDATE ppo_authority.gate SET revision=revision+1;')})
 await check('application deadline cancellation rolls back gate and disposes connection',async()=>{
  const s=session('matrix-cancel');await s.ready();const pending=s.send('BEGIN; UPDATE ppo_authority.gate SET revision=revision+1; SELECT pg_sleep(5);');const rejection=assert.rejects(pending,/57014/)
  await new Promise(r=>setTimeout(r,100));assert.equal(await sql("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='matrix-cancel' AND state='active';"),'t');await rejection;await s.close();await sql('UPDATE ppo_authority.gate SET revision=revision+1;')
 })
 await check('connection ceiling rejects thirteenth backend and recovers after disposal',async()=>{
  const clients=Array.from({length:12},(_,i)=>session('matrix-concurrent-'+i))
  try{await Promise.all(clients.map(s=>s.ready()));evidence.connectionsAtTwelve=Number(await clients[0].send("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend';"));assert.equal(evidence.connectionsAtTwelve,12);await assert.rejects(sql('SELECT 1;'),/too many clients/)}finally{await Promise.all(clients.map(s=>s.close()))}
  assert.equal(await sql('SELECT 1;'),'1')
 })
 evidence.after=await counters()
}
async function retention(){
 const {op,registered,f}=await owned()
 // A genuine signed effect is the seed. Replicas below are privileged STORAGE
 // fixtures only. They do not authenticate replicated contexts or effects.
 assert.equal(JSON.parse(await sql('SELECT ppo_authority.apply_resource_operation('+L(op.operationId)+'::uuid,'+L(op.descriptorHash)+');','ppo_resource_consumer')).applied,true)
 const fresh=await createIsolatedPostgresActionVerifier({mode:'isolated-postgres-action-fencing-only',query:query('ppo_action_verifier'),...f.config}).register({...f.input,signedProof:signOfflineHostActionProof({...f.proof,actionId:randomUUID().replaceAll('-','')},f.keys.host.privateKey)})
 const capTicket=randomUUID(),capContext=JSON.parse(await sql('SELECT context FROM ppo_authority.action_contexts WHERE ticket='+L(registered.ticket)+'::uuid;'));capContext.proofHash='f'.repeat(64)
 const contextProbe='SELECT ppo_authority.register_action_context('+L(capTicket)+'::uuid,'+L(JSON.stringify(capContext))+');'
 await check('same-input retention probes succeed before capacity in rollback-only controls',async()=>{
  assert.equal(await sql("BEGIN; SELECT ppo_authority.certify_admission(repeat('f',64)); ROLLBACK;",'ppo_admission_verifier'),'t')
  assert.equal(await sql("BEGIN; SELECT ppo_authority.revoke_action_context('claim',repeat('f',64)); ROLLBACK;",'ppo_action_admin'),'')
  assert.equal(await sql('BEGIN;'+contextProbe+'ROLLBACK;','ppo_action_verifier'),'t')
 })
 evidence.retentionFixture='privileged storage copies from one genuine signed effect; no authorization claim for replicas'
 await measured('populate-retained-storage',()=>sql(`
 CREATE TEMP TABLE matrix_ids AS SELECT n,gen_random_uuid() ticket,gen_random_uuid() operation_id FROM generate_series(1,998) n;
 INSERT INTO ppo_authority.action_contexts SELECT i.ticket,c.context,encode(sha256(i.ticket::text::bytea),'hex') FROM matrix_ids i CROSS JOIN (SELECT context FROM ppo_authority.action_contexts LIMIT 1)c;
 ALTER TABLE ppo_authority.action_tombstones DISABLE TRIGGER action_precommit_freshness;
 INSERT INTO ppo_authority.action_tombstones SELECT t.host_id,lpad(to_hex(i.n),32,'0'),i.operation_id,i.ticket,t.context_hash,t.target_id,t.generation,t.host_epoch,t.consumed_at,t.not_before,t.expires_at,t.transaction_id FROM matrix_ids i CROSS JOIN (SELECT * FROM ppo_authority.action_tombstones LIMIT 1)t WHERE i.n<=997;
 ALTER TABLE ppo_authority.action_tombstones ENABLE TRIGGER action_precommit_freshness;
 INSERT INTO ppo_authority.resource_operations SELECT i.operation_id,i.ticket,o.descriptor,o.payload,encode(sha256(i.operation_id::text::bytea),'hex') FROM matrix_ids i CROSS JOIN (SELECT * FROM ppo_authority.resource_operations LIMIT 1)o;
 INSERT INTO ppo_authority.resource_versions SELECT r.resource_id,n,r.project,r.path,r.ref,r.value FROM generate_series(2,998)n CROSS JOIN (SELECT * FROM ppo_authority.resource_versions WHERE version=1)r;
 INSERT INTO ppo_authority.resource_receipts SELECT i.operation_id,i.ticket,jsonb_set(r.after_state,'{version}',to_jsonb(i.n)),jsonb_set(r.after_state,'{version}',to_jsonb(i.n+1)),encode(sha256(i.operation_id::text::bytea),'hex') FROM matrix_ids i CROSS JOIN (SELECT * FROM ppo_authority.resource_receipts LIMIT 1)r WHERE i.n<=997;
 INSERT INTO ppo_authority.action_revocations SELECT 'request',encode(sha256(n::text::bytea),'hex') FROM generate_series(1,2000)n;
 INSERT INTO ppo_authority.admission_certificates SELECT encode(sha256(('retention-'||n)::bytea),'hex') FROM generate_series(1,10000-(SELECT count(*)::integer FROM ppo_authority.admission_certificates))n;
 UPDATE ppo_authority.admission_identity SET cert_count=10000;
 `))
 await check('fresh signed exact-CAS operation reaches version 999 then signer denies next version',async()=>{
  const next=await resourceOperation(f,fresh)
  const bindings=JSON.parse(await sql('SELECT jsonb_build_object(\'action\',ppo_authority.action_bindings_valid(c.context),\'resource\',ppo_authority.resource_bindings_valid(o.descriptor,c.context,to_jsonb(r)),\'unused\',NOT EXISTS(SELECT 1 FROM ppo_authority.action_tombstones t WHERE t.ticket=c.ticket),\'nonceCount\',(SELECT count(*) FROM ppo_authority.action_tombstones),\'version\',r.version) FROM ppo_authority.resource_operations o JOIN ppo_authority.action_contexts c USING(ticket) CROSS JOIN ppo_authority.current_resource r WHERE o.operation_id='+L(next.operationId)+'::uuid;'))
  assert.deepEqual(bindings,{action:true,resource:true,unused:true,nonceCount:998,version:998})
  assert.equal(JSON.parse(await measured('fresh-final-version-apply',()=>sql('SELECT ppo_authority.apply_resource_operation('+L(next.operationId)+'::uuid,'+L(next.descriptorHash)+');','ppo_resource_consumer'))).applied,true)
  const {d}=await resourceDescriptor(fresh);assert.equal(d.expectedVersion,999)
  assert.doesNotThrow(()=>signSyntheticResourceDescriptor(JSON.stringify({...d,expectedVersion:998}),f.keys.coordinator.privateKey))
  assert.throws(()=>signSyntheticResourceDescriptor(JSON.stringify(d),f.keys.coordinator.privateKey))
  // Final tombstone is explicitly privileged storage, after the signed effect.
  await sql("ALTER TABLE ppo_authority.action_tombstones DISABLE TRIGGER action_precommit_freshness; INSERT INTO ppo_authority.action_tombstones SELECT t.host_id,repeat('f',32),o.operation_id,c.ticket,t.context_hash,t.target_id,t.generation,t.host_epoch,t.consumed_at,t.not_before,t.expires_at,t.transaction_id FROM ppo_authority.action_tombstones t CROSS JOIN ppo_authority.action_contexts c JOIN ppo_authority.resource_operations o ON o.ticket=c.ticket WHERE NOT EXISTS(SELECT 1 FROM ppo_authority.action_tombstones used WHERE used.ticket=c.ticket) LIMIT 1; ALTER TABLE ppo_authority.action_tombstones ENABLE TRIGGER action_precommit_freshness;")
 })
 evidence.retained=JSON.parse(await sql(`SELECT jsonb_build_object('certificates',(SELECT count(*) FROM ppo_authority.admission_certificates),'contexts',(SELECT count(*) FROM ppo_authority.action_contexts),'tombstones',(SELECT count(*) FROM ppo_authority.action_tombstones),'operations',(SELECT count(*) FROM ppo_authority.resource_operations),'receipts',(SELECT count(*) FROM ppo_authority.resource_receipts),'resourceVersions',(SELECT count(*) FROM ppo_authority.resource_versions),'revocations',(SELECT count(*) FROM ppo_authority.action_revocations));`))
 // Ownership seed used some certs: new fixture hashes fill the *remaining*
 // capacity below; an overflow is a preserved failure, never hidden pruning.
 assert.equal(evidence.retained.certificates,10000);assert.equal(evidence.retained.contexts,1000);assert.equal(evidence.retained.tombstones,1000);assert.equal(evidence.retained.operations,1000);assert.equal(evidence.retained.receipts,999);assert.equal(evidence.retained.resourceVersions,1000);assert.equal(evidence.retained.revocations,2000)
 await check('certificate capacity rejects new token without pruning',async()=>assert.equal(await sql("SELECT ppo_authority.certify_admission(repeat('f',64));",'ppo_admission_verifier'),'f'))
 await check('revocation capacity raises denial without pruning',()=>assert.rejects(sql("SELECT ppo_authority.revoke_action_context('claim',repeat('f',64));",'ppo_action_admin'),/revocation bound/))
 await check('context capacity rejects otherwise matching native snapshot',async()=>{
  assert.equal(await sql(contextProbe,'ppo_action_verifier'),'f')
 })
 await check('retained duplicate resource replay denies',async()=>assert.equal(JSON.parse(await sql('SELECT ppo_authority.apply_resource_operation('+L(op.operationId)+'::uuid,'+L(op.descriptorHash)+');','ppo_resource_consumer')).applied,false))
 evidence.denialGaps=['single initialized resource has version 0 plus at most 999 mutations: 1000 receipts is infeasible on supported single-resource path','expectedVersion 999 is denied by real signer/verifier before SQL; native apply version ceiling is not independently isolated','replicated rows are storage only','at 1000 contexts and 1000 unique-ticket tombstones every context is consumed; an independently unused context cannot coexist with both maxima']
 await plans([['receipt-at-retention','SELECT ppo_authority.read_resource_receipt('+L(op.operationId)+'::uuid,'+L(op.descriptorHash)+')'],['context-at-retention','SELECT ppo_authority.read_resource_context('+L(registered.ticket)+'::uuid)']])
 evidence.after=await counters()
}
try{
 evidence.settings=JSON.parse(await sql("SELECT jsonb_object_agg(name,setting) FROM pg_settings WHERE name IN ('server_version','max_connections','shared_buffers','work_mem','max_wal_size','fsync','synchronous_commit','statement_timeout','lock_timeout','idle_in_transaction_session_timeout');"))
 if(name==='catalog20'||name==='history100'||name==='catalog2000')await catalogCase();else if(name==='operations')await operations();else await retention()
 evidence.ok=true
}catch(e){evidence.ok=false;evidence.failure={message:e.message,stack:e.stack};console.error(e)}
finally{await Promise.all([...sessions].map(s=>s.close()));evidence.node={...process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS};evidence.finished=new Date().toISOString();await writeFile(output,JSON.stringify(evidence,null,2));if(!evidence.ok)process.exitCode=1}
