import type { AdapterAccount, OperationDescriptor } from './provider'

/**
 * The carrier port (plan A1 §4; B-W1-48; features LOG-025, LOG-032, LOG-059): carrier labels and tracking through
 * Sendcloud (Sendcloud's own carriers: BRT, GLS, Poste, DHL …). The adapters live in apps/factory-api/src/adapters/
 * sendcloud/ (Sendcloud's public API v3 for LIVE and SANDBOX accounts; the FAKE for local and test); every call they
 * make runs inside ONE gateway call (rate limit, circuit breaker, timeout, retries of idempotent operations, kill
 * switch, one IntegrationCall row), never inside a command's transaction.
 *
 * One label is one parcel: each parcel of a shipment is its own Sendcloud shipment, so a label is bought, voided and
 * tracked on its own and a buy of several parcels can partly succeed. Its `providerId` is the adapter's own id of the
 * label (opaque to the rest of the factory, kept in Parcel.carrierParcelId).
 *
 * Pure types and constants: no I/O.
 */

/** The gateway operations of the carrier adapters (the ledger's operation names). */
export const CARRIER_OPERATIONS = Object.freeze({
  /** Announce one parcel and buy its label. Idempotent: the external reference makes a repeat answer the same label. */
  createLabel: { name: 'carrier.create_label', idempotent: true },
  /** The label's file (PDF or ZPL). A read. */
  labelDocument: { name: 'carrier.label_document', idempotent: true },
  /** Cancel (void) a label at the carrier. Asking twice cancels once. */
  voidLabel: { name: 'carrier.void_label', idempotent: true },
  /** The carrier's tracking events of a parcel. A read. */
  tracking: { name: 'carrier.tracking', idempotent: true },
} as const satisfies Record<string, OperationDescriptor>)

/** What an adapter gets for one attempt of a gateway call (the API's GatewayCall has this shape). */
export interface CarrierCall {
  readonly account: AdapterAccount
  readonly attempt: number
  /** Aborted at the attempt's timeout. */
  readonly signal: AbortSignal
  readonly idempotencyKey: string | null
  /** The account's sealed credentials, opened for this call; null when it has none. */
  credentials<T = Record<string, unknown>>(): Promise<T | null>
  /** The provider's HTTP status and answer of this attempt, for the ledger (redacted there). */
  answer(details: { readonly httpStatus?: number; readonly response?: unknown }): void
}

/** An address as a carrier label prints it. */
export interface CarrierAddress {
  readonly name: string
  readonly companyName: string | null
  readonly line1: string
  readonly line2: string | null
  readonly postalCode: string
  readonly city: string
  /** ISO 3166-2 subdivision (a province), when known. */
  readonly province: string | null
  /** ISO 3166-1 alpha-2. */
  readonly country: string
  readonly phone: string | null
  readonly email: string | null
}

/** One label to buy: one parcel of a shipment. */
export interface CarrierLabelRequest {
  /** The shipment's number (printed as the order number on the label). */
  readonly shipmentNumber: string
  /** The parcel's place in the shipment (1, 2 …) and how many it has. */
  readonly seq: number
  readonly parcels: number
  /** Unique per label bought: the same reference again answers the label already bought (the buy's idempotency). */
  readonly externalReference: string
  readonly from: CarrierAddress
  readonly to: CarrierAddress
  /** The carrier (Sendcloud's code: "brt", "gls") and the service (Sendcloud's shipping option code). */
  readonly carrierCode: string | null
  readonly serviceCode: string
  /** Kilograms (decimal string, above 0); centimetres when measured. */
  readonly weightKg: string
  readonly lengthCm: string | null
  readonly widthCm: string | null
  readonly heightCm: string | null
}

/** A label bought. */
export interface CarrierLabel {
  /** The adapter's id of the label (void and track it with it). */
  readonly providerId: string
  readonly trackingNumber: string
  readonly trackingUrl: string | null
  /** The carrier that carries it, as the provider names it. */
  readonly carrierCode: string | null
  readonly carrierName: string | null
}

export const LABEL_FORMATS = ['PDF', 'ZPL'] as const
export type LabelFormat = (typeof LABEL_FORMATS)[number]

/** The content type a label file of each format is stored with (ZPL is printer text). */
export const LABEL_CONTENT_TYPES: Readonly<Record<LabelFormat, string>> = Object.freeze({ PDF: 'application/pdf', ZPL: 'text/plain' })

/**
 * A label's file. A carrier whose labels are ZPL by nature answers ZPL even when a PDF is asked (Sendcloud: "it can't be
 * converted"): `format` says what came.
 */
export interface LabelDocument {
  readonly format: LabelFormat
  readonly body: Uint8Array
}

/** What the carrier did with a void: cancelled now, or queued (it cancels later, unless the parcel moves first). */
export type VoidOutcome = 'CANCELLED' | 'QUEUED'

/** One tracking event as the carrier reports it (the factory's status is mapped from `code`). */
export interface CarrierTrackingEvent {
  /** The provider's id of the event: one row per shipment and id. */
  readonly externalEventId: string
  /** ISO 8601 instant of the carrier's event. */
  readonly occurredAt: string
  /** The provider's status code (Sendcloud v3: the phase, or the exception when the phase is `none`). */
  readonly code: string
  readonly description: string | null
  readonly location: string | null
}

/** A label of a parcel, as tracking asks for it. */
export interface TrackedLabel {
  readonly providerId: string
  readonly trackingNumber: string
}

/**
 * The carrier port. Each method runs inside its gateway call (the `call`), throws the gateway's ProviderError for a
 * provider's refusal (retryable or not) and never calls the outside twice for one attempt.
 */
export interface CarrierPort {
  createLabel(call: CarrierCall, request: CarrierLabelRequest): Promise<CarrierLabel>
  labelDocument(call: CarrierCall, providerId: string, format: LabelFormat): Promise<LabelDocument>
  voidLabel(call: CarrierCall, providerId: string): Promise<VoidOutcome>
  tracking(call: CarrierCall, label: TrackedLabel): Promise<readonly CarrierTrackingEvent[]>
}

/**
 * Sendcloud's webhooks (v3 "parcel status changed"): `Sendcloud-Signature` is the hex HMAC-SHA256 of the raw body, keyed
 * with the integration's secret key (the account's webhook secret). The body says `action`, a unix `timestamp`, and the
 * parcel: its Sendcloud id, tracking number and status { id, message }.
 */
export const SENDCLOUD_SIGNATURE_HEADER = 'sendcloud-signature'
export const SENDCLOUD_STATUS_ACTION = 'parcel_status_changed'
