# Acceptance fixture sandbox-readiness investigation

## Supported finding and limits

The same deterministic failure exists on main `23827bcb888e3e9a36d5ac6e9a9db006c7d47c61`
and PR #140 `52f51618d1488c9668ce7dd08898277885561a0a`.
A randomly generated base64url run ID can contain a substring recognized by the
credential detector. That ID is included in the Codex policy/probe directory.
The native sandbox command builder validates the probe working directory and
rejects credential-shaped text with `CODEX_SANDBOX_REQUIRED` before invoking the
fixture adapter. Production rejection is correct and remains unchanged.

For synthetic credential-shaped IDs, both edit and nochange child modes fail
with `readiness-failed: codex_sandbox_required`; control IDs reach readiness.
A direct adapter experiment confirmed both `rejectUnsafeText` and
`normalizeSandboxPath` in the throw stack, reporting only booleans. The successful
preceding probes were local-workspace-git, direct-network and direct-ssh-transport.
The next probe uses the policy directory containing the run ID.

This demonstrates a pre-existing intermittent fixture defect. It does **not**
prove the exact cause of GitHub run 37798610580 jobs 113384518796 and 113387046592:
the logs retain only the broad readiness code, not the failing predicate or
fixture ID. Those jobs failed 6D-EDIT and 6D-NOCHANGE respectively. Their destroyed
runner state cannot be reconstructed from those logs. Do not label their cause
as conclusively established.

## Trace and alternative predicates

`withOwnedChild` launches the same Node executable with only PATH inherited and
passes the fixture via IPC. The child calls `advance`, whose trusted runtime
profile includes explicit native sandbox configuration and the deterministic
adapter. The provider's object is validated, then `executeCodexImplementation`
normalizes the sandbox and runs its probes. The continuation layer converts a
safe error code to lowercase; the child sends the bounded readiness code. No
external Codex service or real development worker is invoked by this fixture.

All sources of `CODEX_SANDBOX_REQUIRED` in the Codex adapter were inspected:

| Predicate | Applicability |
| --- | --- |
| Missing, non-object or array sandbox | Explicit fixture object supplied |
| Empty/oversized/control/credential-shaped type, network, enforcement or platform | Fixed fixture strings |
| Network is not `none` | Fixed `none` |
| Unsupported backend or backend/platform/enforcement mismatch | Explicit native Linux in CI; native Darwin on macOS |
| Missing/invalid permission profile | Fixed `:workspace` |
| Sandbox executable/path text, absolute/canonical form, 240-character limit | Executable fixed within process; probe paths vary |
| Namespace UID/GID positive bounds and required privilege booleans | Network-namespace backend only; not selected by fixture |
| Native probe cwd normalization, including credential-shaped text | Demonstrated failing predicate for synthetic IDs |

Probe execution, network denial, platform enforcement, Git subprocess or other
sandbox establishment failures use `CODEX_SANDBOX_UNAVAILABLE` (or an ambiguity
code), not `CODEX_SANDBOX_REQUIRED`. Provider rejection instead produces
`continue_runtime_not_ready`. These distinctions narrow the investigation without
weakening any check.

## Environment and orchestration

Both CI attempts used Ubuntu 24.04.5 runner image 20261004.327.1 on different
hosted workers. Workflow gates invoke Node directly; the workflow does not pin
a Node version. Logs do not establish the exact test-process Node version.
Local reproduction used Linux and Node 24.19.0. Child environment is deliberately
restricted to PATH, while sandbox options come from the explicit fixture
profile. HOME, tokens and ambient sandbox variables are not copied to the child.

Parallel regression runs test files in separate Node processes; serial regression
sets concurrency to one. Each fixture creates a fresh canonical temporary root,
private state store and Git repository. IPC preserves its generated run ID.
No shared store or environment mutation is needed for the demonstrated failure:
it reproduces serially in an isolated child. More fixtures/gates create more
opportunities for random ID collisions with the credential pattern. There is no
evidence that load, subprocess inheritance or interference caused the two CI
failures. Concurrency is not required to reproduce this defect.

## Smallest correction and reproduction

Use fixed bytes only for the single run created in each isolated acceptance
fixture. The existing `randomBytesImpl` creation seam supplies those bytes.
Temporary roots, other random values and production run IDs remain unchanged.
Equal IDs in different private stores are independent. No retry, filtering,
allowlist change, test skip, acceptance change or sandbox bypass is introduced.

The fixture permits an explicit byte generator for negative tests. Four cases
inject synthetic credential-shaped IDs (two detector shapes, edit/nochange),
assert the existing safe failure code, ensure readiness is never signalled and
verify child termination. A control test checks equal deterministic IDs in two
distinct stores and successful readiness in both modes. Existing recovery cases
retain their original success assertions.

Run the bounded regression without accessing any owner data:

```sh
node --test local-operator/phase-6-recovery-acceptance.test.mjs
```

For the failing-path reproducer alone:

```sh
node --test --test-name-pattern='credential-shaped fixture ID' local-operator/phase-6-recovery-acceptance.test.mjs
```

## If readiness still fails

Do not infer that every broad readiness failure has this cause. The next scoped
instrumentation proposal is a closed-enum predicate classifier at sandbox
validation throw sites, carried separately from the unchanged error code through
the fixture readiness result. Suggested fixed categories distinguish sandbox
shape/fields, network mode, backend binding, profile, path text/length/canonical
form and namespace privilege fields. Only repository-owned enum members would
be serialized; unknown exceptions would map to `not_assessed`. Never serialize
raw paths, environment, arguments, stack traces or exception messages, and do not
change live recovery classification. That instrumentation is not part of this
fixture-only patch.

PR #140 remains unchanged. A green check on this separate patch cannot retroactively
clear its failed run. After owner-reviewed integration, the combined revision must
run the normal gates once; no repeated unchanged CI retries are justified here.
