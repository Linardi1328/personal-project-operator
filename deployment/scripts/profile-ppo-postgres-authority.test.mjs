import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'

const script=fileURLToPath(new URL('./profile-ppo-postgres-authority.mjs',import.meta.url))
// Lifecycle/cleanup regression uses a fake Docker executable, never a real
// daemon/container. Real resource measurements remain separate PG evidence.
for(const mode of ['cold-image','cancel-during-version','startup-deadline'])test('profiler lifecycle: '+mode,{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ppo-profile-lifecycle-'))
 const docker=join(root,'docker'),preload=join(root,'fast-deadline.mjs')
 await writeFile(docker,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),root=process.env.PPO_FAKE_PROFILE_ROOT,mode=process.env.PPO_FAKE_PROFILE_MODE
const mark=n=>fs.writeFileSync(path.join(root,n),'yes')
if(process.env.PPO_LAB_NODE_PROFILE){mark('suite-started');process.exit(1)}
if(a[0]==='image'){if(mode==='cold-image'&&!fs.existsSync(path.join(root,'run-started')))process.exit(1);console.log('["synthetic-image"]')}
else if(a[0]==='run'){mark('run-started');setTimeout(()=>console.log('f'.repeat(64)),mode==='startup-deadline'?200:1)}
else if(a[0]==='logs')console.log('synthetic server diagnostic')
else if(a[0]==='rm')mark('removed-owned-id')
else if(a[0]==='exec'){
 const s=a.at(-1)
 if(s==='SELECT version()'){mark('version');process.kill(process.ppid,'SIGTERM');setTimeout(()=>console.log('synthetic PG'),20)}
 else if(s==='SELECT 1')console.log('1')
 else if(a.includes('cat'))console.log(a.includes('/sys/fs/cgroup/memory.events')?'oom_kill 0':'512')
 else console.log('{}')
}else process.exit(1)
`,{mode:0o700})
 await writeFile(preload,"const original=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===1200000?1:ms,...args)\n")
 let child,timer,watch,output=''
 try{
  const env={...process.env,PATH:root+delimiter+process.env.PATH,CI:'true',GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'15742',GITHUB_RUN_ATTEMPT:'1',PPO_FAKE_PROFILE_ROOT:root,PPO_FAKE_PROFILE_MODE:mode};delete env.NODE_TEST_CONTEXT
  child=spawn(process.execPath,[...(mode==='startup-deadline'?['--import',preload]:[]),script],{env,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',c=>{output+=c;if(output.length>65536)child.kill('SIGKILL')});child.stderr.resume()
  timer=setTimeout(()=>child.kill('SIGKILL'),8000)
  // Before the correction, a cancellation can wrongly start a suite. Stop
  // that child group through the profiler's normal SIGTERM cleanup path.
  watch=setInterval(async()=>{try{if((await readdir(root)).includes('suite-started'))child.kill('SIGTERM')}catch{}},20)
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
  clearInterval(watch);clearTimeout(timer)
  assert.equal(exit.signal,null);assert.equal(exit.code,1)
  const {output:artifacts}=JSON.parse(output.trim()),report=JSON.parse(await readFile(join(artifacts,'report.json'),'utf8'))
  assert.equal(report.productionQualified,false);assert.equal(report.containerId,'f'.repeat(64));assert.equal((await readdir(root)).includes('removed-owned-id'),true)
  assert.equal(Object.hasOwn(report,'testExit'),false)
  assert.equal((await readdir(root)).includes('suite-started'),false)
  if(mode==='startup-deadline'){assert.equal(report.stopReason,'Whole profile deadline');assert.equal((await readdir(root)).includes('version'),false);assert.ok(report.wallMs>=200)}
  else assert.equal(report.stopReason,'SIGTERM')
  await rm(artifacts,{recursive:true})
 }finally{clearTimeout(timer);clearInterval(watch);if(child?.exitCode===null)child.kill('SIGKILL');await rm(root,{recursive:true})}
})
