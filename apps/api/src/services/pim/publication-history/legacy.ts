/**
 * Sheet publish parity, step 4 — what the three older history sources (the Amazon flat file, the eBay flat file and
 * the photo runs) share: exact time literals, the cursor rule for a fixed rank, product lookups by SKU, plain counts.
 *
 * None of these sources records an account or the person who sent a run (only the Amazon photo review records its
 * person and account). A filter on something a source does not record returns no rows from it — never every row.
 */
import { Prisma } from '@prisma/client'
import type { HistoryCounts, HistoryProductResult, HistoryState } from '@nexus/shared/publication-history'
import type { StudioChannelIssue } from '@nexus/shared/studio-publication'
import prisma from '../../../db.js'
import { variationLabel } from './studio.js'
import { totalsOf, type HistoryCursor, type HistoryFilters, type HistorySourceTotals } from './types.js'

export const iso = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)
/** An exact UTC instant as the timestamp-without-time-zone the columns store. */
export const instant = (ms: number) => Prisma.sql`(${new Date(ms).toISOString()}::timestamptz AT TIME ZONE 'UTC')`
export const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, match => `\\${match}`)
export const whole = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
export const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
/** A JSON value as an array, or an empty one — never a cast error on a stored object or null. */
export const jsonArray = (column: Prisma.Sql) => Prisma.sql`(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END)`

/**
 * Strictly after the cursor in the global order (sortAt DESC, rank ASC, localId DESC), for a source of this rank. The
 * query must expose `r.started` (the sort time) and `r."localId"`.
 */
export function afterCursor(rank: number, cursor: HistoryCursor | null) {
  if (!cursor) return Prisma.empty
  const at = instant(cursor.at)
  if (rank > cursor.rank) return Prisma.sql`AND r.started <= ${at}`
  if (rank < cursor.rank) return Prisma.sql`AND r.started < ${at}`
  return Prisma.sql`AND (r.started < ${at} OR (r.started = ${at} AND r."localId" COLLATE "C" < ${cursor.id} COLLATE "C"))`
}

export function statesFilter(filters: HistoryFilters) {
  return filters.states?.length ? Prisma.sql`AND r.state IN (${Prisma.join(filters.states)})` : Prisma.empty
}

/** A source with neither an account nor a person cannot answer those filters: it returns no rows. */
export const unanswerable = (filters: HistoryFilters) => !!filters.accountId || !!filters.userId

/** No older source has runs a person marked as checked (D3 is product sheet only): `checked=true` matches none. */
export const onlyChecked = (filters: HistoryFilters) => filters.checked === true

/**
 * Exact counts over a source's own row relation — the SAME relation its list pages through, so a count equals the
 * list's length. The relation must expose `state` and `started`; older sources have no checked runs.
 */
export async function countRelation(relation: Prisma.Sql, doneSince: number): Promise<HistorySourceTotals> {
  const rows = await prisma.$queryRaw<Array<{ state: string; n: number; checked: number; done: number }>>(Prisma.sql`
    SELECT r.state, count(*)::int AS n, 0::int AS checked,
           count(*) FILTER (WHERE r.state IN ('succeeded', 'partial', 'failed') AND r.started >= ${instant(doneSince)})::int AS done
      FROM (${relation}) r
     GROUP BY r.state`)
  return totalsOf(rows)
}

/** Per-product counts that never overlap: what is not known yet is waiting (still working) or unknown (finished). */
export function legacyCounts(input: { total: number; accepted: number; failed: number; skipped?: number; notSent?: number; state: HistoryState }): HistoryCounts {
  const counts: HistoryCounts = { accepted: input.accepted, verified: 0, failed: input.failed, waiting: 0, notSent: input.notSent ?? 0, skipped: input.skipped ?? 0, unknown: 0 }
  const rest = Math.max(0, input.total - counts.accepted - counts.failed - counts.notSent - counts.skipped)
  if (input.state === 'in_progress') counts.waiting = rest
  else counts.unknown = rest
  return counts
}

export interface SkuProduct {
  productId: string
  variationLabel: string | null
}

/** The products of these SKUs in this business, one read. A SKU that is not a product here is left out. */
export async function productsBySku(skus: string[]): Promise<Map<string, SkuProduct>> {
  const wanted = [...new Set(skus.filter(Boolean))]
  if (!wanted.length) return new Map()
  const products = await prisma.product.findMany({ where: { sku: { in: wanted } }, select: { id: true, sku: true, parentId: true, variantAttributes: true } })
  return new Map(products.map(p => [p.sku, { productId: p.id, variationLabel: p.parentId ? variationLabel(p.variantAttributes) : null }]))
}

/** Failed first, then not sent, unknown, waiting, then the rest; each group by SKU (the order the studio uses). */
export const RESULT_ORDER: HistoryProductResult[] = ['FAILED', 'NOT_SENT', 'UNKNOWN', 'WAITING', 'ACCEPTED', 'VERIFIED', 'SKIPPED']
export const byResult = <T extends { result: HistoryProductResult; sku: string }>(a: T, b: T) =>
  RESULT_ORDER.indexOf(a.result) - RESULT_ORDER.indexOf(b.result) || a.sku.localeCompare(b.sku)

/** A stored issue list (Amazon's per-SKU report shape) as the channel issues the history shows. */
export function issuesOf(raw: unknown, fallback?: { code?: unknown; message?: unknown; fields?: unknown; severity: StudioChannelIssue['severity'] }): StudioChannelIssue[] {
  const list = Array.isArray(raw) ? raw.flatMap(item => {
    const issue = record(item)
    const message = text(issue.message)
    if (!message) return []
    const severity: StudioChannelIssue['severity'] = issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : issue.severity === 'ERROR' ? 'error' : issue.severity === 'WARNING' ? 'warning' : 'info'
    return [{ code: text(issue.code) ?? '', severity, message,
      attributeNames: Array.isArray(issue.attributeNames) ? issue.attributeNames.filter((n): n is string => typeof n === 'string') : [] }]
  }) : []
  if (list.length || !fallback) return list
  const message = text(fallback.message)
  if (!message) return []
  return [{ code: text(fallback.code) ?? '', severity: fallback.severity, message,
    attributeNames: Array.isArray(fallback.fields) ? fallback.fields.filter((n): n is string => typeof n === 'string') : [] }]
}

/** Older than this, a run that still says it is working has no live answer coming: a person must check it. */
export const STALE = {
  /** Amazon flat-file feeds: the poll keeps asking, but no feed takes a week. Same limit as the product sheet sweep. */
  amazonFeedMs: 7 * 24 * 60 * 60_000,
  /** The eBay flat file refuses a second push while one has run for less than 15 minutes; after that it is not running. */
  ebayPushMs: 15 * 60_000,
  /** Amazon photo feeds are polled only while their page is open. */
  photoFeedMs: 24 * 60 * 60_000,
  /** The Amazon photo worker marks a run it lost after 10 minutes; an hour without that means the worker is not running. */
  photoRunMs: 60 * 60_000,
  /** eBay and Shopify photo publishes run inside one request. */
  photoRequestMs: 30 * 60_000,
} as const

export const ago = (now: Date, ms: number) => instant(now.getTime() - ms)
