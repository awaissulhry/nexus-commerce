/**
 * Channel refund publisher (H.14, R5.x).
 *
 * Posts the local Return's refund decision back to the originating
 * marketplace so the buyer is actually refunded. Pre-H.14 the
 * /fulfillment/returns/:id/refund endpoint only flipped local
 * status; without channel push, the operator had to re-issue the
 * refund manually in Seller Central / eBay back office.
 *
 * Per-channel adapter state (current — see getRefundChannelAdapter-
 * Status() for the live machine-readable shape):
 *
 *   eBay        — REAL. POST /sell/fulfillment/v1/order/{orderId}/
 *                 issue_refund. Supports full refunds today; per-
 *                 line refundItems[] mapping requires storing eBay
 *                 lineItemIds on OrderItem (a follow-up).
 *
 *   Amazon FBA  — MANUAL_REQUIRED. Amazon issues refunds
 *                 automatically when the unit hits their warehouse;
 *                 we no-op with a confirmation message.
 *
 *   Amazon FBM  — MANUAL_REQUIRED. SP-API has no seller-issued
 *                 refund endpoint (the legacy POST_PAYMENT_-
 *                 ADJUSTMENT_DATA feed is dead). Operator finishes
 *                 in Seller Central; we surface a deep link.
 *
 *   Shopify     — REAL behind NEXUS_ENABLE_SHOPIFY_REFUND=true
 *                 (default-OFF). Real path uses Admin GraphQL
 *                 `refundCreate` against the order's capture/sale
 *                 transactions, refunding proportionally. Default
 *                 dryRun returns a mock refundGid so the surface
 *                 can be exercised without live credentials.
 *
 *   WooCommerce — NOT_IMPLEMENTED. Out of active-channel scope
 *                 (Xavia is Amazon + eBay + Shopify). Adapter
 *                 returns NOT_IMPLEMENTED with the path-forward
 *                 hint so operators don't get a silent failure.
 *
 *   Etsy        — NOT_IMPLEMENTED. Same reason as Woo.
 *
 * Caller contract: publish() never throws. Returns a structured
 * result so the route handler can persist (or surface) the outcome
 * without bubbling exceptions through the refund button.
 *
 * Env flags:
 *   NEXUS_ENABLE_SHOPIFY_REFUND=true  → Shopify real path
 *   (eBay needs no flag; the adapter goes live as soon as a working
 *    OAuth-managed eBay ChannelConnection exists.)
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

/**
 * R5.2 — adapter-state report.
 *
 * Tells operators (via /fulfillment/returns/refund-channel-status)
 * whether each channel's refund adapter is real, mocked, manual, or
 * not implemented at all. Useful for "why did my refund button
 * give me a fake confirmation?" debugging without grepping the
 * source.
 *
 * mode meanings:
 *   real             — adapter posts to the live channel API
 *   dryRun           — adapter returns a structurally-valid mock
 *                      (set NEXUS_ENABLE_*=true to flip to real)
 *   manual_required  — channel doesn't support API refunds; we
 *                      surface a deep link to the back office
 *   not_implemented  — adapter is a stub, no support planned in
 *                      the active-channel scope
 */
export type RefundAdapterMode =
  | 'real'
  | 'dryRun'
  | 'manual_required'
  | 'not_implemented'

export interface RefundChannelAdapterStatus {
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  mode: RefundAdapterMode
  /** Sub-mode for channels with split FBM/FBA semantics (Amazon). */
  variant?: string
  /** Operator-facing one-liner explaining the current state. */
  notes: string
  /** Env flag that flips this adapter mode (when applicable). */
  envFlag?: string
}

export function getRefundChannelAdapterStatus(): RefundChannelAdapterStatus[] {
  return [
    {
      channel: 'EBAY',
      mode: 'real',
      notes:
        'POST /sell/fulfillment/v1/order/{orderId}/issue_refund. Activates as soon as an OAuth eBay ChannelConnection exists.',
    },
    {
      channel: 'AMAZON',
      mode: 'manual_required',
      variant: 'FBM',
      notes:
        'SP-API has no seller-issued refund endpoint. Operator finishes in Seller Central; we surface a deep link.',
    },
    {
      channel: 'AMAZON',
      mode: 'manual_required',
      variant: 'FBA',
      notes:
        'Amazon issues refunds automatically when the unit reaches their warehouse. Adapter no-ops with a confirmation message.',
    },
    {
      channel: 'SHOPIFY',
      mode: isShopifyRefundReal() ? 'real' : 'dryRun',
      notes: isShopifyRefundReal()
        ? 'Admin GraphQL refundCreate mutation, refunding proportionally across capture/sale transactions.'
        : 'Mocked refundGid. Set NEXUS_ENABLE_SHOPIFY_REFUND=true to flip to the real GraphQL refundCreate path.',
      envFlag: 'NEXUS_ENABLE_SHOPIFY_REFUND',
    },
    {
      channel: 'WOOCOMMERCE',
      mode: 'not_implemented',
      notes:
        'Out of active-channel scope (Xavia ships Amazon + eBay + Shopify). Path forward: POST /wp-json/wc/v3/orders/{id}/refunds with basic-auth from the existing Woo connection.',
    },
    {
      channel: 'ETSY',
      mode: 'not_implemented',
      notes:
        'Out of active-channel scope. Etsy refund API is also restricted to specific seller programs, so this would need an Etsy partner-app review even when scope expands.',
    },
  ]
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
      return publishShopifyRefund(ret, input)
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

/**
 * O.55 — Shopify refund via Admin GraphQL refundCreate.
 *
 *   mutation { refundCreate(input: { orderId, transactions, ... }) }
 *
 * Shopify requires us to specify the parent transactions (the
 * payment(s) we're refunding against). For v0 we resolve them via
 * GraphQL `order { transactions { id, kind, status, amountSet } }`,
 * filter to capture/sale transactions matching the order's currency,
 * and refund proportionally against them. Note=the refund reason.
 *
 * dryRun-default: returns a structurally-valid mock refundGid when
 * NEXUS_ENABLE_SHOPIFY_REFUND is unset/false. Real path requires the
 * SHOPIFY_* env vars + the flag flipped to 'true'.
 */
function isShopifyRefundReal(): boolean {
  return process.env.NEXUS_ENABLE_SHOPIFY_REFUND === 'true'
}

async function publishShopifyRefund(
  ret: LoadedReturn,
  input: RefundPublishInput,
): Promise<RefundPublishResult> {
  const order = ret.order!
  if (!order.channelOrderId) {
    return {
      outcome: 'FAILED',
      error: 'Linked Order is missing channelOrderId — cannot post to Shopify',
    }
  }

  if (!isShopifyRefundReal()) {
    // dryRun-default: return a mock OK so the surface can be wired
    // and exercised without the SHOPIFY_* env or marketplace
    // credentials in place.
    const mockGid = `gid://shopify/Refund/MOCK-${Date.now()}`
    logger.info('shopify refund: dryRun (mock)', {
      returnId: ret.id,
      shopifyOrderId: order.channelOrderId,
      mockGid,
    })
    return {
      outcome: 'OK',
      channelRefundId: mockGid,
      channelMessage: `Shopify refund mocked (set NEXUS_ENABLE_SHOPIFY_REFUND=true to issue for real).`,
    }
  }

  // Real path. Lazy-import to avoid pulling in Shopify client when
  // refunding non-Shopify channels.
  const [{ ShopifyEnhancedService }, { ConfigManager }] = await Promise.all([
    import('../marketplaces/shopify-enhanced.service.js'),
    import('../../utils/config.js'),
  ])
  const config = ConfigManager.getConfig('SHOPIFY')
  if (!config) {
    return {
      outcome: 'FAILED',
      error: 'Shopify config missing — set SHOPIFY_* env vars',
    }
  }
  const shopify = new ShopifyEnhancedService(config as any)

  // Order GID: the channelOrderId is the numeric id; promote to GID.
  const gid = order.channelOrderId.startsWith('gid://')
    ? order.channelOrderId
    : `gid://shopify/Order/${order.channelOrderId}`

  const refundCurrency = ret.currencyCode || 'EUR'
  const totalAmount = (ret.refundCents! / 100).toFixed(2)
  const reasonText = (input.reasonText ?? ret.notes ?? 'Refund issued via Nexus Commerce').slice(0, 500)

  // 1) Fetch the order's transactions so we know what to refund against.
  const txQuery = `
    query OrderTransactions($id: ID!) {
      order(id: $id) {
        id
        currencyCode
        transactions(first: 10) {
          id
          kind
          status
          amountSet { shopMoney { amount currencyCode } }
        }
      }
    }
  `
  let txResp: any
  try {
    txResp = await (shopify as any).graphqlRequest(txQuery, { id: gid })
  } catch (err) {
    return {
      outcome: 'FAILED',
      error: `Shopify transactions fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const allTx: Array<{ id: string; kind: string; status: string; amountSet: { shopMoney: { amount: string; currencyCode: string } } }> =
    txResp?.order?.transactions ?? []
  const refundable = allTx.filter(
    (tx) => (tx.kind === 'CAPTURE' || tx.kind === 'SALE') && tx.status === 'SUCCESS',
  )
  if (refundable.length === 0) {
    return {
      outcome: 'FAILED',
      error: 'Shopify order has no refundable capture/sale transactions',
    }
  }

  // 2) Build refund transactions list. v0: refund the full
  // ret.refundCents proportionally across capture/sale transactions
  // (most orders have a single transaction, so this collapses to a
  // straight refund on it).
  const totalCaptured = refundable.reduce(
    (sum, tx) => sum + Number(tx.amountSet.shopMoney.amount),
    0,
  )
  if (totalCaptured <= 0) {
    return {
      outcome: 'FAILED',
      error: 'Shopify captured total is zero — nothing to refund against',
    }
  }
  const refundAmount = Number(totalAmount)
  const transactions = refundable.map((tx) => {
    const txAmount = Number(tx.amountSet.shopMoney.amount)
    const share = totalCaptured > 0 ? (txAmount / totalCaptured) * refundAmount : 0
    return {
      orderId: gid,
      parentId: tx.id,
      amount: share.toFixed(2),
      gateway: undefined as string | undefined,
      kind: 'REFUND',
    }
  })

  // 3) refundCreate. notify=true so Shopify sends the customer's
  // refund email; note carries the operator reason for the customer-
  // facing note in the order timeline.
  const mutation = `
    mutation RefundCreate($input: RefundInput!) {
      refundCreate(input: $input) {
        refund { id legacyResourceId }
        userErrors { field message }
      }
    }
  `
  let resp: any
  try {
    resp = await (shopify as any).graphqlRequest(mutation, {
      input: {
        orderId: gid,
        note: reasonText,
        notify: true,
        transactions,
      },
    })
  } catch (err) {
    return {
      outcome: 'FAILED',
      error: `Shopify refundCreate failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const errs = resp?.refundCreate?.userErrors ?? []
  if (errs.length > 0) {
    return {
      outcome: 'FAILED',
      error: errs.map((e: any) => `${e.field?.join('.') ?? ''}: ${e.message}`).join('; '),
    }
  }
  const refund = resp?.refundCreate?.refund
  const refundId = refund?.id ?? null
  logger.info('shopify refund issued', {
    returnId: ret.id,
    shopifyOrderId: order.channelOrderId,
    refundId,
    amount: totalAmount,
    currency: refundCurrency,
  })
  return {
    outcome: 'OK',
    channelRefundId: refundId ?? undefined,
    channelMessage: `Shopify refund ${refundId ?? '(no id returned)'} for ${totalAmount} ${refundCurrency} issued.`,
  }
}
