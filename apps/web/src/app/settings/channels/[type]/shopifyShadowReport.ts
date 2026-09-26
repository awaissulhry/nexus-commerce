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

export interface ShopifyShadowReport {
  readOnly: true
  accountId: string
  generatedAt: string
  window: { days: number; since: string; until: string; note: string }
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
    perWeek: Array<{ weekStart: string; orders: number; units: number }>
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
  }
  locations: {
    used: Array<{ id: string; name: string; orders: number; fulfillments: number; cancelledFulfillments: number }>
    fulfillmentsWithoutLocation: number
    ordersWithoutFulfillment: number
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
  return `Incomplete: ${why} after ${read.ordersRead} orders. The counts cover only those orders.`
}

export function matchSentence(report: ShopifyShadowReport): string {
  const { skus, orders } = report
  if (orders.total === 0) return 'No orders in this window.'
  return `${skus.ordersFullyMatched} of ${orders.total} orders (${percent(skus.orderMatchRate)}) have every line matched to a Nexus SKU; ${skus.matchedLines} of ${skus.lines} lines (${percent(skus.lineMatchRate)}).`
}
