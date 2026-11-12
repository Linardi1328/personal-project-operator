import { constants } from "node:fs"
import { mkdtemp, lstat, open, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  createDevelopmentRun, transitionDevelopmentRun, recordDevelopmentRunProgress,
  DEVELOPMENT_RUN_STORE_DIR, MAX_DEVELOPMENT_RUN_RECORD_BYTES, parseDevelopmentRunRecord
} from "./development-run-state.mjs"
import { rehearseSyntheticMigrationPreflight } from "./development-migration-preflight.mjs"

const MODE="synthetic-migration-import-rehearsal-only"
const MAX_BYTES=32*1024*1024
const MAX_FILES=10100
const ID=/^[A-Za-z0-9_-]{43}$/u
const RECORD=/^[A-Za-z0-9_-]{43}\.json$/u
const MARKER=/^[0-9]{6}\.json$/u
const IMPORT="SELECT ppo_authority.import_synthetic_snapshot($1::text,$2::text) AS accepted"
const ARCHIVE="SELECT ppo_authority.read_synthetic_archive($1::text) AS archive"
function deny(){throw Error("Synthetic migration rehearsal rejected.")}
const exact=(pattern,value)=>pattern.exec(value)?.[0]===value
const owned=info=>typeof process.getuid==="function"&&info.uid===BigInt(process.getuid())&&(info.mode&0o077n)===0n
// Compare inode, size, mode, owner and precise modification metadata.
// These observations detect changes, not a malicious same-UID replacement.
function same(a,b){
  return ["dev","ino","mode","uid","nlink","size","mtimeNs","ctimeNs"].every(key=>a[key]===b[key])
}
async function directory(path){
  const info=await lstat(path,{bigint:true})
  if(!info.isDirectory()||!owned(info)||await realpath(path)!==path)deny()
  return info
}
async function capture(root){
  const entries=[]
  let total=0
  async function walk(path,relative,depth){
    const before=await directory(path)
    const names=(await readdir(path)).sort()
    for(const name of names){
      const full=join(path,name),rel=relative?relative+"/"+name:name
      if(depth===0){
        if(!["records","versions"].includes(name))deny()
        await walk(full,rel,1)
      }else if(relative==="versions"){
        if(!exact(ID,name))deny()
        await walk(full,rel,2)
      }else{
        if(!(relative==="records"?exact(RECORD,name):exact(MARKER,name)))deny()
        const initial=await lstat(full,{bigint:true})
        if(!initial.isFile()||!owned(initial)||initial.nlink!==1n||initial.size>BigInt(MAX_DEVELOPMENT_RUN_RECORD_BYTES))deny()
        if(entries.length>=MAX_FILES||total+Number(initial.size)>MAX_BYTES)deny()
        // Open the observed file without following its final path component.
        // Use a bounded read even if a file grows after the first stat.
        const handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
        try{
          const opened=await handle.stat({bigint:true})
          if(!same(initial,opened))deny()
          const size=Number(initial.size),buffer=Buffer.alloc(size+1)
          let offset=0
          while(offset<buffer.length){
            const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset)
            if(bytesRead===0)break
            offset+=bytesRead
          }
          if(offset!==size||!same(initial,await handle.stat({bigint:true}))||
             !same(initial,await lstat(full,{bigint:true})))deny()
          entries.push({relativePath:rel,bytes:Buffer.from(buffer.subarray(0,size))})
          total+=size
        }finally{await handle.close()}
      }
    }
    if(!same(before,await directory(path))||!isDeepStrictEqual(names,(await readdir(path)).sort()))deny()
    if(depth===0&&!isDeepStrictEqual(names,["records","versions"]))deny()
    if(depth===2&&names.length===0)deny()
  }
  if(typeof constants.O_NOFOLLOW!=="number")deny()
  await walk(root,"",0)
  return entries
}
const preflight=entries=>rehearseSyntheticMigrationPreflight({mode:"synthetic-migration-preflight-only",entries})
function payload(entries){
  // Own source only. Every raw JSON value must survive normalization; the
  // earlier source preflight permits some benign extensions, this stricter
  // rehearsal refuses them rather than silently discarding any data.
  for(const entry of entries){
    const id=entry.relativePath.split("/").at(-1)
    const runId=entry.relativePath.startsWith("records/")?id.slice(0,-5):entry.relativePath.split("/")[1]
    const source=entry.bytes.toString("utf8")
    if(!isDeepStrictEqual(JSON.parse(source),parseDevelopmentRunRecord(source,runId)))deny()
  }
  return entries.map(e=>({path:e.relativePath,bytesBase64:e.bytes.toString("base64")}))
}
function decodeFiles(files){
  if(!Array.isArray(files)||files.length>MAX_FILES)deny()
  let total=0
  return files.map(file=>{
    if(typeof file?.path!=="string"||typeof file.bytesBase64!=="string"||
      file.bytesBase64.length>Math.ceil(MAX_DEVELOPMENT_RUN_RECORD_BYTES/3)*4)deny()
    const bytes=Buffer.from(file.bytesBase64,"base64")
    if(bytes.toString("base64")!==file.bytesBase64)deny()
    total+=bytes.length
    if(total>MAX_BYTES)deny()
    return {relativePath:file.path,bytes}
  })
}
function verifiedArchive(files,expectedHash){
  const entries=decodeFiles(files),manifest=preflight(entries)
  if(!manifest.readyForRehearsal||manifest.inventoryHash!==expectedHash)deny()
  return {manifest,files:payload(entries)}
}
function one(result,key){
  if(!Array.isArray(result?.rows)||result.rows.length!==1||!Object.hasOwn(result.rows[0],key))deny()
  return result.rows[0][key]
}

/**
 * Fixed synthetic source generator. No caller-supplied root, records, callback
 * or environment-derived write path. All filesystem mutations complete
 * before capture; no capability to the scratch root escapes this function.
 * Same-user adversaries and privileged local processes are outside this lab.
 */
export async function captureSyntheticMigrationRehearsal({mode}={}){
  if(mode!==MODE)deny()
  const scratch=await mkdtemp(join(await realpath(tmpdir()),"ppo-import-rehearsal-"))
  try{
    await directory(scratch)
    let clock=Date.parse("2026-04-01T00:00:00.000Z")
    const options={writeDataDir:scratch,now:()=>new Date(clock+=1000)}
    for(const [index,project] of ["rivora","rivora","kynexa"].entries()){
      let r=await createDevelopmentRun({projectId:project,task:"RIC-157 shared authority synthetic: import rehearsal "+index,
        baseSha:"a".repeat(40),headSha:"b".repeat(40),branch:"feature/migration-rehearsal",actor:"synthetic-import"},options)
      for(const status of ["planning_in_progress","planned","implementation_in_progress"]){
        r=await transitionDevelopmentRun(r.runId,{expectedVersion:r.version,status,actor:"synthetic-import"},options)
      }
      r=await recordDevelopmentRunProgress(r.runId,{expectedVersion:r.version,status:r.status,actor:"synthetic-import",
        evidence:[{kind:"implementation",sha:"b".repeat(40),source:"synthetic-import",summary:"Exact bytes 😀",metadata:{large:1e308}}]},options)
      if(index<2)await transitionDevelopmentRun(r.runId,{expectedVersion:r.version,status:"cancelled",actor:"synthetic-import"},options)
    }
    const root=join(scratch,DEVELOPMENT_RUN_STORE_DIR)
    if(!isDeepStrictEqual(await readdir(scratch),[DEVELOPMENT_RUN_STORE_DIR]))deny()
    const first=await capture(root),second=await capture(root)
    const manifest=preflight(first),repeat=preflight(second)
    if(!manifest.readyForRehearsal||!repeat.readyForRehearsal||
      manifest.inventoryHash!==repeat.inventoryHash||!isDeepStrictEqual(first,second))deny()
    const files=payload(first)
    // No mutable buffers escape. Return only generated synthetic archive
    // strings and immutable manifest digest; raw archive lives in the DB.
    return Object.freeze({inventoryHash:manifest.inventoryHash,
      files:Object.freeze(files.map(Object.freeze)),runCount:manifest.runs.length})
  }finally{await rm(scratch,{recursive:true,force:true})}
}

/**
 * Fixed injected query seam. A result must acknowledge actual COMMIT, not
 * merely a function return in an open transaction. No retry on ambiguity.
 * No production driver, credentials or actual authority switch.
 */
export function createSyntheticMigrationImporter({mode,query}={}){
  if(mode!==MODE||typeof query!=="function")deny()
  return Object.freeze({
    async rehearse(snapshot){
      // Snapshot is a trusted synthetic capture, but validate and snapshot
      // every input again. Never trust caller-supplied manifest readiness.
      const {manifest,files}=verifiedArchive(snapshot?.files,snapshot?.inventoryHash)
      if(manifest.runs.length!==snapshot.runCount)deny()
      const body=JSON.stringify(files)
      let accepted
      try{
        accepted=one(await query(IMPORT,[manifest.inventoryHash,body]),"accepted")
        if(accepted!==true&&accepted!==false)deny()
      }catch{
        // May have committed. Caller may inspect the exact archive digest;
        // absence alone is not proof that an uncertain write cannot complete.
        const error=Error("Synthetic migration commit outcome unknown; reconcile archive before any further action.")
        error.code="MIGRATION_COMMIT_UNKNOWN"
        error.inventoryHash=manifest.inventoryHash
        throw error
      }
      if(accepted!==true)deny()
      return Object.freeze({inventoryHash:manifest.inventoryHash,runCount:manifest.runs.length,
        fileCount:manifest.fileCount,rehearsalCommitted:true,importAuthorized:false,cutoverAuthorized:false})
    },
    async readArchive(inventoryHash){
      if(typeof inventoryHash!=="string"||!/^[a-f0-9]{64}$/u.test(inventoryHash)||inventoryHash.length!==64)deny()
      const archive=one(await query(ARCHIVE,[inventoryHash]),"archive")
      if(archive===null)return null
      return Object.freeze(verifiedArchive(archive,inventoryHash).files.map(Object.freeze))
    }
  })
}
