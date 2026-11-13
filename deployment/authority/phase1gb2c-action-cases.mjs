import {admissionProfileSql} from './phase1gd1-profile.mjs'
import {createCatalogCertifiedQuery,certifyCatalogMutation} from '../../local-operator/development-catalog-certified-query.mjs'
import {runResourceCases} from './phase1gb2c2-resource-cases.mjs'
import assert from "node:assert/strict"
import {readFile,mkdtemp,open,rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {randomUUID} from "node:crypto"
import {spawnSync} from "node:child_process"
import {createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL as O} from "../../local-operator/development-ownership-rehearsal.mjs"
import {createIsolatedPostgresActionVerifier,createIsolatedPostgresActionFence,inspectIsolatedActionConsumption,POSTGRES_ACTION_SQL as S} from "../../local-operator/software-factory-remote-postgres-action-fence.mjs"
import {signedActionFixture} from "./action-test-fixture.mjs"
const mode="isolated-postgres-action-fencing-only"
export async function runPostgresActionCases(t,h){
 const {sql,session,blockedBy,literals:L,installImportAuthority,dropImportAuthority,container}=h
 const bind=(s,a)=>s.replace(/\$([1-3])/gu,(_,i)=>L(a[Number(i)-1]))
 const query=role=>async(s,a)=>({rows:[JSON.parse(await sql("SELECT row_to_json(q) FROM ("+bind(s,a)+") q;",role))]})
 const roles={[O.read]:"ppo_rehearsal_controller",[O.sourceRead]:"ppo_rehearsal_controller",[O.control]:"ppo_rehearsal_controller",[O.receipt]:"ppo_rehearsal_controller",[O.source]:"ppo_rehearsal_source",[O.target]:"ppo_rehearsal_target"}
 const ownQuery=(s,a)=>(h.admissionProfile?createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:query(roles[s]),verifierQuery:query('ppo_admission_verifier')}):query(roles[s]))(s,a)
 const rawConsume=(ticket,op=randomUUID())=>"SELECT ppo_authority.consume_action("+L(ticket)+"::uuid,"+L(op)+"::uuid);"
 const count=()=>sql("SELECT count(*) FROM ppo_authority.action_tombstones;")
 const host=async(f,expected=0,policy=f.policy)=>sql("SELECT ppo_authority.configure_action_host("+L(f.proof.hostId)+","+expected+","+L(JSON.stringify(policy))+");","ppo_action_admin")
 const revoke=(kind,hash)=>sql("SELECT ppo_authority.revoke_action_context("+L(kind)+","+L(hash)+");","ppo_action_admin")
 const verifier=f=>createIsolatedPostgresActionVerifier({mode,query:query("ppo_action_verifier"),...f.config})
 const consumer=async(name,hook=async(_s,execute)=>execute())=>{
  const c=session(name,"ppo_action_consumer");await c.ready()
  return {close:c.close,adapter:createIsolatedPostgresActionFence({mode,query:async(s,a)=>hook(s,async()=>{
   if(["BEGIN","COMMIT","ROLLBACK"].includes(s)){await c.send(s+";");return {rows:[]}}
   return {rows:[JSON.parse(await c.send("SELECT row_to_json(q) FROM ("+bind(s,a)+") q;"))]}
  })})}
 }
 async function fixture(fn){
  await installImportAuthority()
  try{
   for(const name of ["phase1gb2-canonical-catalog.sql","phase1gb2-ownership-rehearsal.sql","phase1gb2c-action-fencing.sql","phase1gb2c2-resource.sql"])await sql(await readFile(new URL(name,import.meta.url),"utf8"))
   if(h.admissionProfile)await sql(await admissionProfileSql({ownership:true}))
   const c=createSyntheticOwnershipRehearsal({mode:"synthetic-ownership-cutover-rehearsal-only",query:ownQuery})
   await c.seed();await c.freeze();await c.import();await c.activate()
   const o=await c.observe(),run=o.catalog.entries.filter(e=>e.path.startsWith("records/")).map(e=>JSON.parse(e.serialized)).find(r=>r.status==="implementation_in_progress")
   const f=signedActionFixture(run);await host(f)
   const registered=await verifier(f).register(f.input)
   await fn({c,run,f,registered})
  }finally{await dropImportAuthority()}
 }
 await t.test("fixed consume validates signed context and preserves immutable native canonical/archive data",async()=>fixture(async({registered})=>{
  const before=await sql("SELECT jsonb_agg(record ORDER BY run_id,version)::text FROM ppo_authority.run_versions;")
  const archive=await sql("SELECT md5(string_agg(encode(bytes,'hex'),'' ORDER BY path)) FROM ppo_authority.synthetic_import_files;")
  const c=await consumer("action-positive")
  try{const r=await c.adapter.consume(registered);assert.equal(r.status,"consumed-diagnostic");assert.equal(r.grant,false);assert.equal(r.canExecute,false);assert.equal(r.releaseAuthorized,false)}finally{await c.close()}
  assert.equal(await count(),"1")
  assert.equal(await sql("SELECT jsonb_agg(record ORDER BY run_id,version)::text FROM ppo_authority.run_versions;"),before)
  assert.equal(await sql("SELECT md5(string_agg(encode(bytes,'hex'),'' ORDER BY path)) FROM ppo_authority.synthetic_import_files;"),archive)
  for(const role of ["ppo_action_consumer","ppo_action_verifier","ppo_action_admin","ppo_authority_writer","ppo_rehearsal_source","ppo_rehearsal_target"]){
   for(const stmt of ["DELETE FROM ppo_authority.action_tombstones;","UPDATE ppo_authority.action_tombstones SET action_id=repeat('a',32);","TRUNCATE ppo_authority.action_tombstones;","INSERT INTO ppo_authority.action_tombstones SELECT * FROM ppo_authority.action_tombstones ON CONFLICT DO NOTHING;","UPDATE ppo_authority.action_hosts SET epoch=1;","UPDATE ppo_authority.action_contexts SET context='{}';"])
    await assert.rejects(sql(stmt,role),/permission denied/)
  }
  await assert.rejects(sql(rawConsume(registered.ticket),"ppo_action_verifier"),/permission denied/)
  await assert.rejects(sql("SELECT ppo_authority.register_action_context(gen_random_uuid(),'{}');","ppo_action_consumer"),/permission denied/)
  assert.equal(await count(),"1")
 }))
 await t.test("concurrent duplicate consumption serializes independent connections with one durable tombstone",async()=>fixture(async({registered})=>{
  const a=session("action-duplicate-a","ppo_action_consumer"),b=session("action-duplicate-b","ppo_action_consumer")
  try{
   await a.ready();await b.ready();await a.send("BEGIN;"+rawConsume(registered.ticket))
   const waiting=b.send("BEGIN;"+rawConsume(registered.ticket)+" COMMIT;")
   await blockedBy(b,a);await a.send("COMMIT;")
   assert.equal(JSON.parse(await waiting).consumed,false);assert.equal(await count(),"1")
   assert.equal(JSON.parse(await sql(rawConsume(registered.ticket),"ppo_action_consumer")).consumed,false)
  }finally{await a.close();await b.close()}
 }))
 await t.test("host revoke/rotate and request/claim invalidation race consumption under the gate",async()=>fixture(async({run,f,registered})=>{
  for(const kind of ["revoke","rotate","request","claim"]){
   // Each independently signed claim is explicitly pinned in a newer host epoch.
   const old=Number(await sql("SELECT epoch FROM ppo_authority.action_hosts WHERE host_id='lab-action-host';"))
   const fresh=signedActionFixture(run,{epoch:old+1})
   await host(fresh,old)
   const r=await verifier(fresh).register(fresh.input)
   const a=session("action-policy-a","ppo_action_admin"),b=session("action-policy-b","ppo_action_consumer")
   try{
    await a.ready();await b.ready()
    const mutation=kind==="request"||kind==="claim"?"SELECT ppo_authority.revoke_action_context("+L(kind)+","+L(kind==="request"?fresh.requestHash:fresh.claimHash)+");":
     "SELECT ppo_authority.configure_action_host('lab-action-host',"+(old+1)+","+L(JSON.stringify({...fresh.policy,...(kind==="revoke"?{status:"revoked"}:{keyFingerprint:"e".repeat(64)})}))+ ");"
    await a.send("BEGIN;"+mutation)
    const waiting=b.send(rawConsume(r.ticket));await blockedBy(b,a);await a.send("COMMIT;")
    assert.equal(JSON.parse(await waiting).consumed,false)
   }finally{await a.close();await b.close()}
  }
  assert.equal(await count(),"0")
  await assert.rejects(host(f,0),/CAS conflict/)
  assert.equal(JSON.parse(await sql(rawConsume(registered.ticket),"ppo_action_consumer")).consumed,false)
  const epoch=Number(await sql("SELECT epoch FROM ppo_authority.action_hosts WHERE host_id='lab-action-host';"))+1
  const fresh=signedActionFixture(run,{keys:f.keys,epoch});await host(fresh,epoch-1)
  const r=await verifier(fresh).register(fresh.input),c=await consumer("action-revoke-after-commit",async(s,execute)=>{
   const result=await execute();if(s==="COMMIT")await host(fresh,epoch,{...fresh.policy,status:"revoked"});return result
  })
  try{const result=await c.adapter.consume(r);assert.equal(result.status,"expired-or-stale");assert.equal(result.consumed,true);assert.equal(result.grant,false)}finally{await c.close()}
  assert.equal(await count(),"1")
 }))
 await t.test("stale repeatable-read/serializable consumers and host writers abort rather than use old pins",async()=>fixture(async({f,registered})=>{
  let epoch=1
  for(const isolation of ["REPEATABLE READ","SERIALIZABLE"]){
   for(const role of ["ppo_action_consumer","ppo_action_admin"]){
    const s=session("action-stale-"+epoch,role)
    try{
     await s.ready();await s.send("BEGIN ISOLATION LEVEL "+isolation+"; SELECT 1 FROM pg_catalog.pg_class LIMIT 1;")
     await host(f,epoch++,{...f.policy,status:"revoked"})
     const call=role==="ppo_action_consumer"?rawConsume(registered.ticket):"SELECT ppo_authority.configure_action_host('lab-action-host',"+epoch+","+L(JSON.stringify(f.policy))+");"
     await assert.rejects(s.send(call+" COMMIT;"),/40001/)
    }finally{await s.close()}
   }
  }
  assert.equal(await count(),"0")
 }))
 await t.test("canonical mutations serialize with consumption; invalid catalog/lost lane/stale refs fail closed",async()=>fixture(async({c,run,registered,f})=>{
  const a=session("action-run-writer","ppo_rehearsal_target"),b=session("action-run-consumer","ppo_action_consumer")
  let targetOperation
  try{
   await a.ready();await b.ready()
   // Existing trusted target state machine supplies the valid CAS candidate;
   // hold its natural gate through an injected dedicated transaction transport.
   await a.send("BEGIN;")
   const other=createSyntheticOwnershipRehearsal({mode:"synthetic-ownership-cutover-rehearsal-only",query:async(s,args)=>{
    if(s!==O.target)return ownQuery(s,args)
    if(h.admissionProfile)assert.equal(await certifyCatalogMutation({query:query('ppo_rehearsal_target'),verifierQuery:query('ppo_admission_verifier'),kind:'target_commit',payload:JSON.parse(args[0])}),true)
    return {rows:[{evidence:JSON.parse(await a.send(bind(s,args)+";"))}]}
   }})
   await other.reconcile(c.operation())
   await other.target.progress(run.runId,{expectedVersion:run.version,status:run.status,actor:"action-test",reason:"canonical CAS race"})
   targetOperation=other.operation()
   const waiting=b.send(rawConsume(registered.ticket));await blockedBy(b,a);await a.send("COMMIT;")
   assert.equal(JSON.parse(await waiting).consumed,false)
  }finally{await a.close();await b.close()}
  // New valid context follows the current run, with a matching host epoch.
  const current=JSON.parse(await sql("SELECT ppo_authority.read_run("+L(run.runId)+");","ppo_authority_reader"))
  const n=signedActionFixture(current,{keys:f.keys,epoch:2});await host(n,1)
  const r=await verifier(n).register(n.input)
  assert.equal(JSON.parse(await sql("BEGIN; "+rawConsume(r.ticket)+" ROLLBACK;","ppo_action_consumer")).consumed,true)
  // Privileged rollback-only probes never alter stored histories.
  for(const mutation of ["UPDATE ppo_authority.rehearsal_owner SET generation=generation+1;",
   "UPDATE ppo_authority.run_versions SET record=jsonb_set(record,'{actor}','false') WHERE run_id="+L(run.runId)+";",
   "UPDATE ppo_authority.run_versions SET record=jsonb_set(record,'{status}','\"cancelled\"') WHERE run_id="+L(run.runId)+" AND version="+current.version+";"]){
   const result=JSON.parse(await sql("BEGIN; ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; "+mutation+" SET LOCAL ROLE ppo_action_consumer; "+rawConsume(r.ticket)+" ROLLBACK;"))
   assert.equal(result.consumed,false)
  }
  const resumed=createSyntheticOwnershipRehearsal({mode:"synthetic-ownership-cutover-rehearsal-only",query:ownQuery})
  assert.equal((await resumed.reconcile(targetOperation)).status,"committed")
  await resumed.target.transition(run.runId,{expectedVersion:current.version,status:"cancelled",actor:"action-test"})
  assert.equal(JSON.parse(await sql(rawConsume(r.ticket),"ppo_action_consumer")).consumed,false)
  assert.equal(JSON.parse(await sql("SELECT ppo_authority.read_run("+L(run.runId)+");","ppo_authority_reader")).status,"cancelled")
  assert.equal(await count(),"0")
 }))
 await t.test("independent host grants, paths, key/worker/role and Git refs are enforced inside consume",async()=>fixture(async({run,f})=>{
  let epoch=1
  for(const change of [{projects:["portfolio"]},{capabilities:["implementation.frontend"]},{keyFingerprint:"e".repeat(64)},
   {workerFingerprint:"e".repeat(64)},{coordinatorFingerprint:"e".repeat(64)},{claimHash:"e".repeat(64)}]){
   const next=signedActionFixture(run,{keys:f.keys,epoch:++epoch});await host(next,epoch-1,{...next.policy,...change})
   const r=await verifier(next).register(next.input)
   assert.equal(JSON.parse(await sql(rawConsume(r.ticket),"ppo_action_consumer")).consumed,false)
  }
  for(const changeRequest of [r=>{r.branch="feature/wrong"},r=>{r.baseSha="e".repeat(40)},r=>{r.headSha="e".repeat(40)},r=>{r.projectId="portfolio"},r=>{r.expectedVersion++}]){
   const next=signedActionFixture(run,{keys:f.keys,epoch:++epoch,changeRequest})
   // Align the independently signed claim/proof to the altered request, so SQL
   // denial proves current canonical binding rather than signature mismatch.
   const bad=signedActionFixture({...run,branch:next.request.branch,baseSha:next.request.baseSha,headSha:next.request.headSha,project:{id:next.request.projectId},version:next.request.expectedVersion},{keys:f.keys,epoch})
   await host(bad,epoch-1);const r=await verifier(bad).register(bad.input)
   assert.equal(JSON.parse(await sql(rawConsume(r.ticket),"ppo_action_consumer")).consumed,false)
  }
  assert.equal(await count(),"0")
 }))
 await t.test("every authority mutation entrypoint contends behind action consumption",async()=>fixture(async({run,f,registered})=>{
  const own=(action,fn)=>"SELECT ppo_authority."+fn+"("+L(JSON.stringify({action,operationId:randomUUID()}))+");"
  const calls=[
   ["ppo_action_admin","SELECT ppo_authority.configure_action_host('lab-action-host',1,"+L(JSON.stringify({...f.policy,status:"revoked"}))+ ");"],
   ["ppo_action_admin","SELECT ppo_authority.revoke_action_context('claim',"+L(f.claimHash)+");"],
   ["ppo_action_verifier","SELECT ppo_authority.register_action_context(gen_random_uuid(),'{}');"],
   ["ppo_rehearsal_controller",own("freeze","rehearsal_control")],
   ["ppo_rehearsal_source",own("source_commit","rehearsal_source_commit")],
   ["ppo_rehearsal_target",own("target_commit","rehearsal_target_commit")],
   ["postgres","SELECT ppo_authority.commit_run("+[run.runId,run.version-1,run.history.at(-1).previousHistoryHash,JSON.stringify(run)].map(L).join(",")+");"],
   ["postgres","SELECT ppo_authority.import_synthetic_snapshot("+L("a".repeat(64))+",'[{}]');"]
  ]
  for(let i=0;i<calls.length;i++){
   const a=session("action-all-leader-"+i,"ppo_action_consumer"),b=session("action-all-waiter-"+i,calls[i][0])
   try{
    await a.ready();await b.ready();await a.send("BEGIN;"+rawConsume(registered.ticket))
    const waiting=b.send("BEGIN;"+calls[i][1]+" ROLLBACK;")
    await blockedBy(b,a);await a.send("ROLLBACK;");await waiting
   }finally{await a.close();await b.close()}
  }
  assert.equal(await count(),"0")
 }))
 await t.test("real malformed/truncated catalog cannot be certified and replacement ownership cannot consume",async()=>fixture(async({f,registered})=>{
  const s=session("action-invalid-catalog","postgres");await s.ready()
  try{
   for(const amount of [1,101]){
    await s.send("BEGIN; INSERT INTO ppo_authority.run_versions SELECT repeat('T',39)||lpad(i::text,4,'0'),0,history_hash,jsonb_set(jsonb_set(record,'{runId}',to_jsonb(repeat('T',39)||lpad(i::text,4,'0'))),'{history,0,actor}','false'::jsonb) FROM generate_series(1,"+amount+") i CROSS JOIN (SELECT * FROM ppo_authority.run_versions WHERE version=0 LIMIT 1) r; SET LOCAL ROLE ppo_action_verifier;")
    let writes=0
    const v=createIsolatedPostgresActionVerifier({mode,...f.config,query:async(statement,args)=>{
     if(statement!==S.snapshot){writes++;throw Error("unexpected certificate write")}
     return {rows:[JSON.parse(await s.send("SELECT row_to_json(q) FROM ("+bind(statement,args)+") q;"))]}
    }})
    await assert.rejects(v.register(f.input));assert.equal(writes,0);await s.send("ROLLBACK;")
   }
  }finally{await s.close()}
  for(const change of ["target_id=gen_random_uuid()","source_id=gen_random_uuid()","generation=generation+1"]){
   assert.equal(JSON.parse(await sql("BEGIN; UPDATE ppo_authority.rehearsal_owner SET "+change+"; SET LOCAL ROLE ppo_action_consumer; "+rawConsume(registered.ticket)+" ROLLBACK;")).consumed,false)
  }
  assert.equal(await count(),"0")
 }))
 await t.test("expiry during gate waits and deferred COMMIT check denies without a tombstone",async()=>fixture(async({run,f})=>{
  for(const kind of ["wait","commit"]){
   const epoch=Number(await sql("SELECT epoch FROM ppo_authority.action_hosts WHERE host_id='lab-action-host';"))+1
   const n=signedActionFixture(run,{keys:f.keys,epoch,lifetime:2500,changeProof:p=>{p.expiresAt=new Date(Date.now()+50000).toISOString()}});await host(n,epoch-1);const r=await verifier(n).register(n.input)
   const a=session("action-expire-a","postgres"),b=session("action-expire-b","ppo_action_consumer")
   try{
    await a.ready();await b.ready()
    if(kind==="wait"){
     await a.send("BEGIN; UPDATE ppo_authority.gate SET revision=revision+1;")
     const waiting=b.send(rawConsume(r.ticket));await blockedBy(b,a)
     await a.send("SELECT pg_sleep(2.6); COMMIT;")
     assert.equal(JSON.parse(await waiting).consumed,false)
    }else{
     assert.equal(JSON.parse(await b.send("BEGIN;"+rawConsume(r.ticket))).consumed,true)
     await assert.rejects(b.send("SELECT pg_sleep(2.6); COMMIT;"),/expired/)
    }
   }finally{await a.close();await b.close()}
  }
  assert.equal(await count(),"0")
 }))
 await t.test("late acknowledged commit denies diagnostic freshness while committed tombstone persists",async()=>fixture(async({run,f})=>{
  const n=signedActionFixture(run,{keys:f.keys,epoch:2,lifetime:3500,changeProof:p=>{p.expiresAt=new Date(Date.now()+50000).toISOString()}});await host(n,1);const r=await verifier(n).register(n.input)
  const c=await consumer("action-ack-late",async(s,execute)=>{
   const result=await execute()
   if(s==="COMMIT")await sql("SELECT pg_sleep(3.6);") // real committed COMMIT response withheld
   return result
  })
  try{const result=await c.adapter.consume(r);assert.equal(result.status,"expired-or-stale");assert.equal(result.grant,false);assert.equal(result.consumed,true)}finally{await c.close()}
  assert.equal(await count(),"1")
 }))
 await t.test("expiry after final deferred check during actual COMMIT retains tombstone but never grants",async()=>fixture(async({run,f})=>{
  await sql("CREATE FUNCTION ppo_authority.test_late_commit() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $b$; CREATE CONSTRAINT TRIGGER zz_test_late_commit AFTER INSERT ON ppo_authority.action_tombstones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ppo_authority.test_late_commit();")
  const n=signedActionFixture(run,{keys:f.keys,epoch:2,lifetime:2500,changeProof:p=>{p.expiresAt=new Date(Date.now()+50000).toISOString()}})
  await host(n,1);const r=await verifier(n).register(n.input),c=await consumer("action-during-commit")
  try{const result=await c.adapter.consume(r);assert.equal(result.status,"expired-or-stale");assert.equal(result.consumed,true);assert.equal(result.grant,false)}finally{await c.close()}
  assert.equal(await count(),"1")
 }))
 await t.test("rollback, backend termination and lost acknowledgments retain conservative operation evidence",async()=>fixture(async({run,f,registered})=>{
  const s=session("action-rollback","ppo_action_consumer");await s.ready()
  try{await s.send("BEGIN;"+rawConsume(registered.ticket)+" ROLLBACK;");assert.equal(await count(),"0")}finally{await s.close()}
  const k=session("action-killed","ppo_action_consumer");await k.ready()
  try{await k.send("BEGIN;"+rawConsume(registered.ticket));await sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='action-killed';")}finally{await k.close()}
  assert.equal(await count(),"0")
  const dir=await mkdtemp(join(tmpdir(),"ppo-action-journal-")),journal=join(dir,"operation.json")
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const savedOperation={ticket:registered.ticket,operationId:randomUUID()}
  const file=await open(journal,"wx",0o600)
  try{await file.writeFile(JSON.stringify(savedOperation));await file.sync()}finally{await file.close()}
  const c=await consumer("action-lost-ack",async(s,execute)=>{const result=await execute();if(s==="COMMIT")throw Error("lost committed ack");return result})
  let outcome
  try{outcome=await c.adapter.consume(savedOperation);assert.equal(outcome.status,"unknown");assert.equal(outcome.grant,false);await assert.rejects(c.adapter.consume(registered))}finally{await c.close()}
  assert.equal(await count(),"1")
  assert.equal((await inspectIsolatedActionConsumption({mode,operation:outcome.operation,query:query("ppo_action_consumer")})).status,"consumed")
  const absent=await inspectIsolatedActionConsumption({mode,operation:{ticket:randomUUID(),operationId:randomUUID()},query:query("ppo_action_consumer")});assert.equal(absent.status,"unknown")
  // Independent Node coordinator restart reads a durable descriptor, no keys.
  const childCode=`import {readFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
   import {inspectIsolatedActionConsumption,POSTGRES_ACTION_SQL as S} from ${JSON.stringify(new URL("../../local-operator/software-factory-remote-postgres-action-fence.mjs",import.meta.url).href)};
   const operation=JSON.parse(readFileSync(process.argv[1],'utf8'));
   const query=async(s,args)=>{if(s!==S.observe)throw Error('fixed read only');
    const text=s.replace(/\\$([12])/g,(_,i)=>"'"+args[Number(i)-1]+"'");
    return {rows:[JSON.parse(execFileSync('docker',['exec',process.argv[2],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','ppo_authority_ci','-c',"SET ROLE ppo_action_consumer; SELECT row_to_json(q) FROM ("+text+") q;"],{encoding:'utf8'}).trim())]};};
   const r=await inspectIsolatedActionConsumption({mode:'isolated-postgres-action-fencing-only',query,operation}); console.log(JSON.stringify({status:r.status,grant:r.grant}));`
  try{
   const child=spawnSync(process.execPath,["--input-type=module","-e",childCode,journal,container],{encoding:"utf8"})
   assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{status:"consumed",grant:false})
  }finally{await rm(dir,{recursive:true,force:true})}
  const newer=signedActionFixture(run,{keys:f.keys,epoch:2});await host(newer,1)
  const staged=await verifier(newer).register(newer.input),pending=session("action-server-uncommitted","ppo_action_consumer")
  await pending.ready();await pending.send("BEGIN;"+rawConsume(staged.ticket))
  // Unclean server death and recovery, not merely a JS adapter recreation.
  assert.equal(spawnSync("docker",["kill","--signal=KILL",container],{encoding:"utf8"}).status,0)
  await pending.close()
  assert.equal(spawnSync("docker",["start",container],{encoding:"utf8"}).status,0)
  let ready=false
  for(let i=0;i<60;i++){
   const check=spawnSync("docker",["exec",container,"pg_isready","-U","postgres","-d","ppo_authority_ci"],{encoding:"utf8"})
   if(check.status===0){ready=true;break}
   await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert.equal(ready,true);assert.equal(await count(),"1")
  const observed=await inspectIsolatedActionConsumption({mode,operation:outcome.operation,query:query("ppo_action_consumer")})
  assert.equal(observed.status,"consumed");assert.equal(observed.grant,false)
  assert.equal(JSON.parse(await sql(rawConsume(registered.ticket),"ppo_action_consumer")).consumed,false)
 }))
 await runResourceCases(t,{fixture,sql,session,blockedBy,L,query,host,verifier,consumer,rawConsume,count,container})
}
