import assert from "node:assert/strict"
import test from "node:test"
import {
  PPO_LINEAR_ISSUE_ENDPOINT,
  PPO_LINEAR_ISSUE_QUERY,
  fetchWarRoomLinearIssuePreview,
  formatWarRoomLinearIssuePreview,
  handleWarRoomLinearIssuePreviewCommand,
  parseWarRoomIssueCommand,
  parseWarRoomIssueArgs
} from "./war-room-linear-issue-preview.mjs"

const KEY = "test-only-read-key-123456789"
const ID = "RIC-145"
const record = (overrides = {}) => ({
  identifier: ID, title: "Build safe read-only preview", description: "Read Linear context without dispatch.",
  state: { name: "In Progress" }, url: "https://linear.app/rbl-productions/issue/RIC-145/build-preview", ...overrides
})
const response = (payload, status = 200) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(payload) })
const okFetch = async () => response({data: {issue: record()}})
const failsWith = code => error => error?.code === code

test("strict phone/CLI parsing accepts one RIC identifier only", () => {
  for (const raw of [`issue ${ID}`, `/ppo issue ${ID}`, `ppo issue ${ID}`]) {
    assert.deepEqual(parseWarRoomIssueCommand(raw), ["issue", ID])
    assert.deepEqual(parseWarRoomIssueArgs([raw]), ["issue", ID])
  }
  assert.deepEqual(parseWarRoomIssueArgs(["/ppo", "issue", ID]), ["issue", ID])
  assert.deepEqual(parseWarRoomIssueArgs(["issue", ID]), ["issue", ID])
  for (const raw of [`issue ${ID} extra`, `issue  ${ID}`, `issue\t${ID}`, `issue ${ID}\nrelease`,
    `issue RIC-0`, `issue RIC-1/../../`, `issue RIC-1;sh`, `issue OTHER-12`,
    `Issue ${ID}`, `issue RIC-1 `, `/ppo issue ${ID}\u001b[0m`]) {
    assert.equal(parseWarRoomIssueCommand(raw), null, raw)
  }
  assert.equal(parseWarRoomIssueArgs(["issue", " RIC-145 "]), null)
  assert.equal(parseWarRoomIssueArgs(["issue", ID, "extra"]), null)
})

test("valid read-only query sends fixed endpoint, bounded GraphQL variables and no mutations", async () => {
  let called = 0
  const fetchImpl = async (url, init) => {
    called++
    assert.equal(url, PPO_LINEAR_ISSUE_ENDPOINT)
    assert.equal(init.method, "POST")
    assert.equal(init.headers.Authorization, KEY)
    assert.equal(init.redirect, "error")
    assert.equal(init.cache, "no-store")
    assert.ok(init.signal)
    const body = JSON.parse(init.body)
    assert.deepEqual(body, {query: PPO_LINEAR_ISSUE_QUERY, variables: {id: ID}})
    assert.equal(body.query.includes("mutation"), false)
    return okFetch()
  }
  const p = await fetchWarRoomLinearIssuePreview(ID, {fetchImpl, apiKey: KEY})
  assert.equal(called, 1)
  assert.deepEqual(p, {identifier: ID, title: record().title, summary: record().description,
    state: "In Progress", url: record().url})
  const formatted = formatWarRoomLinearIssuePreview(p)
  assert.match(formatted, /READ ONLY/)
  assert.match(formatted, /No dispatch staged/)
  assert.ok(!formatted.includes(KEY))
})

test("missing dedicated read-only credential never contacts provider", async () => {
  let calls = 0
  const result = await handleWarRoomLinearIssuePreviewCommand(ID, {apiKey: "", fetchImpl: async()=>{calls++; return okFetch()}})
  assert.equal(result.ok, false)
  assert.match(result.output, /LINEAR_READ_CREDENTIAL_UNAVAILABLE/)
  assert.equal(calls, 0)
})

test("invalid identifiers fail before credential or network handling", async () => {
  const result = await handleWarRoomLinearIssuePreviewCommand("RIC-0", {apiKey: KEY, fetchImpl: async()=>{throw Error("called")}})
  assert.equal(result.ok, false)
  assert.match(result.output, /LINEAR_ISSUE_ID_INVALID/)
})

test("provider errors, partial GraphQL errors, auth and rate limits fail closed with safe codes", async () => {
  for (const [fetchImpl, code] of [
    [async()=>response({},401),"LINEAR_AUTH_FAILED"],
    [async()=>response({},403),"LINEAR_AUTH_FAILED"],
    [async()=>response({},429),"LINEAR_RATE_LIMITED"],
    [async()=>response({},503),"LINEAR_UPSTREAM_UNAVAILABLE"],
    [async()=>response({errors:[{message:"secret: stolen"}],data:{issue:record()}}),"LINEAR_UPSTREAM_UNAVAILABLE"],
    [async()=>response({data:{issue:null}}),"LINEAR_ISSUE_NOT_FOUND"],
    [async()=>{throw Error("API key leaked: "+KEY)},"LINEAR_UPSTREAM_UNAVAILABLE"]
  ]) {
    const result = await handleWarRoomLinearIssuePreviewCommand(ID, {fetchImpl, apiKey: KEY})
    assert.equal(result.ok,false)
    assert.match(result.output,new RegExp(code))
    assert.ok(!result.output.includes(KEY))
    assert.ok(!result.output.includes("secret: stolen"))
  }
})

test("wrong issue identity and untrusted external source URL are rejected", async () => {
  for (const issue of [record({identifier:"RIC-146"}),record({url:"https://evil.example/issue/RIC-145"}),
    record({url:"http://linear.app/rbl/issue/RIC-145"}),record({url:"https://linear.app.evil.com/issue/RIC-145"}),
    record({url:"https://linear.app/rbl/issue/RIC-145?token=abc"}),record({title:null})]) {
    await assert.rejects(fetchWarRoomLinearIssuePreview(ID,{apiKey:KEY,fetchImpl:async()=>response({data:{issue}})}),failsWith("LINEAR_RESPONSE_INVALID"))
  }
})

test("provider-controlled content is bounded, removes controls and redacts token forms", async () => {
  const secret = "lin_api_abcdefghijklmnopqrstuvwxyz123456"
  const issue = record({title:"Audit\u001b[31m team",description:`Authorization: Bearer SECRET_TEST_VALUE ${secret} github_pat_abcdefghijklmnopqrstuvwxyz12345678 Task: ${"x".repeat(4000)}`})
  const preview = await fetchWarRoomLinearIssuePreview(ID,{apiKey:KEY,fetchImpl:async()=>response({data:{issue}})})
  assert.equal(preview.title.includes("\u001b"),false)
  assert.ok(preview.summary.length <= 1151)
  assert.ok(!preview.summary.includes(secret))
  assert.ok(!preview.summary.includes("SECRET_TEST_VALUE"))
  assert.ok(preview.summary.includes("[redacted]"))
  assert.ok(!formatWarRoomLinearIssuePreview(preview).includes(KEY))
})

test("oversized announced and streamed responses cannot allocate unbounded data", async () => {
  await assert.rejects(fetchWarRoomLinearIssuePreview(ID,{apiKey:KEY,fetchImpl:async()=>({status:200,headers:{get:()=>"1000000"},text:async()=>""})}),failsWith("LINEAR_RESPONSE_OVERSIZED"))
  const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(70000));c.close()}})
  await assert.rejects(fetchWarRoomLinearIssuePreview(ID,{apiKey:KEY,fetchImpl:async()=>({status:200,headers:{get:()=>null},body})}),failsWith("LINEAR_RESPONSE_OVERSIZED"))
})

test("malformed JSON and wrong root object never produce authority-bearing preview", async () => {
  for (const payload of ["not-json","null","[]",'{"data": {"issue": 42}}']) {
    await assert.rejects(fetchWarRoomLinearIssuePreview(ID,{apiKey:KEY,fetchImpl:async()=>({status:200,headers:{get:()=>null},text:async()=>payload})}),failsWith("LINEAR_RESPONSE_INVALID"))
  }
})

test("null/empty Linear description renders a safe readable preview", async () => {
  const p = await fetchWarRoomLinearIssuePreview(ID,{apiKey:KEY,fetchImpl:async()=>response({data:{issue:record({description:null})}})})
  assert.equal(p.summary,"(no description)")
})