import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { linkSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { createDevelopmentRun, transitionDevelopmentRun } from "./development-run-state.mjs"
import { createOfflineTransactionFenceAdapter } from "./software-factory-remote-transaction-fence.mjs"
import { createSqliteFenceLab, openSqliteFenceLab } from "./software-factory-remote-sqlite-fence-lab.mjs"

const BASE = "a".repeat(40), HEAD = "b".repeat(40)
const REQ = "c".repeat(64), CLAIM = "d".repeat(64)
const ACTION = "e".repeat(32)
const code = value => error => error?.code === value
const iso = ms => new Date(ms).toISOString()

// Generate real PPO-schema history in a private scratch store, never from
// user/production data. The scratch store is destroyed BEFORE seeding SQL.
async function syntheticRun(projectId="rivora") {
  const dir=mkdtempSync(join(realpathSync(tmpdir()),"ppo-synthetic-run-"))
  let ms=Date.parse("2026-01-01T00:00:00.000Z")
  const options={writeDataDir:dir,now:()=>new Date(ms+=1000)}
  try {
    let record=await createDevelopmentRun({
      projectId, task:"RIC-157 synthetic lab: generated fixture",
      baseSha:BASE,headSha:HEAD,branch:"feature/sqlite-lab",actor:"test-agent"
    },options)
    for(const status of ["planning_in_progress","planned","implementation_in_progress"]){
      record=await transitionDevelopmentRun(record.runId,{
        expectedVersion:record.version,status,actor:"test-agent"
      },options)
    }
    const next=await transitionDevelopmentRun(record.runId,{
      expectedVersion:record.version,status:"implementation_ready",actor:"test-agent"
    },options)
    return {record,next}
  }finally{rmSync(dir,{recursive:true,force:true})}
}
function withDb(f,fn){
  const db=new DatabaseSync(join(f.directory,"fence-lab.sqlite"))
  try{
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;")
    return fn(db)
  }finally{db.close()}
}
function put(f,table,id,payload){
  // Test-only fixture writer, never exported or called by production.
  return withDb(f,db=>db.prepare("INSERT INTO "+table+"(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(id,JSON.stringify(payload)))
}
function count(f){return withDb(f,db=>db.prepare("SELECT COUNT(*) AS n FROM consumed").get().n)}
function adapter(transact){return createOfflineTransactionFenceAdapter({
  mode:"offline-transaction-contract-only",transact
})}

async function fixture(t){
  const f=createSqliteFenceLab()
  t.after(()=>rmSync(f.directory,{recursive:true,force:true}))
  const {record,next}=await syntheticRun()
  const key=generateKeyPairSync("ed25519").publicKey
  const fingerprint=createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex")
  const now=Date.now()
  const b={
    hostId:"lab-mac",workerId:"codex",hostEpoch:7,publicKey:key,
    runId:record.runId,expectedVersion:record.version,
    requestHash:REQ,claimHash:CLAIM,projectId:record.project.id,
    capability:"implementation.backend",branch:record.branch,
    baseSha:record.baseSha,headSha:record.headSha,actionId:ACTION,
    actionType:"workspace.read",actionPath:"src/a.mjs",
    issuedAt:iso(now-1000),expiresAt:iso(now+45000),
    requestExpiresAt:iso(now+60000),requiredCatalogInvalidCount:0,maxActiveProjects:2
  }
  const host={hostId:b.hostId,workerId:b.workerId,hostEpoch:7,claimEpoch:7,
    claimHash:CLAIM,keyFingerprint:fingerprint,status:"active",
    approvedProjectIds:["rivora"],approvedCapabilities:["implementation.backend"]}
  const claim={state:"claimed",claimHash:CLAIM,requestHash:REQ,runId:b.runId,
    expectedVersion:b.expectedVersion,hostId:b.hostId,workerId:b.workerId,
    claimedAt:iso(now-2000),leaseExpiresAt:iso(now+60000)}
  const request={requestHash:REQ,runId:b.runId,expectedVersion:b.expectedVersion,
    projectId:b.projectId,workerId:b.workerId,capability:b.capability,
    branch:b.branch,baseSha:b.baseSha,headSha:b.headSha,
    expiresAt:b.requestExpiresAt,permits:["workspace.read"],allowedPaths:["src/"]}
  put(f,"hosts",b.hostId,host)
  put(f,"claims",CLAIM,claim)
  put(f,"requests",REQ,request)
  put(f,"canonical_runs",record.runId,record)
  return {...f,b,host,claim,request,record,next,consume:adapter(f.transact)}
}

const labUrl=new URL("./software-factory-remote-sqlite-fence-lab.mjs",import.meta.url).href
const adapterUrl=new URL("./software-factory-remote-transaction-fence.mjs",import.meta.url).href
const childScript=[
  'import {createPublicKey} from "node:crypto"',
  'import {openSqliteFenceLab} from '+JSON.stringify(labUrl),
  'import {createOfflineTransactionFenceAdapter} from '+JSON.stringify(adapterUrl),
  'const {directory,token,b,hold}=JSON.parse(process.argv[1])',
  'b.publicKey=createPublicKey(b.publicKey)',
  'try {',
  'const base=openSqliteFenceLab(directory,token)',
  'const transact=hold?async cb=>base(async tx=>{const result=await cb(tx);',
  'if(result===true){process.send({kind:"pending"});await new Promise(()=>{setInterval(()=>{},1000)})}return result}):base',
  'const consume=createOfflineTransactionFenceAdapter({mode:"offline-transaction-contract-only",transact})',
  'await consume(b);process.send({kind:"result",ok:true})',
  '}catch(error){process.send({kind:"result",ok:false,code:error?.code||"LAB_DENIED"})}',
  'if(process.connected)process.disconnect()'
].join("\n")
function launch(t,f,hold=false){
  const data={directory:f.directory,token:f.token,hold,b:{
    ...f.b,publicKey:f.b.publicKey.export({type:"spki",format:"pem"})
  }}
  const child=spawn(process.execPath,["--input-type=module","-e",childScript,JSON.stringify(data)],
    {stdio:["ignore","ignore","pipe","ipc"]})
  let stderr=""
  child.stderr.on("data",chunk=>{stderr+=chunk})
  const done=new Promise((resolve,reject)=>{
    child.once("error",reject)
    child.once("exit",(exitCode,signal)=>resolve({exitCode,signal,stderr}))
  })
  const message=new Promise(resolve=>child.once("message",resolve))
  const first=Promise.race([message,done.then(result=>{throw Error("Child exited before result: "+JSON.stringify(result))})])
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL")
    await done
  })
  return {child,done,first}
}

test("SQLite lab persists a nonce across independent connections and reopen",async t=>{
  const f=await fixture(t)
  assert.equal(await f.consume(f.b),true)
  assert.equal(count(f),1)
  const reopened=adapter(openSqliteFenceLab(f.directory,f.token))
  await assert.rejects(reopened(f.b),code("TX_REPLAY_OR_AMBIGUOUS"))
  const row=withDb(f,db=>db.prepare("SELECT * FROM consumed").get())
  assert.equal(row.run_id,f.record.runId)
  assert.equal(row.run_version,f.record.version)
  assert.equal(row.host_epoch,7)
  assert.ok(row.consumed_ms<row.expires_ms)
  assert.throws(()=>withDb(f,db=>db.exec("DELETE FROM consumed")),/immutable laboratory nonce/)
  assert.equal(count(f),1)
})

test("two independent processes cannot both consume the same nonce",{timeout:20000},async t=>{
  const f=await fixture(t)
  const a=launch(t,f), b=launch(t,f)
  const results=await Promise.all([a.first,b.first])
  await Promise.all([a.done,b.done])
  assert.equal(results.filter(x=>x.ok===true).length,1)
  assert.equal(results.filter(x=>x.ok===false).length,1)
  assert.equal(count(f),1)
  const later=launch(t,f)
  assert.equal((await later.first).ok,false)
  await later.done
})

test("process killed before commit rolls back nonce; competing writer denied",{timeout:20000},async t=>{
  const f=await fixture(t)
  const holder=launch(t,f,true)
  assert.deepEqual(await holder.first,{kind:"pending"})
  // Separate connection and child are excluded from the uncommitted writer.
  assert.throws(()=>withDb(f,db=>db.exec("BEGIN IMMEDIATE")),/locked|busy/i)
  const competing=launch(t,f)
  assert.equal((await competing.first).ok,false)
  await competing.done
  assert.equal(count(f),0)
  holder.child.kill("SIGKILL")
  assert.equal((await holder.done).signal,"SIGKILL")
  assert.equal(count(f),0)
  assert.equal(await adapter(openSqliteFenceLab(f.directory,f.token))(f.b),true)
  assert.equal(count(f),1)
})

test("committed nonce survives lost acknowledgment and later process",{timeout:20000},async t=>{
  const f=await fixture(t)
  const loseAck=adapter(async cb=>{
    assert.equal(await f.transact(cb),true)
    throw Error("simulated lost acknowledgment after real COMMIT")
  })
  await assert.rejects(loseAck(f.b),code("TX_UNAVAILABLE_OR_AMBIGUOUS"))
  assert.equal(count(f),1)
  const child=launch(t,f)
  assert.equal((await child.first).ok,false)
  await child.done
  assert.equal(count(f),1)
})

test("revocation, host policy and canonical version change deny against stored authority",async t=>{
  for(const kind of ["revoked","rotated","project","capability","version"]){
    const f=await fixture(t)
    if(kind==="revoked")put(f,"hosts",f.b.hostId,{...f.host,status:"revoked"})
    if(kind==="rotated")put(f,"hosts",f.b.hostId,{...f.host,hostEpoch:8})
    if(kind==="project")put(f,"hosts",f.b.hostId,{...f.host,approvedProjectIds:["kynexa"]})
    if(kind==="capability")put(f,"hosts",f.b.hostId,{...f.host,approvedCapabilities:["implementation.frontend"]})
    if(kind==="version")put(f,"canonical_runs",f.record.runId,f.next)
    await assert.rejects(f.consume(f.b),code(kind==="version"?"TX_RUN_STALE":
      kind==="project"||kind==="capability"?"TX_REPLAY_OR_AMBIGUOUS":"TX_HOST_STALE"),kind)
    assert.equal(count(f),0)
  }
})

test("admission derives lanes from full validated run records, not a copied summary",async t=>{
  for(const kind of ["invalid","incomplete","duplicate","overflow"]){
    const f=await fixture(t)
    if(kind==="invalid"){
      const id=randomBytes(32).toString("base64url")
      put(f,"canonical_runs",id,{runId:id,task:"invalid history"})
    }
    if(kind==="incomplete")withDb(f,db=>db.exec("UPDATE lab_meta SET catalog_complete=0"))
    if(kind==="duplicate"){
      const {record}=await syntheticRun("rivora")
      put(f,"canonical_runs",record.runId,record)
    }
    if(kind==="overflow"){
      for(const projectId of ["kynexa","khlim-assist"]){
        const {record}=await syntheticRun(projectId)
        put(f,"canonical_runs",record.runId,record)
      }
    }
    await assert.rejects(f.consume(f.b),code("TX_ADMISSION_BLOCKED"),kind)
    assert.equal(count(f),0)
  }
})

test("actual wall-clock expiry before commit rolls back the staged nonce",async t=>{
  const f=await fixture(t)
  const deadline=Date.now()+2000
  f.b.expiresAt=iso(deadline)
  let staged=false
  const delayed=adapter(cb=>f.transact(async tx=>{
    const result=await cb(tx)
    staged=result===true
    // Wait until the real database wall clock passes the signed deadline.
    await delay(Math.max(0,deadline-Date.now()+50))
    return result
  }))
  await assert.rejects(delayed(f.b),code("TX_UNAVAILABLE_OR_AMBIGUOUS"))
  assert.equal(staged,true)
  assert.equal(count(f),0)
})

test("lab cannot open a different database, wrong token or non-lab directory",async t=>{
  const f=await fixture(t)
  assert.throws(()=>openSqliteFenceLab(f.directory,"0".repeat(64)))
  assert.throws(()=>openSqliteFenceLab(realpathSync(tmpdir()),f.token))
  assert.equal(count(f),0)
})


test("nonce provenance cannot be replaced even when recursive triggers are off",async t=>{
  const f=await fixture(t)
  assert.equal(await f.consume(f.b),true)
  const before=withDb(f,db=>db.prepare("SELECT * FROM consumed").get())
  withDb(f,db=>{
    db.exec("PRAGMA recursive_triggers=OFF")
    assert.equal(db.prepare("PRAGMA recursive_triggers").get().recursive_triggers,0)
    const replacement=db.prepare(
      "INSERT OR REPLACE INTO consumed(host_id,action_id,request_hash,claim_hash,run_id,run_version,host_epoch,consumed_ms,expires_ms) VALUES(?,?,?,?,?,?,?,?,?)"
    ).run(before.host_id,before.action_id,"f".repeat(64),"a".repeat(64),
      "R".repeat(43),before.run_version+1,before.host_epoch+1,
      before.consumed_ms,before.expires_ms)
    assert.equal(replacement.changes,0)
    assert.throws(()=>db.exec("UPDATE consumed SET host_epoch=99"),/immutable laboratory nonce/)
    assert.throws(()=>db.exec("DELETE FROM consumed"),/immutable laboratory nonce/)
    assert.deepEqual(db.prepare("SELECT * FROM consumed").all(),[before])
  })
  await assert.rejects(adapter(openSqliteFenceLab(f.directory,f.token))(f.b),code("TX_REPLAY_OR_AMBIGUOUS"))
  assert.deepEqual(withDb(f,db=>db.prepare("SELECT * FROM consumed").all()),[before])
})

test("a valid new host epoch cannot reuse a consumed action ID",async t=>{
  const f=await fixture(t)
  assert.equal(await f.consume(f.b),true)
  const original=withDb(f,db=>db.prepare("SELECT * FROM consumed").get())
  const key=generateKeyPairSync("ed25519").publicKey
  const fingerprint=createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex")
  const newClaim="f".repeat(64)
  put(f,"hosts",f.b.hostId,{...f.host,hostEpoch:8,claimEpoch:8,
    claimHash:newClaim,keyFingerprint:fingerprint})
  put(f,"claims",newClaim,{...f.claim,claimHash:newClaim})
  const rotated={...f.b,hostEpoch:8,publicKey:key,claimHash:newClaim}
  await assert.rejects(f.consume(rotated),code("TX_REPLAY_OR_AMBIGUOUS"))
  assert.deepEqual(withDb(f,db=>db.prepare("SELECT * FROM consumed").all()),[original])
  // Positive control: the new epoch and claim are valid with a new nonce.
  assert.equal(await f.consume({...rotated,actionId:"a".repeat(32)}),true)
  assert.equal(count(f),2)
})

test("late post-COMMIT or cleanup acknowledgment denies and burns the committed nonce",{timeout:20000},async t=>{
  for(const phase of ["commit","close"]){
    const f=await fixture(t)
    const deadline=Date.now()+3000
    f.b.expiresAt=iso(deadline)
    let injected=false
    // Inject real synchronous latency at the native call boundary, without
    // replacing SQLite storage, the transaction or the authority clock.
    function crossDeadline(){
      assert.ok(Date.now()<deadline,"must observe a fresh deadline before latency")
      injected=true
      const waitMs=Math.max(1,deadline-Date.now()+50)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,waitMs)
      assert.ok(Date.now()>=deadline,"latency must cross the deadline")
    }
    const proto=DatabaseSync.prototype
    const method=phase==="commit"?"exec":"close"
    const original=proto[method]
    const mocked=t.mock.method(proto,method,function(...args){
      const result=original.apply(this,args)
      if(phase==="close"||args[0]==="COMMIT")crossDeadline()
      return result
    })
    try{
      await assert.rejects(f.consume(f.b),code("TX_UNAVAILABLE_OR_AMBIGUOUS"),phase)
    }finally{
      mocked.mock.restore()
    }
    assert.equal(injected,true,phase)
    const before=withDb(f,db=>db.prepare("SELECT * FROM consumed").all())
    assert.equal(before.length,1,phase)
    // A fresh boundary with the same nonce must reach replay detection, not
    // just fail because the original proof's time has already expired.
    const now=Date.now()
    const fresh={...f.b,issuedAt:iso(now-1000),expiresAt:iso(now+10000)}
    await assert.rejects(adapter(openSqliteFenceLab(f.directory,f.token))(fresh),
      code("TX_REPLAY_OR_AMBIGUOUS"),phase)
    assert.deepEqual(withDb(f,db=>db.prepare("SELECT * FROM consumed").all()),before)
  }
})

test("non-lab database metadata, obsolete schema and hard links are rejected",async t=>{
  for(const kind of ["application-id","schema-version","metadata","hard-link"]){
    const f=await fixture(t)
    if(kind==="application-id")withDb(f,db=>db.exec("PRAGMA application_id=0"))
    if(kind==="schema-version")withDb(f,db=>db.exec("PRAGMA user_version=1"))
    if(kind==="metadata")withDb(f,db=>db.exec("DELETE FROM lab_meta"))
    if(kind==="hard-link")linkSync(join(f.directory,"fence-lab.sqlite"),join(f.directory,"other.sqlite"))
    assert.throws(()=>openSqliteFenceLab(f.directory,f.token),undefined,kind)
    if(kind==="hard-link")unlinkSync(join(f.directory,"other.sqlite"))
    assert.equal(count(f),0)
  }
})
