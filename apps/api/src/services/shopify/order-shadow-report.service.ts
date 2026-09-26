/**
 * Shopify orders shadow report — measure before building order ingest.
 *
 * The review of PLAN-SHOPIFY-ORDERS.md (2026-09-26) asked for this first: how many Shopify orders
 * there really are, how many of their lines the order webhook would match to a Nexus product, and
 * which fulfilment locations ship them. Nexus holds 0 Shopify orders today, so none of that can be
 * read from our own tables; it has to be read from Shopify.
 *
 * What it does:
 *   - reads the account's orders created in a bounded window (default 60 days — Shopify returns only
 *     the last 60 without `read_all_orders`; at most 90), newest first, a page at a time, through the
 *     read-only admin reader (the channel gateway, `kind: 'read'`), pacing itself by Shopify's cost
 *     bucket and stopping at a page bound;
 *   - matches line SKUs the way the order webhook does today (the exact SKU in this business, via the
 *     workspace SKU key — a soft-deleted product still matches, and is flagged);
 *   - returns counts only.
 *
 * What it never does: write anything (no order, hold, stock, listing or Shopify change — the only row
 * a run adds is the gateway's own call-log row per Shopify read), ask Shopify for a buyer field, or
 * return one. Off unless NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT is exactly '1'.
 */
import prisma from '../../db.js'
import { shopifyAdminReader, type ShopifyGraphqlError, type ShopifyReadGraphql } from './admin-client.js'

export const SHOPIFY_SHADOW_REPORT_SWITCH = 'NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT'
export const DEFAULT_WINDOW_DAYS = 60
export const MAX_WINDOW_DAYS = 90
const PAGE_SIZE = 20
const LINES_PER_ORDER = 20
const FULFILMENTS_PER_ORDER = 5
const DEFAULT_MAX_PAGES = 25
const DEFAULT_MAX_WAIT_MS = 20_000
const LIST_LIMIT = 25
const DAY_MS = 86_400_000

export function shopifyShadowReportEnabled(): boolean {
  return process.env[SHOPIFY_SHADOW_REPORT_SWITCH] === '1'
}

/** A refusal or failure with the HTTP status the route answers with. */
export class ShadowReportError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message)
    this.name = 'ShadowReportError'
  }
}

/**
 * The only document this report sends. No order id, number or name, no customer, address, contact,
 * note, attribute or line title: only what the counts need. Cost ≈ 2 + 20 × (1 + 22 + 10) < 1,000,
 * Shopify's single-query cap.
 */
export const SHADOW_ORDERS_QUERY = `query NexusShadowOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt
      cancelledAt
      test
      sourceName
      displayFinancialStatus
      displayFulfillmentStatus
      lineItems(first: ${LINES_PER_ORDER}) { pageInfo { hasNextPage } nodes { sku quantity } }
      fulfillments(first: ${FULFILMENTS_PER_ORDER}) { status location { id name } }
    }
  }
}`

export interface ShadowOrder {
  createdAt: string
  cancelledAt: string | null
  test: boolean
  sourceName: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string | null
  lineItems: { pageInfo?: { hasNextPage?: boolean } | null; nodes: Array<{ sku: string | null; quantity: number }> } | null
  fulfillments: Array<{ status: string | null; location: { id: string; name: string } | null }> | null
}

export type StopReason = 'complete' | 'max_pages' | 'throttled'

export interface ShadowRead {
  orders: ShadowOrder[]
  pages: number
  stoppedBecause: StopReason
  throttleWaits: number
  waitedMs: number
  locationsReadable: boolean
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10)

/** Only a location Shopify will not show (a missing scope) is survivable: the orders are still there. */
function onlyLocationDenied(errors: ShopifyGraphqlError[]): boolean {
  return errors.length > 0 && errors.every((e) => e.extensions?.code === 'ACCESS_DENIED' && (e.path ?? []).includes('location'))
}

/**
 * Reads every order created since `since` (Shopify is asked from the day before; the exact boundary
 * is applied by the aggregation). Paces by `extensions.cost`: when the bucket cannot pay for another
 * page, it waits for the refill, and stops as `throttled` once the waits would pass `maxWaitMs`. The
 * gateway already retries a THROTTLED answer twice; one that still arrives ends the read with what it
 * has (an error when nothing was read yet).
 */
export async function readShadowOrders(
  read: ShopifyReadGraphql,
  opts: { since: Date; maxPages?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<ShadowRead> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const filter = `created_at:>=${isoDate(new Date(opts.since.getTime() - DAY_MS))}`
  const orders: ShadowOrder[] = []
  let after: string | null = null
  let pages = 0
  let throttleWaits = 0
  let waitedMs = 0
  let locationsReadable = true

  for (;;) {
    if (pages >= maxPages) return { orders, pages, stoppedBecause: 'max_pages', throttleWaits, waitedMs, locationsReadable }
    type Page = { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShadowOrder[] } }
    const result = await read<Page>(SHADOW_ORDERS_QUERY, { first: PAGE_SIZE, after, query: filter })
    if (result.errors.some((e) => e.extensions?.code === 'THROTTLED')) {
      if (pages === 0) throw new ShadowReportError('SHOPIFY_THROTTLED', 'Shopify is rate-limiting this account right now; nothing was read. Try again in a minute.', 429)
      return { orders, pages, stoppedBecause: 'throttled', throttleWaits, waitedMs, locationsReadable }
    }
    if (result.errors.length > 0) {
      if (!onlyLocationDenied(result.errors) || !result.data) {
        const messages = result.errors.map((e) => e.message).join('; ').slice(0, 300)
        throw new ShadowReportError('SHOPIFY_QUERY_FAILED', `Shopify refused the order read: ${messages}`, 502)
      }
      locationsReadable = false
    }
    const connection = result.data?.orders
    if (!connection) throw new ShadowReportError('SHOPIFY_QUERY_FAILED', 'Shopify returned no orders field.', 502)
    pages++
    orders.push(...(connection.nodes ?? []))
    if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
      return { orders, pages, stoppedBecause: 'complete', throttleWaits, waitedMs, locationsReadable }
    }
    after = connection.pageInfo.endCursor

    const bucket = result.cost?.throttleStatus
    const needed = result.cost?.requestedQueryCost ?? null
    if (bucket && needed !== null && bucket.currentlyAvailable < needed) {
      const waitMs = Math.ceil(((needed - bucket.currentlyAvailable) / Math.max(bucket.restoreRate, 1)) * 1000)
      if (waitedMs + waitMs > maxWaitMs) return { orders, pages, stoppedBecause: 'throttled', throttleWaits, waitedMs, locationsReadable }
      await sleep(waitMs)
      throttleWaits++
      waitedMs += waitMs
    }
  }
}

// ── The counts (pure) ───────────────────────────────────────────────────────

export interface CountRow { value: string; orders: number }
export interface UnmatchedSku { sku: string; lines: number; units: number; nearMatch: boolean }

export interface ShadowCounts {
  orders: {
    total: number
    /** Read (Shopify's date filter is a day wider) but created before the window: not counted. */
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
    /** Unmatched lines whose SKU equals a Nexus SKU once case and spaces are ignored. */
    nearMatchLines: number
    /** Matched lines whose product is soft-deleted: the webhook would still hold stock on it. */
    deletedProductLines: number
    ordersFullyMatched: number
    ordersPartlyMatched: number
    ordersUnmatched: number
    /** Orders with more lines than one read returns (the count covers the lines read). */
    ordersWithUnreadLines: number
    orderMatchRate: number | null
    lineMatchRate: number | null
    unmatched: UnmatchedSku[]
    unmatchedShapes: Array<{ shape: string; lines: number }>
  }
  locations: {
    used: Array<{ id: string; name: string; orders: number; fulfillments: number; cancelledFulfillments: number }>
    fulfillmentsWithoutLocation: number
    ordersWithoutFulfillment: number
  }
}

/** A SKU's form without its value: letter runs → A / a, digit runs → 9, everything else kept. */
export function skuShape(sku: string): string {
  return sku.replace(/[A-Z]+/g, 'A').replace(/[a-z]+/g, 'a').replace(/[0-9]+/g, '9').slice(0, 40)
}

const fold = (sku: string) => sku.trim().toLowerCase()

/** Monday 00:00 UTC of the date's week. */
function weekStart(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS)
}

function countRows(counts: Map<string, number>, limit = LIST_LIMIT): CountRow[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([value, orders]) => ({ value, orders }))
}

const bump = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by)

export function aggregateShadowReport(input: {
  orders: ShadowOrder[]
  products: Array<{ sku: string; deletedAt: Date | null }>
  since: Date
  until: Date
}): ShadowCounts {
  const exact = new Map(input.products.map((p) => [p.sku, p.deletedAt !== null]))
  const folded = new Set(input.products.map((p) => fold(p.sku)))
  const inWindow = input.orders.filter((o) => new Date(o.createdAt).getTime() >= input.since.getTime())

  const weeks = new Map<string, { orders: number; units: number }>()
  for (let w = weekStart(input.since); w.getTime() <= input.until.getTime(); w = new Date(w.getTime() + 7 * DAY_MS)) {
    weeks.set(isoDate(w), { orders: 0, units: 0 })
  }
  const financial = new Map<string, number>()
  const fulfilment = new Map<string, number>()
  const sources = new Map<string, number>()
  const unmatched = new Map<string, UnmatchedSku>()
  const locations = new Map<string, ShadowCounts['locations']['used'][number]>()
  const skus = {
    lines: 0, units: 0, linesWithoutSku: 0, matchedLines: 0, matchedUnits: 0, unmatchedLines: 0, unmatchedUnits: 0,
    nearMatchLines: 0, deletedProductLines: 0, ordersFullyMatched: 0, ordersPartlyMatched: 0, ordersUnmatched: 0, ordersWithUnreadLines: 0,
  }
  let cancelled = 0
  let test = 0
  let pos = 0
  let fulfillmentsWithoutLocation = 0
  let ordersWithoutFulfillment = 0

  for (const order of inWindow) {
    if (order.cancelledAt) cancelled++
    if (order.test) test++
    const source = order.sourceName?.trim() || 'unknown'
    if (source === 'pos') pos++
    bump(sources, source)
    bump(financial, order.displayFinancialStatus ?? 'UNKNOWN')
    bump(fulfilment, order.displayFulfillmentStatus ?? 'UNKNOWN')

    const lines = order.lineItems?.nodes ?? []
    if (order.lineItems?.pageInfo?.hasNextPage) skus.ordersWithUnreadLines++
    let matched = 0
    let orderUnits = 0
    for (const line of lines) {
      const units = Number.isFinite(line.quantity) ? line.quantity : 0
      orderUnits += units
      skus.lines++
      skus.units += units
      const sku = line.sku ?? ''
      if (sku.trim() === '') { skus.linesWithoutSku++; continue }
      if (exact.has(sku)) {
        matched++
        skus.matchedLines++
        skus.matchedUnits += units
        if (exact.get(sku)) skus.deletedProductLines++
        continue
      }
      const near = folded.has(fold(sku))
      skus.unmatchedLines++
      skus.unmatchedUnits += units
      if (near) skus.nearMatchLines++
      const row = unmatched.get(sku) ?? { sku, lines: 0, units: 0, nearMatch: near }
      row.lines++
      row.units += units
      unmatched.set(sku, row)
    }
    if (lines.length > 0 && matched === lines.length) skus.ordersFullyMatched++
    else if (matched > 0) skus.ordersPartlyMatched++
    else skus.ordersUnmatched++

    const week = weeks.get(isoDate(weekStart(new Date(order.createdAt))))
    if (week) { week.orders++; week.units += orderUnits }

    const fulfilments = order.fulfillments ?? []
    if (fulfilments.length === 0) ordersWithoutFulfillment++
    const seen = new Set<string>()
    for (const f of fulfilments) {
      if (!f.location?.id) { fulfillmentsWithoutLocation++; continue }
      const row = locations.get(f.location.id) ?? { id: f.location.id, name: f.location.name, orders: 0, fulfillments: 0, cancelledFulfillments: 0 }
      row.fulfillments++
      if ((f.status ?? '').toUpperCase() === 'CANCELLED') row.cancelledFulfillments++
      if (!seen.has(f.location.id)) { row.orders++; seen.add(f.location.id) }
      locations.set(f.location.id, row)
    }
  }

  const unmatchedRows = [...unmatched.values()].sort((a, b) => b.lines - a.lines || b.units - a.units || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
  const shapes = new Map<string, number>()
  for (const row of unmatchedRows) bump(shapes, skuShape(row.sku), row.lines)

  return {
    orders: {
      total: inWindow.length,
      outsideWindow: input.orders.length - inWindow.length,
      cancelled,
      test,
      pos,
      perWeek: [...weeks.entries()].map(([start, w]) => ({ weekStart: start, orders: w.orders, units: w.units })),
      financialStatus: countRows(financial),
      fulfillmentStatus: countRows(fulfilment),
      sources: countRows(sources, 10),
    },
    skus: {
      ...skus,
      orderMatchRate: inWindow.length ? skus.ordersFullyMatched / inWindow.length : null,
      lineMatchRate: skus.lines ? skus.matchedLines / skus.lines : null,
      unmatched: unmatchedRows.slice(0, LIST_LIMIT),
      unmatchedShapes: countRows(shapes, 10).map((row) => ({ shape: row.value, lines: row.orders })),
    },
    locations: {
      used: [...locations.values()].sort((a, b) => b.fulfillments - a.fulfillments || (a.name < b.name ? -1 : 1)),
      fulfillmentsWithoutLocation,
      ordersWithoutFulfillment,
    },
  }
}

// ── Nexus SKUs (read only) ──────────────────────────────────────────────────

/** The Nexus products whose SKU equals a line SKU exactly, or ignoring case and spaces. Reads only. */
async function nexusProductsFor(orders: ShadowOrder[]): Promise<Array<{ sku: string; deletedAt: Date | null }>> {
  const raw = [...new Set(orders.flatMap((o) => (o.lineItems?.nodes ?? []).map((l) => l.sku ?? '')).filter((s) => s.trim() !== ''))]
  const candidates = [...new Set([...raw, ...raw.map((s) => s.trim())])]
  const found = new Map<string, { sku: string; deletedAt: Date | null }>()
  for (let i = 0; i < candidates.length; i += 500) {
    const chunk = candidates.slice(i, i + 500)
    const rows = await prisma.product.findMany({ where: { sku: { in: chunk, mode: 'insensitive' } }, select: { sku: true, deletedAt: true } })
    for (const row of rows) found.set(row.sku, row)
  }
  return [...found.values()]
}

// ── The report ──────────────────────────────────────────────────────────────

export interface ShopifyShadowReport extends ShadowCounts {
  readOnly: true
  accountId: string
  generatedAt: string
  window: { days: number; since: string; until: string; note: string }
  read: Omit<ShadowRead, 'orders'> & { complete: boolean; ordersRead: number; pageSize: number; linesPerOrder: number }
}

export async function shopifyShadowReport(
  accountId: string,
  opts: { days?: number; now?: Date; sleep?: (ms: number) => Promise<void>; maxPages?: number } = {},
): Promise<ShopifyShadowReport> {
  if (!shopifyShadowReportEnabled()) {
    throw new ShadowReportError('SHOPIFY_SHADOW_REPORT_OFF', `The Shopify shadow report is switched off on this server (${SHOPIFY_SHADOW_REPORT_SWITCH}).`, 404)
  }
  const days = opts.days ?? DEFAULT_WINDOW_DAYS
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    throw new ShadowReportError('SHOPIFY_SHADOW_REPORT_WINDOW', `The window is a whole number of days from 1 to ${MAX_WINDOW_DAYS}.`, 400)
  }
  const until = opts.now ?? new Date()
  const since = new Date(until.getTime() - days * DAY_MS)
  const { read } = await shopifyAdminReader(accountId)
  const result = await readShadowOrders(read, { since, sleep: opts.sleep, maxPages: opts.maxPages })
  const products = await nexusProductsFor(result.orders)
  const counts = aggregateShadowReport({ orders: result.orders, products, since, until })
  return {
    readOnly: true,
    accountId,
    generatedAt: until.toISOString(),
    window: {
      days,
      since: since.toISOString(),
      until: until.toISOString(),
      note: 'Shopify returns only the last 60 days of orders unless the app holds the read_all_orders permission.',
    },
    read: {
      pages: result.pages,
      stoppedBecause: result.stoppedBecause,
      complete: result.stoppedBecause === 'complete',
      throttleWaits: result.throttleWaits,
      waitedMs: result.waitedMs,
      locationsReadable: result.locationsReadable,
      ordersRead: result.orders.length,
      pageSize: PAGE_SIZE,
      linesPerOrder: LINES_PER_ORDER,
    },
    ...counts,
  }
}
