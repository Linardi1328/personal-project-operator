import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"
import {
  buildBaselineSoftwareFactoryPlan,
  resolveSoftwareFactoryTaskRole,
  softwareFactoryPlanEvidence
} from "./software-factory-plan-contract.mjs"
import { signRemoteEnvelope } from "./software-factory-remote-contract.mjs"
import { createOfflineRemoteDispatchMock } from "./software-factory-remote-mock.mjs"

const RID="R".repeat(43), BASE="b".repeat(40), SHA="a".repeat(40)
const NOW="2026-11-10T06:03:00.000Z",ISSUED="2026-11-10T06:00:00.000Z",EXPIRES="2026-11-10T06:10:00.000Z"
const signer=generateKeyPairSync("ed25519")
const nonce="e".repeat(32)

/** Build the real hash-bound PPO baseline plan for role-integration tests. */
function plannedRun(objective) {
  const plan=buildBaselineSoftwareFactoryPlan({runId:RID,projectId:"rivora",baseSha:BASE,objective})
  return {
    runId:RID,version:9,status:"implementation_in_progress",project:{id:"rivora"},
    branch:"ppo/rivora/synthetic",baseSha:BASE,headSha:SHA,task:objective,
    evidence:{planning:[softwareFactoryPlanEvidence(plan)]}
  }
}
/** Create the signed descriptor expected to match PPO's canonical role decision. */
function descriptor(role) {
  return {
    kind:"dispatch-request",schemaVersion:1,requestId:"1".repeat(32),runId:RID,
    expectedVersion:9,projectId:"rivora",branch:"ppo/rivora/synthetic",baseSha:BASE,headSha:SHA,
    capability:role,workerId:role==="implementation.backend"?"codex":"antigravity",
    taskSource:{kind:"linear-issue",issueId:"RIC-141",revisionHash:"f".repeat(64)},
    scope:{mode:"implementation",allowedPaths:["local-operator/"],permits:["workspace.read"]},
    approval:{ownerId:"owner",approvalId:"2".repeat(32),approvedAt:ISSUED},
    nonce,idempotencyKey:"3".repeat(64),issuedAt:ISSUED,expiresAt:EXPIRES,maxDurationMs:120000
  }
}
/** Integrate the offline harness with PPO's actual Phase 1A task-role resolver. */
function harness(run) {
  return createOfflineRemoteDispatchMock({
    mode:"offline-mock-only",readRun:async()=>structuredClone(run),
    resolveRole:resolveSoftwareFactoryTaskRole,now:()=>new Date(NOW),
    approvedProjects:["rivora"],coordinatorPublicKey:signer.publicKey,
    reviewerPublicKey:generateKeyPairSync("ed25519").publicKey,
    workerRegistry:{}
  })
}

/** Ensure Phase 1B never invents a weaker role classification than merged Phase 1A. */
test("actual PPO baseline plans bind backend multipart form to Codex and frontend form to Antigravity",async()=>{
  for(const [objective,role] of [
    ["Accept multipart form data in the backend endpoint.","implementation.backend"],
    ["Implement the approved responsive signup form.","implementation.frontend"]
  ]){
    const run=plannedRun(objective)
    assert.equal(resolveSoftwareFactoryTaskRole(run),role)
    const payload=descriptor(role)
    const result=await harness(run).stage(signRemoteEnvelope(payload,"ppo-control-plane",signer.privateKey))
    assert.equal(result.outcome,"staged")
  }
})

test("actual PPO resolver blocks mixed-role and stale hash-bound plans from synthetic dispatch",async()=>{
  for(const objective of [
    "Implement a browser UI and backend API simultaneously.",
    "Accept multipart form data in the backend endpoint."
  ]){
    const run=plannedRun(objective)
    if(objective.startsWith("Accept"))run.task="Implement an unrelated frontend signup form."
    assert.equal(resolveSoftwareFactoryTaskRole(run),"debugging")
    const role="implementation.frontend"
    await assert.rejects(
      harness(run).stage(signRemoteEnvelope(descriptor(role),"ppo-control-plane",signer.privateKey)),
      error=>error?.code==="REMOTE_ROLE_MISMATCH"
    )
  }
})