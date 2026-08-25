import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"

const SCRIPT_PATH = resolve("deployment/scripts/prepare-khlim-development-runtime.sh")
const REVIEWER_PATH = resolve("deployment/bin/ppo-independent-reviewer")

test("KHLIM runtime preparation script has valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", SCRIPT_PATH], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
})

test("independent reviewer wrapper has valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", REVIEWER_PATH], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
})

test("KHLIM runtime preparation is fixed, confirmation-gated, and non-destructive", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8")

  assert.match(source, /SOURCE_DIR="\$\{SOURCE_ROOT\}\/khlim-digital-ecosystem"/u)
  assert.match(source, /REPO_URL="https:\/\/github\.com\/Linardi1328\/khlim-digital-ecosystem\.git"/u)
  assert.match(source, /TRUSTED_NODE_BIN="\$\{TRUSTED_NODE_DIR\}\/node"/u)
  assert.match(source, /CODEX_VERSION="0\.149\.1"/u)
  assert.match(source, /CODEX_NPM_SPEC="@openai\/codex@\$\{CODEX_VERSION\}"/u)
  assert.match(source, /BWRAP_BIN="\/usr\/bin\/bwrap"/u)
  assert.match(source, /WORKSPACE_ROOT="\/var\/lib\/personal-project-operator\/development-workspaces"/u)
  assert.match(source, /PPO_KHLIM_RUNTIME_CONFIRM/u)
  assert.match(source, /REQUIRED_CONFIRMATION="prepare-khlim-development-runtime"/u)
  assert.match(source, /install -m 0755 -o root -g root "\$OPENCLAW_NODE_BIN" "\$TRUSTED_NODE_BIN"/u)
  assert.match(source, /stat -c '%u:%g:%a' "\$TRUSTED_NODE_BIN"/u)
  assert.match(source, /install -d -m 0750 -o root -g "\$SERVICE_GROUP" "\$SOURCE_ROOT"/u)
  assert.match(source, /install -m 0755 -o root -g root "\$REVIEWER_SOURCE" "\$REVIEWER_BIN"/u)
  assert.match(source, /login --device-auth/u)
  assert.match(source, /status --porcelain=v1 --untracked-files=all/u)
  assert.match(source, /merge --ff-only "origin\/\$\{BRANCH\}"/u)
  assert.doesNotMatch(source, /reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|rm\s+-rf|apparmor_restrict_unprivileged_userns=0/u)
})

test("independent reviewer wrapper pins read-only non-interactive Codex", async () => {
  const source = await readFile(REVIEWER_PATH, "utf8")

  assert.match(source, /CODEX_BIN="\/home\/ppo\/\.local\/bin\/codex"/u)
  assert.match(source, /CODEX_MODEL="gpt-5\.6-sol"/u)
  assert.match(source, /--sandbox read-only/u)
  assert.match(source, /--ask-for-approval never/u)
  assert.match(source, /--ignore-user-config/u)
  assert.match(source, /--ignore-rules/u)
  assert.equal(source.includes('trust_level=\\"untrusted\\"'), true)
  assert.match(source, /PPO_PHASE6K_REVIEW_POLICY/u)
  assert.doesNotMatch(source, /danger-full-access|yolo/u)
})
