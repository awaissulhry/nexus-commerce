/**
 * O.11 — WooCommerce ship confirmation.
 *
 * Two REST calls:
 *   1. PUT /wp-json/wc/v3/orders/{id}  body { status: 'completed' }
 *   2. POST /wp-json/wc/v3/orders/{id}/notes
 *      body { note: 'Shipped via X · tracking Y · <url>', customer_note: true }
 *
 * Step 1 transitions the WooCommerce order to "completed", which fires
 * Woo's built-in "order_completed" hook (sends the customer email,
 * marks the order shipped on the storefront). Step 2 attaches a
 * customer-visible note carrying the tracking number + carrier so the
 * customer can track without leaving Woo's order-history page.
 *
 * Same dryRun pattern as siblings:
 *   NEXUS_ENABLE_WOO_SHIP_CONFIRM=true|false   default 'false'
 */

import prisma from '../../db.js'
import { resolveTrackingUrl } from '../carriers.service.js'

// ── Public types ──────────────────────────────────────────────────────
export interface WooShipConfirmationInput {
  /** WooCommerce numeric order ID. Stored as channelOrderId on Order. */
  wooOrderId: number
  carrierCode: string
  carrierName?: string | null
  trackingNumber: string
  trackingUrl?: string | null
  shippedAt: Date
}

export interface WooShipResult {
  wooOrderId: number
  status: 'completed'
  noteAdded: boolean
  dryRun: boolean
}

export class WooPushbackError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly response?: unknown,
  ) {
    super(message)
    this.name = 'WooPushbackError'
  }
}

function isReal(): boolean {
  return process.env.NEXUS_ENABLE_WOO_SHIP_CONFIRM === 'true'
}

/**
 * Compose a customer-visible Woo order note carrying the tracking
 * details. Italian default since Woo merchants are predominantly
 * IT-language for this operator. Falls back gracefully when no
 * trackingUrl is resolved.
 */
function composeShipNote(input: WooShipConfirmationInput): string {
  const url = input.trackingUrl ?? resolveTrackingUrl(input.carrierCode, input.trackingNumber)
  const carrier = input.carrierName ?? input.carrierCode
  const lines = [
    `Spedito via ${carrier}.`,
    `Numero tracking: ${input.trackingNumber}`,
  ]
  if (url) lines.push(`Traccia: ${url}`)
  return lines.join('\n')
}

/**
 * Confirm shipment on WooCommerce: status → completed + customer-
 * visible tracking note. dryRun mode (default) is a no-op that returns
 * a structurally-valid mock so the retry job (O.12) can be wired and
 * exercised end-to-end without touching the WooCommerce store.
 */
export async function submitShipConfirmation(
  input: WooShipConfirmationInput,
): Promise<WooShipResult> {
  if (!isReal()) {
    return {
      wooOrderId: input.wooOrderId,
      status: 'completed',
      noteAdded: true,
      dryRun: true,
    }
  }

  // Defer the heavy import so dryRun mode never loads the WooCommerce
  // service (which has its own auth / config chain).
  const [{ WooCommerceSyncService }, { ConfigManager }] = await Promise.all([
    import('../sync/woocommerce-sync.service.js'),
    import('../../utils/config.js'),
  ])
  const config = ConfigManager.getConfig('WOOCOMMERCE')
  if (!config) {
    throw new WooPushbackError(
      'WooCommerce config missing — set WOOCOMMERCE_* env vars',
      503,
      'CONFIG_MISSING',
    )
  }
  const woo = new WooCommerceSyncService(config as any)

  // Step 1: transition status. Woo throws on failure (network / auth /
  // 4xx); let it propagate, the retry job will mark FAILED + backoff.
  try {
    await woo.updateOrderStatus(input.wooOrderId, 'completed')
  } catch (err: any) {
    throw new WooPushbackError(
      err?.message ?? 'updateOrderStatus failed',
      err?.status ?? 502,
      err?.code ?? null,
      err,
    )
  }

  // Step 2: attach customer-visible note. Failure here is non-fatal —
  // status is already updated, the customer email is firing, the
  // tracking is on the Shipment row in Nexus. Log + continue.
  let noteAdded = false
  try {
    const note = composeShipNote(input)
    // addFulfillmentNote uses customer_note=false in the existing
    // helper; we want the customer to see this, so call the underlying
    // service directly for full control.
    await (woo as any).woocommerceService.addOrderNote(input.wooOrderId, note, true)
    noteAdded = true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[woo-pushback] note attach failed (status update succeeded)', err)
  }

  return {
    wooOrderId: input.wooOrderId,
    status: 'completed',
    noteAdded,
    dryRun: false,
  }
}

/**
 * Build a WooShipConfirmationInput from a Shipment + Order. Returns
 * null when the shipment isn't a Woo order or is missing required
 * fields. The wooOrderId comes from Order.channelOrderId (Woo IDs are
 * numeric strings as stored).
 */
export async function buildShipInputForShipment(
  shipmentId: string,
): Promise<WooShipConfirmationInput | null> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      order: { select: { channel: true, channelOrderId: true } },
    },
  })
  if (!shipment?.order || shipment.order.channel !== 'WOOCOMMERCE') return null
  if (!shipment.trackingNumber || !shipment.shippedAt) return null

  const wooOrderId = Number(shipment.order.channelOrderId)
  if (!Number.isFinite(wooOrderId) || wooOrderId <= 0) return null

  return {
    wooOrderId,
    carrierCode: shipment.carrierCode,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl ?? null,
    shippedAt: shipment.shippedAt,
  }
}

export const __test = { isReal, composeShipNote }
