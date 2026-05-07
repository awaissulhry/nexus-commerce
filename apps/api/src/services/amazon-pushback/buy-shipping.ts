/**
 * O.9b — Amazon Buy Shipping integration.
 *
 * Distinct from O.9 (submitShippingConfirmation): Buy Shipping lets us
 * PURCHASE the shipping label directly through Amazon at Amazon-
 * discounted carrier rates. Often 30-50% cheaper than retail Sendcloud
 * rates for FBM orders — material to FBM unit economics.
 *
 * SP-API: Merchant Fulfillment v0 (mfn/v0).
 *   POST /mfn/v0/eligibleShippingServices  → list available services + rates
 *   POST /mfn/v0/shipments                 → purchase a shipment (creates label)
 *   GET  /mfn/v0/shipments/{id}            → fetch shipment + label
 *   DELETE /mfn/v0/shipments/{id}          → cancel
 *
 * Wired into the outbound flow via the rules engine (O.16): operator
 * defines a rule like "for Amazon FBM orders weighing < 2kg, prefer
 * Buy Shipping over Sendcloud direct". When the rule fires, the
 * shipment is created with carrierCode=AMAZON_BUY_SHIPPING, and the
 * print-label endpoint routes to this module instead of Sendcloud.
 *
 * Wiring into print-label is a follow-up commit (lands in O.16). This
 * commit ships the producer + a typed surface so callers can compose.
 *
 * Env knobs (matching the rest of Wave 4):
 *   NEXUS_ENABLE_AMAZON_BUY_SHIPPING=true|false   default 'false'
 *
 * dryRun mode (default) returns structurally-identical mocks so the
 * full pipeline (rate compare → purchase → label fetch) can be wired
 * and exercised without touching Amazon.
 */

// ── Public types ──────────────────────────────────────────────────────
export interface ShipmentAddress {
  name: string
  addressLine1: string
  addressLine2?: string
  city: string
  stateOrProvinceCode?: string
  postalCode: string
  countryCode: string
  email?: string
  phone?: string
}

export interface ShipmentItem {
  orderItemId: string
  quantity: number
}

export interface ShipmentRequestDetails {
  amazonOrderId: string
  itemList: ShipmentItem[]
  shipFromAddress: ShipmentAddress
  // package weight in grams; converted to {value, unit:'GRAMS'} on the wire
  weightGrams: number
  // package dimensions in cm; if any are 0 we omit the dimensions field
  // (Amazon will still rate-shop on weight + service eligibility)
  lengthCm?: number
  widthCm?: number
  heightCm?: number
  // Amazon shipping options (carrier mustShip / mustNotShip lists, etc.)
  shippingServiceOptions?: {
    deliveryExperience?: 'DeliveryConfirmationWithAdultSignature'
      | 'DeliveryConfirmationWithSignature'
      | 'DeliveryConfirmationWithoutSignature'
      | 'NoTracking'
    carrierWillPickUp?: boolean
    declaredValue?: { currencyCode: string; amount: number }
  }
}

export interface EligibleShippingService {
  shippingServiceName: string
  carrierName: string
  shippingServiceId: string
  shippingServiceOfferId: string
  rate: { currencyCode: string; amount: number }
  estimatedDeliveryDate?: string
  earliestEstimatedDeliveryDate?: string
  latestEstimatedDeliveryDate?: string
  shippingServiceOptions?: {
    deliveryExperience?: string
    carrierWillPickUp?: boolean
  }
}

export interface PurchasedShipment {
  amazonShipmentId: string
  shippingServiceId: string
  carrierName: string
  trackingId: string | null
  labelData: string | null // base64 PDF when present
  labelFormat: 'PDF' | 'PNG' | 'ZPL203' | string | null
  rate: { currencyCode: string; amount: number }
  status: string
  dryRun: boolean
}

export class BuyShippingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly response?: unknown,
  ) {
    super(message)
    this.name = 'BuyShippingError'
  }
}

function isReal(): boolean {
  return process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING === 'true'
}

/**
 * Fetch eligible shipping services + their rates for a shipment. The
 * rules engine (O.16) calls this when an operator wants to compare
 * Buy Shipping vs Sendcloud rates; the outbound UI may also expose a
 * "compare rates" button per shipment.
 */
export async function getEligibleShippingServices(
  details: ShipmentRequestDetails,
): Promise<EligibleShippingService[]> {
  if (!isReal()) {
    // Mock returns three plausible services so rate-compare UI can be
    // exercised end-to-end. Rates intentionally span low→high.
    return [
      {
        shippingServiceName: 'AMZ_PARTNERED_DPD_GROUND',
        carrierName: 'DPD',
        shippingServiceId: 'AMZ_PD_GROUND',
        shippingServiceOfferId: `MOCK-OFFER-DPD-${Date.now()}`,
        rate: { currencyCode: 'EUR', amount: 4.99 },
        estimatedDeliveryDate: new Date(Date.now() + 86400000 * 3).toISOString(),
      },
      {
        shippingServiceName: 'AMZ_PARTNERED_UPS_STANDARD',
        carrierName: 'UPS',
        shippingServiceId: 'AMZ_UPS_STD',
        shippingServiceOfferId: `MOCK-OFFER-UPS-${Date.now()}`,
        rate: { currencyCode: 'EUR', amount: 6.49 },
        estimatedDeliveryDate: new Date(Date.now() + 86400000 * 2).toISOString(),
      },
      {
        shippingServiceName: 'AMZ_PARTNERED_DHL_EXPRESS',
        carrierName: 'DHL',
        shippingServiceId: 'AMZ_DHL_EXP',
        shippingServiceOfferId: `MOCK-OFFER-DHL-${Date.now()}`,
        rate: { currencyCode: 'EUR', amount: 12.99 },
        estimatedDeliveryDate: new Date(Date.now() + 86400000).toISOString(),
      },
    ]
  }

  const sp = await getSpClient()
  const res: any = await sp.callAPI({
    operation: 'getEligibleShipmentServices',
    endpoint: 'merchantFulfillment',
    body: { ShipmentRequestDetails: toAmazonShape(details) },
  })
  const services = res?.ShippingServiceList ?? []
  return services.map(fromAmazonService)
}

/**
 * Purchase a shipment — buys the label + creates the Amazon-side
 * shipment record. Returns the label as base64-encoded PDF (or other
 * format depending on the offer). Caller persists the label PDF +
 * tracking ID onto the Shipment row.
 */
export async function createShipment(
  details: ShipmentRequestDetails,
  shippingServiceOfferId: string,
): Promise<PurchasedShipment> {
  if (!isReal()) {
    const mockId = `MOCK-AMZ-SHIP-${Date.now()}`
    return {
      amazonShipmentId: mockId,
      shippingServiceId: shippingServiceOfferId,
      carrierName: 'Mock Buy Shipping',
      trackingId: `MOCK-BS-${Math.floor(Math.random() * 1e10)}`,
      labelData: Buffer.from('%PDF-1.4\n%mock-buyshipping-label\n', 'utf8').toString('base64'),
      labelFormat: 'PDF',
      rate: { currencyCode: 'EUR', amount: 5.99 },
      status: 'Purchased',
      dryRun: true,
    }
  }

  const sp = await getSpClient()
  const res: any = await sp.callAPI({
    operation: 'createShipment',
    endpoint: 'merchantFulfillment',
    body: {
      ShipmentRequestDetails: toAmazonShape(details),
      ShippingServiceId: shippingServiceOfferId,
    },
  })
  const shipment = res?.Shipment
  if (!shipment) {
    throw new BuyShippingError('createShipment returned no Shipment', 502, 'EMPTY_RESPONSE', res)
  }
  return {
    amazonShipmentId: shipment.ShipmentId,
    shippingServiceId: shipment.ShippingService?.ShippingServiceId,
    carrierName: shipment.ShippingService?.CarrierName ?? 'Unknown',
    trackingId: shipment.TrackingId ?? null,
    labelData: shipment.Label?.FileContents?.Contents ?? null,
    labelFormat: shipment.Label?.LabelFormat ?? null,
    rate: {
      currencyCode: shipment.ShippingService?.Rate?.CurrencyCode ?? 'EUR',
      amount: Number(shipment.ShippingService?.Rate?.Amount ?? 0),
    },
    status: shipment.Status ?? 'Purchased',
    dryRun: false,
  }
}

/**
 * Cancel a previously-purchased Buy Shipping shipment. Only works
 * before carrier pickup; afterwards Amazon rejects with a clear error.
 */
export async function cancelBuyShippingShipment(amazonShipmentId: string):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isReal()) return { ok: true }
  try {
    const sp = await getSpClient()
    await sp.callAPI({
      operation: 'cancelShipment',
      endpoint: 'merchantFulfillment',
      path: { shipmentId: amazonShipmentId },
    })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
}

// ── Internals ──────────────────────────────────────────────────────────
async function getSpClient(): Promise<any> {
  const { SellingPartner } = await import('amazon-sp-api')
  return new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as any,
    refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  } as any)
}

function toAmazonShape(d: ShipmentRequestDetails): any {
  const out: any = {
    AmazonOrderId: d.amazonOrderId,
    ItemList: d.itemList.map((it) => ({
      OrderItemId: it.orderItemId,
      Quantity: it.quantity,
    })),
    ShipFromAddress: {
      Name: d.shipFromAddress.name,
      AddressLine1: d.shipFromAddress.addressLine1,
      AddressLine2: d.shipFromAddress.addressLine2,
      City: d.shipFromAddress.city,
      StateOrProvinceCode: d.shipFromAddress.stateOrProvinceCode,
      PostalCode: d.shipFromAddress.postalCode,
      CountryCode: d.shipFromAddress.countryCode,
      Email: d.shipFromAddress.email,
      Phone: d.shipFromAddress.phone,
    },
    PackageDimensions: d.lengthCm && d.widthCm && d.heightCm ? {
      Length: d.lengthCm,
      Width: d.widthCm,
      Height: d.heightCm,
      Unit: 'centimeters',
    } : undefined,
    Weight: { Value: d.weightGrams, Unit: 'grams' },
    ShippingServiceOptions: d.shippingServiceOptions ? {
      DeliveryExperience: d.shippingServiceOptions.deliveryExperience ?? 'DeliveryConfirmationWithoutSignature',
      CarrierWillPickUp: d.shippingServiceOptions.carrierWillPickUp ?? false,
      DeclaredValue: d.shippingServiceOptions.declaredValue ? {
        CurrencyCode: d.shippingServiceOptions.declaredValue.currencyCode,
        Amount: d.shippingServiceOptions.declaredValue.amount,
      } : undefined,
    } : {
      DeliveryExperience: 'DeliveryConfirmationWithoutSignature',
      CarrierWillPickUp: false,
    },
  }
  return out
}

function fromAmazonService(s: any): EligibleShippingService {
  return {
    shippingServiceName: s.ShippingServiceName,
    carrierName: s.CarrierName,
    shippingServiceId: s.ShippingServiceId,
    shippingServiceOfferId: s.ShippingServiceOfferId,
    rate: {
      currencyCode: s.Rate?.CurrencyCode ?? 'EUR',
      amount: Number(s.Rate?.Amount ?? 0),
    },
    estimatedDeliveryDate: s.EarliestEstimatedDeliveryDate,
    earliestEstimatedDeliveryDate: s.EarliestEstimatedDeliveryDate,
    latestEstimatedDeliveryDate: s.LatestEstimatedDeliveryDate,
    shippingServiceOptions: s.ShippingServiceOptions ? {
      deliveryExperience: s.ShippingServiceOptions.DeliveryExperience,
      carrierWillPickUp: s.ShippingServiceOptions.CarrierWillPickUp,
    } : undefined,
  }
}

export const __test = { isReal, toAmazonShape, fromAmazonService }
