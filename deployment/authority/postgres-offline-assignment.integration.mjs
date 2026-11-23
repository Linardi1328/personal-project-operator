import assert from "node:assert/strict"
import { execFileSync, fork, spawn } from "node:child_process"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createIsolatedCanonicalRunState } from "../../local-operator/development-run-state.mjs"
import { ADMISSION_SQL, createCatalogCertifiedQuery } from "../../local-operator/development-catalog-certified-query.mjs"
import { createPostgresCanonicalAuthority } from "../../local-operator/development-postgres-canonical-authority.mjs"
import { remotePayloadDigest, signRemoteEnvelope } from "../../local-operator/software-factory-remote-contract.mjs"
import { linearIssueRevisionHash } from "../../local-operator/war-room-assignment-preflight.mjs"
import { admissionProfileSql } from "./phase1gd1-profile.mjs"
import { createPostgresTestSession } from "./postgres-test-session.mjs"
import { OFFLINE_ASSIGNMENT_SQL, createPostgresOfflineAssignmentBinder, createPostgresOfflineAssignmentObserver } from "./postgres-offline-assignment.mjs"

const container = process.env.PPO_ASSIGNMENT_TEST_CONTAINER_ID
if (process.env.CI !== "true" || !/^[a-f0-9]{64}$/u.test(container ?? "")) throw Error("Dedicated assignment test container required.")
const [details] = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))
if (details.Id !== container || !/^\/ppo-authority-ci-[0-9]+-[0-9]+-assignment$/u.test(details.Name) ||
    details.Config.Image !== "postgres:16" || details.HostConfig.NetworkMode !== "none" ||
    details.HostConfig.PublishAllPorts || Object.keys(details.HostConfig.PortBindings ?? {}).length ||
    details.Mounts.some(mount => mount.Type === "bind")) throw Error("Assignment test container failed isolation checks.")

const WRITER = "ppo_authority_writer"
const READER = "ppo_authority_reader"
const VERIFIER = "ppo_admission_verifier"
const BINDER = "ppo_offline_assignment_binder"
const COMMIT_RUN = "SELECT ppo_authority.commit_run($1::text,$2::integer,$3::text,$4::text) AS accepted"
const READ_RUN = "SELECT ppo_authority.read_run($1::text) AS record"
const READ_CATALOG = "SELECT ppo_authority.read_catalog_snapshot() AS snapshot"
const STATEMENTS = new Set([COMMIT_RUN, READ_RUN, READ_CATALOG, ...Object.values(ADMISSION_SQL), ...Object.values(OFFLINE_ASSIGNMENT_SQL)])
const BRANCH = "feature/disposable-assignment"
const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const CRASH_CHILD = "--ric194-assignment-writer"
const CRASH_SESSION = "ric194-crash-writer"
const FLAGS = { grant: false, canExecute: false, releaseAuthorized: false }
const ISSUE = Object.freeze({ identifier: "RIC-987194", title: "Synthetic database assignment",
  description: "Create a synthetic backend API endpoint.", updatedAt: "2026-11-01T00:00:00.000Z" })
const ISSUE_HASH = linearIssueRevisionHash(ISSUE)
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const keyHash = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex")
const mode = "disposable-postgres-offline-assignment"
const now = () => new Date()
const randomHex = bytes => randomBytes(bytes).toString("hex")
const literal = value => value === null ? "NULL" : Number.isSafeInteger(value) ? String(value) :
  "convert_from(decode('" + Buffer.from(value, "utf8").toString("base64") + "','base64'),'UTF8')"

function session(role = "postgres", name = "assignment-test") {
  assert.ok(["postgres", WRITER, READER, VERIFIER, BINDER].includes(role))
  const child = spawn("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", "ppo_authority_ci"], { stdio: ["pipe", "pipe", "pipe"] })
  const client = createPostgresTestSession(child, { timeoutMs: 60000, maxStdoutBytes: 70 * 1024 * 1024 })
  return {
    ...client, name,
    ready: async () => Number(await client.send("\\set VERBOSITY verbose\n" +
      "SET application_name=" + "'" + name + "'; SET statement_timeout='20s'; " +
      "SET idle_in_transaction_session_timeout='20s'; SET ROLE " + role + "; SELECT pg_backend_pid();"))
  }
}

async function sql(statement, role) {
  const client = session(role)
  try {
    await client.ready()
    return await client.send(statement)
  } finally { await client.close() }
}

function statementFor(statement, args) {
  assert.ok(STATEMENTS.has(statement))
  return "SELECT row_to_json(q) FROM (" + statement.replace(/\$([1-7])/gu, (_, index) =>
    literal(args[Number(index) - 1])) + ") q;"
}

async function crashWriter() {
  const [args] = await once(process, "message")
  const writer = session(BINDER, CRASH_SESSION)
  try {
    const pid = await writer.ready()
    const reply = JSON.parse(await writer.send("BEGIN; SET LOCAL idle_in_transaction_session_timeout='5s';" +
      statementFor(OFFLINE_ASSIGNMENT_SQL.bind, args)))
    process.send({ pid, accepted: reply.accepted })
    // The parent kills this owned transport before sending a commit message.
    await once(process, "message")
    await writer.send("COMMIT;")
  } finally { await writer.close() }
}
const result = output => ({ rows: [JSON.parse(output)] })
const query = role => async (statement, args) => result(await sql(statementFor(statement, args), role))
const profile = name => readFile(new URL("./" + name + ".sql", import.meta.url), "utf8")

function assignment(run, changes = {}) {
  const time = Date.now()
  return signRemoteEnvelope({
    kind: "dispatch-request", schemaVersion: 1, runId: run.runId, expectedVersion: run.version,
    projectId: run.project.id, branch: BRANCH, baseSha: BASE, headSha: HEAD,
    requestId: randomHex(16), nonce: randomHex(16), idempotencyKey: randomHex(32),
    capability: "implementation.backend", workerId: "codex",
    taskSource: { kind: "linear-issue", issueId: ISSUE.identifier, revisionHash: ISSUE_HASH },
    scope: { mode: "implementation", allowedPaths: ["src/"], permits: ["workspace.read"] },
    approval: { ownerId: "fixture-owner", approvalId: randomHex(16), approvedAt: new Date(time - 2000).toISOString() },
    issuedAt: new Date(time - 1000).toISOString(), expiresAt: new Date(time + 120000).toISOString(),
    maxDurationMs: 1000, ...changes
  }, "ppo-control-plane", privateKey)
}

async function waitForBlock(waiter, leader) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const blocked = await sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity l " +
      "ON l.pid=ANY(pg_blocking_pids(w.pid)) WHERE w.application_name=" + literal(waiter.name) +
      " AND l.application_name=" + literal(leader.name) + ");")
    if (blocked === "t") return
  }
  assert.fail("Expected server-observed gate contention")
}

if (process.argv[2] === CRASH_CHILD && typeof process.send === "function") {
  await crashWriter()
} else test("RIC-194 disposable PostgreSQL assignment authority", { timeout: 220000 }, async t => {
  for (const name of ["phase1gb2-canonical-postgres", "phase1gb2-synthetic-import", "phase1gb2-canonical-catalog"]) {
    await sql(await profile(name))
  }
  await sql(await admissionProfileSql())
  const authorityId = await sql("SELECT id FROM ppo_authority.admission_identity;")
  const readerQuery = query(READER)
  const verifierQuery = query(VERIFIER)
  const approved = new Set()
  const config = { mode, authorityId, coordinatorPublicKey: publicKey, readerQuery, verifierQuery,
    commitQuery: query(BINDER), approvedProjects: ["rivora", "kynexa"], now,
    readIssue: () => ISSUE, resolveIssueProject: () => "rivora",
    readRepo: projectId => ({ projectId, branch: BRANCH, baseSha: BASE, headSha: HEAD,
      reviewedCanonicalPath: true, isolatedWorktree: true }),
    verifyOwnerApproval: context => approved.has(context.requestHash) }
  const canonical = createPostgresCanonicalAuthority({ mode: "isolated-postgres-canonical-authority",
    query: createCatalogCertifiedQuery({ mode: "isolated-catalog-certified-authority", query: query(WRITER), verifierQuery }) })
  const state = createIsolatedCanonicalRunState({ mode: "isolated-postgres-canonical-authority", authority: canonical, now })
  const read = id => state.read(id)
  const change = (run, status, changes = {}) =>
    state.transition(run.runId, { expectedVersion: run.version, status, actor: "assignment-test", ...changes })
  const cancel = async run => change(await read(run.runId), "cancelled")
  async function seed(projectId = "rivora") {
    let run = await state.create({ projectId, task: "RIC-157 shared authority synthetic: RIC-194 backend assignment",
      baseSha: BASE, headSha: HEAD, branch: BRANCH })
    for (const status of ["planning_in_progress", "planned", "implementation_in_progress"]) run = await change(run, status)
    return run
  }
  const approve = signed => { approved.add(remotePayloadDigest(signed.payload)); return signed }
  const bind = (signed, overrides = {}) => createPostgresOfflineAssignmentBinder({
    ...config, resolveIssueProject: () => signed.payload.projectId, ...overrides
  })(signed)
  const observe = signed => createPostgresOfflineAssignmentObserver({ mode, authorityId, coordinatorPublicKey: publicKey, readerQuery: query(READER) })(signed)
  const count = () => sql("SELECT count(*) FROM ppo_authority.offline_assignment_reservations;")
  async function assertUnchanged(run, signed, total) {
    assert.deepEqual(await read(run.runId), run)
    assert.equal((await observe(signed)).outcome, "unobserved")
    assert.equal(await count(), total)
  }

  await t.test("RED ordinary D1 candidate publishes without a reservation; GREEN same writer is denied and atomic binder commits", async subtest => {
    const run = await seed()
    const signed = approve(assignment(run))
    let args
    await assert.rejects(bind(signed, { commitQuery: async (_statement, values) => {
      args = values
      return { rows: [{ accepted: false }] }
    } }), { code: "OFFLINE_ASSIGNMENT_DENIED" })
    const raw = statementFor(COMMIT_RUN, [run.runId, 3, args[5], args[6]])
    assert.equal(JSON.parse(await sql("BEGIN;" + raw + "ROLLBACK;", WRITER)).accepted, true)
    assert.deepEqual(await read(run.runId), run)

    await sql(await profile("postgres-offline-assignment"))
    await sql("INSERT INTO ppo_authority.offline_assignment_policy VALUES (true," + literal(keyHash) + ");")
    await assert.rejects(sql(raw, WRITER), /42501: offline assignment reservation required/u)
    await assert.rejects(query(READER)(OFFLINE_ASSIGNMENT_SQL.bind, args), /42501/u)
    await assert.rejects(query(BINDER)(COMMIT_RUN, [run.runId, 3, args[5], args[6]]), /42501/u)
    await assert.rejects(query(BINDER)(ADMISSION_SQL.certify, ["a".repeat(64)]), /42501/u)
    await assert.rejects(sql("SELECT count(*) FROM ppo_authority.offline_assignment_reservations;", BINDER), /42501/u)
    assert.equal(await count(), "0")
    const receipt = await bind(signed)
    assert.deepEqual(receipt, { outcome: "bound-offline", runId: run.runId, expectedVersion: 3,
      version: 4, requestHash: remotePayloadDigest(signed.payload), historyHash: (await read(run.runId)).historyHash, ...FLAGS })
    assert.deepEqual(await observe(signed), receipt)
    assert.equal(await count(), "1")
    subtest.diagnostic("the same D1-certified v3 → v4 candidate succeeded before the profile and failed with 42501 after installation")
    await assert.rejects(bind(signed), { code: "PREFLIGHT_RUN_STALE" })
    await cancel(run)
  })

  await t.test("signed scope, approval and stale version or refs fail before final submission", async () => {
    const run = await seed()
    const signed = approve(assignment(run))
    const altered = structuredClone(signed)
    altered.payload.scope.allowedPaths = ["other/"]
    const denied = [
      [altered, "OFFLINE_ASSIGNMENT_SIGNATURE_INVALID"],
      [assignment(run), "PREFLIGHT_APPROVAL_REQUIRED"],
      [approve(assignment(run, { headSha: "d".repeat(40) })), "PREFLIGHT_RUN_STALE"],
      [approve(assignment(run, { expectedVersion: 2 })), "PREFLIGHT_RUN_STALE"]
    ]
    for (const [request, code] of denied) {
      await assert.rejects(bind(request, { commitQuery: () => assert.fail("Unexpected bind submission") }), { code })
    }
    await assertUnchanged(run, signed, "1")
    await cancel(run)
  })

  await t.test("source identity and exact D1 certificate are checked by the write transaction", async () => {
    const run = await seed()
    const first = approve(assignment(run))
    // A transport that claims to certify without writing the actual token
    // cannot substitute for D1 at the PostgreSQL publication boundary.
    await assert.rejects(bind(first, { verifierQuery: async () => ({ rows: [{ certified: true }] }) }),
      { code: "OFFLINE_ASSIGNMENT_DENIED" })
    await assertUnchanged(run, first, "1")
    await assert.rejects(bind(first, { authorityId: "00000000-0000-0000-0000-000000000000" }),
      { code: "OFFLINE_ASSIGNMENT_DENIED" })
    for (const [index, value] of [[1, "another-signer"], [2, "0".repeat(64)], [4, '{"mode":"implementation"}']]) {
      await assert.rejects(bind(first, { commitQuery: (statement, args) =>
        query(BINDER)(statement, args.with(index, value)) }), { code: "OFFLINE_ASSIGNMENT_DENIED" })
    }
    const second = approve(assignment(run))
    await assert.rejects(bind(second, { commitQuery: async (statement, args) => {
      // An unrelated mutation after certification invalidates the old catalog token.
      const unrelated = await seed("kynexa")
      await cancel(unrelated)
      return query(BINDER)(statement, args)
    } }), { code: "OFFLINE_ASSIGNMENT_DENIED" })
    await assertUnchanged(run, second, "1")
    await cancel(run)
  })

  await t.test("standalone profile refuses gateway or ownership installation and runtime routing", async () => {
    const run = await seed()
    const signed = approve(assignment(run))
    try {
      for (const table of ["ppo_authority.gateway_profile", "ppo_authority.rehearsal_owner"]) {
        await sql("BEGIN; SET LOCAL ROLE ppo_authority_owner; CREATE TABLE " + table + " (fixture boolean); COMMIT;")
        try {
          await assert.rejects(sql(await profile("postgres-offline-assignment")), /standalone disposable D1 authority required/u)
          await assert.rejects(bind(signed), { code: "OFFLINE_ASSIGNMENT_DENIED" })
          await assert.rejects(observe(signed), { code: "OFFLINE_ASSIGNMENT_OBSERVATION_UNAVAILABLE" })
          assert.deepEqual(await read(run.runId), run)
          assert.equal(await count(), "1")
        } finally { await sql("DROP TABLE " + table + ";") }
      }
    } finally { await cancel(run) }
  })

  async function contend(first, second) {
    const leader = session(BINDER, "assignment-race-leader")
    const waiter = session(BINDER, "assignment-race-waiter")
    try {
      await leader.ready()
      await waiter.ready()
      let staged
      let resume
      const tentative = new Promise(resolve => { staged = resolve })
      const release = new Promise(resolve => { resume = resolve })
      const firstResult = bind(first, { commitQuery: async (statement, args) => {
        const reply = result(await leader.send("BEGIN;" + statementFor(statement, args)))
        staged()
        await release
        await leader.send("COMMIT;")
        return reply
      } })
      await Promise.race([tentative, firstResult])
      assert.equal((await observe(first)).outcome, "unobserved")
      const secondResult = bind(second, { commitQuery: async (statement, args) =>
        result(await waiter.send(statementFor(statement, args))) })
      const completion = Promise.allSettled([firstResult, secondResult])
      try { await waitForBlock(waiter, leader) } finally { resume() }
      const [won, lost] = await completion
      assert.equal(won.status, "fulfilled")
      assert.equal(lost.status, "rejected")
      assert.equal(lost.reason.code, "OFFLINE_ASSIGNMENT_DENIED")
      assert.deepEqual(await observe(first), won.value)
      assert.equal((await observe(second)).outcome, "unobserved")
    } finally {
      await leader.close()
      await waiter.close()
    }
  }

  await t.test("two writers for one run version yield exactly one committed binding", async () => {
    const run = await seed()
    await contend(approve(assignment(run)), approve(assignment(run)))
    assert.equal(await count(), "2")
    assert.equal((await read(run.runId)).version, 4)
    await cancel(run)
  })

  await t.test("cross-run replay contention and independently repeated IDs, nonces and approvals are denied", async () => {
    const first = await seed()
    const second = await seed("kynexa")
    const original = approve(assignment(first))
    await contend(original, approve(assignment(second, { nonce: original.payload.nonce })))
    for (const key of ["requestId", "nonce", "idempotencyKey", "approval"]) {
      const duplicate = approve(assignment(second, { [key]: original.payload[key] }))
      await assert.rejects(bind(duplicate), { code: "OFFLINE_ASSIGNMENT_DENIED" })
      await assertUnchanged(second, duplicate, "3")
    }
    await cancel(first)
    await cancel(second)
  })

  await t.test("a native error after reservation insertion rolls back both writes and replay keys", async () => {
    const run = await seed()
    const signed = approve(assignment(run))
    await sql(`
      CREATE FUNCTION ppo_authority.assignment_test_fault() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM ppo_authority.offline_assignment_reservations
          WHERE run_id=NEW.run_id AND expected_version=NEW.version-1)
        THEN RAISE EXCEPTION 'expected prior reservation insert' USING ERRCODE='P1943'; END IF;
        RAISE EXCEPTION 'injected canonical insert failure' USING ERRCODE='P1942';
      END $body$;
      CREATE TRIGGER assignment_test_fault BEFORE INSERT ON ppo_authority.run_versions
        FOR EACH ROW EXECUTE FUNCTION ppo_authority.assignment_test_fault();
    `)
    let nativeError
    try {
      await assert.rejects(bind(signed, { commitQuery: async (statement, args) => {
        try { return await query(BINDER)(statement, args) } catch (error) { nativeError = error; throw error }
      } }), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN" })
      assert.match(nativeError.message, /P1942/u)
      await assertUnchanged(run, signed, "3")
    } finally {
      await sql("DROP TRIGGER assignment_test_fault ON ppo_authority.run_versions; DROP FUNCTION ppo_authority.assignment_test_fault();")
    }
    await cancel(run)
  })

  await t.test("authorization that expires between native statement and COMMIT rolls back the complete transaction", async () => {
    const run = await seed()
    const expiresAt = new Date(Date.now() + 8000).toISOString()
    const signed = approve(assignment(run, { expiresAt }))
    const writer = session(BINDER, "assignment-expiring-writer")
    let nativeError
    try {
      await writer.ready()
      await assert.rejects(bind(signed, { commitQuery: async (statement, args) => {
        const reply = result(await writer.send("BEGIN;" + statementFor(statement, args)))
        assert.equal(reply.rows[0].accepted, true)
        assert.equal((await observe(signed)).outcome, "unobserved")
        await writer.send("SELECT pg_sleep(greatest(0,extract(epoch FROM (" + literal(expiresAt) +
          "::timestamptz-clock_timestamp())))::double precision+0.05);")
        try { await writer.send("COMMIT;") } catch (error) { nativeError = error; throw error }
        return reply
      } }), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN" })
      assert.match(nativeError.message, /P1941/u)
      await assertUnchanged(run, signed, "3")
    } finally { await writer.close() }
    await cancel(run)
  })

  await t.test("termination of the writer backend before commit leaves no binding", async () => {
    const run = await seed()
    const signed = approve(assignment(run))
    const writer = session(BINDER, "assignment-terminated-writer")
    let terminated = false
    try {
      const pid = await writer.ready()
      assert.ok(Number.isSafeInteger(pid) && pid > 0)
      await assert.rejects(bind(signed, { commitQuery: async (statement, args) => {
        const reply = result(await writer.send("BEGIN;" + statementFor(statement, args)))
        assert.equal(reply.rows[0].accepted, true)
        assert.equal((await observe(signed)).outcome, "unobserved")
        assert.equal(await sql("SELECT pg_terminate_backend(" + pid + ",5000);"), "t")
        terminated = true
        await writer.send("COMMIT;")
        return reply
      } }), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN" })
      assert.equal(terminated, true)
      await assertUnchanged(run, signed, "3")
    } finally { await writer.close() }
    await cancel(run)
  })

  await t.test("SIGKILL of the writer transport before commit leaves no binding", async () => {
    const run = await seed()
    const signed = approve(assignment(run))
    const child = fork(fileURLToPath(import.meta.url), [CRASH_CHILD], {
      execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"]
    })
    const closed = once(child, "close")
    let verifiedDeath = false
    try {
      await assert.rejects(bind(signed, { commitQuery: async (statement, args) => {
        assert.equal(statement, OFFLINE_ASSIGNMENT_SQL.bind)
        const message = Promise.race([
          once(child, "message", { signal: AbortSignal.timeout(10000) }),
          closed.then(() => assert.fail("Writer exited before the tentative statement"))
        ])
        child.send(args)
        const [{ pid, accepted }] = await message
        assert.ok(Number.isSafeInteger(pid) && pid > 0)
        assert.equal(accepted, true)
        assert.equal((await observe(signed)).outcome, "unobserved")
        assert.equal(child.kill("SIGKILL"), true)
        assert.deepEqual(await closed, [null, "SIGKILL"])
        const deadline = Date.now() + 10000
        while (await sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=" + pid + " AND application_name='" + CRASH_SESSION + "');") === "t") {
          assert.ok(Date.now() < deadline, "Uncommitted backend survived the writer and its idle limit")
        }
        verifiedDeath = true
        throw Error("Writer died before acknowledging commit")
      } }), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN" })
      assert.equal(verifiedDeath, true)
      await assertUnchanged(run, signed, "3")
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await closed
    }
    await cancel(run)
  })

  await t.test("backend unavailable and lost acknowledgment stay unknown; independent reader reconciles after server restart", async () => {
    const unavailableRun = await seed()
    const first = approve(assignment(unavailableRun))
    const unavailable = session(BINDER)
    await unavailable.ready()
    await unavailable.close()
    let submissions = 0
    await assert.rejects(bind(first, { commitQuery: async (statement, args) => {
      submissions++
      return result(await unavailable.send(statementFor(statement, args)))
    } }), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN" })
    assert.equal(submissions, 1)
    await assertUnchanged(unavailableRun, first, "3")
    await cancel(unavailableRun)

    // A separate run supplies the lost-acknowledgment scenario.
    const run = await seed()
    const second = approve(assignment(run))
    await assert.rejects(bind(second, { commitQuery: async (statement, args) => {
      submissions++
      const reply = await query(BINDER)(statement, args)
      assert.equal(reply.rows[0].accepted, true)
      throw Error("synthetic transport lost committed acknowledgment")
    } }), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN", observation: {
      runId: run.runId, expectedVersion: 3, requestHash: remotePayloadDigest(second.payload)
    } })
    assert.equal(submissions, 2)
    execFileSync("docker", ["restart", container], { stdio: "ignore" })
    const deadline = Date.now() + 10000
    while (true) {
      try { await sql("SELECT 1;"); break } catch (error) {
        if (Date.now() >= deadline) throw error
      }
    }
    const receipt = await observe(second)
    assert.equal(receipt.outcome, "bound-offline")
    assert.equal(receipt.historyHash, (await read(run.runId)).historyHash)
    assert.equal(await count(), "4")
    assert.equal((await observe(first)).outcome, "unobserved")
    await assert.rejects(bind(second), { code: "PREFLIGHT_RUN_STALE" })
    await cancel(run)
  })

  await t.test("incomplete, invalid and over-capacity catalogs refuse assignment", async () => {
    const run = await seed()
    const unrelated = await seed("kynexa")
    await cancel(unrelated)
    const signed = approve(assignment(run))
    const source = await sql("SELECT record::text FROM ppo_authority.run_versions WHERE run_id=" +
      literal(unrelated.runId) + " AND version=0;")
    const filter = " WHERE run_id=" + literal(unrelated.runId) + " AND version=0;"
    const table = "ppo_authority.run_versions"
    async function editVersions(statement) {
      await sql("BEGIN; SET CONSTRAINTS ALL IMMEDIATE; ALTER TABLE " + table + " DISABLE TRIGGER immutable_versions;" + statement +
        "ALTER TABLE " + table + " ENABLE TRIGGER immutable_versions; COMMIT;")
    }
    async function denyCatalog(code) {
      assert.equal((await query(READER)(READ_CATALOG, [])).rows[0].snapshot.code, code)
      await assert.rejects(bind(signed, { commitQuery: () => assert.fail("Unexpected bind submission") }), { code: "PREFLIGHT_CATALOG_BLOCKED" })
      await assertUnchanged(run, signed, "4")
    }
    await editVersions("UPDATE " + table + " SET record=jsonb_set(record,'{history,0,actor}','false'::jsonb)" + filter)
    try { await denyCatalog("ok") } finally {
      await editVersions("UPDATE " + table + " SET record=" + literal(source) + "::jsonb" + filter)
    }
    await editVersions("DELETE FROM " + table + filter)
    try { await denyCatalog("ok") } finally {
      await sql("INSERT INTO " + table + " VALUES(" + [unrelated.runId, 0, JSON.parse(source).historyHash, source].map(literal).join(",") + "::jsonb);")
    }
    const duplicate = literal("W".repeat(43))
    await sql("INSERT INTO " + table + " SELECT " + duplicate + ",version,history_hash,jsonb_set(record,'{runId}',to_jsonb(" +
      duplicate + ")) FROM " + table + " WHERE run_id=" + literal(run.runId) + ";")
    try { await denyCatalog("ok") } finally {
      await editVersions("DELETE FROM " + table + " WHERE run_id=" + duplicate + ";")
    }
    await sql("INSERT INTO " + table + " SELECT id,0,source->>'historyHash',jsonb_set(source,'{runId}',to_jsonb(id)) " +
      "FROM (SELECT repeat('Z',40)||lpad(i::text,3,'0') AS id," + literal(source) + "::jsonb AS source FROM generate_series(1,21) i) f;")
    try { await denyCatalog("catalog_truncated") } finally {
      await editVersions("DELETE FROM " + table + " WHERE run_id LIKE '" + "Z".repeat(40) + "%';")
    }
  })
})
