/**
 * P5.1 verification — ONE live Orders 2026-01-01 read, captured.
 *
 * ## Why this exists
 *
 * P5.1 migrated Amazon Orders from v0 (removed 2027-03-27) to 2026-01-01. The
 * whole mapping is proven against Amazon's **published model** and its own example
 * response, and by 48 tests and 13 mutation checks — but **no live 2026-01-01
 * call had ever been made**. `build/P5.1.md` §6 put it to the Owner as two
 * options and recommended **B: one captured live read before the switch goes on**.
 * The Owner chose B. This is that read.
 *
 * ## What it does, and what it deliberately does not
 *
 * - **One `searchOrders` call.** A GET. It changes nothing on the seller account,
 *   and the channel gateway classifies it `read`.
 * - **It does NOT turn the switch on.** `NEXUS_ENABLE_AMAZON_ORDERS_2026` is
 *   untouched; the order sync keeps using v0 until somebody decides otherwise.
 *   A probe that changed the system it is measuring would answer a different
 *   question.
 * - **It reports the SHAPE, not the contents.** The point is "does our mapping
 *   match what Amazon really sends", which is a question about field names and
 *   presence. So it returns the key PATHS Amazon sent, and the mapped v0 result
 *   with buyer personal data REDACTED. A verification endpoint must not become a
 *   way to read customer names out of a log.
 *
 * ## The two questions only a live call can answer
 *
 * Both are named in `amazon-orders-2026.ts` and neither is in Amazon's model:
 *
 *   1. May `paginationToken` be sent together with `includedData` on page 2, or
 *      must it go alone? This probe asks for a second page when one exists.
 *   2. Is `marketplaceIds` accepted as the SDK serialises an array?
 *
 * ## Reading the answer
 *
 * `ok: true` with `orders > 0` and `mapping.unmapped` empty is the result P5.1
 * was waiting for. `ok: false` carries Amazon's own status and message — which is
 * itself a finding, not a failure of the probe.
 */

import type { FastifyInstance } from 'fastify'
import {
  AMAZON_ORDERS_2026_VERSION,
  ORDERS_2026_INCLUDED_DATA,
  toV0Order,
  toV0OrderItems,
  type Order2026,
  type SearchOrdersResponse2026,
} from '../services/marketplaces/amazon-orders-2026.js'

/** Buyer personal data never leaves this endpoint. */
const PII_PATHS = new Set(['buyer', 'recipient'])

/** Every dotted path Amazon actually sent, to a shallow depth. Values are NOT included. */
/**
 * 🔴 Which order this probe reports on: the first one **that has line items**, not simply the
 * first one.
 *
 * The money question — is `ItemPrice` the LINE total, as `upsertOrderItem` assumes when it
 * divides by quantity — can only be answered by an order that HAS items. Reporting on
 * `orders[0]` regardless meant nine consecutive live calls answered "no items", which is a true
 * statement about that order and tells you nothing about the mapping.
 *
 * Worse, it invited a false finding: one call's field paths read against a later call's item
 * count look like *"Amazon sent items and our mapper produced none"*, when they are simply two
 * different orders. Every number below now comes from the SAME chosen order, so they can be
 * compared.
 *
 * The fallback to index 0 is deliberate — an empty-handed answer must still report the field
 * paths and the mapping — and `chosenHasItems: false` says plainly which case it is.
 */
export function chooseProbeOrder(orders: ReadonlyArray<{ orderItems?: unknown[] }>): {
  chosenIndex: number
  ordersWithItems: number
  chosenHasItems: boolean
} {
  const hasItems = (o: { orderItems?: unknown[] }) => Array.isArray(o?.orderItems) && o.orderItems.length > 0
  const ordersWithItems = orders.filter(hasItems).length
  const withItems = orders.findIndex(hasItems)
  const chosenIndex = withItems >= 0 ? withItems : orders.length > 0 ? 0 : -1
  return { chosenIndex, ordersWithItems, chosenHasItems: withItems >= 0 }
}

function pathsOf(value: unknown, prefix = '', depth = 0, out: string[] = []): string[] {
  if (depth > 3 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    if (value.length > 0) pathsOf(value[0], `${prefix}[]`, depth + 1, out)
    return out
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    out.push(path)
    // The presence of a PII section is the fact we need; its inside is not.
    if (!PII_PATHS.has(key)) pathsOf(child, path, depth + 1, out)
  }
  return out
}

/** The mapped v0 order, with anything a buyer could be identified by removed. */
function redactV0(raw: ReturnType<typeof toV0Order>): Record<string, unknown> {
  const { BuyerInfo, ShippingAddress, ...rest } = raw
  return {
    ...rest,
    BuyerInfo: BuyerInfo ? { present: true, keys: Object.keys(BuyerInfo) } : null,
    ShippingAddress: ShippingAddress
      ? { present: true, keys: Object.keys(ShippingAddress), CountryCode: ShippingAddress.CountryCode ?? null }
      : null,
  }
}

export default async function amazonOrders2026ProbeRoutes(app: FastifyInstance) {
  /**
   * GET /api/admin/amazon-orders-2026-probe?days=7&accountId=…
   *
   * Read-only. One page, optionally a second to answer the pagination question.
   */
  app.get('/admin/amazon-orders-2026-probe', async (req, reply) => {
    const query = req.query as { days?: string; accountId?: string; marketplaceId?: string }
    const days = Math.min(Math.max(Number(query.days ?? 7) || 7, 1), 30)
    const marketplaceId = query.marketplaceId || process.env.AMAZON_MARKETPLACE_ID || 'APJ6JRA9NG5V4'

    // SP-API refuses a `createdBefore` inside its ~2 minute propagation window.
    const SKEW_MS = 180_000
    const createdBefore = new Date(Date.now() - SKEW_MS).toISOString()
    const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const request = {
      operation: 'searchOrders',
      endpoint: 'orders',
      // The version goes in `options`. A top-level `version` key is accepted by
      // the object and IGNORED, which would silently send these 2026 parameters
      // to the v0 path — the defect P5.1's guard exists for.
      options: { version: AMAZON_ORDERS_2026_VERSION },
      query: {
        marketplaceIds: [marketplaceId],
        createdAfter,
        createdBefore,
        // 2026-09-21 — was 5. An order with line items is what the MONEY question needs,
        // and with 5 the newest order had none on nine consecutive calls. A wider page is a
        // better chance of finding one without asking Amazon more times.
        maxResultsPerPage: 20,
        includedData: [...ORDERS_2026_INCLUDED_DATA],
      },
    }

    try {
      const { getAmazonSpClient } = await import('../lib/amazon-sp-client.js')
      const sp = await getAmazonSpClient(query.accountId)

      const page1 = (await sp.callAPI(request)) as SearchOrdersResponse2026
      const orders = Array.isArray(page1?.orders) ? page1.orders : []
      const nextToken = page1?.pagination?.nextToken ?? null

      // Question 1 — may `paginationToken` travel WITH `includedData`? Only a
      // real second page can answer it, and only when one exists.
      let page2: { attempted: boolean; ok: boolean; error: string | null; orders: number | null } =
        { attempted: false, ok: false, error: null, orders: null }
      if (nextToken) {
        page2.attempted = true
        try {
          // 2026-09-21 — this now sends what the REAL sync sends, which is the whole
          // page-1 query plus the cursor. The first version sent the cursor with
          // `includedData` alone, matching the sync's own shape at the time, and Amazon
          // refused BOTH: "One and only one of createdAfter or lastUpdatedAfter must be
          // provided." That answer is what fixed amazon.service.ts; this probe must keep
          // measuring the shape production actually uses, or it stops being a control.
          const res = (await sp.callAPI({
            ...request,
            query: { ...(request.query as Record<string, unknown>), paginationToken: nextToken },
          })) as SearchOrdersResponse2026
          page2 = { attempted: true, ok: true, error: null, orders: Array.isArray(res?.orders) ? res.orders.length : 0 }
        } catch (err: any) {
          page2 = { attempted: true, ok: false, error: String(err?.message ?? err).slice(0, 400), orders: null }
        }
      }

      const choice = chooseProbeOrder(orders as Order2026[])
      const { chosenIndex, ordersWithItems, chosenHasItems } = choice
      const first = chosenIndex >= 0 ? (orders[chosenIndex] as Order2026) : undefined
      const sent = first ? [...new Set(pathsOf(first))].sort() : []

      // The mapping, checked against what Amazon actually sent rather than
      // against the example response the tests use.
      const WANTED: Array<[string, string]> = [
        ['orderId', 'AmazonOrderId'],
        ['createdTime', 'PurchaseDate'],
        ['lastUpdatedTime', 'LastUpdateDate'],
        ['salesChannel.marketplaceId', 'MarketplaceId'],
        ['fulfillment.fulfillmentStatus', 'OrderStatus'],
        ['fulfillment.fulfilledBy', 'FulfillmentChannel'],
        ['proceeds.grandTotal', 'OrderTotal'],
        ['orderItems', '(items, folded in — there is no getOrderItems)'],
        ['buyer', 'BuyerInfo'],
        ['recipient', 'ShippingAddress'],
      ]
      const mapping = WANTED.map(([from, to]) => ({
        from, to, amazonSentIt: sent.some((p) => p === from || p.startsWith(`${from}.`) || p.startsWith(`${from}[]`)),
      }))

      const items = first ? toV0OrderItems(first) : []

      return reply.send({
        ok: true,
        note: 'Read-only. The 2026-01-01 switch was NOT turned on by this call.',
        version: AMAZON_ORDERS_2026_VERSION,
        window: { createdAfter, createdBefore, days, marketplaceId },
        answered: {
          // Question 2 — the SDK's array serialisation was accepted, or we would
          // not be here with a 200.
          marketplaceIdsAccepted: true,
          // Question 1 — null when no second page existed to ask with.
          paginationTokenWithIncludedData: page2.attempted ? page2.ok : null,
          page2,
        },
        orders: orders.length,
        /** How many of this page's orders carried line items, and which one is reported on. */
        ordersWithItems,
        chosenIndex,
        chosenHasItems,
        nextTokenPresent: !!nextToken,
        /** Field PATHS only — no values, so no buyer data. */
        amazonSentPaths: sent,
        mapping,
        unmapped: mapping.filter((m) => !m.amazonSentIt).map((m) => m.from),
        /** The mapped v0 order our 14 downstream files would receive, PII removed. */
        mappedFirstOrder: first ? redactV0(toV0Order(first)) : null,
        mappedFirstOrderItems: items.slice(0, 3).map((i) => ({
          ASIN: i.ASIN, SellerSKU: i.SellerSKU, OrderItemId: i.OrderItemId,
          QuantityOrdered: i.QuantityOrdered, QuantityShipped: i.QuantityShipped,
          ItemPrice: i.ItemPrice,
          // 🔴 The money check, computed here so the answer is unambiguous:
          // v0's ItemPrice is a LINE total and `upsertOrderItem` divides it by
          // the quantity. This is what would be stored.
          wouldStoreUnitPrice: i.ItemPrice && i.QuantityOrdered
            ? Number(i.ItemPrice.Amount) / i.QuantityOrdered
            : null,
        })),
      })
    } catch (err: any) {
      // Amazon refusing is a FINDING, not a probe failure — report it plainly.
      return reply.send({
        ok: false,
        note: 'Read-only. Nothing was changed, and the 2026-01-01 switch is still off.',
        version: AMAZON_ORDERS_2026_VERSION,
        window: { createdAfter, createdBefore, days, marketplaceId },
        error: String(err?.message ?? err).slice(0, 800),
        statusCode: err?.statusCode ?? err?.status ?? null,
        amazonCode: err?.code ?? null,
      })
    }
  })
}
