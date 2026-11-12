import test from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import { signedActionFixture } from "../deployment/authority/action-test-fixture.mjs"
import {createIsolatedPostgresActionVerifier,createIsolatedPostgresActionFence,inspectIsolatedActionConsumption,POSTGRES_ACTION_SQL as S} from "./software-factory-remote-postgres-action-fence.mjs"
const mode="isolated-postgres-action-fencing-only"
const run={runId:"R".repeat(43),version:3,project:{id:"rivora"},branch:"feature/test",baseSha:"a".repeat(40),headSha:"b".repeat(40)}
const operation={ticket:randomUUID(),operationId:randomUUID()}
const e={...operation,consumed:true,fresh:true,targetId:randomUUID(),generation:"3",observedMicros:"1794500000000000",contextHash:"c".repeat(64)}
test("explicit isolation and pinned Ed25519 verifier keys required",()=>{
 assert.throws(()=>createIsolatedPostgresActionFence())
 assert.throws(()=>createIsolatedPostgresActionVerifier({mode,query:async()=>{}}))
})
test("signed request/claim/proof rejection precedes all SQL",async()=>{
 for(const mutate of [x=>{x.signedRequest.signature="a".repeat(86)},x=>{x.signedClaim.signature="a".repeat(86)},x=>{x.signedProof.signature="a".repeat(86)},x=>{x.signedProof.payload.hostEpoch=2}]){
  const f=signedActionFixture(run);f.input=structuredClone(f.input);mutate(f.input);let calls=0
  const v=createIsolatedPostgresActionVerifier({mode,...f.config,query:async()=>{calls++;throw Error()}})
  await assert.rejects(v.register(f.input));assert.equal(calls,0)
 }
})
test("independently signed inconsistent identities, scope and time are denied",async()=>{
 for(const opts of [{changeClaim:c=>{c.runId="S".repeat(43)}},{changeProof:p=>{p.claimHash="d".repeat(64)}},
  {changeProof:p=>{p.actionPath="src-evil/file"}},{changeProof:p=>{p.hostId="real-host"}},
  {changeProof:p=>{p.expiresAt=new Date(Date.now()+55000).toISOString();p.issuedAt=new Date(Date.now()-100).toISOString()},changeRequest:r=>{r.expiresAt=new Date(Date.now()+51000).toISOString()}}]){
  const f=signedActionFixture(run,opts);let calls=0
  await assert.rejects(createIsolatedPostgresActionVerifier({mode,...f.config,query:async()=>{calls++;throw Error()}}).register(f.input));assert.equal(calls,0)
 }
})
test("invalid and truncated complete catalogs never receive verifier attestations",async()=>{
 for(const catalog of [{revision:"1",code:"catalog_truncated",entries:[]},{revision:"1",code:"ok",entries:[{path:"records/"+run.runId+".json",serialized:"{}"}]}]){
  const f=signedActionFixture(run);let writes=0
  const v=createIsolatedPostgresActionVerifier({mode,...f.config,query:async(s)=>{if(s!==S.snapshot)writes++;return {rows:[{snapshot:{phase:"target",targetId:randomUUID(),sourceId:randomUUID(),generation:"3",catalogText:JSON.stringify(catalog),entriesText:JSON.stringify(catalog.entries)}}]}}})
  await assert.rejects(v.register(f.input));assert.equal(writes,0)
 }
})
test("acknowledged diagnostic never grants execution or strict freshness authorization",async()=>{
 const calls=[]
 const c=createIsolatedPostgresActionFence({mode,query:async(s)=>{calls.push(s);return {rows:[{evidence:e}]}}})
 const r=await c.consume(operation)
 assert.equal(r.status,"consumed-diagnostic");assert.equal(r.grant,false);assert.equal(r.canExecute,false);assert.equal(r.releaseAuthorized,false)
 assert.deepEqual(calls,["BEGIN",S.consume,S.precommit,"COMMIT",S.observe])
 await assert.rejects(c.consume(operation))
})
test("expiry before commit rolls back; expiry after acknowledgment preserves diagnostic consumption",async()=>{
 for(const stage of [S.precommit,S.observe]){
  const calls=[]
  const r=await createIsolatedPostgresActionFence({mode,query:async(s)=>{calls.push(s);return {rows:[{evidence:{...e,fresh:s!==stage}}]}}}).consume(operation)
  assert.equal(r.grant,false);assert.equal(r.status,stage===S.precommit?"denied":"expired-or-stale")
  assert.equal(calls.includes("COMMIT"),stage===S.observe);assert.equal(calls.includes("ROLLBACK"),stage===S.precommit)
 }
})
test("unknown responses latch the client, never retry and never infer noncommit",async()=>{
 for(const stage of ["BEGIN",S.consume,S.precommit,"COMMIT",S.observe]){
  const calls=[]
  const c=createIsolatedPostgresActionFence({mode,query:async(s)=>{calls.push(s);if(s===stage)throw Error("lost");return {rows:[{evidence:e}]}}})
  assert.equal((await c.consume(operation)).status,"unknown")
  await assert.rejects(c.consume(operation));assert.equal(calls.filter(s=>s===S.consume).length,stage==="BEGIN"?0:1)
 }
 const absent=await inspectIsolatedActionConsumption({mode,operation,query:async()=>({rows:[{evidence:{consumed:false,fresh:false}}]})})
 assert.equal(absent.status,"unknown");assert.equal(absent.grant,false)
})
test("post-commit evidence cannot be rebound to a different identity or operation",async()=>{
 for(const change of [{targetId:randomUUID()},{generation:"4"},{contextHash:"f".repeat(64)},{operationId:randomUUID()},{observedMicros:"1794499999999999"}]){
  const r=await createIsolatedPostgresActionFence({mode,query:async(s)=>({rows:[{evidence:s===S.observe?{...e,...change}:e}]})}).consume(operation)
  assert.equal(r.status,"unknown");assert.equal(r.grant,false)
 }
})
