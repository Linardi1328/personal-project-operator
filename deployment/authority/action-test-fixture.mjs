// Synthetic signatures for tests only; never a host enrollment interface.
import { generateKeyPairSync,createHash,randomBytes } from "node:crypto"
import { signRemoteEnvelope,remotePayloadDigest } from "../../local-operator/software-factory-remote-contract.mjs"
import { signOfflineHostActionProof } from "../../local-operator/software-factory-remote-host-fence.mjs"
export function signedActionFixture(run,{now=Date.now(),lifetime=50000,epoch=1,keys,changeRequest=()=>{},changeClaim=()=>{},changeProof=()=>{}}={}){
 keys??={coordinator:generateKeyPairSync("ed25519"),worker:generateKeyPairSync("ed25519"),host:generateKeyPairSync("ed25519")}
 const iso=ms=>new Date(ms).toISOString(),nonce=()=>randomBytes(16).toString("hex")
 const request={kind:"dispatch-request",schemaVersion:1,requestId:nonce(),runId:run.runId,expectedVersion:run.version,
  projectId:run.project.id,branch:run.branch,baseSha:run.baseSha,headSha:run.headSha,capability:"implementation.backend",workerId:"codex",
  taskSource:{kind:"linear-issue",issueId:"RIC-157",revisionHash:"c".repeat(64)},scope:{mode:"implementation",allowedPaths:["src/"],permits:["workspace.read","workspace.write","tests.local"]},
  approval:{ownerId:"owner",approvalId:nonce(),approvedAt:iso(now-2000)},nonce:nonce(),idempotencyKey:"d".repeat(64),
  issuedAt:iso(now-1000),expiresAt:iso(now+60000),maxDurationMs:1000}
 changeRequest(request)
 const requestHash=remotePayloadDigest(request)
 const claim={kind:"worker-claim",schemaVersion:1,requestId:request.requestId,requestHash,runId:run.runId,expectedVersion:run.version,
  workerId:request.workerId,hostId:"lab-action-host",claimNonce:nonce(),claimedAt:iso(now-500),leaseExpiresAt:iso(now+lifetime)}
 changeClaim(claim)
 const claimHash=remotePayloadDigest(claim)
 const proof={version:1,hostId:claim.hostId,hostEpoch:epoch,workerId:request.workerId,requestHash,claimHash,
  runId:run.runId,expectedVersion:run.version,actionId:nonce(),actionType:"workspace.write",actionPath:"src/synthetic.mjs",issuedAt:iso(now-100),expiresAt:iso(now+Math.min(lifetime,50000))}
 changeProof(proof)
 const fingerprint=key=>createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex")
 const policy={status:"active",workerId:request.workerId,keyFingerprint:fingerprint(keys.host.publicKey),workerFingerprint:fingerprint(keys.worker.publicKey),
  coordinatorFingerprint:fingerprint(keys.coordinator.publicKey),claimHash,projects:[run.project.id],capabilities:[request.capability]}
 return {keys,request,claim,proof,policy,requestHash,claimHash,
  input:{signedRequest:signRemoteEnvelope(request,"ppo-control-plane",keys.coordinator.privateKey),signedClaim:signRemoteEnvelope(claim,request.workerId,keys.worker.privateKey),signedProof:signOfflineHostActionProof(proof,keys.host.privateKey)},
  config:{coordinatorPublicKey:keys.coordinator.publicKey,workerPublicKey:keys.worker.publicKey,hostPublicKey:keys.host.publicKey}}
}
