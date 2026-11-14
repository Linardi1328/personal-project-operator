import {runPinnedServiceTransportCases} from './pinned-service-transport-cases.mjs'
import {runAdmissionCases} from './phase1gd1-admission-cases.mjs'
import { runPostgresActionCases } from "./phase1gb2c-action-cases.mjs"
import { runOwnershipRehearsalCases } from "./phase1gb2-ownership-cases.mjs"
import { createPostgresTestSession } from "./postgres-test-session.mjs"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  createDevelopmentRun, transitionDevelopmentRun, recordDevelopmentRunProgress,
  createIsolatedCanonicalRunState, recoverDevelopmentRunReviewOrphanState,
  recoverDevelopmentRunReviewRuntimeFailureState,
  REVIEW_ORPHAN_RECOVERY_CONFIRMATION, REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION
} from "../../local-operator/development-run-state.mjs"
import { createPostgresCanonicalAuthority } from "../../local-operator/development-postgres-canonical-authority.mjs"
import { captureSyntheticMigrationRehearsal, createSyntheticMigrationImporter } from "../../local-operator/development-migration-rehearsal.mjs"
import { createPostgresCanonicalCatalog } from "../../local-operator/development-postgres-canonical-catalog.mjs"
import { rehearseSyntheticMigrationPreflight } from "../../local-operator/development-migration-preflight.mjs"

// Deliberately not a .test.mjs: the explicit CI step starts a fresh isolated
// PostgreSQL container. No environment DSN or host database is ever used.
const container=process.env.PPO_AUTHORITY_TEST_CONTAINER
if(process.env.CI!=="true"||!/^ppo-authority-ci-[0-9]+-[0-9]+$/u.test(container||"")){
  throw Error("Dedicated disposable CI authority container required")
}
async function sql(input,role="postgres",maxStdoutBytes=40*1024*1024){
  if(!["postgres","ppo_authority_writer","ppo_authority_reader","ppo_untrusted_ci","ppo_authority_importer","ppo_rehearsal_controller","ppo_rehearsal_source","ppo_rehearsal_target","ppo_action_admin","ppo_action_verifier","ppo_action_consumer","ppo_resource_verifier","ppo_resource_consumer","ppo_admission_verifier"].includes(role))throw Error("invalid test role")
  const p=spawn("docker",["exec","-i",container,"psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","ppo_authority_ci"],{stdio:["pipe","pipe","pipe"]})
  const largeSnapshot=maxStdoutBytes>40*1024*1024
  const client=createPostgresTestSession(p,{timeoutMs:largeSnapshot?60000:20000,maxStdoutBytes})
  try{return await client.send("SET statement_timeout='"+(largeSnapshot?"45s":"15s")+"'; SET ROLE "+role+";\n"+input)}
  catch(error){throw Error("PostgreSQL CI statement failed: "+error.message.slice(0,1200))}
  finally{await client.close()}
}
// Only the fixed adapter statements are supported. Base64 text encoding is
// for the psql test transport, NOT a replacement for production bind params.
const literals=v=>v===null?"NULL":
  typeof v==="number"&&Number.isSafeInteger(v)?String(v):
  typeof v==="string"?"convert_from(decode('"+Buffer.from(v,"utf8").toString("base64")+"','base64'),'UTF8')":
  (()=>{throw Error("invalid test parameter")})()
const statements={
  "SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::text) AS accepted":"accepted",
  "SELECT ppo_authority.read_run($1::text) AS record":"record",
  "SELECT ppo_authority.read_versions($1::text) AS records":"records",
  "SELECT ppo_authority.read_catalog_snapshot() AS snapshot":"snapshot",
  "SELECT ppo_authority.import_synthetic_snapshot($1::text,$2::text) AS accepted":"accepted",
  "SELECT ppo_authority.read_synthetic_archive($1::text) AS archive":"archive"
}
function query(role){
  return async (statement,values)=>{
    if(!Object.hasOwn(statements,statement))throw Error("unexpected query")
    const bound=statement.replace(/\$([1-4])/g,(_,i)=>literals(values[Number(i)-1]))
    const out=await sql("SELECT row_to_json(q) FROM ("+bound+") q;",role)
    return {rows:[JSON.parse(out)]}
  }
}
function authority(role="ppo_authority_writer"){
  return createPostgresCanonicalAuthority({mode:"isolated-postgres-canonical-authority",query:query(role)})
}
async function fixture(project,task="RIC-157 shared authority synthetic: canonical CAS fixture"){
  const dir=await mkdtemp(join(tmpdir(),"ppo-shared-authority-"))
  let clock=Date.parse("2026-01-01T00:00:00.000Z")
  const options={writeDataDir:dir,now:()=>new Date(clock+=1000)}
  try{
    const initial=await createDevelopmentRun({projectId:project,task,
      baseSha:"a".repeat(40),headSha:"b".repeat(40),branch:"feature/authority-ci",actor:"test-agent"},options)
    const first=await transitionDevelopmentRun(initial.runId,{expectedVersion:0,status:"planning_in_progress",actor:"test-agent"},options)
    const planned=await transitionDevelopmentRun(initial.runId,{expectedVersion:1,status:"planned",actor:"test-agent"},options)
    const implementing=await transitionDevelopmentRun(initial.runId,{expectedVersion:2,status:"implementation_in_progress",actor:"test-agent"},options)
    const progress=await recordDevelopmentRunProgress(initial.runId,{expectedVersion:3,status:"implementation_in_progress",actor:"test-agent",reason:"synthetic progress",evidence:[{kind:"implementation",sha:"b".repeat(40),source:"test-agent",summary:"Large numeric metadata and Unicode 😀",metadata:Object.fromEntries(Array.from({length:16},(_,i)=>["n"+i,Array(16).fill(1e308)]))}]},options)
    const cancelled=await transitionDevelopmentRun(initial.runId,{expectedVersion:4,status:"cancelled",actor:"test-agent"},options)
    return {initial,first,planned,implementing,progress,cancelled}
  }finally{await rm(dir,{recursive:true,force:true})}
}
async function releasedFixture(project){
  const dir=await mkdtemp(join(tmpdir(),"ppo-shared-release-"))
  let clock=Date.parse("2026-01-01T00:00:00.000Z")
  const options={writeDataDir:dir,now:()=>new Date(clock+=1000)}
  try{
    const initial=await createDevelopmentRun({projectId:project,task:"RIC-157 shared authority synthetic: release reentry",
      baseSha:"a".repeat(40),headSha:"b".repeat(40),branch:"feature/authority-ci",actor:"test-agent"},options)
    const records=[initial]
    for(const status of ["planning_in_progress","planned","implementation_in_progress","implementation_ready","tests_in_progress","tests_passed","review_in_progress","review_passed","merge_ready","merged","deploy_in_progress","deployed","verification_in_progress","verification_failed","rollback_in_progress","rolled_back","implementation_in_progress"]){
      records.push(await transitionDevelopmentRun(initial.runId,{expectedVersion:records.at(-1).version,status,actor:"test-agent"},options))
    }
    return {released:records.at(-2),reactivated:records.at(-1),history:records.slice(0,-1)}
  }finally{await rm(dir,{recursive:true,force:true})}
}
const commit=(a,record,prior=null)=>a.commitRecord(JSON.stringify(record),prior?.version??-1,prior?.historyHash??null)
const commitSql=(record,prior=null)=>"SELECT ppo_authority.commit_run("+[record.runId,prior?.version??-1,prior?.historyHash??null,JSON.stringify(record)].map(literals).join(",")+");"

// Hold a known snapshot in an independent session, then let A commit. B
// is provably not merely scheduled after A: its read completed beforehand.
async function staleSnapshot(isolation,record,next,commitA){
  const client=session("canonical-stale-snapshot","ppo_authority_writer")
  try{
    await client.ready()
    assert.equal(await client.send("BEGIN ISOLATION LEVEL "+isolation+"; SELECT ppo_authority.read_run("+literals(record.runId)+") IS NOT NULL;"),"t")
    await commitA()
    if(isolation==="READ COMMITTED")assert.equal(await client.send(commitSql(next,record)+" COMMIT;"),"f")
    else await assert.rejects(client.send(commitSql(next,record)+" COMMIT;"),/40001/)
  }finally{await client.close()}
}

// Interactive independent transactions use server-observed blocking, never
// sleeps to choose a winner. Every send is delimited after execution by psql.
function session(name,role){
  const p=spawn("docker",["exec","-i",container,"psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","ppo_authority_ci"],{stdio:["pipe","pipe","pipe"]})
  const client=createPostgresTestSession(p)
  return {...client,name,
    ready:()=>client.send("\\set VERBOSITY verbose\nSELECT set_config('application_name',"+literals(name)+",false); SET statement_timeout='15s'; SET idle_in_transaction_session_timeout='15s'; SET ROLE "+role+";")
  }
}
async function blockedBy(waiter,leader){
  const deadline=Date.now()+10000
  while(Date.now()<deadline){
    const waiting=await sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity b ON b.pid=ANY(pg_blocking_pids(w.pid)) WHERE w.application_name="+literals(waiter.name)+" AND b.application_name="+literals(leader.name)+" AND w.wait_event_type='Lock');")
    if(waiting==="t")return
  }
  assert.fail("expected server-observed gate contention")
}
const importStatement=snapshot=>"SELECT ppo_authority.import_synthetic_snapshot("+[
  snapshot.inventoryHash,JSON.stringify(snapshot.files.map(f=>({...f,normalizedBase64:Buffer.from(JSON.stringify(JSON.parse(Buffer.from(f.bytesBase64,"base64")))).toString("base64")})))
].map(literals).join(",")+");"
async function installImportAuthority(){
  for(const name of ["phase1gb2-canonical-postgres.sql","phase1gb2-synthetic-import.sql"])
    await sql(await readFile(new URL("./"+name,import.meta.url),"utf8"))
}
async function dropImportAuthority(){
  // Disposable database fixture teardown only; never a reset endpoint.
  await sql("DROP SCHEMA IF EXISTS ppo_authority CASCADE; DROP OWNED BY ppo_authority_owner; DROP ROLE IF EXISTS ppo_authority_importer,ppo_authority_reader,ppo_authority_writer,ppo_authority_owner,ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target,ppo_action_admin,ppo_action_verifier,ppo_action_consumer,ppo_resource_verifier,ppo_resource_consumer,ppo_admission_verifier;")
}
async function exactImported(snapshot,extra=[],querySql=sql){
  // Independent oracle: original bytea -> PostgreSQL JSONB, never through
  // JSON.parse/binary64, compared against the entire version/current sets.
  const native=JSON.parse(await querySql(`
    WITH archive AS (
      SELECT split_part(path,'/',2) AS run_id,split_part(split_part(path,'/',3),'.',1)::integer AS version,
             convert_from(bytes,'UTF8')::jsonb AS record
      FROM ppo_authority.synthetic_import_files WHERE inventory_hash=${literals(snapshot.inventoryHash)} AND path LIKE 'versions/%'
    ), extra AS (
      SELECT r->>'runId' AS run_id,(r->>'version')::integer AS version,r AS record
      FROM jsonb_array_elements(${literals(JSON.stringify(extra))}::jsonb) r
    ), expected AS (SELECT * FROM archive UNION ALL SELECT * FROM extra),
    differences AS (
      SELECT count(*) FILTER (WHERE v.run_id IS NULL) AS missing,
             count(*) FILTER (WHERE e.run_id IS NULL) AS unexpected,
             count(*) FILTER (WHERE e.run_id IS NOT NULL AND v.run_id IS NOT NULL AND e.record IS DISTINCT FROM v.record) AS different
      FROM expected e FULL JOIN ppo_authority.run_versions v USING(run_id,version)
    ), archive_current AS (
      SELECT substring(path from 9 for 43) AS run_id,convert_from(bytes,'UTF8')::jsonb AS record
      FROM ppo_authority.synthetic_import_files WHERE inventory_hash=${literals(snapshot.inventoryHash)} AND path LIKE 'records/%'
    ), archive_latest AS (SELECT DISTINCT ON(run_id) run_id,record FROM archive ORDER BY run_id,version DESC),
    expected_current AS (SELECT DISTINCT ON(run_id) run_id,record FROM expected ORDER BY run_id,version DESC)
    SELECT jsonb_build_object(
      'archiveVersions',(SELECT count(*) FROM archive),
      'archiveRuns',(SELECT count(*) FROM archive_current),
      'extraVersions',(SELECT count(*) FROM extra),
      'actualVersions',(SELECT count(*) FROM ppo_authority.run_versions),
      'missing',d.missing,'unexpected',d.unexpected,'different',d.different,
      'duplicateExpected',(SELECT count(*)-count(DISTINCT (run_id,version)) FROM expected),
      'versionGaps',(SELECT count(*) FROM (SELECT run_id FROM expected GROUP BY run_id HAVING min(version)<>0 OR max(version)+1<>count(*)) g),
      'invalidExtras',(SELECT count(*) FROM extra x WHERE EXISTS(SELECT 1 FROM archive a WHERE a.run_id=x.run_id AND a.version>=x.version)),
      'archiveCanonicalDifferences',(SELECT count(*) FROM archive_current c FULL JOIN archive_latest a USING(run_id) WHERE c.run_id IS NULL OR a.run_id IS NULL OR c.record IS DISTINCT FROM a.record),
      'canonicalDifferences',(SELECT count(*) FROM expected_current e FULL JOIN ppo_authority.current_runs c USING(run_id) WHERE e.run_id IS NULL OR c.run_id IS NULL OR e.record IS DISTINCT FROM c.record)
    ) FROM differences d;
  `))
  const archiveVersions=snapshot.files.filter(f=>f.path.startsWith("versions/")).length
  assert.deepEqual(native,{archiveVersions,archiveRuns:snapshot.runCount,extraVersions:extra.length,
    actualVersions:archiveVersions+extra.length,missing:0,unexpected:0,different:0,
    duplicateExpected:0,versionGaps:0,invalidExtras:0,archiveCanonicalDifferences:0,canonicalDifferences:0},"native archive parity")
  // Supplement native equality with independent JS readback and byte checks.
  const expected=snapshot.files.filter(f=>f.path.startsWith("versions/")).map(f=>JSON.parse(Buffer.from(f.bytesBase64,"base64"))).concat(extra)
  const actual=JSON.parse(await querySql("SELECT coalesce(jsonb_agg(record ORDER BY run_id,version),'[]') FROM ppo_authority.run_versions;"))
  const order=rows=>rows.sort((a,b)=>a.runId<b.runId?-1:a.runId>b.runId?1:a.version-b.version)
  assert.deepEqual(order(actual),order(expected))
  const importer=createSyntheticMigrationImporter({mode:"synthetic-migration-import-rehearsal-only",query:query("ppo_authority_importer")})
  const orderFiles=files=>[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  assert.deepEqual(orderFiles(await importer.readArchive(snapshot.inventoryHash)),orderFiles(snapshot.files))
}

test("isolated pinned mutual-TLS service boundaries",{timeout:120000},async t=>{
 await runPinnedServiceTransportCases(t,{sql,container,literals,installImportAuthority,dropImportAuthority})
})

test("D1 admission integrity reproduction",{timeout:180000},async t=>{
 await runAdmissionCases(t,{sql,installImportAuthority,dropImportAuthority,authority,query,session,blockedBy,literals,readFile,catalogSql:await readFile(new URL('./phase1gb2-canonical-catalog.sql',import.meta.url),'utf8')})
})

test("D1 integrated certified ownership action and resource regressions",{timeout:300000},async t=>{
 await runPostgresActionCases(t,{sql,session,blockedBy,literals,installImportAuthority,dropImportAuthority,container,admissionProfile:true})
})

test("isolated PostgreSQL transactional action fencing",{timeout:300000},async t=>{
  await runPostgresActionCases(t,{sql,session,blockedBy,literals,installImportAuthority,dropImportAuthority,container})
})

test("durable synthetic single-authority ownership and cutover rehearsal",{timeout:180000},async t=>{
  await runOwnershipRehearsalCases(t,{sql,session,blockedBy,literals,exactImported,installImportAuthority,dropImportAuthority,query,container})
})

test("legacy raw duplicate archive semantics and exact bytes survive canonical transport hardening",{timeout:30000},async()=>{
  const mode="synthetic-migration-import-rehearsal-only"
  const source=await captureSyntheticMigrationRehearsal({mode})
  const files=source.files.map(f=>({path:f.path,bytesBase64:Buffer.from(Buffer.from(f.bytesBase64,"base64").toString("utf8").replaceAll('"actor":','"actor":false,"actor":')).toString("base64")}))
  assert.ok(files.some((f,i)=>f.bytesBase64!==source.files[i].bytesBase64))
  const manifest=rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:files.map(f=>({relativePath:f.path,bytes:Buffer.from(f.bytesBase64,"base64")}))})
  assert.equal(manifest.readyForRehearsal,true)
  const snapshot={inventoryHash:manifest.inventoryHash,runCount:source.runCount,files}
  await installImportAuthority()
  try{
    await sql(await readFile(new URL("./phase1gb2-canonical-catalog.sql",import.meta.url),"utf8"))
    const importer=createSyntheticMigrationImporter({mode,query:query("ppo_authority_importer")})
    assert.equal((await importer.rehearse(snapshot)).rehearsalCommitted,true)
    await exactImported(snapshot)
    const catalog=createPostgresCanonicalCatalog({mode:"isolated-postgres-canonical-catalog",query:query("ppo_authority_reader")})
    assert.equal((await catalog.list()).ok,true)
    const raw=Buffer.from(files.find(f=>f.path.startsWith("records/")).bytesBase64,"base64").toString("utf8")
    // The raw archive is allowed to retain duplicate properties; the same
    // text cannot enter the fresh canonical writer transport ambiguously.
    const r=JSON.parse(raw)
    await assert.rejects(authority().commitRecord(raw,r.version-1,r.history.at(-1).previousHistoryHash),/Duplicate/)
    await exactImported(snapshot)
  }finally{await dropImportAuthority()}
})

test("F-05 coordinated mixed importer/writer races, rollback and stale snapshots",{timeout:180000},async()=>{
  const snapshot=await captureSyntheticMigrationRehearsal({mode:"synthetic-migration-import-rehearsal-only"})
  const writer=await fixture("kynexa") // same project as the imported active run
  const free=await fixture("rivora")
  const importedVersions=snapshot.files.filter(f=>f.path.startsWith("versions/")).length
  const revision=async()=>Number(await sql("SELECT revision FROM ppo_authority.gate;"))
  const noArchive=async()=>{
    assert.equal(await sql("SELECT count(*) FROM ppo_authority.synthetic_import_batch;"),"0")
    assert.equal(await sql("SELECT count(*) FROM ppo_authority.synthetic_import_files;"),"0")
  }
  // Writer first: import waits, then denies nonempty target. Writer rollback:
  // importer sees empty target and commits all bytes/versions instead.
  // Import first: conflicting writer waits and denies WIP; rollback admits it.
  for(const first of ["writer","importer"]){
    for(const rollback of [false,true]){
      await installImportAuthority()
      const a=session("f05-leader","ppo_authority_"+(first==="writer"?"writer":"importer"))
      const b=session("f05-waiter","ppo_authority_"+(first==="writer"?"importer":"writer"))
      try{
        await Promise.all([a.ready(),b.ready()])
        assert.equal(await a.send("BEGIN; "+(first==="writer"?commitSql(writer.initial):importStatement(snapshot))),"t")
        const waiting=b.send(first==="writer"?importStatement(snapshot):commitSql(writer.initial))
        waiting.catch(()=>{})
        await blockedBy(b,a)
        await a.send(rollback?"ROLLBACK;":"COMMIT;")
        assert.equal(await waiting,rollback?"t":"f")
        const imported=first==="writer"?rollback:!rollback
        if(imported){
          await exactImported(snapshot)
          assert.equal(await authority().readRun(writer.initial.runId),null)
          assert.equal(await revision(),importedVersions+1+(rollback?0:1))
          // One remaining lane admits a different project; a third project
          // and the already occupied project are both rejected.
          assert.equal(await commit(authority(),free.initial),true)
          const third=await fixture("khlim-assist")
          assert.equal(await commit(authority(),third.initial),false)
          assert.equal(await commit(authority(),writer.initial),false)
          await exactImported(snapshot,[free.initial])
        }else{
          await noArchive()
          assert.deepEqual(await authority().readVersions(writer.initial.runId),[writer.initial])
          assert.equal(await sql("SELECT count(*) FROM ppo_authority.run_versions;"),"1")
          assert.equal(await revision(),rollback?1:2)
        }
      }finally{await Promise.all([a.close(),b.close()]);await dropImportAuthority()}
    }
  }
  // Stale importer snapshot is established on an empty target before the
  // writer changes the gate. Even a rolled-back writer does not make a
  // snapshot stale; that positive control must import successfully.
  for(const isolation of ["REPEATABLE READ","SERIALIZABLE"]){
    for(const rollback of [false,true]){
      await installImportAuthority()
      const a=session("f05-stale","ppo_authority_importer")
      try{
        await a.ready()
        assert.equal(await a.send("BEGIN ISOLATION LEVEL "+isolation+"; SELECT ppo_authority.read_synthetic_archive("+literals(snapshot.inventoryHash)+") IS NULL;"),"t")
        assert.equal(await sql("BEGIN; "+commitSql(writer.initial)+(rollback?" ROLLBACK;":" COMMIT;"),"ppo_authority_writer"),"t")
        if(rollback){
          assert.equal(await a.send(importStatement(snapshot)),"t")
          await a.send("COMMIT;")
          await exactImported(snapshot)
          assert.equal(await revision(),importedVersions+1)
        }else{
          await assert.rejects(a.send(importStatement(snapshot)),/40001/)
          await noArchive()
          assert.equal(await sql("SELECT count(*) FROM ppo_authority.run_versions;"),"1")
          assert.deepEqual(await authority().readVersions(writer.initial.runId),[writer.initial])
          assert.equal(await revision(),1)
        }
      }finally{await a.close();await dropImportAuthority()}
    }
  }
  // Fail late after archive staging/history replay while a writer is waiting.
  // ON_ERROR_STOP disconnects the failed transaction, rolling everything back.
  await installImportAuthority()
  await sql(`CREATE FUNCTION ppo_authority.ci_import_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $body$ BEGIN PERFORM pg_advisory_xact_lock(158001); RETURN NEW; END $body$;
    CREATE TRIGGER ci_import_barrier AFTER INSERT ON ppo_authority.synthetic_import_batch FOR EACH ROW EXECUTE FUNCTION ppo_authority.ci_import_barrier();`)
  const a=session("f05-failed-import","ppo_authority_importer"),b=session("f05-surviving-writer","ppo_authority_writer"),barrier=session("f05-import-barrier","postgres")
  try{
    await Promise.all([a.ready(),b.ready(),barrier.ready()])
    await barrier.send("BEGIN; SELECT pg_advisory_xact_lock(158001);")
    const active=snapshot.files.find(f=>f.path.startsWith("records/")&&JSON.parse(Buffer.from(f.bytesBase64,"base64")).status==="implementation_in_progress")
    const id=JSON.parse(Buffer.from(active.bytesBase64,"base64")).runId
    const files=snapshot.files.filter(f=>f.path!=="versions/"+id+"/000001.json")
    const manifest=rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:files.map(f=>({relativePath:f.path,bytes:Buffer.from(f.bytesBase64,"base64")}))})
    // The test-only AFTER INSERT trigger pauses after import itself updates
    // the canonical gate. No artificial gate lock/update precedes import.
    const importing=a.send("BEGIN; "+importStatement({inventoryHash:manifest.inventoryHash,files}));importing.catch(()=>{})
    await blockedBy(a,barrier)
    const waiting=b.send(commitSql(writer.initial));waiting.catch(()=>{})
    await blockedBy(b,a)
    await barrier.send("COMMIT;")
    await assert.rejects(importing,/synthetic history import rejected/)
    assert.equal(await waiting,"t")
    await noArchive()
    assert.equal(await sql("SELECT count(*) FROM ppo_authority.run_versions;"),"1")
    assert.deepEqual(await authority().readVersions(writer.initial.runId),[writer.initial])
    assert.equal(await revision(),1)
  }finally{await Promise.all([a.close(),b.close(),barrier.close()]);await dropImportAuthority()}
})

test("synthetic capture and atomic PostgreSQL import preserve all original bytes and history",{timeout:90000},async()=>{
  await sql(await readFile(new URL("./phase1gb2-canonical-postgres.sql",import.meta.url),"utf8"))
  await sql(await readFile(new URL("./phase1gb2-synthetic-import.sql",import.meta.url),"utf8"))
  await sql(await readFile(new URL("./phase1gb2-canonical-catalog.sql",import.meta.url),"utf8"))
  console.log("PostgreSQL integration runtime:",await sql("SHOW server_version;"))
  const mode="synthetic-migration-import-rehearsal-only"
  const snapshot=await captureSyntheticMigrationRehearsal({mode})
  const importer=createSyntheticMigrationImporter({mode,query:query("ppo_authority_importer")})
  const read=authority("ppo_authority_reader")
  const wire=files=>files.map(file=>({...file,normalizedBase64:Buffer.from(JSON.stringify(JSON.parse(Buffer.from(file.bytesBase64,"base64")))).toString("base64")}))
  const importSql=(hash,files)=>"SELECT ppo_authority.import_synthetic_snapshot("+[hash,JSON.stringify(wire(files))].map(literals).join(",")+");"
  const counts=()=>sql("SELECT (SELECT count(*) FROM ppo_authority.run_versions)||','||(SELECT count(*) FROM ppo_authority.synthetic_import_batch)||','||(SELECT count(*) FROM ppo_authority.synthetic_import_files)||','||(SELECT revision FROM ppo_authority.gate);")
  const empty=await counts()
  assert.equal(empty,"0,0,0,0")
  assert.equal(snapshot.runCount,3)
  assert.equal(await importer.readArchive(snapshot.inventoryHash),null)
  // Identical valid source bytes, independent Node processes with genuinely
  // different default collation. The same digest must be accepted by SQL.
  const moduleURL=new URL("../../local-operator/development-migration-preflight.mjs",import.meta.url).href
  const localeProbe=`
    import {readFileSync} from "node:fs";
    import {rehearseSyntheticMigrationPreflight as scan} from ${JSON.stringify(moduleURL)};
    const files=JSON.parse(readFileSync(0,"utf8"));
    const result=scan({mode:"synthetic-migration-preflight-only",entries:files.map(f=>({relativePath:f.path,bytes:Buffer.from(f.bytesBase64,"base64")}))});
    console.log(JSON.stringify({numeric:new Intl.Collator().resolvedOptions().numeric,hash:result.inventoryHash,ready:result.readyForRehearsal}));
  `
  for(const [locale,numeric] of [["en_US.UTF-8",false],["en-u-kn-true",true]]){
    const child=spawnSync(process.execPath,["--input-type=module","-e",localeProbe],{input:JSON.stringify(snapshot.files),encoding:"utf8",env:{...process.env,LANG:locale,LC_ALL:locale,LC_COLLATE:locale},timeout:10000})
    assert.equal(child.status,0,child.stderr)
    assert.deepEqual(JSON.parse(child.stdout),{numeric,hash:snapshot.inventoryHash,ready:true})
  }

  // Failure after archive insertion and some history appends: remove the
  // final active run's version 1 marker, recompute the *actual* manifest.
  // The database must roll back the complete batch, not just the bad run.
  const activeFile=snapshot.files.find(f=>f.path.startsWith("records/")&&JSON.parse(Buffer.from(f.bytesBase64,"base64")).status==="implementation_in_progress")
  const active=JSON.parse(Buffer.from(activeFile.bytesBase64,"base64"))
  // Preserve the JS-parsed values and every original history hash, while
  // changing exact decimal tokens in the active run's source and markers.
  for(const [from,to] of [["1e+308","1.00000000000000001e308"],
    ["9007199254740992","9007199254740993"],['"zero":0','"zero":1e-100000']]){
    let changed=0
    const files=snapshot.files.map(file=>{
      if(file.path!==activeFile.path&&!file.path.startsWith("versions/"+active.runId+"/"))return file
      const raw=Buffer.from(file.bytesBase64,"base64").toString("utf8")
      const altered=raw.replaceAll(from,to)
      if(altered!==raw)changed++
      assert.deepEqual(JSON.parse(altered),JSON.parse(raw))
      return {...file,bytesBase64:Buffer.from(altered).toString("base64")}
    })
    assert.ok(changed>=2)
    const manifest=rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:files.map(f=>({relativePath:f.path,bytes:Buffer.from(f.bytesBase64,"base64")}))})
    assert.equal(manifest.readyForRehearsal,true)
    assert.notEqual(manifest.inventoryHash,snapshot.inventoryHash)
    let calls=0,dbError
    const checked=createSyntheticMigrationImporter({mode,query:async(statement,args)=>{
      calls++
      try{return await query("ppo_authority_importer")(statement,args)}
      catch(error){dbError=error;throw error}
    }})
    await assert.rejects(checked.rehearse({...snapshot,files,inventoryHash:manifest.inventoryHash}),error=>error.code==="MIGRATION_COMMIT_UNKNOWN")
    assert.equal(calls,1)
    assert.match(dbError?.message||"",/normalized numeric or value parity mismatch|numeric field overflow|value overflows numeric format/)
    assert.equal(await counts(),empty)
    assert.equal(await importer.readArchive(manifest.inventoryHash),null)
  }
  const incomplete=snapshot.files.filter(f=>f.path!=="versions/"+active.runId+"/000001.json")
  const invalid=rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:incomplete.map(f=>({relativePath:f.path,bytes:Buffer.from(f.bytesBase64,"base64")}))})
  assert.equal(invalid.readyForRehearsal,false)
  await assert.rejects(sql(importSql(invalid.inventoryHash,incomplete),"ppo_authority_importer"),/synthetic history import rejected/)
  assert.equal(await counts(),empty)
  assert.equal(await importer.readArchive(invalid.inventoryHash),null)
  // Tampered digest fails even if the file contents are otherwise valid.
  await assert.rejects(sql(importSql("f".repeat(64),snapshot.files),"ppo_authority_importer"),/digest mismatch/)
  assert.equal(await counts(),empty)
  await assert.rejects(importer.rehearse({...snapshot,inventoryHash:"f".repeat(64)}))
  assert.equal(await counts(),empty)
  // Successful SQL function return inside a rolled back transaction is
  // deliberately NOT treated as an acknowledged import.
  assert.equal(await sql("BEGIN; "+importSql(snapshot.inventoryHash,snapshot.files)+" ROLLBACK;","ppo_authority_importer"),"t")
  assert.equal(await counts(),empty)
  // Ordinary writer, reader and importer roles must remain distinct.
  for(const role of ["ppo_authority_writer","ppo_authority_reader"]){
    await assert.rejects(sql(importSql(snapshot.inventoryHash,snapshot.files),role),/permission denied/)
    await assert.rejects(sql("SELECT ppo_authority.read_synthetic_archive("+literals(snapshot.inventoryHash)+");",role),/permission denied/)
  }
  await assert.rejects(sql("SELECT * FROM ppo_authority.synthetic_import_files;","ppo_authority_importer"),/permission denied/)
  await assert.rejects(sql("UPDATE ppo_authority.gate SET revision=0;","ppo_authority_importer"),/permission denied/)
  await assert.rejects(sql("SELECT ppo_authority.commit_run(NULL,NULL,NULL,NULL);","ppo_authority_importer"),/permission denied/)

  // Two independent clients race for the empty target. Inject loss of the
  // winning acknowledgement AFTER the psql autocommit has actually completed.
  let attempts=0,commits=0
  const loseAck=()=>createSyntheticMigrationImporter({mode,query:async(statement,args)=>{
    attempts++
    const result=await query("ppo_authority_importer")(statement,args)
    if(result.rows[0].accepted===true){commits++;throw Error("synthetic lost committed import response")}
    return result
  }})
  const results=await Promise.allSettled([loseAck().rehearse(snapshot),loseAck().rehearse(snapshot)])
  assert.equal(attempts,2)
  assert.equal(commits,1)
  assert.equal(results.filter(r=>r.status==="rejected"&&r.reason.code==="MIGRATION_COMMIT_UNKNOWN"&&r.reason.inventoryHash===snapshot.inventoryHash).length,1)
  assert.equal(results.filter(r=>r.status==="rejected"&&r.reason.message==="Synthetic migration rehearsal rejected.").length,1)
  assert.deepEqual((await counts()).split(",").slice(0,3),["17","1","20"])
  const archive=await importer.readArchive(snapshot.inventoryHash)
  const sorted=files=>[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  assert.deepEqual(sorted(archive),sorted(snapshot.files))
  const rechecked=rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:archive.map(f=>({relativePath:f.path,bytes:Buffer.from(f.bytesBase64,"base64")}))})
  assert.equal(rechecked.inventoryHash,snapshot.inventoryHash)
  assert.equal(rechecked.readyForRehearsal,true)
  for(const file of archive.filter(f=>f.path.startsWith("records/"))){
    const record=JSON.parse(Buffer.from(file.bytesBase64,"base64"))
    const expected=sorted(archive.filter(f=>f.path.startsWith("versions/"+record.runId+"/"))).map(f=>JSON.parse(Buffer.from(f.bytesBase64,"base64")))
    assert.deepEqual(await read.readVersions(record.runId),expected)
    assert.deepEqual(await read.readRun(record.runId),record)
  }
  // Independent catalog operation must validate complete archive histories and
  // expose the same legacy summaries without reading any filesystem store.
  const catalog=createPostgresCanonicalCatalog({mode:"isolated-postgres-canonical-catalog",query:query("ppo_authority_reader")})
  const listed=await catalog.list()
  assert.equal(listed.ok,true)
  assert.equal(listed.summaries.length,3)
  for(const file of archive.filter(f=>f.path.startsWith("records/"))){
    const record=JSON.parse(Buffer.from(file.bytesBase64,"base64"))
    const inspected=await catalog.inspect(record.runId,{expectedRevision:listed.revision})
    assert.equal(inspected.ok,true)
    assert.deepEqual(inspected.record,record)
    assert.deepEqual(inspected.versions,await read.readVersions(record.runId))
  }
  await assert.rejects(sql("SELECT ppo_authority.read_catalog_snapshot();","ppo_authority_importer"),/permission denied/)
  // M-01: a correctly rounded JS readback cannot expose this native decimal
  // corruption. The exact oracle must reject it inside this rollback-only
  // independent session, while the source archive remains untouched.
  const corrupt=session("oracle-decimal-corruption","postgres")
  try{
    await corrupt.ready()
    await corrupt.send("BEGIN; ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; UPDATE ppo_authority.run_versions SET record=replace(record::text,'9007199254740992','9007199254740993')::jsonb WHERE version>=4;")
    await assert.rejects(exactImported(snapshot,[],statement=>corrupt.send(statement)),/native archive parity/)
    await corrupt.send("ROLLBACK;")
    await corrupt.send("BEGIN; ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; DELETE FROM ppo_authority.run_versions WHERE run_id="+literals(active.runId)+" AND version=1;")
    await assert.rejects(exactImported(snapshot,[],statement=>corrupt.send(statement)),/native archive parity/)
    await corrupt.send("ROLLBACK;")
    await corrupt.send("BEGIN; INSERT INTO ppo_authority.run_versions SELECT repeat('Z',43),version,history_hash,jsonb_set(record,'{runId}',to_jsonb(repeat('Z',43))) FROM ppo_authority.run_versions WHERE version=0 LIMIT 1;")
    await assert.rejects(exactImported(snapshot,[],statement=>corrupt.send(statement)),/native archive parity/)
    await corrupt.send("ROLLBACK;")
  }finally{await corrupt.close()}
  await exactImported(snapshot)
  const after=await counts()
  await assert.rejects(importer.rehearse(snapshot))
  // Rejected import can advance the internal gate revision only.
  assert.deepEqual((await counts()).split(",").slice(0,3),after.split(",").slice(0,3))
  assert.deepEqual(sorted(await importer.readArchive(snapshot.inventoryHash)),sorted(snapshot.files))
  for(const table of ["synthetic_import_batch","synthetic_import_files"]){
    await assert.rejects(sql("DELETE FROM ppo_authority."+table+";"),/append-only/)
    await assert.rejects(sql("UPDATE ppo_authority."+table+" SET inventory_hash=inventory_hash;"),/append-only/)
  }
  await assert.rejects(sql("TRUNCATE ppo_authority.synthetic_import_files;"),/append-only/)
  await assert.rejects(sql("TRUNCATE ppo_authority.synthetic_import_batch,ppo_authority.synthetic_import_files;"),/append-only/)
  // Subsequent direct writers may append to the imported authority but the
  // preserved source archive must never change with those mutations.
  const state=createIsolatedCanonicalRunState({mode:"isolated-postgres-canonical-authority",authority:authority()})
  const held=session("catalog-held-snapshot","ppo_authority_reader")
  const barrier=session("catalog-snapshot-barrier","ppo_authority_writer")
  try{
    await Promise.all([held.ready(),barrier.ready()])
    await barrier.send("BEGIN; SELECT pg_advisory_xact_lock(157003);")
    const before=await query("ppo_authority_reader")("SELECT ppo_authority.read_catalog_snapshot() AS snapshot",[])
    // This READ COMMITTED statement establishes its snapshot, then waits at
    // the advisory barrier BEFORE executing the catalog function. A VOLATILE
    // replacement would see the subsequently committed writer and fail parity.
    const pending=held.send("WITH barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(157003)) SELECT ppo_authority.read_catalog_snapshot() FROM barrier;")
    pending.catch(()=>{})
    await blockedBy(held,barrier)
    await state.transition(active.runId,{expectedVersion:active.version,status:"cancelled",actor:"synthetic-import"})
    await barrier.send("COMMIT;")
    const oldSnapshot=JSON.parse(await pending)
    assert.deepEqual(oldSnapshot,before.rows[0].snapshot)
    const current=await catalog.list()
    assert.notEqual(current.revision,oldSnapshot.revision)
    const stale=createPostgresCanonicalCatalog({mode:"isolated-postgres-canonical-catalog",query:async()=>({rows:[{snapshot:oldSnapshot}]})})
    assert.equal((await stale.list({expectedRevision:current.revision})).code,"stale_observation")
    assert.equal((await stale.inspect(active.runId)).record.status,"implementation_in_progress")
    assert.equal((await catalog.inspect(active.runId)).record.status,"cancelled")
  }finally{await Promise.all([held.close(),barrier.close()])}
  assert.deepEqual(sorted(await importer.readArchive(snapshot.inventoryHash)),sorted(snapshot.files))
  assert.equal((await read.readVersions(active.runId)).length,active.version+2)
  assert.equal((await catalog.list({expectedRevision:listed.revision})).code,"stale_observation")
  const updated=await catalog.inspect(active.runId)
  assert.equal(updated.record.status,"cancelled")
  assert.deepEqual(updated.versions,await read.readVersions(active.runId))
  // Privileged corruption exists only in rollback-only test transactions.
  // Fixed ordinary reader function must surface invalid data through the
  // trusted validator, and server bounds must stop before aggregating it.
  async function injectedRead(mutation){
    const bound="SELECT row_to_json(q) FROM (SELECT ppo_authority.read_catalog_snapshot() AS snapshot) q;"
    return createPostgresCanonicalCatalog({mode:"isolated-postgres-canonical-catalog",query:async()=>({rows:[JSON.parse(await sql("BEGIN; "+mutation+" SET LOCAL ROLE ppo_authority_reader; "+bound+" ROLLBACK;"))]})}).list()
  }
  assert.equal((await injectedRead("ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; UPDATE ppo_authority.run_versions SET record=jsonb_set(record,'{history,0,actor}','\"corrupt\"') WHERE version=0;")).code,"catalog_invalid")
  assert.equal((await injectedRead("ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; UPDATE ppo_authority.run_versions SET record=replace(record::text,'9007199254740992','9007199254740993')::jsonb WHERE version>=4;")).code,"catalog_invalid")
  assert.equal((await injectedRead("INSERT INTO ppo_authority.run_versions SELECT lpad(i::text,43,'A'),0,history_hash,jsonb_set(record,'{runId}',to_jsonb(lpad(i::text,43,'A'))) FROM generate_series(1,101) i CROSS JOIN (SELECT * FROM ppo_authority.run_versions WHERE version=0 LIMIT 1) v;")).code,"catalog_truncated")
  assert.equal((await injectedRead("ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; UPDATE ppo_authority.run_versions SET record=record||jsonb_build_object('oversize',repeat('x',33*1024*1024)) WHERE run_id="+literals(active.runId)+" AND version=0;")).code,"catalog_truncated")
  await assert.rejects(exactImported(snapshot),/native archive parity/) // unaccounted post-import version
  const extras=(await read.readVersions(active.runId)).slice(active.version+1)
  await exactImported(snapshot,extras)
  await assert.rejects(exactImported(snapshot,[...extras,...extras]),/native archive parity/)
})

test("real PostgreSQL canonical authority: CAS, history, roles and serialized WIP",{timeout:90000},async()=>{
  const writer=authority(),reader=authority("ppo_authority_reader")
  const a=await fixture("rivora")
  assert.equal(await reader.readRun(a.initial.runId),null)
  const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}":JSON.stringify(value)
  function contradict(record,key,value){
    const altered=structuredClone(record),event=altered.history.at(-1)
    event[key]=value
    delete event.eventHash
    event.eventHash=createHash("sha256").update(stable(event)).digest("hex")
    altered.historyHash=event.eventHash
    return altered
  }
  for(const [key,value] of [["project","kynexa"],["repo","another/repo"]]){
    const wrong=contradict(a.initial,key,value)
    await assert.rejects(commit(writer,wrong))
    assert.equal(await sql(commitSql(wrong),"ppo_authority_writer"),"f")
    assert.equal(await reader.readRun(a.initial.runId),null)
  }
  const createSql="SELECT ppo_authority.commit_run("+[a.initial.runId,-1,null,JSON.stringify(a.initial)].map(literals).join(",") + "::text);"
  assert.equal(await sql("BEGIN; "+createSql+" ROLLBACK;","ppo_authority_writer"),"t")
  assert.equal(await reader.readRun(a.initial.runId),null)
  assert.deepEqual(await reader.readVersions(a.initial.runId),[])
  assert.equal(await commit(writer,a.initial),true)
  assert.equal(await commit(writer,a.initial),false)
  const duplicateFree=await fixture("rivora")
  assert.equal(await commit(writer,duplicateFree.initial),false)
  assert.equal(await reader.readRun(duplicateFree.initial.runId),null)
  await assert.rejects(writer.commitRecord(JSON.stringify(duplicateFree.initial)+" ".repeat(131072),-1,null))
  const oversizedSql="SELECT ppo_authority.commit_run("+[duplicateFree.initial.runId,-1,null,JSON.stringify(duplicateFree.initial)+" ".repeat(131072)].map(literals).join(",")+");"
  assert.equal(await sql(oversizedSql,"ppo_authority_writer"),"f")
  const unsupported=await fixture("kynexa","RIC-157 shared authority synthetic: lone surrogate \ud800")
  await assert.rejects(commit(writer,unsupported.initial))
  assert.equal(await reader.readRun(unsupported.initial.runId),null)
  const outcomes=await Promise.all([commit(writer,a.first,a.initial),commit(authority(),a.first,a.initial)])
  assert.deepEqual(outcomes.sort(),[false,true])
  assert.equal(await writer.commitRecord(JSON.stringify(a.planned),1,"f".repeat(64)),false)
  const fork=structuredClone(a.planned)
  fork.history[0].actor="rewritten"
  // Direct trusted SQL writer bypasses the JS validator here intentionally:
  // the DB must still refuse a rewrite of an existing history prefix.
  const forkResult=await query("ppo_authority_writer")(
    "SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::text) AS accepted",
    [a.initial.runId,1,a.first.historyHash,JSON.stringify(fork)])
  assert.equal(forkResult.rows[0].accepted,false)
  assert.deepEqual(await reader.readVersions(a.initial.runId),[a.initial,a.first])
  assert.equal(await commit(writer,a.planned,a.first),true)
  assert.equal(await commit(writer,a.implementing,a.planned),true)
  const wrongHead={...a.progress,headSha:"c".repeat(40)}
  await assert.rejects(commit(writer,wrongHead,a.implementing))
  for(const [key,value] of [["project","kynexa"],["repo","another/repo"]]){
    await assert.rejects(commit(writer,contradict(a.progress,key,value),a.implementing))
    assert.deepEqual(await reader.readRun(a.initial.runId),a.implementing)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(a.progress))<131072)
  assert.equal(await commit(writer,a.progress,a.implementing),true)
  const physical=Number(await sql("SELECT octet_length(record::text) FROM ppo_authority.current_runs WHERE run_id="+literals(a.initial.runId)+";"))
  assert.ok(physical>131072,"exercise actual JSONB numeric expansion")
  assert.equal(await commit(writer,a.first,a.initial),false)
  assert.deepEqual(await reader.readVersions(a.initial.runId),[a.initial,a.first,a.planned,a.implementing,a.progress])
  assert.deepEqual(await reader.readRun(a.initial.runId),a.progress)

  // The restricted role cannot mutate, erase, or directly read the tables.
  for(const statement of [
    "DELETE FROM ppo_authority.run_versions;",
    "UPDATE ppo_authority.run_versions SET history_hash='x';",
    "TRUNCATE ppo_authority.run_versions;",
    "INSERT INTO ppo_authority.run_versions SELECT * FROM ppo_authority.run_versions;",
    "SELECT * FROM ppo_authority.run_versions;",
    "UPDATE ppo_authority.gate SET revision=0;"
  ])await assert.rejects(sql(statement,"ppo_authority_writer"),/permission denied/)
  await assert.rejects(commit(reader,a.cancelled,a.progress),/permission denied/)
  for(const statement of ["DELETE FROM ppo_authority.run_versions;","UPDATE ppo_authority.run_versions SET history_hash=history_hash;","TRUNCATE ppo_authority.run_versions;"])
    await assert.rejects(sql(statement,"postgres"),/append-only/)
  await assert.rejects(sql("SELECT * FROM ppo_authority.run_versions;","ppo_authority_reader"),/permission denied/)
  await assert.rejects(sql("CREATE TABLE ppo_authority.fake(id int);","ppo_authority_writer"),/permission denied/)
  await sql("CREATE ROLE ppo_untrusted_ci NOLOGIN; GRANT USAGE ON SCHEMA ppo_authority TO ppo_untrusted_ci;")
  await assert.rejects(sql("SELECT ppo_authority.read_catalog_snapshot();","ppo_untrusted_ci"),/permission denied/)
  await assert.rejects(sql("SELECT ppo_authority.read_run("+literals(a.initial.runId)+");","ppo_untrusted_ci"),/permission denied/)
  await assert.rejects(sql(commitSql(a.cancelled,a.progress),"ppo_untrusted_ci"),/permission denied/)
  assert.equal(await sql("CREATE TEMP TABLE current_runs(run_id text,record jsonb); CREATE TEMP TABLE gate(singleton boolean,revision bigint); SELECT ppo_authority.read_run("+literals(a.initial.runId)+")->>'runId';","ppo_authority_writer"),a.initial.runId)

  // Two different newly active projects contend for the last lane.
  const b=await fixture("kynexa"),c=await fixture("khlim-assist")
  const admitted=await Promise.all([commit(writer,b.initial),commit(authority(),c.initial)])
  assert.deepEqual([...admitted].sort(),[false,true])
  const winner=admitted[0]?b:c,loser=admitted[0]?c:b
  assert.equal(await reader.readRun(loser.initial.runId),null)
  const duplicate=await fixture(winner.initial.project.id)
  assert.equal(await commit(writer,duplicate.initial),false)
  assert.equal(await commit(writer,winner.first,winner.initial),true)
  assert.equal(await commit(writer,winner.planned,winner.first),true)
  assert.equal(await commit(writer,winner.implementing,winner.planned),true)
  assert.equal(await commit(writer,winner.progress,winner.implementing),true)
  assert.equal(await commit(writer,winner.cancelled,winner.progress),true)
  assert.equal(await commit(writer,loser.initial),true)
  assert.equal(await commit(writer,a.cancelled,a.progress),true)
  assert.deepEqual(await reader.readVersions(a.initial.runId),[a.initial,a.first,a.planned,a.implementing,a.progress,a.cancelled])
  // New sessions observe durable latest state. No retry after unknown commit.
  assert.deepEqual(await authority("ppo_authority_reader").readRun(a.initial.runId),a.cancelled)

  // Distinct competing valid versions: same previous event, alternative actor.
  // READ COMMITTED sees the new state; higher isolation must abort stale B.
  for(const isolation of ["READ COMMITTED","REPEATABLE READ","SERIALIZABLE"]){
    const r=await fixture("rivora")
    assert.equal(await commit(writer,r.initial),true)
    const alternative=contradict(r.first,"actor","alternative-agent")
    await staleSnapshot(isolation,r.initial,alternative,async()=>{
      assert.equal(await commit(writer,r.first,r.initial),true)
    })
    assert.deepEqual(await reader.readVersions(r.initial.runId),[r.initial,r.first])
    for(const [next,prior] of [[r.planned,r.first],[r.implementing,r.planned],[r.progress,r.implementing],[r.cancelled,r.progress]])
      assert.equal(await commit(writer,next,prior),true)
  }

  // The loser from the earlier creation race still occupies one lane.
  // Rehearse two independently released projects competing to re-enter
  // the final lane; the second transaction has an explicit prior snapshot.
  const releasedA=await releasedFixture("rivora"),releasedB=await releasedFixture("portfolio")
  for(const r of [releasedA,releasedB]){
    for(let i=0;i<r.history.length;i++)assert.equal(await commit(writer,r.history[i],r.history[i-1]||null),true)
    assert.deepEqual(await reader.readRun(r.released.runId),r.released)
  }
  await staleSnapshot("READ COMMITTED",releasedB.released,releasedB.reactivated,async()=>{
    assert.equal(await commit(writer,releasedA.reactivated,releasedA.released),true)
  })
  assert.deepEqual(await reader.readRun(releasedA.released.runId),releasedA.reactivated)
  assert.deepEqual(await reader.readRun(releasedB.released.runId),releasedB.released)
  // Release the synthetic lanes for the direct state-machine integration.
  const direct=createIsolatedCanonicalRunState({mode:"isolated-postgres-canonical-authority",authority:writer})
  await direct.transition(releasedA.reactivated.runId,{expectedVersion:releasedA.reactivated.version,status:"cancelled",actor:"test-agent"})
  await direct.transition(loser.initial.runId,{expectedVersion:0,status:"cancelled",actor:"test-agent"})
})


const MODE="isolated-postgres-canonical-authority"
const SHA="b".repeat(40)
const initialInput=(projectId="rivora",task="RIC-157 shared authority synthetic: direct state machine")=>({
  projectId,task,baseSha:"a".repeat(40),headSha:SHA,branch:"feature/direct-authority",actor:"test-agent"
})
function tick(){
  let time=Date.parse("2026-02-01T00:00:00.000Z")
  return ()=>new Date(time+=1000)
}
function isolated(storage=authority(), options={}){
  return createIsolatedCanonicalRunState({mode:MODE,authority:storage,...options})
}
const errorCode=code=>error=>error?.code===code

test("direct PostgreSQL state machine matches filesystem history and guarded review recovery",{timeout:90000},async()=>{
  // Two separate disposable authorities with the SAME synthetic deterministic
  // input form an oracle comparison only; no mirroring or production dual write.
  const scratch=await mkdtemp(join(tmpdir(),"ppo-writer-parity-"))
  const marker=await mkdtemp(join(tmpdir(),"ppo-no-file-fallback-"))
  const oldRoot=process.env.PPO_WRITE_DATA_DIR
  process.env.PPO_WRITE_DATA_DIR=marker
  try{
    const fileOptions={writeDataDir:scratch,now:tick(),randomBytesImpl:n=>Buffer.alloc(n,71)}
    const db=authority(),state=isolated(db,{now:tick(),randomBytesImpl:n=>Buffer.alloc(n,71)})
    const file={
      create:input=>createDevelopmentRun(input,fileOptions),
      read:id=>Promise.reject(new Error("not needed")),
      transition:(id,input)=>transitionDevelopmentRun(id,input,fileOptions),
      progress:(id,input)=>recordDevelopmentRunProgress(id,input,fileOptions),
      recoverReviewOrphan:(id,input)=>recoverDevelopmentRunReviewOrphanState(id,input,fileOptions),
      recoverReviewRuntimeFailure:(id,input)=>recoverDevelopmentRunReviewRuntimeFailureState(id,input,fileOptions)
    }
    let actual=await state.create(initialInput()),expected=await file.create(initialInput())
    const versions=[expected]
    assert.deepEqual(actual,expected)
    // Every transition and progress event must have byte-equivalent JSON values
    // and the same history hash under a fixed clock/ID, not just same status.
    const both=async(method,input)=>{
      actual=await state[method](actual.runId,input)
      expected=await file[method](expected.runId,input)
      assert.deepEqual(actual,expected)
      assert.deepEqual(await state.read(actual.runId),expected)
      versions.push(expected)
    }
    const transition=async(status,evidence=[])=>both("transition",{
      expectedVersion:actual.version,status,actor:"test-agent",evidence
    })
    for(const status of ["planning_in_progress","planned","implementation_in_progress"])await transition(status)
    await both("progress",{expectedVersion:actual.version,status:actual.status,actor:"test-agent",
      reason:"synthetic progress",incrementAttempt:true,headSha:SHA})
    for(const status of ["implementation_ready","tests_in_progress","tests_passed"])await transition(status)
    await transition("review_in_progress",[{kind:"review",sha:SHA,source:"phase-6f-independent-review-agent",
      summary:"Synthetic review started",metadata:{project:actual.project.id,reviewedSha:SHA,attempt:1,outcome:"review_started"}}])
    const orphan={expectedVersion:actual.version,expectedHeadSha:SHA,reviewAttempt:1,confirmation:REVIEW_ORPHAN_RECOVERY_CONFIRMATION}
    // Rejected recovery must leave the exact version/history unchanged. The
    // confirmation check happens before clock consumption in both paths.
    await assert.rejects(state.recoverReviewOrphan(actual.runId,{...orphan,confirmation:"wrong"}),errorCode("REVIEW_ORPHAN_RECOVERY_CONFIRMATION_REQUIRED"))
    assert.deepEqual(await state.read(actual.runId),expected)
    await both("recoverReviewOrphan",orphan)
    assert.equal(actual.status,"tests_passed")
    await transition("review_in_progress",[{kind:"review",sha:SHA,source:"phase-6f-independent-review-agent",
      summary:"Synthetic review retry",metadata:{project:actual.project.id,reviewedSha:SHA,attempt:2,outcome:"review_started"}}])
    await transition("review_changes_requested",[{kind:"review",sha:SHA,source:"phase-6f-independent-review-agent",
      summary:"Synthetic reviewer runtime failure",metadata:{project:actual.project.id,reviewedSha:SHA,attempt:2,
        outcome:"owner_action_required",decision:"OWNER_ACTION_REQUIRED",mergeAllowed:false,blockers:0,securityFindings:0,
        testsRequired:0,runtimeFailureClass:"runtime"}}])
    const runtime={expectedVersion:actual.version,expectedHeadSha:SHA,reviewAttempt:2,confirmation:REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION}
    await assert.rejects(state.recoverReviewRuntimeFailure(actual.runId,{...runtime,expectedHeadSha:"c".repeat(40)}),errorCode("REVIEW_RUNTIME_RECOVERY_HEAD_MISMATCH"))
    assert.deepEqual(await state.read(actual.runId),expected)
    await both("recoverReviewRuntimeFailure",runtime)
    await transition("cancelled")
    assert.deepEqual(await db.readVersions(actual.runId),versions)
    assert.deepEqual(await readdir(marker),[])
  }finally{
    if(oldRoot===undefined)delete process.env.PPO_WRITE_DATA_DIR
    else process.env.PPO_WRITE_DATA_DIR=oldRoot
    await rm(scratch,{recursive:true,force:true})
    await rm(marker,{recursive:true,force:true})
  }
})

test("direct writers use real CAS, deny invalid mutations and reconcile lost commit acknowledgments",{timeout:90000},async()=>{
  const db=authority(), state=isolated(db)
  const initial=await state.create(initialInput("rivora"))
  await assert.rejects(state.create(initialInput("rivora")),errorCode("AUTHORITY_COMMIT_REJECTED"))
  await assert.rejects(state.create(initialInput("kynexa","not synthetic")),errorCode("AUTHORITY_SCOPE_DENIED"))
  await assert.rejects(state.transition(initial.runId,{expectedVersion:0,status:"merged",actor:"test-agent"}),errorCode("INVALID_RUN_TRANSITION"))
  await assert.rejects(state.transition(initial.runId,{expectedVersion:9,status:"planning_in_progress",actor:"test-agent"}),errorCode("STALE_RUN_VERSION"))
  assert.deepEqual(await db.readVersions(initial.runId),[initial])
  // Both independent state machines observe the same version BEFORE either
  // can submit its different candidate. PostgreSQL decides the CAS winner.
  let reads=0,release
  const barrier=new Promise(resolve=>{release=resolve})
  function competing(){
    const connection=authority()
    return isolated({commitRecord:connection.commitRecord,async readRun(id){
      const r=await connection.readRun(id)
      if(++reads===2)release()
      await barrier
      return r
    }})
  }
  const contenders=await Promise.allSettled(["writer-a","writer-b"].map(actor=>competing().transition(initial.runId,{
    expectedVersion:0,status:"planning_in_progress",actor
  })))
  assert.equal(contenders.filter(r=>r.status==="fulfilled").length,1)
  const winner=contenders.find(r=>r.status==="fulfilled").value
  assert.equal(contenders.find(r=>r.status==="rejected").reason.code,"AUTHORITY_COMMIT_REJECTED")
  assert.deepEqual(await db.readVersions(initial.runId),[initial,winner])
  // Simulate a lost acknowledgement only AFTER actual committed append.
  let writes=0
  const uncertain=isolated({readRun:db.readRun,async commitRecord(...args){
    writes++
    assert.equal(await db.commitRecord(...args),true)
    throw Error("synthetic lost acknowledgment")
  }})
  let observation
  await assert.rejects(uncertain.transition(initial.runId,{expectedVersion:1,status:"planned",actor:"test-agent"}),error=>{
    observation=error.observation
    return error.code==="AUTHORITY_COMMIT_UNKNOWN"&&error.stateCommitted!==true
  })
  assert.equal(writes,1)
  const current=await state.read(initial.runId)
  assert.deepEqual(observation,{runId:current.runId,version:current.version,historyHash:current.historyHash})
  assert.equal(current.status,"planned")
  assert.equal((await db.readVersions(initial.runId)).length,3)
  await assert.rejects(state.transition(initial.runId,{expectedVersion:1,status:"planned",actor:"test-agent"}),errorCode("STALE_RUN_VERSION"))
  await state.transition(initial.runId,{expectedVersion:2,status:"cancelled",actor:"test-agent"})
  // Unknown initial creation still carries the exact generated run ID.
  let created
  await assert.rejects(uncertain.create(initialInput("kynexa")),error=>{
    created=error.observation
    return error.code==="AUTHORITY_COMMIT_UNKNOWN"
  })
  assert.equal(writes,2)
  const recovered=await state.read(created.runId)
  assert.equal(recovered.historyHash,created.historyHash)
  assert.equal(recovered.version,0)
  assert.equal((await db.readVersions(recovered.runId)).length,1)
  await state.transition(recovered.runId,{expectedVersion:0,status:"cancelled",actor:"test-agent"})
})


test("independent slower writer preserves nondecreasing event and evidence time",{timeout:90000},async()=>{
  const db=authority(), fast=isolated(db,{now:()=>new Date("2026-03-01T00:00:00.000Z")})
  const slow=isolated(authority(),{now:()=>new Date("2026-02-01T00:00:00.000Z")})
  let r=await fast.create(initialInput("rivora"))
  const time=r.timestamps.updatedAt
  const versions=[r]
  const check=next=>{
    assert.equal(next.timestamps.updatedAt,time)
    assert.equal(next.history.at(-1).timestamp,time)
    for(const e of next.history.at(-1).evidence)assert.equal(e.recordedAt,time)
    versions.push(next)
    r=next
  }
  const transition=async(status,evidence=[])=>check(await slow.transition(r.runId,{expectedVersion:r.version,status,actor:"slow-writer",evidence}))
  for(const status of ["planning_in_progress","planned","implementation_in_progress"])await transition(status)
  check(await slow.progress(r.runId,{expectedVersion:r.version,status:r.status,actor:"slow-writer",
    evidence:[{kind:"implementation",sha:SHA,source:"slow-writer",summary:"Earlier clock"}]}))
  for(const status of ["implementation_ready","tests_in_progress","tests_passed"])await transition(status)
  await transition("review_in_progress",[{kind:"review",sha:SHA,source:"phase-6f-independent-review-agent",
    summary:"Started",metadata:{project:r.project.id,reviewedSha:SHA,attempt:1,outcome:"review_started"}}])
  check(await slow.recoverReviewOrphan(r.runId,{expectedVersion:r.version,expectedHeadSha:SHA,reviewAttempt:1,confirmation:REVIEW_ORPHAN_RECOVERY_CONFIRMATION}))
  await transition("review_in_progress",[{kind:"review",sha:SHA,source:"phase-6f-independent-review-agent",
    summary:"Retry",metadata:{project:r.project.id,reviewedSha:SHA,attempt:2,outcome:"review_started"}}])
  await transition("review_changes_requested",[{kind:"review",sha:SHA,source:"phase-6f-independent-review-agent",
    summary:"Runtime failure",metadata:{project:r.project.id,reviewedSha:SHA,attempt:2,
      outcome:"owner_action_required",decision:"OWNER_ACTION_REQUIRED",mergeAllowed:false,blockers:0,securityFindings:0,
      testsRequired:0,runtimeFailureClass:"runtime"}}])
  check(await slow.recoverReviewRuntimeFailure(r.runId,{expectedVersion:r.version,expectedHeadSha:SHA,reviewAttempt:2,confirmation:REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION}))
  await transition("cancelled")
  assert.deepEqual(await db.readVersions(r.runId),versions)
})
