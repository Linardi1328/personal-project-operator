import nativeTest,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import {randomUUID,createHash} from 'node:crypto'
import {signedActionFixture} from '../deployment/authority/action-test-fixture.mjs'
import {serviceTlsFixture,finishServiceTestFixture} from '../deployment/authority/service-transport-test-fixture.mjs'
import {createIsolatedPinnedService,createIsolatedPinnedClient,createIsolatedPinRegistry,PINNED_SERVICE_LIMITS,SERVICE_ROLE_PROBE,SERVICE_ADMIN_SQL,serviceLogin} from './isolated-pinned-service-transport.mjs'
import {remotePayloadDigest} from './software-factory-remote-contract.mjs'
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

test('pinned verifier resource-context acknowledgments require complete typed and consistent diagnostic snapshots',async()=>{
 const ticket=randomUUID(),resourceId=randomUUID()
 const f=signedActionFixture({runId:'A'.repeat(43),version:1,project:{id:'synthetic'},branch:'feature/synthetic',baseSha:'a'.repeat(40),headSha:'b'.repeat(40)})
 const snapshot={contextHash:'a'.repeat(64),context:{targetId:randomUUID(),sourceId:randomUUID(),generation:'3',catalogDigest:'b'.repeat(64),
  coordinatorFingerprint:f.policy.coordinatorFingerprint,workerFingerprint:f.policy.workerFingerprint,hostFingerprint:f.policy.keyFingerprint,
  request:f.request,claim:f.claim,proof:f.proof,requestHash:f.requestHash,claimHash:f.claimHash,proofHash:'c'.repeat(64)},
  resource:{resource_id:resourceId,version:0,project:'synthetic',path:'src/synthetic.mjs',value:'',ref:createHash('sha256').update('').digest('hex')}}
 const variants=[
  ['truthy primitive context',s=>{s.context=true}],
  ['missing proof',s=>{delete s.context.proof}],
  ['missing hostId',s=>{delete s.context.proof.hostId}],
  ['non-string hostId',s=>{s.context.proof.hostId={}}],
  ['wrong host binding',s=>{s.context.proof.hostId='lab-other-host'}],
  ['missing request',s=>{delete s.context.request}],
  ['malformed request',s=>{s.context.request.expectedVersion='1'}],
  ['missing claim',s=>{delete s.context.claim}],
  ['wrong digest',s=>{s.context.requestHash='0'.repeat(64)}],
  ['malformed generation',s=>{s.context.generation='0'}],
  ['missing resource version',s=>{delete s.resource.version}],
  ['malformed resource version',s=>{s.resource.version='0'}],
  ['resource value/ref mismatch',s=>{s.resource.value='different'}],
  ['noncanonical resource path',s=>{s.resource.path='src/other.mjs'}]
 ]
 let response=snapshot,requests=0
 const peer=https.createServer({...fixture.certs.verifier.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'},(req,res)=>{
  requests++;req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...flags,status:'context',context:response}))
 })
 await new Promise(r=>peer.listen(0,'127.0.0.1',r))
 try{
  const x={port:peer.address().port,service:'verifier',pins:fixture.registry()}
  for(const [name,mutate] of variants){
   response=structuredClone(snapshot);mutate(response)
   const api=client(x),before=requests
   const result=await api.send('/v1/resource/context',{ticket})
   assert.deepEqual(result,{...flags,status:'unknown'},name)
   assert.equal(requests,before+1,name)
   await assert.rejects(api.send('/v1/resource/context',{ticket}))
   assert.equal(requests,before+1,name)
  }
  response=snapshot
  const result=await client(x).send('/v1/resource/context',{ticket})
  assert.deepEqual(result,{...flags,status:'context',context:snapshot})
  // Read-only observations at the terminal version are still valid diagnostic
  // context; descriptor registration independently denies an exhausted resource.
  response=structuredClone(snapshot);response.resource.version=999
  assert.deepEqual(await client(x).send('/v1/resource/context',{ticket}),{...flags,status:'context',context:response})
 }finally{await new Promise(r=>peer.close(r))}
})

test('fixture cleanup attempts every resource and preserves the primary failure',async()=>{
 const primary=Error('original test failure'),cleanup=Error('server close failed'),attempted=[]
 const steps=[async()=>{attempted.push('server');throw cleanup},async()=>{attempted.push('session')},async()=>{attempted.push('role');throw Error('role drop failed')},async()=>{attempted.push('schema')}]
 await assert.rejects(finishServiceTestFixture(steps,primary),error=>{assert.equal(error.cause,primary);assert.deepEqual(error.errors.slice(0,2),[primary,cleanup]);assert.equal(error.errors.length,3);return true})
 assert.deepEqual(attempted,['server','session','role','schema'])
 await assert.rejects(finishServiceTestFixture([async()=>{}],primary),error=>error===primary)
 await finishServiceTestFixture([async()=>{}])
})


const nativeHash=value=>createHash('sha256').update(value).digest('hex')
function diagnosticSnapshot(){
 const f=signedActionFixture({runId:'A'.repeat(43),version:1,project:{id:'synthetic'},branch:'feature/synthetic',baseSha:'a'.repeat(40),headSha:'b'.repeat(40)}, {now:Date.parse('2026-01-01T00:00:00.000Z')})
 return {contextHash:'a'.repeat(64),context:{targetId:randomUUID(),sourceId:randomUUID(),generation:'3',catalogDigest:'b'.repeat(64),coordinatorFingerprint:f.policy.coordinatorFingerprint,workerFingerprint:f.policy.workerFingerprint,hostFingerprint:f.policy.keyFingerprint,request:f.request,claim:f.claim,proof:f.proof,requestHash:f.requestHash,claimHash:f.claimHash,proofHash:'c'.repeat(64)},resource:{resource_id:randomUUID(),version:0,project:'synthetic',path:'src/synthetic.mjs',value:'',ref:nativeHash('')}}
}
function refreshDiagnosticDigests(s){
 const c=s.context
 c.requestHash=remotePayloadDigest(c.request);c.claim.requestHash=c.requestHash
 c.claimHash=remotePayloadDigest(c.claim);c.proof.requestHash=c.requestHash;c.proof.claimHash=c.claimHash
}
// Every case traverses authenticated, pinned mutual TLS. A control response
// proves the same route works, and peer counts rule out pre-dispatch failures.
async function diagnosticPeer(service,fn){
 let response,requests=0
 const peer=https.createServer({...fixture.certs[service].tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},(req,res)=>{
  assert.equal(req.socket.authorized,true);requests++;req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response))
 });await new Promise(r=>peer.listen(0,'127.0.0.1',r))
 const x={port:peer.address().port,service,pins:fixture.registry()}
 async function check(path,body,reply,expected,label){
  response=reply;const api=client(x),before=requests
  const result=await api.send(path,body)
  assert.equal(requests,before+1,label+' reached peer')
  await assert.rejects(api.send(path,body));assert.equal(requests,before+1,label+' single attempt')
  assert.deepEqual(result,expected==='unknown'?{...flags,status:'unknown'}:reply,label)
 }
 try{await fn(check)}finally{await new Promise(r=>peer.close(r))}
}

nativeTest('P2-1 diagnostic cross-payload consistency over pinned mutual TLS',async t=>{
 const baseline=diagnosticSnapshot(),body={ticket:randomUUID()},iso=n=>new Date(n).toISOString(),start=Date.parse(baseline.context.request.issuedAt),end=Date.parse(baseline.context.request.expiresAt)
 const variants=[
  ['proof issued before request',s=>{s.context.proof.issuedAt=iso(start-1);s.context.proof.expiresAt=iso(start+1000)}],
  ['proof expires after request',s=>{s.context.proof.issuedAt=iso(end-1000);s.context.proof.expiresAt=iso(end+1)}],
  ['claim issued before request',s=>{s.context.claim.claimedAt=iso(start-1)}],
  ['claim lease expires after request',s=>{s.context.claim.leaseExpiresAt=iso(end+1)}],
  ['proof action absent from permits',s=>{s.context.request.scope.permits=['workspace.read']}],
  ['proof outside allowed path',s=>{s.context.proof.actionPath='other/synthetic.mjs'}],
  ['proof path prefix is not containment',s=>{s.context.proof.actionPath='src-evil/synthetic.mjs'}],
  ['standalone terminal dot segment',s=>{s.context.proof.actionPath='src/.'}]
 ]
 await diagnosticPeer('verifier',async check=>{
  await check('/v1/resource/context',body,{...flags,status:'context',context:baseline},'context','historical expired control')
  for(const[name,mutate]of variants)await t.test(name,async()=>{
   const s=structuredClone(baseline);mutate(s);refreshDiagnosticDigests(s)
   await check('/v1/resource/context',body,{...flags,status:'context',context:s},'unknown',name)
  })
 })
})

const invalidNativeStrings=[['NUL','a\0b'],['unpaired high surrogate','a\ud800b'],['unpaired low surrogate','a\udc00b']]
nativeTest('P2-2 native context strings over pinned mutual TLS',async t=>{
 const baseline=diagnosticSnapshot(),body={ticket:randomUUID()}
 await diagnosticPeer('verifier',async check=>{
  for(const[name,value]of invalidNativeStrings)await t.test(name,async()=>{
   const s=structuredClone(baseline);s.resource.value=value;s.resource.ref=nativeHash(value)
   await check('/v1/resource/context',body,{...flags,status:'context',context:s},'unknown',name)
  })
  for(const[name,value]of [['supplementary Unicode','😀'.repeat(1024)],['legal controls','\u0001'.repeat(4096)],['4096 ASCII bytes','x'.repeat(4096)]])await t.test(name,async()=>{
   const s=structuredClone(baseline);s.resource.version=999;s.resource.value=value;s.resource.ref=nativeHash(value)
   await check('/v1/resource/context',body,{...flags,status:'context',context:s},'context',name)
  })
 })
})

nativeTest('P2-3 complete receipt states over pinned mutual TLS',async t=>{
 const body={...operation(),descriptorHash:'a'.repeat(64)},state=diagnosticSnapshot().resource
 const receipt={operation_id:body.operationId,ticket:body.ticket,descriptor_hash:body.descriptorHash,before_state:state,after_state:{...state,version:1,value:'next',ref:nativeHash('next')}}
 const evidence={consumed:true,ticket:body.ticket,operationId:body.operationId,targetId:randomUUID(),generation:'3',contextHash:'b'.repeat(64),observedMicros:'1000000',fresh:true}
 const variants=[]
 for(const side of ['before_state','after_state']){
  for(const field of Object.keys(state))variants.push([`${side} missing ${field}`,r=>{delete r[side][field]}])
  variants.push([`${side} extra field`,r=>{r[side].extra=true}])
  for(const version of [-1,1000,0.5,'0',null])variants.push([`${side} invalid version ${JSON.stringify(version)}`,r=>{r[side].version=version;if(side==='before_state')r.after_state.version=Number(version)+1;else r.before_state.version=Number(version)-1}])
  for(const[name,value]of invalidNativeStrings)variants.push([`${side} ${name}`,r=>{r[side].value=value;r[side].ref=nativeHash(value)}])
  variants.push([`${side} mismatched value hash`,r=>{r[side].ref='f'.repeat(64)}])
  variants.push([`${side} oversized value`,r=>{r[side].value='x'.repeat(4097);r[side].ref=nativeHash(r[side].value)}])
  variants.push([`${side} malformed resource id`,r=>{r[side].resource_id='invalid'}])
  variants.push([`${side} invalid project`,r=>{r[side].project='INVALID'}])
  variants.push([`${side} changed project`,r=>{r[side].project='other'}])
  variants.push([`${side} changed path`,r=>{r[side].path='src/other.mjs'}])
 }
 variants.push(['resource identity discontinuity',r=>{r.after_state.resource_id=randomUUID()}],['version gap',r=>{r.after_state.version=2}],['version reversal',r=>{r.after_state.version=0}])
 await diagnosticPeer('consumer',async check=>{
  for(const status of ['consumed-diagnostic','expired-or-stale','committed-synthetic-effect']){
   const path=status==='committed-synthetic-effect'?'/v1/resource/inspect':'/v1/resource/apply'
   const reply=r=>({...flags,status,operation:body,...(status==='committed-synthetic-effect'?{}:{evidence:{...evidence,fresh:status==='consumed-diagnostic'}}),receipt:r})
   await check(path,body,reply(receipt),status,status+' control')
   for(const[name,mutate]of variants)await t.test(status+' '+name,async()=>{
    const r=structuredClone(receipt);mutate(r);await check(path,body,reply(r),'unknown',name)
   })
   for(const[name,before,after]of [['supplementary Unicode','😀'.repeat(1024),'𐀀'.repeat(1024)],['maximum escaped receipt','\u0001'.repeat(4096),'\u0002'.repeat(4096)],['terminal version','','final']])await t.test(status+' '+name,async()=>{
    const r=structuredClone(receipt);Object.assign(r.before_state,{version:998,value:before,ref:nativeHash(before)});Object.assign(r.after_state,{version:999,value:after,ref:nativeHash(after)})
    await check(path,body,reply(r),status,name)
   })
  }
 })
})
