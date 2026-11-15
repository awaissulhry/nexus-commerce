import type { CarrierAddress, CarrierCall } from '../../ports/carrier'
import type { OperationDescriptor } from '../../ports/provider'

/**
 * The pickup port (B-W2b-395; LOG-048): a carrier pickup booked through Sendcloud (its carriers that offer one), beside the
 * label port (ports/carrier.ts). The adapters live in apps/factory-api/src/adapters/sendcloud/pickups.ts (Sendcloud's API v3
 * for LIVE and SANDBOX accounts; the FAKE for local and test); each call runs inside ONE gateway call (rate limit, circuit
 * breaker, timeout, kill switch, one IntegrationCall row), never inside a command's transaction. Pure types: no I/O.
 */

export const PICKUP_OPERATIONS = Object.freeze({
  /** Book one pickup. NOT idempotent (Sendcloud takes no reference that answers a repeat): tried once, never retried. */
  book: { name: 'carrier.book_pickup', idempotent: false },
  /** Call a booked pickup off. Asking twice cancels once. */
  cancel: { name: 'carrier.cancel_pickup', idempotent: true },
} as const satisfies Record<string, OperationDescriptor>)

/** One pickup to book. */
export interface PickupBookingRequest {
  /** The carrier, as Sendcloud names it ("brt", "dhl"). */
  readonly carrierCode: string
  /** Where the driver collects. */
  readonly address: CarrierAddress
  /** The window the goods are ready in (ISO instants). */
  readonly readyFrom: string
  readonly readyUntil: string
  readonly parcels: number
  readonly pallets: number
  /** The total weight in kilograms (decimal string), when known. */
  readonly weightKg: string | null
  /** Our reference of the request (shown on the carrier's side). */
  readonly reference: string
}

/** A pickup booked: the provider's reference. */
export interface PickupBooked {
  readonly providerReference: string
}

/** What the provider did with a call-off: cancelled, or nothing (its call-off is not wired: the office tells the carrier). */
export type PickupCancelOutcome = 'CANCELLED' | 'NOT_MAPPED'

export interface PickupPort {
  book(call: CarrierCall, request: PickupBookingRequest): Promise<PickupBooked>
  cancel(call: CarrierCall, providerReference: string): Promise<PickupCancelOutcome>
}
