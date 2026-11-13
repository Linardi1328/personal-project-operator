import {admissionProfileSql,admissionOwnershipSql} from './phase1gd1-profile.mjs'
import {createSyntheticOwnershipRehearsal} from '../../local-operator/development-ownership-rehearsal.mjs'
import {createSyntheticMigrationImporter,captureSyntheticMigrationRehearsal} from '../../local-operator/development-migration-rehearsal.mjs'
import {rehearseSyntheticMigrationPreflight} from '../../local-operator/development-migration-preflight.mjs'
import {randomUUID} from 'node:crypto'
import {readdir,readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDevelopmentRun,transitionDevelopmentRun,recordDevelopmentRunProgress} from '../../local-operator/development-run-state.mjs'
import {createCatalogCertifiedQuery,ADMISSION_SQL,certifyCatalogMutation} from '../../local-operator/development-catalog-certified-query.mjs'
import {createPostgresCanonicalAuthority} from '../../local-operator/development-postgres-canonical-authority.mjs'
import assert from 'node:assert/strict'
import {createIsolatedCanonicalRunState} from '../../local-operator/development-run-state.mjs'
import {createPostgresCanonicalCatalog} from '../../local-operator/development-postgres-canonical-catalog.mjs'
export async function runAdmissionCases(t,h){
 const {sql,installImportAuthority,dropImportAuthority,query,literals:L}=h
 const bind=(s,a)=>s.replace(/\$([1-4])/gu,(_,i)=>L(a[Number(i)-1]))
 const q=role=>async(s,a)=>({rows:[JSON.parse(await sql("SELECT row_to_json(q) FROM ("+bind(s,a)+") q;",role,70*1024*1024))]})
 const certified=role=>createCatalogCertifiedQuery({mode:"isolated-catalog-certified-authority",query:q(role),verifierQuery:q("ppo_admission_verifier")})
 async function fixture(fn){await installImportAuthority();try{await sql(h.catalogSql);await sql(await admissionProfileSql());const a=createPostgresCanonicalAuthority({mode:'isolated-postgres-canonical-authority',query:certified('ppo_authority_writer')}),state=createIsolatedCanonicalRunState({mode:'isolated-postgres-canonical-authority',authority:a});await fn(a,state,certified('ppo_authority_writer'))}finally{await dropImportAuthority()}}
 const create=state=>state.create({projectId:'rivora',task:'RIC-157 shared authority synthetic: admission integrity',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),branch:'feature/admission'})
 const cancel=(state,r)=>state.transition(r.runId,{expectedVersion:r.version,status:'cancelled',actor:'admission-test'})
 await t.test('H-01 GREEN prospective capacity agreement',()=>fixture(async(a,state)=>{
  for(let i=0;i<19;i++)await cancel(state,await create(state))
  const catalog=createPostgresCanonicalCatalog({mode:'isolated-postgres-canonical-catalog',query:query('ppo_authority_reader')})
  assert.equal((await catalog.list()).ok,true)
  const twentieth=await create(state);assert.equal((await catalog.list()).ok,true);let r=twentieth;for(const status of ['planning_in_progress','planned','implementation_in_progress'])r=await state.transition(r.runId,{expectedVersion:r.version,status,actor:'admission-test'});r=await state.progress(r.runId,{expectedVersion:r.version,status:r.status,actor:'admission-test',reason:'progress at count20'});await cancel(state,r)
  await assert.rejects(create(state))
  const result=await catalog.list();assert.equal(result.ok,true);assert.equal(result.summaries.length,20)
  console.log('GREEN H-01: run21 denied; complete current catalog remains ready at20')
 }))
 await t.test('H-02 GREEN unrelated historical corruption blocks writer',()=>fixture(async(a,state)=>{
  const r=await create(state);await cancel(state,r)
  const catalog=createPostgresCanonicalCatalog({mode:'isolated-postgres-canonical-catalog',query:query('ppo_authority_reader')})
  assert.equal((await catalog.list()).ok,true)
  await sql("ALTER TABLE ppo_authority.run_versions DISABLE TRIGGER immutable_versions; UPDATE ppo_authority.run_versions SET record=jsonb_set(record,'{history,0,actor}','false'::jsonb) WHERE version=0; ALTER TABLE ppo_authority.run_versions ENABLE TRIGGER immutable_versions;")
  assert.equal((await catalog.list()).ok,false)
  const before=await sql('SELECT jsonb_agg(record ORDER BY run_id,version) FROM ppo_authority.run_versions;')
  await assert.rejects(create(state))
  assert.equal(await sql('SELECT jsonb_agg(record ORDER BY run_id,version) FROM ppo_authority.run_versions;'),before)
  console.log('GREEN H-02: complete historical corruption blocks candidate before any mutation')
 }))
 async function candidate(project='rivora'){
  const dir=await mkdtemp(join(tmpdir(),'ppo-admission-candidate-'))
  try{return await createDevelopmentRun({projectId:project,task:'RIC-157 shared authority synthetic: admission candidate',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),branch:'feature/admission'},{writeDataDir:dir})}finally{await rm(dir,{recursive:true,force:true})}
 }
 const payload=r=>({serialized:JSON.stringify(r),expectedVersion:-1,expectedHash:null})
 const commitSQL=r=>'SELECT ppo_authority.commit_run('+[r.runId,-1,null,JSON.stringify(r)].map(L).join(',')+');'
 const attest=r=>certifyCatalogMutation({query:q('ppo_authority_writer'),verifierQuery:q('ppo_admission_verifier'),kind:'direct',payload:payload(r)})
 await t.test('certificates cannot be fabricated rebound or bypassed through legacy functions',()=>fixture(async()=>{
  const a=await candidate(),b=await candidate('kynexa')
  const before=await sql('SELECT count(*) FROM ppo_authority.run_versions;')
  assert.equal(await sql(commitSQL(a),'ppo_authority_writer'),'f')
  await assert.rejects(q('ppo_authority_writer')(ADMISSION_SQL.certify,['a'.repeat(64)]),/permission denied/)
  await assert.rejects(sql('SELECT ppo_authority.admission_commit_core('+[a.runId,-1,null,JSON.stringify(a)].map(L).join(',')+');','ppo_authority_writer'),/permission denied/)
  assert.equal(await attest(a),true)
  assert.equal(await sql(commitSQL(b),'ppo_authority_writer'),'f')
  assert.equal(await sql('SELECT count(*) FROM ppo_authority.run_versions;'),before)
  assert.equal(await sql(commitSQL(a),'ppo_authority_writer'),'t')
  assert.equal(await sql(commitSQL(b),'ppo_authority_writer'),'f')
 }))
 await t.test('independent contenders for final slot and stale RR/serializable observations',()=>fixture(async(a,state)=>{
  for(let i=0;i<19;i++)await cancel(state,await create(state))
  const one=await candidate(),two=await candidate('kynexa');assert.equal(await attest(one),true);assert.equal(await attest(two),true)
  const leader=h.session('admission-final-leader','ppo_authority_writer'),waiter=h.session('admission-final-waiter','ppo_authority_writer'),rr=h.session('admission-rr','ppo_authority_writer'),serial=h.session('admission-serial','ppo_authority_writer')
  try{
   for(const c of [leader,waiter,rr,serial])await c.ready()
   await rr.send('BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT ppo_authority.read_catalog_snapshot() IS NOT NULL;')
   await serial.send('BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT ppo_authority.read_catalog_snapshot() IS NOT NULL;')
   assert.equal(await leader.send('BEGIN;'+commitSQL(one)),'t')
   const waiting=waiter.send(commitSQL(two));const settled=waiting.catch(e=>e)
   await h.blockedBy(waiter,leader);await leader.send('COMMIT;')
   assert.equal(await settled,'f')
   await assert.rejects(rr.send(commitSQL(two)),/40001/);await assert.rejects(serial.send(commitSQL(two)),/40001/)
  }finally{for(const c of [leader,waiter,rr,serial])await c.close()}
  assert.equal(await sql('SELECT count(*) FROM ppo_authority.current_runs;'),'20')
 }))
 await t.test('independent native prospective version and physical byte exhaustion denies atomically',()=>fixture(async()=>{
  const r=await candidate();assert.equal(await attest(r),true)
  // The verifier role can write only a token, not a replacement catalog.
  const p=(await q('ppo_authority_writer')(ADMISSION_SQL.prepare,['direct',JSON.stringify(payload(r))])).rows[0].preparation
  assert.equal(p.after.code,'ok')
  await sql("BEGIN; SET LOCAL ROLE ppo_authority_owner; SELECT ppo_authority.require_admission('direct',"+L(JSON.stringify(payload(r)))+"); ROLLBACK;")
  const size=await sql("SELECT ppo_authority.admission_pack(jsonb_build_array(jsonb_build_object('path','records/x.json','serialized',repeat('x',33554432))))->>'code';")
  assert.equal(size,'catalog_truncated')
  assert.equal(await sql("SELECT ppo_authority.admission_pack((SELECT jsonb_agg(jsonb_build_object('path','versions/x/'||i,'serialized','{}')) FROM generate_series(1,2001) i))->>'code';"),'catalog_truncated')
  assert.equal(await sql('SELECT count(*) FROM ppo_authority.run_versions;'),'0')
 }))

 await t.test('certified import and unknown direct acknowledgment preserve native archive and no retry',()=>fixture(async()=>{
  const mode='synthetic-migration-import-rehearsal-only',snapshot=await captureSyntheticMigrationRehearsal({mode})
  const importer=createSyntheticMigrationImporter({mode,query:certified('ppo_authority_importer')})
  await importer.rehearse(snapshot)
  const archive=await sql("SELECT md5(string_agg(encode(bytes,'hex'),'' ORDER BY path)) FROM ppo_authority.synthetic_import_files;")
  const r=await candidate('portfolio');let calls=0
  const base=certified('ppo_authority_writer'),lost=createPostgresCanonicalAuthority({mode:'isolated-postgres-canonical-authority',query:async(s,args)=>{const result=await base(s,args);if(s.includes('commit_run')){calls++;throw Error('lost after commit')}return result}})
  await assert.rejects(lost.commitRecord(JSON.stringify(r),-1,null));assert.equal(calls,1)
  assert.equal((await lost.readRun(r.runId)).runId,r.runId)
  assert.equal(await sql("SELECT md5(string_agg(encode(bytes,'hex'),'' ORDER BY path)) FROM ppo_authority.synthetic_import_files;"),archive)
 }))
 for(const abort of [false,true])await t.test('certified source/target and safe source-only abort '+abort,()=>fixture(async()=>{
  await sql(await admissionOwnershipSql())
  const raw=(s,args)=>q(s.includes('source_commit')?'ppo_rehearsal_source':s.includes('target_commit')?'ppo_rehearsal_target':'ppo_rehearsal_controller')(s,args)
  const c=createSyntheticOwnershipRehearsal({mode:'synthetic-ownership-cutover-rehearsal-only',query:createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:raw,verifierQuery:q('ppo_admission_verifier')})})
  const seed=await c.seed();const o=await c.observe(),r=o.files.filter(f=>f.path.startsWith('records/')).map(f=>JSON.parse(Buffer.from(f.bytesBase64,'base64'))).find(r=>r.status==='implementation_in_progress')
  if(!abort){
   const next=await candidate('portfolio'),request={action:'source_commit',operationId:randomUUID(),sourceId:seed.sourceId,targetId:seed.targetId,generation:seed.generation,manifest:seed.manifest,key:seed.key,runId:next.runId,expectedVersion:-1,expectedHash:null,serialized:JSON.stringify(next)}
   assert.equal(await certifyCatalogMutation({query:q('ppo_rehearsal_source'),verifierQuery:q('ppo_admission_verifier'),kind:'source_commit',payload:request}),true)
   const call='SELECT ppo_authority.rehearsal_source_commit('+L(JSON.stringify(request))+');'
   assert.equal(JSON.parse(await sql('BEGIN;'+call+' ROLLBACK;','ppo_rehearsal_source')).accepted,true)
   const corrupted=JSON.parse(await sql("BEGIN; ALTER TABLE ppo_authority.rehearsal_source_files DISABLE TRIGGER immutable_source_markers; UPDATE ppo_authority.rehearsal_source_files SET normalized=jsonb_set(normalized::jsonb,'{history,0,actor}','false')::text,bytes=convert_to(jsonb_set(normalized::jsonb,'{history,0,actor}','false')::text,'UTF8') WHERE path LIKE 'versions/%' AND path NOT LIKE '%"+r.runId+"%'; SET LOCAL ROLE ppo_rehearsal_source; "+call+" ROLLBACK;"))
   assert.equal(corrupted.accepted,false)
  }
  const source=await c.source.progress(r.runId,{expectedVersion:r.version,status:r.status,actor:'admission-test',reason:'source certified'})
  await c.freeze();await c.import()
  const archive=await sql("SELECT md5(string_agg(encode(bytes,'hex'),'' ORDER BY path)) FROM ppo_authority.synthetic_import_files;")
  if(abort){
   await sql("INSERT INTO ppo_authority.run_versions SELECT repeat('T',39)||lpad(i::text,4,'0'),0,history_hash,jsonb_set(record,'{runId}',to_jsonb(repeat('T',39)||lpad(i::text,4,'0'))) FROM generate_series(1,101) i CROSS JOIN (SELECT * FROM ppo_authority.run_versions WHERE version=0 LIMIT 1) r;")
   await c.abort();await c.source.progress(r.runId,{expectedVersion:source.version,status:source.status,actor:'admission-test',reason:'safe source-only abort'})
  }else{
   await c.activate();await c.target.progress(r.runId,{expectedVersion:source.version,status:source.status,actor:'admission-test',reason:'target certified'})
   await assert.rejects(c.source.progress(r.runId,{expectedVersion:source.version,status:source.status,actor:'admission-test'}))
  }
  assert.equal(await sql("SELECT md5(string_agg(encode(bytes,'hex'),'' ORDER BY path)) FROM ppo_authority.synthetic_import_files;"),archive)
 }))

 await t.test('native per-run version exhaustion preserves imported complete history and archive',()=>fixture(async(a)=>{
  const dir=await mkdtemp(join(tmpdir(),'ppo-admission-versions-'))
  try{
   const options={writeDataDir:dir};let r=await createDevelopmentRun({projectId:'rivora',task:'RIC-157 shared authority synthetic: complete version capacity',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),branch:'feature/admission'},options)
   for(const status of ['planning_in_progress','planned','implementation_in_progress'])r=await transitionDevelopmentRun(r.runId,{expectedVersion:r.version,status},options)
   while(r.version<99)r=await recordDevelopmentRunProgress(r.runId,{expectedVersion:r.version,status:r.status,reason:'bounded version capacity'},options)
   const entries=[]
   for(const name of await readdir(join(dir,'development-runs','versions',r.runId)))entries.push({relativePath:'versions/'+r.runId+'/'+name,bytes:await readFile(join(dir,'development-runs','versions',r.runId,name))})
   entries.push({relativePath:'records/'+r.runId+'.json',bytes:await readFile(join(dir,'development-runs','records',r.runId+'.json'))})
   const manifest=rehearseSyntheticMigrationPreflight({mode:'synthetic-migration-preflight-only',entries});assert.equal(manifest.readyForRehearsal,true)
   const files=entries.map(e=>({path:e.relativePath,bytesBase64:e.bytes.toString('base64'),normalizedBase64:e.bytes.toString('base64')}))
   const imported=await certified('ppo_authority_importer')('SELECT ppo_authority.import_synthetic_snapshot($1::text,$2::text) AS accepted',[manifest.inventoryHash,JSON.stringify(files)]);assert.equal(imported.rows[0].accepted,true)
   const before=await sql("SELECT md5(jsonb_agg(record ORDER BY run_id,version)::text) FROM ppo_authority.run_versions;")
   await assert.rejects(recordDevelopmentRunProgress(r.runId,{expectedVersion:99,status:r.status,reason:'must exhaust'},options),e=>e.code==='RUN_HISTORY_LIMIT_REACHED')
   const next={...r,version:100}
   const p={serialized:JSON.stringify(next),expectedVersion:99,expectedHash:r.historyHash}
   assert.equal(await certifyCatalogMutation({query:q('ppo_authority_writer'),verifierQuery:q('ppo_admission_verifier'),kind:'direct',payload:p}),false)
   // Privileged negative control: even a deliberately over-trusting verifier
   // cannot remove the independent SQL version guard.
   const prep=(await q('ppo_authority_writer')(ADMISSION_SQL.prepare,['direct',JSON.stringify(p)])).rows[0].preparation
   await q('ppo_admission_verifier')(ADMISSION_SQL.certify,[prep.token])
   assert.equal(await sql('SELECT ppo_authority.commit_run('+[r.runId,99,r.historyHash,JSON.stringify(next)].map(L).join(',')+');','ppo_authority_writer'),'f')
   assert.equal(await sql("SELECT md5(jsonb_agg(record ORDER BY run_id,version)::text) FROM ppo_authority.run_versions;"),before)
   assert.equal(await sql('SELECT count(*) FROM ppo_authority.run_versions;'),'100')
   const archive=await createSyntheticMigrationImporter({mode:'synthetic-migration-import-rehearsal-only',query:certified('ppo_authority_importer')}).readArchive(manifest.inventoryHash)
   assert.equal(archive.length,files.length)
   for(const f of archive)assert.equal(f.bytesBase64,files.find(x=>x.path===f.path).bytesBase64)
  }finally{await rm(dir,{recursive:true,force:true})}
 }))

}
