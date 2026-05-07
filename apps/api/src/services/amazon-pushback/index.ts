/**
 * O.9 — Amazon FBM shipping confirmation via SP-API Feeds.
 *
 * Amazon's only path to confirm an FBM order's tracking is the Feeds
 * API with feed_type=POST_ORDER_FULFILLMENT_DATA. We submit the feed
 * and stash the feedId on the TrackingMessageLog response payload;
 * O.12's retry job polls the feed until COMPLETE / CANCELLED / FATAL
 * and finalizes the log entry.
 *
 * Three env knobs match the Sendcloud pattern:
 *   NEXUS_AMAZON_SHIP_CONFIRM_ENV=sandbox|production  default 'sandbox'
 *   NEXUS_ENABLE_AMAZON_SHIP_CONFIRM=true|false       default 'false'
 *
 * When ENABLE=false (default), submitShippingConfirmation returns a
 * structurally-valid mock feed reference. The retry job sees the mock
 * feedId, polls (also mocked), marks SUCCESS, and the rest of the
 * system behaves as if Amazon ack'd. Operator flips ENABLE=true once
 * sandbox creds + SP-API permissions are in place + a single canary
 * order completes the round trip.
 *
 * Why Feeds and not direct REST: Amazon's Orders API can update
 * fulfillment status only for AFN (FBA) orders. For MFN (FBM) — which
 * is what Awa runs — the Feeds + POST_ORDER_FULFILLMENT_DATA path is
 * the official channel. See SP-API "FBM Shipping Confirmation" docs.
 */

import prisma from '../../db.js'

// ── Public types ──────────────────────────────────────────────────────
export interface ShippingConfirmationInput {
  amazonOrderId: string
  // Amazon-recognized carrier code. We map our Sendcloud carrier code
  // through CARRIER_MAP below; if no mapping, we fall back to "Other"
  // and pass the carrier_name through.
  carrierCode: string
  carrierName?: string | null
  trackingNumber: string
  shippedAt: Date
  shippingMethod?: string | null
  // Optional per-line items array. Amazon doesn't strictly require it
  // when all items in the order ship together — passing the order ID
  // alone implies "everything in this order is now shipped".
  items?: Array<{ amazonOrderItemId: string; quantity: number }>
}

export interface FeedSubmissionResult {
  feedId: string
  feedDocumentId: string
  // When dryRun=true, this is the mock response. Real responses
  // include the same fields; the boolean lets log readers see at a
  // glance whether a row exercised the real path.
  dryRun: boolean
}

export class AmazonPushbackError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly response?: unknown,
  ) {
    super(message)
    this.name = 'AmazonPushbackError'
  }
}

// Amazon-recognized carrier codes (subset). Sendcloud's carrier codes
// map through here when we push the confirmation. Anything not in the
// map ships under "Other" with carrier_name=our internal code.
const CARRIER_MAP: Record<string, string> = {
  BRT: 'BRT', // Amazon recognizes BRT explicitly
  POSTE: 'Poste Italiane',
  GLS: 'GLS',
  SDA: 'SDA',
  TNT: 'TNT',
  DHL: 'DHL',
  UPS: 'UPS',
  FEDEX: 'FedEx',
  DPD: 'DPD',
  CHRONOPOST: 'Chronopost',
  // Sendcloud-aggregated carriers — Amazon doesn't recognize "Sendcloud"
  // as a carrier, so we surface the underlying carrier when we know it,
  // else fall to "Other".
  SENDCLOUD: 'Other',
}

function isReal(): boolean {
  return process.env.NEXUS_ENABLE_AMAZON_SHIP_CONFIRM === 'true'
}

/**
 * Build the POST_ORDER_FULFILLMENT_DATA XML payload. Amazon expects
 * UTF-8 XML; we keep it minimal and strict-schema.
 */
function buildFeedXml(input: ShippingConfirmationInput, merchantToken: string): string {
  const carrierName = CARRIER_MAP[input.carrierCode.toUpperCase()] ?? input.carrierName ?? 'Other'
  const shippedAt = input.shippedAt.toISOString()
  const itemsXml = input.items?.length
    ? input.items.map((it) => `
        <Item>
          <AmazonOrderItemCode>${escapeXml(it.amazonOrderItemId)}</AmazonOrderItemCode>
          <Quantity>${it.quantity}</Quantity>
        </Item>`).join('')
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>${escapeXml(merchantToken)}</MerchantIdentifier>
  </Header>
  <MessageType>OrderFulfillment</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <OrderFulfillment>
      <AmazonOrderID>${escapeXml(input.amazonOrderId)}</AmazonOrderID>
      <FulfillmentDate>${shippedAt}</FulfillmentDate>
      <FulfillmentData>
        <CarrierCode>${escapeXml(carrierName)}</CarrierCode>
        ${input.shippingMethod ? `<ShippingMethod>${escapeXml(input.shippingMethod)}</ShippingMethod>` : ''}
        <ShipperTrackingNumber>${escapeXml(input.trackingNumber)}</ShipperTrackingNumber>
      </FulfillmentData>${itemsXml}
    </OrderFulfillment>
  </Message>
</AmazonEnvelope>`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Submit one shipping confirmation. Three SP-API calls in real mode:
 *   1. POST /feeds/2021-06-30/documents → returns { feedDocumentId, url }
 *   2. PUT to the returned URL with the XML body
 *   3. POST /feeds/2021-06-30/feeds with { feedType, marketplaceIds,
 *      inputFeedDocumentId } → returns { feedId }
 *
 * In dryRun mode (default), returns a mock { feedId, feedDocumentId }
 * without any network I/O.
 */
export async function submitShippingConfirmation(
  input: ShippingConfirmationInput,
  marketplaceIds: string[],
): Promise<FeedSubmissionResult> {
  if (!isReal()) {
    const mockId = `MOCK-FEED-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    return {
      feedId: mockId,
      feedDocumentId: `MOCK-DOC-${mockId}`,
      dryRun: true,
    }
  }

  // Real path. Imports are deferred so dryRun mode never loads the
  // (heavy) SellingPartner client + its AWS auth chain.
  const { SellingPartner } = await import('amazon-sp-api')
  const merchantToken = process.env.AMAZON_MERCHANT_TOKEN ?? process.env.AMAZON_SELLER_ID
  if (!merchantToken) {
    throw new AmazonPushbackError(
      'AMAZON_MERCHANT_TOKEN / AMAZON_SELLER_ID env not set',
      500,
      'MERCHANT_TOKEN_MISSING',
    )
  }

  const sp: any = new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as any,
    refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  })

  // Step 1: create feed document slot.
  const docRes: any = await sp.callAPI({
    operation: 'createFeedDocument',
    endpoint: 'feeds',
    body: { contentType: 'text/xml; charset=UTF-8' },
  })
  const feedDocumentId: string = docRes.feedDocumentId
  const uploadUrl: string = docRes.url

  // Step 2: upload the XML body to the returned URL.
  const xml = buildFeedXml(input, merchantToken)
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    body: xml,
  })
  if (!uploadRes.ok) {
    throw new AmazonPushbackError(
      `Feed upload failed: HTTP ${uploadRes.status}`,
      uploadRes.status,
      'UPLOAD_FAILED',
    )
  }

  // Step 3: create the feed referencing the uploaded document.
  const feedRes: any = await sp.callAPI({
    operation: 'createFeed',
    endpoint: 'feeds',
    body: {
      feedType: 'POST_ORDER_FULFILLMENT_DATA',
      marketplaceIds,
      inputFeedDocumentId: feedDocumentId,
    },
  })

  return {
    feedId: feedRes.feedId,
    feedDocumentId,
    dryRun: false,
  }
}

/**
 * Build a ShippingConfirmationInput from a Shipment row + its Order.
 * Used by the retry worker (O.12) to compose the Amazon call from the
 * TrackingMessageLog request payload.
 */
export async function buildConfirmationInputForShipment(
  shipmentId: string,
): Promise<ShippingConfirmationInput | null> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { select: { channelOrderId: true, channel: true } } },
  })
  if (!shipment || !shipment.order) return null
  if (shipment.order.channel !== 'AMAZON') return null
  if (!shipment.trackingNumber || !shipment.shippedAt) return null
  return {
    amazonOrderId: shipment.order.channelOrderId,
    carrierCode: shipment.carrierCode,
    trackingNumber: shipment.trackingNumber,
    shippedAt: shipment.shippedAt,
    shippingMethod: shipment.serviceName ?? null,
  }
}

export const __test = { isReal, buildFeedXml, escapeXml, CARRIER_MAP }
