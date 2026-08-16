# Codex Bugfix Template

Use this for one clear defect.

```text
Goal:
Fix <specific bug> in <project>.

Scope:
- Project: <project>
- Repo: <repo>
- Inspect: <files/components/logs>
- Change only the smallest set of files needed for the fix.

Requirements:
- Reproduce or explain the bug.
- Identify root cause.
- Implement the minimal fix.
- Preserve existing behavior outside the bug.

Do not change:
- Do not bundle unrelated improvements.
- Do not change public behavior except the bug fix.
- Do not add secrets, deployments, or external writes.

Tests/checks:
- Add or update a focused regression test when practical.
- Run relevant tests/checks.
- Provide manual verification if automated tests are not available.

Exit criteria:
- Bug is fixed.
- Regression coverage or manual verification is documented.
- Changed files and checks are summarized.
```

