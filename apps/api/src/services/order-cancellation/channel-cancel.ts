import { getAmazonSellerId } from '../../lib/amazon-sp-client.js'
import { ebaySend } from '../gateway/ebay.js'
import { amazonSpClient } from '../../lib/amazon-sp-client.js'
/**
 * O.50 — Channel-side cancellation pushback.
 *
 * When operator cancels an order in Nexus (O.48), tell the channel
 * about it so the marketplace updates its side + the customer is
 * notified per the marketplace's own cancellation flow. Per
 * project_active_channels: Amazon + eBay + Shopify only.
 *
 * Same dryRun-default pattern as Wave 4 channel pushback (O.9-O.11):
 *   NEXUS_ENABLE_AMAZON_ORDER_CANCEL=true|false   default 'false'
 *   NEXUS_ENABLE_EBAY_ORDER_CANCEL=true|false     default 'false'
 *   NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL=true|false  default 'false'
 *
 * In dryRun every function returns a structurally-identical mock
 * acknowledgement so the manual-cancel endpoint can wire fully
 * end-to-end without real API calls. Operator flips per-channel
 * flags one at a time after sandbox testing.
 *
 * Method per channel:
 * - Amazon: SP-API Feeds with feedType=POST_ORDER_ACKNOWLEDGEMENT_DATA
 *   and StatusCode=Failure (StatusReason=NoInventory or other from a
 *   small enum). Async — returns feedId; ack lands when polled.
 * - eBay:   Fulfillment API POST /sell/fulfillment/v1/order/{orderId}
 *           /cancellation_request. Synchronous; eBay returns 201 +
 *           Location header with the cancellation id.
 * - Shopify: Admin GraphQL `orderCancel` mutation with reason +
 *            refund flag. Synchronous.
 */

export interface ChannelCancelResult {
  ok: boolean
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  channelOrderId: string
  /** Reference id from the channel's response (feedId / cancellationId
   *  / mutation id). Null on dryRun mocks since nothing real ran. */
  ackRef: string | null
  /** True when NEXUS_ENABLE_*_ORDER_CANCEL=false. */
  dryRun: boolean
  error?: string
}

// ── Reason mapping per channel. Operator's free-form reason from O.48
// gets normalized to the channel's expected enum where possible.
type ChannelReasonAmazon = 'NoInventory' | 'GeneralAdjustment' | 'CustomerExchange' | 'BuyerCanceled' | 'CarrierCreditDecision'
type ChannelReasonEbay = 'OUT_OF_STOCK_OR_CANNOT_FULFILL' | 'BUYER_CANCEL_OR_ADDRESS_ISSUE' | 'BUYER_ASKED_CANCEL' | 'ORDER_UNPAID'

function mapReasonToAmazon(reason: string | undefined): ChannelReasonAmazon {
  const r = (reason ?? '').toLowerCase()
  if (r.includes('out of stock') || r.includes('inventory')) return 'NoInventory'
  if (r.includes('buyer') || r.includes('customer')) return 'BuyerCanceled'
  if (r.includes('carrier')) return 'CarrierCreditDecision'
  if (r.includes('exchange')) return 'CustomerExchange'
  return 'GeneralAdjustment'
}

function mapReasonToEbay(reason: string | undefined): ChannelReasonEbay {
  const r = (reason ?? '').toLowerCase()
  if (r.includes('out of stock') || r.includes('inventory')) return 'OUT_OF_STOCK_OR_CANNOT_FULFILL'
  if (r.includes('buyer asked') || r.includes('customer asked')) return 'BUYER_ASKED_CANCEL'
  if (r.includes('address')) return 'BUYER_CANCEL_OR_ADDRESS_ISSUE'
  if (r.includes('unpaid')) return 'ORDER_UNPAID'
  return 'OUT_OF_STOCK_OR_CANNOT_FULFILL'
}

// ── Amazon ─────────────────────────────────────────────────────────────
function isAmazonReal() {
  return process.env.NEXUS_ENABLE_AMAZON_ORDER_CANCEL === 'true'
}

export async function cancelOnAmazon(
  amazonOrderId: string,
  reason: string | undefined,
  marketplaceIds: string[],
): Promise<ChannelCancelResult> {
  if (!isAmazonReal()) {
    return {
      ok: true,
      channel: 'AMAZON',
      channelOrderId: amazonOrderId,
      ackRef: null,
      dryRun: true,
    }
  }
  try {
    const account = await (await import('../connection-resolver.service.js')).resolveConnection({ channel: 'AMAZON', channelOrderId: amazonOrderId })
    const merchantToken = await (await import('../../lib/amazon-sp-client.js')).getAmazonSellerId(account.id)
    const sp: any = await (await import('../../lib/amazon-sp-client.js')).getAmazonSpClient(account.id)

    const reasonCode = mapReasonToAmazon(reason)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header><DocumentVersion>1.01</DocumentVersion><MerchantIdentifier>${merchantToken}</MerchantIdentifier></Header>
  <MessageType>OrderAcknowledgement</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <OrderAcknowledgement>
      <AmazonOrderID>${amazonOrderId}</AmazonOrderID>
      <StatusCode>Failure</StatusCode>
      <Item><AmazonOrderItemCode>0</AmazonOrderItemCode><CancelReason>${reasonCode}</CancelReason></Item>
    </OrderAcknowledgement>
  </Message>
</AmazonEnvelope>`

    const docRes: any = await sp.callAPI({
      operation: 'createFeedDocument',
      endpoint: 'feeds',
      body: { contentType: 'text/xml; charset=UTF-8' },
    })
    // gateway-exempt: pre-signed feed-document upload to Amazon's storage; the feed itself goes through the gateway
    const upload = await fetch(docRes.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
      body: xml,
    })
    if (!upload.ok) throw new Error(`feed upload HTTP ${upload.status}`)

    const feedRes: any = await sp.callAPI({
      operation: 'createFeed',
      endpoint: 'feeds',
      body: {
        feedType: 'POST_ORDER_ACKNOWLEDGEMENT_DATA',
        marketplaceIds,
        inputFeedDocumentId: docRes.feedDocumentId,
      },
    })
    return {
      ok: true,
      channel: 'AMAZON',
      channelOrderId: amazonOrderId,
      ackRef: feedRes.feedId,
      dryRun: false,
    }
  } catch (err: any) {
    return {
      ok: false,
      channel: 'AMAZON',
      channelOrderId: amazonOrderId,
      ackRef: null,
      dryRun: false,
      error: err?.message ?? String(err),
    }
  }
}

// ── eBay ───────────────────────────────────────────────────────────────
function isEbayReal() {
  return process.env.NEXUS_ENABLE_EBAY_ORDER_CANCEL === 'true'
}

export async function cancelOnEbay(
  ebayOrderId: string,
  reason: string | undefined,
  connectionId: string,
  orderId?: string,
): Promise<ChannelCancelResult> {
  if (!isEbayReal()) {
    return {
      ok: true,
      channel: 'EBAY',
      channelOrderId: ebayOrderId,
      ackRef: null,
      dryRun: true,
    }
  }
  try {
    const { EbayAuthService } = await import('../ebay-auth.service.js')
    const { recordApiCall } = await import('../outbound-api-call-log.service.js')
    const auth = new EbayAuthService()
    const token = await auth.getValidToken(connectionId)
    const url = `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}/cancellation_request`
    return await recordApiCall<ChannelCancelResult>(
      {
        channel: 'EBAY',
        operation: 'cancelOrder',
        endpoint: '/sell/fulfillment/v1/order/{orderId}/cancellation_request',
        method: 'POST',
        connectionId,
        triggeredBy: 'manual',
        orderId,
      },
      async () => {
        const res = await ebaySend(connectionId, url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US',
          },
          body: JSON.stringify({ cancellationReason: mapReasonToEbay(reason) }),
        })
        if (res.status === 201) {
          const loc = res.headers.get('location') ?? ''
          return {
            ok: true,
            channel: 'EBAY' as const,
            channelOrderId: ebayOrderId,
            ackRef: loc.split('/').pop() ?? `unknown-${Date.now()}`,
            dryRun: false,
          }
        }
        const text = await res.text()
        let body: any = null
        try { body = text ? JSON.parse(text) : null } catch { /* */ }
        const firstErr = body?.errors?.[0]
        const err = new Error(
          firstErr?.message ?? `eBay API error ${res.status}: ${text.slice(0, 500)}`,
        ) as Error & { statusCode: number; body: unknown }
        err.statusCode = res.status
        err.body = body ?? text
        throw err
      },
    )
  } catch (err: any) {
    return {
      ok: false,
      channel: 'EBAY',
      channelOrderId: ebayOrderId,
      ackRef: null,
      dryRun: false,
      error: err?.message ?? String(err),
    }
  }
}

// ── Shopify ────────────────────────────────────────────────────────────
function isShopifyReal() {
  return process.env.NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL === 'true'
}

/**
 * P1.4b — the order's own Shopify account on the 2026-07 GraphQL client (services/shopify/
 * order-actions.service.ts), not the env credentials. The old `orderCancel(input:)` form no longer
 * exists on the API. No refund (the operator refunds separately), no restock (Nexus already restocked).
 */
export async function cancelOnShopify(
  shopifyOrderId: string,
  reason: string | undefined,
  orderId?: string,
): Promise<ChannelCancelResult> {
  if (!isShopifyReal()) {
    return {
      ok: true,
      channel: 'SHOPIFY',
      channelOrderId: shopifyOrderId,
      ackRef: null,
      dryRun: true,
    }
  }
  try {
    const { shopifyOrderAccount, cancelShopifyOrder } = await import('../shopify/order-actions.service.js')
    const accountId = await shopifyOrderAccount(orderId ? { orderId } : { channelOrderId: shopifyOrderId })
    const reasonEnum =
      reason && /inventory|stock/i.test(reason) ? 'INVENTORY'
      : reason && /fraud/i.test(reason) ? 'FRAUD'
      : reason && /customer|buyer/i.test(reason) ? 'CUSTOMER'
      : 'OTHER'
    const { jobId } = await cancelShopifyOrder({ accountId, channelOrderId: shopifyOrderId, reason: reasonEnum, staffNote: reason ?? 'Cancelled via Nexus' })
    return {
      ok: true,
      channel: 'SHOPIFY',
      channelOrderId: shopifyOrderId,
      ackRef: jobId,
      dryRun: false,
    }
  } catch (err: any) {
    return {
      ok: false,
      channel: 'SHOPIFY',
      channelOrderId: shopifyOrderId,
      ackRef: null,
      dryRun: false,
      error: err?.message ?? String(err),
    }
  }
}

export const __test = { mapReasonToAmazon, mapReasonToEbay, isAmazonReal, isEbayReal, isShopifyReal }
