import type {
  CarrierAddress,
  CarrierCall,
  CarrierLabel,
  CarrierLabelRequest,
  CarrierPort,
  CarrierTrackingEvent,
  LabelDocument,
  LabelFormat,
  TrackedLabel,
  VoidOutcome,
} from '@nexus/factory-domain/ports/carrier'
import { ProviderError } from '../../platform/gateway/gateway'

/**
 * Sendcloud's public API v3 for LIVE and SANDBOX accounts (B-W1-48; Owner Q20: the factory company's OWN Sendcloud
 * account, never another business's). Sendcloud has no separate sandbox host: a SANDBOX account is a test integration
 * of the same API (its "unstamped letter" service buys nothing). Every method runs inside its gateway call
 * (modules/shipping/labels/carrier.ts): the call's abort signal, its credentials, one ledger row. No SDK: fetch.
 *
 *   createLabel     POST /shipments/announce        one parcel, label requested; `external_reference_id` = the buy's
 *                                                   reference: Sendcloud answers 409 with the shipment it already made
 *   labelDocument   GET  /parcels/{id}/documents/label   Accept application/pdf or application/zpl
 *   voidLabel       POST /shipments/{id}/cancel     200 cancelled, 202 queued (cancelled later), 409 refused
 *   tracking        GET  /parcels/tracking/{tracking number}   the carrier's events (phase, exception, time)
 *
 * The account's credentials (sealed JSON): { "publicKey": "…", "secretKey": "…" } (HTTP Basic). Its settings (not
 * secret): { "contractId"?: number, "partnerId"?: string }. The provider id of a label is
 * "<Sendcloud shipment id>:<Sendcloud parcel id>".
 */

export const SENDCLOUD_API = 'https://panel.sendcloud.sc/api/v3'

export interface SendcloudOptions {
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

/** The provider id of a label, and its two parts. */
export const providerIdOf = (shipmentId: string, parcelId: string): string => `${shipmentId}:${parcelId}`
export function partsOf(providerId: string): { shipmentId: string; parcelId: string } {
  const [shipmentId, parcelId, ...rest] = providerId.split(':')
  if (!shipmentId || !parcelId || rest.length > 0) throw new ProviderError('This label was not bought through Sendcloud v3 (its provider id is not "<shipment>:<parcel>").', { retryable: false })
  return { shipmentId, parcelId }
}

/** Sendcloud's error answer, in one line. */
function errorText(body: unknown): string {
  const errors = record(body).errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((entry) => {
        const error = record(entry)
        const where = record(error.source).pointer
        return [textOf(error.detail) ?? textOf(error.code) ?? 'error', typeof where === 'string' ? `(${where})` : ''].join(' ').trim()
      })
      .join('; ')
      .slice(0, 500)
  }
  return textOf(record(body).detail) ?? textOf(record(body).message) ?? 'Sendcloud refused the request.'
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

/** The announce request (the label as a PDF; other formats are fetched as documents). */
export function announceBody(request: CarrierLabelRequest, settings: unknown) {
  const contractId = record(settings).contractId
  const dimensions = request.lengthCm && request.widthCm && request.heightCm ? { dimensions: { length: request.lengthCm, width: request.widthCm, height: request.heightCm, unit: 'cm' } } : {}
  return {
    from_address: address(request.from),
    to_address: address(request.to),
    ship_with: { type: 'shipping_option_code', properties: { shipping_option_code: request.serviceCode, ...(typeof contractId === 'number' ? { contract_id: contractId } : {}) } },
    order_number: request.shipmentNumber,
    external_reference_id: request.externalReference,
    reference: `${request.shipmentNumber}/${request.seq}`,
    parcels: [{ weight: { value: request.weightKg, unit: 'kg' }, ...dimensions }],
    label_details: { mime_type: 'application/pdf', dpi: 72 },
  }
}

/** The label of an announce answer (201, or 409 with the shipment the reference already made). */
export function labelOf(body: unknown, request: Pick<CarrierLabelRequest, 'carrierCode'>): CarrierLabel {
  const data = record(record(body).data)
  const parcels = Array.isArray(data.parcels) ? data.parcels.map(record) : []
  const parcel = parcels[0]
  const shipmentId = idOf(data.id)
  const parcelId = parcel ? idOf(parcel.id) : null
  if (!shipmentId || !parcel || !parcelId) throw new ProviderError('Sendcloud answered without the shipment and its parcel.', { retryable: false })
  const numbers = Array.isArray(parcel.tracking_numbers) ? parcel.tracking_numbers.map(record) : []
  const trackingNumber = textOf(parcel.tracking_number) ?? textOf(numbers[0]?.tracking_number)
  // The label is bought but the carrier has not given its number yet: the same reference asks again (idempotent).
  if (!trackingNumber) throw new ProviderError('Sendcloud announced the parcel but has no tracking number yet.', { retryable: true })
  const carrier = record(data.carrier)
  return {
    providerId: providerIdOf(shipmentId, parcelId),
    trackingNumber,
    trackingUrl: textOf(parcel.tracking_url) ?? textOf(numbers[0]?.tracking_url),
    carrierCode: textOf(numbers[0]?.carrier_code) ?? textOf(carrier.code) ?? request.carrierCode,
    carrierName: textOf(carrier.name),
  }
}

/** The tracking events of a v3 tracking answer; the code is the phase, or `exception:<name>` when the phase is none. */
export function eventsOf(body: unknown, trackingNumber: string): CarrierTrackingEvent[] {
  const events = record(body).events
  if (!Array.isArray(events)) return []
  return events.flatMap((entry) => {
    const event = record(entry)
    const at = textOf(event.event_at)
    if (!at || Number.isNaN(Date.parse(at))) return []
    const phase = textOf(event.phase) ?? 'unknown'
    const code = phase === 'none' ? `exception:${textOf(event.exception) ?? 'unknown'}` : phase
    return [{ externalEventId: `sc3:${trackingNumber}:${new Date(at).toISOString()}:${code}`.slice(0, 255), occurredAt: new Date(at).toISOString(), code, description: textOf(event.description)?.slice(0, 500) ?? null, location: null }]
  })
}

export function sendcloudAdapter(options: SendcloudOptions = {}): CarrierPort {
  const base = (options.baseUrl ?? SENDCLOUD_API).replace(/\/+$/, '')
  const send = options.fetch ?? fetch

  async function request(call: CarrierCall, method: 'GET' | 'POST', path: string, init: { body?: unknown; accept?: string } = {}): Promise<Response> {
    if (call.account.provider !== 'SENDCLOUD' || call.account.mode === 'FAKE') throw new ProviderError('Only a LIVE or SANDBOX Sendcloud account calls Sendcloud.', { retryable: false })
    const credentials = await call.credentials<Credentials>()
    const publicKey = textOf(credentials?.publicKey)
    const secretKey = textOf(credentials?.secretKey)
    if (!publicKey || !secretKey) throw new ProviderError('The Sendcloud connection has no API keys: an administrator adds them under Connections.', { retryable: false })
    const partnerId = textOf(record(call.account.settings).partnerId)
    try {
      return await send(`${base}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
          accept: init.accept ?? 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(partnerId ? { 'sendcloud-partner-id': partnerId } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: call.signal,
      })
    } catch (error) {
      if (call.signal.aborted) throw error
      throw new ProviderError(`Sendcloud could not be reached (${(error as Error).name}).`)
    }
  }

  async function json(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  async function refusal(call: CarrierCall, response: Response, summary: Record<string, unknown> = {}): Promise<never> {
    const body = await json(response)
    call.answer({ httpStatus: response.status, response: { ...summary, error: errorText(body) } })
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
    throw new ProviderError(`Sendcloud answered ${response.status}: ${errorText(body)}`, {
      httpStatus: response.status,
      response: body,
      ...(Number.isSafeInteger(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    })
  }

  return Object.freeze({
    async createLabel(call: CarrierCall, labelRequest: CarrierLabelRequest): Promise<CarrierLabel> {
      const response = await request(call, 'POST', '/shipments/announce', { body: announceBody(labelRequest, call.account.settings) })
      if (response.status !== 200 && response.status !== 201 && response.status !== 409) return refusal(call, response)
      const body = await json(response)
      if (response.status === 409 && !record(body).data) {
        call.answer({ httpStatus: 409, response: { error: errorText(body) } })
        throw new ProviderError(`Sendcloud answered 409: ${errorText(body)}`, { httpStatus: 409, retryable: false })
      }
      const label = labelOf(body, labelRequest)
      call.answer({ httpStatus: response.status, response: { providerId: label.providerId, replayed: response.status === 409 } })
      return label
    },

    async labelDocument(call: CarrierCall, providerId: string, format: LabelFormat): Promise<LabelDocument> {
      const { parcelId } = partsOf(providerId)
      const accept = format === 'PDF' ? 'application/pdf' : 'application/zpl'
      const response = await request(call, 'GET', `/parcels/${encodeURIComponent(parcelId)}/documents/label`, { accept })
      if (response.status !== 200) return refusal(call, response, { parcelId })
      const type = (response.headers.get('content-type') ?? accept).split(';')[0]!.trim().toLowerCase()
      const body = new Uint8Array(await response.arrayBuffer())
      // A carrier whose labels are ZPL answers ZPL even to a PDF request.
      const came: LabelFormat = type === 'application/pdf' ? 'PDF' : 'ZPL'
      call.answer({ httpStatus: 200, response: { parcelId, format: came, bytes: body.byteLength } })
      return { format: came, body }
    },

    async voidLabel(call: CarrierCall, providerId: string): Promise<VoidOutcome> {
      const { shipmentId } = partsOf(providerId)
      const response = await request(call, 'POST', `/shipments/${encodeURIComponent(shipmentId)}/cancel`)
      if (response.status === 200 || response.status === 202) {
        call.answer({ httpStatus: response.status, response: { shipmentId } })
        return response.status === 200 ? 'CANCELLED' : 'QUEUED'
      }
      if (response.status === 409) {
        const body = await json(response)
        const detail = errorText(body)
        call.answer({ httpStatus: 409, response: { shipmentId, error: detail } })
        // Asked twice: the first cancel is under way.
        if (/already/i.test(detail) && /cancel/i.test(detail)) return 'QUEUED'
        throw new ProviderError(`Sendcloud refused to cancel the label: ${detail}`, { httpStatus: 409, retryable: false })
      }
      return refusal(call, response, { shipmentId })
    },

    async tracking(call: CarrierCall, label: TrackedLabel): Promise<readonly CarrierTrackingEvent[]> {
      const response = await request(call, 'GET', `/parcels/tracking/${encodeURIComponent(label.trackingNumber)}`)
      if (response.status !== 200) return refusal(call, response)
      const events = eventsOf(await json(response), label.trackingNumber)
      call.answer({ httpStatus: 200, response: { events: events.length } })
      return events
    },
  } satisfies CarrierPort)
}
