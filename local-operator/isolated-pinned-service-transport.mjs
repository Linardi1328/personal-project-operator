import https from 'node:https'
import {checkServerIdentity} from 'node:tls'
import {createHash,X509Certificate} from 'node:crypto'
import {parseUniqueJson} from './unique-json.mjs'
import {createIsolatedPostgresActionVerifier,createIsolatedPostgresActionFence,inspectIsolatedActionConsumption,POSTGRES_ACTION_SQL as A} from './software-factory-remote-postgres-action-fence.mjs'
import {createSyntheticResourceVerifier,createSyntheticResourceFence,inspectSyntheticResourceReceipt,RESOURCE_SQL as R} from './software-factory-postgres-resource-fence.mjs'

const MODE='isolated-pinned-service-transport-only',AM='isolated-postgres-action-fencing-only',RM='isolated-postgres-resource-fencing-only'
const FLAGS=Object.freeze({grant:false,canExecute:false,releaseAuthorized:false})
const statuses=new Set(['registered','context','updated','consumed-diagnostic','expired-or-stale','denied','unknown','unavailable','consumed','committed-synthetic-effect'])
const jsonText=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes)
const HASH=/^[a-f0-9]{64}$/u,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v)
const kinds=new Set(['coordinator','administrator','verifier-service','consumer-service','administrator-service'])
const roles={actionVerifier:'ppo_action_verifier',resourceVerifier:'ppo_resource_verifier',actionConsumer:'ppo_action_consumer',resourceConsumer:'ppo_resource_consumer',admin:'ppo_action_admin'}
// Two legal 4096-byte values can each expand sixfold when JSON escapes are
// serialized in a receipt. 64 KiB also covers the bounded 32 KiB action
// context plus one escaped current resource and fixed metadata.
export const PINNED_SERVICE_LIMITS=Object.freeze({requestBytes:65536,responseBytes:65536,concurrent:4,sockets:16,operationMs:10000,bodyMs:2000,clientMs:12000})
export const SERVICE_ROLE_PROBE="SELECT current_user AS role,session_user AS login,(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged,(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=session_user) AS login_privileged,(SELECT coalesce(json_agg(p.rolname ORDER BY p.rolname),'[]'::json) FROM pg_roles p WHERE p.rolname<>session_user AND pg_has_role(session_user,p.oid,'MEMBER')) AS memberships"
export const SERVICE_ADMIN_SQL=Object.freeze({configure:'SELECT ppo_authority.configure_action_host($1::text,$2::bigint,$3::text) AS epoch',revoke:'SELECT ppo_authority.revoke_action_context($1::text,$2::text) AS revoked'})
export function serviceLogin(role){const key=Object.entries(roles).find(([,v])=>v===role)?.[0];if(!key)fail();return 'ppo_transport_'+key.replace(/[A-Z]/gu,c=>'_'+c.toLowerCase())}
const denied=status=>({...FLAGS,status})
function fail(){throw Error('Isolated pinned service denied or unavailable.')}
function exact(o,keys){return o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===[...keys].sort().join('|')}
function boundedJson(o,max){const s=JSON.stringify(o);if(typeof s!=='string'||Buffer.byteLength(s)>max)fail();return s}
export function tlsKeyFingerprint(cert){try{return createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('hex')}catch{fail()}}

// Trusted administrative capability only. No route accepts a replacement pin,
// epoch, role, SQL or verifier attestation from an ordinary service request.
export function createIsolatedPinRegistry({mode,entries}={}){
 if(mode!==MODE||!Array.isArray(entries)||entries.length<1||entries.length>20)fail()
 const map=new Map(),retired=new Set(),listeners=new Set()
 for(const e of entries){if(!exact(e,['identity','kind','fingerprint','epoch'])||!/^lab-[a-z0-9-]{1,60}$/u.test(e.identity)||!kinds.has(e.kind)||!hash(e.fingerprint)||e.epoch!==1||map.has(e.identity)||[...map.values()].some(x=>x.fingerprint===e.fingerprint))fail();map.set(e.identity,Object.freeze({...e,active:true}))}
 const read=id=>map.get(id),lookup=fp=>[...map.values()].find(e=>e.active&&e.fingerprint===fp)
 function change(id,expected,fingerprint){const e=read(id);if(!e||e.epoch!==expected||e.epoch>=1e9||retired.size>=128||fingerprint!==null&&(!hash(fingerprint)||retired.has(fingerprint)||[...map.values()].some(x=>x.fingerprint===fingerprint)))fail();retired.add(e.fingerprint);const next=Object.freeze({...e,epoch:e.epoch+1,active:fingerprint!==null,fingerprint:fingerprint??e.fingerprint});map.set(id,next);for(const fn of listeners)fn(next);return next}
 return Object.freeze({read,lookup,rotate:(id,expected,fp)=>change(id,expected,fp),revoke:(id,expected)=>change(id,expected,null),subscribe(fn){if(typeof fn!=='function')fail();listeners.add(fn);return()=>listeners.delete(fn)}})
}
const services={verifier:['actionVerifier','resourceVerifier'],consumer:['actionConsumer','resourceConsumer'],administrator:['admin']}
function route(service,path,body,keys){
 const operation=(resource=false)=>{if(!exact(body,resource?['ticket','operationId','descriptorHash']:['ticket','operationId'])||!uuid(body.ticket)||!uuid(body.operationId)||resource&&!hash(body.descriptorHash))fail()}
 if(service==='verifier'&&path==='/v1/action/register'){
  if(!exact(body,['signedRequest','signedClaim','signedProof','ticket'])||!uuid(body.ticket))fail()
  return {connection:'actionVerifier',statements:[A.snapshot,A.register],run:q=>createIsolatedPostgresActionVerifier({mode:AM,query:q,...keys}).register(body).then(registration=>({...FLAGS,status:'registered',registration}))}
 }
 if(service==='verifier'&&path==='/v1/resource/context'){
  if(!exact(body,['ticket'])||!uuid(body.ticket))fail()
  return {connection:'resourceVerifier',statements:[R.read],run:async q=>{const r=await q(R.read,[body.ticket]);if(r?.rows?.length!==1)fail();return {...FLAGS,status:r.rows[0].context?'context':'denied',context:r.rows[0].context}}}
 }
 if(service==='verifier'&&path==='/v1/resource/register'){
  if(!exact(body,['signed','payload']))fail()
  return {connection:'resourceVerifier',statements:[R.register],run:q=>createSyntheticResourceVerifier({mode:RM,query:q,publicKey:keys.coordinatorPublicKey}).register(body.signed,body.payload).then(registration=>({...FLAGS,status:'registered',registration}))}
 }
 if(service==='consumer'&&['/v1/action/consume','/v1/action/inspect'].includes(path)){
  operation();return {connection:'actionConsumer',statements:[A.consume,A.precommit,A.observe,'BEGIN','COMMIT','ROLLBACK'],run:q=>path.endsWith('/consume')?createIsolatedPostgresActionFence({mode:AM,query:q}).consume(body):inspectIsolatedActionConsumption({mode:AM,query:q,operation:body})}
 }
 if(service==='consumer'&&['/v1/resource/apply','/v1/resource/inspect'].includes(path)){
  operation(true);return {connection:'resourceConsumer',statements:[R.apply,R.receipt,A.precommit,A.observe,'BEGIN','COMMIT','ROLLBACK'],run:q=>path.endsWith('/apply')?createSyntheticResourceFence({mode:RM,query:q}).apply(body):inspectSyntheticResourceReceipt({mode:RM,query:q,operation:body})}
 }
 if(service==='administrator'&&path==='/v1/host/configure'){
  if(!exact(body,['hostId','expectedEpoch','policy'])||typeof body.hostId!=='string'||!/^lab-[a-z0-9-]{1,59}$/u.test(body.hostId)||!Number.isSafeInteger(body.expectedEpoch)||body.expectedEpoch<0||body.expectedEpoch>=1e9||!body.policy||typeof body.policy!=='object')fail()
  const policy=boundedJson(body.policy,4096)
  return {connection:'admin',statements:[SERVICE_ADMIN_SQL.configure],run:async q=>{const r=await q(SERVICE_ADMIN_SQL.configure,[body.hostId,body.expectedEpoch,policy]);if(r?.rows?.length!==1||String(r.rows[0].epoch)!==String(body.expectedEpoch+1))fail();return {...FLAGS,status:'updated',epoch:String(r.rows[0].epoch)}}}
 }
 if(service==='administrator'&&path==='/v1/context/revoke'){
  if(!exact(body,['kind','hash'])||!['request','claim'].includes(body.kind)||!hash(body.hash))fail()
  return {connection:'admin',statements:[SERVICE_ADMIN_SQL.revoke],run:async q=>{const r=await q(SERVICE_ADMIN_SQL.revoke,[body.kind,body.hash]);if(r?.rows?.length!==1||!Object.hasOwn(r.rows[0],'revoked'))fail();return {...FLAGS,status:'updated'}}}
 }
 fail()
}

// Each service owns only its listed fixed DB capabilities and a separate TLS
// identity. Factories are server infrastructure, never request properties.
export function createIsolatedPinnedService({mode,service,identity,tls,pins,connections,verifierKeys}={}){
 if(mode!==MODE||!exact(tls,['key','cert','ca'])||!Object.hasOwn(services,service)||!pins?.read||!pins?.lookup||!pins?.subscribe||!exact(connections,services[service])||services[service].some(k=>typeof connections[k]!=='function'))fail()
 const own=pins.read(identity);if(!own?.active||own.kind!==service+'-service'||own.fingerprint!==tlsKeyFingerprint(tls?.cert))fail()
 const sockets=new Set(),active=new Set(),usedSessions=new WeakSet();let started=false,closing=false,closingTask
 const selfCurrent=()=>{const p=pins.read(identity);return p?.active&&p.fingerprint===own.fingerprint&&p.epoch===own.epoch}
 const server=https.createServer({...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',handshakeTimeout:PINNED_SERVICE_LIMITS.bodyMs,connectionsCheckingInterval:500},async(req,res)=>{
  const peer=req.socket.authorized&&pins.lookup(tlsKeyFingerprint(req.socket.getPeerCertificate().raw))
  const validPeer=()=>{const p=peer&&pins.read(peer.identity);return selfCurrent()&&p?.active&&p.epoch===peer.epoch&&p.fingerprint===peer.fingerprint}
  const send=(status,result)=>{if(res.destroyed||res.writableEnded)return;const text=boundedJson(result,PINNED_SERVICE_LIMITS.responseBytes);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(text),'connection':'close'});res.end(text)}
  if(closing||!peer||peer.kind!==(service==='administrator'?'administrator':'coordinator')||!validPeer()){send(403,denied('denied'));req.resume();return}
  if(active.size>=PINNED_SERVICE_LIMITS.concurrent){send(503,denied('unavailable'));req.resume();return}
  let connection,opening,disposal,disposalFailed=false,cancelled=false,dispatched=false,rejectAbort,finishAttempt
  const finished=new Promise(resolve=>{finishAttempt=resolve})
  const abort=new Promise((_,reject)=>{rejectAbort=reject});abort.catch(()=>{})
  const dispose=()=>{if(!connection)return Promise.resolve();if(!disposal)disposal=Promise.resolve().then(()=>connection.dispose()).catch(()=>{disposalFailed=true});return disposal}
  const attempt={peer:peer.identity,epoch:peer.epoch,fingerprint:peer.fingerprint,finished,cancel(){if(cancelled)return;cancelled=true;rejectAbort(Error('Service attempt interrupted.'));void dispose()}}
  active.add(attempt)
  const timer=setTimeout(()=>attempt.cancel(),PINNED_SERVICE_LIMITS.operationMs)
  res.once('close',()=>{if(!res.writableFinished)attempt.cancel()})
  try{
   if(req.method!=='POST'||req.headers['content-type']!=='application/json'||req.headers['content-encoding']||req.headers['transfer-encoding']||!/^\d{1,6}$/u.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>PINNED_SERVICE_LIMITS.requestBytes)fail()
   const chunks=[];let bytes=0
   const bodyTimer=setTimeout(()=>{attempt.cancel();req.destroy()},PINNED_SERVICE_LIMITS.bodyMs)
   try{for await(const chunk of req){bytes+=chunk.length;if(bytes>PINNED_SERVICE_LIMITS.requestBytes)fail();chunks.push(chunk)}}finally{clearTimeout(bodyTimer)}
   const body=parseUniqueJson(jsonText(Buffer.concat(chunks)),{maxBytes:PINNED_SERVICE_LIMITS.requestBytes,maxDepth:32}),r=route(service,req.url,body,verifierKeys)
   if(cancelled||!validPeer())fail()
   opening=Promise.resolve().then(connections[r.connection]).then(async c=>{connection=c;if(!c||typeof c.query!=='function'||typeof c.dispose!=='function'||usedSessions.has(c))fail();usedSessions.add(c);if(cancelled){await dispose();fail()}return c})
   await Promise.race([opening,abort])
   if(!validPeer())fail()
   const probe=await Promise.race([connection.query(SERVICE_ROLE_PROBE,[]),abort]),p=probe?.rows?.[0],role=roles[r.connection]
   if(!Array.isArray(probe?.rows)||probe.rows.length!==1||p?.role!==role||p.login!==serviceLogin(role)||p.privileged!==false||p.login_privileged!==false||JSON.stringify(p.memberships)!==JSON.stringify([role]))fail()
   const query=async(s,a)=>{if(cancelled||!validPeer()||!r.statements.includes(s))fail();dispatched=true;return Promise.race([connection.query(s,a),abort])}
   const result=await Promise.race([r.run(query),abort])
   if(cancelled||!validPeer()||result?.grant!==false||result.canExecute!==false||result.releaseAuthorized!==false)fail()
   send(200,result)
  }catch{try{send(cancelled||dispatched?503:400,denied(cancelled||dispatched?'unknown':'denied'))}catch{res.destroy()}}
  finally{clearTimeout(timer);if(opening)await opening.catch(()=>{});await dispose();if(!disposalFailed)active.delete(attempt);finishAttempt(!disposalFailed)}
 })
 server.maxHeadersCount=16;server.headersTimeout=2000;server.requestTimeout=2000;server.keepAliveTimeout=1;server.maxRequestsPerSocket=1
 server.on('connection',s=>{if(sockets.size>=PINNED_SERVICE_LIMITS.sockets){s.destroy();return}sockets.add(s);s.once('close',()=>sockets.delete(s))})
 server.on('tlsClientError',()=>{})
 const unsubscribe=pins.subscribe(()=>{for(const attempt of active){const p=pins.read(attempt.peer);if(!selfCurrent()||!p?.active||p.epoch!==attempt.epoch||p.fingerprint!==attempt.fingerprint)attempt.cancel()}})
 return Object.freeze({async listen(){if(started||closing)fail();started=true;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});return Object.freeze({port:server.address().port,identity,service})},async close(){
  if(closingTask)return closingTask
  closing=true;unsubscribe();const pending=[...active];for(const a of pending)a.cancel();for(const s of sockets)s.destroy()
  closingTask=(async()=>{
   if(started)await new Promise(resolve=>server.close(resolve))
   let deadline
   try{const result=await Promise.race([Promise.all(pending.map(a=>a.finished)),new Promise(resolve=>{deadline=setTimeout(()=>resolve(null),PINNED_SERVICE_LIMITS.operationMs)})]);if(!result||result.some(ok=>!ok))fail()}finally{clearTimeout(deadline)}
  })()
  return closingTask
 }})
}

function boundResponse(path,body,r){
 const positive={"/v1/action/register":['registered'],"/v1/resource/register":['registered'],"/v1/resource/context":['context'],"/v1/action/consume":['consumed-diagnostic','expired-or-stale'],"/v1/action/inspect":['consumed'],"/v1/resource/apply":['consumed-diagnostic','expired-or-stale'],"/v1/resource/inspect":['committed-synthetic-effect'],"/v1/host/configure":['updated'],"/v1/context/revoke":['updated']}
 if(!r||Object.getPrototypeOf(r)!==Object.prototype||r.grant!==false||r.canExecute!==false||r.releaseAuthorized!==false||!statuses.has(r.status))fail()
 if(['denied','unknown','unavailable'].includes(r.status))return
 if(!positive[path]?.includes(r.status))fail()
 if(r.status==='registered'){
  const p=r.registration
  if(path==='/v1/action/register'){if(!p||p.ticket!==body.ticket||!uuid(p.targetId)||typeof p.generation!=='string'||!/^[1-9][0-9]{0,9}$/u.test(p.generation)||BigInt(p.generation)>1000000000n||!hash(p.proofHash))fail()}
  else{const d=parseUniqueJson(body.signed.text,{maxBytes:8192});if(!p||p.ticket!==d.ticket||p.operationId!==d.operationId||p.descriptorHash!==createHash('sha256').update(body.signed.text).digest('hex'))fail()}
 }
 if(['consumed-diagnostic','expired-or-stale','consumed','committed-synthetic-effect'].includes(r.status)){
  if(!exact(r.operation,Object.keys(body))||Object.keys(body).some(k=>r.operation[k]!==body[k]))fail()
  if(r.status!=='committed-synthetic-effect'){
   const e=r.evidence;if(!e||e.consumed!==true||e.ticket!==body.ticket||e.operationId!==body.operationId||!uuid(e.targetId)||!hash(e.contextHash)||typeof e.generation!=='string'||!/^[1-9][0-9]{0,9}$/u.test(e.generation)||BigInt(e.generation)>1000000000n||typeof e.observedMicros!=='string'||!/^[1-9][0-9]{0,18}$/u.test(e.observedMicros)||typeof e.fresh!=='boolean'||r.status==='consumed-diagnostic'&&e.fresh!==true||r.status==='expired-or-stale'&&e.fresh!==false)fail()
  }
  if(path.startsWith('/v1/resource/')){const p=r.receipt,b=p?.before_state,a=p?.after_state;if(p?.operation_id!==body.operationId||p.ticket!==body.ticket||p.descriptor_hash!==body.descriptorHash||!uuid(a?.resource_id)||a.resource_id!==b?.resource_id||!Number.isSafeInteger(b.version)||a.version!==b.version+1||typeof a.value!=='string'||Buffer.byteLength(a.value)>4096||a.ref!==createHash('sha256').update(a.value).digest('hex'))fail()}
 }
 if(r.status==='context'&&(!r.context||!hash(r.context.contextHash)||!r.context.context||!uuid(r.context.resource?.resource_id)))fail()
 if(r.status==='updated'&&path==='/v1/host/configure'&&r.epoch!==String(body.expectedEpoch+1))fail()
}

// One network attempt per client. A lost/invalid response is unknown, and this
// object cannot replay. Reconciliation uses a new explicit read-only request.
export function createIsolatedPinnedClient({mode,service,serverIdentity,port,tls,pins}={}){
 if(mode!==MODE||!exact(tls,['key','cert','ca'])||!Object.hasOwn(services,service)||!Number.isSafeInteger(port)||port<1||port>65535||!pins?.read)fail()
 let used=false
 return Object.freeze({async send(path,body){
  if(used)fail();used=true
  let text,request;try{text=boundedJson(body,PINNED_SERVICE_LIMITS.requestBytes);request=parseUniqueJson(text,{maxBytes:PINNED_SERVICE_LIMITS.requestBytes,maxDepth:32});route(service,path,request,{})}catch{return denied('denied')}
  const pin=pins.read(serverIdentity);if(!pin?.active||pin.kind!==service+'-service')return denied('denied')
  return new Promise(resolve=>{
   let settled=false,timer
   const finish=r=>{if(!settled){settled=true;clearTimeout(timer);resolve(r)}}
   const req=https.request({host:'127.0.0.1',servername:'localhost',port,path,method:'POST',...tls,agent:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',rejectUnauthorized:true,headers:{'content-type':'application/json','content-length':Buffer.byteLength(text)},checkServerIdentity(host,cert){const error=checkServerIdentity(host,cert);if(error)return error;try{if(tlsKeyFingerprint(cert.raw)!==pin.fingerprint)return Error('Service pin denied.')}catch{return Error('Service pin denied.')}}},res=>{
    const chunks=[];let bytes=0
    res.on('data',chunk=>{bytes+=chunk.length;if(bytes>PINNED_SERVICE_LIMITS.responseBytes){req.destroy();finish(denied('unknown'));return}chunks.push(chunk)})
    res.on('error',()=>finish(denied('unknown')))
    res.on('end',()=>{try{const p=pins.read(serverIdentity);if(!p?.active||p.epoch!==pin.epoch||p.fingerprint!==pin.fingerprint||res.headers['content-type']!=='application/json')fail();const r=parseUniqueJson(jsonText(Buffer.concat(chunks)),{maxBytes:PINNED_SERVICE_LIMITS.responseBytes,maxDepth:32});boundResponse(path,request,r);if(res.statusCode!==200&&!['denied','unknown','unavailable'].includes(r.status))fail();finish(r)}catch{finish(denied('unknown'))}})
   })
   timer=setTimeout(()=>{req.destroy();finish(denied('unknown'))},PINNED_SERVICE_LIMITS.clientMs)
   req.on('error',()=>finish(denied('unknown')));req.end(text)
  })
 }})
}
