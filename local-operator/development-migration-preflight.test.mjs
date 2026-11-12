import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createDevelopmentRun, transitionDevelopmentRun, DEVELOPMENT_RUN_STORE_DIR,
  inspectDevelopmentRunReadOnly } from "./development-run-state.mjs"
import { rehearseSyntheticMigrationPreflight } from "./development-migration-preflight.mjs"

const mode="synthetic-migration-preflight-only"
const digest=b=>createHash("sha256").update(b).digest("hex")
const scan=entries=>rehearseSyntheticMigrationPreflight({mode,entries})
const canonical=id=>"records/"+id+".json"
const marker=(id,v)=>"versions/"+id+"/"+String(v).padStart(6,"0")+".json"
async function fixture(t,{project="rivora",seed=3,actor="test-agent",task="RIC-157 shared authority synthetic: migration fixture",terminal=false}={}){
  const dir=await mkdtemp(join(tmpdir(),"ppo-synthetic-migration-"))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  let time=Date.parse("2026-01-01T00:00:00.000Z")
  const opts={writeDataDir:dir,randomBytesImpl:n=>Buffer.alloc(n,seed),now:()=>new Date(time+=1000)}
  const initial=await createDevelopmentRun({projectId:project,task,baseSha:"a".repeat(40),
    headSha:"b".repeat(40),branch:"feature/migration-fixture",actor:"test-agent"},opts)
  const next=await transitionDevelopmentRun(initial.runId,{expectedVersion:0,
    status:terminal?"cancelled":"planning_in_progress",actor},opts)
  const root=join(dir,DEVELOPMENT_RUN_STORE_DIR)
  // The test captures only its freshly generated scratch store. The actual
  // preflight module cannot enumerate paths or read/write any filesystem.
  async function snapshot(){
    const result=[]
    for(const file of await readdir(join(root,"records")))result.push({relativePath:"records/"+file,bytes:await readFile(join(root,"records",file))})
    for(const id of await readdir(join(root,"versions"))){
      for(const file of await readdir(join(root,"versions",id)))result.push({relativePath:"versions/"+id+"/"+file,bytes:await readFile(join(root,"versions",id,file))})
    }
    return result
  }
  return {dir,root,initial,next,snapshot,entries:await snapshot()}
}
function replace(entries,path,bytes){return entries.map(e=>e.relativePath===path?{relativePath:path,bytes}:e)}
function get(entries,path){return entries.find(e=>e.relativePath===path).bytes}

test("exact source inventory binds every marker and canonical byte without changing the source",async t=>{
  const f=await fixture(t)
  const result=scan(f.entries)
  assert.equal(result.readyForRehearsal,true)
  assert.equal(result.importAuthorized,false)
  assert.equal(result.cutoverAuthorized,false)
  assert.equal(result.fileCount,3)
  assert.equal(result.diagnostics.invalid,0)
  const r=result.runs[0]
  assert.deepEqual(r.latest,{version:1,historyHash:f.next.historyHash,projectId:"rivora",status:"planning_in_progress",terminal:false})
  assert.equal(r.canonical.sha256,digest(get(f.entries,canonical(f.next.runId))))
  assert.deepEqual(r.markers.map(m=>m.sha256),[0,1].map(v=>digest(get(f.entries,marker(f.next.runId,v)))))
  assert.deepEqual(await f.snapshot(),f.entries)
  assert.equal(scan([...f.entries].reverse()).inventoryHash,result.inventoryHash)
  // Changing only whitespace must change exact source provenance even though
  // normalized JSON values and canonical history still match.
  const alternate=replace(f.entries,canonical(f.next.runId),Buffer.from(JSON.stringify(f.next,null,2)))
  const modified=scan(alternate)
  assert.equal(modified.readyForRehearsal,true)
  assert.notEqual(modified.inventoryHash,result.inventoryHash)
  assert.deepEqual(modified.runs[0].latest,r.latest)
  assert.equal((await inspectDevelopmentRunReadOnly(f.next.runId,{writeDataDir:f.dir})).canonicalState,"canonical_current")
})

test("missing/behind canonical, marker gaps and valid divergent histories are blocked",async t=>{
  const f=await fixture(t)
  const id=f.next.runId
  const base=get(f.entries,marker(id,0))
  const cases=[
    [f.entries.filter(e=>e.relativePath!==canonical(id)),"canonical_missing"],
    [replace(f.entries,canonical(id),base),"canonical_behind"],
    [f.entries.filter(e=>e.relativePath!==marker(id,0)),"marker_gap_or_version_mismatch"],
    [f.entries.filter(e=>e.relativePath===canonical(id)),"marker_missing"],
    [replace(f.entries,marker(id,0),Buffer.from("{bad")),"record_invalid"],
    [[...f.entries,f.entries[0]],"duplicate_path"]
  ]
  const fork=await fixture(t,{seed:3,actor:"alternative-agent"})
  assert.equal(fork.next.runId,id)
  assert.notEqual(fork.next.historyHash,f.next.historyHash)
  cases.push([replace(f.entries,canonical(id),get(fork.entries,canonical(id))),"canonical_conflict"])
  // A valid higher-version snapshot built from a different lower history.
  const opts={writeDataDir:fork.dir,now:()=>new Date("2026-01-01T00:00:10Z")}
  const fork2=await transitionDevelopmentRun(id,{expectedVersion:1,status:"planned",actor:"alternative-agent"},opts)
  const f2=await fork.snapshot()
  cases.push([[...replace(f.entries,canonical(id),get(f2,canonical(id))),{
    relativePath:marker(id,2),bytes:get(f2,marker(id,2))
  }],"marker_history_conflict"])
  assert.equal(fork2.version,2)
  for(const [entries,code] of cases){
    const result=scan(entries)
    assert.equal(result.readyForRehearsal,false,code)
    assert.equal(result.runs[0].code,code)
    assert.equal(result.runs[0].recoveryRequired,true)
    assert.equal(result.fileCount,entries.length)
    assert.equal(result.importAuthorized,false)
  }
  assert.deepEqual(await f.snapshot(),f.entries)
})

test("scope, malformed UTF-8, unsupported encodings and unknown paths cannot be silently dropped",async t=>{
  const outside=await fixture(t,{task:"ordinary non-synthetic record"})
  assert.equal(scan(outside.entries).runs[0].code,"out_of_scope")
  const unsupported=await fixture(t,{task:"RIC-157 shared authority synthetic: lone surrogate \ud800"})
  assert.equal(scan(unsupported.entries).runs[0].code,"unsupported_encoding")
  const f=await fixture(t)
  for(const [key,value] of [["extra","\u0000"],["extra","\ud800"],["\ud800","valid"],["\u0000","valid"]]){
    for(const path of [canonical(f.next.runId),marker(f.next.runId,1)]){
      const record=JSON.parse(get(f.entries,path).toString("utf8"))
      record.project[key]=value
      const changed=replace(f.entries,path,Buffer.from(JSON.stringify(record)))
      const result=scan(changed)
      assert.equal(result.runs[0].code,"unsupported_encoding")
      assert.equal(result.readyForRehearsal,false)
    }
  }
  const raw=get(f.entries,canonical(f.next.runId)).toString("utf8")
  const overwritten=raw.replace('"project":{','"project":{"extra":"\\u0000","extra":"valid",')
  assert.notEqual(overwritten,raw)
  assert.equal(scan(replace(f.entries,canonical(f.next.runId),Buffer.from(overwritten))).runs[0].code,"unsupported_encoding")
  const unicode=JSON.parse(raw)
  unicode.project.extra="Valid supplementary character 😀"
  assert.equal(scan(replace(f.entries,canonical(f.next.runId),Buffer.from(JSON.stringify(unicode)))).readyForRehearsal,true)
  const invalid=replace(f.entries,canonical(f.next.runId),Buffer.from([0xc3,0x28]))
  assert.equal(scan(invalid).runs[0].code,"record_invalid")
  const unknown={relativePath:"../../private-name",bytes:Buffer.from("PRIVATE_SYNTHETIC_BYTES")}
  const result=scan([...f.entries,unknown])
  assert.equal(result.readyForRehearsal,false)
  assert.equal(result.unknown.length,1)
  assert.equal(result.unknown[0].sha256,digest(unknown.bytes))
  assert.equal(JSON.stringify(result).includes("private-name"),false)
  assert.equal(JSON.stringify(result).includes("PRIVATE_SYNTHETIC_BYTES"),false)
  assert.equal(scan([]).readyForRehearsal,false)
  assert.equal(scan([...f.entries,{relativePath:canonical(f.next.runId)+"\n",bytes:f.entries[0].bytes}]).unknown.length,1)
  assert.throws(()=>scan([{relativePath:"records/anything",bytes:Buffer.alloc(131073)}]))
  assert.throws(()=>rehearseSyntheticMigrationPreflight({mode:"production",entries:f.entries}))
})

test("complete source scan preserves WIP policy and legacy catalog truncation hold",async t=>{
  const a=await fixture(t,{project:"rivora",seed:1})
  const b=await fixture(t,{project:"kynexa",seed:2})
  const c=await fixture(t,{project:"portfolio",seed:3})
  const dup=await fixture(t,{project:"rivora",seed:4})
  assert.equal(scan([...a.entries,...b.entries]).readyForRehearsal,true)
  const over=scan([...a.entries,...b.entries,...c.entries])
  assert.equal(over.diagnostics.overWipLimit,true)
  assert.equal(over.readyForRehearsal,false)
  assert.equal(scan([...a.entries,...dup.entries]).diagnostics.duplicateActiveProject,true)
  const all=[]
  for(let i=10;i<31;i++){
    const closed=await fixture(t,{seed:i,terminal:true})
    all.push(...closed.entries)
  }
  const truncated=scan(all)
  assert.equal(truncated.diagnostics.runs,21)
  assert.equal(truncated.diagnostics.invalid,0)
  assert.equal(truncated.diagnostics.legacyCatalogTruncated,true)
  assert.equal(truncated.readyForRehearsal,false)
  assert.deepEqual(truncated.diagnostics.activeProjects,[])
})
