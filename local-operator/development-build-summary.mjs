export const MAX_DEVELOPMENT_BUILD_SUMMARY_CHARS = 500

const unsafeTextPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:])/iu

export function safeDevelopmentBuildSummary(value) {
  const normalized = typeof value === "string" ? value.trim() : ""

  return normalized &&
    normalized.length <= MAX_DEVELOPMENT_BUILD_SUMMARY_CHARS &&
    !unsafeTextPattern.test(normalized) &&
    !sensitiveTextPattern.test(normalized)
    ? normalized
    : null
}
