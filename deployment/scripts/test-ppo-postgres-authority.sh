#!/usr/bin/env bash
set -euo pipefail

# CI-only disposable database. No DSN, credentials or production Docker
# context is selected from arguments or repository deployment settings.
[[ "$#" -eq 0 || ( "$#" -eq 1 && "${1:-}" == --assignment-only ) ]] || exit 1
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || exit 1
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || exit 1
export PPO_AUTHORITY_TEST_CONTAINER="ppo-authority-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
container_id=
trap 'if [[ -n "$container_id" ]]; then docker rm -fv "$container_id" >/dev/null 2>&1 || true; fi' EXIT

start_container() {
  local name="$1" details version ready=false
  container_id="$(docker run -d --network none --name "$name" \
    -e POSTGRES_DB=ppo_authority_ci \
    -e POSTGRES_PASSWORD=disposable-ci-only-not-a-secret \
    postgres:16)"
  # Verify the actual container before any database command or cluster-wide test.
  details="$(docker inspect --format '{{.Id}} {{.Name}} {{.Config.Image}} {{.HostConfig.NetworkMode}} {{.HostConfig.PublishAllPorts}} {{len .HostConfig.PortBindings}}{{range .Mounts}}{{if eq .Type "bind"}} bind{{end}}{{end}}' "$container_id")"
  [[ "$container_id" =~ ^[a-f0-9]{64}$ &&
     "$details" == "$container_id /$name postgres:16 none false 0" ]] || exit 1
  for attempt in $(seq 1 60); do
    if docker exec "$container_id" pg_isready -h 127.0.0.1 -U postgres -d ppo_authority_ci >/dev/null 2>&1 &&
       docker exec "$container_id" psql -X -qAt -U postgres -d ppo_authority_ci -c "SELECT 1" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  test "$ready" = true
  version="$(docker exec "$container_id" psql -X -qAt -U postgres -d ppo_authority_ci -c 'SHOW server_version_num')"
  [[ "$version" =~ ^16[0-9]{4}$ ]] || exit 1
}

# Keep the standalone assignment profile and RIC-177 on separate clusters.
start_container "${PPO_AUTHORITY_TEST_CONTAINER}-assignment"
PPO_ASSIGNMENT_TEST_CONTAINER_ID="$container_id" node --test deployment/authority/postgres-offline-assignment.integration.mjs
docker rm -fv "$container_id" >/dev/null
container_id=
if [[ "${1:-}" == --assignment-only ]]; then exit 0; fi

start_container "$PPO_AUTHORITY_TEST_CONTAINER"
node --test deployment/authority/phase2c-external-incarnation.integration.mjs
# Self-cleaning RIC-177 sealed gateway profile; runs before the legacy suite
# that intentionally retains its last fixture until container teardown.
node --test --test-concurrency=1 deployment/authority/phase2bc-authority-gateway.integration.mjs
node --test deployment/authority/phase1gb2-canonical-postgres.integration.mjs
