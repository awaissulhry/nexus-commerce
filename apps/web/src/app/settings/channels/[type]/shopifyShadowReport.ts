/**
 * The Shopify orders shadow report card's pure half (the markup is ShopifyShadowReportCard.tsx).
 *
 *   GET /api/shopify/shadow-report/:accountId?days=60
 *
 * Read-only on the server: it reads recent Shopify orders and Nexus SKUs and answers with counts.
 * Off unless the API has NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT=1 — then the answer is "off", which the
 * card shows as information, not as a failure.
 */
import { getBackendUrl } from '@/lib/backend-url'

export interface CountRow { value: string; orders: number }
export type WeekCoverage = 'full' | 'partial' | 'none'

export interface ShopifyShadowReport {
  readOnly: true
  accountId: string
  generatedAt: string
  window: { days: number; since: string; until: string; limitedByShopify: boolean; note: string | null }
  coverage: { since: string; complete: boolean }
  read: {
    pages: number
    stoppedBecause: 'complete' | 'max_pages' | 'throttled'
    complete: boolean
    throttleWaits: number
    waitedMs: number
    locationsReadable: boolean
    ordersRead: number
    pageSize: number
    linesPerOrder: number
  }
  orders: {
    total: number
    outsideWindow: number
    cancelled: number
    test: number
    pos: number
    perWeek: Array<{ weekStart: string; orders: number | null; units: number | null; coverage: WeekCoverage }>
    financialStatus: CountRow[]
    fulfillmentStatus: CountRow[]
    sources: CountRow[]
  }
  skus: {
    lines: number
    units: number
    linesWithoutSku: number
    matchedLines: number
    matchedUnits: number
    unmatchedLines: number
    unmatchedUnits: number
    nearMatchLines: number
    deletedProductLines: number
    ordersFullyMatched: number
    ordersPartlyMatched: number
    ordersUnmatched: number
    ordersWithUnreadLines: number
    orderMatchRate: number | null
    lineMatchRate: number | null
    unmatched: Array<{ sku: string; lines: number; units: number; nearMatch: boolean }>
    unmatchedShapes: Array<{ shape: string; lines: number }>
    matchRule: string
  }
  locations: {
    used: Array<{ id: string; name: string; orders: number; fulfillments: number; cancelledFulfillments: number }>
    fulfillmentsWithoutLocation: number
    ordersWithoutFulfillment: number
    ordersWithUnreadFulfilments: number
  }
}

export type ShadowReportResult =
  | { kind: 'ok'; report: ShopifyShadowReport }
  | { kind: 'off'; message: string }
  | { kind: 'error'; message: string }

export async function fetchShopifyShadowReport(accountId: string, days = 60, fetchImpl: typeof fetch = fetch): Promise<ShadowReportResult> {
  try {
    const res = await fetchImpl(`${getBackendUrl()}/api/shopify/shadow-report/${encodeURIComponent(accountId)}?days=${days}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; report?: ShopifyShadowReport; code?: string; error?: string } | null
    if (res.ok && body?.ok && body.report) return { kind: 'ok', report: body.report }
    if (body?.code === 'SHOPIFY_SHADOW_REPORT_OFF') return { kind: 'off', message: body.error ?? 'The Shopify shadow report is switched off on this server.' }
    if (body?.error) return { kind: 'error', message: body.code ? `${body.error} (${body.code})` : body.error }
    return { kind: 'error', message: `The report could not be loaded (HTTP ${res.status}).` }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

export function readSentence(report: ShopifyShadowReport): string {
  const { read } = report
  if (read.complete) return `Complete: ${read.ordersRead} orders read in ${read.pages} page${read.pages === 1 ? '' : 's'}.`
  const why = read.stoppedBecause === 'max_pages'
    ? `stopped at the ${read.pages}-page limit`
    : 'Shopify’s rate limit ended the read'
  return `Incomplete: ${why} after ${read.ordersRead} orders.`
}

export function matchSentence(report: ShopifyShadowReport): string {
  const { skus, orders } = report
  if (orders.total === 0) return 'No orders in this window.'
  return `${skus.ordersFullyMatched} of ${orders.total} orders (${percent(skus.orderMatchRate)}) have every line matched to a Nexus product by exact SKU; ${skus.matchedLines} of ${skus.lines} lines (${percent(skus.lineMatchRate)}).`
}

/** Today's order webhook looks a line without a SKU up by its title; this report does not read titles. */
export const NO_SKU_ROW = {
  label: 'Lines without a SKU (not matched here)',
  hint: 'today’s order webhook tries the line title for these; this report does not read titles',
} as const

/** A week's count: never 0 for a week that was not read. */
export function weekCell(value: number | null, coverage: WeekCoverage): string {
  if (coverage === 'none' || value === null) return 'Not read'
  return coverage === 'partial' ? `${value} (partly read)` : String(value)
}

/** Null when every order of the window was read; otherwise from when the counts hold, and why. */
export function coverageSentence(report: ShopifyShadowReport): string | null {
  if (report.coverage.complete) return null
  const from = `Counts cover orders created from ${report.coverage.since.slice(0, 10)} on; older weeks show "Not read".`
  return report.window.note ? `${from} ${report.window.note}` : from
}
