import type { ApiError } from '../../../lib/api/errors'
import { isApiError } from '../../../lib/api/errors'

/**
 * What every Admin page shares (B-W0-27), pure: the money grains, how a read is loaded, the step-up dialog's state,
 * a problem in the page's words (a message key of `admin`), and the small helpers the views and the tests use. The API's
 * words never reach the screen (apps/factory-web CLAUDE.md): a refusal becomes a key here.
 */

export const GRAINS = ['price', 'cost', 'margin', 'wages', 'pay'] as const
export type Grain = (typeof GRAINS)[number]

/** A read: null items while loading; a problem (a message key) when it failed. */
export interface Loaded<T> {
  items: readonly T[] | null
  problem?: string | null
}
export const loading = <T>(): Loaded<T> => ({ items: null, problem: null })
export const loaded = <T>(items: readonly T[]): Loaded<T> => ({ items, problem: null })
export const failed = <T>(problem: string): Loaded<T> => ({ items: null, problem })

/** A notice under the page head (a receipt or a refusal), in the page's words. */
export interface Notice {
  key: string
  tone: 'success' | 'info' | 'warning' | 'danger'
  params?: Readonly<Record<string, string | number>>
  /** A bulk run's refused rows: each one's name and its problem (a message key). */
  refused?: ReadonlyArray<{ name: string; problem: string }>
}

/** The step-up dialog (a fresh authenticator code before a change that raises rights, A1 §3.10). */
export interface StepUpModel {
  open: boolean
  busy: boolean
  /** What the code allows, a message key. */
  sentence: string
  problem: string | null
}
export const STEP_UP_CLOSED: StepUpModel = { open: false, busy: false, sentence: 'stepUp.sentence.default', problem: null }

/** Rows a list shows at first, and adds with each "Show N more" (Owner L3: 50 by default, no 500). */
export const PAGE_SIZE = 50

/** The rows of the first `pages` pages, and how many the next "Show more" adds (0: every row is shown). */
export function shownOf<T>(rows: readonly T[], pages: number, size = PAGE_SIZE): { rows: readonly T[]; more: number } {
  const shown = rows.slice(0, Math.max(1, pages) * size)
  return { rows: shown, more: Math.min(size, rows.length - shown.length) }
}

/** The selected ids among the rows shown (a filter or a search that hides a row drops it from the selection). */
export function selectedAmong<T extends { id: string }>(rows: readonly T[], selected: readonly string[]): T[] {
  const held = new Set(selected)
  return rows.filter((row) => held.has(row.id))
}

/** Case- and accent-blind search over a row's words. */
export function matches(query: string, ...words: ReadonlyArray<string | null | undefined>): boolean {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const needle = fold(query.trim())
  if (needle === '') return true
  return words.some((word) => typeof word === 'string' && fold(word).includes(needle))
}

/** The grains a set of roles gives, in the fixed order (price, cost, margin, wages). */
export function grainsOf(roles: ReadonlyArray<{ grains: readonly string[] }>): Grain[] {
  const held = new Set(roles.flatMap((role) => role.grains))
  return GRAINS.filter((grain) => held.has(grain))
}

/** The `uses/<kind>` issues of an "in use" refusal (platform/admin/org): kind → count. */
export function usesOf(error: ApiError): Record<string, number> {
  const out: Record<string, number> = {}
  for (const issue of error.issues) {
    const path = typeof issue.path === 'string' ? issue.path : Array.isArray(issue.path) ? issue.path.join('/') : ''
    const match = /^uses\/(\w+)$/.exec(path)
    if (match) out[match[1]] = Number(issue.message) || 0
  }
  return out
}

/** A failed read or write as a message key of `admin` (step-up is the dialog's, not a problem). */
export function problemKey(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  switch (error.kind) {
    case 'signed_out':
      return 'problem.signedOut'
    case 'forbidden':
      return 'problem.forbidden'
    case 'step_up':
      return 'problem.stepUp'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return Object.keys(usesOf(error)).length > 0 ? 'problem.inUse' : 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'unavailable':
      return 'problem.unavailable'
    case 'contract':
      return 'problem.contract'
    default:
      return 'problem.internal'
  }
}

/** A refusal as a notice: the words for the kind, and for "in use" what still uses the row. */
export function problemNotice(error: unknown): Notice {
  const key = problemKey(error)
  if (key === 'problem.inUse' && isApiError(error)) {
    const uses = usesOf(error)
    const [kind, count] = Object.entries(uses)[0] ?? ['other', 0]
    return { key: `problem.inUseBy.${kind}`, tone: 'warning', params: { count } }
  }
  return { key, tone: key === 'problem.conflict' || key === 'problem.forbidden' ? 'warning' : 'danger' }
}

/** A wrong or refused step-up code, in the dialog's words. */
export function stepUpProblem(error: unknown): string {
  if (!isApiError(error)) return 'stepUp.problem.failed'
  if (error.kind === 'invalid') return 'stepUp.problem.wrong'
  if (error.kind === 'forbidden') return 'stepUp.problem.locked'
  if (error.kind === 'conflict') return 'stepUp.problem.noAuthenticator'
  if (error.kind === 'rate_limited') return 'stepUp.problem.tooMany'
  return 'stepUp.problem.failed'
}

/** The office address of an Admin page under `/w/<company>`. */
export const adminHref = (prefix: string, path: string) => `${prefix}/admin${path}`

/** The words that pick a status tone, one per status family. */
export const STATUS_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'>> = {
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
  INVITED: 'info',
  SUSPENDED: 'warning',
  DEACTIVATED: 'neutral',
  INACTIVE: 'neutral',
  PENDING: 'info',
  REVOKED: 'neutral',
  PAUSED: 'warning',
}

// ---- where a role applies (ScopePicker) ----

export interface ScopeChoice {
  allCompanies: boolean
  companyIds: string[]
  /** Empty: every site of the chosen companies. */
  siteIds: string[]
}

export interface ScopeOption {
  id: string
  name: string
  sites: ReadonlyArray<{ id: string; name: string }>
}

export const EVERYWHERE: ScopeChoice = { allCompanies: true, companyIds: [], siteIds: [] }

/** Where a role applies, in words: "All companies", or "Officina Demo S.r.l. › Plant 1". */
export function scopeWords(scope: { allCompanies: boolean; companyIds: readonly string[]; siteIds: readonly string[] }, companies: readonly ScopeOption[], all: string): string {
  if (scope.allCompanies) return all
  const sites = new Set(scope.siteIds)
  return scope.companyIds
    .map((id) => {
      const company = companies.find((item) => item.id === id)
      if (!company) return null
      const named = company.sites.filter((site) => sites.has(site.id)).map((site) => site.name)
      return named.length > 0 ? `${company.name} › ${named.join(', ')}` : company.name
    })
    .filter((words): words is string => !!words)
    .join(' · ')
}

/** A choice is complete: every company, or at least one named. */
export const scopeReady = (scope: ScopeChoice) => scope.allCompanies || scope.companyIds.length > 0

