/**
 * O.16b — Amazon Buy Shipping (Merchant Fulfillment Network).
 *
 * SP-API Merchant Fulfillment endpoints:
 *   POST /mfn/v0/eligibleShippingServices  → rate quotes
 *   POST /mfn/v0/shipments                  → purchase label (commits)
 *   DELETE /mfn/v0/shipments/{id}           → cancel before pickup
 *
 * Why operators want it: Buy Shipping rates are usually 5–15%
 * cheaper than retail Sendcloud / direct-carrier rates because
 * Amazon negotiates volume discounts and resells. It also
 * auto-credits VTR (valid tracking) for FBM orders, so it's the
 * lowest-friction way to keep VTR ≥95%.
 *
 * Why this commit ships as a STUB:
 *   1. Real SP-API calls require sandbox testing first; misconfigured
 *      production calls can buy real labels with real money.
 *   2. PDF label storage needs a Cloudinary / S3 integration commit
 *      of its own.
 *   3. Cancel-before-pickup needs a refund flow that the operator
 *      must approve to avoid runaway costs on misclicks.
 *
 * What this commit DOES land:
 *   - Service shape with real SP-API call sites marked clearly
 *   - dryRun mock rates that mirror the real response shape so the
 *     UI can be exercised end-to-end without credentials
 *   - Env flag NEXUS_ENABLE_AMAZON_BUY_SHIPPING=true to flip
 *     between dryRun and real (real path returns a "not implemented
 *     yet" error today; the actual SP-API client wiring is the
 *     follow-up commit)
 *
 * Operator impact today: visible "Buy Shipping rates" button on
 * FBM order detail returns mock quotes; purchasing returns a stub
 * confirmation. Production flip is one env var + a single follow-up
 * commit (the SP-API client + Cloudinary label storage) away.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const ENABLED = process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING === 'true'

export interface RateQuote {
  serviceId: string
  carrierName: string
  serviceName: string
  totalCharge: { currencyCode: string; amount: number }
  estimatedTransitDays: number
  guaranteedDelivery: boolean
}

export interface RateQuoteResponse {
  orderId: string
  channelOrderId: string
  rates: RateQuote[]
  source: 'real' | 'dryRun'
  message?: string
}

export interface LabelPurchaseResponse {
  orderId: string
  shipmentId: string
  trackingNumber: string
  labelUrl: string
  totalCharge: { currencyCode: string; amount: number }
  source: 'real' | 'dryRun'
  message?: string
}

const MOCK_RATES: RateQuote[] = [
  {
    serviceId: 'mock-amzl-2d',
    carrierName: 'AMZL',
    serviceName: 'Standard 2-day',
    totalCharge: { currencyCode: 'EUR', amount: 4.99 },
    estimatedTransitDays: 2,
    guaranteedDelivery: false,
  },
  {
    serviceId: 'mock-amzl-1d',
    carrierName: 'AMZL',
    serviceName: 'Premium next-day',
    totalCharge: { currencyCode: 'EUR', amount: 8.49 },
    estimatedTransitDays: 1,
    guaranteedDelivery: true,
  },
  {
    serviceId: 'mock-poste-3d',
    carrierName: 'Poste Italiane',
    serviceName: 'Pacco Standard',
    totalCharge: { currencyCode: 'EUR', amount: 3.95 },
    estimatedTransitDays: 3,
    guaranteedDelivery: false,
  },
]

export async function getBuyShippingRates(orderId: string): Promise<RateQuoteResponse> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      channel: true,
      fulfillmentMethod: true,
      channelOrderId: true,
      shippingAddress: true,
    },
  })
  if (!order) throw new Error(`Order ${orderId} not found`)
  if (order.channel !== 'AMAZON' || order.fulfillmentMethod !== 'FBM') {
    throw new Error('Buy Shipping only applies to Amazon FBM orders')
  }

  if (!ENABLED) {
    logger.info('amazon-buy-shipping: returning dryRun rates', { orderId })
    return {
      orderId,
      channelOrderId: order.channelOrderId,
      rates: MOCK_RATES,
      source: 'dryRun',
      message:
        'NEXUS_ENABLE_AMAZON_BUY_SHIPPING is not set — returning mock rates so the UI can be exercised. Production flip requires the SP-API Merchant Fulfillment client wire (follow-up commit).',
    }
  }

  // Real path. Requires:
  //   1. amazon-sp-api.client wired to /mfn/v0/eligibleShippingServices
  //   2. Order shippingAddress mapped to SP-API ShipFromAddress shape
  //   3. Box dimensions + weight (currently not on Order; default to
  //      a "standard parcel" 30×20×10 cm / 1 kg until variant-level
  //      packaging metadata lands)
  // Until the client wires up:
  throw new Error(
    'Real Buy Shipping rate-quote path not yet implemented; toggle NEXUS_ENABLE_AMAZON_BUY_SHIPPING=false to use dryRun, or ship the follow-up commit that wires amazon-sp-api.client.eligibleShippingServices().',
  )
}

export async function purchaseBuyShippingLabel(args: {
  orderId: string
  serviceId: string
}): Promise<LabelPurchaseResponse> {
  const order = await prisma.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, channelOrderId: true, channel: true, fulfillmentMethod: true },
  })
  if (!order) throw new Error(`Order ${args.orderId} not found`)
  if (order.channel !== 'AMAZON' || order.fulfillmentMethod !== 'FBM') {
    throw new Error('Buy Shipping only applies to Amazon FBM orders')
  }

  if (!ENABLED) {
    const mockTracking = `MOCK${Date.now()}`
    logger.info('amazon-buy-shipping: returning dryRun label', {
      orderId: args.orderId,
      serviceId: args.serviceId,
      mockTracking,
    })
    return {
      orderId: args.orderId,
      shipmentId: `mock-ship-${Date.now()}`,
      trackingNumber: mockTracking,
      labelUrl:
        'https://placeholder.example/buy-shipping-label.pdf', // not a real URL; UI shows it disabled
      totalCharge: { currencyCode: 'EUR', amount: 0 },
      source: 'dryRun',
      message:
        'dryRun: no real label purchased. Flip NEXUS_ENABLE_AMAZON_BUY_SHIPPING=true and ship the SP-API client wire to make this real.',
    }
  }

  throw new Error(
    'Real Buy Shipping label-purchase path not yet implemented; needs the SP-API client wire + Cloudinary/S3 label storage.',
  )
}
