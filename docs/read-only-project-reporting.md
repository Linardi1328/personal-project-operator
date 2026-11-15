# Read-only project reporting

The existing `/ppo status`, `/ppo pr <project>` and `/ppo issue RIC-…` reports
use observable provider data. They do not infer project completion, priority,
blocked work, CI readiness, permission or release authorization.

## GitHub project status

`/ppo status` keeps the fixed connected-project registry order and its existing
four sequential, bounded reads per project. Each source is attempted once.
One failed read no longer hides the other available observations:

```text
KHLIM Assist
- Repo: Linardi1328/khlim-assist
- Default: main
- Latest: abcdef1 Known update
- Open PRs: unavailable (unexpected local failure.)
- Open issues: none
- Updated: 2026-11-15T00:00:00Z
```

A confirmed empty list is `none` or `none returned`. Missing or malformed list
information is `unavailable`, never a zero count. If repository metadata is
unavailable, the configured registry repository is explicitly labeled as configured;
its default branch and updated time remain unavailable. If all four reads fail,
the existing compact project-unavailable response remains. Safe fixed provider
errors may be shown; raw exceptions and response bodies are not printed.

Project grouping is unchanged. The development-run catalog already validates its
summaries, distinguishes unavailable catalogs, and applies its reviewed ordering;
this change leaves its validation, state and ordering contract intact.

## Pull request summaries

`/ppo pr` displays the bounded returned subset in ascending PR-number order,
with deterministic display-text ties for incomplete metadata. It does not mutate
the input list. At the existing five-item page limit the count is `5+`, not an
exact total. Missing PR numbers are identified as unavailable.

Known draft metadata is `draft` or `not draft`. Missing, null or wrongly typed
draft metadata is retained as unknown and displayed as `draft status unavailable`,
including the terminal validation CLI. A non-draft PR is not called “ready”:
these reads do not establish CI, review or merge readiness.

## War Room issue previews

Linear task states remain provider-supplied text: for example `Done`, `In Progress`,
`Todo`, or `Blocked`. Missing or blank state metadata is `unknown`; it is not
mapped to completion or inferred from the issue title. A missing description is
`(description unavailable)`, distinct from an explicitly null/empty description,
which remains `(no description)`. Wrongly typed data still produces the existing
safe unavailable response. The preview retains its READ ONLY/untrusted-context
notice, fixed query, identifier checks, URL checks, sanitization and limits.

## Validation and limits

Focused regression command:

```sh
node --test local-operator/read-only-reporting-regression.test.mjs local-operator/github-readonly.test.mjs local-operator/github-ppo-status.test.mjs local-operator/github-ppo-commands.test.mjs local-operator/war-room-linear-issue-preview.test.mjs local-operator/war-room-linear-issue-preview-integration.test.mjs
```

Local validation passed all 27 focused tests and all seven standard quality
gates, including 5 witness plus 88 canonical PostgreSQL tests in a fresh
network-disabled disposable container (93 passed, no failures or skips).
The broader local Node gates used canonical `TMPDIR=/private/tmp`.

These tests use controlled provider responses; they do not establish live Linear
credential provisioning or phone-to-provider connectivity. GitHub counts remain
bounded observations. Reporting still cannot derive a complete cross-provider
completed/active/pending/blocked task inventory from open PRs or repository activity.
No reporting system, endpoint family or task-state mutation is added. RIC-177 is
separate and on hold; authority, authentication, execution and retirement policies
are outside this reporting change.
