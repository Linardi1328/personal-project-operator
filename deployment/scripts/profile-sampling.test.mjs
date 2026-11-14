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
for(const mode of ['sql-fails-after-first','sql-unavailable','peak-malformed','events-unavailable','missing-oom','missing-oom-kill','duplicate-oom-kill','cleanup-fails'])test('profiler partial observations: '+mode,{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ppo-profile-sampling-'))
 const scripts=join(root,'deployment','scripts'),authority=join(root,'deployment','authority')
 const privateTmp=join(root,'tmp')
 let child,timer,hardTimer,closed,artifacts,output='',stderr=''
 try{
  await mkdir(scripts,{recursive:true});await mkdir(authority,{recursive:true});await mkdir(privateTmp)
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
else if(a[0]==='rm'){if(a.at(-1)!==id)process.exit(1);fs.writeFileSync(path.join(root,'removed'),'yes');if(mode==='cleanup-fails')process.exit(1)}
else if(a[0]==='exec'){
 const s=a.at(-1)
 if(s==='SELECT 1')console.log('1')
 else if(s==='SELECT version()')console.log('synthetic PG')
 else if(s==='/sys/fs/cgroup/memory.events'){const n=next('events');if(mode==='events-unavailable')process.exit(1);if(mode==='missing-oom')console.log('oom_kill 0');else if(mode==='missing-oom-kill')console.log('oom 0');else if(mode==='duplicate-oom-kill')console.log('oom 2\\noom_kill 2\\noom_kill 0');else console.log('oom '+(n===1?0:2)+'\\noom_kill '+(n===1?0:2)+'\\nfuture_counter 7')}
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
  const env={...process.env,PATH:root+delimiter+process.env.PATH,CI:'true',GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'15742',GITHUB_RUN_ATTEMPT:'2',PPO_FAKE_PROFILE_ROOT:root,PPO_FAKE_PROFILE_MODE:mode,TMPDIR:privateTmp,TMP:privateTmp,TEMP:privateTmp};delete env.NODE_TEST_CONTEXT
  child=spawn(process.execPath,['--import',preload,target],{env,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>stderr+=c)
  timer=setTimeout(()=>child.kill('SIGTERM'),10000)
  hardTimer=setTimeout(()=>child.kill('SIGKILL'),12000)
  closed=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('close',(code,signal)=>resolve({code,signal}))})
  const exit=await closed
  assert.equal(exit.error,undefined)
  assert.equal(exit.signal,null,stderr);const summary=JSON.parse(output.trim());artifacts=summary.output
  assert.ok(artifacts.startsWith(privateTmp+'/'))
  const report=JSON.parse(await readFile(join(artifacts,'report.json'),'utf8'))
  const rows=(await readFile(join(artifacts,'database-samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(report.testExit.code,0);assert.equal(report.productionQualified,false);assert.equal(await readFile(join(root,'removed'),'utf8'),'yes')
  assert.equal(report.error,undefined)
  if(mode==='cleanup-fails'){
   assert.equal(exit.code,1);assert.equal(report.measurementComplete,true);assert.equal(report.cleanupFailed,true);assert.equal(summary.complete,false);assert.equal(report.observerErrors,0)
  }else assert.ok(report.observerErrors>0)
  assert.equal(report.sampleCount,rows.filter(r=>r.database).length)
  if(mode==='sql-fails-after-first'){
   assert.equal(exit.code,0);assert.equal(report.measurementComplete,true);assert.equal(report.sampleCount,1)
   assert.ok(rows.some(r=>!r.database&&r.cgroupPeakBytes===1024&&r.memoryEvents?.oom_kill==='2'))
   assert.equal(report.sampledMaxima.cgroupPeakBytes,1024);assert.equal(report.memoryEventMaxima.oom_kill,'2')
   assert.equal(report.sampledMaxima.databaseBytes,200);assert.equal(report.sampledMaxima.walBytes,'100');assert.equal(report.memoryEventMaxima.future_counter,'7');assert.equal(summary.complete,true)
  }else if(mode!=='cleanup-fails'){
   assert.equal(exit.code,1);assert.equal(report.measurementComplete,false);assert.equal(summary.complete,false)
   if(mode==='sql-unavailable'){
    assert.equal(report.sampleCount,0);assert.ok(rows.length>0);assert.equal(report.sampledMaxima.databaseBytes,null);assert.equal(report.sampledMaxima.walBytes,null)
    assert.ok(report.sampledMaxima.cgroupPeakBytes>=512);assert.ok(Object.hasOwn(report.memoryEventMaxima,'oom_kill'))
   }else{
    assert.ok(report.sampleCount>0);assert.equal(report.sampledMaxima.databaseBytes,200);assert.equal(report.sampledMaxima.walBytes,'100')
    if(mode==='peak-malformed'){assert.equal(report.cgroupPeakSampleCount,0);assert.equal(report.sampledMaxima.cgroupPeakBytes,null);assert.ok(report.memoryEventSampleCount>0)}
    else{assert.equal(report.memoryEventSampleCount,0);assert.deepEqual(report.memoryEventMaxima,{});assert.ok(report.cgroupPeakSampleCount>0);assert.ok(rows.every(r=>!r.memoryEvents))}
   }
  }
  assert.equal(report.cgroupPeakSampleCount,rows.filter(r=>Object.hasOwn(r,'cgroupPeakBytes')).length)
  assert.equal(report.memoryEventSampleCount,rows.filter(r=>r.memoryEvents).length)
 }finally{
  clearTimeout(timer);clearTimeout(hardTimer)
  if(child&&child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM');const escalation=setTimeout(()=>child.kill('SIGKILL'),2000)
   try{await closed}finally{clearTimeout(escalation)}
  }
  await rm(root,{recursive:true,force:true})
 }
})
