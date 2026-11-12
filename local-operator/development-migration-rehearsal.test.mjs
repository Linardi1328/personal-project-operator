import assert from "node:assert/strict"
import test from "node:test"
import { captureSyntheticMigrationRehearsal, createSyntheticMigrationImporter } from "./development-migration-rehearsal.mjs"
import { rehearseSyntheticMigrationPreflight } from "./development-migration-preflight.mjs"

const mode="synthetic-migration-import-rehearsal-only"
test("fixed synthetic capture and importer verify exact archive without retry or fallback",async()=>{
  await assert.rejects(captureSyntheticMigrationRehearsal({mode:"production"}))
  assert.throws(()=>createSyntheticMigrationImporter({mode:"production",query:async()=>{}}))
  const snapshot=await captureSyntheticMigrationRehearsal({mode})
  assert.equal(snapshot.runCount,3)
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.files)&&snapshot.files.every(Object.isFrozen))
  const preflight=files=>rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries:files.map(f=>({relativePath:f.path,bytes:Buffer.from(f.bytesBase64,"base64")}))})
  assert.equal(preflight(snapshot.files).inventoryHash,snapshot.inventoryHash)
  let calls=0
  const importer=createSyntheticMigrationImporter({mode,query:async(statement,params)=>{
    calls++
    if(statement.includes("import_synthetic_snapshot")){
      assert.equal(params[0],snapshot.inventoryHash)
      assert.deepEqual(JSON.parse(params[1]),snapshot.files)
      return {rows:[{accepted:true}]}
    }
    return {rows:[{archive:snapshot.files}]}
  }})
  for(const bad of [
    {...snapshot,runCount:4},
    {...snapshot,inventoryHash:"a".repeat(64)},
    {...snapshot,files:snapshot.files.slice(1)},
    {...snapshot,files:[{...snapshot.files[0],bytesBase64:snapshot.files[0].bytesBase64+"\n"},...snapshot.files.slice(1)]}
  ])await assert.rejects(importer.rehearse(bad))
  assert.equal(calls,0)
  const receipt=await importer.rehearse(snapshot)
  assert.equal(receipt.rehearsalCommitted,true)
  assert.equal(receipt.importAuthorized,false)
  assert.equal(receipt.cutoverAuthorized,false)
  assert.deepEqual(await importer.readArchive(snapshot.inventoryHash),snapshot.files)
  assert.equal(calls,2)
  // Correctly hashed but normalization-changing raw extension is denied.
  const files=snapshot.files.map((file,i)=>{
    if(i!==0)return file
    const raw=JSON.parse(Buffer.from(file.bytesBase64,"base64"))
    raw.project.extra="discarded"
    return {...file,bytesBase64:Buffer.from(JSON.stringify(raw)).toString("base64")}
  })
  const altered=preflight(files)
  assert.equal(altered.readyForRehearsal,true)
  await assert.rejects(importer.rehearse({...snapshot,files,inventoryHash:altered.inventoryHash}))
  assert.equal(calls,2)
  for(const bad of [undefined,1,"true",new Error("lost acknowledgement")]){
    let attempts=0
    const unknown=createSyntheticMigrationImporter({mode,query:async()=>{
      attempts++
      if(bad instanceof Error)throw bad
      return {rows:[{accepted:bad}]}
    }})
    await assert.rejects(unknown.rehearse(snapshot),e=>e.code==="MIGRATION_COMMIT_UNKNOWN"&&e.inventoryHash===snapshot.inventoryHash)
    assert.equal(attempts,1)
  }
  const corrupted=createSyntheticMigrationImporter({mode,query:async()=>({rows:[{archive:snapshot.files.slice(1)}]})})
  await assert.rejects(corrupted.readArchive(snapshot.inventoryHash))
})
