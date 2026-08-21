import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const SCRIPT_PATH = resolve("deployment/scripts/deploy-exact-sha.sh");
const MAIN_ONLY_FETCH_REFSPEC = "+refs/heads/main:refs/remotes/origin/main";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  }).trim();
}

function runBash(script, args = []) {
  return spawnSync("bash", ["-c", script, "bash", ...args], {
    encoding: "utf8"
  });
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function createExactShaFixture() {
  const root = await mkdtemp(join(tmpdir(), "ppo-exact-sha-"));
  const remoteWorkDir = join(root, "remote-work");
  const remoteBareDir = join(root, "origin.git");
  const installDir = join(root, "install");

  await mkdir(remoteWorkDir, { recursive: true });

  git(remoteWorkDir, ["init", "-b", "main"]);
  git(remoteWorkDir, ["config", "user.email", "phase6h@example.invalid"]);
  git(remoteWorkDir, ["config", "user.name", "Phase 6H Test"]);

  await writeFile(join(remoteWorkDir, "deployment.txt"), "base\n");
  git(remoteWorkDir, ["add", "deployment.txt"]);
  git(remoteWorkDir, ["commit", "-m", "base"]);

  await writeFile(join(remoteWorkDir, "deployment.txt"), "approved deployment\n");
  git(remoteWorkDir, ["add", "deployment.txt"]);
  git(remoteWorkDir, ["commit", "-m", "approved deployment"]);
  const expectedSha = git(remoteWorkDir, ["rev-parse", "HEAD"]);

  await writeFile(join(remoteWorkDir, "deployment.txt"), "remote main tip\n");
  git(remoteWorkDir, ["add", "deployment.txt"]);
  git(remoteWorkDir, ["commit", "-m", "remote main tip"]);
  const remoteMainSha = git(remoteWorkDir, ["rev-parse", "HEAD"]);

  git(root, ["init", "--bare", "-b", "main", remoteBareDir]);
  git(remoteBareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(remoteWorkDir, ["remote", "add", "origin", remoteBareDir]);
  git(remoteWorkDir, ["push", "--quiet", "origin", "main"]);
  git(root, ["clone", "--quiet", remoteBareDir, installDir]);

  git(installDir, ["config", "user.email", "phase6h@example.invalid"]);
  git(installDir, ["config", "user.name", "Phase 6H Test"]);
  git(installDir, ["config", "--unset-all", "remote.origin.fetch"]);
  git(installDir, ["config", "--add", "remote.origin.fetch", MAIN_ONLY_FETCH_REFSPEC]);
  git(installDir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  return {
    root,
    remoteBareDir,
    installDir,
    expectedSha,
    remoteMainSha
  };
}

function runVerifyExpectedCommit(installDir, expectedSha) {
  return runBash(
    [
      "source \"$1\"",
      "INSTALL_DIR=\"$2\"",
      "EXPECTED_SHA=\"$3\"",
      "verify_expected_commit"
    ].join("\n"),
    [SCRIPT_PATH, installDir, expectedSha]
  );
}

function runMainWithDeploymentMutationMarkers(installDir, stateDir, expectedSha, mutationLog) {
  return runBash(
    [
      "source \"$1\"",
      "INSTALL_DIR=\"$2\"",
      "STATE_DIR=\"$3\"",
      "EXPECTED_SHA=\"$4\"",
      "MUTATION_LOG=\"$5\"",
      "SERVICE_USER=\"ppo-test\"",
      "SERVICE_GROUP=\"ppo-test\"",
      "PREFLIGHT_SCRIPT=\"/tmp/phase-6h-preflight-should-not-run\"",
      "SERVICE_CONTROL_SCRIPT=\"/tmp/phase-6h-service-should-not-run\"",
      "require_root() { :; }",
      "require_service_identity() { :; }",
      "verify_checkout_identity() { :; }",
      "record_previous_revision() { printf 'record_previous_revision\\n' >> \"$MUTATION_LOG\"; }",
      "lock_runtime_checkout_permissions() { printf 'lock_runtime_checkout_permissions\\n' >> \"$MUTATION_LOG\"; }",
      "sudo() { printf 'runtime_preflight\\n' >> \"$MUTATION_LOG\"; return 0; }",
      "env() { printf 'service_restart\\n' >> \"$MUTATION_LOG\"; return 0; }",
      "main \"$EXPECTED_SHA\""
    ].join("\n"),
    [SCRIPT_PATH, installDir, stateDir, expectedSha, mutationLog]
  );
}

test("exact-SHA verification fetch preserves origin main and origin HEAD with main-only fetch config", async () => {
  const fixture = await createExactShaFixture();

  try {
    assert.deepEqual(git(fixture.installDir, ["config", "--get-all", "remote.origin.fetch"]).split("\n"), [
      MAIN_ONLY_FETCH_REFSPEC
    ]);
    assert.equal(git(fixture.installDir, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]), fixture.remoteMainSha);
    assert.equal(git(fixture.installDir, ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"]), fixture.remoteMainSha);

    const result = runVerifyExpectedCommit(fixture.installDir, fixture.expectedSha);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(git(fixture.installDir, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]), fixture.remoteMainSha);
    assert.equal(git(fixture.installDir, ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"]), fixture.remoteMainSha);
    assert.equal(git(fixture.installDir, ["merge-base", "--is-ancestor", fixture.expectedSha, "refs/remotes/origin/main"]), "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact-SHA verification rejects a valid commit that is not reachable from fetched main", async () => {
  const fixture = await createExactShaFixture();

  try {
    const treeSha = git(fixture.installDir, ["write-tree"]);
    const unreachableSha = git(fixture.installDir, ["commit-tree", treeSha, "-m", "unreachable expected commit"]);
    const result = runVerifyExpectedCommit(fixture.installDir, unreachableSha);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected deployment SHA is not reachable from fetched origin main/);
    assert.equal(git(fixture.installDir, ["cat-file", "-t", unreachableSha]), "commit");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fetch failure stops before previous revision record, checkout, preflight, or service restart", async () => {
  const fixture = await createExactShaFixture();
  const emptyRemoteDir = join(fixture.root, "empty-origin.git");
  const stateDir = join(fixture.root, "state");
  const mutationLog = join(fixture.root, "mutation.log");

  try {
    git(fixture.root, ["init", "--bare", "-b", "main", emptyRemoteDir]);
    git(fixture.installDir, ["remote", "set-url", "origin", emptyRemoteDir]);

    const headBefore = git(fixture.installDir, ["rev-parse", "--verify", "HEAD"]);
    const result = runMainWithDeploymentMutationMarkers(
      fixture.installDir,
      stateDir,
      fixture.expectedSha,
      mutationLog
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed to fetch approved origin main/);
    assert.equal(git(fixture.installDir, ["rev-parse", "--verify", "HEAD"]), headBefore);
    assert.equal(await pathExists(mutationLog), false);
    assert.equal(await pathExists(join(stateDir, "last-deploy-previous-revision")), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deployment verification fetch remains fixed to origin main without prune or force", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8");

  assert.match(source, /REMOTE_NAME="origin"/);
  assert.match(source, /MAIN_BRANCH="main"/);
  assert.match(source, /source_main_ref="refs\/heads\/main"/);
  assert.match(source, /remote_main_ref="refs\/remotes\/origin\/main"/);
  assert.match(source, /fetch "\$REMOTE_NAME" "\$\{source_main_ref\}:\$\{remote_main_ref\}"/);
  assert.match(source, /rev-parse --verify --quiet "\$\{remote_main_ref\}\^\{commit\}"/);
  assert.doesNotMatch(source, /fetch\s+--prune/);
  assert.doesNotMatch(source, /\+refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.doesNotMatch(source, /\bgit pull\b/);
});
