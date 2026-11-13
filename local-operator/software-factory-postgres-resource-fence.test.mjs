import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomUUID} from 'node:crypto'
import {signSyntheticResourceDescriptor,createSyntheticResourceVerifier,createSyntheticResourceFence,inspectSyntheticResourceReceipt} from './software-factory-postgres-resource-fence.mjs'
const mode='isolated-postgres-resource-fencing-only'
test('resource seam requires explicit isolation and pinned signing keys',()=>{assert.throws(()=>createSyntheticResourceFence());assert.throws(()=>createSyntheticResourceVerifier({mode,query:async()=>{}}))})
test('malformed or unsupported descriptors cannot be signed',()=>{
 const key=generateKeyPairSync('ed25519').privateKey
 for(const value of ['{}','{"version":1,"version":1}',JSON.stringify({action:'tests.local'}),' '.repeat(8193)])assert.throws(()=>signSyntheticResourceDescriptor(value,key))
})
test('absent exact resource receipt is unknown and never authorizes retry',async()=>{
 const operation={operationId:randomUUID(),ticket:randomUUID(),descriptorHash:'a'.repeat(64)}
 const r=await inspectSyntheticResourceReceipt({mode,operation,query:async()=>({rows:[{receipt:null}]})})
 assert.equal(r.status,'unknown');assert.equal(r.grant,false);assert.equal(r.canExecute,false);assert.equal(r.releaseAuthorized,false)
})
test('unknown transaction cannot be retried by the resource adapter',async()=>{
 const c=createSyntheticResourceFence({mode,query:async()=>{throw Error('lost')}}),o={operationId:randomUUID(),ticket:randomUUID(),descriptorHash:'b'.repeat(64)}
 assert.equal((await c.apply(o)).status,'unknown');await assert.rejects(c.apply(o))
})
