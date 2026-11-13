import test from 'node:test'
import assert from 'node:assert/strict'
import {createCatalogCertifiedQuery,certifyCatalogMutation,ADMISSION_SQL as S} from './development-catalog-certified-query.mjs'
import {captureSyntheticMigrationRehearsal} from './development-migration-rehearsal.mjs'
const source=await captureSyntheticMigrationRehearsal({mode:'synthetic-migration-import-rehearsal-only'})
const snapshot={revision:'0',code:'ok',entries:source.files.map(f=>({path:f.path,serialized:Buffer.from(f.bytesBase64,'base64').toString('utf8')}))}
const empty={revision:'0',code:'ok',entries:[]},token='a'.repeat(64),payload={files:source.files.map(f=>({...f,normalizedBase64:f.bytesBase64}))}
test('explicit trusted verifier transport required',()=>{assert.throws(()=>createCatalogCertifiedQuery());assert.throws(()=>createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:async()=>{}}))})
test('complete existing and prospective semantic validation precede certification',async()=>{
 let certs=0
 const query=async()=>({rows:[{preparation:{before:empty,after:snapshot,token}}]}),verifierQuery=async()=>{certs++;return {rows:[{certified:true}]}}
 assert.equal(await certifyCatalogMutation({query,verifierQuery,kind:'seed',payload}),true);assert.equal(certs,1)
 for(const side of ['before','after'])for(const broken of [{revision:'0',code:'catalog_truncated',entries:[]},{...snapshot,entries:snapshot.entries.map((e,i)=>i?e:{...e,serialized:'{}'})}]){
  certs=0
  assert.equal(await certifyCatalogMutation({query:async()=>({rows:[{preparation:{before:snapshot,after:snapshot,token,[side]:broken}}]}),verifierQuery,kind:'seed',payload}),false)
  assert.equal(certs,0)
 }
})
test('fresh duplicate decoded keys are rejected before normalization or SQL',async()=>{
 let calls=0
 await assert.rejects(certifyCatalogMutation({query:async()=>{calls++},verifierQuery:async()=>{calls++},kind:'direct',payload:{serialized:'{"actor":false,"act\\u006fr":"safe"}'}}))
 assert.equal(calls,0)
})
test('malformed and lost certification acknowledgments never dispatch a mutation or retry',async()=>{
 const commit='SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::text) AS accepted'
 const r=JSON.parse(snapshot.entries.find(e=>e.path.startsWith('records/')).serialized)
 for(const ack of [null,{rows:[]},{rows:[{certified:true},{certified:true}]},{rows:[{certified:'true'}]}]){
  const calls=[]
  const q=createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:async(s)=>{calls.push(s);return {rows:[{preparation:{before:empty,after:snapshot,token}}]}},verifierQuery:async()=>ack})
  await assert.rejects(q(commit,[r.runId,r.version-1,r.history.at(-1).previousHistoryHash,JSON.stringify(r)]))
  assert.deepEqual(calls,[S.prepare])
 }
})
test('source-only abort is not routed through a target catalog certificate',async()=>{
 let called=0
 const q=createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:async()=>{called++;return {rows:[{evidence:{accepted:true}}]}},verifierQuery:async()=>assert.fail('abort certification')})
 await q('SELECT ppo_authority.rehearsal_control($1::text) AS evidence',[JSON.stringify({action:'abort'})]);assert.equal(called,1)
})
