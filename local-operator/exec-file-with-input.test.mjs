import assert from "node:assert/strict"
import test from "node:test"
import { execFileWithInput } from "./exec-file-with-input.mjs"

test("live probe transport delivers the exact prompt and EOF to a real child", async () => {
  const input = "Reply with exactly PPO_CODEX_AUTHENTICATED.\n"
  const result = await execFileWithInput(process.execPath, ["-e", `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk });
    process.stdin.on("end", () => process.stdout.write(input));
  `], { input, encoding: "utf8", shell: false, maxBuffer: 4096, timeout: 5000 })
  assert.equal(result.stdout, input)
  assert.equal(result.stderr, "")
})

test("live probe transport retains early child failure details for classification", async () => {
  await assert.rejects(execFileWithInput(process.execPath, ["-e", `
    process.stderr.write("HTTP 401: unauthorized");
    process.exit(7);
  `], { input: "probe\n", encoding: "utf8", shell: false, timeout: 5000 }), error => {
    assert.equal(error.code, 7)
    assert.match(error.stderr, /HTTP 401: unauthorized/)
    return true
  })
})

test("live probe transport still terminates a child that exceeds its deadline", async () => {
  await assert.rejects(execFileWithInput(process.execPath, ["-e", `
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `], { input: "probe\n", encoding: "utf8", shell: false, timeout: 200 }), error => {
    assert.equal(error.killed, true)
    assert.equal(error.signal, "SIGTERM")
    return true
  })
})
