import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import test from "node:test"
import { createOfflineTransactionFenceAdapter } from "./software-factory-remote-transaction-fence.mjs"

const RUN = "R".repeat(43), REQ = "a".repeat(64), CLAIM = "b".repeat(64)
const BASE = "c".repeat(40), HEAD = "d".repeat(40)
const deny = code => error => error?.code === code

/** In-memory serialized transaction fixture, NEVER a durable shared authority. */
function fixture() {
  const key = generateKeyPairSync("ed25519").publicKey
  const keyFingerprint = createHash("sha256")
    .update(key.export({type:"spki", format:"der"})).digest("hex")
  const b = {
    hostId:"demo-mac", workerId:"codex", hostEpoch:7, publicKey:key,
    runId:RUN, expectedVersion:9, requestHash:REQ, claimHash:CLAIM,
    projectId:"rivora", capability:"implementation.backend",
    branch:"feature/synthetic", baseSha:BASE, headSha:HEAD,
    actionId:"f".repeat(32), actionType:"workspace.read",
    actionPath:"src/a.mjs", issuedAt:"2026-11-12T02:02:30.000Z",
    expiresAt:"2026-11-12T02:03:30.000Z",
    requestExpiresAt:"2026-11-12T02:10:00.000Z",
    requiredCatalogInvalidCount:0, maxActiveProjects:2
  }
  const state = {
    now:"2026-11-12T02:03:00.000Z", used:new Set(),
    host:{hostId:b.hostId,workerId:b.workerId,hostEpoch:7,claimEpoch:7,
      claimHash:CLAIM,keyFingerprint,status:"active"},
    claim:{state:"claimed",claimHash:CLAIM,requestHash:REQ,runId:RUN,
      expectedVersion:9,hostId:b.hostId,workerId:b.workerId,
      claimedAt:"2026-11-12T02:01:00.000Z",
      leaseExpiresAt:"2026-11-12T02:04:00.000Z"},
    request:{requestHash:REQ,runId:RUN,expectedVersion:9,projectId:"rivora",
      workerId:"codex",capability:"implementation.backend",
      branch:b.branch,baseSha:BASE,headSha:HEAD,
      expiresAt:b.requestExpiresAt,permits:["workspace.read"],
      allowedPaths:["src/"]},
    run:{runId:RUN,version:9,status:"implementation_in_progress",
      project:{id:"rivora"},branch:b.branch,baseSha:BASE,headSha:HEAD},
    admission:{valid:true,invalidCount:0,activeProjects:["rivora"]}
  }
  let previous=Promise.resolve()
  const config={mode:"offline-transaction-contract-only",
    transact:async callback=>{
      let unlock
      const turn=new Promise(resolve=>{unlock=resolve})
      const before=previous
      previous=turn
      await before
      try {
        return await callback({
          now:()=>state.now,
          readHostForUpdate:()=>({...state.host}),
          readClaimForUpdate:()=>({...state.claim}),
          readRequestForUpdate:()=>({...state.request}),
          readRunForUpdate:()=>({...state.run,project:{...state.run.project}}),
          readAdmissionForUpdate:()=>({...state.admission,
            activeProjects:[...state.admission.activeProjects]}),
          tryConsumeOnce:input=>{
            const id=input.hostId+":"+input.actionId
            if(state.used.has(id))return false
            state.used.add(id)
            return true
          }
        })
      }finally{unlock()}
    }
  }
  return {state,b,config,consume:createOfflineTransactionFenceAdapter(config)}
}

test("one action consumes exactly once with no execution interface",async()=>{
  const f=fixture()
  assert.equal(await f.consume(f.b),true)
  assert.equal(f.state.used.size,1)
  await assert.rejects(f.consume(f.b),deny("TX_REPLAY_OR_AMBIGUOUS"))
})

test("parallel duplicate actions have exactly one winner",async()=>{
  const f=fixture()
  const results=await Promise.allSettled([f.consume(f.b),f.consume(f.b)])
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1)
  assert.equal(results.filter(x=>x.status==="rejected").length,1)
  assert.equal(results.find(x=>x.status==="rejected").reason.code,
    "TX_REPLAY_OR_AMBIGUOUS")
})

test("a new adapter cannot reuse an already-consumed nonce in the same mock store",async()=>{
  const f=fixture()
  await f.consume(f.b)
  const restarted=createOfflineTransactionFenceAdapter(f.config)
  await assert.rejects(restarted(f.b),deny("TX_REPLAY_OR_AMBIGUOUS"))
})

test("host revocation, rotation or claim re-pinning drift denies",async()=>{
  for(const kind of ["revoked","epoch","key","claim-epoch","claim-hash"]){
    const f=fixture()
    if(kind==="revoked")f.state.host.status="revoked"
    if(kind==="epoch")f.state.host.hostEpoch=8
    if(kind==="key")f.state.host.keyFingerprint="0".repeat(64)
    if(kind==="claim-epoch")f.state.host.claimEpoch=6
    if(kind==="claim-hash")f.state.host.claimHash="0".repeat(64)
    await assert.rejects(f.consume(f.b),deny("TX_HOST_STALE"),kind)
    assert.equal(f.state.used.size,0)
  }
})

test("expired signed claim and wrong claim/request binding deny",async()=>{
  for(const kind of ["lease","request","claim","missing"]){
    const f=fixture()
    if(kind==="lease")f.state.claim.leaseExpiresAt="2026-11-12T02:02:59.000Z"
    if(kind==="request")f.state.claim.requestHash="e".repeat(64)
    if(kind==="claim")f.state.claim.claimHash="e".repeat(64)
    if(kind==="missing")f.state.claim=null
    await assert.rejects(f.consume(f.b),deny("TX_CLAIM_STALE"),kind)
    assert.equal(f.state.used.size,0)
  }
})

test("canonical PPO version, Git refs and run state are enforced",async()=>{
  for(const kind of ["version","base","head","status"]){
    const f=fixture()
    if(kind==="version")f.state.run.version=10
    if(kind==="base")f.state.run.baseSha="0".repeat(40)
    if(kind==="head")f.state.run.headSha="0".repeat(40)
    if(kind==="status")f.state.run.status="completed"
    await assert.rejects(f.consume(f.b),deny("TX_RUN_STALE"),kind)
    assert.equal(f.state.used.size,0)
  }
})

test("catalog invalidity, excessive or duplicate lanes always deny",async()=>{
  for(const kind of ["invalid","catalog","wip","duplicate","no-lane"]){
    const f=fixture()
    if(kind==="invalid")f.state.admission.invalidCount=1
    if(kind==="catalog")f.state.admission.valid=false
    if(kind==="wip")f.state.admission.activeProjects=["kynexa","khlim"]
    if(kind==="duplicate")f.state.admission.activeProjects=["rivora","rivora"]
    if(kind==="no-lane")f.state.admission.activeProjects=["kynexa"]
    await assert.rejects(f.consume(f.b),deny("TX_ADMISSION_BLOCKED"),kind)
    assert.equal(f.state.used.size,0)
  }
})

test("scope permits, relative path and request expiry rechecked in transaction",async()=>{
  for(const kind of ["action","path","digest","expiry"]){
    const f=fixture()
    if(kind==="action")f.state.request.permits=["workspace.write"]
    if(kind==="path")f.state.request.allowedPaths=["docs/"]
    if(kind==="digest")f.state.request.requestHash="0".repeat(64)
    if(kind==="expiry")f.state.request.expiresAt="2026-11-12T02:02:59.000Z"
    await assert.rejects(f.consume(f.b),deny("TX_SCOPE_DENIED"),kind)
    assert.equal(f.state.used.size,0)
  }
})

test("Date timestamp retains milliseconds at boundary",async()=>{
  const f=fixture()
  f.state.now=new Date("2026-11-12T02:03:30.001Z")
  await assert.rejects(f.consume(f.b),deny("TX_EXPIRED"))
  assert.equal(f.state.used.size,0)
})

test("malicious accessors and unknown fields rejected before invoking driver",async()=>{
  const f=fixture()
  let called=0
  const hostile={...f.b,get actionId(){called++;return "f".repeat(32)}}
  await assert.rejects(f.consume(hostile),deny("TX_BOUNDARY_INVALID"))
  await assert.rejects(f.consume({...f.b,canExecute:true}),
    deny("TX_BOUNDARY_INVALID"))
  const maliciousCapability={ [Symbol.toPrimitive](){called++;throw Error("coerce")} }
  await assert.rejects(f.consume({...f.b,capability:maliciousCapability}),
    deny("TX_BOUNDARY_INVALID"))
  await assert.rejects(f.consume({...f.b,publicKey:{
    get asymmetricKeyType(){called++;throw Error("key getter")}
  }}),deny("TX_BOUNDARY_INVALID"))
  assert.equal(called,0)
  assert.equal(f.state.used.size,0)
})

test("unavailable, negative and lost-ack transaction outcomes never imply success",async()=>{
  for(const kind of ["throw","false","lost-ack"]){
    const f=fixture()
    let calls=0
    const consume=createOfflineTransactionFenceAdapter({
      mode:"offline-transaction-contract-only",
      transact:async()=>{
        calls++
        if(kind==="throw")throw new Error("storage unavailable")
        if(kind==="false")return false
        f.state.used.add(f.b.hostId+":"+f.b.actionId)
        throw new Error("COMMIT succeeded, response lost")
      }
    })
    await assert.rejects(consume(f.b),deny("TX_UNAVAILABLE_OR_AMBIGUOUS"))
    assert.equal(calls,1)
    if(kind==="lost-ack")assert.equal(f.state.used.size,1)
  }
})

test("untrusted transaction driver cannot yield an unchecked success",async()=>{
  const f=fixture()
  let calls=0
  const consume=createOfflineTransactionFenceAdapter({
    mode:"offline-transaction-contract-only",
    transact:async callback=>{calls++;return callback({})}
  })
  await assert.rejects(consume({...f.b,hostEpoch:0}),deny("TX_BOUNDARY_INVALID"))
  assert.equal(calls,0)
  await assert.rejects(consume(f.b),deny("TX_DRIVER_INVALID"))
  assert.equal(calls,1)
})
