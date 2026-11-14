# Generated ID validity and positive fixture domains

## Retirement request encoding correction

This is a separate existing-bug correction from exact main
`3207553da0c301adb04618f1b71fa20bbfecf90b`. It changes only the encoding of
fresh retirement request IDs: 32 cryptographically random bytes now become
64 lowercase hexadecimal characters instead of 43 base64url characters.
Entropy remains 256 bits. The opaque ID is still bound into the exact owner
challenge, used once, and included in the audited transition reason.

Base64url can produce strings containing `sk-` or `ghp_`. Interpolating one
into the retirement reason causes the existing sensitive-text detector to
reject the otherwise valid transition with `INVALID_REASON`; the retirement
boundary deliberately reports the generic `retirement_unavailable`. Hex
cannot contain those sensitive-prefix alphabets. The detector is unchanged.

Deterministic RED on the original generator used controlled 32-byte values
whose canonical base64url representations are `sk-` followed by 40 `A`s,
and `ghp_` followed by 39 `A`s. Actual staging succeeded, but concurrent
confirmation produced this exact pair for both inputs:

```text
actual:   [retirement_unavailable, retirement_request_unavailable]
expected: [retired, retirement_request_unavailable]
```

A neutral all-zero value reached `retired` before failing the new expected
hex assertion. The pre-fix output is preserved locally at
`/tmp/ric157-retirement-token-red.log`. After the one-line correction, all
three controlled-byte stage/confirm cases succeed, preserve prior history,
bind the exact 64-character ID into challenge/reason, reject restart replay,
and consume concurrent confirmation exactly once. The crypto builtin is
mocked only during test staging and restored in `finally` with builtin ESM
exports synchronized. No runtime randomness override or privilege seam is
introduced. A fourth regression directly requires both sensitive reasons to
remain `INVALID_REASON` with all fixture files byte-for-byte unchanged.

The retirement-focused suite has 36 passing tests (32 existing plus four new), including
expiry, exact owner confirmation, single use, restart, quiescence checks,
version conflict, ambiguous durability and historical-marker preservation:

```sh
TMPDIR=/private/tmp node --test local-operator/development-run-retirement.test.mjs
```

Validation uses the task-local official Node 24.20.0 runtime; full gate
results are reported separately against the committed head. The original
intermittent retirement CI incident did not log its random request ID, so this proves
an independent generator defect and matching failure pair, not the cause of
that original incident. No real record is retired or rewritten. RIC-59 and
RIC-61 holds, missing production quiescence integration, and pilot approval
requirements remain unchanged.

## Adapter positive-fixture domain correction

A separate acceptance failure occurred in the unchanged clean-descendant
orphan recovery test: it received `CODEX_SANDBOX_REQUIRED` while expecting
`CODEX_EXECUTION_AMBIGUOUS`. Deterministic scratch runs of that complete test
passed for the canonical all-`A` run ID and failed for canonical IDs `sk-`
followed by 40 `A`s and `ghp_` followed by 39 `A`s. The sensitive-path policy
intentionally rejects the execution-policy path containing these IDs.
Scratch inputs and logs remain at `/tmp/ric157-codex-path-domain-*`; the
original CI run ID was not logged, so attribution to this path remains
conditional rather than proven.

Ordinary adapter test fixtures now use the existing `createDevelopmentRun`
`randomBytesImpl` option with a module-local counter padded to 32 lowercase
hex characters and encoded as **32 ASCII bytes**, not 16 hex-decoded bytes.
Those bytes yield unique canonical 43-character base64url IDs without `-`
or `_`. An optional test-fixture override retains explicit adverse IDs.
The positive-domain test checks uniqueness, byte length, character domain,
and canonical round trip. Every existing orphan-recovery assertion remains.

Two deterministic adverse-ID cases still require `CODEX_SANDBOX_REQUIRED`,
zero implementation-runner calls, unchanged run state, source/workspace Git
heads and clean workspace, and no implementation effect file. The existing
mocked local-Git, network and SSH preflight probes occur before this denial;
the tests assert that exact probe-only sequence. An initial assertion that
even those preflight callbacks were absent failed and is preserved at
`/tmp/ric157-codex-fixture-domain-focused.log`; the correction reflects the
existing sequence without changing runtime policy or allowing execution.

**Unresolved operational compatibility blocker before pilot:** production
run IDs remain unrestricted random canonical base64url IDs. Some valid IDs
can therefore still fall outside the sensitive-path policy's permitted
domain. Constraining positive fixtures does not fix that production
incompatibility. The runtime path denial remains fail closed; this follow-up
changes no production run-ID generator, sandbox policy, filter, injection
API, or authorization boundary. The only production change in this PR
remains retirement's one-line request-ID hexadecimal encoding.
