import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createGitHubReadOnlyClient,listAllowedProjects} from './github-readonly.mjs'
import {handleGitHubPpoStatus} from './github-ppo-status.mjs'
import {handleGitHubPpoCommand} from './github-ppo-commands.mjs'
import {generateCodexPrompt} from './codex-prompt-generator.mjs'

const project=listAllowedProjects()[0]
const first=output=>output.split('\n\n')[1]
function providerClient({identity=project.fullName,missingIdentity=false,prs=[],issues=[],failures=[]}={}){
 return createGitHubReadOnlyClient({runner:async request=>{
  assert.equal(request.method,'GET')
  const endpoint=request.endpoint
  const kind=endpoint.endsWith('/pulls')?'prs':endpoint.endsWith('/issues')?'issues':endpoint.endsWith('/commits')?'commits':'repository'
  if(failures.includes(kind))throw Error('SENSITIVE_TEST_SENTINEL provider failure')
  const fullName=endpoint.split('/').slice(2,4).join('/')
  const payload=kind==='prs'?prs:kind==='issues'?issues:kind==='commits'?[{sha:'a'.repeat(40),commit:{message:'Independent commit'}}]:{...(missingIdentity?{}:{full_name:identity===project.fullName?fullName:identity}),default_branch:'main',updated_at:'2026-11-15T00:00:00Z'}
  return JSON.stringify(payload)
 }})
}

for(const missingIdentity of [true,false])test(`P2-01 provider identity ${missingIdentity?'missing':'null'} is configured, while independent metadata remains available`,async()=>{
 const c=providerClient({missingIdentity,identity:null}),metadata=await c.getRepoMetadata(project.id)
 assert.equal(metadata.fullName,project.fullName)
 assert.equal(metadata.defaultBranch,'main')
 const report=first((await handleGitHubPpoStatus({client:c})).output)
 assert.match(report,/Repo: Linardi1328\/khlim-assist \(configured; identity unavailable\)/)
 assert.equal(metadata.identityConfirmed,false)
 assert.match(report,/- Default: main/)
 assert.match(report,/- Latest: aaaaaaa Independent commit/)
 assert.match((await handleGitHubPpoCommand('repo',project.id,{client:c})).output,/configured; identity unavailable/)
})

test('P2-01 confirmed identities remain confirmed and mismatches still reject',async()=>{
 assert.equal((await providerClient().getRepoMetadata(project.id)).identityConfirmed,true)
 for(const identity of ['Other/repository','',123])await assert.rejects(providerClient({identity}).getRepoMetadata(project.id),e=>e.code==='MALFORMED_GITHUB_RESPONSE')
})

for(const [name,rows,expected]of [
 ['null',[null],/unavailable.*incomplete/],
 ['primitives',[false,42,'row',[]],/unavailable.*incomplete/],
 ['mixed',[{number:7,title:'Valid',draft:false},null,'row'],/1\+.*incomplete/],
 ['incomplete object',[{}],/Open PRs: 1(?:\n|$)/],
 ['empty',[],/Open PRs: none(?:\n|$)/]
])test('P2-02 actual PR provider normalization: '+name,async()=>{
 const report=first((await handleGitHubPpoStatus({client:providerClient({prs:rows})})).output)
 assert.match(report,expected)
 assert.match(report,/- Default: main/)
 assert.match(report,/- Latest: aaaaaaa Independent commit/)
 assert.match(report,/- Open issues: none/)
 if(name==='mixed'){
  const pr=(await handleGitHubPpoCommand('pr',project.id,{client:providerClient({prs:rows})})).output
  assert.match(pr,/1\+.*incomplete/);assert.match(pr,/#7 Valid/);assert.doesNotMatch(pr,/#null|#undefined/)
 }
})

for(const [name,rows,expected,valid,invalid]of [
 ['entirely invalid',[null,true,2,'row',[]],/unavailable.*incomplete.*page limit hit/,0,5],
 ['mixed unsaturated',[{number:8,title:'Issue'},null],/1\+.*incomplete/,1,1],
 ['saturated mixed',[{number:8},{number:9,pull_request:{}},null,42,{}],/2\+.*incomplete.*page limit hit/,2,2],
 ['confirmed empty',[],/Open issues: none(?:\n|$)/,0,0]
])test('P2-02 actual issue provider normalization: '+name,async()=>{
 const c=providerClient({issues:rows}),report=first((await handleGitHubPpoStatus({client:c})).output)
 assert.match(report,expected)
 assert.match(report,/- Default: main/);assert.match(report,/- Latest: aaaaaaa Independent commit/);assert.match(report,/- Open PRs: none/)
 const page=await c.getOpenIssuesPage(project.id,5)
 assert.equal(page.issues.length,valid);assert.equal(page.invalidRowCount,invalid)
 assert.equal(page.rawReturnedCount,rows.length);assert.equal(page.limitHit,rows.length>=5)
})

test('P2-02 legacy array/snapshot consumers cannot silently lose malformed-row completeness',async()=>{
 for(const config of [{prs:[{},null]},{issues:[{},null]}]){
  const c=providerClient(config)
  await assert.rejects(config.prs?c.getOpenPullRequests(project.id):c.getOpenIssues(project.id),e=>e.code==='MALFORMED_GITHUB_RESPONSE')
  await assert.rejects(c.getProjectSnapshot(project.id),e=>e.code==='MALFORMED_GITHUB_RESPONSE')
 }
})

async function cli(t,command,records){
 const dir=await mkdtemp(join(tmpdir(),'ppo-report-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const gh=join(dir,'gh')
 await writeFile(gh,`#!/usr/bin/env node
if(process.argv[2]!=='api'||process.argv[3]!=='--method'||process.argv[4]!=='GET')process.exit(2)
const path=process.argv[5],data=JSON.parse(process.env.PPO_REPORT_TEST_DATA)
console.log(JSON.stringify((path.includes('/pulls')||path.includes('/issues'))?data: {default_branch:'main'}))
`);await chmod(gh,0o700)
 const r=spawnSync(process.execPath,['local-operator/github-readonly-cli.mjs',command,project.id],{cwd:new URL('..',import.meta.url),env:{...process.env,PATH:dir+':'+process.env.PATH,PPO_REPORT_TEST_DATA:JSON.stringify(records)},encoding:'utf8',timeout:10000})
 assert.equal(r.status,0,r.stderr);return r.stdout
}
test('P3-01 real CLI shares deterministic PR lines, including absent number and confirmed non-draft',async t=>{
 const records=[{number:9,title:'Nine',draft:true},{title:'Unknown'},{number:2,title:'Two',draft:false}]
 const a=await cli(t,'prs',records),b=await cli(t,'prs',[...records].reverse())
 assert.equal(a,b);assert.doesNotMatch(a,/#null|#undefined/)
 assert.match(a,/number unavailable Unknown.*draft status unavailable/)
 assert.match(a,/#2 Two.*not draft/);assert.ok(a.indexOf('#2')<a.indexOf('#9'))
 const phone=(await handleGitHubPpoCommand('pr',project.id,{client:providerClient({prs:records})})).output
 assert.deepEqual(a.split('\n').filter(l=>l.startsWith('- ')),phone.split('\n').filter(l=>l.startsWith('- ')))
})


test('page-aware prompt reporting preserves partial counts and configured identity',async()=>{
 const c=providerClient({missingIdentity:true,prs:[{number:7},null],issues:[{number:8},{pull_request:{}},false]})
 const prompt=await generateCodexPrompt(project.id,'Review existing documentation',{client:c,loadProjectDocument:async()=> '# Project\n\n## Current Status\nConnected candidate.'})
 assert.match(prompt,/configured; identity unavailable/)
 assert.match(prompt,/Open PRs: 1\+.*incomplete/)
 assert.match(prompt,/Open issues: 1\+.*incomplete/)
})

test('page APIs retain valid incomplete records and raw saturation before filtering',async()=>{
 const c=providerClient({prs:[{},null,42,{number:9},{number:10}],issues:[{},null,{pull_request:{}},{number:9},'row']})
 const prs=await c.getOpenPullRequestsPage(project.id,5),issues=await c.getOpenIssuesPage(project.id,5)
 assert.deepEqual(prs.pullRequests.map(r=>r.number),[null,9,10]);assert.equal(prs.invalidRowCount,2)
 assert.deepEqual(issues.issues.map(r=>r.number),[null,9]);assert.equal(issues.invalidRowCount,2)
 for(const page of [prs,issues]){assert.equal(page.rawReturnedCount,5);assert.equal(page.pageLimit,5);assert.equal(page.limitHit,true)}
})

test('CLI keeps malformed pages unavailable and distinguishes missing provider identity',async t=>{
 const output=await cli(t,'prs',[null,42]);assert.match(output,/Open PRs: unavailable.*incomplete/);assert.doesNotMatch(output,/none open|#null/)
 const repo=await cli(t,'repo',[]);assert.match(repo,/configured; identity unavailable/);assert.match(repo,/Default: main/)
 const issues=await cli(t,'issues',[{number:7},{},null]);assert.match(issues,/Open issues: 2\+.*incomplete/);assert.match(issues,/#7/);assert.match(issues,/number unavailable/);assert.doesNotMatch(issues,/#null/)
})
