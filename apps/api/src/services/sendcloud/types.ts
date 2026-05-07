/**
 * O.6 — Sendcloud REST API types. Subset of the v2/v3 shapes we
 * actually consume; full schema lives at https://api.sendcloud.dev.
 *
 * Wire format follows Sendcloud's snake_case convention; we leave it
 * as-is rather than camelCasing internally so the dryRun mocks stay
 * structurally identical to live responses (one less layer to drift).
 */

// ── Address (input + output share the same shape on the wire) ──────────
export interface SendcloudAddress {
  name: string
  company_name?: string
  address: string
  address_2?: string
  city: string
  postal_code: string
  country: string // ISO-2 (IT, DE, FR, ...)
  country_state?: string
  telephone?: string
  email?: string
  // EORI / IOSS / VAT stored at the parcel level when applicable, not here.
}

// ── Parcel item line (commercial-invoice + customs declaration) ────────
export interface SendcloudParcelItem {
  description: string
  quantity: number
  weight: string // grams, as string per Sendcloud convention
  value: string // unit price, as string
  hs_code?: string
  origin_country?: string // ISO-2
  sku?: string
  product_id?: string
}

// ── Parcel — the central object Sendcloud uses for label generation ───
export interface SendcloudParcelInput {
  // Recipient address.
  name: string
  company_name?: string
  address: string
  address_2?: string
  city: string
  postal_code: string
  country: string
  country_state?: string
  telephone?: string
  email?: string

  // Parcel measurements.
  weight: string // kg, e.g. "1.500"
  length?: string // cm
  width?: string
  height?: string

  // Order context.
  order_number: string
  total_order_value: string
  total_order_value_currency?: string

  // Carrier choice — Sendcloud routes via shipping_method id (per-account).
  // When omitted, Sendcloud picks based on dimensions + destination.
  shipment?: { id: number } // shipping_method_id

  // Sender — optional override. Default sender lives on integration setup.
  sender_address?: number

  // Customs (international).
  parcel_items?: SendcloudParcelItem[]
  customs_invoice_nr?: string
  customs_shipment_type?: number // 0=Gift, 1=Documents, 2=CommercialGoods, 3=CommercialSample, 4=ReturnedGoods

  // Idempotency: if Sendcloud has seen this external_reference before for
  // the same integration, it returns the existing parcel rather than
  // creating a duplicate. We pass the Shipment.id here.
  external_reference?: string

  // Whether to actually request a label. False = "create parcel record
  // but don't generate label yet" (rare; we always set true).
  request_label?: boolean
}

export interface SendcloudParcelOutput {
  id: number
  tracking_number: string | null
  tracking_url: string | null
  label: {
    normal_printer: string[] // PDF URLs
    label_printer: string | null
  } | null
  status: { id: number; message: string }
  carrier: { code: string }
  shipment: { id: number; name: string }
  weight: string
  // The full set of input fields is echoed back; we don't model them all
  // here since callers only need what's listed above.
}

// ── Service map: shipping_method id per (channel, marketplace) ────────
// Stored on Carrier.defaultServiceMap as JSON. When a shipment lacks an
// explicit service, we look up by `${channel}_${marketplace}` here.
export type ServiceMap = Record<string, number>

// ── Credentials shape — JSON in Carrier.credentialsEncrypted ──────────
export interface SendcloudCredentials {
  publicKey: string
  privateKey: string
  integrationId?: number
}

// ── Client errors ──────────────────────────────────────────────────────
export class SendcloudError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly response?: unknown,
  ) {
    super(message)
    this.name = 'SendcloudError'
  }
}
