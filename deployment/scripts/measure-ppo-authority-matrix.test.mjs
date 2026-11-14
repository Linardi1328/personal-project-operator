import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'

const script=fileURLToPath(new URL('./measure-ppo-authority-matrix.mjs',import.meta.url))
// Fake Docker lifecycle evidence only; never a real daemon or authority.
for(const mode of ['interrupt-start','interrupt-ready','final-server-ready'])test('matrix startup: '+mode,{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ppo-matrix-lifecycle-'))
 await writeFile(join(root,'docker'),String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),root=process.env.PPO_FAKE_MATRIX_ROOT,mode=process.env.PPO_FAKE_MATRIX_MODE,id='f'.repeat(64)
const mark=n=>fs.writeFileSync(path.join(root,n),'yes')
if(process.env.PPO_MATRIX_CONTAINER){mark('scenario-started');process.exit(1)}
if(a[0]==='image')console.log(JSON.stringify({Id:'a'.repeat(64),RepoDigests:[],Architecture:'synthetic'}))
else if(a[0]==='create'){
 fs.writeFileSync(a[a.indexOf('--cidfile')+1],id)
 const label=a[a.indexOf('--label')+1],split=label.indexOf('=');fs.writeFileSync(path.join(root,'labels.json'),JSON.stringify({[label.slice(0,split)]:label.slice(split+1)}));console.log(id)
}else if(a[0]==='start'){
 if(mode==='interrupt-start')process.kill(process.ppid,'SIGTERM')
 setTimeout(()=>console.log(id),20)
}else if(a[0]==='exec'){
 if(a.at(-1)==='SELECT 1'){
  if(mode==='interrupt-ready')process.kill(process.ppid,'SIGTERM')
  const tcp=a.includes('-h')&&a[a.indexOf('-h')+1]==='127.0.0.1'
  if(tcp){
   if(!a.includes('PGPASSWORD=disposable-offline-only'))process.exit(3)
   const p=path.join(root,'tcp-count'),n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1))
   if(mode==='final-server-ready'&&n===0)process.exit(1)
  }else mark('temporary-socket-ready')
  setTimeout(()=>console.log('1'),20)
 }else console.log('512\n512\noom 0\noom_kill 0\n16 data')
}else if(a[0]==='inspect')console.log(a.includes('{{json .Config.Labels}}')?fs.readFileSync(path.join(root,'labels.json'),'utf8'):'{}')
else if(a[0]==='logs')console.log('synthetic diagnostic')
else if(a[0]==='rm'){if(a.at(-1)!==id)process.exit(4);mark('removed-owned-id')}
else process.exit(2)
`,{mode:0o700})
 let child,timer,output='',artifacts
 try{
  const env={...process.env,PATH:root+delimiter+process.env.PATH,PPO_FAKE_MATRIX_ROOT:root,PPO_FAKE_MATRIX_MODE:mode};delete env.NODE_TEST_CONTEXT;delete env.PPO_MATRIX_CONTAINER
  child=spawn(process.execPath,[script,'operations'],{env,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',b=>{output+=b;if(output.length>65536)child.kill('SIGKILL')});child.stderr.resume()
  timer=setTimeout(()=>child.kill('SIGKILL'),8000)
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});clearTimeout(timer)
  assert.equal(exit.signal,null);assert.equal(exit.code,1)
  artifacts=output.trim().split('\n')[0]
  const report=JSON.parse(await readFile(join(artifacts,'matrix.json'),'utf8')),files=await readdir(root)
  assert.equal(report.ok,false);assert.equal(report.cases[0].cleanup,'removed exact owned ID');assert.ok(files.includes('removed-owned-id'))
  if(mode.startsWith('interrupt-')){
   assert.equal(files.includes('scenario-started'),false)
   assert.match(report.failure,/Interrupted/u)
   assert.equal(report.cases[0].exit,undefined)
  }else{
   assert.equal(files.includes('temporary-socket-ready'),false)
   assert.equal(await readFile(join(root,'tcp-count'),'utf8'),'2')
   // The deliberately failing fake scenario starts only after final readiness.
   assert.equal(files.includes('scenario-started'),true)
  }
 }finally{clearTimeout(timer);if(child?.exitCode===null)child.kill('SIGKILL');if(artifacts)await rm(artifacts,{recursive:true});await rm(root,{recursive:true})}
})
