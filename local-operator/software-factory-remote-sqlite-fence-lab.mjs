import { randomBytes } from "node:crypto"
import { chmodSync, closeSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import {
  isDevelopmentRunTerminalStatus, parseDevelopmentRunRecord
} from "./development-run-state.mjs"
import { softwareFactoryRunConsumesWip } from "./software-factory-admission.mjs"

// RIC-157 Phase 1G-B1: disposable single-host transaction laboratory.
// Never import live PPO records, enroll hosts, or wire to a worker/gateway.
const PREFIX = "ppo-phase1g-lab-"
const DB_NAME = "fence-lab.sqlite"
const APPLICATION_ID = 1347438407
const MAX_RUNS = 100
const SYNTHETIC_TASK = "RIC-157 synthetic lab:"
const CLOCK = "CAST(unixepoch('subsec') * 1000 AS INTEGER)"
const SCHEMA = [
  "CREATE TABLE lab_meta (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, catalog_complete INTEGER NOT NULL CHECK(catalog_complete IN (0,1))) STRICT",
  "CREATE TABLE hosts (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload) AND json_extract(payload,'$.hostId') IS id)) STRICT",
  "CREATE TABLE claims (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload) AND json_extract(payload,'$.claimHash') IS id)) STRICT",
  "CREATE TABLE requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload) AND json_extract(payload,'$.requestHash') IS id)) STRICT",
  "CREATE TABLE canonical_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload) AND json_extract(payload,'$.runId') IS id)) STRICT",
  "CREATE TABLE consumed (host_id TEXT NOT NULL, action_id TEXT NOT NULL, request_hash TEXT NOT NULL, claim_hash TEXT NOT NULL, run_id TEXT NOT NULL, run_version INTEGER NOT NULL CHECK(run_version>=1), host_epoch INTEGER NOT NULL CHECK(host_epoch>=1), consumed_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL CHECK(consumed_ms<expires_ms), PRIMARY KEY(host_id,action_id)) STRICT",
  "CREATE TRIGGER consumed_no_update BEFORE UPDATE ON consumed BEGIN SELECT RAISE(ABORT,'immutable laboratory nonce'); END",
  "CREATE TRIGGER consumed_no_delete BEFORE DELETE ON consumed BEGIN SELECT RAISE(ABORT,'immutable laboratory nonce'); END"
].join(";\n") + ";"

function deny() { throw new Error("SQLite fence laboratory unavailable or invalid.") }
function tempRoot() { return realpathSync(tmpdir()) }
function checkPrivate(path, directory) {
  const info = lstatSync(path)
  if ((directory ? !info.isDirectory() : !info.isFile()) ||
      info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      typeof process.getuid !== "function" || info.uid !== process.getuid() ||
      realpathSync(path) !== path) deny()
}
function labPath(directory) {
  if (typeof directory !== "string" || dirname(directory) !== tempRoot() ||
      !/^ppo-phase1g-lab-[A-Za-z0-9]+$/u.test(basename(directory))) deny()
  checkPrivate(directory, true)
  const path = join(directory, DB_NAME)
  checkPrivate(path, false)
  return path
}
function connect(directory, token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) deny()
  const db = new DatabaseSync(labPath(directory))
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
    if (db.prepare("PRAGMA application_id").get().application_id !== APPLICATION_ID ||
        db.prepare("PRAGMA user_version").get().user_version !== 1 ||
        db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal" ||
        db.prepare("PRAGMA synchronous").get().synchronous !== 2 ||
        db.prepare("SELECT token FROM lab_meta WHERE id=1").get()?.token !== token) deny()
    return db
  } catch (error) { db.close(); throw error }
}

/** Create a fresh private, disposable database. No caller-supplied path or live data. */
export function createSqliteFenceLab() {
  const directory = mkdtempSync(join(tempRoot(), PREFIX))
  const token = randomBytes(32).toString("hex")
  let db
  try {
    chmodSync(directory, 0o700)
    closeSync(openSync(join(directory, DB_NAME), "wx", 0o600))
    db = new DatabaseSync(labPath(directory))
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
    db.exec("BEGIN IMMEDIATE")
    db.exec(SCHEMA)
    db.prepare("INSERT INTO lab_meta VALUES (1,?,1)").run(token)
    db.exec("PRAGMA application_id=" + APPLICATION_ID + "; PRAGMA user_version=1; COMMIT")
    db.close()
    db = null
    return Object.freeze({ directory, token, transact: openSqliteFenceLab(directory, token) })
  } catch (error) {
    try { db?.close() } finally { rmSync(directory, {recursive:true,force:true}) }
    throw error
  }
}

/** Reopen the same synthetic authority from another process. */
export function openSqliteFenceLab(directory, token) {
  const probe = connect(directory, token)
  probe.close()
  return async function transact(callback) {
    if (typeof callback !== "function") deny()
    const db = connect(directory, token)
    let begun = false
    let active = false
    let pending = null
    let attempted = false
    let lastClock = -1
    function requireActive() { if (!active) deny() }
    function clock() {
      requireActive()
      const value = db.prepare("SELECT " + CLOCK + " AS ms").get().ms
      if (!Number.isSafeInteger(value) || value < lastClock) deny()
      lastClock = value
      return value
    }
    function read(table, id) {
      requireActive()
      // table is supplied only by fixed internal closures below.
      const row = db.prepare("SELECT payload FROM " + table + " WHERE id=?").get(id)
      return row ? JSON.parse(row.payload) : null
    }
    function runRecord(row) {
      const record = parseDevelopmentRunRecord(row.payload, row.id)
      if (!record.task.startsWith(SYNTHETIC_TASK)) deny()
      return record
    }
    function readRun(id) {
      requireActive()
      const row = db.prepare("SELECT id,payload FROM canonical_runs WHERE id=?").get(id)
      return row ? runRecord(row) : null
    }
    function admission() {
      requireActive()
      const rows = db.prepare("SELECT id,payload FROM canonical_runs LIMIT ?").all(MAX_RUNS + 1)
      if (rows.length > MAX_RUNS ||
          db.prepare("SELECT catalog_complete FROM lab_meta WHERE id=1").get()?.catalog_complete !== 1) {
        return {valid:false,invalidCount:1,activeProjects:[]}
      }
      const activeProjects = new Set()
      let invalidCount = 0
      for (const row of rows) {
        try {
          const r = runRecord(row)
          if (softwareFactoryRunConsumesWip({
            status:r.status, terminal:isDevelopmentRunTerminalStatus(r.status)
          })) {
            if (activeProjects.has(r.project.id)) invalidCount++
            activeProjects.add(r.project.id)
          }
        } catch { invalidCount++ }
      }
      return {valid:invalidCount===0,invalidCount,activeProjects:[...activeProjects].sort()}
    }
    function fresh(lower, upper) {
      const now = clock()
      return now >= lower && now < upper
    }
    try {
      // SQLite serializes all writers on this database. Fail immediately on a
      // competing writer; do not silently wait/retry an already reviewed call.
      db.exec("BEGIN IMMEDIATE")
      begun = true
      active = true
      const tx = Object.freeze({
        now:()=>new Date(clock()),
        readHostForUpdate:id=>typeof id==="string" && id.startsWith("lab-")
          ? read("hosts",id) : null,
        readClaimForUpdate:id=>read("claims",id),
        readRequestForUpdate:id=>read("requests",id),
        readRunForUpdate:readRun,
        readAdmissionForUpdate:admission,
        tryConsumeFreshOnce:input=>{
          requireActive()
          if (attempted) deny()
          attempted = true
          const times = [input.claimNotBeforeMs,input.claimExpiresAtMs,
            input.proofNotBeforeMs,input.proofExpiresAtMs,input.requestExpiresAtMs]
          if (!times.every(Number.isSafeInteger)) deny()
          const lower = Math.max(input.claimNotBeforeMs,input.proofNotBeforeMs)
          const upper = Math.min(input.claimExpiresAtMs,input.proofExpiresAtMs,input.requestExpiresAtMs)
          if (lower>=upper || !fresh(lower,upper)) return false
          const host = read("hosts",input.hostId)
          const request = read("requests",input.requestHash)
          // Registry-level grants are independent of request/claim approval.
          if (!host || !request || !Array.isArray(host.approvedProjectIds) ||
              !Array.isArray(host.approvedCapabilities) ||
              !host.approvedProjectIds.includes(request.projectId) ||
              !host.approvedCapabilities.includes(request.capability)) return false
          // Actual DB clock predicate AND database-enforced uniqueness.
          // RETURNING is not a commit acknowledgment.
          const row = db.prepare(
            "INSERT INTO consumed(host_id,action_id,request_hash,claim_hash,run_id,run_version,host_epoch,consumed_ms,expires_ms) " +
            "SELECT ?,?,?,?,?,?,?,ms,? FROM (SELECT " + CLOCK + " AS ms) " +
            "WHERE ms>=? AND ms<? ON CONFLICT(host_id,action_id) DO NOTHING RETURNING consumed_ms"
          ).get(input.hostId,input.actionId,input.requestHash,input.claimHash,
            input.runId,input.expectedVersion,input.hostEpoch,upper,lower,upper)
          if (!row) return false
          if (!Number.isSafeInteger(row.consumed_ms) || row.consumed_ms < lastClock) deny()
          lastClock = row.consumed_ms
          pending = {lower,upper}
          return true
        }
      })
      const result = await callback(tx)
      if (result !== true || !pending || !fresh(pending.lower,pending.upper)) {
        db.exec("ROLLBACK")
        begun = false
        return false
      }
      db.exec("COMMIT")
      begun = false
      // COMMIT and ACK can be delayed. A late/unknown ACK never returns true.
      // If COMMIT succeeded, its nonce remains burned even on a later denial.
      return fresh(pending.lower,pending.upper)
    } finally {
      active = false
      try { if (begun) db.exec("ROLLBACK") } finally { db.close() }
    }
  }
}
