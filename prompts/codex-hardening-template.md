# Codex Hardening Template

Use this after a feature exists and needs reliability, safety, and edge-case cleanup.

```text
Goal:
Harden <feature/phase> for <project>.

Scope:
- Project: <project>
- Repo: <repo>
- Inspect: <files/components/tests>
- Change only code related to <feature/phase>.

Requirements:
- Find and fix edge cases.
- Improve error handling and empty states.
- Preserve existing behavior outside the scoped feature.
- Add or update focused tests where appropriate.

Do not change:
- Do not add new product scope.
- Do not refactor unrelated areas.
- Do not add secrets, live writes, deployments, or paid API calls.

Tests/checks:
- Run relevant unit/integration checks.
- Run lint/type checks if available.
- Document any checks that cannot run.

Exit criteria:
- Known edge cases are handled.
- Tests/checks pass or failures are explained.
- Summary includes risks that remain.
```

