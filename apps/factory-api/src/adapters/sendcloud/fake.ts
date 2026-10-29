import { createHash } from 'node:crypto'
import type {
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
import { SENDCLOUD_SIGNATURE_HEADER, SENDCLOUD_STATUS_ACTION } from '@nexus/factory-domain/ports/carrier'
import type { TrackingStatus } from '@nexus/factory-domain/shipping/labels/tracking'
import { parseDecimal } from '@nexus/factory-domain/tax/decimal'
import { ProviderError } from '../../platform/gateway/gateway'
import { fakeSignatureHeaders } from '../../platform/inbound/verifiers'
import { sendcloudSignature, statusChangeKey } from './webhook'

/**
 * The FAKE Sendcloud (plan A1 §4 "Fake behaviour"; B-W1-48; local and test only: modules/shipping/labels/carrier.ts makes
 * none in staging or production, where the gateway refuses FAKE accounts anyway). Nothing leaves the process.
 *
 *   labels     deterministic: the same external reference gives the same label (tracking number FK + 12 hex of its
 *              hash), as Sendcloud answers a reused reference with the shipment it made; files are a small PDF and ZPL
 *              with the tracking number
 *   refusals   a parcel over FAKE_MAX_WEIGHT_KG is refused (400, as a carrier's weight limit); `failNext` scripts the
 *              next calls' failures (a 503 is retried by the gateway, a 4xx is final); a void after the carrier
 *              collected it, or `refuseVoidNext`, is refused (409)
 *   tracking   `advance(trackingNumber, status)` adds the carrier's next event and returns the webhook Sendcloud would
 *              send for it (signed with Sendcloud's header AND the factory's fake header, which a FAKE account's inbound
 *              route checks); an event whose webhook is never posted is a lost update the poll finds (`tracking`)
 *   scripts    `play(trackingNumber, 'delivered' | 'returned' | 'exception')` runs a whole sequence
 */

export const FAKE_MAX_WEIGHT_KG = 30

/** The Sendcloud status (webhook id and message) and the v3 tracking code of each factory status, as the fake reports it. */
export const FAKE_STATUSES: Readonly<Record<TrackingStatus, { readonly id: number; readonly message: string; readonly code: string }>> = Object.freeze({
  LABEL_CREATED: { id: 1000, message: 'Ready to send', code: 'ready_to_send' },
  IN_TRANSIT: { id: 3, message: 'En route to sorting center', code: 'in_transit' },
  OUT_FOR_DELIVERY: { id: 92, message: 'Driver en route', code: 'in_delivery' },
  DELIVERED: { id: 11, message: 'Delivered', code: 'delivered' },
  EXCEPTION: { id: 8, message: 'Delivery attempt failed', code: 'exception:address_error' },
  RETURNED: { id: 62993, message: 'Returned to sender', code: 'exception:returned_sender' },
})

export const FAKE_SCRIPTS = Object.freeze({
  delivered: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'],
  returned: ['IN_TRANSIT', 'EXCEPTION', 'RETURNED'],
  exception: ['IN_TRANSIT', 'EXCEPTION'],
} as const satisfies Record<string, readonly TrackingStatus[]>)

interface FakeLabel {
  readonly label: CarrierLabel
  readonly request: CarrierLabelRequest
  readonly parcelId: string
  voided: VoidOutcome | null
  readonly events: CarrierTrackingEvent[]
}

/** One webhook delivery as Sendcloud would post it. */
export interface FakeWebhook {
  readonly body: string
  readonly headers: Record<string, string>
  readonly key: string
}

const hex = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A tiny one-page PDF that says the label's tracking number (valid enough for any viewer; same input, same bytes). */
function labelPdf(trackingNumber: string, request: CarrierLabelRequest): Uint8Array {
  const text = `FAKE LABEL ${trackingNumber} ${request.shipmentNumber}/${request.seq}`.replace(/[()\\]/g, '')
  const stream = `BT /F1 14 Tf 20 120 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 298 420] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

const labelZpl = (trackingNumber: string, request: CarrierLabelRequest): Uint8Array =>
  new TextEncoder().encode(`^XA^CI28^FO40,40^A0N,40,40^FDFAKE ${request.shipmentNumber}/${request.seq}^FS^FO40,100^BCN,120,Y,N,N^FD${trackingNumber}^FS^XZ\n`)

export class FakeSendcloud implements CarrierPort {
  /** The labels asked for, in order (a repeat of a reference is listed again). */
  readonly requests: CarrierLabelRequest[] = []
  readonly voids: string[] = []
  private readonly labels = new Map<string, FakeLabel>()
  private readonly byReference = new Map<string, string>()
  private readonly failures: { readonly httpStatus: number; readonly message: string }[] = []
  private refuseVoids = 0
  private sequence = 0

  constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  /** The next `count` calls (any operation) fail with this HTTP status (503: the gateway retries it; 4xx: final). */
  failNext(count: number, httpStatus = 503, message = 'Sendcloud is not available (fake).'): void {
    for (let index = 0; index < count; index++) this.failures.push({ httpStatus, message })
  }

  /** The next `count` voids are refused (the carrier collected the parcel). */
  refuseVoidNext(count = 1): void {
    this.refuseVoids += count
  }

  private guard(call: CarrierCall): void {
    if (call.account.provider !== 'SENDCLOUD' || call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE Sendcloud account uses the fake Sendcloud.', { retryable: false })
    const failure = this.failures.shift()
    if (failure) {
      call.answer({ httpStatus: failure.httpStatus, response: { fake: true, error: failure.message } })
      throw new ProviderError(failure.message, { httpStatus: failure.httpStatus })
    }
  }

  private find(key: string): FakeLabel {
    const found = this.labels.get(key) ?? [...this.labels.values()].find((entry) => entry.label.trackingNumber === key)
    if (!found) throw new ProviderError('No such label (fake).', { httpStatus: 404, retryable: false })
    return found
  }

  /** The label bought for a tracking number or provider id (tests). */
  labelOf(key: string): { readonly label: CarrierLabel; readonly voided: VoidOutcome | null; readonly request: CarrierLabelRequest } {
    const found = this.find(key)
    return { label: found.label, voided: found.voided, request: found.request }
  }

  async createLabel(call: CarrierCall, request: CarrierLabelRequest): Promise<CarrierLabel> {
    this.guard(call)
    this.requests.push(Object.freeze({ ...request }))
    const known = this.byReference.get(request.externalReference)
    if (known) {
      call.answer({ httpStatus: 409, response: { fake: true, providerId: known, replayed: true } })
      return this.labels.get(known)!.label
    }
    if (parseDecimal(request.weightKg)?.greaterThan(FAKE_MAX_WEIGHT_KG) ?? false) {
      call.answer({ httpStatus: 400, response: { fake: true, error: 'weight' } })
      throw new ProviderError(`Sendcloud answered 400: the parcel weighs more than this service takes (${FAKE_MAX_WEIGHT_KG} kg, fake).`, { httpStatus: 400 })
    }
    const digest = hex(request.externalReference)
    const parcelId = String(++this.sequence)
    const providerId = `fk-${digest.slice(0, 8)}:${parcelId}`
    const trackingNumber = `FK${digest.slice(0, 12).toUpperCase()}`
    const label: CarrierLabel = Object.freeze({
      providerId,
      trackingNumber,
      trackingUrl: `https://tracking.invalid/${trackingNumber}`,
      carrierCode: request.carrierCode ?? 'fake',
      carrierName: 'Fake Carrier',
    })
    const created = { externalEventId: `fake:${trackingNumber}:0`, occurredAt: this.clock.now().toISOString(), code: FAKE_STATUSES.LABEL_CREATED.code, description: FAKE_STATUSES.LABEL_CREATED.message, location: null }
    this.labels.set(providerId, { label, request, parcelId, voided: null, events: [created] })
    this.byReference.set(request.externalReference, providerId)
    call.answer({ httpStatus: 201, response: { fake: true, providerId } })
    return label
  }

  async labelDocument(call: CarrierCall, providerId: string, format: LabelFormat): Promise<LabelDocument> {
    this.guard(call)
    const found = this.find(providerId)
    const body = format === 'PDF' ? labelPdf(found.label.trackingNumber, found.request) : labelZpl(found.label.trackingNumber, found.request)
    call.answer({ httpStatus: 200, response: { fake: true, format, bytes: body.byteLength } })
    return { format, body }
  }

  async voidLabel(call: CarrierCall, providerId: string): Promise<VoidOutcome> {
    this.guard(call)
    const found = this.find(providerId)
    const collected = found.events.some((event) => event.code !== FAKE_STATUSES.LABEL_CREATED.code)
    if (this.refuseVoids > 0 || collected) {
      if (this.refuseVoids > 0) this.refuseVoids--
      call.answer({ httpStatus: 409, response: { fake: true } })
      throw new ProviderError('Sendcloud refused to cancel the label: the carrier has the parcel already (fake).', { httpStatus: 409, retryable: false })
    }
    found.voided = 'CANCELLED'
    this.voids.push(providerId)
    call.answer({ httpStatus: 200, response: { fake: true } })
    return 'CANCELLED'
  }

  async tracking(call: CarrierCall, label: TrackedLabel): Promise<readonly CarrierTrackingEvent[]> {
    this.guard(call)
    const found = this.find(label.providerId)
    call.answer({ httpStatus: 200, response: { fake: true, events: found.events.length } })
    return found.events.map((event) => ({ ...event }))
  }

  /**
   * The carrier's next event for a label (by tracking number or provider id), at `at` (default the fake's clock), and
   * the webhook Sendcloud would post for it, signed with `secret` (the account's webhook secret). Not posting it makes a
   * lost update.
   */
  advance(key: string, status: TrackingStatus, secret: string, at: Date = this.clock.now()): FakeWebhook {
    const found = this.find(key)
    const sendcloud = FAKE_STATUSES[status]
    found.events.push({ externalEventId: `fake:${found.label.trackingNumber}:${found.events.length}`, occurredAt: at.toISOString(), code: sendcloud.code, description: sendcloud.message, location: 'FAKE HUB' })
    return this.webhook(found, status, secret, at)
  }

  /** A whole scripted sequence; the webhooks in order. */
  play(key: string, script: keyof typeof FAKE_SCRIPTS, secret: string, from: Date = this.clock.now(), stepMs = 60 * 60_000): FakeWebhook[] {
    return FAKE_SCRIPTS[script].map((status, index) => this.advance(key, status, secret, new Date(from.getTime() + index * stepMs)))
  }

  private webhook(found: FakeLabel, status: TrackingStatus, secret: string, at: Date): FakeWebhook {
    const sendcloud = FAKE_STATUSES[status]
    const body = JSON.stringify({
      action: SENDCLOUD_STATUS_ACTION,
      timestamp: at.getTime(),
      carrier_status_change_timestamp: at.getTime(),
      parcel: {
        id: Number.parseInt(found.parcelId, 10),
        tracking_number: found.label.trackingNumber,
        status: { id: sendcloud.id, message: sendcloud.message },
        carrier: { code: found.label.carrierCode, name: found.label.carrierName },
        order_number: found.request.shipmentNumber,
      },
    })
    const key = statusChangeKey({ parcelId: found.parcelId, statusId: sendcloud.id, timestampMs: at.getTime() })
    return {
      body,
      key,
      headers: {
        'content-type': 'application/json',
        [SENDCLOUD_SIGNATURE_HEADER]: sendcloudSignature(secret, body),
        // Signed when it is sent (now), whatever time the carrier's event has: the fake header has a 5-minute window.
        ...fakeSignatureHeaders(secret, body, this.clock.now(), { id: key, type: SENDCLOUD_STATUS_ACTION }),
      },
    }
  }
}
