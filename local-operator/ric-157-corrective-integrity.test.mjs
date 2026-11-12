import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { before, test } from "node:test"
import { captureSyntheticMigrationRehearsal } from "./development-migration-rehearsal.mjs"
import { rehearseSyntheticMigrationPreflight } from "./development-migration-preflight.mjs"
import { createPostgresCanonicalCatalog } from "./development-postgres-canonical-catalog.mjs"
import { createPostgresCanonicalAuthority } from "./development-postgres-canonical-authority.mjs"
import { parseDevelopmentRunRecord } from "./development-run-state.mjs"

let files, id
before(async()=>{
  const source=await captureSyntheticMigrationRehearsal({mode:"synthetic-migration-import-rehearsal-only"})
  files=source.files.map(f=>({path:f.path,serialized:Buffer.from(f.bytesBase64,"base64").toString("utf8")}))
  id=JSON.parse(files.find(f=>f.path.startsWith("records/")).serialized).runId
})
const stable=v=>Array.isArray(v)?"["+v.map(stable).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+stable(v[k])).join(",")+"}":JSON.stringify(v)
function rehash(record){
  let previous=null
  for(const event of record.history){
    event.previousHistoryHash=previous
    delete event.eventHash
    event.eventHash=createHash("sha256").update(stable(event)).digest("hex")
    previous=event.eventHash
  }
  record.historyHash=previous
  return record
}
const scan=entries=>rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:entries.map(e=>({relativePath:e.path,bytes:Buffer.from(e.serialized)}))})
const catalog=entries=>createPostgresCanonicalCatalog({mode:"isolated-postgres-canonical-catalog",query:async()=>({rows:[{snapshot:{revision:"18",code:"ok",entries}}]})})
const target=entries=>JSON.parse(entries.find(e=>e.path==="records/"+id+".json").serialized)
async function writerRejects(serialized){
  let calls=0
  const a=createPostgresCanonicalAuthority({mode:"isolated-postgres-canonical-authority",query:async()=>{calls++;return {rows:[{accepted:true}]}}})
  const r=JSON.parse(serialized),prior=r.history.at(-1).previousHistoryHash
  await assert.rejects(a.commitRecord(serialized,r.version-1,prior))
  assert.equal(calls,0)
}
const cases=[
  ["actor",true],["actor",null],["actor",123],["actor",["synthetic-import"]],
  ["headSha",["b".repeat(40)]],["headSha","B".repeat(40)],["headSha","b".repeat(40)+"\n"],["headSha",42],
  ["branch"," feature/history "],["branch",""],["branch",["feature/history"]],
  ["reason"," padded reason "],["reason",""],["reason",42]
]
for(const [field,value] of cases){
  for(const path of ["parser","preflight","catalog","writer"]){
    test("H-01 "+path+" rejects rehashed historical "+field+" "+JSON.stringify(value),async()=>{
      const entries=files.map(e=>{
        const r=JSON.parse(e.serialized)
        if(r.runId!==id)return {...e}
        r.history[0][field]=value
        return {path:e.path,serialized:JSON.stringify(rehash(r))}
      })
      // All marker prefixes and recomputed hash chains agree. The candidate
      // final event retains its valid actor, refs and canonical summary.
      const r=target(entries),serialized=JSON.stringify(r)
      assert.deepEqual(r.history.slice(0,-1),JSON.parse(entries.find(e=>e.path==="versions/"+id+"/"+String(r.version-1).padStart(6,"0")+".json").serialized).history)
      if(path==="parser")assert.throws(()=>parseDevelopmentRunRecord(serialized))
      if(path==="preflight")assert.equal(scan(entries).readyForRehearsal,false)
      if(path==="catalog")assert.equal((await catalog(entries).list()).code,"catalog_invalid")
      if(path==="writer")await writerRejects(serialized)
    })
  }
}
for(const [name,replace] of [
  ["nested duplicate",s=>s.replace('"project":{','"project":{"id":"wrong",')],
  ["escaped equivalent",s=>s.replace('"actor":','"\\u0061ctor":false,"actor":')],
  ["overwritten malformed",s=>s.replace('"actor":','"actor":{},"actor":')],
  ["nested metadata",s=>s.replace('"large":','"large":false,"large":')]
]){
  for(const path of ["parser","preflight","catalog","writer"]){
    test("M-02 "+path+" rejects "+name+" before normalization",async()=>{
      const entries=files.map(e=>({path:e.path,serialized:replace(e.serialized)}))
      assert.ok(entries.some((e,i)=>e.serialized!==files[i].serialized))
      const serialized=entries.find(e=>e.path==="records/"+id+".json").serialized
      // Last-key-wins JSON values, including all event hashes, are unchanged.
      assert.deepEqual(JSON.parse(serialized),target(files))
      if(path==="parser")assert.throws(()=>parseDevelopmentRunRecord(serialized))
      if(path==="preflight")assert.equal(scan(entries).readyForRehearsal,false)
      if(path==="catalog")assert.equal((await catalog(entries).list()).code,"catalog_invalid")
      if(path==="writer")await writerRejects(serialized)
    })
  }
}
test("legitimate repeated names in separate objects preserve historical compatibility",async()=>{
  assert.equal(scan(files).readyForRehearsal,true)
  assert.equal((await catalog(files).list()).ok,true)
  for(const e of files)assert.doesNotThrow(()=>parseDevelopmentRunRecord(e.serialized))
})
