import nativeTest,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import {randomUUID} from 'node:crypto'
import {serviceTlsFixture,finishServiceTestFixture} from '../deployment/authority/service-transport-test-fixture.mjs'
import {createIsolatedPinnedService,createIsolatedPinnedClient,createIsolatedPinRegistry,PINNED_SERVICE_LIMITS,SERVICE_ROLE_PROBE,SERVICE_ADMIN_SQL,serviceLogin} from './isolated-pinned-service-transport.mjs'
import {POSTGRES_ACTION_SQL as A} from './software-factory-remote-postgres-action-fence.mjs'
const test=(name,fn)=>nativeTest(name,{timeout:15000},fn)
const mode='isolated-pinned-service-transport-only',flags={grant:false,canExecute:false,releaseAuthorized:false}
let fixture
before(async()=>{fixture=await serviceTlsFixture()})
after(async()=>{await fixture?.close()})
const operation=()=>({ticket:randomUUID(),operationId:randomUUID()})
function connections(handler=async()=>({rows:[]}),probe={}){
 const state={opened:0,disposed:0,statements:[],committed:0}
 const open=role=>async()=>{state.opened++;return {async query(s,a){state.statements.push(s);if(s===SERVICE_ROLE_PROBE)return {rows:[{role,login:serviceLogin(role),privileged:false,login_privileged:false,memberships:[role],...probe}]};if(s==='COMMIT')state.committed++;return handler(s,a)},async dispose(){state.disposed++}}}
 return {state,consumer:{actionConsumer:open('ppo_action_consumer'),resourceConsumer:open('ppo_resource_consumer')},admin:{admin:open('ppo_action_admin')}}
}
function actionRows(s,a){if(['BEGIN','COMMIT','ROLLBACK'].includes(s))return {rows:[]};return {rows:[{evidence:{consumed:true,ticket:a[0],operationId:a[1],targetId:'00000000-0000-4000-8000-000000000001',generation:'3',contextHash:'a'.repeat(64),observedMicros:'1000000',fresh:true}}]}}
async function server(c,pins=fixture.registry(),service='consumer'){
 const cert=fixture.certs[service],s=createIsolatedPinnedService({mode,service,identity:cert.identity,tls:cert.tls,pins,connections:c[service==='administrator'?'admin':'consumer']})
 return {s,pins,...await s.listen()}
}
function client(x,{peer='coordinator',pins=x.pins}={}){return createIsolatedPinnedClient({mode,service:x.service,serverIdentity:fixture.certs[x.service].identity,port:x.port,tls:fixture.certs[peer].tls,pins})}
async function raw(x,text,{peer='coordinator',path='/v1/action/consume',headers={}}={}){
 return new Promise((resolve,reject)=>{const req=https.request({host:'127.0.0.1',servername:'localhost',port:x.port,path,method:'POST',...fixture.certs[peer].tls,agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(text),...headers}},res=>{let data='';res.setEncoding('utf8');res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,result:JSON.parse(data)}))});req.on('error',reject);req.setTimeout(3000,()=>req.destroy());req.end(text)})
}

test('explicit isolated mode, fixed service capabilities and initial pin ownership are required',()=>{
 assert.throws(()=>createIsolatedPinnedService());assert.throws(()=>createIsolatedPinnedClient());assert.throws(()=>createIsolatedPinRegistry({mode,entries:[]}))
 const c=connections(),pins=fixture.registry()
 assert.throws(()=>createIsolatedPinnedService({mode,service:'consumer',identity:fixture.certs.consumer.identity,tls:fixture.certs.consumer.tls,pins,connections:{...c.consumer,admin:c.admin.admin}}))
 assert.throws(()=>pins.rotate('lab-coordinator',2,fixture.certs.coordinatorNew.fingerprint))
})
test('actual mTLS pinned diagnostic consumption owns and disposes one dedicated connection',async()=>{
 const c=connections(actionRows),x=await server(c)
 try{const api=client(x),r=await api.send('/v1/action/consume',operation());assert.equal(r.status,'consumed-diagnostic');for(const[k,v]of Object.entries(flags))assert.equal(r[k],v);await assert.rejects(api.send('/v1/action/consume',operation()));assert.equal(c.state.opened,1);assert.equal(c.state.disposed,1);assert.equal(c.state.committed,1)}finally{await x.s.close()}
})
test('unregistered and wrong-kind certificates cannot cross verifier/consumer/administrator boundaries',async()=>{
 const c=connections(actionRows),x=await server(c),admin=await server(c,x.pins,'administrator')
 try{assert.equal((await client(x,{peer:'unknown'}).send('/v1/action/consume',operation())).status,'denied');assert.equal((await client(x,{peer:'admin'}).send('/v1/action/consume',operation())).status,'denied');assert.equal((await client(admin).send('/v1/context/revoke',{kind:'claim',hash:'a'.repeat(64)})).status,'denied');assert.equal(c.state.opened,0)}finally{await x.s.close();await admin.s.close()}
})
test('server key pin mismatch denies even a CA-valid service certificate',async()=>{
 const c=connections(actionRows),x=await server(c),pins=fixture.registry();pins.rotate(fixture.certs.consumer.identity,1,fixture.certs.consumerNew.fingerprint)
 try{assert.equal((await client(x,{pins}).send('/v1/action/consume',operation())).status,'unknown');assert.equal(c.state.opened,0)}finally{await x.s.close()}
})
test('role/SQL/attestation injection, duplicate decoded keys, malformed and oversized bodies deny before DB dispatch',async()=>{
 const c=connections(actionRows),x=await server(c)
 try{
  for(const body of [{...operation(),role:'ppo_action_admin'},{query:'COMMIT'}, {...operation(),context:{accepted:true}}])assert.equal((await raw(x,JSON.stringify(body))).result.status,'denied')
  assert.equal((await raw(x,'{"ticket":"x","ti\\u0063ket":"y"}')).result.status,'denied')
  assert.equal((await raw(x,'{')).result.status,'denied')
  assert.equal((await raw(x,' '.repeat(PINNED_SERVICE_LIMITS.requestBytes+1))).result.status,'denied')
  assert.equal((await client(x).send('/v1/arbitrary/execute',operation())).status,'denied')
  assert.equal(c.state.opened,0)
 }finally{await x.s.close()}
})
test('privileged login, wrong current role or expanded membership rejects the connection before mutation',async()=>{
 for(const probe of [{login_privileged:true},{privileged:true},{role:'postgres'},{memberships:['ppo_action_consumer','ppo_action_admin']}]){
  const c=connections(actionRows,probe),x=await server(c)
  try{assert.equal((await client(x).send('/v1/action/consume',operation())).status,'denied');assert.deepEqual(c.state.statements,[SERVICE_ROLE_PROBE]);assert.equal(c.state.disposed,1)}finally{await x.s.close()}
 }
})
test('rotation/revocation rechecks existing attempt, disposes uncertainty and never retries a transaction',async()=>{
 let entered,release;const enteredPromise=new Promise(r=>entered=r),held=new Promise(r=>release=r)
 const c=connections(async(s,a)=>{if(s===A.consume){entered();await held}return actionRows(s,a)}),x=await server(c)
 try{
  const pending=client(x).send('/v1/action/consume',operation());await enteredPromise;x.pins.rotate('lab-coordinator',1,fixture.certs.coordinatorNew.fingerprint)
  const r=await pending;release();assert.equal(r.status,'unknown');assert.equal(c.state.disposed,1);assert.equal(c.state.committed,0)
  assert.equal((await client(x).send('/v1/action/consume',operation())).status,'denied')
  assert.equal((await client(x,{peer:'coordinatorNew'}).send('/v1/action/consume',operation())).status,'consumed-diagnostic')
  x.pins.revoke('lab-coordinator',2);assert.equal((await client(x,{peer:'coordinatorNew'}).send('/v1/action/consume',operation())).status,'denied')
  assert.throws(()=>x.pins.rotate('lab-coordinator',3,fixture.certs.coordinator.fingerprint))
 }finally{release();await x.s.close()}
})
test('lost COMMIT acknowledgment and oversized output return unknown and dispose without another COMMIT',async()=>{
 for(const failure of ['ack','output']){
  const c=connections(async(s,a)=>{if(s==='COMMIT'&&failure==='ack')throw Error('lost acknowledgment');const r=actionRows(s,a);if(s===A.observe&&failure==='output')r.rows[0].evidence.extra='x'.repeat(PINNED_SERVICE_LIMITS.responseBytes);return r}),x=await server(c)
  try{const api=client(x);assert.equal((await api.send('/v1/action/consume',operation())).status,'unknown');await assert.rejects(api.send('/v1/action/consume',operation()));assert.equal(c.state.committed,1);assert.equal(c.state.disposed,1)}finally{await x.s.close()}
 }
})
test('fixed administrator functions remain separate and validate exact acknowledgment types',async()=>{
 const c=connections(async(s,a)=>s===SERVICE_ADMIN_SQL.configure?{rows:[{epoch:String(a[1]+1)}]}:{rows:[{revoked:''}]}),x=await server(c,fixture.registry(),'administrator')
 try{const r=await client(x,{peer:'admin'}).send('/v1/host/configure',{hostId:'lab-test',expectedEpoch:0,policy:{status:'active'}});assert.equal(r.status,'updated');assert.equal(r.epoch,'1');assert.equal(c.state.disposed,1);assert.equal((await client(x,{peer:'admin'}).send('/v1/context/revoke',{kind:'claim',hash:'f'.repeat(64)})).status,'updated');assert.equal(c.state.disposed,2)}finally{await x.s.close()}
})
test('server-key rotation denies the old service and requires independently pinned replacement credentials',async()=>{
 const c=connections(actionRows),x=await server(c);let replacement
 try{x.pins.rotate('lab-consumer',1,fixture.certs.consumerNew.fingerprint);assert.equal((await client(x).send('/v1/action/consume',operation())).status,'unknown');replacement=createIsolatedPinnedService({mode,service:'consumer',identity:'lab-consumer',tls:fixture.certs.consumerNew.tls,pins:x.pins,connections:c.consumer});const address=await replacement.listen();assert.equal((await client({...x,port:address.port}).send('/v1/action/consume',operation())).status,'consumed-diagnostic')}finally{await x.s.close();await replacement?.close()}
})
test('concurrent connection budget denies excess work without opening another DB connection',async()=>{
 let entered=0,allEntered,release;const ready=new Promise(r=>allEntered=r),held=new Promise(r=>release=r)
 const c=connections(async(s,a)=>{if(s===A.consume){if(++entered===PINNED_SERVICE_LIMITS.concurrent)allEntered();await held}return actionRows(s,a)}),x=await server(c)
 try{const pending=Array.from({length:PINNED_SERVICE_LIMITS.concurrent},()=>client(x).send('/v1/action/consume',operation()));await ready;assert.equal((await client(x).send('/v1/action/consume',operation())).status,'unavailable');assert.equal(c.state.opened,PINNED_SERVICE_LIMITS.concurrent);release();for(const r of await Promise.all(pending))assert.equal(r.status,'consumed-diagnostic')}finally{release();await x.s.close()}
})
test('cancelled opening factories retain capacity until every late connection is disposed',async()=>{
 let calls=0,entered,release,disposed;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r),drained=new Promise(r=>disposed=r)
 const c=connections(actionRows),open=c.consumer.actionConsumer
 c.consumer.actionConsumer=async()=>{if(++calls===PINNED_SERVICE_LIMITS.concurrent)entered();if(calls<=PINNED_SERVICE_LIMITS.concurrent)await held;const s=await open(),close=s.dispose;return {...s,async dispose(){await close();if(c.state.disposed===PINNED_SERVICE_LIMITS.concurrent)disposed()}}}
 const x=await server(c)
 try{
  const pending=Array.from({length:PINNED_SERVICE_LIMITS.concurrent},()=>client(x).send('/v1/action/consume',operation()));await ready
  x.pins.rotate('lab-coordinator',1,fixture.certs.coordinatorNew.fingerprint)
  for(const r of await Promise.all(pending))assert.equal(r.status,'unknown')
  assert.equal((await client(x,{peer:'coordinatorNew'}).send('/v1/action/consume',operation())).status,'unavailable');assert.equal(calls,PINNED_SERVICE_LIMITS.concurrent)
  release();await drained
  assert.equal((await client(x,{peer:'coordinatorNew'}).send('/v1/action/consume',operation())).status,'consumed-diagnostic')
 }finally{release();await x.s.close()}
})
test('cancelled in-flight connections retain capacity and shutdown waits for actual disposal',async()=>{
 let entered=0,ready,releaseQuery,releaseDispose;const allEntered=new Promise(r=>ready=r),queryHeld=new Promise(r=>releaseQuery=r),disposeHeld=new Promise(r=>releaseDispose=r)
 const c=connections(async(s,a)=>{if(s===A.consume){if(++entered===PINNED_SERVICE_LIMITS.concurrent)ready();await queryHeld}return actionRows(s,a)}),open=c.consumer.actionConsumer
 c.consumer.actionConsumer=async()=>{const s=await open(),close=s.dispose;return {...s,async dispose(){await disposeHeld;await close()}}}
 const x=await server(c)
 try{
  const pending=Array.from({length:PINNED_SERVICE_LIMITS.concurrent},()=>client(x).send('/v1/action/consume',operation()));await allEntered
  x.pins.rotate('lab-coordinator',1,fixture.certs.coordinatorNew.fingerprint)
  for(const r of await Promise.all(pending))assert.equal(r.status,'unknown')
  assert.equal((await client(x,{peer:'coordinatorNew'}).send('/v1/action/consume',operation())).status,'unavailable')
  assert.equal(c.state.opened,PINNED_SERVICE_LIMITS.concurrent);assert.equal(c.state.disposed,0)
  const closing=x.s.close();assert.equal(await Promise.race([closing.then(()=> 'closed'),new Promise(r=>setTimeout(()=>r('held'),25))]),'held')
  releaseDispose();releaseQuery();await closing;assert.equal(c.state.disposed,PINNED_SERVICE_LIMITS.concurrent)
 }finally{releaseDispose();releaseQuery();await x.s.close()}
})
test('failed disposal quarantines capacity and shutdown reports uncertainty',async()=>{
 const c=connections(actionRows),open=c.consumer.actionConsumer
 c.consumer.actionConsumer=async()=>({...await open(),async dispose(){throw Error('session termination uncertain')}})
 const x=await server(c)
 try{
  for(let i=0;i<PINNED_SERVICE_LIMITS.concurrent;i++)assert.equal((await client(x).send('/v1/action/consume',operation())).status,'consumed-diagnostic')
  assert.equal((await client(x).send('/v1/action/consume',operation())).status,'unavailable');assert.equal(c.state.opened,PINNED_SERVICE_LIMITS.concurrent)
  await assert.rejects(x.s.close(),/denied|unavailable/)
 }finally{await x.s.close().catch(()=>{})}
})
test('client binds acknowledgments to its immutable serialized request despite caller mutation',async()=>{
 for(const rebound of [false,true]){
  const original=operation(),expected={...original},replacement=operation()
  const s=https.createServer({...fixture.certs.consumer.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},(req,res)=>{
   req.resume();Object.assign(original,replacement);const bound=rebound?replacement:expected
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...flags,status:'consumed-diagnostic',operation:bound,evidence:actionRows(A.consume,[bound.ticket,bound.operationId]).rows[0].evidence}))
  });await new Promise(r=>s.listen(0,'127.0.0.1',r))
  try{const r=await client({port:s.address().port,service:'consumer',pins:fixture.registry()}).send('/v1/action/consume',original);assert.equal(r.status,rebound?'unknown':'consumed-diagnostic');if(!rebound)assert.deepEqual(r.operation,expected)}finally{await new Promise(r=>s.close(r))}
 }
})
test('malformed, overlarge or grant-bearing responses from a pinned TLS peer remain unknown',async()=>{
 for(const text of ['{"grant":false,"grant":false}',JSON.stringify({...flags,status:'invented'}),JSON.stringify({...flags,status:'consumed-diagnostic'}),JSON.stringify({...flags,status:'updated',epoch:'1'}),JSON.stringify({grant:true,canExecute:true,releaseAuthorized:true,status:'consumed-diagnostic'}),' '.repeat(PINNED_SERVICE_LIMITS.responseBytes+1)]){
  const s=https.createServer({...fixture.certs.consumer.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},(req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(text)});await new Promise(r=>s.listen(0,'127.0.0.1',r))
  try{const x={port:s.address().port,service:'consumer',pins:fixture.registry()};assert.equal((await client(x).send('/v1/action/consume',operation())).status,'unknown')}finally{await new Promise(r=>s.close(r))}
 }
})

test('fixture cleanup attempts every resource and preserves the primary failure',async()=>{
 const primary=Error('original test failure'),cleanup=Error('server close failed'),attempted=[]
 const steps=[async()=>{attempted.push('server');throw cleanup},async()=>{attempted.push('session')},async()=>{attempted.push('role');throw Error('role drop failed')},async()=>{attempted.push('schema')}]
 await assert.rejects(finishServiceTestFixture(steps,primary),error=>{assert.equal(error.cause,primary);assert.deepEqual(error.errors.slice(0,2),[primary,cleanup]);assert.equal(error.errors.length,3);return true})
 assert.deepEqual(attempted,['server','session','role','schema'])
 await assert.rejects(finishServiceTestFixture([async()=>{}],primary),error=>error===primary)
 await finishServiceTestFixture([async()=>{}])
})
