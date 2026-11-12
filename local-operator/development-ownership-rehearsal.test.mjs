import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import test from "node:test"
import { createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL as S } from "./development-ownership-rehearsal.mjs"
const mode="synthetic-ownership-cutover-rehearsal-only"
const sha=s=>createHash("sha256").update(s).digest("hex")
function transport(){
  const owner={target_id:randomUUID(),source_id:null,generation:"1",phase:"empty",fence:null,attempt:null,manifest:null,imported:false}
  let files=[],rev="0",key=null,digest=null,freezeFailure=false,receiptOverride=null,readOverride=null
  const receipts=new Map(),calls=[]
  const query=async(s,a)=>{
    calls.push({s,a})
    if(s===S.read){
      const o={owner:{...owner},files:structuredClone(files),revision:rev,digest,parity:false,catalog:{revision:rev,code:"ok",entries:[]}}
      return {rows:[{observation:readOverride?readOverride(o):o}]}
    }
    if(s===S.receipt)return {rows:[{evidence:receiptOverride?receiptOverride(receipts.get(a[0])??null):receipts.get(a[0])??null}]}
    assert.equal(s,S.control)
    const r=JSON.parse(a[0])
    if(r.action==="seed"){
      owner.source_id=randomUUID();owner.phase="source";key=randomUUID();files=r.files.map(({path,bytesBase64})=>({path,bytesBase64}));digest=r.manifest;owner.manifest=digest;rev="1"
    }else if(r.action==="freeze"){
      owner.phase="held";owner.generation="2";owner.fence=randomUUID();owner.attempt=r.operationId;key=null;rev="2"
    }else throw Error("unexpected test mutation")
    const e={operationId:r.operationId,requestHash:sha(a[0]),action:r.action,accepted:true,sourceId:owner.source_id,targetId:owner.target_id,
      generation:owner.generation,phase:owner.phase,fence:owner.fence,attempt:owner.attempt,manifest:digest,imported:false,key,revision:rev}
    receipts.set(r.operationId,e)
    if(r.action==="freeze"&&freezeFailure)throw Error("synthetic lost ack")
    return {rows:[{evidence:structuredClone(e)}]}
  }
  return {query,calls,owner,freezeLost:()=>{freezeFailure=true},setReceipt:fn=>{receiptOverride=fn},setRead:fn=>{readOverride=fn}}
}
test("ownership rehearsal requires explicit mode and trusted transport",()=>{
  assert.throws(()=>createSyntheticOwnershipRehearsal())
  assert.throws(()=>createSyntheticOwnershipRehearsal({mode:"production",query:async()=>{}}))
})
test("lost acknowledgment latches both writer interfaces; only positive exact receipt clears it",async()=>{
  const h=transport(),c=createSyntheticOwnershipRehearsal({mode,query:h.query})
  await c.seed();h.freezeLost()
  let d
  await assert.rejects(c.freeze(),e=>{d=e.operation;return e.code==="REHEARSAL_COMMIT_UNKNOWN"})
  assert.deepEqual(c.pending(),d)
  const mutations=()=>h.calls.filter(c=>c.s===S.control).length
  assert.equal(mutations(),2)
  await assert.rejects(c.freeze(),e=>e.code==="REHEARSAL_UNCERTAIN")
  await assert.rejects(c.sourceAuthority.readRun("A".repeat(43)))
  await assert.rejects(c.targetAuthority.readRun("A".repeat(43)))
  assert.equal(mutations(),2)
  h.setReceipt(()=>null)
  assert.equal((await c.reconcile()).status,"unknown")
  assert.deepEqual(c.pending(),d)
  await assert.rejects(c.reconcile({...d,requestHash:"f".repeat(64)}))
  h.setReceipt(null)
  assert.equal((await c.reconcile()).status,"committed")
  assert.equal(c.pending(),null)
  assert.equal((await c.observe()).owner.phase,"held")
  assert.equal(mutations(),2) // reconciliation never resubmits a mutation
})
test("a restarted client's absent receipt is uncertainty, never initialization permission",async()=>{
  const h=transport(),c=createSyntheticOwnershipRehearsal({mode,query:h.query})
  await c.seed();h.freezeLost();await assert.rejects(c.freeze())
  const d=c.pending();h.setReceipt(()=>null)
  const restart=createSyntheticOwnershipRehearsal({mode,query:h.query})
  assert.equal((await restart.reconcile(JSON.parse(JSON.stringify(d)))).status,"unknown")
  assert.deepEqual(restart.pending(),d)
  await assert.rejects(restart.seed())
  await assert.rejects(restart.sourceAuthority.readRun("A".repeat(43)))
})
test("malformed or rebound committed evidence never grants a writer capability",async()=>{
  for(const corrupt of [e=>({...e,targetId:randomUUID()}),e=>({...e,sourceId:[e.sourceId]}),e=>({...e,generation:2}),
    e=>({...e,requestHash:"f".repeat(64)}),e=>({...e,manifest:"f".repeat(64)}),e=>({...e,attempt:randomUUID()}),e=>({...e,key:randomUUID()})]){
    const h=transport(),c=createSyntheticOwnershipRehearsal({mode,query:h.query});await c.seed();h.freezeLost();await assert.rejects(c.freeze())
    h.setReceipt(e=>corrupt(e));await assert.rejects(c.reconcile())
    assert.ok(c.pending());await assert.rejects(c.targetAuthority.readRun("A".repeat(43)))
  }
})
test("authority identity is distinct from revision; typed bounded pins fail closed",async()=>{
  const h=transport(),c=createSyntheticOwnershipRehearsal({mode,query:h.query});await c.seed()
  const rev=(await c.observe()).revision
  h.setRead(o=>({...o,owner:{...o.owner,target_id:randomUUID()}}))
  await assert.rejects(c.observe(),e=>e.code==="AUTHORITY_REPLACED")
  for(const mutate of [o=>({...o,revision:Number(rev)}),o=>({...o,owner:{...o.owner,generation:"1000000001"}}),
    o=>({...o,owner:{...o.owner,target_id:[o.owner.target_id]}}),o=>({...o,files:Array(2101).fill(null)})]){
    h.setRead(mutate);await assert.rejects(c.observe())
  }
})
