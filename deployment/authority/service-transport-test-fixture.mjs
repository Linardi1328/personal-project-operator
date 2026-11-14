import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createIsolatedPinRegistry,tlsKeyFingerprint} from '../../local-operator/isolated-pinned-service-transport.mjs'
const mode='isolated-pinned-service-transport-only'
// Disposable synthetic CA/keys only, never an enrollment API or runtime issuer.
export async function serviceTlsFixture(){
 const root=await mkdtemp(join(tmpdir(),'ppo-synthetic-mtls-'))
 const run=args=>execFileSync('openssl',args,{cwd:root,stdio:'pipe',timeout:10000,maxBuffer:16384})
 try{
  run(['req','-sha256','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=PPO disposable test CA','-addext','basicConstraints=critical,CA:TRUE'])
  const ca=await readFile(join(root,'ca.pem')),certs={}
  const names={verifier:'verifier-service',consumer:'consumer-service',administrator:'administrator-service',coordinator:'coordinator',admin:'administrator',unknown:'coordinator',coordinatorNew:'coordinator',consumerNew:'consumer-service'}
  for(const [name,kind]of Object.entries(names)){
   run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN=lab-'+name.toLowerCase()])
   await writeFile(join(root,name+'.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage='+ (kind.endsWith('-service')?'serverAuth':'clientAuth')+'\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n')
   run(['x509','-sha256','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext'])
   const tls={key:await readFile(join(root,name+'.key')),cert:await readFile(join(root,name+'.pem')),ca}
   certs[name]={tls,identity:'lab-'+name.toLowerCase(),kind,fingerprint:tlsKeyFingerprint(tls.cert)}
  }
  const registry=()=>createIsolatedPinRegistry({mode,entries:['verifier','consumer','administrator','coordinator','admin'].map(name=>({...Object.fromEntries(['identity','kind','fingerprint'].map(k=>[k,certs[name][k]])),epoch:1}))})
  return {certs,registry,close:()=>rm(root,{recursive:true})}
 }catch(e){await rm(root,{recursive:true});throw e}
}
