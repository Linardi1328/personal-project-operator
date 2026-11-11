import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { toPpoWrapperArgs, runPpoLocalTool } from "../openclaw/plugins/ppo-local/bridge.mjs"

const ID = "RIC-145"
const CLI = fileURLToPath(new URL("./ppo-command.mjs", import.meta.url))

test("the OpenClaw bridge accepts only one canonical RBL Linear issue identifier", () => {
  for (const raw of [`issue ${ID}`, `/ppo issue ${ID}`, `ppo issue ${ID}`]) {
    assert.deepEqual(toPpoWrapperArgs(raw), ["issue", ID])
  }
  for (const raw of [`issue  ${ID}`, `issue ${ID} extra`, `issue RIC-0`,
    `issue RIC-145;rm -rf /`, `issue RIC-145\nrelease`, `/ppo issue ${ID} `,
    `issue OTHER-145`, `issue RIC-0001`, `issue RIC-145/../../`,
    `issue\t${ID}`, `issue ${ID}\u001b[32m`]) {
    assert.equal(toPpoWrapperArgs(raw), null, raw)
  }
})

test("the OpenClaw tool forwards a read-only issue route without execution arguments", async () => {
  let calls = 0
  const result = await runPpoLocalTool({command:`/ppo issue ${ID}`}, {
    runWrapper: async (args, options) => {
      calls += 1
      assert.deepEqual(args, ["issue", ID])
      assert.ok(options.wrapperPath.endsWith("ppo-command.mjs"))
      assert.ok(options.env.PPO_WRITE_DATA_DIR.startsWith("/"))
      return {stdout:"PPO Linear read-only preview",stderr:""}
    }
  })
  assert.equal(calls,1)
  assert.equal(result.ok,true)
  assert.equal(result.stdout,"PPO Linear read-only preview")
  assert.deepEqual(result.wrapperArgs,["issue",ID])
})

test("the terminal command refuses to call Linear when dedicated credential is absent", () => {
  const run = spawnSync(process.execPath,[CLI,"issue",ID], {
    encoding:"utf8", env:{...process.env,PPO_LINEAR_READ_API_KEY:""},timeout:12000
  })
  assert.equal(run.status,1)
  assert.match(run.stdout,/LINEAR_READ_CREDENTIAL_UNAVAILABLE/)
  assert.match(run.stdout,/No work staged or executed/)
  assert.equal(run.stderr,"")
})

test("the terminal command rejects input that adds scope, shell syntax or other commands", () => {
  for(const args of [["issue",ID,"run"],["issue RIC-145 extra"],["/ppo issue RIC-0"],["issue", "RIC-145\nrelease"]]) {
    const run = spawnSync(process.execPath,[CLI,...args],{encoding:"utf8",timeout:12000,env:{...process.env,PPO_LINEAR_READ_API_KEY:""}})
    assert.equal(run.status,1,JSON.stringify(args))
    assert.doesNotMatch(run.stdout,/LINEAR_READ_CREDENTIAL_UNAVAILABLE/)
  }
})