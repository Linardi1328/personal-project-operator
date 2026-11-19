// RIC-177 causal RED reproduction. Runs against an UNCHANGED checkout supplied
// by PPO_RED_CHECKOUT, a disposable network-none PostgreSQL container and an
// actual ordinary LOGIN identity. Asserts the desired GREEN property; at the
// baseline it is expected to FAIL because raw SQL bypasses the witness.
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp,chmod,rm,readFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
const root=process.env.PPO_RED_CHECKOUT
if(!root?.startsWith('/'))throw Error('PPO_RED_CHECKOUT required')
const m=p=>import('file://'+join(root,p))
const {openExternalIncarnationAnchor}=await m('local-operator/development-external-incarnation-anchor.mjs')
const {createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL:O}=await m('local-operator/development-ownership-rehearsal.mjs')
const {createCatalogCertifiedQuery}=await m('local-operator/development-catalog-certified-query.mjs')
const {createIsolatedPostgresActionVerifier}=await m('local-operator/software-factory-remote-postgres-action-fence.mjs')
const {signedActionFixture}=await m('deployment/authority/action-test-fixture.mjs')
const {admissionProfileSql}=await m('deployment/authority/phase1gd1-profile.mjs')
const container=process.env.PPO_AUTHORITY_TEST_CONTAINER,db='ppo_authority_ci'
if(process.env.CI!=='true'||!/^ppo-authority-ci-[0-9]+-[0-9]+$/u.test(container||''))throw Error('Dedicated disposable authority container required')
const sha=s=>createHash('sha256').update(s).digest('hex')
const L=v=>v===null?'NULL':typeof v==='number'?String(v):"convert_from(decode('"+Buffer.from(v).toString('base64')+"','base64'),'UTF8')"
function docker(args,input,ok=true){const r=spawnSync('docker',['exec','-i',container,...args],{input,encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});if(ok)assert.equal(r.status,0,r.stderr||String(r.error));return r}
const sql=(text,role='postgres')=>docker(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],"SET statement_timeout='15s';SET ROLE "+role+';'+text).stdout.trim()
// Actual LOGIN session (not superuser SET ROLE): session_user is the login.
const asLogin=(login,role,text)=>docker(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-U',login,'-d',db],"\\set VERBOSITY verbose\nSET statement_timeout='15s';SET ROLE "+role+';'+text,false)
const bind=(s,args)=>s.replace(/\$([1-3])/gu,(_,i)=>L(args[Number(i)-1]))
const query=role=>async(s,args)=>({rows:[JSON.parse(sql('SELECT row_to_json(q) FROM ('+bind(s,args)+') q;',role))]})
function checkpoint(){
 const tables=JSON.parse(sql("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='ppo_authority';"))
 const parts=tables.map(name=>"SELECT "+L(name)+" AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ppo_authority."+name+' t')
 return sha(sql("SELECT jsonb_agg(q ORDER BY name)::text FROM ("+parts.join(' UNION ALL ')+') q;'))
}
const dump=()=>docker(['pg_dump','-U','postgres','-d',db,'--schema=ppo_authority']).stdout
const restore=s=>{sql('DROP SCHEMA IF EXISTS ppo_authority CASCADE;');sql(s)}

test('RIC-177 RED: ordinary LOGIN raw SQL after stale restore must be denied while the witness denies',{timeout:120000},async t=>{
 for(const file of ['phase1gb2-canonical-postgres.sql','phase1gb2-synthetic-import.sql','phase1gb2-canonical-catalog.sql','phase1gb2-ownership-rehearsal.sql','phase1gb2c-action-fencing.sql','phase1gb2c2-resource.sql'])sql(await readFile(join(root,'deployment/authority',file),'utf8'))
 sql(await admissionProfileSql({ownership:true}))
 sql('CREATE ROLE ppo_red_consumer_login LOGIN NOINHERIT;GRANT ppo_action_consumer TO ppo_red_consumer_login;CREATE ROLE ppo_red_admin_login LOGIN NOINHERIT;GRANT ppo_action_admin TO ppo_red_admin_login;')
 const path=await realpath(await mkdtemp(join(tmpdir(),'ppo-red-anchor-')));await chmod(path,0o700)
 let witness
 t.after(async()=>{try{await witness?.close()}finally{await rm(path,{recursive:true,force:true});sql('DROP SCHEMA IF EXISTS ppo_authority CASCADE;DROP OWNED BY ppo_authority_owner;DROP ROLE IF EXISTS ppo_red_consumer_login,ppo_red_admin_login,ppo_authority_importer,ppo_authority_reader,ppo_authority_writer,ppo_authority_owner,ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target,ppo_action_admin,ppo_action_verifier,ppo_action_consumer,ppo_resource_verifier,ppo_resource_consumer,ppo_admission_verifier;')}})
 const roles={[O.read]:'ppo_rehearsal_controller',[O.sourceRead]:'ppo_rehearsal_controller',[O.control]:'ppo_rehearsal_controller',[O.receipt]:'ppo_rehearsal_controller',[O.source]:'ppo_rehearsal_source',[O.target]:'ppo_rehearsal_target'}
 const owner=createSyntheticOwnershipRehearsal({mode:'synthetic-ownership-cutover-rehearsal-only',query:(s,a)=>createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:query(roles[s]),verifierQuery:query('ppo_admission_verifier')})(s,a)})
 await owner.seed();await owner.freeze();await owner.import();await owner.activate()
 const observed=await owner.observe(),run=observed.catalog.entries.filter(e=>e.path.startsWith('records/')).map(e=>JSON.parse(e.serialized)).find(r=>r.status==='implementation_in_progress')
 const f=signedActionFixture(run)
 sql('SELECT ppo_authority.configure_action_host('+L(f.proof.hostId)+',0,'+L(JSON.stringify(f.policy))+');','ppo_action_admin')
 const registered=await createIsolatedPostgresActionVerifier({mode:'isolated-postgres-action-fencing-only',query:query('ppo_action_verifier'),...f.config}).register(f.input)
 const o={ticket:registered.ticket,operationId:randomUUID()},raw='SELECT ppo_authority.consume_action('+L(o.ticket)+'::uuid,'+L(o.operationId)+'::uuid);'
 const identity={anchorId:randomUUID(),authorityId:observed.owner.target_id,ownerId:randomUUID()}
 witness=await openExternalIncarnationAnchor({mode:'isolated-external-incarnation-anchor-only',path,pinnedIdentity:identity,initializeCheckpoint:checkpoint()})
 const activate=async()=>{const e=await witness.inspect();return witness.activate({checkpoint:checkpoint(),expectedRecordHash:e.recordHash})}
 const snapshot=dump();await activate()
 // Witness-bound positive control: consume once, record, then revoke host.
 let e=await witness.inspect()
 const reserve=async(kind,input,subject)=>{const b={...identity,incarnation:e.incarnation,instanceId:e.instanceId,checkpoint:checkpoint()},op={operationId:input.operationId,kind,subjectHash:sha(JSON.stringify([kind,subject])),inputHash:sha(JSON.stringify(input))};await witness.reserve({binding:b,operation:op});return {b,op}}
 let r=await reserve('consume-action',o,[f.proof.hostId,f.proof.actionId])
 assert.equal(JSON.parse(asLogin('ppo_red_consumer_login','ppo_action_consumer',raw).stdout.trim()).consumed,true)
 await witness.recordCommitted({binding:r.b,operation:r.op,checkpoint:checkpoint(),receiptHash:sha('consumed')});await activate();e=await witness.inspect()
 const revokeInput={operationId:randomUUID(),hostId:f.proof.hostId,expectedEpoch:1}
 r=await reserve('revoke-host',revokeInput,f.proof.hostId)
 assert.equal(asLogin('ppo_red_admin_login','ppo_action_admin','SELECT ppo_authority.configure_action_host('+L(f.proof.hostId)+',1,'+L(JSON.stringify({...f.policy,status:'revoked'}))+');').stdout.trim(),'2')
 await witness.recordCommitted({binding:r.b,operation:r.op,checkpoint:checkpoint(),receiptHash:sha('revoked')});await activate()
 restore(snapshot)
 assert.equal(sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),'0')
 assert.equal(sql("SELECT policy->>'status' FROM ppo_authority.action_hosts;"),'active')
 // Witness denies the stale state: checkpoint mismatch, retained subject.
 e=await witness.inspect()
 await assert.rejects(witness.reserve({binding:{...identity,incarnation:e.incarnation,instanceId:e.instanceId,checkpoint:checkpoint()},operation:{operationId:randomUUID(),kind:'consume-action',subjectHash:sha('x'),inputHash:sha('y')}}),/denied|quarantined/)
 await assert.rejects(activate(),/denied|quarantined/)
 const before=checkpoint()
 // Desired GREEN property: actual ordinary LOGIN raw consumption is denied before mutation.
 const consumer=asLogin('ppo_red_consumer_login','ppo_action_consumer',raw)
 const admin=asLogin('ppo_red_admin_login','ppo_action_admin','SELECT ppo_authority.configure_action_host('+L(f.proof.hostId)+',1,'+L(JSON.stringify(f.policy))+');')
 const observedOutcome={consumerStatus:consumer.status,consumerStdout:consumer.stdout.trim(),consumerStderr:consumer.stderr.trim(),adminStatus:admin.status,adminStdout:admin.stdout.trim(),adminStderr:admin.stderr.trim(),tombstonesAfter:sql('SELECT count(*) FROM ppo_authority.action_tombstones;'),hostAfter:sql('SELECT epoch||\':\'||(policy->>\'status\') FROM ppo_authority.action_hosts;'),checkpointUnchanged:checkpoint()===before}
 console.log('RIC177_RED_OBSERVED '+JSON.stringify(observedOutcome))
 assert.notEqual(consumer.status,0,'ordinary LOGIN consumed an action the external witness denies')
 assert.match(consumer.stderr,/42501/)
 assert.notEqual(admin.status,0,'ordinary LOGIN reconfigured a host the external witness denies')
 assert.match(admin.stderr,/42501/)
 assert.equal(observedOutcome.checkpointUnchanged,true)
})
