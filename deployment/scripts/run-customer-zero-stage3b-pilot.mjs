#!/usr/bin/env node

import { startKhlimAssistStage3BPilot } from "../../local-operator/customer-zero-stage3b-pilot.mjs"

if (process.argv.length !== 2) {
  process.stderr.write("Stage 3B pilot accepts no command-line arguments.\n")
  process.exit(2)
}

const result = await startKhlimAssistStage3BPilot()

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

if (result.outcome === "planned" || result.outcome === "existing") {
  process.exit(0)
}

process.exit(2)
