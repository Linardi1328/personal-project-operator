import assert from "node:assert/strict"
import childProcess, { execFileSync, fork, spawn } from "node:child_process"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createIsolatedCanonicalRunState } from "../../local-operator/development-run-state.mjs"
import { ADMISSION_SQL, createCatalogCertifiedQuery } from "../../local-operator/development-catalog-certified-query.mjs"
import { createPostgresCanonicalAuthority } from "../../local-operator/development-postgres-canonical-authority.mjs"
import { rehearseSyntheticMigrationPreflight } from "../../local-operator/development-migration-preflight.mjs"
import { remotePayloadDigest, signRemoteEnvelope } from "../../local-operator/software-factory-remote-contract.mjs"
import { linearIssueRevisionHash } from "../../local-operator/war-room-assignment-preflight.mjs"
import { admissionProfileSql } from "./phase1gd1-profile.mjs"
import { createPostgresTestSession } from "./postgres-test-session.mjs"
import { createPostgresOfflineAssignmentBinder, createPostgresOfflineAssignmentObserver, createPostgresOfflineAssignmentPreparer } from "./postgres-offline-assignment.mjs"
import { assertDisposableAssignmentContainer, OFFLINE_ASSIGNMENT_SQL } from "./postgres-offline-assignment-transport.mjs"

const container = process.env.PPO_ASSIGNMENT_TEST_CONTAINER_ID
if (process.env.CI !== "true" || !/^[a-f0-9]{64}$/u.test(container ?? "")) throw Error("Dedicated assignment test container required.")
assertDisposableAssignmentContainer(container)

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
    const reply = JSON.parse(await writer.send("BEGIN; SET LOCAL idle_in_transaction_session_timeout='20s';" +
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

// Drop only the fixed binder session, either before its statement is sent
// or after psql has printed its post-commit completion marker. The default
// lab binder still owns its session and the test does not replace its writer.
async function withTransportLoss(afterCommit, operation) {
  const originalSpawn = childProcess.spawn
  let witnessed = false
  let submissions = 0
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args)
    const upstream = child.stdout
    const forwarded = new PassThrough()
    child.stdout = forwarded
    const write = child.stdin.write.bind(child.stdin)
    let marker
    let dropped = ""
    child.stdin.write = (data, ...rest) => {
      if (typeof data === "string" && data.includes("ppo_authority.bind_offline_assignment(")) {
        submissions++
        marker = /\\echo (PPO_CI_[0-9a-f]+_END)/u.exec(data)?.[1]
        assert.ok(marker)
        if (!afterCommit) {
          witnessed = true
          child.kill("SIGKILL")
          return false
        }
      }
      return write(data, ...rest)
    }
    upstream.setEncoding("utf8")
    upstream.on("data", chunk => {
      if (!marker) {
        forwarded.write(chunk)
      } else if (afterCommit) {
        dropped += chunk
        if (dropped.includes(marker)) {
          witnessed = true
          child.kill("SIGKILL")
        }
      }
    })
    upstream.on("end", () => forwarded.end())
    return child
  }
  syncBuiltinESMExports()
  try { await operation() } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
  assert.equal(witnessed, true)
  assert.equal(submissions, 1)
}

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
  // PostgreSQL reports the wait on the leader's transaction ID. The waiter's
  // tuple lock identifies the actual relation instead of the nonce index.
  while (Date.now() < deadline) {
    const blocked = await sql(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity l ON l.pid=ANY(pg_blocking_pids(w.pid))
        JOIN pg_locks waiting ON waiting.pid=w.pid AND waiting.locktype='transactionid' AND NOT waiting.granted
        JOIN pg_locks held ON held.pid=l.pid AND held.locktype='transactionid' AND held.granted
          AND held.transactionid=waiting.transactionid
        WHERE w.application_name=${literal(waiter.name)} AND l.application_name=${literal(leader.name)}
          AND EXISTS (SELECT 1 FROM pg_locks WHERE pid=w.pid AND locktype='tuple' AND relation='ppo_authority.gate'::regclass)
          AND EXISTS (SELECT 1 FROM pg_locks WHERE pid=l.pid AND granted AND mode='RowExclusiveLock'
            AND relation='ppo_authority.gate'::regclass)
      );
    `)
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
  const config = { mode, authorityId, containerId: container, coordinatorPublicKey: publicKey, readerQuery, verifierQuery,
    approvedProjects: ["rivora", "kynexa"], now,
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
  const withRequest = (signed, overrides) => ({
    ...config, resolveIssueProject: () => signed.payload.projectId, ...overrides
  })
  const prepare = (signed, overrides = {}) => createPostgresOfflineAssignmentPreparer(withRequest(signed, overrides))(signed)
  const observe = signed => createPostgresOfflineAssignmentObserver({ mode, authorityId, coordinatorPublicKey: publicKey, readerQuery: query(READER) })(signed)
  function bind(signed, overrides = {}) {
    return createPostgresOfflineAssignmentBinder(withRequest(signed, overrides))(signed)
  }
  // Native fault/locking tests need an explicit transaction. Only the harness
  // has that session. The executable lab entrypoint always uses bind above.
  async function submitWithTestSession(signed, commitQuery, overrides) {
    const { args } = await prepare(signed, overrides)
    const reply = await commitQuery(OFFLINE_ASSIGNMENT_SQL.bind, args)
    return reply.rows[0].accepted
  }
  const count = () => sql("SELECT count(*) FROM ppo_authority.offline_assignment_reservations;")
  async function assertUnchanged(run, signed, total) {
    assert.deepEqual(await read(run.runId), run)
    assert.equal((await observe(signed)).outcome, "unobserved")
    assert.equal(await count(), total)
  }

  await t.test("RED ordinary D1 candidate publishes without a reservation; GREEN same writer is denied and atomic binder commits", async subtest => {
    const run = await seed()
    const signed = approve(assignment(run))
    const { args } = await prepare(signed, { readerQuery: (statement, values) =>
      statement === OFFLINE_ASSIGNMENT_SQL.replay ? { rows: [{ conflict: false }] } : readerQuery(statement, values) })
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
    const receipt = await bind(signed, { commitQuery: () => assert.fail("Caller-selected writer ran") })
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
      await assert.rejects(bind(request), { code })
    }
    await assertUnchanged(run, signed, "1")
    await cancel(run)
  })

  await t.test("source identity and exact D1 certificate are checked by the write transaction", async () => {
    const run = await seed()
    const first = approve(assignment(run))
    const fakeCertification = () => ({ rows: [{ certified: true }] })
    const submit = (statement, args) => query(BINDER)(statement, args)
    assert.equal(await submitWithTestSession(first, submit, { verifierQuery: fakeCertification }), false)
    await assertUnchanged(run, first, "1")
    // A real D1 catalog certificate alone is insufficient. Only signed and
    // owner-approved input gets the separate purpose-specific attestation.
    let certifications = 0
    assert.equal(await submitWithTestSession(first, submit, { verifierQuery: (statement, args) =>
      ++certifications === 1 ? verifierQuery(statement, args) : fakeCertification() }), false)
    assert.equal(certifications, 2)
    const attestationOnly = approve(assignment(run))
    certifications = 0
    assert.equal(await submitWithTestSession(attestationOnly, submit, { verifierQuery: (statement, args) =>
      ++certifications === 1 ? fakeCertification() : verifierQuery(statement, args) }), false)
    assert.equal(certifications, 2)
    await assertUnchanged(run, attestationOnly, "1")
    const anotherAuthority = "00000000-0000-0000-0000-000000000000"
    await assert.rejects(bind(first, { authorityId: anotherAuthority }), { code: "OFFLINE_ASSIGNMENT_UNAVAILABLE" })
    for (const [index, value] of [[0, anotherAuthority], [1, "another-signer"], [2, "0".repeat(64)], [4, '{"mode":"implementation"}']]) {
      assert.equal(await submitWithTestSession(first, (statement, args) =>
        query(BINDER)(statement, args.with(index, value))), false)
    }
    const second = approve(assignment(run))
    assert.equal(await submitWithTestSession(second, async (statement, args) => {
      // An unrelated mutation after certification invalidates the old catalog token.
      const unrelated = await seed("kynexa")
      await cancel(unrelated)
      return query(BINDER)(statement, args)
    }), false)
    await assertUnchanged(run, second, "1")
    await cancel(run)
  })

  await t.test("standalone profile refuses gateway or ownership installation and runtime routing", async () => {
    const run = await seed()
    const signed = approve(assignment(run))
    const { args } = await prepare(signed)
    try {
      for (const table of ["ppo_authority.gateway_profile", "ppo_authority.rehearsal_owner"]) {
        await sql("BEGIN; SET LOCAL ROLE ppo_authority_owner; CREATE TABLE " + table + " (fixture boolean); COMMIT;")
        try {
          await assert.rejects(sql(await profile("postgres-offline-assignment")), /standalone disposable D1 authority required/u)
          await assert.rejects(bind(signed), { code: "OFFLINE_ASSIGNMENT_UNAVAILABLE" })
          assert.equal((await query(BINDER)(OFFLINE_ASSIGNMENT_SQL.bind, args)).rows[0].accepted, false)
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
      const firstResult = submitWithTestSession(first, async (statement, args) => {
        const reply = result(await leader.send("BEGIN;" + statementFor(statement, args)))
        staged()
        await release
        await leader.send("COMMIT;")
        return reply
      })
      await Promise.race([tentative, firstResult])
      assert.equal((await observe(first)).outcome, "unobserved")
      const secondResult = submitWithTestSession(second, async (statement, args) =>
        result(await waiter.send(statementFor(statement, args))))
      const completion = Promise.allSettled([firstResult, secondResult])
      try { await waitForBlock(waiter, leader) } finally { resume() }
      const [won, lost] = await completion
      assert.deepEqual(won, { status: "fulfilled", value: true })
      assert.deepEqual(lost, { status: "fulfilled", value: false })
      const binding = await observe(first)
      assert.equal(binding.outcome, "bound-offline")
      assert.equal(binding.historyHash, (await read(first.payload.runId)).historyHash)
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
    const certificateCount = () => sql("SELECT cert_count FROM ppo_authority.admission_identity;")
    const before = await certificateCount()
    for (const key of ["requestId", "nonce", "idempotencyKey", "approval"]) {
      const duplicate = approve(assignment(second, { [key]: original.payload[key] }))
      await assert.rejects(bind(duplicate), { code: "OFFLINE_ASSIGNMENT_REPLAY" })
      await assertUnchanged(second, duplicate, "3")
    }
    assert.equal(await certificateCount(), before)
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
        RAISE EXCEPTION 'injected failure after both inserts' USING ERRCODE='P1942';
      END $body$;
      CREATE TRIGGER assignment_test_fault AFTER INSERT ON ppo_authority.run_versions
        FOR EACH ROW EXECUTE FUNCTION ppo_authority.assignment_test_fault();
    `)
    try {
      await assert.rejects(submitWithTestSession(signed, query(BINDER)), /P1942/u)
      await assertUnchanged(run, signed, "3")
    } finally {
      await sql("DROP TRIGGER assignment_test_fault ON ppo_authority.run_versions; DROP FUNCTION ppo_authority.assignment_test_fault();")
    }
    await cancel(run)
  })

  await t.test("a successful native bind statement is rejected at COMMIT after expiry", async () => {
    const run = await seed()
    const expiresAt = new Date(Date.now() + 8000).toISOString()
    const signed = approve(assignment(run, { expiresAt }))
    const { args } = await prepare(signed)
    const writer = session(BINDER, "assignment-expiring-writer")
    try {
      await writer.ready()
      const reply = result(await writer.send("BEGIN;" + statementFor(OFFLINE_ASSIGNMENT_SQL.bind, args)))
      assert.equal(reply.rows[0].accepted, true)
      assert.ok(Date.now() < Date.parse(expiresAt))
      assert.equal((await observe(signed)).outcome, "unobserved")
      await writer.send("SELECT pg_sleep(greatest(0,extract(epoch FROM (" + literal(expiresAt) +
        "::timestamptz-clock_timestamp())))::double precision+0.05);")
      await assert.rejects(writer.send("COMMIT;"), /P1941/u)
      await assertUnchanged(run, signed, "3")
    } finally { await writer.close() }
    await cancel(run)
  })

  await t.test("the fixed autocommit transport withholds acknowledgment when authorization expires", async () => {
    const run = await seed()
    await sql(`
      CREATE FUNCTION ppo_authority.assignment_test_delay() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE deadline timestamptz;
      BEGIN
        SELECT expires_at INTO STRICT deadline FROM ppo_authority.offline_assignment_reservations
          WHERE run_id=NEW.run_id AND expected_version=NEW.version-1;
        PERFORM pg_sleep(greatest(0,extract(epoch FROM (deadline-clock_timestamp())))::double precision+0.05);
        RETURN NEW;
      END $body$;
      CREATE TRIGGER assignment_test_delay BEFORE INSERT ON ppo_authority.run_versions
        FOR EACH ROW EXECUTE FUNCTION ppo_authority.assignment_test_delay();
    `)
    const expiresAt = new Date(Date.now() + 8000).toISOString()
    const signed = approve(assignment(run, { expiresAt }))
    try {
      await assert.rejects(bind(signed), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN" })
      assert.ok(Date.now() >= Date.parse(expiresAt))
      await assertUnchanged(run, signed, "3")
    } finally {
      await sql("DROP TRIGGER assignment_test_delay ON ppo_authority.run_versions; DROP FUNCTION ppo_authority.assignment_test_delay();")
    }
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
      await assert.rejects(submitWithTestSession(signed, async (statement, args) => {
        const reply = result(await writer.send("BEGIN;" + statementFor(statement, args)))
        assert.equal(reply.rows[0].accepted, true)
        assert.equal((await observe(signed)).outcome, "unobserved")
        assert.equal(await sql("SELECT pg_terminate_backend(" + pid + ",5000);"), "t")
        terminated = true
        await writer.send("COMMIT;")
        return reply
      }), /session closed|terminating connection/u)
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
      await assert.rejects(submitWithTestSession(signed, async (statement, args) => {
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
        assert.equal(await sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=" + pid +
          " AND application_name='" + CRASH_SESSION + "' AND state='idle in transaction'" +
          " AND clock_timestamp()-state_change < interval '5 seconds');"), "t")
        assert.equal(child.kill("SIGKILL"), true)
        assert.deepEqual(await closed, [null, "SIGKILL"])
        const deadline = Date.now() + 10000
        while (await sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=" + pid + " AND application_name='" + CRASH_SESSION + "');") === "t") {
          assert.ok(Date.now() < deadline, "Uncommitted backend survived the writer and its idle limit")
        }
        verifiedDeath = true
        throw Error("Writer died before acknowledging commit")
      }), /Writer died before acknowledging commit/u)
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
    await withTransportLoss(false, () => assert.rejects(bind(first), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN" }))
    await assertUnchanged(unavailableRun, first, "3")
    await cancel(unavailableRun)

    // A separate run supplies the lost-acknowledgment scenario.
    const run = await seed()
    const second = approve(assignment(run))
    await withTransportLoss(true, () => assert.rejects(bind(second), { code: "OFFLINE_ASSIGNMENT_COMMIT_UNKNOWN", observation: {
      runId: run.runId, expectedVersion: 3, requestHash: remotePayloadDigest(second.payload)
    } }))
    execFileSync("docker", ["restart", container], { stdio: "ignore", timeout: 15000, killSignal: "SIGKILL" })
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
      await assert.rejects(bind(signed), { code: "PREFLIGHT_CATALOG_BLOCKED" })
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
    try {
      const { entries } = (await query(READER)(READ_CATALOG, [])).rows[0].snapshot
      const inspection = rehearseSyntheticMigrationPreflight({ mode: "synthetic-migration-preflight-only",
        entries: entries.map(entry => ({ relativePath: entry.path, bytes: Buffer.from(entry.serialized, "utf8") })) })
      assert.equal(inspection.diagnostics.duplicateActiveProject, true)
      assert.equal(inspection.diagnostics.invalid, 0)
      assert.equal(inspection.diagnostics.unknown, 0)
      await denyCatalog("ok")
    } finally {
      await editVersions("DELETE FROM " + table + " WHERE run_id=" + duplicate + ";")
    }
    await sql("INSERT INTO " + table + " SELECT id,0,source->>'historyHash',jsonb_set(source,'{runId}',to_jsonb(id)) " +
      "FROM (SELECT repeat('Z',40)||lpad(i::text,3,'0') AS id," + literal(source) + "::jsonb AS source FROM generate_series(1,21) i) f;")
    try { await denyCatalog("catalog_truncated") } finally {
      await editVersions("DELETE FROM " + table + " WHERE run_id LIKE '" + "Z".repeat(40) + "%';")
    }
  })
})
