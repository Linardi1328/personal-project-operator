import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createSyntheticOwnershipRehearsal, OWNERSHIP_REHEARSAL_SQL as S } from "../../local-operator/development-ownership-rehearsal.mjs"
const mode="synthetic-ownership-cutover-rehearsal-only"
export async function runOwnershipRehearsalCases(t,h){
  const {sql,session,blockedBy,literals,exactImported,installImportAuthority,dropImportAuthority,container}=h
  const roles={[S.read]:"ppo_rehearsal_controller",[S.receipt]:"ppo_rehearsal_controller",[S.control]:"ppo_rehearsal_controller",[S.source]:"ppo_rehearsal_source",[S.target]:"ppo_rehearsal_target"}
  const bound=(statement,args)=>statement.replace(/\$([12])/gu,(_,i)=>literals(args[Number(i)-1]))
  const q=async(statement,args)=>{
    if(!Object.hasOwn(roles,statement))throw Error("unexpected ownership statement")
    return {rows:[JSON.parse(await sql("SELECT row_to_json(q) FROM ("+bound(statement,args)+") q;",roles[statement]))]}
  }
  const make=(query=q)=>createSyntheticOwnershipRehearsal({mode,query})
  const raw=async(action,r,channel=S.control)=>(await q(channel,[JSON.stringify({action,operationId:randomUUID(),...r})])).rows[0].evidence
  const current=async c=>{
    const o=await c.observe()
    const active=o.files.map(f=>JSON.parse(Buffer.from(f.bytesBase64,"base64"))).find(r=>r.status==="implementation_in_progress")
    return {o,active}
  }
  const snapshot=o=>({inventoryHash:o.digest,runCount:o.files.filter(f=>f.path.startsWith("records/")).length,files:o.files})
  const capturePins=(o,p)=>({sourceId:o.owner.source_id,targetId:o.owner.target_id,generation:o.owner.generation,revision:o.revision,manifest:o.digest,fence:p?.fence,attempt:p?.attempt})
  async function fixture(fn){
    const cleanups=[]
    await installImportAuthority()
    try{
      await sql(await readFile(new URL("./phase1gb2-canonical-catalog.sql",import.meta.url),"utf8"))
      await sql(await readFile(new URL("./phase1gb2-ownership-rehearsal.sql",import.meta.url),"utf8"))
      const c=make();const seed=await c.seed();await fn(c,seed,cleanups)
    }finally{try{await dropImportAuthority()}finally{for(const cleanup of cleanups)await cleanup()}}
  }
  await t.test("source-only, held and target-only; exact handoff, lost committed activation and process restart",async()=>{
    await fixture(async(c,seed,cleanups)=>{
      const {active}=await current(c)
      assert.equal(seed.phase,"source");assert.equal(seed.generation,"1")
      await assert.rejects(c.target.transition(active.runId,{expectedVersion:active.version,status:"cancelled",actor:"owner-test"}))
      assert.equal(await c.sourceAuthority.commitRecord(JSON.stringify(active),active.version-1,active.history.at(-1).previousHistoryHash),false)
      await assert.rejects(c.source.create({projectId:"kynexa",task:"RIC-157 shared authority synthetic: source WIP deny",baseSha:"a".repeat(40),headSha:"b".repeat(40),branch:"feature/ownership"}))
      const progressed=await c.source.progress(active.runId,{expectedVersion:active.version,status:active.status,actor:"owner-test",reason:"source-only mutation"})
      const seedOld=make();assert.equal((await seedOld.reconcile({...c.operation(),operationId:seed.operationId,requestHash:seed.requestHash,action:"seed",sourceId:null,generation:"1"})).status,"unknown")
      const freeze=await c.freeze();assert.equal(freeze.generation,"2");assert.equal(freeze.phase,"held")
      await assert.rejects(c.source.transition(active.runId,{expectedVersion:progressed.version,status:"cancelled",actor:"owner-test"}))
      await assert.rejects(c.target.transition(active.runId,{expectedVersion:progressed.version,status:"cancelled",actor:"owner-test"}))
      await assert.rejects(c.activate())
      await c.import();const before=await c.observe();await exactImported(snapshot(before))
      await assert.rejects(c.activate({operationId:freeze.operationId}))
      // Native hidden decimal corruption cannot be blessed at activation.
      const unsafeRequest=JSON.stringify({action:"activate",operationId:randomUUID(),...capturePins(before,freeze)})
      const denied=JSON.parse(await sql("BEGIN; ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; UPDATE ppo_authority.run_versions SET record=replace(record::text,'9007199254740992','9007199254740993')::jsonb WHERE version>=4; SET LOCAL ROLE ppo_rehearsal_controller; SELECT ppo_authority.rehearsal_control("+literals(unsafeRequest)+"); ROLLBACK;"))
      assert.equal(denied.accepted,false)
      await exactImported(snapshot(before))
      // Catalog failures deny activation before any mutation transport call.
      for(const kind of ["invalid","truncated"]){
        let mutations=0
        const bad=make(async(statement,args)=>{
          const result=await q(statement,args)
          if(statement===S.read){
            if(kind==="truncated")result.rows[0].observation.catalog={revision:result.rows[0].observation.revision,code:"catalog_truncated",entries:[]}
            else result.rows[0].observation.catalog.entries[0].serialized="{}"
          }else if(statement===S.control)mutations++
          return result
        })
        assert.equal((await bad.reconcile(c.operation())).status,"committed")
        await assert.rejects(bad.activate(),e=>e.code==="CATALOG_INVALID")
        assert.equal(mutations,0)
      }
      let lost=false,calls=0
      const journalRoot=await mkdtemp(join(tmpdir(),"ppo-ownership-journal-")),journalPath=join(journalRoot,"operation.json")
      cleanups.push(()=>rm(journalRoot,{recursive:true,force:true}))
      const lose=make(async(statement,args)=>{
        if(statement===S.control&&JSON.parse(args[0]).action==="activate"){
          // Persist the bounded descriptor BEFORE dispatch, as required of
          // the trusted caller/transport; no writer capability is journaled.
          const file=await open(journalPath,"wx",0o600)
          try{await file.writeFile(JSON.stringify(lose.pending()));await file.sync()}finally{await file.close()}
          const result=await q(statement,args);calls++;lost=true;throw Error("lost after actual commit")
        }
        return q(statement,args)
      })
      await lose.reconcile(c.operation())
      let uncertain
      await assert.rejects(lose.activate(),e=>{uncertain=e.operation;return e.code==="REHEARSAL_COMMIT_UNKNOWN"})
      assert.equal(lost,true);assert.equal(calls,1)
      await assert.rejects(lose.sourceAuthority.readRun(active.runId))
      await assert.rejects(lose.targetAuthority.readRun(active.runId))
      await assert.rejects(c.source.transition(active.runId,{expectedVersion:progressed.version,status:"cancelled",actor:"old-source"}))
      assert.equal((await c.observe()).owner.phase,"target")
      await assert.rejects(c.abort()) // no reverse migration or stale source revival
      // A brand new Node process reconstructs the client and obtains only a
      // positive current committed receipt from an independent connection.
      const moduleURL=new URL("../../local-operator/development-ownership-rehearsal.mjs",import.meta.url).href
      // Unclean restart of this disposable PostgreSQL instance preserves
      // identities, committed ownership and its operation receipt via WAL.
      for(const args of [["kill","--signal=KILL",container],["start",container]]){
        const result=spawnSync("docker",args,{encoding:"utf8",timeout:20000});assert.equal(result.status,0,result.stderr)
      }
      let ready=false
      for(let i=0;i<50;i++){
        try{if(await sql("SELECT 1;")==="1"){ready=true;break}}catch{}
        await new Promise(resolve=>setTimeout(resolve,100)) // startup polling, never mutation retry
      }
      assert.equal(ready,true)
      assert.equal((await q(S.read,[])).rows[0].observation.owner.target_id,seed.targetId)
      const probe=`import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {createSyntheticOwnershipRehearsal} from ${JSON.stringify(moduleURL)};
        const d=JSON.parse(readFileSync(process.argv[1],'utf8'));const lit=v=>"convert_from(decode('"+Buffer.from(v).toString('base64')+"','base64'),'UTF8')";
        const c=createSyntheticOwnershipRehearsal({mode:${JSON.stringify(mode)},query:async(s,a)=>{if(s!==${JSON.stringify(S.receipt)})throw Error('unexpected');const b=s.replace(/\\$([12])/g,(_,i)=>lit(a[Number(i)-1]));const p=spawnSync('docker',['exec',${JSON.stringify(container)},'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','ppo_authority_ci','-c','SET ROLE ppo_rehearsal_controller; SELECT row_to_json(q) FROM ('+b+') q;'],{encoding:'utf8',timeout:10000});if(p.status!==0)throw Error(p.stderr);return {rows:[JSON.parse(p.stdout)]}}});const r=await c.reconcile(d);console.log(JSON.stringify({status:r.status,phase:r.evidence.phase,generation:r.evidence.generation}));`
      const process=spawnSync(globalThis.process.execPath,["--input-type=module","-e",probe,journalPath],{encoding:"utf8",timeout:15000})
      assert.equal(process.status,0,process.stderr)
      assert.deepEqual(JSON.parse(process.stdout),{status:"committed",phase:"target",generation:"3"})
      assert.deepEqual(JSON.parse(await readFile(journalPath,"utf8")),uncertain)
      await rm(journalRoot,{recursive:true,force:true})
      const restart=make();assert.equal((await restart.reconcile(JSON.parse(JSON.stringify(uncertain)))).status,"committed")
      await assert.rejects(restart.target.create({projectId:"kynexa",task:"RIC-157 shared authority synthetic: target WIP deny",baseSha:"a".repeat(40),headSha:"b".repeat(40),branch:"feature/ownership"}))
      assert.equal(await restart.targetAuthority.commitRecord(JSON.stringify(progressed),progressed.version-1,progressed.history.at(-1).previousHistoryHash),false)
      const cancelled=await restart.target.transition(active.runId,{expectedVersion:progressed.version,status:"cancelled",actor:"new-target"})
      await exactImported(snapshot(before),[cancelled])
      const owned=await restart.reconcile(restart.operation()),ownedNow=await restart.observe()
      const validSourceCandidate={...capturePins(ownedNow),key:owned.evidence.key,runId:cancelled.runId,expectedVersion:progressed.version,expectedHash:progressed.historyHash,serialized:JSON.stringify(cancelled)}
      assert.equal((await raw("source_commit",validSourceCandidate,S.source)).accepted,false)
      await exactImported(snapshot(before),[cancelled])
      // Source table bytes stay identical once target owns writes.
      assert.deepEqual((await restart.observe()).files,before.files)
      await assert.rejects(sql("SELECT ppo_authority.commit_run(NULL,NULL,NULL,NULL);","ppo_authority_writer"),/permission denied/)
      await assert.rejects(sql("SELECT ppo_authority.import_synthetic_snapshot(NULL,NULL);","ppo_authority_importer"),/permission denied/)
      for(const role of ["ppo_rehearsal_controller","ppo_rehearsal_source","ppo_rehearsal_target"]){
        await assert.rejects(sql("UPDATE ppo_authority.rehearsal_owner SET generation=1;",role),/permission denied/)
        await assert.rejects(sql("SELECT * FROM ppo_authority.rehearsal_source_files;",role),/permission denied/)
        await assert.rejects(sql("SELECT ppo_authority.rehearsal_apply(NULL,NULL);",role),/permission denied/)
      }
      await assert.rejects(sql("DELETE FROM ppo_authority.rehearsal_receipts;"),/append-only/)
      await assert.rejects(sql("UPDATE ppo_authority.rehearsal_source_files SET bytes=bytes WHERE path LIKE 'versions/%';"),/append-only/)
    })
  })
  await t.test("pre-activation abort never erases target and rotates source ownership; stale handoff is fenced",async()=>{
    for(const staged of [false,true])await fixture(async(c,seed)=>{
      const {active}=await current(c);const oldSource={...seed}
      const held=await c.freeze();if(staged)await c.import()
      const o=await c.observe(),pins=capturePins(o,held)
      const wrong=await raw("activate",{...pins,fence:randomUUID()});assert.equal(wrong.accepted,false)
      // Uncertain abort keeps the source's newly issued opaque permit unknown.
      const lose=make(async(s,a)=>{const result=await q(s,a);if(s===S.control&&JSON.parse(a[0]).action==="abort")throw Error("lost committed abort");return result})
      await lose.reconcile(c.operation())
      await assert.rejects(lose.abort(),e=>e.code==="REHEARSAL_COMMIT_UNKNOWN")
      const aborted=await lose.reconcile();assert.equal(aborted.status,"committed");assert.equal(aborted.evidence.phase,"aborted")
      assert.equal(aborted.evidence.generation,"3")
      const now=await lose.observe();assert.equal(now.owner.imported,staged)
      assert.equal((await raw("activate",pins)).accepted,false) // queued/delayed old request cannot activate
      assert.equal((await raw("source_commit",{...capturePins(now),generation:oldSource.generation,key:oldSource.key,runId:active.runId,expectedVersion:active.version,expectedHash:active.historyHash,serialized:JSON.stringify(active)},S.source)).accepted,false)
      await assert.rejects(c.source.progress(active.runId,{expectedVersion:active.version,status:active.status,actor:"stale-owner"}))
      const mutated=await lose.source.progress(active.runId,{expectedVersion:active.version,status:active.status,actor:"new-source",reason:"safe pre-activation resume"})
      assert.equal(mutated.version,active.version+1)
      await assert.rejects(lose.freeze()) // no destructive reset/re-import of quarantined target
      await assert.rejects(lose.activate())
      if(staged)await exactImported(snapshot(o))
      else assert.equal(await sql("SELECT count(*) FROM ppo_authority.run_versions;"),"0")
    })
  })
  await t.test("real mutation gate serializes source write and concurrent freeze; stale snapshot/identity/manifest deny",async()=>{
    await fixture(async(c)=>{
      const {o,active}=await current(c),other=make();await other.reconcile(c.operation())
      const a=session("ownership-source-writer","ppo_rehearsal_source"),b=session("ownership-freeze","ppo_rehearsal_controller"),barrier=session("ownership-source-barrier","postgres")
      await sql(`CREATE FUNCTION ppo_authority.ci_source_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $b$ BEGIN PERFORM pg_advisory_xact_lock(157901); RETURN NEW; END $b$;
        CREATE TRIGGER ci_source_barrier AFTER INSERT ON ppo_authority.rehearsal_source_files FOR EACH ROW WHEN(NEW.path LIKE 'versions/%') EXECUTE FUNCTION ppo_authority.ci_source_barrier();`)
      try{
        await Promise.all([a.ready(),b.ready(),barrier.ready()]);await barrier.send("BEGIN; SELECT pg_advisory_xact_lock(157901);")
        const inSession=(session,s,args)=>session.send("BEGIN; SELECT row_to_json(q) FROM ("+bound(s,args)+") q; COMMIT;").then(out=>({rows:[JSON.parse(out)]}))
        const writer=make((s,args)=>s===S.source?inSession(a,s,args):q(s,args));await writer.reconcile(c.operation())
        const freezer=make((s,args)=>s===S.control?inSession(b,s,args):q(s,args));await freezer.reconcile(c.operation())
        const writing=writer.source.progress(active.runId,{expectedVersion:active.version,status:active.status,actor:"held-boundary",reason:"mutation before freeze"});writing.catch(()=>{})
        await blockedBy(a,barrier)
        const freezing=freezer.freeze();freezing.catch(()=>{})
        await blockedBy(b,a)
        await barrier.send("COMMIT;")
        const written=await writing;assert.equal(written.version,active.version+1)
        await assert.rejects(freezing,e=>e.code==="REHEARSAL_REJECTED")
        const after=await writer.observe();assert.equal(after.owner.phase,"source");assert.notEqual(after.digest,o.digest)
        assert.equal((await raw("freeze",{...capturePins(after),manifest:"f".repeat(64)})).accepted,false)
        const refreshed=await writer.observe()
        assert.equal((await raw("freeze",{...capturePins(refreshed),targetId:randomUUID()})).accepted,false)
        // Two independent controllers race; exactly one held generation exists.
        const left=make(),right=make();await left.reconcile(writer.operation());await right.reconcile(writer.operation())
        const results=await Promise.allSettled([left.freeze(),right.freeze()])
        assert.equal(results.filter(r=>r.status==="fulfilled").length,1)
        const winner=results[0].status==="fulfilled"?left:right
        assert.equal((await winner.observe()).owner.generation,"2")
        await winner.abort()
      }finally{await Promise.all([a.close(),b.close(),barrier.close()])}
    })
  })
  await t.test("transaction crash rolls activation back; absence stays unknown; explicit abort fences pending generation",async()=>{
    await fixture(async c=>{
      await c.freeze();await c.import();const held=await c.observe();const snap=snapshot(held)
      const a=session("ownership-crash-activation","ppo_rehearsal_controller"),barrier=session("ownership-crash-barrier","postgres")
      await sql(`CREATE FUNCTION ppo_authority.ci_activation_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $b$ BEGIN IF NEW.evidence->>'action'='activate' THEN PERFORM pg_advisory_xact_lock(157902); END IF; RETURN NEW; END $b$;
        CREATE TRIGGER ci_activation_barrier AFTER INSERT ON ppo_authority.rehearsal_receipts FOR EACH ROW EXECUTE FUNCTION ppo_authority.ci_activation_barrier();`)
      try{
        await Promise.all([a.ready(),barrier.ready()]);await barrier.send("BEGIN; SELECT pg_advisory_xact_lock(157902);")
        const client=make((s,args)=>s===S.control?a.send("BEGIN; SELECT row_to_json(q) FROM ("+bound(s,args)+") q; COMMIT;").then(out=>({rows:[JSON.parse(out)]})):q(s,args))
        await client.reconcile(c.operation());const activation=client.activate();activation.catch(()=>{})
        await blockedBy(a,barrier)
        assert.equal((await c.observe()).owner.phase,"held")
        await sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='ownership-crash-activation';")
        await assert.rejects(activation,e=>e.code==="REHEARSAL_COMMIT_UNKNOWN")
        assert.equal((await client.reconcile()).status,"unknown")
        assert.equal((await client.observe()).owner.phase,"held")
        await assert.rejects(client.activate(),e=>e.code==="REHEARSAL_UNCERTAIN")
        await exactImported(snap)
        // Use normal independent transport to submit a NEW explicit abort;
        // source never resumes on absence or on a stale operation receipt.
        const restart=make();assert.equal((await restart.reconcile(client.pending())).status,"unknown")
        await restart.abort();assert.equal((await restart.observe()).owner.phase,"aborted")
        await exactImported(snap)
      }finally{await Promise.all([a.close(),barrier.close()])}
    })
  })
  await t.test("late failed import rolls back archive and histories; explicit abort is the only source resumption",async()=>{
    await fixture(async c=>{
      await c.freeze();const before=await c.observe()
      await sql(`CREATE FUNCTION ppo_authority.ci_import_fault() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $b$ BEGIN IF NEW.version=2 THEN RAISE EXCEPTION 'synthetic late import fault'; END IF; RETURN NEW; END $b$;
        CREATE TRIGGER ci_import_fault AFTER INSERT ON ppo_authority.run_versions FOR EACH ROW EXECUTE FUNCTION ppo_authority.ci_import_fault();`)
      await assert.rejects(c.import(),e=>e.code==="REHEARSAL_COMMIT_UNKNOWN")
      const pending=c.pending();assert.equal((await c.reconcile()).status,"unknown")
      assert.equal(await sql("SELECT (SELECT count(*) FROM ppo_authority.run_versions)||','||(SELECT count(*) FROM ppo_authority.synthetic_import_batch)||','||(SELECT count(*) FROM ppo_authority.synthetic_import_files);"),"0,0,0")
      assert.deepEqual((await c.observe()).files,before.files)
      assert.equal((await c.observe()).owner.phase,"held")
      await c.abort() // positive committed abort fences the absent/late old generation
      assert.equal((await c.observe()).owner.phase,"aborted")
      assert.equal((await make().reconcile(pending)).status,"unknown")
    })
  })
  await t.test("stale REPEATABLE READ and SERIALIZABLE source writers cannot cross the ownership gate",async()=>{
    for(const isolation of ["REPEATABLE READ","SERIALIZABLE"])await fixture(async c=>{
      const a=session("ownership-stale-source","ppo_rehearsal_source")
      try{
        await a.ready();const stale=make((s,args)=>[S.read,S.source].includes(s)?a.send("SELECT row_to_json(q) FROM ("+bound(s,args)+") q;").then(out=>({rows:[JSON.parse(out)]})):q(s,args))
        await stale.reconcile(c.operation());await a.send("BEGIN ISOLATION LEVEL "+isolation+";")
        const {active}=await current(stale) // old source-only snapshot now established
        await c.freeze()
        await assert.rejects(stale.source.progress(active.runId,{expectedVersion:active.version,status:active.status,actor:"stale-transaction"}))
        assert.ok(stale.pending())
        assert.equal((await stale.reconcile()).status,"unknown")
        const o=await c.observe();assert.equal(o.owner.phase,"held");assert.equal(o.owner.generation,"2")
        assert.equal(o.files.filter(f=>f.path.startsWith("versions/")).length,17)
        await c.abort()
      }finally{await a.close()}
    })
  })
  await t.test("bounded receipt ledger reserves the terminal abort slot without deleting evidence",async()=>{
    await fixture(async c=>{
      await c.freeze()
      await sql(`WITH filler AS MATERIALIZED (SELECT gen_random_uuid() AS id FROM generate_series(1,997))
        INSERT INTO ppo_authority.rehearsal_receipts SELECT id,repeat('f',64),jsonb_build_object('operationId',id,'requestHash',repeat('f',64),'action','test-budget-filler') FROM filler;`)
      assert.equal(await sql("SELECT count(*) FROM ppo_authority.rehearsal_receipts;"),"999")
      await assert.rejects(c.import(),e=>e.code==="REHEARSAL_REJECTED")
      await c.abort()
      assert.equal(await sql("SELECT count(*) FROM ppo_authority.rehearsal_receipts;"),"1000")
      assert.equal((await c.observe()).owner.phase,"aborted")
      await assert.rejects(sql("DELETE FROM ppo_authority.rehearsal_receipts;"),/append-only/)
    })
  })
  await t.test("authority replacement at identical revision/generation rejects prior pins and receipts",async()=>{
    let saved,pinned,oldClient
    await fixture(async(c,seed)=>{saved=c.operation();pinned=seed;oldClient=c;assert.equal((await c.observe()).revision,"1")})
    // Whole disposable fixture teardown/new installation: never a protocol
    // reset API. Restart preserves identity; fresh authority generates a new one.
    await fixture(async(c,seed)=>{
      const o=await c.observe();assert.equal(o.revision,"1");assert.equal(seed.generation,pinned.generation)
      assert.notEqual(seed.targetId,pinned.targetId);assert.notEqual(seed.sourceId,pinned.sourceId)
      await assert.rejects(oldClient.observe(),e=>e.code==="AUTHORITY_REPLACED")
      assert.equal((await make().reconcile(saved)).status,"unknown")
      assert.equal((await raw("freeze",{...capturePins(o),sourceId:pinned.sourceId,targetId:pinned.targetId})).accepted,false)
      assert.equal((await c.observe()).owner.phase,"source")
    })
  })
}
