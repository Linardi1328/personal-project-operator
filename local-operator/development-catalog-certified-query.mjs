import {parseUniqueJson} from './unique-json.mjs'
import {createPostgresCanonicalCatalog} from './development-postgres-canonical-catalog.mjs'
const one=(r,k)=>{if(!Array.isArray(r?.rows)||r.rows.length!==1||!Object.hasOwn(r.rows[0],k))throw Error('Admission transport invalid.');return r.rows[0][k]}
export const ADMISSION_SQL=Object.freeze({prepare:'SELECT ppo_authority.prepare_admission($1::text,$2::text) AS preparation',certify:'SELECT ppo_authority.certify_admission($1::text) AS certified'})
// Trusted service transport: read/mutation query and independently scoped
// verifierQuery are captured separately. Never grant verifier to a host.
export function createCatalogCertifiedQuery({mode,query,verifierQuery}={}){
 if(mode!=='isolated-catalog-certified-authority'||typeof query!=='function'||typeof verifierQuery!=='function')throw Error('Certified authority required.')
 return async(s,args)=>{
  let kind,payload
  if(s==='SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::text) AS accepted'){kind='direct';payload={serialized:args[3],expectedVersion:args[1],expectedHash:args[2]}}
  else if(s==='SELECT ppo_authority.import_synthetic_snapshot($1::text,$2::text) AS accepted'){kind='import';payload={inventoryHash:args[0],files:JSON.parse(args[1])}}
  else if(['SELECT ppo_authority.rehearsal_control($1::text) AS evidence','SELECT ppo_authority.rehearsal_source_commit($1::text) AS evidence','SELECT ppo_authority.rehearsal_target_commit($1::text) AS evidence'].includes(s)){
   payload=JSON.parse(args[0]);kind=payload.action==='import'?'held_import':payload.action
   if(!['source_commit','target_commit','seed','held_import'].includes(kind))return query(s,args)
  }else return query(s,args)
  if(!await certifyCatalogMutation({query,verifierQuery,kind,payload}))return {rows:[s.includes('rehearsal_')?{evidence:{accepted:false}}:{accepted:false}]}
  return query(s,args)
 }
}

export async function certifyCatalogMutation({query,verifierQuery,kind,payload}){
  if(['direct','source_commit','target_commit'].includes(kind))parseUniqueJson(payload.serialized,{maxBytes:131072})
  if(['import','seed'].includes(kind))for(const file of payload.files)parseUniqueJson(Buffer.from(file.normalizedBase64,'base64').toString('utf8'),{maxBytes:131072})
  const p=one(await query(ADMISSION_SQL.prepare,[kind,JSON.stringify(payload)]),'preparation')
  if(!p||Buffer.byteLength(JSON.stringify(p))>70*1024*1024||typeof p.token!=='string'||!/^[a-f0-9]{64}$/u.test(p.token))throw Error('Admission preparation unavailable.')
  for(const snapshot of [p.before,p.after]){
   const result=await createPostgresCanonicalCatalog({mode:'isolated-postgres-canonical-catalog',query:async()=>({rows:[{snapshot}]})}).list()
   if(!result.ok)return false
  }
  if(one(await verifierQuery(ADMISSION_SQL.certify,[p.token]),'certified')!==true)throw Error('Admission certification unavailable.')
  return true
}
