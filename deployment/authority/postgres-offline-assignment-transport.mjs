import { execFileSync, spawn } from "node:child_process"
import { ADMISSION_SQL } from "../../local-operator/development-catalog-certified-query.mjs"
import { createPostgresTestSession } from "./postgres-test-session.mjs"

export const OFFLINE_ASSIGNMENT_SQL = Object.freeze({
  bind: "SELECT ppo_authority.bind_offline_assignment($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text) AS accepted",
  observe: "SELECT ppo_authority.read_offline_assignment($1::uuid,$2::text,$3::text,$4::integer,$5::text) AS receipt"
})
const READ = new Set([
  "SELECT ppo_authority.read_run($1::text) AS record",
  "SELECT ppo_authority.read_catalog_snapshot() AS snapshot",
  ADMISSION_SQL.prepare,
  OFFLINE_ASSIGNMENT_SQL.observe
])

export function assertDisposableAssignmentContainer(containerId) {
  if (typeof containerId !== "string" || !/^[a-f0-9]{64}$/u.test(containerId)) {
    throw Error("Verified disposable assignment container required.")
  }
  // Read only isolation metadata. The harness supplies the ID it just
  // created. No host, DSN, published port, or existing container name is used.
  let details
  try {
    details = execFileSync("docker", ["inspect", "--format",
      '{{.Id}} {{.Name}} {{.Config.Image}} {{.HostConfig.NetworkMode}} {{.HostConfig.PublishAllPorts}} {{len .HostConfig.PortBindings}}{{range .Mounts}}{{if eq .Type "bind"}} bind{{end}}{{end}}',
      containerId], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096 }).trim()
  } catch {
    throw Error("Verified disposable assignment container required.")
  }
  if (!new RegExp("^" + containerId + " /ppo-authority-ci-[0-9]+-[0-9]+-assignment postgres:16 none false 0$", "u").test(details)) {
    throw Error("Verified disposable assignment container required.")
  }
}

function literal(value) {
  if (Number.isSafeInteger(value)) return String(value)
  if (typeof value !== "string") throw Error("Invalid disposable statement parameter.")
  return "convert_from(decode('" + Buffer.from(value, "utf8").toString("base64") + "','base64'),'UTF8')"
}

/**
 * Own a fresh psql session per fixed statement. Only the trusted disposable
 * socket can SET ROLE. The binder has no LOGIN or client-facing session.
 */
export function createDisposableAssignmentTransport(containerId) {
  assertDisposableAssignmentContainer(containerId)
  async function execute(role, statement, args) {
    const bound = statement.replace(/\$([1-7])/gu, (_, index) => literal(args[Number(index) - 1]))
    const child = spawn("docker", ["exec", "-i", containerId, "psql", "-X", "-qAt",
      "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "ppo_authority_ci"], { stdio: ["pipe", "pipe", "pipe"] })
    const session = createPostgresTestSession(child, { timeoutMs: 60000, maxStdoutBytes: 70 * 1024 * 1024 })
    try {
      await session.send("SET statement_timeout='45s'; SET ROLE " + role + ";")
      // psql processes the completion marker after ReadyForQuery for the
      // single autocommit statement. A deferred COMMIT failure stops psql
      // before that marker, even if the SELECT had produced a tentative row.
      const output = await session.send("SELECT row_to_json(q) FROM (" + bound + ") q;")
      return { rows: [JSON.parse(output)] }
    } finally { await session.close() }
  }

  return Object.freeze({
    readerQuery(statement, args) {
      if (!READ.has(statement)) throw Error("Invalid disposable reader statement.")
      return execute("ppo_authority_reader", statement, args)
    },
    verifierQuery(statement, args) {
      if (statement !== ADMISSION_SQL.certify) throw Error("Invalid disposable verifier statement.")
      return execute("ppo_admission_verifier", statement, args)
    },
    bind(args) { return execute("ppo_offline_assignment_binder", OFFLINE_ASSIGNMENT_SQL.bind, args) }
  })
}
