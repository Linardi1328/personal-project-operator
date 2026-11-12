import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createDevelopmentRun, readDevelopmentRun, transitionDevelopmentRun,
  createIsolatedCanonicalRunState } from "./development-run-state.mjs"

const mode="isolated-postgres-canonical-authority"
const input={projectId:"rivora",task:"RIC-157 shared authority synthetic: boundary unit fixture",
  baseSha:"a".repeat(40),headSha:"b".repeat(40),branch:"feature/authority-unit",actor:"test-agent"}
const hasCode=code=>error=>error?.code===code

test("existing filesystem APIs do not select a supplied authority option",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"ppo-file-authority-boundary-"))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  let calls=0
  const authority={readRun(){calls++;throw Error("must not run")},commitRecord(){calls++;throw Error("must not run")}}
  const opts={writeDataDir:dir,authority,mode}
  const created=await createDevelopmentRun(input,opts)
  const next=await transitionDevelopmentRun(created.runId,{expectedVersion:0,status:"planning_in_progress",actor:"test-agent"},opts)
  assert.deepEqual(await readDevelopmentRun(created.runId,opts),next)
  assert.equal(calls,0)
  assert.ok((await readdir(dir)).length>0)
})

test("isolated writer denies non-synthetic state and does not retry uncertain or rejected commits",async()=>{
  assert.throws(()=>createIsolatedCanonicalRunState({mode:"production",authority:{}}),hasCode("AUTHORITY_SCOPE_DENIED"))
  let calls=0,serialized=null
  const authority={async readRun(){return null},async commitRecord(payload,version,hash){
    calls++;serialized=JSON.parse(payload);assert.equal(version,-1);assert.equal(hash,null);return false
  }}
  const state=createIsolatedCanonicalRunState({mode,authority})
  await assert.rejects(state.create({...input,task:"ordinary task"}),hasCode("AUTHORITY_SCOPE_DENIED"))
  assert.equal(calls,0)
  await assert.rejects(state.create(input),hasCode("AUTHORITY_COMMIT_REJECTED"))
  assert.equal(calls,1)
  await assert.rejects(state.read(serialized.runId),hasCode("RUN_NOT_FOUND"))
  // Capture the selected capability once; a subsequent mutation of the
  // caller's object cannot redirect operations to another store.
  authority.commitRecord=()=>{throw Error("replacement called")}
  await assert.rejects(state.create(input),hasCode("AUTHORITY_COMMIT_REJECTED"))
  assert.equal(calls,2)
  for(const result of [undefined,1,"true"]){
    let attempts=0
    const unknown=createIsolatedCanonicalRunState({mode,authority:{readRun:async()=>null,
      commitRecord:async()=>{attempts++;return result}}})
    await assert.rejects(unknown.create(input),e=>e.code==="AUTHORITY_COMMIT_UNKNOWN"&&e.observation.version===0&&e.stateCommitted!==true)
    assert.equal(attempts,1)
  }
})

test("isolated writer refuses malformed or non-synthetic records returned by trusted transport",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"ppo-authority-malformed-"))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const normal=await createDevelopmentRun({...input,task:"ordinary file fixture"},{writeDataDir:dir})
  let commits=0
  const make=record=>createIsolatedCanonicalRunState({mode,authority:{
    readRun:async()=>record,commitRecord:async()=>{commits++;return true}
  }})
  await assert.rejects(make(normal).transition(normal.runId,{expectedVersion:0,status:"planning_in_progress",actor:"test-agent"}),hasCode("AUTHORITY_SCOPE_DENIED"))
  await assert.rejects(make({...normal,version:7}).read(normal.runId))
  assert.equal(commits,0)
})
