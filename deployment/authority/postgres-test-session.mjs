import { randomUUID } from "node:crypto"

// Test transport only. Delimiters are unique per request and match a whole
// output line. Per-request UTF-8 output and diagnostic buffers are bounded.
export function createPostgresTestSession(p,{timeoutMs=30000,maxStdoutBytes=40*1024*1024,maxStderrBytes=16384}={}){
  let pending=null,closed=false,stderr="",resolveDone
  const done=new Promise(resolve=>{resolveDone=resolve})
  const timer=setTimeout(()=>fail(Error("PostgreSQL test session timeout.")),timeoutMs)
  function rejectPending(error){
    if(pending){const {reject}=pending;pending=null;reject(error)}
  }
  function fail(error){
    if(closed)return
    closed=true
    clearTimeout(timer)
    rejectPending(error)
    p.kill("SIGKILL")
  }
  p.stdin.on("error",error=>fail(error))
  p.stdout.setEncoding("utf8")
  p.stderr.setEncoding("utf8")
  p.stderr.on("data",chunk=>{
    if(Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>maxStderrBytes){fail(Error("PostgreSQL test stderr limit."));return}
    stderr+=chunk
  })
  p.stdout.on("data",chunk=>{
    if(closed)return
    if(!pending){fail(Error("Unexpected PostgreSQL test output."));return}
    pending.bytes+=Buffer.byteLength(chunk)
    if(pending.bytes>maxStdoutBytes){fail(Error("PostgreSQL test stdout limit."));return}
    pending.output+=chunk
    const {marker,output}=pending
    const match=new RegExp("(?:^|\\n)"+marker+"\\r?\\n").exec(output)
    if(match){
      const {resolve}=pending
      const rest=output.slice(match.index+match[0].length)
      if(rest.trim()){fail(Error("Unexpected PostgreSQL test trailing output."));return}
      pending=null
      resolve(output.slice(0,match.index).trim())
    }
  })
  p.on("error",error=>fail(error))
  p.on("close",()=>{
    closed=true
    clearTimeout(timer)
    rejectPending(Error(stderr||"PostgreSQL test session closed."))
    resolveDone()
  })
  function send(statement){
    if(closed||p.exitCode!==null||p.signalCode!==null)return Promise.reject(Error("PostgreSQL test session closed."))
    if(pending)return Promise.reject(Error("PostgreSQL test send already pending."))
    stderr=""
    return new Promise((resolve,reject)=>{
      const marker="PPO_CI_"+randomUUID().replaceAll("-","")+"_END"
      pending={resolve,reject,marker,output:"",bytes:0}
      p.stdin.write(statement+"\n\\echo "+marker+"\n")
    })
  }
  async function close(){
    if(!closed){closed=true;clearTimeout(timer);rejectPending(Error("PostgreSQL test session closed."));p.stdin.end();p.kill("SIGKILL")}
    await done
  }
  return {send,close}
}
