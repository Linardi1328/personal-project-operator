import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VPS_HEALTH_SERVICE,
  VPS_INSTALL_DIR,
  VPS_NODE_PATH,
  VPS_OPENCLAW_PATH,
  VPS_WRAPPER_PATH,
  collectVpsHealth,
  formatVpsHealth
} from "./scripts/vps-health.mjs";

const sensitiveSentinel = "SENSITIVE_TEST_SENTINEL";

function preflightSupportsNodeVersion(version) {
  const result = spawnSync("bash", [
    "-c",
    `source deployment/scripts/preflight-openclaw-runtime.sh; is_supported_node_version "${version}"`
  ], {
    encoding: "utf8"
  });

  return result.status === 0;
}

function fakeRunner(command, args, options) {
  assert.deepEqual(options.shell, false, "health commands use shell:false");

  const key = `${command} ${args.join(" ")}`;
  const responses = new Map([
    [`${VPS_NODE_PATH} --version`, { stdout: "v26.0.0\n", stderr: sensitiveSentinel }],
    ["git --version", { stdout: "git version 2.43.0\n", stderr: sensitiveSentinel }],
    ["gh --version", { stdout: "gh version 2.97.0\nhttps://example.invalid\n", stderr: sensitiveSentinel }],
    [`${VPS_OPENCLAW_PATH} --version`, { stdout: "openclaw 2026.5.17\n", stderr: sensitiveSentinel }],
    [`systemctl is-active ${VPS_HEALTH_SERVICE}`, { stdout: "active\n", stderr: sensitiveSentinel }],
    [`systemctl is-enabled ${VPS_HEALTH_SERVICE}`, { stdout: "enabled\n", stderr: sensitiveSentinel }],
    ["uptime -p", { stdout: "up 2 hours, 4 minutes\n", stderr: sensitiveSentinel }],
    ["df -h /", { stdout: "Filesystem Size Used Avail Use% Mounted on\n/dev/root 39G 10G 29G 26% /\n", stderr: sensitiveSentinel }],
    ["free -m", { stdout: "       total used free\nMem:    3930 800 3130\n", stderr: sensitiveSentinel }]
  ]);

  if (!responses.has(key)) {
    throw new Error(`${sensitiveSentinel} unexpected command ${key}`);
  }

  return responses.get(key);
}

function runPermissionLock(script, repoPath) {
  execFileSync("bash", [
    "-c",
    "chown() { :; }; source \"$1\"; INSTALL_DIR=\"$2\"; lock_runtime_checkout_permissions",
    "bash",
    script,
    repoPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

async function createModeFixtureRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "ppo-mode-lock-"));

  await mkdir(join(repoPath, "deployment", "scripts"), { recursive: true });
  await mkdir(join(repoPath, "local-operator"), { recursive: true });
  await writeFile(join(repoPath, "deployment", "scripts", "run.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(join(repoPath, "deployment", "scripts", "tool.mjs"), "#!/usr/bin/env node\nconsole.log('ok')\n");
  await writeFile(join(repoPath, "local-operator", "plain.mjs"), "export const plain = true\n");
  await writeFile(join(repoPath, "local-operator", "tracked-exec.mjs"), "#!/usr/bin/env node\nconsole.log('ok')\n");

  await chmod(join(repoPath, "deployment", "scripts", "run.sh"), 0o755);
  await chmod(join(repoPath, "deployment", "scripts", "tool.mjs"), 0o755);
  await chmod(join(repoPath, "local-operator", "plain.mjs"), 0o644);
  await chmod(join(repoPath, "local-operator", "tracked-exec.mjs"), 0o755);

  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "phase4a@example.invalid"], { cwd: repoPath, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Phase 4A Test"], { cwd: repoPath, encoding: "utf8" });
  execFileSync("git", ["add", "."], { cwd: repoPath, encoding: "utf8" });
  execFileSync("git", ["commit", "-m", "mode fixture"], { cwd: repoPath, encoding: "utf8" });

  return repoPath;
}

async function numericMode(path) {
  return (await stat(path)).mode & 0o777;
}

async function dirtyFixtureModes(repoPath) {
  await chmod(join(repoPath, "deployment", "scripts", "run.sh"), 0o644);
  await chmod(join(repoPath, "deployment", "scripts", "tool.mjs"), 0o644);
  await chmod(join(repoPath, "local-operator", "plain.mjs"), 0o755);
  await chmod(join(repoPath, "local-operator", "tracked-exec.mjs"), 0o644);
}

async function assertModeLockClean(repoPath, script) {
  await dirtyFixtureModes(repoPath);
  assert.notEqual(execFileSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" }), "");

  runPermissionLock(script, repoPath);

  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" }), "");
  assert.equal(await numericMode(join(repoPath, "deployment", "scripts", "run.sh")), 0o755);
  assert.equal(await numericMode(join(repoPath, "deployment", "scripts", "tool.mjs")), 0o755);
  assert.equal(await numericMode(join(repoPath, "local-operator", "plain.mjs")), 0o644);
  assert.equal(await numericMode(join(repoPath, "local-operator", "tracked-exec.mjs")), 0o755);

  const modes = execFileSync("git", ["ls-files", "-s"], { cwd: repoPath, encoding: "utf8" });
  assert.match(modes, /^100755 .*	deployment\/scripts\/run\.sh$/m);
  assert.match(modes, /^100755 .*	deployment\/scripts\/tool\.mjs$/m);
  assert.match(modes, /^100644 .*	local-operator\/plain\.mjs$/m);
  assert.match(modes, /^100755 .*	local-operator\/tracked-exec\.mjs$/m);
}

{
  const report = await collectVpsHealth({
    runner: fakeRunner,
    exists: (path) => path === VPS_INSTALL_DIR || path === VPS_WRAPPER_PATH,
    now: "2026-08-18T00:00:00.000Z"
  });
  const output = formatVpsHealth(report);

  assert.match(output, /^VPS Health Foundation/);
  assert.match(output, /Source: local read-only host checks/);
  assert.match(output, /Target: Ubuntu 24\.04 LTS, 2 vCPU \/ 4 GB RAM class VPS/);
  assert.match(output, /Service: ppo-openclaw\.service/);
  assert.match(output, /- OpenClaw bundled Node\.js: available \(v26\.0\.0\)/);
  assert.match(output, /- OpenClaw local-prefix executable: available \(openclaw 2026\.5\.17\)/);
  assert.match(output, /- systemd active: active \(active\)/);
  assert.match(output, /- systemd boot recovery: enabled \(enabled\)/);
  assert.match(output, /- repo checkout: present \(\/opt\/personal-project-operator\)/);
  assert.match(output, /- PPO wrapper: present \(\/opt\/personal-project-operator\/local-operator\/ppo-command\.mjs\)/);
  assert.match(output, /Does not SSH to a server\./);
  assert.match(output, /Does not restart services\./);
  assert.doesNotMatch(output, new RegExp(sensitiveSentinel));
}

{
  const report = await collectVpsHealth({
    runner: () => {
      throw new Error(`${sensitiveSentinel} command failure`);
    },
    exists: () => false,
    now: "2026-08-18T00:00:00.000Z"
  });
  const output = formatVpsHealth(report);

  assert.match(output, /- OpenClaw bundled Node\.js: unavailable/);
  assert.match(output, /- systemd active: inactive or unavailable/);
  assert.match(output, /- repo checkout: missing/);
  assert.doesNotMatch(output, new RegExp(sensitiveSentinel));
}

{
  const source = await readFile(new URL("./scripts/vps-health.mjs", import.meta.url), "utf8");

  assert.match(source, /execFile/);
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /execSync|spawn\(|eval\(|new Function|node:vm|ssh |scp |rsync /);
}

{
  const shellScripts = [
    "bootstrap-ubuntu-24.04.sh",
    "preflight-openclaw-runtime.sh",
    "install-or-update-repo.sh",
    "service-control.sh",
    "firewall-ssh-hardening.sh",
    "rollback-repo.sh"
  ];

  for (const script of shellScripts) {
    const source = await readFile(new URL(`./scripts/${script}`, import.meta.url), "utf8");

    assert.match(source, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m, `${script} fails closed`);
    assert.doesNotMatch(source, /\beval\b|curl[^|\n]*\|[^|\n]*sh|git push|gh api|ssh |scp |rsync /, `${script} avoids remote deployment and generic execution`);
    assert.doesNotMatch(source, /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/, `${script} contains no committed IP address`);
  }
}

{
  const unit = await readFile(new URL("./systemd/ppo-openclaw.service", import.meta.url), "utf8");

  assert.match(unit, /User=ppo/);
  assert.match(unit, /Group=ppo/);
  assert.match(unit, /Environment=OPENCLAW_SERVICE_REPAIR_POLICY=external/);
  assert.match(unit, /Environment=PATH=\/home\/ppo\/\.local\/openclaw\/tools\/node\/bin:\/home\/ppo\/\.local\/openclaw\/bin:/);
  assert.match(unit, /ExecStartPre=\/opt\/personal-project-operator\/deployment\/scripts\/preflight-openclaw-runtime\.sh/);
  assert.match(unit, /ExecStart=\/home\/ppo\/\.local\/openclaw\/bin\/openclaw gateway run/);
  assert.doesNotMatch(unit, /gateway start/);
  assert.match(unit, /EnvironmentFile=-\/etc\/personal-project-operator\/openclaw\.env/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartPreventExitStatus=78/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /ReadWritePaths=\/home\/ppo \/var\/lib\/personal-project-operator \/var\/log\/personal-project-operator/);
  assert.doesNotMatch(unit, /ReadWritePaths=.*\/opt\/personal-project-operator/);
  assert.doesNotMatch(unit, /group:plugins|\*|TOKEN=|PASSWORD=|SECRET=|PRIVATE KEY/);
}

{
  const bootstrap = await readFile(new URL("./scripts/bootstrap-ubuntu-24.04.sh", import.meta.url), "utf8");

  assert.doesNotMatch(bootstrap, /\bnodejs\b|\bnpm\b/, "bootstrap does not install unsupported Ubuntu apt Node runtime");
  assert.match(bootstrap, /ca-certificates curl git gh ufw logrotate iproute2/);
  assert.match(bootstrap, /\/home\/\$\{SERVICE_USER\}\/\.local\/openclaw/);
}

{
  const preflight = await readFile(new URL("./scripts/preflight-openclaw-runtime.sh", import.meta.url), "utf8");

  assert.match(preflight, /OPENCLAW_PREFIX="\/home\/ppo\/\.local\/openclaw"/);
  assert.match(preflight, /NODE_BIN="\$\{OPENCLAW_PREFIX\}\/tools\/node\/bin\/node"/);
  assert.match(preflight, /EX_SOFTWARE=78/);
  assert.match(preflight, /exit "\$EX_SOFTWARE"/);
  assert.match(preflight, /\$OPENCLAW_BIN" --version/);
}

for (const version of [
  "v22.22.3",
  "22.22.4",
  "22.23.0",
  "v24.15.0",
  "24.16.0",
  "v25.9.0",
  "25.10.0",
  "v26.0.0",
  "27.1.2"
]) {
  assert.equal(preflightSupportsNodeVersion(version), true, `preflight accepts supported Node ${version}`);
}

for (const version of [
  "v20.99.0",
  "21.0.0",
  "22.22.2",
  "22.21.99",
  "23.0.0",
  "24.14.9",
  "25.8.99",
  "not-a-version"
]) {
  assert.equal(preflightSupportsNodeVersion(version), false, `preflight rejects unsupported Node ${version}`);
}

{
  const installScript = await readFile(new URL("./scripts/install-or-update-repo.sh", import.meta.url), "utf8");
  const rollbackScript = await readFile(new URL("./scripts/rollback-repo.sh", import.meta.url), "utf8");

  assert.match(installScript, /git clone --branch "\$BRANCH" --depth 1 "\$REPO_URL" "\$INSTALL_DIR"/);
  assert.match(installScript, /git -C "\$INSTALL_DIR" pull --ff-only origin "\$BRANCH"/);
  assert.match(installScript, /chown -R root:root "\$INSTALL_DIR"/);
  assert.match(installScript, /find "\$INSTALL_DIR" -type d -exec chmod 0755/);
  assert.match(installScript, /find "\$INSTALL_DIR" -type f -exec chmod 0644/);
  assert.match(installScript, /git -C "\$INSTALL_DIR" ls-files -z -s/);
  assert.match(installScript, /100644\)/);
  assert.match(installScript, /100755\)/);
  assert.doesNotMatch(installScript, /sudo -u "\$SERVICE_USER" git|chown "\$SERVICE_USER:\$SERVICE_GROUP" "\$INSTALL_DIR"/);
  assert.doesNotMatch(installScript, /local-operator".*name '\*\.mjs'.*chmod 0755/s);
  assert.match(rollbackScript, /git -C "\$INSTALL_DIR" switch --detach "\$revision"/);
  assert.match(rollbackScript, /chown -R root:root "\$INSTALL_DIR"/);
  assert.match(rollbackScript, /git -C "\$INSTALL_DIR" ls-files -z -s/);
  assert.match(rollbackScript, /100644\)/);
  assert.match(rollbackScript, /100755\)/);
  assert.doesNotMatch(rollbackScript, /sudo -u "\$SERVICE_USER" git/);
  assert.doesNotMatch(rollbackScript, /local-operator".*name '\*\.mjs'.*chmod 0755/s);
}

{
  const repoPath = await createModeFixtureRepo();

  try {
    await assertModeLockClean(repoPath, "deployment/scripts/install-or-update-repo.sh");
    await assertModeLockClean(repoPath, "deployment/scripts/rollback-repo.sh");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

{
  const firewall = await readFile(new URL("./scripts/firewall-ssh-hardening.sh", import.meta.url), "utf8");

  assert.match(firewall, /ss -H -ltnp/);
  assert.match(firewall, /local_address="\$\(awk '\{print \$4\}' <<<"\$line"\)"/);
  assert.match(firewall, /port="\$\{local_address##\*:\}"/);
  assert.match(firewall, /SSH_CONNECTION is missing; run from an active SSH session/);
  assert.match(firewall, /server_port="\$\(awk '\{print \$4\}' <<<"\$SSH_CONNECTION"\)"/);
  assert.match(firewall, /active SSH session port does not match detected sshd listeners/);
  assert.match(firewall, /ufw allow "\$\{port\}\/tcp"/);
  assert.match(firewall, /no listening sshd port detected; refusing to enable UFW/);
  assert.doesNotMatch(firewall, /ufw allow OpenSSH|authorized_keys/);
}

{
  const phase4Sources = await Promise.all([
    readFile(new URL("./systemd/ppo-openclaw.service", import.meta.url), "utf8"),
    readFile(new URL("./scripts/preflight-openclaw-runtime.sh", import.meta.url), "utf8"),
    readFile(new URL("./scripts/vps-health.mjs", import.meta.url), "utf8"),
    readFile(new URL("./README.md", import.meta.url), "utf8"),
    readFile(new URL("../openclaw/vps-setup.md", import.meta.url), "utf8"),
    readFile(new URL("../commands/vps-health.md", import.meta.url), "utf8")
  ]);
  const joinedSources = phase4Sources.join("\n");

  assert.match(joinedSources, /\/home\/ppo\/\.local\/openclaw\/tools\/node\/bin\/node/);
  assert.match(joinedSources, /\/home\/ppo\/\.local\/openclaw\/bin\/openclaw/);
  assert.doesNotMatch(joinedSources, /\/home\/ppo\/\.local\/openclaw\/bin\/node/);
  assert.match(joinedSources, /install-cli\.sh \| bash -s -- --prefix \/home\/ppo\/\.local\/openclaw --no-onboard/);
}

console.log("Phase 4A VPS health and deployment static tests passed.");
