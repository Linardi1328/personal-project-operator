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
    beforeAdmission:null, beforeConsume:null, beforeCommit:null, driverCalls:0,
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
        state.driverCalls++
        let pending = null
        const fresh = input => {
          const now = state.now instanceof Date ? state.now.getTime() : Date.parse(state.now)
          return Number.isFinite(now) && now >= input.claimNotBeforeMs &&
            now >= input.proofNotBeforeMs && now < input.claimExpiresAtMs &&
            now < input.proofExpiresAtMs && now < input.requestExpiresAtMs
        }
        const result = await callback({
          now:()=>state.now,
          readHostForUpdate:()=>({...state.host}),
          readClaimForUpdate:()=>({...state.claim}),
          readRequestForUpdate:()=>({...state.request}),
          readRunForUpdate:()=>({...state.run,project:{...state.run.project}}),
          readAdmissionForUpdate:async()=>{
            await state.beforeAdmission?.()
            return {...state.admission,activeProjects:[...state.admission.activeProjects]}
          },
          tryConsumeFreshOnce:async input=>{
            await state.beforeConsume?.()
            const id=input.hostId+":"+input.actionId
            if(!fresh(input)||pending||state.used.has(id))return false
            pending={id,input}
            return true
          }
        })
        // Simulate a commit-time condition with no await between the final
        // clock check and publishing the nonce. Not a real database guarantee.
        await state.beforeCommit?.()
        if(result!==true||!pending||!fresh(pending.input))return false
        state.used.add(pending.id)
        return true
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
    if(kind==="wip")f.state.admission.activeProjects=["rivora","kynexa","khlim"]
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


test("expiry after asynchronous reads cannot consume a nonce",async()=>{
  for(const kind of ["proof","claim","request"]){
    const f=fixture()
    // Independently exercise a shorter claim or simultaneous proof/request deadline.
    if(kind==="claim")f.state.claim.leaseExpiresAt="2026-11-12T02:03:15.000Z"
    if(kind==="request"){
      f.b.requestExpiresAt=f.b.expiresAt
      f.state.request.expiresAt=f.b.expiresAt
    }
    f.state.beforeAdmission=async()=>{
      f.state.now=kind==="claim"?"2026-11-12T02:03:15.000Z":"2026-11-12T02:03:30.000Z"
    }
    await assert.rejects(f.consume(f.b),deny("TX_EXPIRED"),kind)
    assert.equal(f.state.used.size,0)
  }
})

test("freshness is enforced by the conditional insert and acknowledged commit",async()=>{
  for(const hook of ["beforeConsume","beforeCommit"]){
    for(const kind of ["proof","claim","request"]){
      const f=fixture()
      if(kind==="claim")f.state.claim.leaseExpiresAt="2026-11-12T02:03:15.000Z"
      if(kind==="request"){
        f.b.requestExpiresAt=f.b.expiresAt
        f.state.request.expiresAt=f.b.expiresAt
      }
      f.state[hook]=async()=>{
        f.state.now=kind==="claim"?"2026-11-12T02:03:15.000Z":"2026-11-12T02:03:30.000Z"
      }
      await assert.rejects(f.consume(f.b),
        deny(hook==="beforeConsume"?"TX_REPLAY_OR_AMBIGUOUS":"TX_UNAVAILABLE_OR_AMBIGUOUS"),
        hook+":"+kind)
      assert.equal(f.state.used.size,0)
    }
  }
})

test("external timestamp fields require immutable canonical ISO strings before driver invocation",async()=>{
  for(const field of ["issuedAt","expiresAt","requestExpiresAt"]){
    const f=fixture()
    let coercions=0
    for(const value of [new Date(f.b[field]),new String(f.b[field]),
      {toString(){coercions++;return f.b[field]}}]){
      await assert.rejects(f.consume({...f.b,[field]:value}),deny("TX_BOUNDARY_INVALID"),field)
    }
    assert.equal(coercions,0)
    assert.equal(f.state.driverCalls,0)
    assert.equal(f.state.used.size,0)
  }
})


test("driver acknowledgment without successful callback completion fails closed",async()=>{
  for(const kind of ["skipped","swallowed","unawaited"]){
    const f=fixture()
    const consume=createOfflineTransactionFenceAdapter({
      mode:"offline-transaction-contract-only",
      transact:async callback=>{
        if(kind==="skipped")return true
        if(kind==="swallowed"){
          try{await callback({})}catch{}
          return true
        }
        // The callback is still suspended on the clock when the driver
        // acknowledges; it must not later reach nonce consumption.
        let release
        const suspended=new Promise(resolve=>{release=resolve})
        const late=callback({
          now:()=>suspended,readHostForUpdate:()=>f.state.host,
          readClaimForUpdate:()=>f.state.claim,readRequestForUpdate:()=>f.state.request,
          readRunForUpdate:()=>f.state.run,readAdmissionForUpdate:()=>f.state.admission,
          tryConsumeFreshOnce:()=>{f.state.used.add("unexpected");return true}
        })
        f.state.finishLate=async()=>{
          release(f.state.now)
          await assert.rejects(late,deny("TX_DRIVER_INVALID"))
        }
        return true
      }
    })
    await assert.rejects(consume(f.b),deny("TX_UNAVAILABLE_OR_AMBIGUOUS"),kind)
    if(f.state.finishLate)await f.state.finishLate()
    assert.equal(f.state.used.size,0)
  }
})

test("driver cannot obtain a success by calling the transaction callback twice",async()=>{
  const f=fixture()
  const consume=createOfflineTransactionFenceAdapter({
    mode:"offline-transaction-contract-only",
    transact:async callback=>{
      // Simulated driver; do not publish any mutation for a rejected transaction.
      const tx={
        now:()=>f.state.now,readHostForUpdate:()=>f.state.host,
        readClaimForUpdate:()=>f.state.claim,readRequestForUpdate:()=>f.state.request,
        readRunForUpdate:()=>f.state.run,readAdmissionForUpdate:()=>f.state.admission,
        tryConsumeFreshOnce:()=>true
      }
      assert.equal(await callback(tx),true)
      await assert.rejects(callback(tx),deny("TX_DRIVER_INVALID"))
      return true
    }
  })
  await assert.rejects(consume(f.b),deny("TX_UNAVAILABLE_OR_AMBIGUOUS"))
  assert.equal(f.state.used.size,0)
})
