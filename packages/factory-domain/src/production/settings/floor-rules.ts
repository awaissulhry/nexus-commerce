import type { Issue } from '../../core/errors'
import { FLOOR_SESSION } from '../../auth/floor/session'
import { ONLINE_ONLY_ACTIONS } from '../../floor-sync/kinds'
import { MAX_BUNDLE_SIZE } from '../bundles/rules'
import { CLOCK_FLAG_MS, CLOCK_WARN_MS, UNDO_WINDOW_MS } from '../scans/rules'

/**
 * A site's floor rules (B-W2b-53; MES-294 "Floor rules per site", MES-128 "Scrap above a limit needs approval"; design
 * production.settings "Floor rules per site" fr-rules; factory-db production.prisma ProductionSettings, the columns of
 * B-W2b-12), pure. W1 ran every site on fixed defaults; from W2b each site keeps its own floor checks on its
 * ProductionSettings row (the office changes them with production.settings.manage; the floor reads its own site's):
 *
 *   quantityGuard         more pieces at an operation than the previous one passed (MES-097): FREE nothing stops, WARN
 *                         the scan counts and the team leader is told, STRICT the scan waits for a team leader's override
 *                         (their PIN and a reason). Default STRICT.
 *   skippedOperationRule  the sequence (MES-098): a scan that skips a required operation. FREE = relaxed sequence (any
 *                         order), WARN = the team leader is told, STRICT = strict sequence (it waits for an override).
 *                         Default WARN.
 *   scrapApprovalLimit    scrap above this many pieces in ONE scan waits for the team leader's approval before it posts
 *                         (MES-128: the replacement, the scrap of stock by lot and the cost wait for it); null: scrap
 *                         needs no approval (the default). A count on the floor; a value limit (cost grain) is not stored.
 *   bundleCodeMode        one bundle code at every operation or a coupon per operation (MES-067): read here, changed by
 *                         the bundles step (B-W2b-41).
 *   stuckBundleHours      a bundle with no scan for this long is stuck (1-720, default 4): read here, the bundles step's.
 *
 * The other rules of the design's section are not per site yet, and the answers say so (the per-site columns are a schema
 * follow-up, named in the step's notes): the undo window (UNDO_WINDOW_MS, the scans' rule), the device clock check
 * (CLOCK_WARN_MS, CLOCK_FLAG_MS) and offline limits (none: a tablet keeps every queued action until it syncs; the
 * online-only actions are held while offline). Idle sign-out IS per site, on the floor sign-in's own settings
 * (FloorSettings.idleMinutes, changed at PUT /auth/floor/sites/:siteId/settings, devices.manage).
 *
 * Nothing here records anything about a person: the checks act on counts and operations; who a record names stays the
 * monitoring switch's (monitoring.ts). A change applies from now on; scans already taken keep what they recorded.
 */

export const FLOOR_RULE_MODES = ['FREE', 'WARN', 'STRICT'] as const
export type FloorRuleMode = (typeof FLOOR_RULE_MODES)[number]

export const BUNDLE_CODE_MODES = ['ONE_CODE', 'COUPON_PER_OPERATION'] as const
export type BundleCodeMode = (typeof BUNDLE_CODE_MODES)[number]

/** One scan reports at most a bundle (MAX_BUNDLE_SIZE garments): a scrap limit above it would never be reached. */
export const MAX_SCRAP_APPROVAL_LIMIT = MAX_BUNDLE_SIZE

/** The checks of a site, as its ProductionSettings row keeps them (or the schema's defaults for a site without one). */
export interface FloorChecks {
  readonly quantityGuard: FloorRuleMode
  readonly skippedOperationRule: FloorRuleMode
  readonly scrapApprovalLimit: number | null
  readonly bundleCodeMode: BundleCodeMode
  readonly stuckBundleHours: number
}

/** The schema's defaults (factory-db production.prisma): a site without floor rules runs on them. */
export const DEFAULT_FLOOR_CHECKS: FloorChecks = Object.freeze({
  quantityGuard: 'STRICT',
  skippedOperationRule: 'WARN',
  scrapApprovalLimit: null,
  bundleCodeMode: 'ONE_CODE',
  stuckBundleHours: 4,
})

export const isFloorRuleMode = (value: unknown): value is FloorRuleMode => (FLOOR_RULE_MODES as readonly unknown[]).includes(value)

/** The site's checks: its row's, or the defaults for a site without one. */
export function floorChecksOf(row: Partial<FloorChecks> | null | undefined): FloorChecks {
  if (!row) return DEFAULT_FLOOR_CHECKS
  return Object.freeze({
    quantityGuard: row.quantityGuard ?? DEFAULT_FLOOR_CHECKS.quantityGuard,
    skippedOperationRule: row.skippedOperationRule ?? DEFAULT_FLOOR_CHECKS.skippedOperationRule,
    scrapApprovalLimit: row.scrapApprovalLimit ?? null,
    bundleCodeMode: row.bundleCodeMode ?? DEFAULT_FLOOR_CHECKS.bundleCodeMode,
    stuckBundleHours: row.stuckBundleHours ?? DEFAULT_FLOOR_CHECKS.stuckBundleHours,
  })
}

/** The rules this step's change keeps (the bundle code mode and the stuck hours are the bundles step's). */
export const FLOOR_RULE_FIELDS = ['quantityGuard', 'skippedOperationRule', 'scrapApprovalLimit'] as const
export type FloorRuleField = (typeof FLOOR_RULE_FIELDS)[number]

export interface FloorRulesChange {
  readonly quantityGuard?: FloorRuleMode | undefined
  readonly skippedOperationRule?: FloorRuleMode | undefined
  /** null: scrap needs no approval. */
  readonly scrapApprovalLimit?: number | null | undefined
}

/** What is wrong with a change of the rules (paths name the body fields); nothing named at all is a problem too. */
export function floorRulesChangeProblems(change: FloorRulesChange): Issue[] {
  const problems: Issue[] = []
  if (FLOOR_RULE_FIELDS.every((field) => change[field] === undefined)) problems.push({ path: 'body', message: 'Name at least one rule to change.' })
  for (const field of ['quantityGuard', 'skippedOperationRule'] as const) {
    const value = change[field]
    if (value !== undefined && !isFloorRuleMode(value)) problems.push({ path: `body/${field}`, message: 'Expected FREE, WARN or STRICT.' })
  }
  const limit = change.scrapApprovalLimit
  if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCRAP_APPROVAL_LIMIT)) {
    problems.push({ path: 'body/scrapApprovalLimit', message: `Expected a whole number of pieces from 1 to ${MAX_SCRAP_APPROVAL_LIMIT} (a bundle holds at most ${MAX_SCRAP_APPROVAL_LIMIT}), or none.` })
  }
  return problems
}

/** The checks after a change (only the fields it names). */
export function changedChecks(before: FloorChecks, change: FloorRulesChange): FloorChecks {
  return Object.freeze({
    ...before,
    ...(change.quantityGuard === undefined ? {} : { quantityGuard: change.quantityGuard }),
    ...(change.skippedOperationRule === undefined ? {} : { skippedOperationRule: change.skippedOperationRule }),
    ...(change.scrapApprovalLimit === undefined ? {} : { scrapApprovalLimit: change.scrapApprovalLimit }),
  })
}

/** The fields whose value differs between the two (in FLOOR_RULE_FIELDS order). */
export function changedFields(before: FloorChecks, after: FloorChecks): FloorRuleField[] {
  return FLOOR_RULE_FIELDS.filter((field) => before[field] !== after[field])
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What each rule means at the site, in words (the form's help and the change's answer). */
export const QUANTITY_GUARD_WORDS: Readonly<Record<FloorRuleMode, string>> = Object.freeze({
  FREE: 'A count above what the previous operation passed is taken as it is; nobody is told.',
  WARN: 'A count above what the previous operation passed counts, and the team leader is told.',
  STRICT: "A count above what the previous operation passed waits for a team leader's override with their PIN and a reason.",
})

export const SEQUENCE_WORDS: Readonly<Record<FloorRuleMode, string>> = Object.freeze({
  FREE: 'Relaxed sequence: operations may be scanned in any order.',
  WARN: 'A scan that skips a required operation counts, and the team leader is told.',
  STRICT: "Strict sequence: a scan that skips a required operation waits for a team leader's override with their PIN and a reason.",
})

export function scrapLimitWords(limit: number | null): string {
  return limit === null
    ? 'Scrap needs no approval, whatever the count.'
    : `Scrap above ${plural(limit, 'piece')} in one scan waits for the team leader's approval before it posts (the replacement, the scrap of stock and the cost wait for it).`
}

/** Each rule in words, in the form's order. */
export function floorChecksWords(checks: FloorChecks): string[] {
  return [QUANTITY_GUARD_WORDS[checks.quantityGuard], SEQUENCE_WORDS[checks.skippedOperationRule], scrapLimitWords(checks.scrapApprovalLimit)]
}

/** What a change means from now on, one sentence per changed rule (nothing changed: none). */
export function floorRulesChangeWords(before: FloorChecks, after: FloorChecks): string[] {
  const words: string[] = []
  for (const field of changedFields(before, after)) {
    if (field === 'quantityGuard') words.push(`From now on: ${QUANTITY_GUARD_WORDS[after.quantityGuard]}`)
    if (field === 'skippedOperationRule') words.push(`From now on: ${SEQUENCE_WORDS[after.skippedOperationRule]}`)
    if (field === 'scrapApprovalLimit') words.push(`From now on: ${scrapLimitWords(after.scrapApprovalLimit)}`)
  }
  if (words.length > 0) words.push('Scans already taken keep what they recorded.')
  return words
}

// ---- the rules that are not per site yet --------------------------------------------------------------------------------

/** The same at every site today (the answers say so; per-site columns are a schema follow-up). */
export const FIXED_FLOOR_RULES = Object.freeze({
  /** One's own last report is undone on the floor until the next scan on the device or this long after it (MES-095). */
  undoWindowSeconds: UNDO_WINDOW_MS / 1000,
  /** A tablet clock off by more than this is shown (PLT-240) … */
  clockOffSeconds: CLOCK_WARN_MS / 1000,
  /** … and flagged on the record beyond this. */
  clockFlagSeconds: CLOCK_FLAG_MS / 1000,
  /** No limit: a tablet keeps every queued action until it syncs (null hours, null actions). */
  offlineMaxHours: null,
  offlineMaxActions: null,
  /** The actions a tablet holds while offline (they need the server at once). */
  onlineOnly: Object.freeze([...ONLINE_ONLY_ACTIONS]),
})

export function fixedFloorRulesWords(): string[] {
  return [
    `Undo window: ${FIXED_FLOOR_RULES.undoWindowSeconds} seconds after the report (or until the next scan on the tablet), the same at every site.`,
    `Tablet clock: shown when it is off by more than ${FIXED_FLOOR_RULES.clockOffSeconds / 60} minutes, flagged on the record beyond ${FIXED_FLOOR_RULES.clockFlagSeconds / 3600} hours, the same at every site.`,
    'Offline: a tablet keeps every action it queues until the network is back; receiving goods, inspections, releases and garment labels wait for the network. No limit in hours or actions yet.',
  ]
}

/** Idle sign-out as the floor sign-in keeps it (FloorSettings; its defaults for a site without a row). */
export function idleSignOutWords(idleMinutes: number): string {
  return `A tablet signs its worker out after ${plural(idleMinutes, 'minute')} without use (changed with the tablets' settings of the site).`
}

export const DEFAULT_IDLE_MINUTES = FLOOR_SESSION.defaultIdleMinutes

// ---- scrap above the limit (MES-128) ----------------------------------------------------------------------------------------

/** Scrap of one scan above the site's limit waits for the team leader's approval (no limit: never). */
export function scrapNeedsApproval(scrapQuantity: number, limit: number | null): boolean {
  return limit !== null && scrapQuantity > limit
}

/** One change of a site's scrap limit, as its audit row keeps it. */
export interface LimitChange {
  readonly at: Date
  readonly before: number | null
  readonly after: number | null
}

/**
 * The limit in force at `at`: a change applies from its moment on, never to scans taken before it. The latest change at
 * or before `at` gives its new value; with none, the value before the first later change; with no change at all, the
 * site's limit now (set before any change was recorded).
 */
export function limitAt(history: readonly LimitChange[], current: number | null, at: Date): number | null {
  const sorted = [...history].sort((a, b) => a.at.getTime() - b.at.getTime())
  let found: number | null | undefined
  for (const change of sorted) if (change.at.getTime() <= at.getTime()) found = change.after
  if (found !== undefined) return found
  return sorted.length > 0 ? sorted[0]!.before : current
}

/** Since when a scan may have waited at all: the first moment any limit was in force (null: never had one). */
export function limitSince(history: readonly LimitChange[], current: number | null): Date | null | 'ALWAYS' {
  const sorted = [...history].sort((a, b) => a.at.getTime() - b.at.getTime())
  if (sorted.length === 0) return current === null ? null : 'ALWAYS'
  if (sorted[0]!.before !== null) return 'ALWAYS'
  const first = sorted.find((change) => change.after !== null)
  return first ? first.at : null
}
