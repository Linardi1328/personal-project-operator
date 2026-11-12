import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import test from "node:test"
import { createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL as S } from "./development-ownership-rehearsal.mjs"
const mode="synthetic-ownership-cutover-rehearsal-only"
const sha=s=>createHash("sha256").update(s).digest("hex")
function transport(){
  const owner={target_id:randomUUID(),source_id:null,generation:"1",phase:"empty",fence:null,attempt:null,manifest:null,imported:false}
  let files=[],rev="0",key=null,digest=null,lostAction=null,receiptOverride=null,readOverride=null
  const receipts=new Map(),calls=[]
  const query=async(s,a)=>{
    calls.push({s,a})
    if(s===S.read||s===S.sourceRead){
      const o={owner:{...owner},files:structuredClone(files),revision:rev,digest,parity:false,catalog:{revision:rev,code:"ok",entries:[]}}
      if(s===S.sourceRead){o.catalog=null;o.parity=null}
      return {rows:[{observation:readOverride&&s===S.read?readOverride(o):o}]}
    }
    if(s===S.receipt)return {rows:[{evidence:receiptOverride?receiptOverride(receipts.get(a[0])??null):receipts.get(a[0])??null}]}
    assert.ok([S.control,S.source].includes(s))
    const r=JSON.parse(a[0])
    if(receipts.size>=999&&r.action!=="abort")return {rows:[{evidence:{accepted:false}}]}
    if(r.action==="seed"){
      owner.source_id=randomUUID();owner.phase="source";key=randomUUID();files=r.files.map(({path,bytesBase64})=>({path,bytesBase64}));digest=r.manifest;owner.manifest=digest;rev="1"
    }else if(r.action==="source_commit"){
      key=randomUUID();rev=String(BigInt(rev)+1n)
    }else if(r.action==="freeze"){
      owner.phase="held";owner.generation="2";owner.fence=randomUUID();owner.attempt=r.operationId;key=null;rev="2"
    }else if(r.action==="import"){
      owner.imported=true;rev="3"
    }else if(r.action==="abort"){
      owner.phase="aborted";owner.generation="3";key=randomUUID();rev="4"
    }else throw Error("unexpected test mutation")
    const e={operationId:r.operationId,requestHash:sha(a[0]),action:r.action,accepted:r.action!=="source_commit",sourceId:owner.source_id,targetId:owner.target_id,
      generation:owner.generation,phase:owner.phase,fence:owner.fence,attempt:owner.attempt,manifest:digest,imported:owner.imported,key,revision:rev}
    receipts.set(r.operationId,e)
    if(r.action===lostAction)throw Error("synthetic lost ack")
    return {rows:[{evidence:structuredClone(e)}]}
  }
  return {query,calls,owner,freezeLost:()=>{lostAction="freeze"},loseAction:action=>{lostAction=action},setReceipt:fn=>{receiptOverride=fn},setRead:fn=>{readOverride=fn}}
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

for(const kind of ["invalid","truncated"]){
  test("held imported "+kind+" target cannot activate but may explicitly abort",async()=>{
    const h=transport(),c=createSyntheticOwnershipRehearsal({mode,query:h.query})
    await c.seed();await c.freeze();await c.import()
    const before=await c.observe(),id=JSON.parse(Buffer.from(before.files[0].bytesBase64,"base64")).runId
    h.setRead(o=>({...o,catalog:kind==="truncated"?{revision:o.revision,code:"catalog_truncated",entries:[]}:
      {revision:o.revision,code:"ok",entries:[{path:"records/"+id+".json",serialized:"{}"}]}}))
    await assert.rejects(c.activate(),e=>e.code==="CATALOG_INVALID")
    const receipt=await c.abort()
    assert.equal(receipt.phase,"aborted");assert.equal(receipt.generation,"3");assert.equal(receipt.imported,true)
    assert.equal((await c.sourceAuthority.readRun(id)).runId,id)
    assert.equal(h.calls.filter(c=>c.s===S.control).length,4)
  })
}

test("client submissions preserve a bounded final abort slot even after rejected operations",async()=>{
  const h=transport(),c=createSyntheticOwnershipRehearsal({mode,query:h.query})
  await c.seed();const o=await c.observe(),r=JSON.parse(Buffer.from(o.files[0].bytesBase64,"base64"))
  for(let i=0;i<997;i++)assert.equal(await c.sourceAuthority.commitRecord(JSON.stringify(r),r.version-1,r.history.at(-1).previousHistoryHash),false)
  await c.freeze() // 999 submitted/receipted operations
  await assert.rejects(c.import()) // must not consume the local abort slot
  const aborted=await c.abort()
  assert.equal(aborted.phase,"aborted");assert.equal(aborted.generation,"3")
})
test("delayed reconciliation cannot replace a newer committed abort permit",async()=>{
  const h=transport();let release,started,delay=false
  const blocked=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{started=resolve})
  const c=createSyntheticOwnershipRehearsal({mode,query:async(s,a)=>{
    const result=await h.query(s,a)
    if(s===S.receipt&&delay){delay=false;started();await blocked}
    return result
  }})
  await c.seed();await c.freeze();h.loseAction("import");await assert.rejects(c.import())
  delay=true;const reconciling=c.reconcile();await ready
  try{
    assert.equal((await c.abort()).phase,"aborted")
    release()
    assert.equal((await reconciling).status,"superseded")
    assert.equal(c.pending(),null)
    const id=JSON.parse(Buffer.from((await c.observe()).files[0].bytesBase64,"base64")).runId
    assert.equal((await c.sourceAuthority.readRun(id)).runId,id)
  }finally{release();await reconciling.catch(()=>{})}
})
test("reconciled CAS/WIP rejection is explicit and retains committed evidence",async()=>{
  const h=transport(),c=createSyntheticOwnershipRehearsal({mode,query:h.query})
  await c.seed();const o=await c.observe(),r=JSON.parse(Buffer.from(o.files[0].bytesBase64,"base64"))
  assert.equal(await c.sourceAuthority.commitRecord(JSON.stringify(r),r.version-1,r.history.at(-1).previousHistoryHash),false)
  const reconciled=await c.reconcile(c.operation())
  assert.equal(reconciled.status,"rejected");assert.equal(reconciled.evidence.accepted,false)
  assert.equal(c.pending(),null)
})
test("delayed import acknowledgment cannot replace a newer committed abort permit",async()=>{
  const h=transport();let release,started
  const blocked=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{started=resolve})
  const c=createSyntheticOwnershipRehearsal({mode,query:async(s,a)=>{
    const result=await h.query(s,a)
    if(s===S.control&&JSON.parse(a[0]).action==="import"){started();await blocked}
    return result
  }})
  await c.seed();await c.freeze()
  const importing=c.import();const settled=importing.catch(error=>error);await ready
  try{
    assert.equal((await c.abort()).phase,"aborted")
    release()
    const result=await settled
    assert.equal(result.code,"REHEARSAL_COMMIT_UNKNOWN")
    assert.equal(c.pending(),null)
    const id=JSON.parse(Buffer.from((await c.observe()).files[0].bytesBase64,"base64")).runId
    assert.equal((await c.sourceAuthority.readRun(id)).runId,id)
  }finally{release();await settled}
})
