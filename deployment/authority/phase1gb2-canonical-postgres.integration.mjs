import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createDevelopmentRun, transitionDevelopmentRun, recordDevelopmentRunProgress } from "../../local-operator/development-run-state.mjs"
import { createPostgresCanonicalAuthority } from "../../local-operator/development-postgres-canonical-authority.mjs"

// Deliberately not a .test.mjs: the explicit CI step starts a fresh isolated
// PostgreSQL container. No environment DSN or host database is ever used.
const container=process.env.PPO_AUTHORITY_TEST_CONTAINER
if(process.env.CI!=="true"||!/^ppo-authority-ci-[0-9]+-[0-9]+$/u.test(container||"")){
  throw Error("Dedicated disposable CI authority container required")
}
function sql(input,role="postgres"){
  if(!["postgres","ppo_authority_writer","ppo_authority_reader"].includes(role))throw Error("invalid test role")
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
  "SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::jsonb) AS accepted":"accepted",
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
async function fixture(project){
  const dir=await mkdtemp(join(tmpdir(),"ppo-shared-authority-"))
  let clock=Date.parse("2026-01-01T00:00:00.000Z")
  const options={writeDataDir:dir,now:()=>new Date(clock+=1000)}
  try{
    const initial=await createDevelopmentRun({projectId:project,task:"RIC-157 shared authority synthetic: canonical CAS fixture",
      baseSha:"a".repeat(40),headSha:"b".repeat(40),branch:"feature/authority-ci",actor:"test-agent"},options)
    const first=await transitionDevelopmentRun(initial.runId,{expectedVersion:0,status:"planning_in_progress",actor:"test-agent"},options)
    const planned=await transitionDevelopmentRun(initial.runId,{expectedVersion:1,status:"planned",actor:"test-agent"},options)
    const implementing=await transitionDevelopmentRun(initial.runId,{expectedVersion:2,status:"implementation_in_progress",actor:"test-agent"},options)
    const progress=await recordDevelopmentRunProgress(initial.runId,{expectedVersion:3,status:"implementation_in_progress",actor:"test-agent",reason:"synthetic progress"},options)
    const cancelled=await transitionDevelopmentRun(initial.runId,{expectedVersion:4,status:"cancelled",actor:"test-agent"},options)
    return {initial,first,planned,implementing,progress,cancelled}
  }finally{await rm(dir,{recursive:true,force:true})}
}
const commit=(a,record,prior=null)=>a.commitRecord(JSON.stringify(record),prior?.version??-1,prior?.historyHash??null)

test("real PostgreSQL canonical authority: CAS, history, roles and serialized WIP",{timeout:90000},async()=>{
  const migration=await readFile(new URL("./phase1gb2-canonical-postgres.sql",import.meta.url),"utf8")
  await sql(migration)
  console.log("PostgreSQL integration runtime:",await sql("SHOW server_version;"))
  const writer=authority(),reader=authority("ppo_authority_reader")
  const a=await fixture("rivora")
  assert.equal(await reader.readRun(a.initial.runId),null)
  const createSql="SELECT ppo_authority.commit_run("+[a.initial.runId,-1,null,JSON.stringify(a.initial)].map(literals).join(",") + "::jsonb);"
  assert.equal(await sql("BEGIN; "+createSql+" ROLLBACK;","ppo_authority_writer"),"t")
  assert.equal(await reader.readRun(a.initial.runId),null)
  assert.deepEqual(await reader.readVersions(a.initial.runId),[])
  assert.equal(await commit(writer,a.initial),true)
  assert.equal(await commit(writer,a.initial),false)
  const outcomes=await Promise.all([commit(writer,a.first,a.initial),commit(authority(),a.first,a.initial)])
  assert.deepEqual(outcomes.sort(),[false,true])
  assert.equal(await writer.commitRecord(JSON.stringify(a.planned),1,"f".repeat(64)),false)
  const fork=structuredClone(a.planned)
  fork.history[0].actor="rewritten"
  // Direct trusted SQL writer bypasses the JS validator here intentionally:
  // the DB must still refuse a rewrite of an existing history prefix.
  const forkResult=await query("ppo_authority_writer")(
    "SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::jsonb) AS accepted",
    [a.initial.runId,1,a.first.historyHash,JSON.stringify(fork)])
  assert.equal(forkResult.rows[0].accepted,false)
  assert.deepEqual(await reader.readVersions(a.initial.runId),[a.initial,a.first])
  assert.equal(await commit(writer,a.planned,a.first),true)
  assert.equal(await commit(writer,a.implementing,a.planned),true)
  const wrongHead={...a.progress,headSha:"c".repeat(40)}
  await assert.rejects(commit(writer,wrongHead,a.implementing))
  assert.equal(await commit(writer,a.progress,a.implementing),true)
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
  await assert.rejects(sql("DELETE FROM ppo_authority.run_versions;","postgres"),/append-only/)

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
})
