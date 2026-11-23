#!/usr/bin/env bash
set -euo pipefail

# CI-only disposable database. No DSN, credentials or production Docker
# context is selected from arguments or repository deployment settings.
[[ "$#" -eq 0 || ( "$#" -eq 1 && "${1:-}" == --assignment-only ) ]] || exit 1
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || exit 1
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || exit 1
export PPO_AUTHORITY_TEST_CONTAINER="ppo-authority-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
container_id=

# An absolute limit around Docker readiness and teardown commands. Node is
# already required by this runner on both macOS and Linux.
bounded_docker() {
  node -e '
    const {spawnSync} = require("node:child_process")
    const [seconds, ...args] = process.argv.slice(1)
    const result = spawnSync("docker", args, {
      timeout: Number(seconds) * 1000, killSignal: "SIGKILL", stdio: "inherit"
    })
    process.exit(result.status === 0 ? 0 : 1)
  ' "$@"
}

trap 'if [[ "$container_id" =~ ^[a-f0-9]{64}$ ]]; then bounded_docker 20 rm -fv "$container_id" >/dev/null 2>&1 || true; fi' EXIT

start_container() {
  local name="$1" details version deadline remaining
  container_id="$(docker create --network none --name "$name" \
    -e POSTGRES_DB=ppo_authority_ci \
    -e POSTGRES_PASSWORD=disposable-ci-only-not-a-secret \
    postgres:16)"
  # Verify the actual container before any database command or cluster-wide test.
  details="$(bounded_docker 10 inspect --format '{{.Id}} {{.Name}} {{.Config.Image}} {{.HostConfig.NetworkMode}} {{.HostConfig.PublishAllPorts}} {{len .HostConfig.PortBindings}}{{range .Mounts}}{{if eq .Type "bind"}} bind{{end}}{{end}}' "$container_id")"
  [[ "$container_id" =~ ^[a-f0-9]{64}$ &&
     "$details" == "$container_id /$name postgres:16 none false 0" ]] || exit 1
  bounded_docker 30 start "$container_id" >/dev/null
  deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    if bounded_docker "$remaining" exec "$container_id" pg_isready -h 127.0.0.1 -U postgres -d ppo_authority_ci >/dev/null 2>&1; then
      remaining=$((deadline - SECONDS))
      if (( remaining > 0 )) &&
         version="$(bounded_docker "$remaining" exec "$container_id" psql -X -qAt -U postgres -d ppo_authority_ci -c 'SHOW server_version_num' 2>/dev/null)"; then
        [[ "$version" =~ ^16[0-9]{4}$ ]] || return 1
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

# Keep the standalone assignment profile and RIC-177 on separate clusters.
start_container "${PPO_AUTHORITY_TEST_CONTAINER}-assignment"
PPO_ASSIGNMENT_TEST_CONTAINER_ID="$container_id" node --test deployment/authority/postgres-offline-assignment.integration.mjs
bounded_docker 20 rm -fv "$container_id" >/dev/null
container_id=
if [[ "${1:-}" == --assignment-only ]]; then exit 0; fi

start_container "$PPO_AUTHORITY_TEST_CONTAINER"
node --test deployment/authority/phase2c-external-incarnation.integration.mjs
# Self-cleaning RIC-177 sealed gateway profile; runs before the legacy suite
# that intentionally retains its last fixture until container teardown.
node --test --test-concurrency=1 deployment/authority/phase2bc-authority-gateway.integration.mjs
node --test deployment/authority/phase1gb2-canonical-postgres.integration.mjs
