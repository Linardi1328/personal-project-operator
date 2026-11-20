// Unit coverage of request validation and fail-closed JS control flow only.
// Security guarantees (privileges, checkpoint, restore/clone, commit) are
// proved by the actual PostgreSQL/mTLS phase2bc integration suite, not here.
import nativeTest,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {createAuthenticatedAuthorityGateway,authorityGatewayRoute,gatewayInputText,gatewaySubjectHash,AUTHORITY_GATEWAY_SQL as G,GATEWAY_RECORD_RESERVE} from './authenticated-authority-gateway.mjs'
import {createIsolatedPinnedService} from './isolated-pinned-service-transport.mjs'
import {EXTERNAL_INCARNATION_LAB_LIMITS} from './development-external-incarnation-anchor.mjs'
import {serviceTlsFixture} from '../deployment/authority/service-transport-test-fixture.mjs'
const test=(name,fn)=>nativeTest(name,{timeout:15000},fn)
const GM='isolated-authenticated-authority-gateway-only',TM='isolated-pinned-service-transport-only'
const sha=s=>createHash('sha256').update(s).digest('hex'),h=c=>c.repeat(64)
let tls
before(async()=>{tls=await serviceTlsFixture()})
after(async()=>{await tls?.close()})
const identity={anchorId:randomUUID(),authorityId:randomUUID(),ownerId:randomUUID()}
function fakeWitness(overrides={}){
 const calls=[],state={identity,incarnation:3,instanceId:randomUUID(),status:'open',checkpoint:h('a'),sequence:10,operations:[],pending:null,recordHash:h('b'),...overrides}
 const w={calls,state,
  inspect:async()=>{calls.push('inspect');return structuredClone(state)},
  reserve:async({operation})=>{calls.push('reserve');state.pending={operation,incarnation:state.incarnation,instanceId:state.instanceId,beforeCheckpoint:state.checkpoint};state.status='quarantined';state.operations.push(operation)},
  recordCommitted:async()=>{calls.push('recordCommitted');state.pending=null},
  quarantine:async()=>{calls.push('quarantine');state.status='quarantined'},
  activate:async()=>{calls.push('activate')}}
 return w
}
const make=(witness,pins=tls.registry())=>createAuthenticatedAuthorityGateway({mode:GM,witness,pinnedIdentity:identity,attestation:h('c'),pins,serviceIdentity:tls.certs.gateway.identity})
const ctx=(query,live=true)=>({query,live:()=>live,peer:{identity:'lab-coordinator',epoch:1,fingerprint:h('d')},service:{identity:tls.certs.gateway.identity,epoch:1,fingerprint:h('e')}})
const dbState=(over={})=>({rows:[{state:{profile:'ric177-disposable-authority-gateway-v1',...identity,lastIncarnation:2,sealedAttestation:h('c'),attestation:h('c'),checkpoint:h('a'),...over}}]})
const body=(w,over={})=>({operationId:randomUUID(),ticket:randomUUID(),expected:{incarnation:w.state.incarnation,instanceId:w.state.instanceId,checkpoint:w.state.checkpoint},...over})

test('construction requires explicit mode, pinned trust domain, attestation, trusted witness and a gateway-service pin',()=>{
 const w=fakeWitness(),pins=tls.registry()
 assert.throws(()=>createAuthenticatedAuthorityGateway())
 assert.throws(()=>createAuthenticatedAuthorityGateway({mode:GM,witness:w,pinnedIdentity:{...identity,extra:randomUUID()},attestation:h('c'),pins,serviceIdentity:tls.certs.gateway.identity}))
 assert.throws(()=>createAuthenticatedAuthorityGateway({mode:GM,witness:{inspect(){}},pinnedIdentity:identity,attestation:h('c'),pins,serviceIdentity:tls.certs.gateway.identity}))
 assert.throws(()=>createAuthenticatedAuthorityGateway({mode:GM,witness:w,pinnedIdentity:identity,attestation:'x',pins,serviceIdentity:tls.certs.gateway.identity}))
 assert.throws(()=>createAuthenticatedAuthorityGateway({mode:GM,witness:w,pinnedIdentity:identity,attestation:h('c'),pins,serviceIdentity:tls.certs.consumer.identity}))
 const g=make(w,pins)
 const conn={gateway:async()=>assert.fail('no connection')}
 assert.throws(()=>createIsolatedPinnedService({mode:TM,service:'consumer',identity:tls.certs.consumer.identity,tls:tls.certs.consumer.tls,pins,connections:{actionConsumer:async()=>{},resourceConsumer:async()=>{}},gateway:g}))
 assert.throws(()=>createIsolatedPinnedService({mode:TM,service:'gateway',identity:tls.certs.gateway.identity,tls:tls.certs.gateway.tls,pins,connections:conn}))
 for(const bad of [null,{...g,activate:undefined},{serviceIdentity:g.serviceIdentity,pins,handle:g.handle}])assert.throws(()=>createIsolatedPinnedService({mode:TM,service:'gateway',identity:tls.certs.gateway.identity,tls:tls.certs.gateway.tls,pins,connections:conn,gateway:bad}))
 assert.throws(()=>createIsolatedPinnedService({mode:TM,service:'gateway',identity:tls.certs.gateway.identity,tls:tls.certs.gateway.tls,pins:tls.registry(),connections:conn,gateway:g}))
 g.detach()
})

test('fixed routes accept only exact bounded shapes; no SQL, role, policy or attestation fields',()=>{
 const e={incarnation:1,instanceId:randomUUID(),checkpoint:h('a')},op=randomUUID()
 assert.ok(authorityGatewayRoute('/v1/gateway/consume',{operationId:op,ticket:randomUUID(),expected:e}))
 assert.ok(authorityGatewayRoute('/v1/gateway/revoke-host',{operationId:op,hostId:'lab-action-host',expectedEpoch:1,expected:e}))
 assert.deepEqual(authorityGatewayRoute('/v1/gateway/state',{}).statements,[G.state])
 assert.deepEqual(authorityGatewayRoute('/v1/gateway/reconcile',{operationId:op}).statements,[G.state,G.receipt])
 for(const [path,b] of [['/v1/gateway/execute',{}],['/v1/gateway/state',{sql:'COMMIT'}],['/v1/gateway/consume',{operationId:op,ticket:randomUUID(),expected:e,role:'ppo_action_admin'}],
  ['/v1/gateway/consume',{operationId:'x',ticket:randomUUID(),expected:e}],['/v1/gateway/consume',{operationId:op,ticket:randomUUID(),expected:{...e,checkpoint:'z'}}],
  ['/v1/gateway/consume',{operationId:op,ticket:randomUUID(),expected:{...e,attestation:h('c')}}],['/v1/gateway/revoke-host',{operationId:op,hostId:'lab-action-host',expectedEpoch:1,expected:e,policy:{status:'active'}}],
  ['/v1/gateway/revoke-host',{operationId:op,hostId:'../x',expectedEpoch:1,expected:e}],['/v1/gateway/revoke-host',{operationId:op,hostId:'lab-action-host',expectedEpoch:0,expected:e}],
  ['/v1/gateway/reconcile',{operationId:op,retry:true}]])assert.throws(()=>authorityGatewayRoute(path,b),path)
})

test('input digest binds every authenticated field; subject is kind-separated',()=>{
 const b={anchorId:identity.anchorId,authorityId:identity.authorityId,ownerId:identity.ownerId,incarnation:2,instanceId:randomUUID(),checkpoint:h('a'),peerIdentity:'lab-coordinator',peerEpoch:1,peerFingerprint:h('d'),serviceIdentity:'lab-gateway',serviceEpoch:1}
 const base={kind:'consume-action',operationId:randomUUID(),key:randomUUID(),detail:'',binding:b},digest=sha(gatewayInputText(base))
 for(const k of Object.keys(b))assert.notEqual(sha(gatewayInputText({...base,binding:{...b,[k]:typeof b[k]==='number'?b[k]+1:b[k]+'0'}})),digest,k)
 for(const k of ['kind','operationId','key','detail'])assert.notEqual(sha(gatewayInputText({...base,[k]:base[k]+'x'})),digest,k)
 assert.notEqual(gatewaySubjectHash('consume-action','lab-x'),gatewaySubjectHash('revoke-host','lab-x'))
})

test('fail-closed control flow: mismatched expectations, divergent native state and exhausted capacity deny before reservation',async()=>{
 for(const [label,over,expectStatus,expectQuarantine] of [
  ['stale client incarnation',{expected:'incarnation'},'denied',false],['witness quarantined',{status:'quarantined'},'denied',false],
  ['divergent checkpoint',{db:{checkpoint:h('f')}},'denied',true],['changed attestation',{db:{attestation:h('0')}},'denied',true],['foreign owner',{db:{ownerId:randomUUID()}},'denied',true],
  ['capacity',{sequence:EXTERNAL_INCARNATION_LAB_LIMITS.records-GATEWAY_RECORD_RESERVE+1},'unavailable',false]]){
  const w=fakeWitness(over.status||over.sequence?{...(over.status?{status:over.status}:{}),...(over.sequence?{sequence:over.sequence}:{})}:{}),g=make(w),statements=[]
  const b=body(w);if(over.expected)b.expected.incarnation++
  const r=await g.handle('/v1/gateway/consume',b,ctx(async s=>{statements.push(s);return dbState(over.db)}))
  assert.equal(r.status,expectStatus,label);assert.equal(r.grant,false);assert.equal(r.canExecute,false);assert.equal(r.releaseAuthorized,false)
  assert.ok(!w.calls.includes('reserve'),label);assert.equal(w.calls.includes('quarantine'),expectQuarantine,label)
  assert.ok(!statements.includes(G.consume),label);g.detach()
 }
})

test('after durable reservation any failure is unknown and latched; reconciliation never issues an effect statement',async()=>{
 const w=fakeWitness(),g=make(w),statements=[]
 const r=await g.handle('/v1/gateway/consume',body(w),ctx(async s=>{statements.push(s);if(s===G.state)return dbState();if(s==='COMMIT')throw Error('lost acknowledgment');if(s===G.consume)return {rows:[{receipt:{}}]};return {rows:[]}}))
 assert.equal(r.status,'unknown');assert.ok(w.calls.includes('reserve'));assert.ok(!w.calls.includes('recordCommitted'));assert.ok(w.state.pending)
 const seen=statements.length
 const missing=await g.handle('/v1/gateway/reconcile',{operationId:w.state.pending.operation.operationId},ctx(async s=>{statements.push(s);return {rows:[{evidence:{receiptText:null,receiptHash:null,native:null,checkpoint:h('9'),attestation:h('c'),sealedAttestation:h('c')}}]}}))
 assert.equal(missing.status,'unknown');assert.deepEqual(statements.slice(seen),[G.receipt]);assert.ok(w.state.pending);assert.ok(!w.calls.includes('recordCommitted'))
 assert.equal((await g.handle('/v1/gateway/reconcile',{operationId:randomUUID()},ctx(async()=>assert.fail('no read')))).status,'denied')
 g.detach()
})

test('a concurrent mutation is refused immediately; a pin change durably quarantines the witness',async()=>{
 const w=fakeWitness(),pins=tls.registry(),g=make(w,pins);let release;const held=new Promise(r=>release=r)
 const first=g.handle('/v1/gateway/consume',body(w),ctx(async s=>{if(s===G.state){await held;return dbState({checkpoint:h('f')})}return {rows:[]}}))
 const second=await g.handle('/v1/gateway/consume',body(w),ctx(async()=>assert.fail('no statement')))
 assert.equal(second.status,'unavailable');release();assert.equal((await first).status,'denied')
 const w2=fakeWitness(),pins2=tls.registry(),g2=make(w2,pins2)
 pins2.rotate('lab-coordinator',1,tls.certs.coordinatorNew.fingerprint);await new Promise(r=>setImmediate(r))
 assert.ok(w2.calls.includes('quarantine'));g.detach();g2.detach()
 const w3=fakeWitness(),pins3=tls.registry(),g3=make(w3,pins3);g3.detach()
 pins3.rotate('lab-coordinator',1,tls.certs.coordinatorNew.fingerprint);await new Promise(r=>setImmediate(r))
 assert.ok(!w3.calls.includes('quarantine'))
 assert.equal((await g3.handle('/v1/gateway/state',{},ctx(async()=>assert.fail()))).status,'unavailable')
})

test('a pin change racing activation is serialized after it and never stales the expected record hash',async()=>{
 const w=fakeWitness({status:'quarantined'}),pins=tls.registry(),g=make(w,pins);let release,entered;const held=new Promise(r=>release=r),reading=new Promise(r=>entered=r)
 const hashes=[];w.activate=async({expectedRecordHash})=>{hashes.push(expectedRecordHash);w.calls.push('activate');if(expectedRecordHash!==w.state.recordHash)throw Error('stale hash would break the witness');w.state.status='open';return {...w.state}}
 const quarantine=w.quarantine;w.quarantine=async()=>{await quarantine();w.state.recordHash=h('7')}
 const activation=g.activate(async()=>{entered();await held;return dbState()})
 await reading;pins.rotate('lab-coordinator',1,tls.certs.coordinatorNew.fingerprint);await new Promise(r=>setImmediate(r))
 assert.ok(!w.calls.includes('quarantine')) // queued behind the activation, not interleaved
 release();assert.equal((await activation).status,'activated');for(let i=0;i<20&&!w.calls.includes('quarantine');i++)await new Promise(r=>setImmediate(r))
 assert.deepEqual(w.calls.filter(c=>['activate','quarantine'].includes(c)),['activate','quarantine']);assert.equal(w.state.status,'quarantined')
 // Already quarantined: a further pin change spends no record.
 const before=w.calls.length;pins.rotate('lab-coordinator',2,tls.certs.unknown.fingerprint);for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r))
 assert.ok(!w.calls.slice(before).includes('quarantine'));g.detach()
})

test('activation keeps its closure reserve and never reopens after detach',async()=>{
 const low=fakeWitness({status:'quarantined',sequence:EXTERNAL_INCARNATION_LAB_LIMITS.records-2}),g1=make(low)
 assert.equal((await g1.activate(async()=>assert.fail('no read'))).status,'denied');assert.ok(!low.calls.includes('activate'));g1.detach()
 const w=fakeWitness({status:'quarantined'}),g2=make(w);let release;const held=new Promise(r=>release=r)
 const activation=g2.activate(async()=>{await held;return dbState()});await new Promise(r=>setImmediate(r));g2.detach();release()
 assert.equal((await activation).status,'denied');assert.ok(!w.calls.includes('activate'))
})

test('shutdown during the final witness reread never reopens the witness',async()=>{
 const w=fakeWitness({status:'quarantined'}),g=make(w);let reads=0,release,entered;const held=new Promise(r=>release=r),inFlight=new Promise(r=>entered=r)
 const inspect=w.inspect;w.inspect=async()=>{const r=await inspect();if(++reads===2){entered();await held}return r}
 const activation=g.activate(async()=>dbState());await inFlight;g.detach();release()
 assert.equal((await activation).status,'denied');assert.ok(!w.calls.includes('activate'))
})

// Detach can land after the synchronous check but while witness.activate is still
// in flight: the awaited transition must be re-quarantined, never left open.
function gatedActivation(w){
 let entered,release;const inFlight=new Promise(r=>entered=r),held=new Promise(r=>release=r)
 w.activate=async({expectedRecordHash})=>{w.calls.push('activate');entered();await held;if(expectedRecordHash!==w.state.recordHash)throw Error('stale');w.state.status='open';return {...w.state}}
 return {inFlight,release}
}
test('shutdown while the witness activation is in flight re-quarantines the witness and reports denied',async()=>{
 const w=fakeWitness({status:'quarantined'}),g=make(w),gate=gatedActivation(w)
 const activation=g.activate(async()=>dbState());await gate.inFlight;g.detach();gate.release()
 const r=await activation
 assert.equal(r.status,'denied');assert.equal(w.state.status,'quarantined');assert.equal(w.state.pending,null)
 assert.deepEqual(w.calls.filter(c=>['activate','quarantine'].includes(c)),['activate','quarantine'])
 assert.equal(r.grant,false);assert.equal(r.canExecute,false);assert.equal(r.releaseAuthorized,false)
})
test('an uncontested activation is unchanged and leaves the witness open',async()=>{
 const w=fakeWitness({status:'quarantined'}),g=make(w),gate=gatedActivation(w);gate.release()
 assert.equal((await g.activate(async()=>dbState())).status,'activated');assert.equal(w.state.status,'open');assert.ok(!w.calls.includes('quarantine'));g.detach()
})
test('a failed re-quarantine after detach is observable, never swallowed',async()=>{
 const w=fakeWitness({status:'quarantined'}),g=make(w),gate=gatedActivation(w)
 w.quarantine=async()=>{w.calls.push('quarantine');throw Error('journal write failed')}
 const activation=g.activate(async()=>dbState());await gate.inFlight;g.detach();gate.release()
 await assert.rejects(activation,/journal write failed/u);assert.equal(w.state.status,'open') // truthfully reported open: the error is the signal
})
test('service close() reports an activation that fails while closing',async()=>{
 const pins=tls.registry(),role='ppo_authority_gateway',login='ppo_transport_gateway'
 let release,entered;const held=new Promise(r=>release=r),inFlight=new Promise(r=>entered=r)
 const stub={serviceIdentity:tls.certs.gateway.identity,pins,handle:async()=>({}),detach(){},activate:async()=>{entered();await held;throw Error('cleanup failed')}}
 const conn={async query(){return {rows:[{role,login,privileged:false,login_privileged:false,memberships:[role]}]}},async dispose(){}}
 const service=createIsolatedPinnedService({mode:TM,service:'gateway',identity:tls.certs.gateway.identity,tls:tls.certs.gateway.tls,pins,connections:{gateway:async()=>conn},gateway:stub})
 const activation=service.activateGateway();await inFlight
 const closing=service.close();release()
 await assert.rejects(activation,/cleanup failed/u);await assert.rejects(closing,/./u)
})
