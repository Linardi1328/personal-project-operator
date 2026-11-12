import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
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

// Deliberately not a .test.mjs: the explicit CI step starts a fresh isolated
// PostgreSQL container. No environment DSN or host database is ever used.
const container=process.env.PPO_AUTHORITY_TEST_CONTAINER
if(process.env.CI!=="true"||!/^ppo-authority-ci-[0-9]+-[0-9]+$/u.test(container||"")){
  throw Error("Dedicated disposable CI authority container required")
}
function sql(input,role="postgres"){
  if(!["postgres","ppo_authority_writer","ppo_authority_reader","ppo_untrusted_ci"].includes(role))throw Error("invalid test role")
  return new Promise((resolve,reject)=>{
    const p=spawn("docker",["exec","-i",container,"psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","ppo_authority_ci"],{stdio:["pipe","pipe","pipe"]})
    let out="",err=""
    const timer=setTimeout(()=>p.kill("SIGKILL"),20000)
    p.stdout.on("data",x=>{out+=x})
    p.stderr.on("data",x=>{err+=x})
    p.on("error",error=>{clearTimeout(timer);reject(error)})
    p.on("close",code=>{
      clearTimeout(timer)
      if(code!==0)reject(Error("PostgreSQL CI statement failed: "+err.slice(0,1200)))
      else resolve(out.trim())
    })
    p.stdin.on("error",()=>{})
    p.stdin.end("SET statement_timeout='15s'; SET ROLE "+role+";\n"+input+"\n")
  })
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
  "SELECT ppo_authority.read_versions($1::text) AS records":"records"
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
  const p=spawn("docker",["exec","-i",container,"psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","ppo_authority_ci"],{stdio:["pipe","pipe","pipe"]})
  let out="",err="",ready=false
  const done=once(p,"close")
  // Attach a rejection handler immediately; failures before the marker must
  // not leave an unhandled process error or a lingering writer session.
  done.catch(()=>{})
  p.stderr.on("data",x=>{err+=x})
  p.stdin.on("error",()=>{})
  const marker=new Promise((resolve,reject)=>{
    p.stdout.on("data",x=>{out+=x;if(!ready&&out.includes("SNAPSHOT_READY")){ready=true;resolve()}})
    done.then(()=>{if(!ready)reject(Error("snapshot session exited early: "+err))},reject)
  })
  const timer=setTimeout(()=>p.kill("SIGKILL"),20000)
  try{
    p.stdin.write("SET statement_timeout='15s'; SET idle_in_transaction_session_timeout='15s'; SET ROLE ppo_authority_writer;\n"+
      "\\set VERBOSITY verbose\nBEGIN ISOLATION LEVEL "+isolation+";\n"+
      "SELECT ppo_authority.read_run("+literals(record.runId)+") IS NOT NULL;\n"+
      "\\echo SNAPSHOT_READY\n")
    await marker
    await commitA()
    p.stdin.end(commitSql(next,record)+" COMMIT;\n")
    const [code]=await done
    if(isolation==="READ COMMITTED"){
      assert.equal(code,0,err)
      assert.equal(out.trim().split("\n").at(-1),"f")
    }else{
      assert.notEqual(code,0)
      assert.match(err,/40001/)
    }
  }finally{
    clearTimeout(timer)
    if(p.exitCode===null&&p.signalCode===null)p.kill("SIGKILL")
    await done.catch(()=>{})
  }
}

test("real PostgreSQL canonical authority: CAS, history, roles and serialized WIP",{timeout:90000},async()=>{
  const migration=await readFile(new URL("./phase1gb2-canonical-postgres.sql",import.meta.url),"utf8")
  await sql(migration)
  console.log("PostgreSQL integration runtime:",await sql("SHOW server_version;"))
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
