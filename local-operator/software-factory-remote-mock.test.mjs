import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"
import {
  SoftwareFactoryRemoteContractError,
  remotePayloadDigest,
  signRemoteEnvelope,
  validateRemotePayload,
  verifyRemoteEnvelope
} from "./software-factory-remote-contract.mjs"
import { createOfflineRemoteDispatchMock } from "./software-factory-remote-mock.mjs"

const key=()=>generateKeyPairSync("ed25519")
const coordinator=key(),codex=key(),antigravity=key(),reviewer=key(),intruder=key()
const SHA="a".repeat(40),BASE="b".repeat(40),HASH="c".repeat(64)
const RID="R".repeat(43)
const ORIGIN="2026-11-10T06:00:00.000Z",NOW="2026-11-10T06:03:00.000Z"
const expiry="2026-11-10T06:10:00.000Z",claimed="2026-11-10T06:02:00.000Z"
const lease="2026-11-10T06:04:00.000Z"
const stamp=i=>i.toString(16).padStart(32,"0")
const request=({role="implementation.backend",...overrides}={})=>({
  kind:"dispatch-request",schemaVersion:1,requestId:stamp(1),runId:RID,expectedVersion:9,
  projectId:"rivora",branch:"ppo/rivora/test",baseSha:BASE,headSha:SHA,
  capability:role,workerId:role==="implementation.backend"?"codex":"antigravity",
  taskSource:{kind:"linear-issue",issueId:"RIC-141",revisionHash:HASH},
  scope:{mode:"implementation",allowedPaths:["local-operator/"],permits:["workspace.read","workspace.write","tests.local"]},
  approval:{ownerId:"owner",approvalId:stamp(2),approvedAt:ORIGIN},nonce:stamp(3),
  idempotencyKey:"d".repeat(64),issuedAt:ORIGIN,expiresAt:expiry,maxDurationMs:120000,
  ...overrides
})
const claim=p=>({
  kind:"worker-claim",schemaVersion:1,requestId:p.requestId,requestHash:remotePayloadDigest(p),
  runId:p.runId,expectedVersion:p.expectedVersion,workerId:p.workerId,hostId:"trusted-mac",
  claimNonce:stamp(4),claimedAt:claimed,leaseExpiresAt:lease
})
const evidence=(p,c,{outcome="success",changedPaths=["local-operator/test.mjs"],deniedTools=[],...rest}={})=>({
  kind:"execution-evidence",schemaVersion:1,requestHash:remotePayloadDigest(p),claimHash:remotePayloadDigest(c),
  runId:p.runId,expectedVersion:p.expectedVersion,workerId:p.workerId,outcome,changedPaths,deniedTools,
  outputHash:"e".repeat(64),summary:"Synthetic sanitized execution summary",finishedAt:NOW,...rest
})
const review=(p,e,extra={})=>({
  kind:"review-decision",schemaVersion:1,requestHash:remotePayloadDigest(p),evidenceHash:remotePayloadDigest(e),
  runId:p.runId,expectedVersion:p.expectedVersion,reviewerId:"mock-reviewer",decision:"accept",
  summary:"Synthetic review only; no merge permission",reviewedAt:NOW,...extra
})
const signed=(payload,who)=>signRemoteEnvelope(payload,...({ppo:["ppo-control-plane",coordinator.privateKey],codex:["codex",codex.privateKey],antigravity:["antigravity",antigravity.privateKey],reviewer:["mock-reviewer",reviewer.privateKey]})[who])
function setup({p=request(),runOverrides={},roleOverride=null,projectList=["rivora"],online=true,now=NOW}={}){
  let run={runId:RID,version:9,status:"implementation_in_progress",project:{id:"rivora"},branch:"ppo/rivora/test",baseSha:BASE,headSha:SHA,role:p.capability,...runOverrides}
  const registry={codex:{hostId:"trusted-mac",online,publicKey:codex.publicKey},antigravity:{hostId:"trusted-mac",online,publicKey:antigravity.publicKey}}
  let reads=0
  const mock=createOfflineRemoteDispatchMock({mode:"offline-mock-only",coordinatorPublicKey:coordinator.publicKey,
    workerRegistry:registry,reviewerPublicKey:reviewer.publicKey,approvedProjects:projectList,
    now:()=>new Date(now),readRun:async()=>{reads+=1;return structuredClone(run)},
    resolveRole:actual=>roleOverride??actual.role})
  return {p,mock,registry,reads:()=>reads,setRun:next=>{run=next}}
}
async function staged(fixture){await fixture.mock.stage(signed(fixture.p,"ppo"));return fixture}
async function claimedFixture(fixture){await staged(fixture);const c=claim(fixture.p);await fixture.mock.claim(fixture.p.requestId,signed(c,fixture.p.workerId));return c}
function isCode(code){return err=>err instanceof SoftwareFactoryRemoteContractError&&err.code===code}

test("full synthetic signed flow binds request, single worker claim, sanitized evidence and review",async()=>{
 const f=setup(),p=f.p,c=await claimedFixture(f)
 assert.equal(f.mock.inspect(p.requestId).claimed,true)
 const e=evidence(p,c)
 assert.equal((await f.mock.recordEvidence(p.requestId,signed(e,"codex"))).outcome,"evidence_recorded")
 const decision=await f.mock.review(p.requestId,signed(review(p,e),"reviewer"))
 assert.deepEqual(decision,{outcome:"review_recorded",requestId:p.requestId,decision:"accept",releaseAuthorized:false})
 assert.equal(f.mock.inspect(p.requestId).hasReview,true)
 assert.equal(f.mock.inspect(p.requestId).releaseAuthorized,false)
})

test("frontend scope is independently bound to Antigravity identity",async()=>{
 const f=setup({p:request({role:"implementation.frontend"})}),p=f.p
 const c=await claimedFixture(f)
 assert.equal(c.workerId,"antigravity")
 const e=evidence(p,c)
 await f.mock.recordEvidence(p.requestId,signed(e,"antigravity"))
 assert.equal((await f.mock.review(p.requestId,signed(review(p,e),"reviewer"))).decision,"accept")
})

test("stage rejects forged coordinator, forged payload, unsupported version and extra properties",async()=>{
 const f=setup(),p=f.p, valid=signed(p,"ppo")
 await assert.rejects(f.mock.stage(signRemoteEnvelope(p,"ppo-control-plane",intruder.privateKey)),isCode("REMOTE_SIGNATURE_INVALID"))
 await assert.rejects(f.mock.stage({...valid,payload:{...p,projectId:"other"}}),isCode("REMOTE_SIGNATURE_INVALID"))
 for(const partial of [{schemaVersion:2},{unexpected:"leak"},{capability:"implementation.frontend"},{scope:{...p.scope,permits:["workspace.read","deploy.production"]}},{branch:"../escape"}]){
  assert.throws(()=>validateRemotePayload({...p,...partial}),isCode(partial.schemaVersion?"REMOTE_VERSION_OR_KIND_INVALID":partial.unexpected?"REMOTE_FIELDS_INVALID":"REMOTE_REQUEST_INVALID"))
 }
})

test("verified envelopes are independent immutable snapshots and reject accessors",async()=>{
 const f=setup(),p=f.p,wire=signed(p,"ppo")
 const verified=verifyRemoteEnvelope(wire,"ppo-control-plane",coordinator.publicKey)
 assert.notStrictEqual(verified,wire.payload)
 assert.equal(Object.isFrozen(verified),true)
 assert.equal(Object.isFrozen(verified.scope),true)
 assert.equal(Object.isFrozen(verified.scope.permits),true)
 wire.payload.scope.permits.pop()
 assert.equal(verified.scope.permits.includes("tests.local"),true)
 // A dispatch remains pinned to signed bytes even when the caller holds a mutable copy.
 const issued=signed(p,"ppo")
 await f.mock.stage(issued)
 issued.payload.scope.permits.pop()
 const c=claim(p)
 assert.equal((await f.mock.claim(p.requestId,signed(c,"codex"))).outcome,"claimed")
 const hostile=signed(p,"ppo")
 Object.defineProperty(hostile.payload.scope,"permits",{enumerable:true,get(){return ["workspace.read"]}})
 await assert.rejects(setup().mock.stage(hostile),isCode("REMOTE_FIELDS_INVALID"))
})

test("duplicate/idempotency/nonce/approval replays cannot stage a second request",async()=>{
 const f=await staged(setup()),p=f.p
 await assert.rejects(f.mock.stage(signed(p,"ppo")),isCode("REMOTE_REPLAY"))
 for(const altered of [
  {requestId:stamp(15)},
  {requestId:stamp(15),idempotencyKey:"f".repeat(64)},
  {requestId:stamp(15),idempotencyKey:"f".repeat(64),nonce:stamp(25)}
 ])await assert.rejects(f.mock.stage(signed({...p,...altered},"ppo")),isCode("REMOTE_REPLAY"))
})

test("only-nonce and only-approval replay are rejected across distinct run IDs",async()=>{
 for (const replayed of ["nonce","approval"]) {
  const f=await staged(setup()),p=f.p,secondRunId="S".repeat(43)
  // Use another canonical run so the run-version reservation cannot mask the
  // nonce / approval replay decision.
  f.setRun({runId:secondRunId,version:p.expectedVersion,status:"implementation_in_progress",
   project:{id:p.projectId},branch:p.branch,baseSha:p.baseSha,headSha:p.headSha,role:p.capability})
  const freshRequest={...p,runId:secondRunId,requestId:stamp(200),
   idempotencyKey:"f".repeat(64),nonce:stamp(201),
   approval:{...p.approval,approvalId:stamp(202)}}
  const reused=replayed==="nonce"
   ? {...freshRequest,nonce:p.nonce}
   : {...freshRequest,approval:{...freshRequest.approval,approvalId:p.approval.approvalId}}
  await assert.rejects(f.mock.stage(signed(reused,"ppo")),isCode("REMOTE_REPLAY"),replayed)
 }
})

test("simultaneous distinct request IDs cannot reuse one approval or nonce",async()=>{
 const f=setup(),p=f.p
 const other={...p,requestId:stamp(123)}
 const outcomes=await Promise.allSettled([
   f.mock.stage(signed(p,"ppo")),
   f.mock.stage(signed(other,"ppo"))
 ])
 assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1)
 assert.equal(outcomes.filter(x=>x.status==="rejected").length,1)
 assert.equal(outcomes.find(x=>x.status==="rejected").reason.code,"REMOTE_CONCURRENT_OPERATION")
})

test("different approvals cannot stage two requests for the same canonical run version",async()=>{
 const f=await staged(setup()),p=f.p
 const alternate={...p,requestId:stamp(151),nonce:stamp(152),idempotencyKey:"a".repeat(64),
   approval:{...p.approval,approvalId:stamp(153)}}
 await assert.rejects(f.mock.stage(signed(alternate,"ppo")),isCode("REMOTE_RUN_ALREADY_STAGED"))
})

test("stale version, branch/SHA, project, task role and unapproved project fail closed",async()=>{
 for(const opts of [
  {p:request({expectedVersion:10})},
  {p:request({headSha:"e".repeat(40)})},
  {p:request({projectId:"kynexa"})},
  {p:request({branch:"ppo/rivora/wrong"})},
  {roleOverride:"implementation.frontend"},
  {projectList:[]}
 ]){
  const f=setup(opts)
  await assert.rejects(f.mock.stage(signed(f.p,"ppo")),isCode(opts.roleOverride?"REMOTE_ROLE_MISMATCH":opts.projectList?"REMOTE_PROJECT_DENIED":opts.p?.projectId==="kynexa"?"REMOTE_PROJECT_DENIED":"REMOTE_RUN_STALE"))
 }
})

test("expired approval or request and future timestamps are refused",async()=>{
 const p=request(),f=setup({now:"2026-11-10T06:11:00.000Z"})
 await assert.rejects(f.mock.stage(signed(p,"ppo")),isCode("REMOTE_EXPIRED"))
 assert.throws(()=>validateRemotePayload({...p,approval:{...p.approval,approvedAt:"2026-11-09T04:00:00.000Z"}}),isCode("REMOTE_REQUEST_TIME_INVALID"))
})

test("offline, unregistered, wrong key, wrong host, and claim replay cannot take ownership",async()=>{
 for(const mode of ["offline","wrong-key","wrong-host","unregistered"]){
  const f=await staged(setup()),p=f.p
  if(mode==="offline")f.registry.codex.online=false
  if(mode==="unregistered")delete f.registry.codex
  let c=claim(p),s=signed(c,"codex")
  if(mode==="wrong-key")s=signRemoteEnvelope(c,"codex",intruder.privateKey)
  if(mode==="wrong-host")s=signed({...c,hostId:"rogue-mac"},"codex")
  await assert.rejects(f.mock.claim(p.requestId,s),isCode(mode==="offline"||mode==="unregistered"?"REMOTE_WORKER_OFFLINE":mode==="wrong-key"?"REMOTE_SIGNATURE_INVALID":"REMOTE_CLAIM_BINDING_INVALID"))
 }
 const f=setup(),c=await claimedFixture(f)
 await assert.rejects(f.mock.claim(f.p.requestId,signed(c,"codex")),isCode("REMOTE_ALREADY_CLAIMED"))
})

test("cross-request claim and mutated signatures are rejected",async()=>{
 const f=await staged(setup()),c=claim(f.p)
 await assert.rejects(f.mock.claim(f.p.requestId,signed({...c,requestHash:"f".repeat(64)},"codex")),isCode("REMOTE_CLAIM_BINDING_INVALID"))
 await assert.rejects(f.mock.claim(f.p.requestId,{...signed(c,"codex"),payload:{...c,hostId:"spoof"}}),isCode("REMOTE_SIGNATURE_INVALID"))
})

test("claim refuses stale run after stage and concurrent claims cannot both win",async()=>{
 const f=await staged(setup()),c=claim(f.p)
 f.setRun({...f.p,version:10,status:"implementation_in_progress",project:{id:"rivora"}})
 await assert.rejects(f.mock.claim(f.p.requestId,signed(c,"codex")),isCode("REMOTE_RUN_STALE"))
 const other=await staged(setup())
 const results=await Promise.allSettled([other.mock.claim(other.p.requestId,signed(c,"codex")),other.mock.claim(other.p.requestId,signed(c,"codex"))])
 assert.equal(results.filter(x=>x.status==="fulfilled").length,1)
 assert.equal(results.filter(x=>x.status==="rejected").length,1)
 assert.equal(results.find(x=>x.status==="rejected").reason.code,"REMOTE_CONCURRENT_OPERATION")
})

test("evidence enforces lease, signed worker identity, paths, permits and explicit denials",async()=>{
 for(const [variant,code] of [
  [{changedPaths:["../credentials.env"]},"REMOTE_EVIDENCE_INVALID"],
  [{changedPaths:["other/unsafe.js"]},"REMOTE_OUT_OF_SCOPE"],
  [{outcome:"success",deniedTools:["workspace.write"]},"REMOTE_DENIED_IS_NOT_SUCCESS"],
  [{outcome:"failed",deniedTools:["sandbox.denied"]},"REMOTE_DENIED_IS_NOT_SUCCESS"],
  [{claimHash:"f".repeat(64)},"REMOTE_EVIDENCE_BINDING_INVALID"]
 ]){
  const f=setup(),c=await claimedFixture(f),p=f.p
  const e=evidence(p,c,variant)
  if(code==="REMOTE_EVIDENCE_INVALID"||(code==="REMOTE_DENIED_IS_NOT_SUCCESS"&&e.outcome==="success")){
    assert.throws(()=>signRemoteEnvelope(e,"codex",codex.privateKey),isCode(code))
  }else await assert.rejects(f.mock.recordEvidence(p.requestId,signed(e,"codex")),isCode(code))
 }
 const p=request({scope:{mode:"implementation",allowedPaths:["local-operator/"],permits:["workspace.read"]}})
 for(const outcome of ["success","failed","blocked"]){
  const f=setup({p}),c=await claimedFixture(f)
  const e=evidence(p,c,{outcome,deniedTools:[]})
  await assert.rejects(f.mock.recordEvidence(p.requestId,signed(e,"codex")),isCode("REMOTE_PERMIT_DENIED"))
 }
})

test("blocked tool denial remains blocked and cannot be converted to accepted review",async()=>{
 const f=setup(),p=f.p,c=await claimedFixture(f)
 const e=evidence(p,c,{outcome:"blocked",changedPaths:[],deniedTools:["workspace.write"]})
 await f.mock.recordEvidence(p.requestId,signed(e,"codex"))
 await assert.rejects(f.mock.review(p.requestId,signed(review(p,e),"reviewer")),isCode("REMOTE_REVIEW_CANNOT_ACCEPT_FAILURE"))
 const blocked=review(p,e,{decision:"blocked"})
 assert.equal((await f.mock.review(p.requestId,signed(blocked,"reviewer"))).releaseAuthorized,false)
 await assert.rejects(f.mock.review(p.requestId,signed(blocked,"reviewer")),isCode("REMOTE_REVIEW_REPLAY"))
})

test("reviewer impersonation, wrong evidence hash and stale version never authorize release",async()=>{
 const f=setup(),p=f.p,c=await claimedFixture(f),e=evidence(p,c)
 await f.mock.recordEvidence(p.requestId,signed(e,"codex"))
 const r=review(p,e)
 await assert.rejects(f.mock.review(p.requestId,signRemoteEnvelope(r,"mock-reviewer",intruder.privateKey)),isCode("REMOTE_SIGNATURE_INVALID"))
 await assert.rejects(f.mock.review(p.requestId,signed({...r,evidenceHash:"f".repeat(64)},"reviewer")),isCode("REMOTE_REVIEW_BINDING_INVALID"))
 f.setRun({...p,version:10,status:"implementation_in_progress",project:{id:"rivora"}})
 await assert.rejects(f.mock.review(p.requestId,signed(r,"reviewer")),isCode("REMOTE_RUN_STALE"))
 assert.equal(f.mock.inspect(p.requestId).releaseAuthorized,false)
})

test("sparse and decorated arrays are refused by validation, signing, hashing and verification",()=>{
 const p=request()
 const hole=new Array(1)
 const decorated=["local-operator/"]
 decorated.custom="hidden"
 const balanced=new Array(1)
 balanced.custom="hidden" // One hole plus one extra key used to pass key-count-only checks.
 const cases=[
  {...p,scope:{...p.scope,allowedPaths:hole}},
  {...p,scope:{...p.scope,allowedPaths:decorated}},
  {...p,scope:{...p.scope,allowedPaths:balanced}},
  {...p,scope:{...p.scope,permits:new Array(1)}},
  {...p,scope:{...p.scope,permits:Object.assign(["workspace.read"],{extra:"hidden"})}}
 ]
 for (const malformed of cases) {
  assert.throws(()=>validateRemotePayload(malformed),isCode("REMOTE_FIELDS_INVALID"))
  assert.throws(()=>remotePayloadDigest(malformed),isCode("REMOTE_FIELDS_INVALID"))
  assert.throws(()=>signRemoteEnvelope(malformed,"ppo-control-plane",coordinator.privateKey),isCode("REMOTE_FIELDS_INVALID"))
  const wire=signed(p,"ppo")
  wire.payload=malformed
  assert.throws(()=>verifyRemoteEnvelope(wire,"ppo-control-plane",coordinator.publicKey),isCode("REMOTE_FIELDS_INVALID"))
 }
})

test("contract rejects secret-bearing summaries, arbitrary payload fields and oversized arrays",()=>{
 const p=request()
 for(const payload of [
  {...p,task:"inject an instruction"},
  {...p,scope:{...p.scope,allowedPaths:Array.from({length:9},(_,i)=>`safe/file${i}`)}},
  {...p,approval:{...p.approval,ownerId:"ssh@host"}}
 ]) assert.throws(()=>validateRemotePayload(payload),err=>err instanceof SoftwareFactoryRemoteContractError&&["REMOTE_REQUEST_INVALID","REMOTE_FIELDS_INVALID"].includes(err.code))
 for(const summary of ["Updated task-runner tests","Risk-free simulated claim","Disk-backed adapter is deferred"]){
  assert.doesNotThrow(()=>validateRemotePayload(evidence(p,claim(p),{summary})))
 }
 for(const summary of ["token=SECRET","sk-"+"a".repeat(24),"ghp_"+"a".repeat(24)]){
  assert.throws(()=>validateRemotePayload(evidence(p,claim(p),{summary})),isCode("REMOTE_EVIDENCE_INVALID"))
 }
})