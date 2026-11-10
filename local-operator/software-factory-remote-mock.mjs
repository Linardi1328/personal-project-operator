import {
  SoftwareFactoryRemoteContractError,
  remotePayloadDigest,
  verifyRemoteEnvelope
} from "./software-factory-remote-contract.mjs"

// Synthetic in-memory harness only. No sockets, filesystem, queue, side effects,
// remote execution, or mutation of PPO's canonical development-run record.
export const SOFTWARE_FACTORY_REMOTE_MOCK_ID = "software-factory-phase1b-offline-mock"
function reject(code) { throw new SoftwareFactoryRemoteContractError(code) }
function time(value) { return Date.parse(value) }
function matchRun(run, p) {
  return run?.runId===p.runId && run?.version===p.expectedVersion &&
    run?.status==="implementation_in_progress" &&
    run?.project?.id===p.projectId && run?.branch===p.branch &&
    run?.baseSha===p.baseSha && run?.headSha===p.headSha
}
function withinPath(path,prefix) { return path===prefix || (prefix.endsWith("/") && path.startsWith(prefix)) }

/** Simulates exactly one claim without asserting distributed durability or host identity. */
export function createOfflineRemoteDispatchMock(config) {
  if (!config || config.mode!=="offline-mock-only" || typeof config.readRun!=="function" ||
      typeof config.resolveRole!=="function" || typeof config.now!=="function" ||
      !config.coordinatorPublicKey || !config.reviewerPublicKey ||
      !Array.isArray(config.approvedProjects) || !config.workerRegistry ||
      typeof config.workerRegistry!=="object") reject("REMOTE_MOCK_CONFIGURATION_INVALID")
  const approvedProjects=new Set(config.approvedProjects)
  const requests=new Map(), seenRequests=new Set(), seenNonces=new Set(), seenApprovals=new Set(), seenRunVersions=new Set(), locked=new Set()
  const nowMs=()=>{const value=config.now();const n=value instanceof Date?value.getTime():Date.parse(value);if(!Number.isFinite(n))reject("REMOTE_CLOCK_INVALID");return n}
  const fresh=(from,to)=>{const n=nowMs();if(n<time(from)-60000 || n>=time(to))reject("REMOTE_EXPIRED")}
  const current=async p=>{
    const run=await config.readRun(p.runId)
    if(!matchRun(run,p))reject("REMOTE_RUN_STALE")
    const role=config.resolveRole(run)
    if(role!==p.capability || !["implementation.backend","implementation.frontend"].includes(role))reject("REMOTE_ROLE_MISMATCH")
  }
  const guard=async (key,fn)=>{
    if(locked.has(key))reject("REMOTE_CONCURRENT_OPERATION")
    locked.add(key)
    try{return await fn()}finally{locked.delete(key)}
  }
  const entry=id=>{const record=requests.get(id);if(!record)reject("REMOTE_REQUEST_UNKNOWN");return record}

  return Object.freeze({
    /** Stage approved PPO-signed metadata only; no worker is contacted. */
    async stage(signed) {
      const p=verifyRemoteEnvelope(signed,"ppo-control-plane",config.coordinatorPublicKey)
      if(p.kind!=="dispatch-request")reject("REMOTE_KIND_MISMATCH")
      return guard("global-claim-registry",async()=>{
        fresh(p.issuedAt,p.expiresAt)
        if(!approvedProjects.has(p.projectId))reject("REMOTE_PROJECT_DENIED")
        if(seenRequests.has(p.idempotencyKey)||seenNonces.has(p.nonce)||seenApprovals.has(p.approval.approvalId)||requests.has(p.requestId))reject("REMOTE_REPLAY")
        const runBinding=`${p.runId}:${p.expectedVersion}`
        if(seenRunVersions.has(runBinding))reject("REMOTE_RUN_ALREADY_STAGED")
        await current(p)
        seenRequests.add(p.idempotencyKey);seenNonces.add(p.nonce);seenApprovals.add(p.approval.approvalId);seenRunVersions.add(runBinding)
        const hash=remotePayloadDigest(p)
        requests.set(p.requestId,{request:p,requestHash:hash,claim:null,evidence:null,review:null})
        return Object.freeze({outcome:"staged",requestId:p.requestId,requestHash:hash})
      })
    },
    /** Verify pinned synthetic host key, claim binding, expiry and one-claim rule. */
    async claim(requestId,signed) {
      return guard("global-claim-registry",async()=>{
        const record=entry(requestId),p=record.request
        if(record.claim)reject("REMOTE_ALREADY_CLAIMED")
        const registered=config.workerRegistry[p.workerId]
        if(!registered || registered.online!==true)reject("REMOTE_WORKER_OFFLINE")
        if(!registered.publicKey || typeof registered.hostId!=="string")reject("REMOTE_WORKER_UNTRUSTED")
        const claim=verifyRemoteEnvelope(signed,p.workerId,registered.publicKey)
        if(claim.kind!=="worker-claim" || claim.requestId!==p.requestId || claim.requestHash!==record.requestHash ||
           claim.runId!==p.runId || claim.expectedVersion!==p.expectedVersion ||
           claim.workerId!==p.workerId || claim.hostId!==registered.hostId)reject("REMOTE_CLAIM_BINDING_INVALID")
        fresh(p.issuedAt,p.expiresAt)
        fresh(claim.claimedAt,claim.leaseExpiresAt)
        if(time(claim.leaseExpiresAt)>time(p.expiresAt) ||
           time(claim.claimedAt)<time(p.issuedAt) ||
           time(claim.leaseExpiresAt)-time(claim.claimedAt)>p.maxDurationMs)reject("REMOTE_LEASE_INVALID")
        if(seenNonces.has(claim.claimNonce))reject("REMOTE_REPLAY")
        await current(p)
        seenNonces.add(claim.claimNonce)
        record.claim={payload:claim,hash:remotePayloadDigest(claim)}
        return Object.freeze({outcome:"claimed",requestId,claimHash:record.claim.hash})
      })
    },
    /** Consume sanitized evidence; a denial may never be labeled success. */
    async recordEvidence(requestId,signed) {
      return guard(requestId,async()=>{
        const record=entry(requestId),p=record.request
        if(!record.claim)reject("REMOTE_CLAIM_REQUIRED")
        if(record.evidence)reject("REMOTE_EVIDENCE_REPLAY")
        const registered=config.workerRegistry[p.workerId]
        const evidence=verifyRemoteEnvelope(signed,p.workerId,registered?.publicKey)
        if(evidence.kind!=="execution-evidence" || evidence.requestHash!==record.requestHash ||
           evidence.claimHash!==record.claim.hash || evidence.runId!==p.runId ||
           evidence.expectedVersion!==p.expectedVersion || evidence.workerId!==p.workerId)reject("REMOTE_EVIDENCE_BINDING_INVALID")
        fresh(record.claim.payload.claimedAt,record.claim.payload.leaseExpiresAt)
        if(time(evidence.finishedAt)<time(record.claim.payload.claimedAt) || time(evidence.finishedAt)>nowMs()+60000)reject("REMOTE_EVIDENCE_TIME_INVALID")
        if(evidence.deniedTools.length>0 && evidence.outcome!=="blocked")reject("REMOTE_DENIED_IS_NOT_SUCCESS")
        if(evidence.outcome==="success" && !p.scope.permits.includes("workspace.write") && evidence.changedPaths.length>0)reject("REMOTE_PERMIT_DENIED")
        if(evidence.changedPaths.some(path=>!p.scope.allowedPaths.some(prefix=>withinPath(path,prefix))))reject("REMOTE_OUT_OF_SCOPE")
        await current(p)
        record.evidence={payload:evidence,hash:remotePayloadDigest(evidence)}
        return Object.freeze({outcome:"evidence_recorded",requestId,evidenceHash:record.evidence.hash})
      })
    },
    /** Record independently signed synthetic review only, never a PPO release. */
    async review(requestId,signed) {
      return guard(requestId,async()=>{
        const record=entry(requestId),p=record.request
        if(!record.evidence)reject("REMOTE_EVIDENCE_REQUIRED")
        if(record.review)reject("REMOTE_REVIEW_REPLAY")
        const r=verifyRemoteEnvelope(signed,"mock-reviewer",config.reviewerPublicKey)
        if(r.kind!=="review-decision" || r.reviewerId!=="mock-reviewer" ||
           r.requestHash!==record.requestHash || r.evidenceHash!==record.evidence.hash ||
           r.runId!==p.runId || r.expectedVersion!==p.expectedVersion)reject("REMOTE_REVIEW_BINDING_INVALID")
        if(r.decision==="accept" && record.evidence.payload.outcome!=="success")reject("REMOTE_REVIEW_CANNOT_ACCEPT_FAILURE")
        if(time(r.reviewedAt)<time(record.evidence.payload.finishedAt) || time(r.reviewedAt)>nowMs()+60000)reject("REMOTE_REVIEW_TIME_INVALID")
        await current(p)
        record.review={payload:r,hash:remotePayloadDigest(r)}
        return Object.freeze({outcome:"review_recorded",requestId,decision:r.decision,releaseAuthorized:false})
      })
    },
    /** Diagnostic metadata only; never return a runnable signed envelope. */
    inspect(requestId) {
      const r=entry(requestId)
      return Object.freeze({requestId,stage:"staged",claimed:Boolean(r.claim),hasEvidence:Boolean(r.evidence),hasReview:Boolean(r.review),releaseAuthorized:false})
    }
  })
}