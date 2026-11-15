// Shared presentation for the existing read-only reports. No provider access.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function repositoryIdentityLabel(project, repository) {
  if (!repository?.fullName) return `${project.fullName} (configured; metadata unavailable)`
  return repository.identityConfirmed === false
    ? `${repository.fullName} (configured; identity unavailable)`
    : repository.fullName
}

export function openItems(page, key) {
  const rows = Array.isArray(page) ? page : page?.[key]
  return Array.isArray(rows) ? rows.filter(record) : []
}

export function openItemCountLabel(page, key, limit = 5) {
  const rows = Array.isArray(page) ? page : page?.[key]
  if (!Array.isArray(rows) || (!Array.isArray(page) && typeof page.limitHit !== 'boolean')) return 'unavailable'
  const declared = Array.isArray(page) ? 0 : page.invalidRowCount ?? 0
  if (!Number.isSafeInteger(declared) || declared < 0) return 'unavailable'
  const valid = rows.filter(record), invalid = declared + rows.length - valid.length
  const limitHit = Array.isArray(page) ? rows.length >= limit : page.limitHit
  if (invalid > 0) {
    return `${valid.length ? `${valid.length}+` : 'unavailable'} (incomplete; ${invalid} invalid ${invalid === 1 ? 'row' : 'rows'}${limitHit ? '; page limit hit' : ''})`
  }
  if (limitHit) return valid.length ? `${valid.length}+` : 'unknown (page limit hit)'
  return valid.length ? String(valid.length) : 'none'
}

function pullRequestLine(pr) {
  const draft = pr.draft === true ? 'draft' : pr.draft === false ? 'not draft' : 'draft status unavailable'
  const number = Number.isSafeInteger(pr.number) && pr.number > 0 ? `#${pr.number}` : 'number unavailable'
  return `- ${number} ${pr.title || 'n/a'} [${pr.headRef || 'n/a'} -> ${pr.baseRef || 'n/a'}, ${draft}] updated ${pr.updatedAt || 'n/a'}`
}

export function pullRequestLines(page) {
  return [...openItems(page, 'pullRequests')].sort((left, right) => {
    const number = pr => Number.isSafeInteger(pr.number) && pr.number > 0 ? pr.number : Infinity
    const difference = number(left) - number(right)
    if (difference) return difference
    const a = pullRequestLine(left), b = pullRequestLine(right)
    return a < b ? -1 : a > b ? 1 : 0
  }).map(pullRequestLine)
}
