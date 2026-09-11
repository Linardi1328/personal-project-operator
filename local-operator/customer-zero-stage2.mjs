import { resolveCustomerZeroProvider } from "./customer-zero-provider-contracts.mjs"
import { projectDevelopmentRunMetrics } from "./development-run-metrics.mjs"
import {
  assertDevelopmentRunEvidenceOwnership,
  resolveDevelopmentRunOwnership,
  RUN_UNIT_INTERFACE_CONTRACT
} from "./development-run-ownership-context.mjs"

const allowedOptions = new Set(["requestedContext"])

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

export function inspectCustomerZeroStage2Run(run, options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowedOptions.has(key))
  ) {
    throw new TypeError("Stage 2 inspection options are invalid.")
  }
  const ownership = resolveDevelopmentRunOwnership(run, options)
  assertDevelopmentRunEvidenceOwnership(run, ownership)
  const providerCapabilities = Object.fromEntries(
    ["backend", "frontend", "optional-frontend", "preview", "deployment"].map((capability) => [
      capability,
      resolveCustomerZeroProvider({
        ownershipContext: ownership.context,
        capability
      })
    ])
  )
  return deepFreeze({
    schemaVersion: 1,
    ownership,
    runUnit: RUN_UNIT_INTERFACE_CONTRACT,
    providers: providerCapabilities,
    metrics: projectDevelopmentRunMetrics(run, options)
  })
}
