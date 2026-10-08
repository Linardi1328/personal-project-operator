#!/usr/bin/env node

import { lstat, readFile, realpath, symlink, unlink } from "node:fs/promises"
import { join, resolve as resolvePath } from "node:path"
import { spawn } from "node:child_process"

const PROJECTS = Object.freeze({
  kynexa: Object.freeze({
    sourceRoots: Object.freeze({
      darwin: "/Users/richie/kynexa",
      linux: "/var/lib/personal-project-operator/source-repos/kynexa"
    }),
    npmPaths: Object.freeze({
      darwin: "/opt/homebrew/bin/npm",
      linux: "/usr/bin/npm"
    }),
    gates: Object.freeze({
      lint: Object.freeze(["run", "lint"]),
      typecheck: Object.freeze(["run", "typecheck"]),
      test: Object.freeze(["test"]),
      build: Object.freeze(["run", "build"]),
      e2e: Object.freeze(["run", "test:e2e"])
    }),
    manifests: Object.freeze({
      "package.json": Object.freeze({
        lint: "eslint",
        typecheck: "next typegen && tsc --noEmit",
        test: "vitest run",
        build: "next build",
        "test:e2e": "playwright test"
      })
    })
  }),
  rivora: Object.freeze({
    sourceRoots: Object.freeze({
      darwin: "/Users/richie/rivora",
      linux: "/var/lib/personal-project-operator/source-repos/rivora"
    }),
    npmPaths: Object.freeze({
      darwin: "/opt/homebrew/bin/npm",
      linux: "/usr/bin/npm"
    }),
    gates: Object.freeze({
      build: Object.freeze(["run", "build"]),
      typecheck: Object.freeze(["run", "typecheck"]),
      test: Object.freeze(["run", "test:run"])
    }),
    manifests: Object.freeze({
      "package.json": Object.freeze({
        build: "npm run build --workspaces --if-present",
        typecheck: "npm run typecheck --workspaces --if-present",
        "test:run": "npm run test:run --workspaces --if-present"
      }),
      "apps/live-site/package.json": Object.freeze({
        build: "tsc -p tsconfig.lib.json && next build --webpack",
        typecheck: "tsc -p tsconfig.lib.json --noEmit && tsc -p tsconfig.test.json",
        "test:run": "vitest run"
      }),
      "apps/marketing-site/package.json": Object.freeze({
        build: "next build --webpack",
        typecheck: "tsc --noEmit",
        "test:run": "vitest run"
      }),
      "events/harbor-city-cup/package.json": Object.freeze({
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
        "test:run": "vitest run"
      }),
      "events/rivora-demo/package.json": Object.freeze({
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        "test:run": "vitest run"
      }),
      "packages/competition-engine/package.json": Object.freeze({
        prebuild: "npm run build -w @rivora/event-schema",
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        "test:run": "vitest run"
      }),
      "packages/event-schema/package.json": Object.freeze({
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        "test:run": "vitest run"
      }),
      "packages/ui/package.json": Object.freeze({
        prebuild: "npm run build -w @rivora/event-schema",
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
        "test:run": "vitest run"
      }),
      "services/organizer-sync/package.json": Object.freeze({
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        "test:run": "vitest run"
      })
    })
  })
})

function fail(message) {
  process.stderr.write(`Reviewed project quality runner failed: ${message}\n`)
  process.exit(2)
}

function platformKey() {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform
  fail("unsupported platform.")
}

async function readManifest(workspace, relativePath) {
  const path = join(workspace, relativePath)
  let raw
  try {
    raw = await readFile(path, "utf8")
  } catch {
    fail("reviewed package manifest is missing.")
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail("reviewed package manifest is malformed.")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.scripts || typeof parsed.scripts !== "object") {
    fail("reviewed package scripts are unavailable.")
  }

  return parsed.scripts
}

async function assertReviewedScripts(workspace, config) {
  for (const [relativePath, expectedScripts] of Object.entries(config.manifests)) {
    const scripts = await readManifest(workspace, relativePath)

    for (const [name, expected] of Object.entries(expectedScripts)) {
      if (scripts[name] !== expected) {
        fail("package script policy drift detected.")
      }
    }

    for (const target of Object.keys(config.gates)) {
      const lifecycle = target === "test" ? "test" : target
      for (const prefix of ["pre", "post"]) {
        const name = `${prefix}${lifecycle}`
        if (Object.hasOwn(scripts, name) && !Object.hasOwn(expectedScripts, name)) {
          fail("unreviewed package lifecycle hook detected.")
        }
      }
    }
  }
}

async function assertDirectory(path, label) {
  let stat
  try {
    stat = await lstat(path)
  } catch {
    fail(`${label} is unavailable.`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe.`)
}

async function run(executablePath, args, cwd, sourceRoot) {
  const env = {
    ...process.env,
    PATH: `${join(sourceRoot, "node_modules", ".bin")}:${process.env.PATH || "/usr/bin:/bin"}`,
    NODE_PATH: join(sourceRoot, "node_modules"),
    CI: "true",
    NEXT_TELEMETRY_DISABLED: "1"
  }

  const result = await new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd,
      env,
      shell: false,
      stdio: "inherit"
    })
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  }).catch(() => fail("reviewed quality command could not start."))

  if (result.signal || result.code !== 0) process.exit(typeof result.code === "number" ? result.code : 1)
}

async function main() {
  if (process.argv.length !== 4) fail("usage is <project> <gate>.")

  const projectId = process.argv[2]
  const gate = process.argv[3]
  const config = PROJECTS[projectId]
  if (!config || !Object.hasOwn(config.gates, gate)) fail("project or gate is not reviewed.")

  const platform = platformKey()
  const sourceRoot = config.sourceRoots[platform]
  const npmPath = config.npmPaths[platform]
  const workspace = await realpath(process.cwd()).catch(() => fail("workspace is unavailable."))

  if (!sourceRoot || !npmPath || workspace === sourceRoot || workspace.startsWith(`${sourceRoot}/`)) {
    fail("workspace identity is unsafe.")
  }

  await assertDirectory(sourceRoot, "source repository")
  await assertDirectory(join(sourceRoot, "node_modules"), "reviewed dependency tree")
  await assertReviewedScripts(workspace, config)

  const workspaceNodeModules = join(workspace, "node_modules")
  let createdLink = false
  try {
    try {
      await lstat(workspaceNodeModules)
      fail("workspace node_modules must not pre-exist.")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }

    await symlink(join(sourceRoot, "node_modules"), workspaceNodeModules, "dir")
    createdLink = true
    await run(npmPath, [...config.gates[gate]], workspace, sourceRoot)
  } finally {
    if (createdLink) await unlink(workspaceNodeModules).catch(() => {})
  }
}

await main()
