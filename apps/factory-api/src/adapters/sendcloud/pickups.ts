import { createHash } from 'node:crypto'
import type { CarrierAddress, CarrierCall } from '@nexus/factory-domain/ports/carrier'
import type { PickupBooked, PickupBookingRequest, PickupCancelOutcome, PickupPort } from '@nexus/factory-domain/shipping/pickups/port'
import { ProviderError } from '../../platform/gateway/gateway'
import { SENDCLOUD_API } from './sendcloud'

/**
 * Carrier pickups through Sendcloud (B-W2b-395; LOG-048; Owner Q20: the factory company's OWN Sendcloud account; FAKE until it
 * exists, and a service the plan does not include stays on the FAKE until the Owner chooses). Every method runs inside its
 * gateway call (modules/shipping/pickups/runtime.ts): the call's abort signal, its credentials, one ledger row. No SDK: fetch.
 *
 *   live (LIVE, SANDBOX)   Sendcloud's public API v3 "Pickups": POST /pickups { carrier_code, address, time_slots [{ start_at,
 *                          end_at }], items [{ quantity, container_type parcel | pallet, total_weight? }], reference }; the
 *                          answer's data.id is the reference kept. Sendcloud answers in words when the carrier offers no pickup
 *                          (a 4xx: final, the request FAILED with its words). Its call-off is NOT wired yet (the answer of a
 *                          live account is to be checked first, Q20): `cancel` sends nothing and says so, the office tells the
 *                          carrier. Check the body against the live account before the first live booking.
 *   FAKE (local, test)     nothing leaves the process: a pickup is booked with reference FPU-<10 hex>, refused (422, as a
 *                          carrier says) when the goods are ready on a Saturday or a Sunday (UTC day) or more than 14 days ahead;
 *                          `failNext` scripts the next calls' failures; a call-off cancels (twice: cancelled once).
 */

export interface SendcloudPickupsOptions {
  /** The HTTP client (tests pass a scripted one; nothing else ever reaches the network). Default: global fetch. */
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
}

interface Credentials {
  readonly publicKey?: unknown
  readonly secretKey?: unknown
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const idOf = (value: unknown): string | null => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : textOf(value))

/** Sendcloud's error answer, in one line. */
function errorText(body: unknown): string {
  const errors = record(body).errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((entry) => {
        const error = record(entry)
        return textOf(error.detail) ?? textOf(error.message) ?? textOf(error.code) ?? 'error'
      })
      .join('; ')
      .slice(0, 500)
  }
  return textOf(record(body).detail) ?? textOf(record(body).message) ?? 'Sendcloud refused the pickup.'
}

function address(value: CarrierAddress) {
  return {
    name: value.name,
    ...(value.companyName ? { company_name: value.companyName } : {}),
    address_line_1: value.line1,
    ...(value.line2 ? { address_line_2: value.line2 } : {}),
    postal_code: value.postalCode,
    city: value.city,
    country_code: value.country,
    ...(value.province ? { state_province_code: value.province } : {}),
    ...(value.phone ? { phone_number: value.phone } : {}),
    ...(value.email ? { email: value.email } : {}),
  }
}

/** The v3 pickup request. */
export function pickupBody(request: PickupBookingRequest) {
  const weight = request.weightKg ? { total_weight: { value: request.weightKg, unit: 'kg' } } : {}
  const items = [
    ...(request.parcels > 0 ? [{ quantity: request.parcels, container_type: 'parcel', ...(request.pallets === 0 ? weight : {}) }] : []),
    ...(request.pallets > 0 ? [{ quantity: request.pallets, container_type: 'pallet', ...(request.parcels === 0 ? weight : {}) }] : []),
  ]
  return {
    carrier_code: request.carrierCode,
    address: address(request.address),
    time_slots: [{ start_at: request.readyFrom, end_at: request.readyUntil }],
    items,
    reference: request.reference,
  }
}

export function sendcloudPickupsAdapter(options: SendcloudPickupsOptions = {}): PickupPort {
  const base = (options.baseUrl ?? SENDCLOUD_API).replace(/\/+$/, '')
  const send = options.fetch ?? fetch

  return Object.freeze({
    async book(call: CarrierCall, request: PickupBookingRequest): Promise<PickupBooked> {
      if (call.account.provider !== 'SENDCLOUD' || call.account.mode === 'FAKE') throw new ProviderError('Only a LIVE or SANDBOX Sendcloud account calls Sendcloud.', { retryable: false })
      const credentials = await call.credentials<Credentials>()
      const publicKey = textOf(credentials?.publicKey)
      const secretKey = textOf(credentials?.secretKey)
      if (!publicKey || !secretKey) throw new ProviderError('The Sendcloud connection has no API keys: an administrator adds them under Connections.', { retryable: false })
      const partnerId = textOf(record(call.account.settings).partnerId)
      let response: Response
      try {
        response = await send(`${base}/pickups`, {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
            accept: 'application/json',
            'content-type': 'application/json',
            ...(partnerId ? { 'sendcloud-partner-id': partnerId } : {}),
          },
          body: JSON.stringify(pickupBody(request)),
          signal: call.signal,
        })
      } catch (error) {
        if (call.signal.aborted) throw error
        throw new ProviderError(`Sendcloud could not be reached (${(error as Error).name}).`)
      }
      let body: unknown = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (response.status !== 200 && response.status !== 201) {
        call.answer({ httpStatus: response.status, response: { error: errorText(body) } })
        throw new ProviderError(`Sendcloud answered ${response.status}: ${errorText(body)}`, { httpStatus: response.status, response: body })
      }
      const id = idOf(record(record(body).data).id) ?? idOf(record(body).id)
      if (!id) {
        call.answer({ httpStatus: response.status, response: { error: 'no pickup id' } })
        throw new ProviderError('Sendcloud answered without the pickup it booked.', { retryable: false })
      }
      call.answer({ httpStatus: response.status, response: { pickupId: id } })
      return { providerReference: id }
    },

    async cancel(call: CarrierCall): Promise<PickupCancelOutcome> {
      call.answer({ response: { mapped: false } })
      return 'NOT_MAPPED'
    },
  } satisfies PickupPort)
}

// ---- the FAKE ------------------------------------------------------------------------------------------------------------

/** The fake carriers book at most this many days ahead. */
export const FAKE_PICKUP_AHEAD_DAYS = 14

interface FakePickup {
  readonly request: PickupBookingRequest
  cancelled: boolean
}

export class FakeSendcloudPickups implements PickupPort {
  private readonly pickups = new Map<string, FakePickup>()
  private readonly failures: { readonly httpStatus: number; readonly message: string }[] = []
  private sequence = 0

  constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  /** The next `count` calls fail with this answer (a 4xx is final; the booking is never retried). */
  failNext(count: number, httpStatus = 503, message = 'Sendcloud is not available (fake).'): void {
    for (let index = 0; index < count; index++) this.failures.push({ httpStatus, message })
  }

  private guard(call: CarrierCall): void {
    if (call.account.provider !== 'SENDCLOUD' || call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE Sendcloud account uses the fake Sendcloud.', { retryable: false })
    const failure = this.failures.shift()
    if (failure) {
      call.answer({ httpStatus: failure.httpStatus, response: { fake: true, error: failure.message } })
      throw new ProviderError(failure.message, { httpStatus: failure.httpStatus })
    }
  }

  async book(call: CarrierCall, request: PickupBookingRequest): Promise<PickupBooked> {
    this.guard(call)
    const from = new Date(request.readyFrom)
    const refuse = (message: string): never => {
      call.answer({ httpStatus: 422, response: { fake: true, error: message } })
      throw new ProviderError(`Sendcloud answered 422: ${message}`, { httpStatus: 422, retryable: false })
    }
    if (from.getUTCDay() === 0 || from.getUTCDay() === 6) refuse(`The carrier ${request.carrierCode} does not collect at weekends (fake).`)
    if (from.getTime() > this.clock.now().getTime() + FAKE_PICKUP_AHEAD_DAYS * 86_400_000) refuse(`The carrier books pickups at most ${FAKE_PICKUP_AHEAD_DAYS} days ahead (fake).`)
    this.sequence++
    const providerReference = `FPU-${createHash('sha256').update(`${request.reference}:${this.sequence}`).digest('hex').slice(0, 10).toUpperCase()}`
    this.pickups.set(providerReference, { request, cancelled: false })
    call.answer({ httpStatus: 201, response: { fake: true, pickupId: providerReference } })
    return { providerReference }
  }

  async cancel(call: CarrierCall, providerReference: string): Promise<PickupCancelOutcome> {
    this.guard(call)
    const found = this.pickups.get(providerReference)
    if (!found) {
      call.answer({ httpStatus: 404, response: { fake: true, error: 'no such pickup' } })
      throw new ProviderError('No such pickup (fake).', { httpStatus: 404, retryable: false })
    }
    found.cancelled = true
    call.answer({ httpStatus: 200, response: { fake: true, pickupId: providerReference } })
    return 'CANCELLED'
  }

  /** A pickup booked (tests). */
  pickupOf(providerReference: string): { readonly request: PickupBookingRequest; readonly cancelled: boolean } | null {
    const found = this.pickups.get(providerReference)
    return found ? { request: found.request, cancelled: found.cancelled } : null
  }

  /** How many pickups were booked (tests). */
  get booked(): number {
    return this.pickups.size
  }
}
