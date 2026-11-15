import test from 'node:test'
import assert from 'node:assert/strict'
import {formatProjectStatus,handleGitHubPpoStatus} from './github-ppo-status.mjs'
import {formatPrSummary} from './github-ppo-commands.mjs'
import {listAllowedProjects,normalizePullRequest} from './github-readonly.mjs'
import {fetchWarRoomLinearIssuePreview} from './war-room-linear-issue-preview.mjs'
const project=listAllowedProjects()[0]
const repository={fullName:project.fullName,defaultBranch:'main',updatedAt:'2026-11-15T00:00:00Z'}
function client(overrides={}){
 return {
  getRepoMetadata:async()=>repository,
  getRecentCommits:async()=>[{shortSha:'abcdef1',message:'Known update'}],
  getOpenPullRequests:async()=>[],
  getOpenIssuesPage:async()=>({issues:[],limitHit:false}),
  ...overrides
 }
}
const firstProject=output=>output.split('\n\n')[1]

test('one unavailable GitHub source preserves independent project facts and registry ordering',async()=>{
 const c=client({getOpenPullRequests:async()=>{throw Error('SENSITIVE_TEST_SENTINEL upstream details')}})
 const {output}=await handleGitHubPpoStatus({client:c}),first=firstProject(output)
 assert.match(first,/- Default: main/)
 assert.match(first,/- Latest: abcdef1 Known update/)
 assert.match(first,/- Open PRs: unavailable/)
 assert.match(first,/- Open issues: none/)
 assert.doesNotMatch(output,/SENSITIVE_TEST_SENTINEL/)
 const order=listAllowedProjects().map(p=>output.indexOf(p.displayName));assert.ok(order.every(position=>position>=0),'every configured project is present');assert.deepEqual(order,[...order].sort((a,b)=>a-b))
})

test('metadata failure preserves list observations and identifies the configured repo',async()=>{
 const {output}=await handleGitHubPpoStatus({client:client({getRepoMetadata:async()=>{throw Error('not available')}})})
 const first=firstProject(output)
 assert.match(first,new RegExp(`Repo: ${project.fullName} \\(configured`))
 assert.match(first,/- Default: unavailable/)
 assert.match(first,/- Latest: abcdef1 Known update/)
 assert.match(first,/- Updated: unavailable/)
})

test('unavailable or malformed reporting lists are distinct from confirmed empty results',()=>{
 const missing=formatProjectStatus(project,null,null,null,null)
 assert.match(missing,/- Latest: unavailable/)
 assert.match(missing,/- Open PRs: unavailable/)
 assert.match(missing,/- Open issues: unavailable/)
 assert.doesNotMatch(missing,/none|completed|ready/)
 for(const page of [{}, {issues:null}, {issues:'unavailable'}])assert.match(formatProjectStatus(project,repository,[],[],page),/- Open issues: unavailable/)
 const empty=formatProjectStatus(project,repository,[],[],{issues:[],limitHit:false})
 assert.match(empty,/- Latest: none returned/);assert.match(empty,/- Open PRs: none/);assert.match(empty,/- Open issues: none/)
})

test('all-source failure reports safe unavailability without inventing zero counts',async()=>{
 const fail=async()=>{throw Error('SENSITIVE_TEST_SENTINEL')}
 const {output}=await handleGitHubPpoStatus({client:client({getRepoMetadata:fail,getRecentCommits:fail,getOpenPullRequests:fail,getOpenIssuesPage:fail})})
 assert.equal((output.match(/Status unavailable:/gu)||[]).length,listAllowedProjects().length)
 assert.doesNotMatch(output,/SENSITIVE_TEST_SENTINEL|Open PRs: none|Open issues: none/)
})

test('PR reporting preserves unknown draft metadata and bounds counts without implying readiness',()=>{
 for(const draft of [undefined,null,'false',0]){
  const normalized=normalizePullRequest({number:7,title:'Incomplete metadata',draft})
  assert.equal(normalized.draft,null)
  const text=formatPrSummary(project,repository,[normalized])
  assert.match(text,/draft status unavailable/);assert.doesNotMatch(text,/ready|#null|undefined/)
 }
 const rows=Array.from({length:5},(_,i)=>normalizePullRequest({number:i+1,title:'Change '+(i+1),draft:i===0}))
 assert.match(formatPrSummary(project,repository,rows),/Open PRs: 5\+/)
 assert.match(formatPrSummary(project,repository,rows),/not draft/)
 assert.match(formatPrSummary(project,repository,[]),/Open PRs: none/)
})

test('PR presentation uses deterministic issue-number order without mutating the supplied rows',()=>{
 const rows=[{number:3,title:'Third',draft:false},{number:1,title:'First',draft:true},{number:2,title:'Second',draft:false}],original=structuredClone(rows)
 assert.equal(formatPrSummary(project,repository,rows),formatPrSummary(project,repository,[...rows].reverse()))
 assert.deepEqual(rows,original)
 const text=formatPrSummary(project,repository,[{}]);assert.doesNotMatch(text,/#undefined|#null|ready/);assert.match(text,/number unavailable/)
})

const issue={identifier:'RIC-145',title:'Read-only context',description:null,state:{name:'Todo'},url:'https://linear.app/rbl-productions/issue/RIC-145/preview'}
const preview=overrides=>fetchWarRoomLinearIssuePreview('RIC-145',{apiKey:'test-only-read-key-123456789',fetchImpl:async()=>({status:200,headers:{get:()=>null},text:async()=>JSON.stringify({data:{issue:{...issue,...overrides}}})})})
test('Linear previews retain confirmed task states and label missing or blank state metadata unknown',async()=>{
 for(const name of ['Done','In Progress','Todo','Blocked'])assert.equal((await preview({state:{name}})).state,name)
 for(const state of [null,undefined,{}, {name:null},{name:''},{name:'   '},{name:'\u001b\u0000'}])assert.equal((await preview({state})).state,'unknown')
 assert.equal((await preview({description:undefined})).summary,'(description unavailable)')
 assert.equal((await preview({description:null})).summary,'(no description)')
})

test('partial failures still perform each existing bounded read once per project',async()=>{
 const calls=[],c=client({getRecentCommits:async()=>{throw Error('unavailable')}})
 for(const [method,fn]of Object.entries(c))c[method]=async(...args)=>{calls.push([method,...args]);return fn(...args)}
 await handleGitHubPpoStatus({client:c})
 assert.deepEqual(calls,listAllowedProjects().flatMap(p=>[
  ['getRepoMetadata',p.id],['getRecentCommits',p.id,5],['getOpenPullRequests',p.id,5],['getOpenIssuesPage',p.id,5]
 ]))
})

test('PR ordering stays deterministic for incomplete metadata and display ties',()=>{
 const rows=[{title:'Same',headRef:'z',draft:null},{title:'Same',headRef:'a',draft:null},{number:4,title:'Known',draft:false}]
 assert.equal(formatPrSummary(project,repository,rows),formatPrSummary(project,repository,[...rows].reverse()))
})

test('malformed Linear status values remain unavailable rather than becoming a confirmed task state',async()=>{
 for(const state of [true,[],{name:12}])await assert.rejects(preview({state}),e=>e.code==='LINEAR_RESPONSE_INVALID')
})

for(const failed of [
 ['getRepoMetadata'],['getRecentCommits'],['getOpenPullRequests'],['getOpenIssuesPage'],
 ['getRepoMetadata','getRecentCommits'],['getOpenPullRequests','getOpenIssuesPage'],
 ['getRepoMetadata','getOpenPullRequests','getOpenIssuesPage'],
 ['getRecentCommits','getOpenPullRequests','getOpenIssuesPage']
])test('P3-02 independent report facts survive failures: '+failed.join(', '),async()=>{
 const overrides=Object.fromEntries(failed.map(key=>[key,async()=>{throw Error('SENSITIVE_TEST_SENTINEL')}]))
 const {output}=await handleGitHubPpoStatus({client:client(overrides)}),report=firstProject(output)
 const missing=key=>failed.includes(key)
 assert.match(report,missing('getRepoMetadata')?/Repo: .*\(configured; metadata unavailable\)/:/Repo: Linardi1328\/khlim-assist(?:\n|$)/)
 assert.match(report,missing('getRepoMetadata')?/- Default: unavailable/ : /- Default: main/)
 assert.match(report,missing('getRepoMetadata')?/- Updated: unavailable/ : /- Updated: 2026-11-15T00:00:00Z/)
 assert.match(report,missing('getRecentCommits')?/- Latest: unavailable/ : /- Latest: abcdef1 Known update/)
 assert.match(report,missing('getOpenPullRequests')?/- Open PRs: unavailable/ : /- Open PRs: none/)
 assert.match(report,missing('getOpenIssuesPage')?/- Open issues: unavailable/ : /- Open issues: none/)
 assert.doesNotMatch(output,/SENSITIVE_TEST_SENTINEL/)
 const positions=listAllowedProjects().map(p=>output.indexOf(p.displayName))
 assert.ok(positions.every(position=>position>=0),'every configured project is present')
 assert.deepEqual(positions,[...positions].sort((a,b)=>a-b))
})
