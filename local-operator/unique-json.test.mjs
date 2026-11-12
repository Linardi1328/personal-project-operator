import assert from "node:assert/strict"
import test from "node:test"
import { parseUniqueJson } from "./unique-json.mjs"
test("duplicate decoded names are refused at every object depth",()=>{
  for(const s of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"nested":{"a":false,"a":"valid"}}',
    '[{"a":1,"a":2}]','{"__proto__":null,"__proto__":{}}','{"a\\u0022":1,"a\\\"":2}']){
    assert.throws(()=>parseUniqueJson(s),/Duplicate/)
  }
})
test("siblings, nested objects, arrays and quoted JSON-like string values remain valid",()=>{
  const source=JSON.stringify({a:{a:1},b:[{a:2},{a:3}],string:'{"a":1,"a":2} \\ "'})
  assert.deepEqual(parseUniqueJson(source),JSON.parse(source))
})
test("byte and depth bounds apply before normalization",()=>{
  assert.throws(()=>parseUniqueJson('"😀"',{maxBytes:5}),/bounded JSON/)
  assert.equal(parseUniqueJson('"😀"',{maxBytes:6}),"😀")
  assert.deepEqual(parseUniqueJson('[[0]]',{maxDepth:2}),[[0]])
  assert.throws(()=>parseUniqueJson('[[[0]]]',{maxDepth:2}),/nesting/)
  assert.throws(()=>parseUniqueJson('{"a":0,}'))
  assert.throws(()=>parseUniqueJson(null))
})
