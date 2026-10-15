/**
 * Shopify order import — whether a Shopify order webhook may touch Nexus, and from when (T0).
 *
 * A Shopify order reaches Nexus stock only when BOTH are true (the Etsy pattern, services/etsy/order-ingest-switch.ts):
 * - the server-wide switch `NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1` (exactly `1`) is on in the process. Without it nothing
 *   registers Shopify webhooks, and an order webhook that still arrives is held in the inbound ledger (answered 200, no
 *   attempt spent, tried again every 30 minutes) and writes nothing;
 * - the account has its start date (T0): its `ShopifyOrderIngest` row, written ONCE when a person switches order import
 *   on for that account (POST /api/shopify/order-import/:accountId/start), at the database clock's whole second. It is
 *   never written by processing and never rewritten. Without it an order webhook is acknowledged and writes nothing, and
 *   webhook registration is refused.
 *
 * Every order webhook (orders/create, orders/updated, fulfillments/create, refunds/create; live or replayed) passes
 * `shopifyOrderIngressGate` first. An order Shopify created BEFORE T0 is acknowledged and ignored: no Nexus order, no
 * hold, no stock movement, one log line. So an old order that is merely edited, fulfilled or refunded after the start is
 * never taken from stock. A fulfilment or refund names only its order, so its order must already be in Nexus (only
 * orders created at or after T0 are); otherwise it is ignored too. An order created at or after T0 goes to the existing
 * order writer unchanged.
 *
 * Registration (webhook-registration.service.ts) subscribes only the order topics and app/uninstalled. No product topics:
 * Shopify follows Nexus, and products/update would overwrite the Nexus product names (Italian) with the store's English
 * titles, products/delete would deactivate Nexus products. No inventory_levels/update: it would set Nexus counts from
 * Shopify's. A subscription of another topic already on the shop is listed in the result and left in place.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { InboundDeferred } from '../cx/ingress/ledger.js'

export const SHOPIFY_ORDER_INGEST_FLAG = 'NEXUS_ENABLE_SHOPIFY_ORDER_INGEST'

export const shopifyOrderIngestEnabled = (): boolean => process.env[SHOPIFY_ORDER_INGEST_FLAG] === '1'

export const SHOPIFY_WEBHOOKS_OFF_CODE = 'shopify_order_ingest_off'

export const SHOPIFY_WEBHOOKS_OFF_MESSAGE =
  'Shopify webhook registration is off: Shopify order import is switched off on this server ' +
  `(${SHOPIFY_ORDER_INGEST_FLAG} is not 1), so nothing was recorded and nothing was registered with Shopify.`

export const SHOPIFY_ORDER_IMPORT_NOT_STARTED_CODE = 'shopify_order_import_not_started'

export const SHOPIFY_ORDER_IMPORT_NOT_STARTED_MESSAGE =
  'Shopify order import has not been started for this Shopify account, so it has no start date and nothing was ' +
  'registered with Shopify. Start it first (POST /api/shopify/order-import/:accountId/start): that records the start ' +
  'date and registers the order webhooks.'

/** While the switch is off, an order webhook is held this long before its next try (the attempt is not spent). */
export const SHOPIFY_ORDER_HOLD_MS = 30 * 60 * 1000

export interface ShopifyOrderIngestStart {
  /** T0: orders Shopify created before it are never imported. */
  since: Date
  by: string | null
}

/** The account's start date, or null when order import was never started for it. Read-only. */
export async function shopifyOrderIngestStart(connectionId: string): Promise<ShopifyOrderIngestStart | null> {
  const row = await prisma.shopifyOrderIngest.findUnique({
    where: { workspace_connectionId: workspaceKey({ connectionId }) }, select: { activatedAt: true, activatedBy: true },
  })
  return row ? { since: row.activatedAt, by: row.activatedBy } : null
}

/**
 * Record the start date, once. Only the explicit start action calls this; processing never does. Idempotent under
 * races: the unique key keeps the first writer's time and person, and a later call reads them back unchanged.
 */
export async function recordShopifyOrderIngestStart(connectionId: string, by: string | null): Promise<ShopifyOrderIngestStart & { newlyStarted: boolean }> {
  const { count } = await prisma.shopifyOrderIngest.createMany({ data: [{ connectionId, activatedBy: by }], skipDuplicates: true })
  const start = await shopifyOrderIngestStart(connectionId)
  if (!start) throw new Error('Shopify order import could not record its start date for this account.')
  return { ...start, newlyStarted: count === 1 }
}

/** The ledger event types of the order topics: the receivers write these, the replay registry is keyed on them. */
export type ShopifyOrderEventType = 'order/create' | 'order/update' | 'fulfillment/create' | 'refunds/create'

export type ShopifyOrderSkip = 'not_started' | 'order_not_in_nexus' | 'no_created_at' | 'before_start_date'

export type ShopifyOrderGate = { admit: true } | { admit: false; code: ShopifyOrderSkip; sentence: string }

const HELD_SENTENCE =
  `Shopify order import is switched off on this server (${SHOPIFY_ORDER_INGEST_FLAG} is not 1): the order webhook is ` +
  'held, nothing was written, and it is tried again when the switch is on.'

/**
 * Whether one order webhook may reach the order writer. Throws InboundDeferred while the switch is off (asked first,
 * before any database read); a failed read throws too, so "could not tell" is never "admit".
 */
export async function shopifyOrderIngressGate(eventType: ShopifyOrderEventType, payload: unknown, connectionId: string | null | undefined): Promise<ShopifyOrderGate> {
  if (!shopifyOrderIngestEnabled()) throw new InboundDeferred(HELD_SENTENCE, SHOPIFY_ORDER_HOLD_MS)
  const start = connectionId ? await shopifyOrderIngestStart(connectionId) : null
  if (!start) return { admit: false, code: 'not_started', sentence: 'Shopify order import was never started for this Shopify account (it has no start date).' }

  const body = (payload ?? {}) as { created_at?: unknown; order_id?: unknown }
  let createdAt: unknown = body.created_at
  if (eventType === 'fulfillment/create' || eventType === 'refunds/create') {
    // A fulfilment or a refund carries its own time, not its order's. The order is in Nexus only if it was created at
    // or after the start date; its purchaseDate is the created_at Shopify sent when the order was imported.
    const order = body.order_id != null
      ? await prisma.order.findUnique({ where: { channel_channelOrderId: workspaceKey({ channel: 'SHOPIFY', channelOrderId: String(body.order_id) }) }, select: { purchaseDate: true } })
      : null
    if (!order) return { admit: false, code: 'order_not_in_nexus', sentence: 'Its order is not in Nexus: an order created before the start date of Shopify order import is never imported.' }
    createdAt = order.purchaseDate
  }

  const at = createdAt instanceof Date ? createdAt.getTime() : typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN
  if (!Number.isFinite(at)) return { admit: false, code: 'no_created_at', sentence: 'The order has no creation time, so it cannot be shown to be after the start date of Shopify order import.' }
  // T0 is a whole second and Shopify's created_at is too: an order created in the start second is imported.
  if (at < start.since.getTime()) {
    return { admit: false, code: 'before_start_date', sentence: `The order was created before the start date of Shopify order import (created ${new Date(at).toISOString()}, start date ${start.since.toISOString()}).` }
  }
  return { admit: true }
}
