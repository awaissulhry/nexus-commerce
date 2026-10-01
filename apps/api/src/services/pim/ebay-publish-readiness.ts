/**
 * Audit P5 (2026-10-01) — readiness agrees with publish on what eBay needs for a NEW listing beyond its category's fields:
 * an item location (country with a postal code or city) and the three business policies. Readiness showed "Ready 100%"
 * while publish refused for them.
 *
 * Publish fills both from the eBay account when it can (`studio-publication-ebay.ts`), so readiness names one only when
 * Nexus KNOWS publish could not fill it (`ebay-account-defaults.ts` keeps what the last successful eBay read found):
 *   · the location: none on the main row, none stored for the account, none on the server, and the last read of the
 *     account found no usable location;
 *   · a policy: none on the main row, no account default, and the last read of this market found no policy of that kind.
 * Never read = not known = not named: a guess would refuse a listing eBay would take. A listing already on eBay keeps its
 * location and policies (a revision does not send them), so it is never named here.
 */
import prisma from '../../db.js'
import {
  EBAY_POLICY_FIELD, EBAY_POLICY_KINDS, ebayLocationKnownMissing, ebayPolicyKnownMissing, isCompleteEbayLocation, resolveEbayItemLocation,
} from '../ebay-account-defaults.js'
import type { ReadinessIssue } from './sheet-rows.service.js'
import { isEbayItemLevel } from './ebay-listing-level.js'

type Store = { kind?: string; path?: string[] } | undefined
interface RowLike {
  parentId: string | null
  listing?: { externalListingId?: string | null } | null
  values: Record<string, { value?: unknown } | undefined>
  readiness: { state: string; issues: ReadinessIssue[] }
}
interface ColumnLike { key: string; label: string; channels?: Record<string, { store?: unknown } | undefined> }

const blank = (value: unknown) => value == null || (typeof value === 'string' && !value.trim())
const POLICY_WORD = { shipping: 'shipping', payment: 'payment', return: 'return' } as const

/**
 * The problems for ONE main row, from its own values (`valueOf(field)`, undefined when the sheet has no such column) and
 * the account's stored metadata. Pure.
 */
export function ebayPublishReadinessIssues(input: { market: string; metadata: unknown; valueOf: (field: string) => unknown; labelOf: (field: string) => string; keyOf: (field: string) => string | undefined; env?: NodeJS.ProcessEnv }): ReadinessIssue[] {
  const issues: ReadinessIssue[] = []
  const metadata = (input.metadata ?? {}) as Record<string, any>
  const location = resolveEbayItemLocation({ country: input.valueOf('itemLocationCountry'), postalCode: input.valueOf('itemPostalCode'), city: input.valueOf('itemLocation') }, metadata, input.env)
  const locationKey = input.keyOf('itemPostalCode') ?? input.keyOf('itemLocationCountry')
  if (locationKey && !isCompleteEbayLocation(location) && ebayLocationKnownMissing(metadata) === true) {
    issues.push({ key: locationKey, label: input.labelOf('itemPostalCode'), severity: 'error',
      message: 'eBay needs the item location country and a postal code or city to create a listing, and this eBay account has no location Nexus can use. Set them on this row.' })
  }
  const known = ebayPolicyKnownMissing(metadata, input.market)
  const defaults = (metadata.ebayPolicies ?? {}) as Record<string, unknown>
  for (const kind of EBAY_POLICY_KINDS) {
    const field = EBAY_POLICY_FIELD[kind], key = input.keyOf(field)
    if (!key || !blank(input.valueOf(field)) || !blank(defaults[field]) || known[kind] !== true) continue
    issues.push({ key, label: input.labelOf(field), severity: 'error',
      message: `This eBay account has no ${POLICY_WORD[kind]} policy for eBay ${input.market}. Create one in eBay (Account › Business policies).` })
  }
  return issues
}

/** On each main row of a not-yet-live eBay listing in this sheet: the account's stored facts, one read per sheet. */
export async function addEbayPublishReadiness(input: { rows: RowLike[]; columns: ColumnLike[]; label: string; market: string; accountId: string }) {
  const mains = input.rows.filter(row => row.parentId === null && !row.listing?.externalListingId)
  if (!mains.length) return
  const columnFor = (field: string) => input.columns.find(col => {
    const store = col.channels?.[input.label]?.store as Store
    return store?.kind === 'platformAttributes' && store.path?.length === 1 && store.path[0] === field
  })
  // An extra the sheet can do without: an account that cannot be read is "not known", so nothing is named (never a guess).
  let account: { connectionMetadata: unknown } | null = null
  try { account = await prisma.channelConnection.findUnique({ where: { id: input.accountId }, select: { connectionMetadata: true } }) } catch { return }
  if (!account) return
  for (const row of mains) {
    const found = ebayPublishReadinessIssues({ market: input.market, metadata: account.connectionMetadata,
      keyOf: field => columnFor(field)?.key, labelOf: field => columnFor(field)?.label ?? field,
      valueOf: field => { const column = columnFor(field); return column ? row.values[column.key]?.value : undefined } })
    if (!found.length) continue
    row.readiness.issues.push(...found)
    // The row's own state rule (as the variation items above do): an error dominates every other state.
    row.readiness.state = 'errors'
  }
}

interface VariationRowLike<C> {
  parentId: string | null
  aliasId?: string | null
  values: Record<string, { mapped?: { errors?: string[] } | null } | undefined>
  readiness: { state: string; issues: ReadinessIssue[] }
  completeness: C
}

/** Whether a sheet column holds an eBay item-level field (`isEbayItemLevel`) on this coordinate. */
export const isEbayItemLevelColumn = (column: ColumnLike, label: string) => isEbayItemLevel(column.channels?.[label]?.store as Parameters<typeof isEbayItemLevel>[0])

/**
 * Follow-up 2026-10-01 (live check: "Condition is required" on all 20 variations of GALE-JACKET) — an eBay variation
 * listing takes its item-level fields once, from its main row; a variation row's own value is never sent. So on a
 * VARIATION row of a listing that has a main row, those fields name no readiness issue and no cell error, and the row's
 * completeness is counted without them. The main row is judged as before. `recount` and `restate` are the sheet's own
 * rules (`completenessFor`, the row state rule), handed in so this stays one rule with them.
 */
export function judgeEbayItemLevelOnMainRow<C, R extends VariationRowLike<C>>(input: { rows: R[]; columns: ColumnLike[]; label: string
  recount: (row: R, columns: ColumnLike[]) => C; restate: (row: R) => string }) {
  const itemLevel = input.columns.filter(column => isEbayItemLevelColumn(column, input.label))
  if (!itemLevel.length) return
  const keys = new Set(itemLevel.map(column => column.key))
  const rest = input.columns.filter(column => !keys.has(column.key))
  const withMain = new Set(input.rows.filter(row => row.parentId === null).map(row => row.aliasId ?? ''))
  for (const row of input.rows) {
    if (row.parentId === null || !withMain.has(row.aliasId ?? '')) continue
    for (const key of keys) {
      const cell = row.values[key]
      if (cell?.mapped?.errors?.length) row.values[key] = { ...cell, mapped: { ...cell.mapped, errors: [] } }
    }
    row.readiness.issues = row.readiness.issues.filter(issue => !keys.has(issue.key))
    row.readiness.state = input.restate(row)
    row.completeness = input.recount(row, rest)
  }
}
