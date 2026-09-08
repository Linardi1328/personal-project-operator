# Customer Zero project capabilities

## Stage 1 combined validation

Run `node capabilities/validate-stage1.mjs` with no arguments. Every PPO quality
gate uses this combined check. It preserves the seven PPO checks, adds strict
parity against `ordinary-projects.json`, and reports six explicit SKIP records for
unverified remote/host acceptance. Exit zero means local configuration parity
only; SKIP never establishes readiness or deployment approval.

The versioned ordinary policy catalog covers all six existing ordinary projects.
It is a separate format from the PPO v1 manifest because remote workflow/provider
details are unverified. Symbolic approved tool references describe existing policy
and cannot be executed through the catalog. Updating runtime policy requires a
reviewed catalog update; the validator never regenerates metadata automatically.

`personal-project-operator.json` is the version 1 capability manifest for the fixed Customer Zero repository. Its schema is `customer-zero-project.schema.json`.

The manifest records existing runtime preparation, local quality gates, GitHub validation, and deployment-provider boundaries. It is descriptive configuration only: reading it grants no repository, runtime, GitHub, deployment, credential, or production authority. Existing reviewed controllers remain the source of operational authorization and continue to reject caller-selected overrides.

## Read-only PPO validator

Run `node capabilities/validate-ppo.mjs` from this checkout. No arguments are accepted.
Every approved quality gate also runs this command before its workload. A failed
or unavailable validator stops the gate with a nonzero exit code, including in
GitHub PR validation and PPO self-development. Gate names, commands, and timeout
policies remain unchanged; validation PASS alone is not a quality-gate PASS.
The command reads fixed local files, emits at most seven JSON PASS/FAIL records,
and exits nonzero on a mismatch or unreadable input. It never follows paths from
the manifest, probes credentials, launches gates, contacts GitHub, or deploys.

Checks cover the current v1 schema vocabulary, approved PPO repository/runtime
metadata, actual runtime gate definitions, runner gate names, and the local
workflow's job, step names, and commands. Deployment metadata is checked against
the approved declarative boundary, not a live provider. This is configuration
parity validation, not host readiness, remote branch protection, or CI evidence.

The workflow reader intentionally accepts only the reviewed simple YAML shape.
Changed formatting or unsupported YAML constructs fail closed and require review.
The schema evaluator supports only the vocabulary used by the checked-in v1
schema and does not resolve references or implement arbitrary JSON Schema drafts.
