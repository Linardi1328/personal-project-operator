import assert from "node:assert/strict"
import { before, test } from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { captureSyntheticMigrationRehearsal } from "./development-migration-rehearsal.mjs"
import { createPostgresCanonicalCatalog } from "./development-postgres-canonical-catalog.mjs"
import { listDevelopmentRunSummaries, inspectDevelopmentRunSummary } from "./development-run-catalog.mjs"
import { createDevelopmentRun, transitionDevelopmentRun } from "./development-run-state.mjs"

const mode="isolated-postgres-canonical-catalog"
let snapshot,source
before(async()=>{
  source=await captureSyntheticMigrationRehearsal({mode:"synthetic-migration-import-rehearsal-only"})
  snapshot={revision:"18",code:"ok",entries:source.files.map(f=>({path:f.path,record:JSON.parse(Buffer.from(f.bytesBase64,"base64"))}))}
})
const catalog=(value=snapshot)=>createPostgresCanonicalCatalog({mode,query:async(statement,args)=>{
  assert.equal(statement,"SELECT ppo_authority.read_catalog_snapshot() AS snapshot")
  assert.deepEqual(args,[])
  return {rows:[{snapshot:structuredClone(value)}]}
}})
const altered=fn=>{const value=structuredClone(snapshot);fn(value);return catalog(value)}

test("isolated catalog requires explicit mode and transport",()=>{
  assert.throws(()=>createPostgresCanonicalCatalog())
  assert.throws(()=>createPostgresCanonicalCatalog({mode:"production",query:()=>{}}))
})
test("one snapshot validates every version and matches legacy summaries and inspection",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ppo-catalog-parity-"))
  try{
    for(const file of source.files){
      const path=join(dir,"development-runs",file.path)
      await mkdir(dirname(path),{recursive:true})
      await writeFile(path,Buffer.from(file.bytesBase64,"base64"))
    }
    const listed=await catalog().list()
    const legacy=await listDevelopmentRunSummaries({writeDataDir:dir})
    assert.equal(listed.ok,true)
    assert.equal(legacy.ok,true)
    assert.deepEqual(listed.summaries,legacy.summaries)
    for(const s of listed.summaries){
      const inspected=await catalog().inspect(s.runId)
      assert.deepEqual(inspected.summary,(await inspectDevelopmentRunSummary(s.runId,{writeDataDir:dir})).summary)
      assert.equal(inspected.versions.length,s.version+1)
      assert.deepEqual(inspected.record,inspected.versions.at(-1))
    }
  }finally{await rm(dir,{recursive:true,force:true})}
})
test("empty canonical authority is a valid empty catalog, absent inspection is explicit",async()=>{
  const c=catalog({revision:"0",code:"ok",entries:[]})
  assert.deepEqual((await c.list()).summaries,[])
  assert.equal((await c.list()).ok,true)
  assert.equal((await c.inspect("A".repeat(43))).code,"run_not_found")
  assert.equal((await c.inspect("../x")).code,"invalid_run_id")
})
test("revision comparison is exact and fail closed without number coercion",async()=>{
  assert.equal((await catalog().list({expectedRevision:"18"})).ok,true)
  for(const expectedRevision of ["17",18,null,"018","9223372036854775808",{},"-1"]){
    const r=await catalog().list({expectedRevision})
    assert.equal(r.ok,false)
    assert.equal(r.code,"stale_observation")
    assert.deepEqual(r.summaries,[])
  }
})
test("transport failure is bounded unavailable, no retry or raw error disclosure",async()=>{
  let calls=0
  const c=createPostgresCanonicalCatalog({mode,query:async()=>{calls++;throw Error("SENSITIVE_TEST_SENTINEL")}})
  const r=await c.list()
  assert.equal(r.code,"store_unavailable")
  assert.equal(calls,1)
  assert.ok(!JSON.stringify(r).includes("SENSITIVE"))
})
test("malformed, oversized and unrecognized transport envelopes deny",async()=>{
  for(const value of [null,{}, {...snapshot,revision:18},{...snapshot,revision:"01"},{...snapshot,code:"unknown"},
    {...snapshot,entries:Array(10101).fill(null)}, {...snapshot,extension:true},
    {...snapshot,entries:[{path:"records/"+"a".repeat(33*1024*1024),record:{}}]}]){
    assert.equal((await catalog(value).list()).code,"store_unavailable")
  }
  for(const response of [{rows:[]},{rows:[{snapshot}, {snapshot}]},{rows:[{snapshot,extra:true}]}]){
    assert.equal((await createPostgresCanonicalCatalog({mode,query:async()=>response}).list()).code,"store_unavailable")
  }
})
test("missing/gapped/duplicate/corrupt/foreign histories and normalization loss invalidate entire catalog",async()=>{
  for(const change of [
    s=>s.entries.splice(s.entries.findIndex(e=>e.path.startsWith("versions/")),1),
    s=>s.entries.push(s.entries[0]),
    s=>s.entries[0].record.history[0].actor="changed",
    s=>s.entries[0].record.extension="discarded",
    s=>s.entries[0].record.task="real record",
    s=>s.entries[0].path="unexpected",
    s=>s.entries[0].path=s.entries[0].path.replace("records/","versions/"),
    s=>{s.entries=s.entries.filter(e=>!e.path.startsWith("records/"))},
    s=>{const e=s.entries.find(e=>e.path.startsWith("records/"));e.record=structuredClone(s.entries.find(v=>v.path.startsWith("versions/"+e.record.runId+"/")&&v.record.version===0).record)}
  ]){
    const r=await altered(change).list()
    assert.equal(r.code,"catalog_invalid")
    assert.equal(r.ok,false)
    assert.deepEqual(r.summaries,[])
    // A valid run cannot be inspected through an invalid catalog either.
    const id=snapshot.entries[0].record.runId
    assert.equal((await altered(change).inspect(id)).ok,false)
  }
})
test("server truncation returns no partial success",async()=>{
  const r=await catalog({revision:"18",code:"catalog_truncated",entries:[]}).list()
  assert.equal(r.ok,false)
  assert.equal(r.diagnostics.truncated,true)
  assert.deepEqual(r.summaries,[])
})
test("complete valid histories above legacy 20-summary bound remain fail closed",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ppo-catalog-bound-"))
  const entries=[]
  try{
    const options={writeDataDir:dir}
    for(let i=0;i<21;i++){
      const r=await createDevelopmentRun({projectId:"rivora",task:"RIC-157 shared authority synthetic: catalog bound "+i,
        branch:"feature/catalog",baseSha:"a".repeat(40),headSha:"b".repeat(40),actor:"test-agent"},options)
      const end=await transitionDevelopmentRun(r.runId,{expectedVersion:0,status:"cancelled",actor:"test-agent"},options)
      entries.push({path:"records/"+r.runId+".json",record:end},
        {path:"versions/"+r.runId+"/000000.json",record:r},{path:"versions/"+r.runId+"/000001.json",record:end})
    }
    const r=await catalog({revision:"42",code:"ok",entries}).list()
    assert.equal(r.code,"catalog_truncated")
    assert.equal(r.ok,false)
    assert.deepEqual(r.summaries,[])
  }finally{await rm(dir,{recursive:true,force:true})}
})

test("valid same-project and third-project WIP conflicts invalidate observations",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ppo-catalog-wip-"))
  try{
    const options={writeDataDir:dir}
    const additions=[]
    for(const projectId of ["rivora","khlim-assist"]){
      const r=await createDevelopmentRun({projectId,task:"RIC-157 shared authority synthetic: WIP catalog",
        branch:"feature/catalog",baseSha:"a".repeat(40),headSha:"b".repeat(40),actor:"test-agent"},options)
      additions.push({path:"records/"+r.runId+".json",record:r},{path:"versions/"+r.runId+"/000000.json",record:r})
    }
    const third=structuredClone(snapshot)
    third.entries.push(...additions)
    assert.equal((await catalog(third).list()).code,"catalog_invalid")
    // An independent source creates a valid active kynexa record, conflicting
    // with the existing imported kynexa active record without corrupting it.
    const same=await createDevelopmentRun({projectId:"kynexa",task:"RIC-157 shared authority synthetic: same lane",
      branch:"feature/catalog",baseSha:"a".repeat(40),headSha:"b".repeat(40),actor:"test-agent"},options)
    const conflict=structuredClone(snapshot)
    conflict.entries.push({path:"records/"+same.runId+".json",record:same},{path:"versions/"+same.runId+"/000000.json",record:same})
    assert.equal((await catalog(conflict).list()).code,"catalog_invalid")
  }finally{await rm(dir,{recursive:true,force:true})}
})
