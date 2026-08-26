import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"
import {
  MAX_REVIEW_FINDING_CHARS,
  MAX_REVIEW_FINDINGS
} from "../local-operator/development-review-findings-contract.mjs"

const SCRIPT_PATH = resolve("deployment/scripts/prepare-khlim-development-runtime.sh")
const MACOS_KHLIM_ASSIST_PYTHON_SCRIPT_PATH = resolve("deployment/scripts/prepare-macos-khlim-assist-python-runtime.sh")
const REVIEWER_PATH = resolve("deployment/bin/ppo-independent-reviewer")
const MACOS_REVIEWER_PATH = resolve("deployment/bin/ppo-independent-reviewer-macos")
const REVIEW_OUTPUT_SCHEMA_PATH = resolve("deployment/phase6f-review-output.schema.json")

test("KHLIM runtime preparation script has valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", SCRIPT_PATH], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
})

test("macOS KHLIM Assist Python runtime preparation script has valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", MACOS_KHLIM_ASSIST_PYTHON_SCRIPT_PATH], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
})

test("macOS KHLIM Assist Python runtime preparation is fixed, gated, isolated, and source-clean", async () => {
  const source = await readFile(MACOS_KHLIM_ASSIST_PYTHON_SCRIPT_PATH, "utf8")

  assert.match(source, /BASE_PYTHON="\/opt\/homebrew\/bin\/python3\.12"/u)
  assert.match(source, /SOURCE_REPO="\/Users\/richie\/khlim-assist"/u)
  assert.match(source, /RUNTIME_DIR="\$\{RUNTIME_ROOT\}\/khlim-assist-python3\.12"/u)
  assert.match(source, /PPO_MACOS_PYTHON_RUNTIME_CONFIRM/u)
  assert.match(source, /REQUIRED_CONFIRMATION="prepare-macos-khlim-assist-python-runtime-v1"/u)
  assert.match(source, /status --porcelain=v1 --untracked-files=all/u)
  assert.match(source, /archive --format=tar HEAD/u)
  assert.match(source, /-m venv "\$\{STAGING_DIR\}"/u)
  assert.match(source, /pip install "\$\{SOURCE_SNAPSHOT\}\[dev\]"/u)
  assert.match(source, /-m ruff --version/u)
  assert.match(source, /-m mypy --version/u)
  assert.match(source, /-m pytest --version/u)
  assert.match(source, /pytest\.__version__\.split/u)
  assert.doesNotMatch(source, /sudo|git\s+clone|git\s+pull|reset\s+--hard|--break-system-packages/u)
})

test("independent reviewer wrapper has valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", REVIEWER_PATH], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
})

test("macOS independent reviewer wrapper has valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", MACOS_REVIEWER_PATH], { encoding: "utf8" })

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

test("independent reviewer output schema pins the exact decision contract", async () => {
  const schema = JSON.parse(await readFile(REVIEW_OUTPUT_SCHEMA_PATH, "utf8"))
  const required = [
    "decision",
    "reviewedSha",
    "mergeAllowed",
    "blockers",
    "securityFindings",
    "testsRequired",
    "summary"
  ]

  assert.equal(schema.type, "object")
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, required)
  assert.deepEqual(Object.keys(schema.properties), required)
  assert.deepEqual(schema.properties.decision.enum, [
    "APPROVED",
    "CHANGES_REQUESTED",
    "OWNER_ACTION_REQUIRED"
  ])
  assert.equal(schema.properties.reviewedSha.pattern, "^[a-f0-9]{40}$")
  for (const field of ["blockers", "securityFindings", "testsRequired"]) {
    assert.equal(schema.properties[field].maxItems, MAX_REVIEW_FINDINGS)
    assert.equal(schema.properties[field].items.maxLength, MAX_REVIEW_FINDING_CHARS)
  }
  assert.equal(schema.properties.summary.maxLength, 500)
})

test("independent reviewer wrapper pins read-only non-interactive Codex", async () => {
  const source = await readFile(REVIEWER_PATH, "utf8")

  assert.match(source, /CODEX_BIN="\/home\/ppo\/\.local\/bin\/codex"/u)
  assert.match(source, /CODEX_MODEL="gpt-5\.6-sol"/u)
  assert.match(source, /REVIEW_OUTPUT_SCHEMA="\/opt\/personal-project-operator\/deployment\/phase6f-review-output\.schema\.json"/u)
  assert.match(source, /--output-schema "\$REVIEW_OUTPUT_SCHEMA"/u)
  assert.match(source, /\[\[ ! -r "\$REVIEW_OUTPUT_SCHEMA" \]\]/u)
  assert.match(source, /--sandbox read-only/u)
  assert.match(source, /--ask-for-approval never/u)
  const invocationStart = source.indexOf('exec "$CODEX_BIN"')
  const execSubcommand = source.indexOf("\n  exec ", invocationStart)

  assert.notEqual(invocationStart, -1)
  assert.notEqual(execSubcommand, -1)
  assert.ok(source.indexOf("--ask-for-approval never", invocationStart) < execSubcommand)
  assert.match(source, /--ignore-user-config/u)
  assert.match(source, /--ignore-rules/u)
  assert.doesNotMatch(source, /PROJECT_TRUST_OVERRIDE|trust_level/u)
  assert.match(source, /PPO_PHASE6K_REVIEW_POLICY/u)
  assert.doesNotMatch(source, /danger-full-access|yolo/u)
})

test("macOS independent reviewer wrapper pins local read-only non-interactive Codex", async () => {
  const source = await readFile(MACOS_REVIEWER_PATH, "utf8")

  assert.match(source, /CODEX_BIN="\/Users\/richie\/\.local\/bin\/codex"/u)
  assert.match(source, /CODEX_MODEL="gpt-5\.6-sol"/u)
  assert.match(source, /REVIEW_OUTPUT_SCHEMA="\/Users\/richie\/personal-project-operator\/deployment\/phase6f-review-output\.schema\.json"/u)
  assert.match(source, /WORKSPACE_ROOT="\/Users\/richie\/\.local\/share\/personal-project-operator\/development-workspaces"/u)
  assert.match(source, /--output-schema "\$REVIEW_OUTPUT_SCHEMA"/u)
  assert.match(source, /\[\[ ! -r "\$REVIEW_OUTPUT_SCHEMA" \]\]/u)
  assert.match(source, /--sandbox read-only/u)
  assert.match(source, /--ask-for-approval never/u)
  assert.match(source, /--ignore-user-config/u)
  assert.match(source, /--ignore-rules/u)
  assert.doesNotMatch(source, /PROJECT_TRUST_OVERRIDE|trust_level/u)
  assert.match(source, /PPO_PHASE6K_REVIEW_POLICY/u)
  assert.doesNotMatch(source, /\/home\/ppo|\/var\/lib\/personal-project-operator|danger-full-access|yolo/u)
})
