import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'
const script=fileURLToPath(new URL('./profile-ppo-postgres-authority.mjs',import.meta.url))

// Exercise the actual profiler with a synthetic test child and fake Docker.
// No real database or resource measurement is performed by these tests.
for(const mode of ['sql-fails-after-first','sql-unavailable','peak-malformed','events-unavailable'])test('profiler partial observations: '+mode,{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ppo-profile-sampling-'))
 const scripts=join(root,'deployment','scripts'),authority=join(root,'deployment','authority')
 let child,timer,artifacts,output='',stderr=''
 try{
  await mkdir(scripts,{recursive:true});await mkdir(authority,{recursive:true})
  const target=join(scripts,'profile-ppo-postgres-authority.mjs')
  await writeFile(target,await readFile(script))
  await writeFile(join(authority,'resource-profile-preload.cjs'),await readFile(new URL('../authority/resource-profile-preload.cjs',import.meta.url)))
  await writeFile(join(root,'git'),'#!/bin/sh\nprintf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',{mode:0o700})
  await writeFile(join(root,'docker'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),root=process.env.PPO_FAKE_PROFILE_ROOT,mode=process.env.PPO_FAKE_PROFILE_MODE,id='f'.repeat(64)
const next=name=>{const p=path.join(root,name);let n=0;try{n=Number(fs.readFileSync(p,'utf8'))}catch{};fs.writeFileSync(p,String(++n));return n}
if(a[0]==='create'){fs.writeFileSync(a[a.indexOf('--cidfile')+1],id);console.log(id)}
else if(a[0]==='start')console.log(id)
else if(a[0]==='image')console.log('["synthetic-image"]')
else if(a[0]==='logs')console.log('synthetic diagnostics')
else if(a[0]==='rm'){if(a.at(-1)!==id)process.exit(1);fs.writeFileSync(path.join(root,'removed'),'yes')}
else if(a[0]==='exec'){
 const s=a.at(-1)
 if(s==='SELECT 1')console.log('1')
 else if(s==='SELECT version()')console.log('synthetic PG')
 else if(s==='/sys/fs/cgroup/memory.events'){const n=next('events');if(mode==='events-unavailable')process.exit(1);console.log('oom_kill '+(n===1?0:2))}
 else if(a.includes('sh')){const n=next('peak');console.log(mode==='peak-malformed'?'malformed':n===1?'512':'1024')}
 else {const n=next('database');if(mode==='sql-unavailable'||(mode==='sql-fails-after-first'&&n>1))process.exit(1);console.log(JSON.stringify({at:'synthetic',databaseBytes:200,tempBytes:10,tempFiles:1,walDirectoryBytes:50,backends:2,lockWaiters:0,longestTransactionMs:3,walBytes:'100'}))}
}else process.exit(1)
`,{mode:0o700})
  // Keep the child alive until each independent observer has attempted the
  // required windows; the final window may lack SQL but still contain OOM data.
  await writeFile(join(authority,'phase1gb2-canonical-postgres.integration.mjs'),`import test from 'node:test';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
  test('synthetic sample windows',{timeout:5000},async()=>{const target=process.env.PPO_FAKE_PROFILE_MODE==='sql-fails-after-first'?2:1;for(;;){const counts=await Promise.all(['database','peak','events'].map(async name=>Number(await readFile(join(process.env.PPO_FAKE_PROFILE_ROOT,name),'utf8').catch(()=>0))));if(counts.every(n=>n>=target))break;await new Promise(r=>setTimeout(r,20))}})
`)
  const preload=join(root,'fast-sampling.mjs')
  await writeFile(preload,'const original=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===5000?100:ms,...args)\n')
  const env={...process.env,PATH:root+delimiter+process.env.PATH,CI:'true',GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'15742',GITHUB_RUN_ATTEMPT:'2',PPO_FAKE_PROFILE_ROOT:root,PPO_FAKE_PROFILE_MODE:mode};delete env.NODE_TEST_CONTEXT
  child=spawn(process.execPath,['--import',preload,target],{env,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>stderr+=c)
  timer=setTimeout(()=>child.kill('SIGKILL'),12000)
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
  assert.equal(exit.signal,null,stderr);artifacts=JSON.parse(output.trim()).output
  const report=JSON.parse(await readFile(join(artifacts,'report.json'),'utf8'))
  const rows=(await readFile(join(artifacts,'database-samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(report.testExit.code,0);assert.equal(report.productionQualified,false);assert.equal(await readFile(join(root,'removed'),'utf8'),'yes')
  assert.equal(report.error,undefined);assert.ok(report.observerErrors>0)
  assert.equal(report.sampleCount,rows.filter(r=>r.database).length)
  if(mode==='sql-fails-after-first'){
   assert.equal(exit.code,0);assert.equal(report.measurementComplete,true);assert.equal(report.sampleCount,1)
   assert.ok(rows.some(r=>!r.database&&r.cgroupPeakBytes===1024&&r.memoryEvents?.oom_kill==='2'))
   assert.equal(report.sampledMaxima.cgroupPeakBytes,1024);assert.equal(report.memoryEventMaxima.oom_kill,'2')
   assert.equal(report.sampledMaxima.databaseBytes,200);assert.equal(report.sampledMaxima.walBytes,'100')
  }else{
   assert.equal(exit.code,1);assert.equal(report.measurementComplete,false)
   if(mode==='sql-unavailable'){
    assert.equal(report.sampleCount,0);assert.ok(rows.length>0);assert.equal(report.sampledMaxima.databaseBytes,null);assert.equal(report.sampledMaxima.walBytes,null)
    assert.ok(report.sampledMaxima.cgroupPeakBytes>=512);assert.ok(Object.hasOwn(report.memoryEventMaxima,'oom_kill'))
   }else{
    assert.ok(report.sampleCount>0);assert.equal(report.sampledMaxima.databaseBytes,200);assert.equal(report.sampledMaxima.walBytes,'100')
    if(mode==='peak-malformed'){assert.equal(report.cgroupPeakSampleCount,0);assert.equal(report.sampledMaxima.cgroupPeakBytes,null);assert.ok(report.memoryEventSampleCount>0)}
    else{assert.equal(report.memoryEventSampleCount,0);assert.deepEqual(report.memoryEventMaxima,{});assert.ok(report.cgroupPeakSampleCount>0)}
   }
  }
  assert.equal(report.cgroupPeakSampleCount,rows.filter(r=>Object.hasOwn(r,'cgroupPeakBytes')).length)
  assert.equal(report.memoryEventSampleCount,rows.filter(r=>r.memoryEvents).length)
 }finally{clearTimeout(timer);if(child?.exitCode===null)child.kill('SIGKILL');if(artifacts)await rm(artifacts,{recursive:true,force:true});await rm(root,{recursive:true,force:true})}
})
