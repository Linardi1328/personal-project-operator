// RIC-177 disposable PostgreSQL + pinned mutual TLS + external witness
// integration. Actual LOGIN identities, actual dump/restore/clone and actual
// HTTPS. Not a production gateway, migration or execution grant.
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {mkdtemp,chmod,rm,readFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {openExternalIncarnationAnchor,EXTERNAL_INCARNATION_LAB_LIMITS} from '../../local-operator/development-external-incarnation-anchor.mjs'
import {createSyntheticOwnershipRehearsal,OWNERSHIP_REHEARSAL_SQL as O} from '../../local-operator/development-ownership-rehearsal.mjs'
import {createCatalogCertifiedQuery} from '../../local-operator/development-catalog-certified-query.mjs'
import {createIsolatedPostgresActionVerifier} from '../../local-operator/software-factory-remote-postgres-action-fence.mjs'
import {signOfflineHostActionProof} from '../../local-operator/software-factory-remote-host-fence.mjs'
import {createIsolatedPinnedService,createIsolatedPinnedClient,serviceLogin} from '../../local-operator/isolated-pinned-service-transport.mjs'
import {createAuthenticatedAuthorityGateway,AUTHORITY_GATEWAY_SQL as G,GATEWAY_RECORD_RESERVE} from '../../local-operator/authenticated-authority-gateway.mjs'
import {signedActionFixture} from './action-test-fixture.mjs'
import {admissionProfileSql} from './phase1gd1-profile.mjs'
import {serviceTlsFixture,finishServiceTestFixture} from './service-transport-test-fixture.mjs'
import {createPostgresTestSession} from './postgres-test-session.mjs'

const container=process.env.PPO_AUTHORITY_TEST_CONTAINER,db='ppo_authority_ci',clone='ppo_authority_clone_ci'
if(process.env.CI!=='true'||!/^ppo-authority-ci-[0-9]+-[0-9]+$/u.test(container||''))throw Error('Dedicated disposable authority container required')
const TM='isolated-pinned-service-transport-only',GM='isolated-authenticated-authority-gateway-only',WM='isolated-external-incarnation-anchor-only'
const sha=s=>createHash('sha256').update(s).digest('hex'),FLAGS={grant:false,canExecute:false,releaseAuthorized:false},APP='ppo-ric177-gateway-ci'
const L=v=>v===null?'NULL':typeof v==='number'?String(v):"convert_from(decode('"+Buffer.from(v).toString('base64')+"','base64'),'UTF8')"
function docker(args,input,ok=true){const r=spawnSync('docker',['exec','-i',container,...args],{input,encoding:'utf8',timeout:20000,maxBuffer:16*1024*1024});if(ok)assert.equal(r.status,0,r.stderr||String(r.error));return r}
const sql=(text,role='postgres',database=db)=>{assert.ok([db,clone].includes(database));return docker(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],"SET statement_timeout='15s';SET ROLE "+role+';'+text).stdout.trim()}
// Actual ordinary LOGIN session: session_user is the login, never a superuser SET ROLE.
const asLogin=(login,text,database=db)=>docker(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',login,'-d',database],"\\set VERBOSITY verbose\nSET statement_timeout='15s';"+text,false)
const bind=(s,a)=>s.replace(/\$([1-4])/gu,(_,i)=>L(a[Number(i)-1]))
const query=role=>async(s,a)=>({rows:[JSON.parse(sql('SELECT row_to_json(q) FROM ('+bind(s,a)+') q;',role))]})
// Independent JS checkpoint (identical to the 2C laboratory) cross-checks the SQL one.
function checkpoint(database=db){
 const tables=JSON.parse(sql("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='ppo_authority';",'postgres',database))
 assert.ok(tables.length>10&&tables.every(name=>/^[a-z_]+$/u.test(name)))
 const parts=tables.map(name=>"SELECT "+L(name)+" AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ppo_authority."+name+' t')
 return sha(sql("SELECT jsonb_agg(q ORDER BY name)::text FROM ("+parts.join(' UNION ALL ')+') q;','postgres',database))
}
const dump=()=>docker(['pg_dump','-U','postgres','-d',db,'--schema=ppo_authority']).stdout
function restore(snapshot,database=db){sql('DROP SCHEMA IF EXISTS ppo_authority CASCADE;','postgres',database);sql(snapshot,'postgres',database)}
const count=(table,database=db)=>Number(sql('SELECT count(*) FROM ppo_authority.'+table+';','postgres',database))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const MODULE_ROLES=['ppo_authority_writer','ppo_authority_reader','ppo_authority_importer','ppo_rehearsal_controller','ppo_rehearsal_source','ppo_rehearsal_target','ppo_action_admin','ppo_action_verifier','ppo_action_consumer','ppo_resource_verifier','ppo_resource_consumer','ppo_admission_verifier']
const TRANSPORT=new Set(['ppo_action_verifier','ppo_resource_verifier','ppo_action_consumer','ppo_resource_consumer','ppo_action_admin'])
// One actual NOINHERIT LOGIN per ordinary role, plus one mixed-role login.
const loginFor=role=>TRANSPORT.has(role)?serviceLogin(role):'ppo_login_'+role.slice(4)
const ORDINARY=Object.fromEntries(MODULE_ROLES.map(role=>[loginFor(role),[role]]))
ORDINARY.ppo_login_mixed=['ppo_action_consumer','ppo_action_admin','ppo_action_verifier','ppo_authority_writer']
const GATEWAY_LOGIN='ppo_transport_gateway',GATEWAY_ROLE='ppo_authority_gateway'
let tls
before(async()=>{tls=await serviceTlsFixture()})
after(async()=>{await tls?.close()})

const PRIVILEGE_INVENTORY=`SELECT jsonb_build_object('role',r.rolname,'login',r.rolcanlogin,
 'execute',(SELECT coalesce(jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"),'[]') FROM pg_proc p WHERE p.pronamespace='ppo_authority'::regnamespace AND has_function_privilege(r.oid,p.oid,'EXECUTE')),
 'write',(SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname COLLATE "C"),'[]') FROM pg_class c WHERE c.relnamespace='ppo_authority'::regnamespace AND c.relkind IN ('r','v','S','p','m','f') AND has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'read',(SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname COLLATE "C"),'[]') FROM pg_class c WHERE c.relnamespace='ppo_authority'::regnamespace AND c.relkind IN ('r','v','S','p','m','f') AND has_table_privilege(r.oid,c.oid,'SELECT')),
 'schema',jsonb_build_array(has_schema_privilege(r.oid,'ppo_authority','USAGE'),has_schema_privilege(r.oid,'ppo_authority','CREATE'),has_schema_privilege(r.oid,'public','CREATE')),
 'memberOf',(SELECT coalesce(jsonb_agg(m.roleid::regrole::text ORDER BY m.roleid::regrole::text COLLATE "C"),'[]') FROM pg_auth_members m WHERE m.member=r.oid),
 'privileged',r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) FROM pg_roles r WHERE r.rolname LIKE 'ppo\\_%' ORDER BY r.rolname COLLATE "C";`
const inventory=()=>Object.fromEntries(sql(PRIVILEGE_INVENTORY).split('\n').map(line=>JSON.parse(line)).map(x=>[x.role,x]))

async function install(){
 for(const file of ['phase1gb2-canonical-postgres.sql','phase1gb2-synthetic-import.sql','phase1gb2-canonical-catalog.sql','phase1gb2-ownership-rehearsal.sql','phase1gb2c-action-fencing.sql','phase1gb2c2-resource.sql'])sql(await readFile(new URL(file,import.meta.url),'utf8'))
 sql(await admissionProfileSql({ownership:true}))
 sql(await readFile(new URL('phase2bc-authority-gateway.sql',import.meta.url),'utf8'))
}
function dropAll(){
 sql('DROP DATABASE IF EXISTS '+clone+';')
 sql('DROP SCHEMA IF EXISTS ppo_authority CASCADE;DROP OWNED BY ppo_authority_owner;DROP ROLE IF EXISTS '+[...Object.keys(ORDINARY),GATEWAY_LOGIN,GATEWAY_ROLE,'ppo_authority_owner',...MODULE_ROLES].join(',')+';')
}

// Trusted bootstrap before sealing: ownership/catalog import, host epoch 1
// and N registered diagnostic contexts. All of it is unreachable after seal.
async function fixture(t,{seal=true,actions=2,lifetime}={}){
 const cleanup=[],sessions=new Set(),counts={opened:0,disposed:0,commits:0,statements:[]}
 let hook=async(_s,execute)=>execute()
 t.after(()=>finishServiceTestFixture([...cleanup.reverse(),async()=>finishServiceTestFixture([...sessions].map(s=>()=>s.dispose())),()=>dropAll()]))
 await install()
 const roles={[O.read]:'ppo_rehearsal_controller',[O.sourceRead]:'ppo_rehearsal_controller',[O.control]:'ppo_rehearsal_controller',[O.receipt]:'ppo_rehearsal_controller',[O.source]:'ppo_rehearsal_source',[O.target]:'ppo_rehearsal_target'}
 const owner=createSyntheticOwnershipRehearsal({mode:'synthetic-ownership-cutover-rehearsal-only',query:(s,a)=>createCatalogCertifiedQuery({mode:'isolated-catalog-certified-authority',query:query(roles[s]),verifierQuery:query('ppo_admission_verifier')})(s,a)})
 await owner.seed();await owner.freeze();await owner.import();await owner.activate()
 const observed=await owner.observe(),run=observed.catalog.entries.filter(e=>e.path.startsWith('records/')).map(e=>JSON.parse(e.serialized)).find(r=>r.status==='implementation_in_progress')
 const f=signedActionFixture(run,lifetime===undefined?{}:{lifetime})
 sql('SELECT ppo_authority.configure_action_host('+L(f.proof.hostId)+',0,'+L(JSON.stringify(f.policy))+');','ppo_action_admin')
 const verifier=createIsolatedPostgresActionVerifier({mode:'isolated-postgres-action-fencing-only',query:query('ppo_action_verifier'),...f.config}),tickets=[]
 for(let i=0;i<actions;i++){
  const signedProof=i===0?f.input.signedProof:signOfflineHostActionProof({...f.proof,actionId:randomUUID().replaceAll('-','')},f.keys.host.privateKey)
  tickets.push((await verifier.register({...f.input,signedProof,ticket:randomUUID()})).ticket)
 }
 for(const [login,members] of Object.entries(ORDINARY))sql('CREATE ROLE '+login+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;'+members.map(m=>'GRANT '+m+' TO '+login+';').join(''))
 sql('CREATE ROLE '+GATEWAY_LOGIN+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;GRANT '+GATEWAY_ROLE+' TO '+GATEWAY_LOGIN+';')
 const identity={anchorId:randomUUID(),authorityId:observed.owner.target_id,ownerId:randomUUID()},preSeal=inventory()
 const x={f,run,tickets,identity,counts,sessions,preSeal,cleanup,setHook:fn=>{hook=fn}}
 if(!seal)return x
 x.attestation=sql('SELECT ppo_authority.seal_authority_gateway('+[identity.anchorId,identity.authorityId,identity.ownerId].map(v=>L(v)+'::uuid').join(',')+');')
 assert.match(x.attestation,/^[a-f0-9]{64}$/u)
 const initial=checkpoint();assert.equal(sql('SELECT ppo_authority.gateway_checkpoint();'),initial)
 // Exclusive gateway sessions: fresh LOGIN connection per attempt, disposed by the transport.
 x.open=(database=db,login=GATEWAY_LOGIN,role=GATEWAY_ROLE)=>async()=>{
  counts.opened++
  const p=spawn('docker',['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',login,'-d',database],{stdio:['pipe','pipe','pipe']})
  const pg=createPostgresTestSession(p,{timeoutMs:30000});let disposed=false
  const connection={async query(s,a){counts.statements.push(s);return hook(s,async()=>{if(s==='COMMIT')counts.commits++;if(['BEGIN','COMMIT','ROLLBACK'].includes(s)){await pg.send(s+';');return {rows:[]}}return {rows:[JSON.parse(await pg.send('SELECT row_to_json(q) FROM ('+bind(s,a)+') q;'))]}})},async dispose(){if(disposed)return;disposed=true;await pg.close();sessions.delete(connection);counts.disposed++}}
  sessions.add(connection)
  try{await pg.send("SET application_name='"+APP+"';SET statement_timeout='7s';SET idle_in_transaction_session_timeout='8s';SET client_connection_check_interval='100ms';SET ROLE "+role+';');return connection}catch(e){await connection.dispose();throw e}
 }
 x.witnessPath=await realpath(await mkdtemp(join(tmpdir(),'ppo-ric177-anchor-')));await chmod(x.witnessPath,0o700)
 cleanup.push(()=>rm(x.witnessPath,{recursive:true,force:true}))
 x.witnessConfig={mode:WM,path:x.witnessPath,pinnedIdentity:identity}
 x.witness=await openExternalIncarnationAnchor({...x.witnessConfig,initializeCheckpoint:initial})
 x.pins=tls.registry()
 x.start=async({witness=x.witness,pins=x.pins,database=db,pinnedIdentity=identity,attestation=x.attestation,connect=x.open(database)}={})=>{
  const gateway=createAuthenticatedAuthorityGateway({mode:GM,witness,pinnedIdentity,attestation,pins,serviceIdentity:tls.certs.gateway.identity})
  const service=createIsolatedPinnedService({mode:TM,service:'gateway',identity:tls.certs.gateway.identity,tls:tls.certs.gateway.tls,pins,connections:{gateway:connect},gateway})
  cleanup.push(()=>service.close());const address=await service.listen()
  const call=(path,body,peer='coordinator')=>createIsolatedPinnedClient({mode:TM,service:'gateway',serverIdentity:tls.certs.gateway.identity,port:address.port,tls:tls.certs[peer].tls,pins}).send(path,body)
  const state=async(peer='coordinator')=>{const s=await call('/v1/gateway/state',{},peer);assert.equal(s.status,'gateway-state');return s}
  const expected=async peer=>{const b=(await state(peer)).binding;return {incarnation:b.incarnation,instanceId:b.instanceId,checkpoint:b.checkpoint}}
  const consume=async(ticket,{operationId=randomUUID(),peer='coordinator',expect}={})=>({operationId,result:await call('/v1/gateway/consume',{operationId,ticket,expected:expect??await expected(peer)},peer)})
  const revoke=async({operationId=randomUUID(),expectedEpoch=1,peer='admin',expect}={})=>({operationId,result:await call('/v1/gateway/revoke-host',{operationId,hostId:x.f.proof.hostId,expectedEpoch,expected:expect??await expected(peer)},peer)})
  const activate=async()=>{const a=await service.activateGateway();assert.equal(a.status,'activated');return a}
  return {gateway,service,call,state,expected,consume,revoke,activate,reconcile:(operationId,peer='coordinator')=>call('/v1/gateway/reconcile',{operationId},peer)}
 }
 cleanup.push(async()=>{try{await x.witness.close()}catch{}})
 x.drain=async()=>{for(let i=0;i<200&&sessions.size;i++)await sleep(10);assert.equal(sessions.size,0);assert.equal(counts.opened,counts.disposed)}
 return x
}
const flagsFalse=r=>{for(const [k,v] of Object.entries(FLAGS))assert.equal(r[k],v,k)}
function denied42501(result,label){assert.notEqual(result.status,0,label+' unexpectedly succeeded: '+result.stdout);assert.match(result.stderr,/42501/u,label+': '+result.stderr)}
const rawConsume=(ticket,op)=>'SELECT ppo_authority.consume_action('+L(ticket)+'::uuid,'+L(op)+'::uuid);'
const rawConfigure=(f,epoch,status)=>'SELECT ppo_authority.configure_action_host('+L(f.proof.hostId)+','+epoch+','+L(JSON.stringify({...f.policy,status}))+');'

test('RIC-177 causal control: without the sealed gateway profile, ordinary LOGIN raw SQL still bypasses the witness after stale restore',{timeout:90000},async t=>{
 const x=await fixture(t,{seal:false}),path=await realpath(await mkdtemp(join(tmpdir(),'ppo-ric177-control-')));await chmod(path,0o700)
 const witness=await openExternalIncarnationAnchor({mode:WM,path,pinnedIdentity:x.identity,initializeCheckpoint:checkpoint()})
 t.after(async()=>{try{await witness.close()}finally{await rm(path,{recursive:true,force:true})}})
 const activate=async()=>{const e=await witness.inspect();return witness.activate({checkpoint:checkpoint(),expectedRecordHash:e.recordHash})}
 const snapshot=dump();let e=await activate()
 const o={ticket:x.tickets[0],operationId:randomUUID()},binding={...x.identity,incarnation:e.incarnation,instanceId:e.instanceId,checkpoint:e.checkpoint}
 const operation={operationId:o.operationId,kind:'consume-action',subjectHash:sha('control-'+o.ticket),inputHash:sha(JSON.stringify(o))}
 await witness.reserve({binding,operation})
 assert.equal(JSON.parse(asLogin(serviceLogin('ppo_action_consumer'),'SET ROLE ppo_action_consumer;'+rawConsume(o.ticket,o.operationId)).stdout.trim()).consumed,true)
 await witness.recordCommitted({binding,operation,checkpoint:checkpoint(),receiptHash:sha('control')});await activate()
 restore(snapshot);assert.equal(count('action_tombstones'),0)
 await assert.rejects(activate(),/denied|quarantined/u)
 // The witness denies the stale state, yet the same ordinary LOGIN commits again.
 const replay=asLogin(serviceLogin('ppo_action_consumer'),'SET ROLE ppo_action_consumer;'+rawConsume(o.ticket,randomUUID()))
 assert.equal(replay.status,0,replay.stderr);assert.equal(JSON.parse(replay.stdout.trim()).consumed,true);assert.equal(count('action_tombstones'),1)
 const reconfigure=asLogin(serviceLogin('ppo_action_admin'),'SET ROLE ppo_action_admin;'+rawConfigure(x.f,1,'active'))
 assert.equal(reconfigure.status,0,reconfigure.stderr);assert.equal(reconfigure.stdout.trim(),'2')
})

test('RIC-177 sealed profile: effective privilege inventory leaves only the gateway mutation path; ordinary, escalated, mixed and private bypasses deny 42501 before mutation',{timeout:120000},async t=>{
 const x=await fixture(t),post=inventory()
 console.log('RIC177_PRIVILEGE_INVENTORY_PRESEAL '+JSON.stringify(x.preSeal))
 console.log('RIC177_PRIVILEGE_INVENTORY_SEALED '+JSON.stringify(post))
 // Pre-seal positive control: the inventory sees the ordinary mutation capabilities that seal removes.
 assert.ok(x.preSeal.ppo_action_consumer.execute.includes('ppo_authority.consume_action(uuid,uuid)'))
 assert.ok(x.preSeal.ppo_action_admin.execute.includes('ppo_authority.configure_action_host(text,bigint,text)'))
 assert.ok(x.preSeal.ppo_action_verifier.execute.includes('ppo_authority.register_action_context(uuid,text)'))
 const entry=['ppo_authority.gateway_consume_action(uuid,uuid,text)','ppo_authority.gateway_receipt(uuid)','ppo_authority.gateway_revoke_host(uuid,text,bigint,text)','ppo_authority.gateway_state()']
 for(const [role,row] of Object.entries(post)){
  if(role==='ppo_authority_owner')continue // object owner: trusted DB administration, never a runtime credential
  assert.equal(row.privileged,false,role)
  assert.deepEqual(row.write,[],role+' table write');assert.deepEqual(row.read,[],role+' table read')
  assert.equal(row.schema[1],false,role+' schema create');assert.equal(row.schema[2],false,role+' public create')
  if(role===GATEWAY_ROLE){assert.deepEqual(row.execute,entry);assert.equal(row.schema[0],true);assert.deepEqual(row.memberOf,[]);continue}
  assert.deepEqual(row.execute,[],role+' execute');assert.equal(row.schema[0],false,role+' schema usage')
 }
 assert.deepEqual(post[GATEWAY_LOGIN].memberOf,[GATEWAY_ROLE]);assert.equal(post.ppo_authority_owner.memberOf.length,0)
 assert.equal(sql("SELECT count(*) FROM pg_auth_members WHERE roleid='ppo_authority_owner'::regrole;"),'0')
 const before=checkpoint(),ticket=x.tickets[0],op=randomUUID()
 // Every pre-seal executable function of every ordinary role, called as that actual LOGIN.
 const attempts=[]
 for(const [login,members] of Object.entries(ORDINARY))for(const role of members){
  for(const fn of x.preSeal[role].execute)attempts.push([login,'SET ROLE '+role+';SELECT '+fn.replace(/\((.*)\)$/u,(_,args)=>'('+(args?args.split(',').map(a=>'NULL::'+a):[]).join(',')+')')+';',role+' '+fn])
  attempts.push([login,'SET ROLE '+role+';'+rawConsume(ticket,op),role+' raw consume'])
  attempts.push([login,'SET ROLE '+role+';'+rawConfigure(x.f,1,'revoked'),role+' raw configure'])
  attempts.push([login,'SET ROLE '+role+';INSERT INTO ppo_authority.action_tombstones SELECT * FROM ppo_authority.action_tombstones;',role+' table write'])
  attempts.push([login,'SET ROLE '+role+';UPDATE ppo_authority.gate SET revision=revision+1;',role+' gate write'])
  attempts.push([login,'SET ROLE '+role+";SELECT ppo_authority.gateway_consume_action("+L(op)+'::uuid,'+L(ticket)+"::uuid,'{}');",role+' gateway entrypoint'])
  attempts.push([login,'SET ROLE '+GATEWAY_ROLE+';',login+' escalation to gateway role'])
  attempts.push([login,'SET ROLE ppo_authority_owner;',login+' escalation to owner'])
 }
 // Mixed-role transaction: switching between several memberships still holds nothing.
 attempts.push(['ppo_login_mixed','BEGIN;SET ROLE ppo_action_verifier;SET ROLE ppo_action_admin;SET ROLE ppo_action_consumer;'+rawConsume(ticket,op)+'COMMIT;','mixed-role transaction'])
 // The gateway LOGIN itself cannot reach private cores, helpers, legacy writers or tables.
 for(const fn of ['ppo_authority.consume_action(NULL::uuid,NULL::uuid)','ppo_authority.configure_action_host(NULL::text,NULL::bigint,NULL::text)','ppo_authority.admission_commit_core(NULL::text,NULL::integer,NULL::text,NULL::text)',
  'ppo_authority.admission_rehearsal_core(NULL::text,NULL::text)','ppo_authority.register_action_context(NULL::uuid,NULL::text)','ppo_authority.gateway_checkpoint()','ppo_authority.gateway_attestation()',
  "ppo_authority.gateway_boundary('{}',NULL,NULL,NULL,NULL)","ppo_authority.gateway_record('{}'::jsonb,NULL,NULL,NULL,NULL)",'ppo_authority.seal_authority_gateway(NULL,NULL,NULL)'])
  attempts.push([GATEWAY_LOGIN,'SET ROLE '+GATEWAY_ROLE+';SELECT '+fn+';','gateway private '+fn])
 attempts.push([GATEWAY_LOGIN,'SET ROLE '+GATEWAY_ROLE+';INSERT INTO ppo_authority.gateway_receipts SELECT * FROM ppo_authority.gateway_receipts;','gateway table write'])
 attempts.push([GATEWAY_LOGIN,'SET ROLE ppo_action_consumer;','gateway escalation'])
 attempts.push([GATEWAY_LOGIN,"SELECT ppo_authority.gateway_state();",'gateway login without SET ROLE'])
 for(const [login,text,label] of attempts)denied42501(asLogin(login,text),label)
 console.log('RIC177_DIRECT_DENIALS '+attempts.length)
 assert.ok(attempts.length>=150)
 assert.equal(checkpoint(),before);assert.equal(count('action_tombstones'),0)
 // Role escalation by membership change: guard denies the escalated LOGIN,
 // and the changed attestation makes the gateway itself deny.
 sql('GRANT '+GATEWAY_ROLE+' TO '+serviceLogin('ppo_action_consumer')+';')
 const escalated=asLogin(serviceLogin('ppo_action_consumer'),'SET ROLE '+GATEWAY_ROLE+';SELECT ppo_authority.gateway_state();')
 denied42501(escalated,'escalated LOGIN at session guard');assert.match(escalated.stderr,/authority gateway session denied/u)
 const gw=await x.start()
 await assert.rejects(gw.activate(),/./u)
 sql('REVOKE '+GATEWAY_ROLE+' FROM '+serviceLogin('ppo_action_consumer')+';')
 await gw.activate()
 const exp=await gw.expected()
 sql('GRANT ppo_action_admin TO '+GATEWAY_LOGIN+';')
 try{const r=(await gw.consume(ticket,{expect:exp})).result;assert.equal(r.status,'denied');flagsFalse(r)}finally{sql('REVOKE ppo_action_admin FROM '+GATEWAY_LOGIN+';')}
 assert.equal(checkpoint(),before)
 // A gateway session opened with the wrong LOGIN/role is rejected by the transport probe before any statement.
 const wrong=await x.start({connect:x.open(db,serviceLogin('ppo_action_consumer'),'ppo_action_consumer'),witness:{inspect:async()=>assert.fail('witness reached'),reserve:async()=>assert.fail(),recordCommitted:async()=>assert.fail(),quarantine:async()=>{},activate:async()=>assert.fail()}})
 assert.equal((await wrong.call('/v1/gateway/state',{})).status,'denied')
 assert.equal(checkpoint(),before);await x.drain()
})

test('RIC-177 valid pinned gateway operations succeed exactly once; replay, new-ID, peer separation and restart replay deny',{timeout:120000},async t=>{
 const x=await fixture(t,{actions:3});let gw=await x.start();await gw.activate()
 // Peer separation: administrator cannot consume; coordinator cannot revoke; unknown peer is not pinned.
 assert.equal((await gw.consume(x.tickets[0],{peer:'admin'})).result.status,'denied')
 assert.equal((await gw.revoke({peer:'coordinator'})).result.status,'denied')
 assert.equal((await gw.call('/v1/gateway/state',{},'unknown')).status,'denied')
 assert.equal(x.counts.commits,0)
 const e0=await gw.expected(),first=await gw.consume(x.tickets[0],{expect:e0});assert.equal(first.result.status,'gateway-consumed');assert.equal(first.result.outcome,'consumed');flagsFalse(first.result)
 assert.equal(count('action_tombstones'),1);assert.equal(count('gateway_receipts'),1);assert.equal(x.counts.commits,1)
 const w1=await x.witness.inspect();assert.equal(w1.status,'quarantined');assert.equal(w1.pending,null);assert.equal(w1.lastReceiptHash,first.result.receiptHash);assert.equal(w1.checkpoint,checkpoint())
 // Same request replayed: witness quarantined until explicit trusted activation.
 assert.equal((await gw.call('/v1/gateway/consume',{operationId:first.operationId,ticket:x.tickets[0],expected:e0})).status,'denied')
 await gw.activate()
 assert.equal((await gw.consume(x.tickets[0],{operationId:first.operationId})).result.status,'denied') // same operation UUID
 assert.equal((await gw.consume(x.tickets[0])).result.status,'denied') // new operation UUID, same subject
 denied42501(asLogin(serviceLogin('ppo_action_consumer'),'SET ROLE ppo_action_consumer;'+rawConsume(x.tickets[0],randomUUID())),'raw replay')
 const revoked=await gw.revoke();assert.equal(revoked.result.status,'gateway-revoked');flagsFalse(revoked.result)
 assert.equal(sql("SELECT epoch||':'||(policy->>'status') FROM ppo_authority.action_hosts;"),'2:revoked')
 await gw.activate()
 assert.equal((await gw.revoke({expectedEpoch:2})).result.status,'denied') // one revocation subject per host
 const afterRevocation=await gw.consume(x.tickets[1]);assert.equal(afterRevocation.result.status,'gateway-denied');assert.equal(afterRevocation.result.outcome,'denied')
 assert.equal(count('action_tombstones'),1);assert.equal(count('gateway_receipts'),3);assert.equal(x.counts.commits,3)
 assert.deepEqual(JSON.parse(sql("SELECT jsonb_agg(outcome ORDER BY incarnation) FROM ppo_authority.gateway_receipts;")),['consumed','revoked','denied'])
 assert.equal(sql('SELECT last_incarnation FROM ppo_authority.gateway_profile;'),String((await x.witness.inspect()).incarnation))
 // Clean restart: the witness reopens quarantined; old requests and IDs stay denied.
 await gw.activate();const old=await gw.expected()
 await gw.service.close();await x.witness.close();await x.drain()
 x.witness=await openExternalIncarnationAnchor(x.witnessConfig)
 gw=await x.start();assert.equal((await gw.state()).witness,'quarantined')
 assert.equal((await gw.consume(x.tickets[2],{expect:old})).result.status,'denied')
 await gw.activate()
 assert.equal((await gw.consume(x.tickets[2],{expect:old})).result.status,'denied') // delayed pre-restart expectation
 assert.equal((await gw.consume(x.tickets[0],{operationId:first.operationId})).result.status,'denied')
 // The restarted gateway still mutates exactly once; the host it revoked
 // before restart stays revoked, so the committed outcome is a denial receipt.
 const fresh=await gw.consume(x.tickets[2]);assert.equal(fresh.result.status,'gateway-denied');assert.equal(fresh.result.outcome,'denied')
 assert.equal(count('action_tombstones'),1);assert.equal(count('gateway_receipts'),4);assert.equal(x.counts.commits,4);await x.drain()
})

test('RIC-177 stale restore, clone and different owner deny before reservation; ordinary LOGIN raw SQL after restore is 42501',{timeout:120000},async t=>{
 const x=await fixture(t),gw=await x.start(),snapshot=dump();await gw.activate()
 assert.equal((await gw.consume(x.tickets[0])).result.status,'gateway-consumed');await gw.activate()
 assert.equal((await gw.revoke()).result.status,'gateway-revoked');await gw.activate()
 const retained=(await x.witness.inspect()).operations.length;assert.equal(retained,2)
 restore(snapshot)
 assert.equal(count('action_tombstones'),0);assert.equal(sql("SELECT policy->>'status' FROM ppo_authority.action_hosts;"),'active')
 assert.equal(sql('SELECT attestation FROM ppo_authority.gateway_profile;'),x.attestation) // exact restore attests identically; checkpoint is the anchor
 const before=checkpoint()
 // GREEN of the baseline RED: the same ordinary LOGIN calls are now denied before mutation.
 denied42501(asLogin(serviceLogin('ppo_action_consumer'),'SET ROLE ppo_action_consumer;'+rawConsume(x.tickets[0],randomUUID())),'consumer after restore')
 denied42501(asLogin(serviceLogin('ppo_action_admin'),'SET ROLE ppo_action_admin;'+rawConfigure(x.f,1,'active')),'admin after restore')
 assert.equal(checkpoint(),before)
 const state=await gw.state();assert.equal(state.consistent,false)
 assert.equal((await gw.consume(x.tickets[1])).result.status,'denied')
 const w=await x.witness.inspect();assert.equal(w.status,'quarantined');assert.equal(w.pending,null);assert.equal(w.operations.length,retained)
 await assert.rejects(gw.activate(),/./u)
 assert.equal(checkpoint(),before);assert.equal(count('gateway_receipts'),0)
 // Clone: identical data and attestation, but no enrolled external owner. A
 // separately initialized witness with a different owner is denied by the
 // sealed trust domain; the original witness cannot be reopened or reset.
 sql('CREATE DATABASE '+clone+';');restore(snapshot,clone);assert.equal(checkpoint(clone),checkpoint())
 const otherPath=await realpath(await mkdtemp(join(tmpdir(),'ppo-ric177-clone-')));await chmod(otherPath,0o700);t.after(()=>rm(otherPath,{recursive:true,force:true}))
 const otherIdentity={...x.identity,ownerId:randomUUID()},other=await openExternalIncarnationAnchor({mode:WM,path:otherPath,pinnedIdentity:otherIdentity,initializeCheckpoint:checkpoint(clone)})
 t.after(async()=>{try{await other.close()}catch{}})
 const cloneGw=await x.start({witness:other,pins:tls.registry(),database:clone,pinnedIdentity:otherIdentity})
 await assert.rejects(cloneGw.activate(),/./u)
 const e=await other.inspect();await other.activate({checkpoint:e.checkpoint,expectedRecordHash:e.recordHash}) // even a forcibly opened foreign owner
 const cloneBefore=checkpoint(clone)
 assert.equal((await cloneGw.consume(x.tickets[1])).result.status,'denied')
 assert.equal(checkpoint(clone),cloneBefore);assert.equal((await other.inspect()).pending,null)
 await assert.rejects(openExternalIncarnationAnchor({...x.witnessConfig,initializeCheckpoint:checkpoint(clone)}),/EEXIST/u)
 await x.drain()
})

test('RIC-177 old, rotated and revoked pins deny; any pin change durably quarantines until trusted activation',{timeout:90000},async t=>{
 const x=await fixture(t,{actions:2}),gw=await x.start();await gw.activate()
 x.pins.rotate('lab-coordinator',1,tls.certs.coordinatorNew.fingerprint)
 assert.equal((await gw.call('/v1/gateway/state',{},'coordinator')).status,'denied')
 for(let i=0;i<50&&(await x.witness.inspect()).status!=='quarantined';i++)await sleep(10)
 assert.equal((await x.witness.inspect()).status,'quarantined')
 assert.equal((await gw.consume(x.tickets[0],{peer:'coordinatorNew'})).result.status,'denied')
 await gw.activate()
 const ok=await gw.consume(x.tickets[0],{peer:'coordinatorNew'});assert.equal(ok.result.status,'gateway-consumed')
 const receipt=JSON.parse(sql('SELECT binding FROM ppo_authority.gateway_receipts;'))
 assert.equal(receipt.peerIdentity,'lab-coordinator');assert.equal(receipt.peerEpoch,2);assert.equal(receipt.peerFingerprint,tls.certs.coordinatorNew.fingerprint);assert.equal(receipt.serviceEpoch,1)
 await gw.activate()
 // Revoking the gateway's own pin closes it to every peer.
 x.pins.revoke(tls.certs.gateway.identity,1)
 assert.equal((await gw.call('/v1/gateway/state',{},'coordinatorNew')).status,'denied')
 assert.equal(count('action_tombstones'),1);await x.drain()
})

test('RIC-177 concurrent requests, copied-identity owners, foreign owners and raw writers produce at most one effect',{timeout:120000},async t=>{
 const x=await fixture(t,{actions:4}),gw=await x.start();await gw.activate()
 const expect=await gw.expected()
 const both=await Promise.all([gw.consume(x.tickets[0],{expect}),gw.consume(x.tickets[1],{expect})])
 const statuses=both.map(b=>b.result.status).sort();assert.equal(statuses[0],'gateway-consumed');assert.ok(['unavailable','denied'].includes(statuses[1]),statuses[1])
 assert.equal(count('action_tombstones'),1);assert.equal(x.counts.commits,1)
 await gw.activate()
 // Copied service identity (out of scope as custody, exercised anyway): a
 // second witness with the SAME pinned identity races the first. The shared
 // gate, checkpoint and DB incarnation floor allow at most one effect.
 const copyPath=await realpath(await mkdtemp(join(tmpdir(),'ppo-ric177-copy-')));await chmod(copyPath,0o700);t.after(()=>rm(copyPath,{recursive:true,force:true}))
 const copy=await openExternalIncarnationAnchor({mode:WM,path:copyPath,pinnedIdentity:x.identity,initializeCheckpoint:checkpoint()})
 t.after(async()=>{try{await copy.close()}catch{}})
 const copyGw=await x.start({witness:copy,pins:tls.registry()})
 let ce=await copy.inspect();while(ce.incarnation<(await x.witness.inspect()).incarnation){await copy.activate({checkpoint:ce.checkpoint,expectedRecordHash:ce.recordHash});await copy.quarantine();ce=await copy.inspect()}
 await copy.activate({checkpoint:ce.checkpoint,expectedRecordHash:ce.recordHash})
 const [a,b]=[await gw.expected(),await copyGw.expected()];assert.ok(a.incarnation>1&&b.incarnation>1);assert.equal(a.checkpoint,b.checkpoint)
 // Both owners reserve, then reach the actual mutation boundary together
 // while a held shared gate forces them to wait on the same lock.
 const holder=createPostgresTestSession(spawn('docker',['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],{stdio:['pipe','pipe','pipe']}))
 x.cleanup.push(()=>holder.close())
 let entered=0,release;const together=new Promise(r=>release=r)
 x.setHook(async(s,execute)=>{if(s===G.consume){entered++;if(entered===2){await holder.send('BEGIN;SELECT 1 FROM ppo_authority.gate WHERE singleton FOR UPDATE;');release()}await together}return execute()})
 const race=Promise.all([gw.consume(x.tickets[2],{expect:a}),copyGw.consume(x.tickets[3],{expect:b})])
 for(let i=0;i<300&&Number(sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='"+APP+"' AND wait_event_type='Lock';"))<2;i++)await sleep(10)
 assert.equal(entered,2)
 // Concurrent ordinary raw writer during the race is still denied.
 denied42501(asLogin(serviceLogin('ppo_action_consumer'),'SET ROLE ppo_action_consumer;'+rawConsume(x.tickets[2],randomUUID())),'concurrent raw writer')
 await holder.send('ROLLBACK;')
 const raced=(await race).map(r=>r.result.status).sort()
 assert.deepEqual(raced,['gateway-consumed','unknown'])
 assert.equal(count('action_tombstones'),2);assert.equal(count('gateway_receipts'),2);assert.equal(x.counts.commits,2)
 x.setHook(async(_s,execute)=>execute())
 // The loser stays latched; read-only reconciliation finds no receipt for it.
 const loser=(await x.witness.inspect()).pending?x.witness:copy,loserGw=loser===copy?copyGw:gw,pendingOp=(await loser.inspect()).pending.operation.operationId
 assert.equal((await loserGw.reconcile(pendingOp)).status,'unknown');assert.equal((await loser.inspect()).pending.operation.operationId,pendingOp)
 // A foreign owner is denied by the sealed trust domain before reservation.
 const foreignPath=await realpath(await mkdtemp(join(tmpdir(),'ppo-ric177-foreign-')));await chmod(foreignPath,0o700);t.after(()=>rm(foreignPath,{recursive:true,force:true}))
 const foreignIdentity={...x.identity,ownerId:randomUUID()},foreign=await openExternalIncarnationAnchor({mode:WM,path:foreignPath,pinnedIdentity:foreignIdentity,initializeCheckpoint:checkpoint()})
 t.after(async()=>{try{await foreign.close()}catch{}})
 const fe=await foreign.inspect();await foreign.activate({checkpoint:fe.checkpoint,expectedRecordHash:fe.recordHash})
 const foreignGw=await x.start({witness:foreign,pins:tls.registry(),pinnedIdentity:foreignIdentity})
 const before=checkpoint();assert.equal((await foreignGw.consume(x.tickets[3])).result.status,'denied')
 assert.equal(checkpoint(),before);assert.equal((await foreign.inspect()).pending,null);await x.drain()
})

test('RIC-177 post-reservation expiry never produces a first effect and recovery cannot upgrade it',{timeout:120000},async t=>{
 const x=await fixture(t,{lifetime:5000}),gw=await x.start();await gw.activate()
 // Positive control: the action is valid and fresh before reservation.
 const control=sql('BEGIN;'+rawConsume(x.tickets[0],randomUUID())+'ROLLBACK;')
 assert.equal(JSON.parse(control).consumed,true)
 const deadline=Math.min(Date.parse(x.f.request.expiresAt),Date.parse(x.f.claim.leaseExpiresAt),Date.parse(x.f.proof.expiresAt))
 let waited=false;x.setHook(async(s,execute)=>{if(s===G.consume){await sleep(Math.max(0,deadline-Date.now())+50);waited=true}return execute()})
 const late=await gw.consume(x.tickets[0]);assert.equal(waited,true)
 assert.equal(late.result.status,'gateway-denied');assert.equal(late.result.outcome,'denied');flagsFalse(late.result)
 assert.equal(count('action_tombstones'),0);assert.equal(JSON.parse(sql('SELECT evidence FROM ppo_authority.gateway_receipts;')).core.consumed,false)
 x.setHook(async(_s,execute)=>execute());await gw.activate()
 assert.equal((await gw.consume(x.tickets[0])).result.status,'denied') // new operation UUID cannot retry the expired subject
 assert.equal((await gw.reconcile(late.operationId)).status,'denied') // nothing pending: recovery cannot upgrade it
 denied42501(asLogin(serviceLogin('ppo_action_consumer'),'SET ROLE ppo_action_consumer;'+rawConsume(x.tickets[0],randomUUID())),'raw post-expiry')
 assert.equal(count('action_tombstones'),0);await x.drain()
})

test('RIC-177 delayed requests bound to an older incarnation deny before reservation',{timeout:90000},async t=>{
 const x=await fixture(t),gw=await x.start();await gw.activate()
 const stale=await gw.expected()
 assert.equal((await gw.revoke()).result.status,'gateway-revoked');await gw.activate()
 const before=await x.witness.inspect(),cp=checkpoint()
 assert.equal((await gw.consume(x.tickets[0],{expect:stale})).result.status,'denied')
 const after=await x.witness.inspect();assert.equal(after.sequence,before.sequence);assert.equal(after.status,'open');assert.equal(checkpoint(),cp)
 assert.equal((await gw.consume(x.tickets[0])).result.status,'gateway-denied') // host revoked: committed denial receipt, no tombstone
 assert.equal(count('action_tombstones'),0);await x.drain()
})

test('RIC-177 lost acknowledgment latches until exact read-only reconciliation; loss before COMMIT stays unknown and latched',{timeout:150000},async t=>{
 const x=await fixture(t,{actions:3}),gw=await x.start();await gw.activate()
 // (a) COMMIT executes, acknowledgment lost.
 x.setHook(async(s,execute)=>{const r=await execute();if(s==='COMMIT')throw Error('synthetic lost acknowledgment');return r})
 const lost=await gw.consume(x.tickets[0]);assert.equal(lost.result.status,'unknown');flagsFalse(lost.result)
 x.setHook(async(_s,execute)=>execute())
 assert.equal(count('action_tombstones'),1);assert.equal(x.counts.commits,1)
 assert.equal((await x.witness.inspect()).pending.operation.operationId,lost.operationId)
 assert.equal((await gw.consume(x.tickets[1])).result.status,'denied') // pending blocks further mutations
 await assert.rejects(gw.activate(),/./u)
 const statements=x.counts.statements.length
 const rec=await gw.reconcile(lost.operationId);assert.equal(rec.status,'reconciled');assert.equal(rec.outcome,'consumed');flagsFalse(rec)
 assert.deepEqual(x.counts.statements.slice(statements).filter(s=>s.startsWith('SELECT ppo_authority.gateway_')),[G.receipt]) // read-only: no effect statement
 assert.equal(x.counts.commits,1);assert.equal(count('action_tombstones'),1)
 await gw.activate()
 assert.equal((await gw.consume(x.tickets[0],{operationId:lost.operationId})).result.status,'denied')
 // (b) Connection lost before COMMIT is dispatched: rolled back, but absence
 // never proves noncommit, so the operation stays latched.
 x.setHook(async(s,execute)=>{if(s==='COMMIT')throw Error('synthetic loss before COMMIT');return execute()})
 const missing=await gw.consume(x.tickets[1]);assert.equal(missing.result.status,'unknown')
 x.setHook(async(_s,execute)=>execute());await x.drain()
 assert.equal(count('action_tombstones'),1);assert.equal(count('gateway_receipts'),1)
 assert.equal((await gw.reconcile(missing.operationId)).status,'unknown')
 assert.equal((await x.witness.inspect()).pending.operation.operationId,missing.operationId)
 await gw.service.close();await x.witness.close()
 await assert.rejects(openExternalIncarnationAnchor(x.witnessConfig),/EEXIST/u) // pending owner retains its lock: no takeover
})

test('RIC-177 contradictory evidence stays unknown and latched; only restored exact evidence reconciles',{timeout:90000},async t=>{
 const x=await fixture(t),gw=await x.start();await gw.activate()
 x.setHook(async(s,execute)=>{const r=await execute();if(s==='COMMIT')throw Error('lost');return r})
 const c=await gw.consume(x.tickets[0]);assert.equal(c.result.status,'unknown');x.setHook(async(_s,execute)=>execute())
 const intact=dump()
 // A privileged administrator removes the native tombstone out of band: the
 // committed receipt now contradicts native state.
 sql('ALTER TABLE ppo_authority.action_tombstones DISABLE TRIGGER immutable_action_tombstones;DELETE FROM ppo_authority.action_tombstones;ALTER TABLE ppo_authority.action_tombstones ENABLE TRIGGER immutable_action_tombstones;')
 assert.equal(count('gateway_receipts'),1);assert.equal(count('action_tombstones'),0)
 assert.equal((await gw.reconcile(c.operationId)).status,'unknown')
 assert.equal((await x.witness.inspect()).pending.operation.operationId,c.operationId)
 assert.equal((await gw.consume(x.tickets[1])).result.status,'denied')
 restore(intact)
 const rec=await gw.reconcile(c.operationId);assert.equal(rec.status,'reconciled');assert.equal(rec.outcome,'consumed')
 await x.drain()
})

test('RIC-177 restore that loses the positive outcome cannot reconcile an outstanding operation',{timeout:90000},async t=>{
 const x=await fixture(t),gw=await x.start(),snapshot=dump();await gw.activate()
 x.setHook(async(s,execute)=>{const r=await execute();if(s==='COMMIT')throw Error('lost');return r})
 const lost=await gw.consume(x.tickets[0]);assert.equal(lost.result.status,'unknown');x.setHook(async(_s,execute)=>execute())
 restore(snapshot)
 assert.equal((await gw.reconcile(lost.operationId)).status,'unknown')
 assert.equal((await x.witness.inspect()).pending.operation.operationId,lost.operationId)
 await x.drain()
})

test('RIC-177 shutdown during an in-flight mutation disposes the actual session without commit and latches the operation',{timeout:90000},async t=>{
 const x=await fixture(t),gw=await x.start();await gw.activate()
 const holder=createPostgresTestSession(spawn('docker',['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],{stdio:['pipe','pipe','pipe']}))
 x.cleanup.push(()=>holder.close())
 x.setHook(async(s,execute)=>{if(s===G.consume)await holder.send('BEGIN;SELECT 1 FROM ppo_authority.gate WHERE singleton FOR UPDATE;');return execute()})
 const pending=gw.consume(x.tickets[0])
 let waiting='0'
 for(let i=0;i<300&&waiting==='0';i++){waiting=sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='"+APP+"' AND wait_event_type='Lock';");if(waiting==='0')await sleep(10)}
 assert.equal(waiting,'1')
 await gw.service.close()
 const r=await pending;assert.equal(r.result.status,'unknown');flagsFalse(r.result)
 await holder.send('ROLLBACK;')
 let remaining
 const deadline=performance.now()+3000
 do{remaining=sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='"+APP+"';");if(remaining==='0')break;await sleep(10)}while(performance.now()<deadline)
 assert.equal(remaining,'0')
 assert.equal(count('action_tombstones'),0);assert.equal(count('gateway_receipts'),0);assert.equal(x.counts.commits,0)
 assert.equal((await x.witness.inspect()).pending.operation.operationId,r.operationId)
 await x.witness.close();await assert.rejects(openExternalIncarnationAnchor(x.witnessConfig),/EEXIST/u)
 await x.drain()
})

test('RIC-177 witness journal capacity is reserved for closure: deny before exhaustion, never prune or reset',{timeout:150000},async t=>{
 const x=await fixture(t),gw=await x.start();await gw.activate()
 const target=EXTERNAL_INCARNATION_LAB_LIMITS.records-GATEWAY_RECORD_RESERVE
 while((await x.witness.inspect()).sequence<target){await x.witness.quarantine();await gw.activate()}
 assert.equal((await x.witness.inspect()).sequence,target)
 const ok=await gw.consume(x.tickets[0]);assert.equal(ok.result.status,'gateway-consumed')
 await gw.activate()
 const e=await x.witness.inspect(),before=checkpoint()
 assert.ok(EXTERNAL_INCARNATION_LAB_LIMITS.records-e.sequence<GATEWAY_RECORD_RESERVE)
 const denied=await gw.consume(x.tickets[1]);assert.equal(denied.result.status,'unavailable');flagsFalse(denied.result)
 assert.equal((await x.witness.inspect()).sequence,e.sequence);assert.equal(checkpoint(),before);assert.equal(count('action_tombstones'),1)
 await gw.service.close();await x.witness.close() // reserved closure record remains available
 const reopened=await openExternalIncarnationAnchor(x.witnessConfig).catch(error=>error)
 assert.ok(reopened instanceof Error) // full journal: reopening cannot append, no reset/prune exists
 await x.drain()
})
