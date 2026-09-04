# Customer Zero project capabilities

`personal-project-operator.json` is the version 1 capability manifest for the fixed Customer Zero repository. Its schema is `customer-zero-project.schema.json`.

The manifest records existing runtime preparation, local quality gates, GitHub validation, and deployment-provider boundaries. It is descriptive configuration only: reading it grants no repository, runtime, GitHub, deployment, credential, or production authority. Existing reviewed controllers remain the source of operational authorization and continue to reject caller-selected overrides.
