#!/usr/bin/env bash
set -euo pipefail

# CI-only disposable database. No DSN, credentials or production Docker
# context is selected from arguments or repository deployment settings.
[[ "$#" -eq 0 && "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true ]] || exit 1
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || exit 1
export PPO_AUTHORITY_TEST_CONTAINER="ppo-authority-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
container_id="$(docker run -d --network none --name "$PPO_AUTHORITY_TEST_CONTAINER" \
  -e POSTGRES_DB=ppo_authority_ci \
  -e POSTGRES_PASSWORD=disposable-ci-only-not-a-secret \
  postgres:16)"
trap 'docker rm -fv "$container_id" >/dev/null 2>&1 || true' EXIT
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$container_id" pg_isready -h 127.0.0.1 -U postgres -d ppo_authority_ci >/dev/null 2>&1 &&
     docker exec "$container_id" psql -X -qAt -U postgres -d ppo_authority_ci -c "SELECT 1" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true
node --test deployment/authority/phase1gb2-canonical-postgres.integration.mjs
node --test deployment/authority/phase2c-external-incarnation.integration.mjs
