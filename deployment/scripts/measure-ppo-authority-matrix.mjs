#!/usr/bin/env node
// Fixed offline test runner. No DSN, context selection, image pulls or mounts.
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
const run=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url))
const cases=['catalog20','history100','catalog2000','operations','retention'],selected=process.argv[2]
if(process.argv.length>3||(selected&&!cases.includes(selected))||!process.version.startsWith('v24.'))throw Error('Node 24 and at most one fixed case name required')
const output=await mkdtemp(join(tmpdir(),'ppo-budget-matrix-'))
console.log(output)
const report={schema:1,started:new Date().toISOString(),node:process.version,output,cases:[],grant:false,canExecute:false,releaseAuthorized:false}
const command=(args)=>run('docker',args,{cwd:root,timeout:15000,maxBuffer:2*1024*1024,encoding:'utf8'}).then(r=>r.stdout.trim())
let active=null,child=null,stopping=false
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;child?.kill('SIGTERM')})
try{
 report.head=(await run('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim()
 report.sources=Object.fromEntries(await Promise.all(['deployment/scripts/measure-ppo-authority-matrix.mjs','deployment/authority/phase2a-budget-matrix.mjs'].map(async path=>[path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')])))
 const image=JSON.parse(await command(['image','inspect','postgres:16','--format','{{json .}}']))
 report.image={id:image.Id,digests:image.RepoDigests,architecture:image.Architecture}
 for(const name of selected?[selected]:cases){
  if(stopping)throw Error('Interrupted')
  const c={name,samples:[],limits:{memoryBytes:2147483648,cpus:2,pids:128,maxConnections:12,statementMs:15000,lockMs:1000,idleMs:1000,applicationMs:20000,caseMs:360000}}
  report.cases.push(c)
  active='ppo-budget-matrix-'+randomUUID()
  const operation=randomUUID(),cidfile=join(output,name+'.cid')
  let id
  try{
   id=await command(['create','--cidfile',cidfile,'--network','none','--memory','2g','--memory-swap','2g','--cpus','2','--pids-limit','128','--label','ppo.offline-budget-matrix='+operation,'--name',active,'-e','POSTGRES_DB=ppo_authority_ci','-e','POSTGRES_PASSWORD=disposable-offline-only',image.Id,'postgres','-c','max_connections=12','-c','shared_buffers=128MB','-c','work_mem=4MB','-c','max_wal_size=256MB','-c','log_temp_files=0'])
   assertId(id);c.container=id
   await command(['start',active])
   let ready=false
   for(let n=0;n<60;n++){
    try{await command(['exec',active,'psql','-XqAt','-U','postgres','-d','ppo_authority_ci','-c','SELECT 1']);ready=true;break}catch{}
    await new Promise(r=>setTimeout(r,250))
   }
   if(!ready)throw Error('Startup deadline')
   let sampling=null
   const sample=()=>sampling??(sampling=(async()=>{try{c.samples.push({at:Date.now(),cgroup:await command(['exec',active,'sh','-c','cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events; du -sk /var/lib/postgresql/data/pg_wal /var/lib/postgresql/data/base'])})}catch(e){c.sampleError=String(e)}})().finally(()=>{sampling=null}))
   await sample();const timer=setInterval(sample,500)
   const log=join(output,name+'.log'),chunks=[]
   try{
    c.exit=await new Promise((resolve,reject)=>{
     child=spawn(process.execPath,['--max-old-space-size=2048','deployment/authority/phase2a-budget-matrix.mjs',name],{cwd:root,env:{...process.env,PPO_MATRIX_CONTAINER:active,PPO_MATRIX_OUTPUT:join(output,name+'.json')},stdio:['ignore','pipe','pipe']})
     const deadline=setTimeout(()=>{c.deadline=true;child.kill('SIGTERM');setTimeout(()=>child?.kill('SIGKILL'),2000).unref()},c.limits.caseMs)
     for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{chunks.push(b);process.stdout.write(b)})
     child.on('error',reject);child.on('close',(code,signal)=>{clearTimeout(deadline);c.signal=signal;resolve(code)})
    })
   }finally{clearInterval(timer);child=null;await sample();await writeFile(log,Buffer.concat(chunks))}
   try{c.evidence=JSON.parse(await readFile(join(output,name+'.json'),'utf8'))}catch(e){c.evidenceError=String(e)}
   const server=await run('docker',['logs','--tail','100',active],{timeout:15000,maxBuffer:2*1024*1024,encoding:'utf8'});c.serverLog=server.stdout+server.stderr
   c.inspect=JSON.parse(await command(['inspect','--format','{{json .State}}',active]))
   if(c.exit!==0||c.deadline||!c.evidence?.ok)throw Error(name+' failed; evidence retained')
  }finally{
   try{
    const owned=(await readFile(cidfile,'utf8')).trim();assertId(owned)
    const labels=JSON.parse(await command(['inspect','--format','{{json .Config.Labels}}',owned]))
    if(labels['ppo.offline-budget-matrix']!==operation)throw Error('Container operation label mismatch')
    await command(['rm','-fv',owned]);c.cleanup='removed exact owned ID'
   }catch(e){c.cleanupFailure=String(e);report.ok=false;process.exitCode=1;throw Error('Cleanup ownership uncertain: '+e.message)}
   finally{active=null;await writeFile(join(output,'matrix.json'),JSON.stringify(report,null,2))}
  }
 }
 report.ok=true
}catch(e){report.ok=false;report.failure=String(e);process.exitCode=1}
finally{report.finished=new Date().toISOString();await writeFile(join(output,'matrix.json'),JSON.stringify(report,null,2));console.log('Evidence: '+join(output,'matrix.json'))}
function assertId(id){if(!/^[a-f0-9]{64}$/u.test(id))throw Error('Invalid container ID')}
