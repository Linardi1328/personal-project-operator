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

The initial implementation at `d2899e242cb4dd0ac8f048610f6fdf49f40f926d`
passed all 27 focused tests and all seven standard quality
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


## PR #169 independent review corrections

Provider repository metadata now includes `identityConfirmed`. The compatibility
`fullName` field retains its configured fallback, but every existing report
(project status, repo/PR summaries, terminal CLI and text prompt context) labels
that fallback `(configured; identity unavailable)`. Independently returned branch
and timestamps remain visible. A missing metadata response retains the separate
`(configured; metadata unavailable)` label. Mismatched provider identities still
raise the existing safe malformed-response error.

PR and issue page results retain `rawReturnedCount`, `pageLimit`, `limitHit` and
`invalidRowCount`. Null, primitive and array rows are structurally invalid; object
records may legitimately have incomplete optional metadata. Issues with an
ambiguous, non-object `pull_request` marker are also incomplete rather than
counted as confirmed issues. Raw page saturation is calculated before excluding
PRs or malformed rows. Reports preserve valid rows and show a lower bound plus
an explicit incomplete label; entirely malformed lists are unavailable, not empty.

The additive `getOpenPullRequestsPage` API mirrors `getOpenIssuesPage`. Existing
array APIs and `getProjectSnapshot` preserve their valid-data contracts, but reject
malformed rows with `MALFORMED_GITHUB_RESPONSE`: callers that cannot carry page
metadata must not receive a silently filtered, complete-looking array. Snapshots
also include the two page envelopes for bounded-result provenance. Existing
planning/readiness consumers were inspected and remain unchanged; they use the
legacy compatibility fields and valid arrays, and fail safely on malformed lists.

Small shared display helpers keep terminal and phone PR lines, ordering, counts
and identity provenance consistent. No second reporting system or provider endpoint
is introduced. Full provider-row normalization, mixed/saturated pages, confirmed
empty results, incomplete records, all four independent source failures, pairs and
triples of failures, CLI ordering and unknown fields are covered by the corrective
tests. Project-order tests verify presence before ordering.

Corrective focused command (53 tests):

```sh
node --test local-operator/github-reporting-corrections.test.mjs local-operator/read-only-reporting-regression.test.mjs local-operator/github-readonly.test.mjs local-operator/github-ppo-status.test.mjs local-operator/github-ppo-commands.test.mjs local-operator/codex-prompt-generator.test.mjs local-operator/war-room-linear-issue-preview.test.mjs local-operator/war-room-linear-issue-preview-integration.test.mjs
```

[Corrective validation evidence](evidence/pr169-independent-corrections.txt) records
causal RED/GREEN at the reviewed head and actual final validation. Fresh hosted CI
and independent exact-head review remain separate from implementation self-checks.
The PR stays open; no merge or authority-gateway work is authorized by these changes.
