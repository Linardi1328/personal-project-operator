import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_HASH,
  SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS,
  SOFTWARE_FACTORY_RELEASE_REQUEST_ID_PATTERN,
  confirmSoftwareFactoryReleaseApproval,
  formatSoftwareFactoryReleaseApproval,
  stageSoftwareFactoryReleaseApproval
} from "./software-factory-release-approval.mjs"

const RUN_ID = "A".repeat(43)
const HEAD_SHA = "a".repeat(40)
const PACKAGE_HASH = "b".repeat(64)

function packageFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "software_factory_release_candidate",
    packageHash: PACKAGE_HASH,
    run: {
      runId: RUN_ID,
      version: 17,
      status: "merge_ready",
      projectId: "khlim-digital-ecosystem",
      repository: "Linardi1328/khlim-digital-ecosystem",
      task: "Fix the approved blocker.",
      branch: "ppo/khlim-digital-ecosystem/implementation/release",
      headSha: HEAD_SHA
    },
    implementation: {},
    tests: {},
    localReview: {},
    remoteReview: {},
    ci: {},
    delivery: {
      prNumber: 42,
      approvedMergeMethod: "squash"
    },
    authority: {
      merge: "owner_approval_required",
      productionDeployment: "not_authorized"
    },
    ...overrides
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ppo-release-approval-"))
  return {
    writeDataDir: join(root, "write-data"),
    packageValue: packageFixture()
  }
}

function deterministicRandom() {
  return Buffer.alloc(32, 7)
}

test("stage creates a bounded single-use request and never merges", async () => {
  const f = await fixture()
  let merges = 0

  const result = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    async buildReleasePackage(runId) {
      assert.equal(runId, RUN_ID)
      return f.packageValue
    },
    async executeMerge() {
      merges += 1
      throw new Error("stage must not merge")
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "release_approval_staged")
  assert.match(result.requestId, SOFTWARE_FACTORY_RELEASE_REQUEST_ID_PATTERN)
  assert.equal(result.runVersion, 17)
  assert.equal(result.headSha, HEAD_SHA)
  assert.equal(result.prNumber, 42)
  assert.equal(result.packageHash, PACKAGE_HASH)
  assert.equal(result.mergeMethod, "squash")
  assert.equal(
    Date.parse(result.expiresAt) - Date.parse(result.createdAt),
    SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS
  )
  assert.equal(merges, 0)
})

test("confirmation rebuilds the same package and passes only the bound run version to SHA-pinned merge", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })
  let mergeCalls = 0

  const confirmed = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:01:00.000Z"),
    buildReleasePackage: async () => structuredClone(f.packageValue),
    async executeMerge(runId, options) {
      mergeCalls += 1
      assert.equal(runId, RUN_ID)
      assert.equal(options.expectedVersion, 17)
      return {
        ok: true,
        outcome: "merged",
        merge: {
          mergeCommitSha: "c".repeat(40),
          mainSha: "c".repeat(40)
        }
      }
    }
  })

  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.outcome, "release_merged")
  assert.equal(confirmed.packageHash, PACKAGE_HASH)
  assert.equal(confirmed.mergeMethod, "squash")
  assert.equal(confirmed.mergeCommitSha, "c".repeat(40))
  assert.equal(mergeCalls, 1)
})

test("changed release package consumes approval and refuses merge", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })
  let merges = 0

  const changed = packageFixture({
    packageHash: "d".repeat(64)
  })
  const confirmed = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:01:00.000Z"),
    buildReleasePackage: async () => changed,
    async executeMerge() {
      merges += 1
    }
  })

  assert.equal(confirmed.ok, false)
  assert.equal(confirmed.code, "RELEASE_APPROVAL_STALE")
  assert.equal(merges, 0)

  const replay = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:01:30.000Z"),
    buildReleasePackage: async () => f.packageValue
  })

  assert.equal(replay.ok, false)
  assert.equal(replay.code, "RELEASE_REQUEST_ALREADY_CONSUMED")
})

test("expired release approval is consumed and cannot merge", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })
  let merges = 0

  const result = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:11:00.000Z"),
    buildReleasePackage: async () => f.packageValue,
    async executeMerge() {
      merges += 1
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, "RELEASE_REQUEST_EXPIRED")
  assert.equal(merges, 0)
})

test("concurrent confirmation is single-use and performs exactly one merge", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })
  let mergeCalls = 0

  const options = {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:01:00.000Z"),
    buildReleasePackage: async () => structuredClone(f.packageValue),
    async executeMerge() {
      mergeCalls += 1
      return {
        ok: true,
        outcome: "merged",
        merge: {
          mergeCommitSha: "e".repeat(40),
          mainSha: "e".repeat(40)
        }
      }
    }
  }

  const results = await Promise.all([
    confirmSoftwareFactoryReleaseApproval(staged.requestId, options),
    confirmSoftwareFactoryReleaseApproval(staged.requestId, options)
  ])

  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.filter((result) => result.code === "RELEASE_REQUEST_ALREADY_CONSUMED").length, 1)
  assert.equal(mergeCalls, 1)
})

test("confirmation refuses changes to any immutable release binding", async () => {
  const mutations = [
    (value) => { value.run.version += 1 },
    (value) => { value.run.projectId = "rbl-content-engine" },
    (value) => { value.run.headSha = "f".repeat(40) },
    (value) => { value.delivery.prNumber = 43 },
    (value) => { value.delivery.approvedMergeMethod = "merge" },
    (value) => { value.packageHash = "1".repeat(64) }
  ]

  for (const mutate of mutations) {
    const f = await fixture()
    const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
      writeDataDir: f.writeDataDir,
      randomBytesImpl: deterministicRandom,
      now: () => new Date("2026-10-08T04:00:00.000Z"),
      buildReleasePackage: async () => f.packageValue
    })
    const changed = structuredClone(f.packageValue)
    mutate(changed)

    const result = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
      writeDataDir: f.writeDataDir,
      now: () => new Date("2026-10-08T04:01:00.000Z"),
      buildReleasePackage: async () => changed,
      executeMerge: async () => {
        throw new Error("stale approval must never merge")
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.code, "RELEASE_APPROVAL_STALE")
  }
})

test("formatter exposes only bounded approval metadata and explicit no-production authority", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })

  const output = formatSoftwareFactoryReleaseApproval(staged)

  assert.match(output, /PPO Software Factory Release/u)
  assert.match(output, /Pull request: #42/u)
  assert.match(output, /Confirm: \/ppo release-confirm/u)
  assert.doesNotMatch(output, /Fix the approved blocker/u)
})

test("release approval policy hash is deterministic SHA-256", () => {
  assert.match(SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_HASH, /^[a-f0-9]{64}$/u)
})


test("staging refuses malformed trusted-builder output before persistence", async () => {
  const f = await fixture()
  const malformed = structuredClone(f.packageValue)
  malformed.run.version = 0

  const result = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => malformed
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, "RELEASE_REQUEST_INVALID")
})


test("successful release pumps at most one queued objective and returns bounded pump metadata", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })
  let drains = 0

  const result = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:01:00.000Z"),
    buildReleasePackage: async () => structuredClone(f.packageValue),
    executeMerge: async () => ({
      ok: true,
      outcome: "merged",
      merge: {
        mergeCommitSha: "7".repeat(40),
        mainSha: "7".repeat(40)
      }
    }),
    async drainQueue() {
      drains += 1
      return {
        ok: false,
        outcome: "blocked_capacity",
        queueId: "Q".repeat(32),
        runId: "R".repeat(43),
        reason: "worker_capacity_exhausted",
        ignored: "must not leak"
      }
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "release_merged")
  assert.equal(drains, 1)
  assert.deepEqual(result.queuePump, {
    ok: false,
    outcome: "blocked_capacity",
    queueId: "Q".repeat(32),
    runId: "R".repeat(43),
    reason: "worker_capacity_exhausted"
  })
})

test("queue pump failure never retroactively changes a committed release merge", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })

  const result = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:01:00.000Z"),
    buildReleasePackage: async () => structuredClone(f.packageValue),
    executeMerge: async () => ({
      ok: true,
      outcome: "merged",
      merge: {
        mergeCommitSha: "8".repeat(40),
        mainSha: "8".repeat(40)
      }
    }),
    async drainQueue() {
      throw new Error("simulated queue failure")
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "release_merged")
  assert.equal(result.mergeCommitSha, "8".repeat(40))
  assert.deepEqual(result.queuePump, {
    ok: false,
    outcome: "queue_pump_unavailable",
    queueId: null,
    runId: null,
    reason: "post_merge_queue_pump_failed"
  })
})

test("stale release approval does not pump the objective queue", async () => {
  const f = await fixture()
  const staged = await stageSoftwareFactoryReleaseApproval(RUN_ID, {
    writeDataDir: f.writeDataDir,
    randomBytesImpl: deterministicRandom,
    now: () => new Date("2026-10-08T04:00:00.000Z"),
    buildReleasePackage: async () => f.packageValue
  })
  let drains = 0
  const changed = packageFixture({ packageHash: "9".repeat(64) })

  const result = await confirmSoftwareFactoryReleaseApproval(staged.requestId, {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T04:01:00.000Z"),
    buildReleasePackage: async () => changed,
    executeMerge: async () => {
      throw new Error("stale release must not merge")
    },
    async drainQueue() {
      drains += 1
      return { ok: true, outcome: "queue_empty" }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, "RELEASE_APPROVAL_STALE")
  assert.equal(drains, 0)
})
