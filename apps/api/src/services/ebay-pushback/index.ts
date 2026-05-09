/**
 * O.10 — eBay markAsShipped + tracking upload via Fulfillment API.
 *
 * POST https://api.ebay.com/sell/fulfillment/v1/order/{orderId}/shipping_fulfillment
 *
 * eBay's modern API for confirming shipment + attaching tracking. The
 * Trading API's CompleteSale path is deprecated — Fulfillment v1 is
 * the official channel for new integrations. Each fulfillment row
 * eBay creates ties to a set of lineItems within an order, so partial
 * shipments are supported by submitting multiple fulfillments per
 * order (each with its own subset of lineItems).
 *
 * Same dryRun pattern as O.9 / O.9b:
 *   NEXUS_ENABLE_EBAY_SHIP_CONFIRM=true|false  default 'false'
 *
 * eBay carrier codes: see https://developer.ebay.com/api-docs/sell/fulfillment/types/sel:ShippingCarrierEnum
 * (subset mapped below; everything else falls to 'OTHER' with a
 * carrier_name passthrough — eBay tolerates unknown carriers and
 * surfaces the operator-provided name to the buyer).
 */

import prisma from '../../db.js'
import { recordApiCall } from '../outbound-api-call-log.service.js'

// ── Public types ──────────────────────────────────────────────────────
export interface ShippingFulfillmentInput {
  /** eBay's per-order ID, e.g. "27-12345-67890". */
  ebayOrderId: string
  /** Internal carrier code from carriers.service.ts. */
  carrierCode: string
  /** Tracking number issued by the carrier. */
  trackingNumber: string
  shippedAt: Date
  /**
   * eBay line item IDs to mark as shipped. Empty / omitted = mark
   * every line in the order shipped (the common case for single-
   * package orders).
   */
  lineItems?: Array<{ lineItemId: string; quantity: number }>
}

export interface FulfillmentResult {
  /** eBay's fulfillment ID; null in dryRun (we synthesize a mock). */
  fulfillmentId: string
  /** Echoed for log audit. */
  ebayOrderId: string
  status: 'CREATED' | 'FAILED'
  dryRun: boolean
}

export class EbayPushbackError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly response?: unknown,
  ) {
    super(message)
    this.name = 'EbayPushbackError'
  }
}

// Internal carrier code → eBay's ShippingCarrierEnum value. Anything
// not in the map maps to 'OTHER' with shippingCarrierCode set verbatim.
const CARRIER_MAP: Record<string, string> = {
  BRT: 'BRT',
  POSTE: 'POSTE_ITALIANE',
  GLS: 'GLS',
  SDA: 'SDA_ITALY',
  TNT: 'TNT',
  DHL: 'DHL',
  UPS: 'UPS',
  FEDEX: 'FedEx',
  DPD: 'DPD',
  CHRONOPOST: 'CHRONOPOST',
  // Sendcloud aggregates many — eBay doesn't recognize "Sendcloud" so
  // we surface 'OTHER'. Operator should ideally configure the
  // shipment.carrierCode to the underlying carrier when known.
  SENDCLOUD: 'OTHER',
}

function isReal(): boolean {
  return process.env.NEXUS_ENABLE_EBAY_SHIP_CONFIRM === 'true'
}

/**
 * Submit a shipping fulfillment to eBay. In real mode, hits the
 * Fulfillment v1 endpoint with the operator's eBay access token. In
 * dryRun mode, returns a mock fulfillment ID without network I/O.
 *
 * connectionId is the ChannelConnection.id for the eBay account; we
 * use it to fetch a valid access token via the existing EbayAuthService
 * (auto-refreshes if expired).
 */
export async function submitShippingFulfillment(
  input: ShippingFulfillmentInput,
  connectionId: string,
  orderId?: string,
): Promise<FulfillmentResult> {
  if (!isReal()) {
    return {
      fulfillmentId: `MOCK-EBAY-FUL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ebayOrderId: input.ebayOrderId,
      status: 'CREATED',
      dryRun: true,
    }
  }

  // Real path. Defer the auth-service import so dryRun mode never
  // touches the eBay token-refresh chain.
  const { EbayAuthService } = await import('../ebay-auth.service.js')
  const auth = new EbayAuthService()
  const accessToken = await auth.getValidToken(connectionId)

  const carrierMapped = CARRIER_MAP[input.carrierCode.toUpperCase()] ?? 'OTHER'

  const body: any = {
    shippedDate: input.shippedAt.toISOString(),
    shippingCarrierCode: carrierMapped,
    trackingNumber: input.trackingNumber,
  }
  if (input.lineItems?.length) {
    body.lineItems = input.lineItems.map((it) => ({
      lineItemId: it.lineItemId,
      quantity: it.quantity,
    }))
  }

  const url = `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(input.ebayOrderId)}/shipping_fulfillment`
  return await recordApiCall<FulfillmentResult>(
    {
      channel: 'EBAY',
      operation: 'createShippingFulfillment',
      endpoint: '/sell/fulfillment/v1/order/{orderId}/shipping_fulfillment',
      method: 'POST',
      connectionId,
      triggeredBy: 'api',
      orderId,
    },
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US',
        },
        body: JSON.stringify(body),
      })

      // eBay returns 201 Created with Location: header containing the
      // fulfillment ID. The body is empty on success; errors come through
      // as a JSON envelope { errors: [{ errorId, message, ... }] }.
      if (res.status === 201) {
        const loc = res.headers.get('location') ?? res.headers.get('content-location') ?? ''
        const fulfillmentId = loc.split('/').pop() ?? `unknown-${Date.now()}`
        return {
          fulfillmentId,
          ebayOrderId: input.ebayOrderId,
          status: 'CREATED' as const,
          dryRun: false,
        }
      }

      const text = await res.text()
      let errBody: any = null
      try {
        errBody = text ? JSON.parse(text) : null
      } catch {
        /* */
      }
      const firstErr = errBody?.errors?.[0]
      const err = new EbayPushbackError(
        firstErr?.message ?? `HTTP ${res.status}`,
        res.status,
        firstErr?.errorId != null ? String(firstErr.errorId) : null,
        errBody,
      ) as EbayPushbackError & { statusCode: number; body: unknown }
      // Augment for parseError() bucket detection.
      err.statusCode = res.status
      err.body = errBody ?? text
      throw err
    },
  )
}

/**
 * Build a ShippingFulfillmentInput from a Shipment row. Used by the
 * retry worker (O.12) to compose the call from a TrackingMessageLog
 * PENDING row. Returns null when the shipment isn't an eBay order or
 * is missing required fields.
 *
 * lineItems are pulled from OrderItem.ebayMetadata.lineItemId
 * (populated by ebay-orders.service.ts:325-329 at ingestion). When
 * the metadata is missing we omit lineItems and eBay applies the
 * fulfillment to the entire order — fine for single-package orders,
 * which is the common case.
 */
export async function buildFulfillmentInputForShipment(
  shipmentId: string,
): Promise<{ input: ShippingFulfillmentInput; connectionId: string | null } | null> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      order: {
        include: {
          items: { select: { sku: true, quantity: true, ebayMetadata: true } },
        },
      },
    },
  })
  if (!shipment?.order || shipment.order.channel !== 'EBAY') return null
  if (!shipment.trackingNumber || !shipment.shippedAt) return null

  const lineItems = shipment.order.items
    .map((it) => ({
      lineItemId: (it.ebayMetadata as any)?.lineItemId as string | undefined,
      quantity: it.quantity,
    }))
    .filter((it): it is { lineItemId: string; quantity: number } => !!it.lineItemId)

  // ChannelConnection lookup — the EBAY connection is global per
  // marketplace today (no per-order connection mapping). Find the
  // active one. If none, the retry job will mark the log entry FAILED
  // with a clear reason.
  const connection = await (prisma as any).channelConnection.findFirst({
    where: { channel: 'EBAY', isActive: true },
    select: { id: true },
  })

  return {
    input: {
      ebayOrderId: shipment.order.channelOrderId,
      carrierCode: shipment.carrierCode,
      trackingNumber: shipment.trackingNumber,
      shippedAt: shipment.shippedAt,
      lineItems: lineItems.length > 0 ? lineItems : undefined,
    },
    connectionId: connection?.id ?? null,
  }
}

export const __test = { isReal, CARRIER_MAP }
