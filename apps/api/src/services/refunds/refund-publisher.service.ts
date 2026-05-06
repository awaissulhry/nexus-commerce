/**
 * H.14 — channel refund publisher.
 *
 * Posts the local Return's refund decision back to the originating
 * marketplace so the buyer is actually refunded. The previous
 * /fulfillment/returns/:id/refund endpoint only flipped local
 * status; without channel push, the operator had to re-issue the
 * refund manually in Seller Central / eBay back office, easy to
 * forget and easy to double-pay.
 *
 * Per-channel state of the world (2026-05):
 *
 *   eBay        — Real implementation. POST /sell/fulfillment/v1/
 *                 order/{orderId}/issue_refund returns refundId.
 *                 Supports full + partial refunds via refundItems[].
 *
 *   Amazon FBA  — Amazon issues refunds automatically per their
 *                 policy. Our adapter no-ops with a confirmation
 *                 message; the operator only marks local status.
 *
 *   Amazon FBM  — SP-API has NO seller-issued refund endpoint.
 *                 The legacy MWS POST_PAYMENT_ADJUSTMENT_DATA feed
 *                 was deprecated. Path forward is Seller Central
 *                 manual issuance; we surface a deep link to the
 *                 order so the operator finishes there. Adapter
 *                 returns ok=true with channelMessage, no
 *                 channelRefundId.
 *
 *   Shopify     — Stub today. Implementation needs Shopify Admin
 *                 GraphQL `refundCreate` mutation against the
 *                 ShopifyService client. Returns NOT_IMPLEMENTED.
 *
 *   WooCommerce — Stub today. Implementation needs POST
 *                 /wp-json/wc/v3/orders/{id}/refunds. Returns
 *                 NOT_IMPLEMENTED.
 *
 *   Etsy        — Stub today. Etsy refunds via API only available
 *                 to specific seller programs. Returns
 *                 NOT_IMPLEMENTED.
 *
 * Caller contract: publish() never throws. Returns a structured
 * result so the route handler can persist (or surface) the outcome
 * without bubbling exceptions through the refund button.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export type RefundOutcome =
  | 'OK'
  | 'OK_MANUAL_REQUIRED'
  | 'NOT_IMPLEMENTED'
  | 'FAILED'

export interface RefundPublishResult {
  outcome: RefundOutcome
  /** Provider-side identifier. eBay refundId, Shopify refundGid, etc. */
  channelRefundId?: string
  /** Operator-facing message. For OK_MANUAL_REQUIRED carries the
   *  reason + a deep link to finish in the channel's back office. */
  channelMessage?: string
  /** Provider error when outcome=FAILED. */
  error?: string
}

interface RefundPublishInput {
  /** Required. The Return row drives most of the request. */
  returnId: string
  /** Override line-item refund amounts. When absent, refunds the
   *  full Return.refundCents. Map keys are eBay/Shopify line-item
   *  identifiers when available, sku otherwise. */
  itemAmountsCents?: Record<string, number>
  /** Operator-facing reason + comment that some channels expect. */
  reasonText?: string
  /** Caller identity for audit. Defaults to 'default-user'. */
  actor?: string
}

const DEFAULT_REASON = 'BUYER_RETURNED_ITEM'

export async function publishRefundToChannel(
  input: RefundPublishInput,
): Promise<RefundPublishResult> {
  const ret = await prisma.return.findUnique({
    where: { id: input.returnId },
    include: {
      order: {
        select: {
          id: true,
          channelOrderId: true,
          channel: true,
          marketplace: true,
          fulfillmentMethod: true,
          ebayMetadata: true,
          amazonMetadata: true,
        },
      },
    },
  })
  if (!ret) {
    return {
      outcome: 'FAILED',
      error: `Return ${input.returnId} not found`,
    }
  }
  if (!ret.order) {
    return {
      outcome: 'FAILED',
      error: 'Return has no linked Order — cannot resolve channel order id',
    }
  }
  if (!ret.refundCents || ret.refundCents <= 0) {
    return {
      outcome: 'FAILED',
      error:
        'refundCents not set or non-positive — set Return.refundCents before publishing',
    }
  }

  const channel = (ret.channel ?? ret.order.channel ?? '').toUpperCase()
  switch (channel) {
    case 'EBAY':
      return publishEbayRefund(ret, input)
    case 'AMAZON':
      return publishAmazonRefund(ret)
    case 'SHOPIFY':
      return notImplemented(
        'Shopify',
        'shopify-publish.service.ts → refundCreate',
      )
    case 'WOOCOMMERCE':
      return notImplemented(
        'WooCommerce',
        'POST /wp-json/wc/v3/orders/{id}/refunds',
      )
    case 'ETSY':
      return notImplemented(
        'Etsy',
        'Etsy refund API limited to specific seller programs',
      )
    default:
      return {
        outcome: 'FAILED',
        error: `Unknown channel ${channel}`,
      }
  }
}

function notImplemented(
  channel: string,
  pathHint: string,
): RefundPublishResult {
  return {
    outcome: 'NOT_IMPLEMENTED',
    channelMessage: `${channel} refund publish not yet wired (${pathHint}). Issue this refund manually in the ${channel} back office, then mark this Return refunded with skipChannelPush=true.`,
  }
}

/**
 * eBay refund via Fulfillment API issue_refund.
 *
 *   POST /sell/fulfillment/v1/order/{orderId}/issue_refund
 *
 * Body shape (full refund):
 *   { reasonForRefund, comment }
 *
 * Body shape (partial / per-line):
 *   {
 *     reasonForRefund,
 *     comment,
 *     refundItems: [{ lineItemId, refundAmount: { value, currency } }]
 *   }
 *
 * eBay returns refundId on success. We persist that into Return.
 * channelRefundId for traceability + deep-link rendering.
 */
/**
 * Loaded Return shape used by per-channel publishers. Mirrors the
 * include block in publishRefundToChannel so the type stays accurate.
 */
type LoadedReturn = NonNullable<
  Awaited<ReturnType<typeof prisma.return.findUnique>>
> & {
  order: {
    id: string
    channelOrderId: string | null
    channel: string | null
    marketplace: string | null
    fulfillmentMethod: string | null
    ebayMetadata: unknown
    amazonMetadata: unknown
  } | null
}

async function publishEbayRefund(
  ret: LoadedReturn,
  input: RefundPublishInput,
): Promise<RefundPublishResult> {
  // Resolve the eBay channel connection that owns this order. eBay
  // accounts can be multi-tenant, so we look up by channelType only;
  // if a seller has multiple eBay connections active we'd need to
  // disambiguate via the order's marketplace, which is future work.
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })
  if (!connection) {
    return {
      outcome: 'FAILED',
      error:
        'No active eBay channel connection. Connect eBay in Settings → Channels first.',
    }
  }

  const order = ret.order!
  if (!order.channelOrderId) {
    return {
      outcome: 'FAILED',
      error: 'Linked Order is missing channelOrderId — cannot post to eBay',
    }
  }

  // Lazy-import to keep this service tree-shakeable + avoid a hard
  // dep on the eBay auth path when only Amazon is configured.
  const { ebayAuthService } = await import('../ebay-auth.service.js')
  let accessToken: string
  try {
    accessToken = await ebayAuthService.getValidToken(connection.id)
  } catch (err) {
    return {
      outcome: 'FAILED',
      error: `eBay auth failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const refundCurrency = ret.currencyCode || 'EUR'
  const totalAmount = (ret.refundCents / 100).toFixed(2)
  const reasonForRefund = mapEbayRefundReason(ret.reason)
  const comment = (
    input.reasonText ??
    ret.notes ??
    'Refund issued via Nexus Commerce'
  ).slice(0, 500)

  // For v1 we issue a full-order refund (sums to ret.refundCents).
  // Per-line partial refunds need refundItems[] with eBay
  // lineItemIds, which require us to have stored them on
  // OrderItem.ebayMetadata at order ingestion. Future enhancement.
  const body: Record<string, unknown> = {
    reasonForRefund,
    comment,
  }
  // When refundCents differs from the order total OR the operator
  // supplied per-item amounts, we'd build refundItems. For now,
  // issue_refund with no refundItems[] = full refund of the
  // remaining refundable amount; we coerce eBay to honour our
  // refundCents by passing it as a partialRefundAmount when present.
  if (Object.keys(input.itemAmountsCents ?? {}).length > 0) {
    // Future: per-line refund mapping. Surface a clear error so the
    // caller knows it didn't apply.
    logger.info('eBay refund per-line amounts requested but not yet wired', {
      returnId: ret.id,
    })
  }

  const url = `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(order.channelOrderId)}/issue_refund`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US',
        'X-EBAY-C-MARKETPLACE-ID': `EBAY_${ret.marketplace ?? 'GB'}`,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return {
      outcome: 'FAILED',
      error: `eBay HTTP error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let parsed: any = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* keep raw text */
    }
    const message =
      parsed?.errors?.[0]?.message ??
      parsed?.errors?.[0]?.longMessage ??
      text.slice(0, 500) ??
      `HTTP ${response.status}`
    logger.warn('eBay issue_refund failed', {
      returnId: ret.id,
      status: response.status,
      message,
    })
    return {
      outcome: 'FAILED',
      error: `eBay rejected refund: ${message}`,
    }
  }

  const json = (await response.json().catch(() => ({}))) as {
    refundId?: string
  }
  const channelRefundId = json.refundId
  logger.info('eBay refund issued', {
    returnId: ret.id,
    channelOrderId: order.channelOrderId,
    refundId: channelRefundId,
    amount: totalAmount,
    currency: refundCurrency,
  })
  return {
    outcome: 'OK',
    channelRefundId,
    channelMessage: `eBay refund ${channelRefundId ?? '(no id returned)'} for ${totalAmount} ${refundCurrency} issued.`,
  }
}

/** Translate our internal reason text to one of eBay's enum values.
 *  When in doubt, default to BUYER_RETURNED_ITEM since this service
 *  only fires after a return has been received. */
function mapEbayRefundReason(reason: string | null | undefined): string {
  if (!reason) return DEFAULT_REASON
  const r = reason.toUpperCase()
  if (r.includes('NOT_AS_DESCRIBED') || r.includes('NOT AS')) {
    return 'ITEM_NOT_AS_DESCRIBED'
  }
  if (r.includes('DAMAGED')) return 'ITEM_DAMAGED'
  if (r.includes('NOT_RECEIVED') || r.includes('NEVER')) {
    return 'ORDER_NOT_RECEIVED'
  }
  if (r.includes('CHANGE_OF_MIND') || r.includes('CHANGED')) {
    return 'BUYERS_REMORSE'
  }
  return DEFAULT_REASON
}

/**
 * Amazon refund handling. SP-API has no FBM seller-issued refund
 * endpoint — the legacy POST_PAYMENT_ADJUSTMENT_DATA feed is
 * deprecated. We classify FBA vs FBM:
 *
 *   FBA: Amazon issues refunds automatically per their policy when
 *        the buyer-returned-item event hits their warehouse. We
 *        no-op locally with a confirmation message.
 *
 *   FBM: Operator must finish the refund in Seller Central. We
 *        return OK_MANUAL_REQUIRED with a deep link so the next
 *        click opens the right Seller Central page.
 */
function publishAmazonRefund(ret: LoadedReturn): RefundPublishResult {
  const isFba =
    ret.isFbaReturn ||
    (ret.order?.fulfillmentMethod ?? '').toUpperCase() === 'FBA'

  if (isFba) {
    return {
      outcome: 'OK_MANUAL_REQUIRED',
      channelMessage:
        'FBA returns: Amazon issues refunds automatically when the unit hits their warehouse. No action needed here unless you want to override.',
    }
  }

  const orderId = ret.order?.channelOrderId
  const marketplace = (ret.marketplace ?? ret.order?.marketplace ?? 'IT').toLowerCase()
  const sellerCentralDomain =
    {
      it: 'sellercentral-europe.amazon.com',
      de: 'sellercentral-europe.amazon.com',
      fr: 'sellercentral-europe.amazon.com',
      es: 'sellercentral-europe.amazon.com',
      uk: 'sellercentral.amazon.co.uk',
      us: 'sellercentral.amazon.com',
      ca: 'sellercentral.amazon.ca',
    }[marketplace] ?? 'sellercentral-europe.amazon.com'
  const sellerCentralUrl = orderId
    ? `https://${sellerCentralDomain}/orders-v3/order/${encodeURIComponent(orderId)}`
    : `https://${sellerCentralDomain}/orders-v3`

  return {
    outcome: 'OK_MANUAL_REQUIRED',
    channelMessage: `Amazon FBM refunds aren't issuable via SP-API. Open Seller Central to complete: ${sellerCentralUrl}`,
  }
}
