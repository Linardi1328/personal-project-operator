import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  VPS_HEALTH_SERVICE,
  VPS_INSTALL_DIR,
  VPS_WRAPPER_PATH,
  collectVpsHealth,
  formatVpsHealth
} from "./scripts/vps-health.mjs";

const sensitiveSentinel = "SENSITIVE_TEST_SENTINEL";

function fakeRunner(command, args, options) {
  assert.deepEqual(options.shell, false, "health commands use shell:false");

  const key = `${command} ${args.join(" ")}`;
  const responses = new Map([
    [keyForProcessVersion(command, args), { stdout: "v24.4.0\n", stderr: sensitiveSentinel }],
    ["git --version", { stdout: "git version 2.43.0\n", stderr: sensitiveSentinel }],
    ["gh --version", { stdout: "gh version 2.97.0\nhttps://example.invalid\n", stderr: sensitiveSentinel }],
    ["openclaw --version", { stdout: "openclaw 2026.5.17\n", stderr: sensitiveSentinel }],
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

function keyForProcessVersion(command, args) {
  return `${command} ${args.join(" ")}`;
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

  assert.match(output, /- Node\.js: unavailable/);
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
  assert.match(unit, /ExecStart=\/usr\/bin\/env openclaw gateway start/);
  assert.match(unit, /EnvironmentFile=-\/etc\/personal-project-operator\/openclaw\.env/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.doesNotMatch(unit, /group:plugins|\*|TOKEN=|PASSWORD=|SECRET=|PRIVATE KEY/);
}

console.log("Phase 4A VPS health and deployment static tests passed.");
