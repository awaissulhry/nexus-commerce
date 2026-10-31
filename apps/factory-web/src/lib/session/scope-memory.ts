/**
 * The company and site a person last worked in, remembered PER PERSON (SCR-002, PLT-003, PLT-004): on a shared office
 * computer, two people who sign in one after the other each come back to their own company and site.
 *
 * Kept in one page cookie (`factory_scope`), a small JSON map keyed by `<tenantId>:<userId>`, newest first, at most
 * `MAX_PEOPLE` people. It holds codes and ids only — no names, no permissions — and it is a convenience: a remembered
 * company the person may no longer open is ignored (`recallScope`), and the API checks every company anyway.
 */

export const SCOPE_COOKIE = 'factory_scope'
export const MAX_PEOPLE = 8

export interface Person {
  tenantId: string
  userId: string
}

export interface RememberedScope {
  /** Company code. */
  company: string
  /** Site id; null = all sites. */
  site: string | null
  /**
   * B-W2b-05 (design shell.scope sec:defaults "Start page: Today (default) / a saved view I pick"): the company-free
   * address an office entry opens for this person (a list page with `?savedView=`); absent or null = Today.
   */
  start?: string | null
}

type Memory = Array<[string, RememberedScope]>

const keyOf = (person: Person) => `${person.tenantId}:${person.userId}`

function isScope(value: unknown): value is RememberedScope {
  if (typeof value !== 'object' || value === null) return false
  const { company, site, start } = value as Record<string, unknown>
  const startOk = start === undefined || start === null || (typeof start === 'string' && start.startsWith('/') && !start.startsWith('//'))
  return typeof company === 'string' && company !== '' && (site === null || typeof site === 'string') && startOk
}

/** The cookie's entries, newest first; anything unreadable is dropped, never an error. */
export function readScopeMemory(raw: string | null | undefined): Memory {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is [string, RememberedScope] => Array.isArray(entry) && typeof entry[0] === 'string' && isScope(entry[1])).slice(0, MAX_PEOPLE)
  } catch {
    return []
  }
}

/**
 * The cookie's new value after `person` worked in `scope`: their entry first, others kept, the oldest past the cap
 * dropped. Their start page is kept unless `scope.start` says another (null: back to Today).
 */
export function rememberScope(raw: string | null | undefined, person: Person, scope: RememberedScope): string {
  const key = keyOf(person)
  const memory = readScopeMemory(raw)
  const start = scope.start !== undefined ? scope.start : (memory.find(([entry]) => entry === key)?.[1].start ?? null)
  const rest = memory.filter(([entry]) => entry !== key)
  const next: Memory = [[key, { company: scope.company, site: scope.site, ...(start ? { start } : {}) }] as [string, RememberedScope], ...rest].slice(0, MAX_PEOPLE)
  return JSON.stringify(next)
}

/** B-W2b-05: the start page this person chose (a company-free address), or null for Today. */
export function recallStart(raw: string | null | undefined, person: Person): string | null {
  return readScopeMemory(raw).find(([entry]) => entry === keyOf(person))?.[1].start ?? null
}

/**
 * Where this person last worked, if they may still open that company (`allowed`, the codes they may switch to).
 * A remembered site that is not one of `sites` (when given) falls back to all sites.
 */
export function recallScope(
  raw: string | null | undefined,
  person: Person,
  allowed: { companies: readonly string[]; sites?: readonly string[] },
): RememberedScope | null {
  const found = readScopeMemory(raw).find(([entry]) => entry === keyOf(person))?.[1]
  if (!found || !allowed.companies.includes(found.company)) return null
  const site = found.site !== null && allowed.sites && !allowed.sites.includes(found.site) ? null : found.site
  return { company: found.company, site }
}

/**
 * The company an office entry point (after sign-in, `/w`) opens: the remembered one when still allowed, else the
 * session's own, else the first the person may open; null when there is none.
 */
export function landingCompany(raw: string | null | undefined, person: Person, current: string | null, companies: readonly string[]): string | null {
  return recallScope(raw, person, { companies })?.company ?? (current && companies.includes(current) ? current : null) ?? companies[0] ?? null
}
