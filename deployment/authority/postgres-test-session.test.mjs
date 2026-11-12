import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"
import { createPostgresTestSession } from "./postgres-test-session.mjs"
function fixture(options){
  const p=new EventEmitter()
  p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough()
  p.exitCode=null;p.signalCode=null
  let input=""
  p.stdin.on("data",chunk=>{input+=chunk})
  p.kill=()=>{p.signalCode="SIGKILL";p.emit("close",null,"SIGKILL")}
  const client=createPostgresTestSession(p,options)
  const marker=()=>input.match(/\\echo (PPO_CI_[a-f0-9]+_END)/gu).at(-1).slice(6)
  return {p,client,marker}
}
test("session markers are unique full lines, never substrings or historical delimiters",async()=>{
  const {p,client,marker}=fixture()
  try{
    let prior=""
    for(let i=0;i<12;i++){
      const result=client.send("SELECT 'synthetic';"),m=marker()
      assert.notEqual(m,prior)
      let completed=false;result.then(()=>{completed=true})
      p.stdout.write("prefix "+m+" suffix\n"+(prior?prior+"\n":""))
      await Promise.resolve()
      assert.equal(completed,false)
      p.stdout.write(m.slice(0,8));p.stdout.write(m.slice(8)+"\n")
      assert.equal(await result,"prefix "+m+" suffix"+(prior?"\n"+prior:""))
      prior=m
    }
  }finally{await client.close()}
})
test("stdout and stderr are bounded and overflow closes the session",async()=>{
  for(const stream of ["stdout","stderr"]){
    const {p,client}=fixture({maxStdoutBytes:16,maxStderrBytes:16})
    const result=client.send("SELECT 1;")
    p[stream].write("x".repeat(17))
    await assert.rejects(result,new RegExp(stream+" limit"))
    await assert.rejects(client.send("SELECT 2;"),/closed/)
    await client.close()
  }
})
test("closed and failed sessions reject immediately, including outstanding sends",async()=>{
  const {p,client}=fixture()
  const result=client.send("SELECT 1;")
  p.stderr.write("40001 synthetic abort")
  p.exitCode=1;p.emit("close",1)
  await assert.rejects(result,/40001/)
  await assert.rejects(client.send("SELECT 2;"),/closed/)
  await client.close()
  const other=fixture()
  const failed=other.client.send("SELECT 1;")
  other.p.emit("error",Error("synthetic process failure"))
  await assert.rejects(failed,/process failure/)
  await assert.rejects(other.client.send("SELECT 2;"),/closed/)
  await other.client.close()
})
