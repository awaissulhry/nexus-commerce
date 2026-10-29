import { describe, expect, it } from 'vitest'
import type { CarrierCall, CarrierLabelRequest } from '@nexus/factory-domain/ports/carrier'
import type { IntegrationMode } from '@nexus/factory-domain/ports/provider'
import { ProviderError } from '../../platform/gateway/gateway'
import { fakeVerifier } from '../../platform/inbound/verifiers'
import { FAKE_MAX_WEIGHT_KG, FakeSendcloud } from './fake'
import { sendcloudAdapter, SENDCLOUD_API } from './sendcloud'
import { parseStatusChange, sendcloudSignature, sendcloudVerifier, statusChangeKey } from './webhook'

/**
 * The Sendcloud adapters (B-W1-48) without any network: the v3 adapter on a scripted fetch (requests checked, answers
 * made up), the webhook verifier, and the FAKE. Every name and number is made up.
 */

const SECRET = 'made-up-webhook-secret'
const answers: unknown[] = []
const call = (mode: IntegrationMode = 'LIVE', credentials: Record<string, unknown> | null = { publicKey: 'pub-made-up', secretKey: 'sec-made-up' }, settings: unknown = { contractId: 7 }): CarrierCall => ({
  account: { id: 'acc', tenantId: 't', companyId: 'c', provider: 'SENDCLOUD', mode, settings },
  attempt: 1,
  signal: new AbortController().signal,
  idempotencyKey: null,
  credentials: async <T,>() => credentials as T | null,
  answer: (details) => void answers.push(details),
})
const request: CarrierLabelRequest = {
  shipmentNumber: 'SH-00002',
  seq: 1,
  parcels: 2,
  externalReference: 'parcel-1.v3',
  from: { name: 'Made-up Factory', companyName: null, line1: 'Via Seed 1', line2: null, postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT', phone: null, email: null },
  to: { name: 'Made-up Workshop', companyName: null, line1: 'Via Esempio 12', line2: null, postalCode: '00000', city: 'Seedville', province: null, country: 'IT', phone: '+39 000', email: null },
  carrierCode: 'brt',
  serviceCode: 'brt:standard',
  weightKg: '1.8500',
  lengthCm: '40.00',
  widthCm: '30.00',
  heightCm: '10.00',
}

type Scripted = { status: number; body?: unknown; type?: string; bytes?: Uint8Array }
function scripted(...replies: Scripted[]) {
  const sent: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected request')
    const body = reply.bytes ?? (reply.body === undefined ? null : JSON.stringify(reply.body))
    return new Response(body, { status: reply.status, headers: { 'content-type': reply.type ?? 'application/json' } })
  }) as typeof fetch
  return { sent, adapter: sendcloudAdapter({ fetch: fetcher }) }
}
const announced = { data: { id: 'sc-ship-9', parcels: [{ id: 41, tracking_number: 'TRK000041', tracking_url: 'https://t.invalid/41', tracking_numbers: [{ carrier_code: 'brt', tracking_number: 'TRK000041' }] }] } }

describe('Sendcloud v3 (LIVE and SANDBOX)', () => {
  it('announces one parcel with its reference, the service and HTTP Basic, and reads the label', async () => {
    const { sent, adapter } = scripted({ status: 201, body: announced })
    const label = await adapter.createLabel(call(), request)
    expect(label).toEqual({ providerId: 'sc-ship-9:41', trackingNumber: 'TRK000041', trackingUrl: 'https://t.invalid/41', carrierCode: 'brt', carrierName: null })
    expect(sent[0]!.url).toBe(`${SENDCLOUD_API}/shipments/announce`)
    const headers = sent[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from('pub-made-up:sec-made-up').toString('base64')}`)
    const body = JSON.parse(String(sent[0]!.init.body))
    expect(body).toMatchObject({
      external_reference_id: 'parcel-1.v3',
      order_number: 'SH-00002',
      ship_with: { type: 'shipping_option_code', properties: { shipping_option_code: 'brt:standard', contract_id: 7 } },
      parcels: [{ weight: { value: '1.8500', unit: 'kg' }, dimensions: { length: '40.00', width: '30.00', height: '10.00', unit: 'cm' } }],
      to_address: { name: 'Made-up Workshop', address_line_1: 'Via Esempio 12', postal_code: '00000', city: 'Seedville', country_code: 'IT', phone_number: '+39 000' },
      label_details: { mime_type: 'application/pdf' },
    })
  })

  it('answers a reused reference (409 with the shipment) with the same label: a repeat is never a second label', async () => {
    const { adapter } = scripted({ status: 409, body: announced })
    expect((await adapter.createLabel(call(), request)).providerId).toBe('sc-ship-9:41')
  })

  it("refuses with Sendcloud's words (final for a 4xx), and before sending anything without API keys or with a FAKE account", async () => {
    const { adapter } = scripted({ status: 400, body: { errors: [{ code: 'invalid', detail: 'Weight exceeds the maximum', source: { pointer: '/parcels/0/weight' } }] } })
    const refused = await adapter.createLabel(call(), request).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ProviderError)
    expect(refused).toMatchObject({ httpStatus: 400, retryable: false, message: 'Sendcloud answered 400: Weight exceeds the maximum (/parcels/0/weight)' })
    const none = scripted()
    await expect(none.adapter.createLabel(call('LIVE', null), request)).rejects.toThrow('no API keys')
    await expect(none.adapter.createLabel(call('FAKE'), request)).rejects.toThrow('Only a LIVE or SANDBOX')
    expect(none.sent).toHaveLength(0)
    const busy = scripted({ status: 503, body: { detail: 'down' } })
    await expect(busy.adapter.createLabel(call(), request)).rejects.toMatchObject({ retryable: true })
  })

  it('fetches the label as PDF or ZPL, and says what came (a ZPL-only carrier answers ZPL)', async () => {
    const { sent, adapter } = scripted({ status: 200, type: 'application/pdf', bytes: new Uint8Array([37, 80]) }, { status: 200, type: 'application/zpl', bytes: new TextEncoder().encode('^XA^XZ') })
    expect(await adapter.labelDocument(call(), 'sc-ship-9:41', 'PDF')).toMatchObject({ format: 'PDF' })
    expect(await adapter.labelDocument(call(), 'sc-ship-9:41', 'PDF')).toMatchObject({ format: 'ZPL' })
    expect(sent[0]!.url).toBe(`${SENDCLOUD_API}/parcels/41/documents/label`)
    expect((sent[0]!.init.headers as Record<string, string>).accept).toBe('application/pdf')
  })

  it('voids by the shipment: cancelled, queued, asked twice, refused', async () => {
    const { sent, adapter } = scripted(
      { status: 200, body: { data: { status: 'cancelled' } } },
      { status: 202, body: { data: { status: 'queued' } } },
      { status: 409, body: { errors: [{ status: '409', code: 'invalid', detail: 'This shipment is already being cancelled.' }] } },
      { status: 409, body: { errors: [{ status: '409', code: 'invalid', detail: 'Shipment is delivered.' }] } },
    )
    expect(await adapter.voidLabel(call(), 'sc-ship-9:41')).toBe('CANCELLED')
    expect(sent[0]!.url).toBe(`${SENDCLOUD_API}/shipments/sc-ship-9/cancel`)
    expect(await adapter.voidLabel(call(), 'sc-ship-9:41')).toBe('QUEUED')
    expect(await adapter.voidLabel(call(), 'sc-ship-9:41')).toBe('QUEUED')
    await expect(adapter.voidLabel(call(), 'sc-ship-9:41')).rejects.toMatchObject({ retryable: false, message: 'Sendcloud refused to cancel the label: Shipment is delivered.' })
    await expect(adapter.voidLabel(call(), 'seed-parcel-1')).rejects.toThrow('not "<shipment>:<parcel>"')
  })

  it('reads the tracking events: the phase, or the exception when the phase is none', async () => {
    const { sent, adapter } = scripted({
      status: 200,
      body: {
        events: [
          { event_at: '2026-10-29T08:00:00Z', phase: 'in_transit', exception: 'none', description: 'On its way' },
          { event_at: '2026-10-29T12:00:00Z', phase: 'none', exception: 'returned_sender', description: 'Back' },
          { event_at: 'not a time', phase: 'delivered' },
        ],
      },
    })
    const events = await adapter.tracking(call(), { providerId: 'sc-ship-9:41', trackingNumber: 'TRK000041' })
    expect(sent[0]!.url).toBe(`${SENDCLOUD_API}/parcels/tracking/TRK000041`)
    expect(events).toEqual([
      { externalEventId: 'sc3:TRK000041:2026-10-29T08:00:00.000Z:in_transit', occurredAt: '2026-10-29T08:00:00.000Z', code: 'in_transit', description: 'On its way', location: null },
      { externalEventId: 'sc3:TRK000041:2026-10-29T12:00:00.000Z:exception:returned_sender', occurredAt: '2026-10-29T12:00:00.000Z', code: 'exception:returned_sender', description: 'Back', location: null },
    ])
  })
})

describe("Sendcloud's webhook signature (Sendcloud-Signature: hex HMAC-SHA256 of the raw body)", () => {
  const body = JSON.stringify({ action: 'parcel_status_changed', timestamp: 1_793_000_000, parcel: { id: 41, tracking_number: 'TRK000041', status: { id: 11, message: 'Delivered' } } })
  const verify = (raw: string, headers: Record<string, string>, secret: string | null = SECRET) => sendcloudVerifier.verify({ rawBody: Buffer.from(raw), headers, secret, now: new Date() })

  it('verifies the raw body and keys the delivery by parcel, status and time (seconds or milliseconds)', async () => {
    const change = parseStatusChange(body)!
    expect(change).toMatchObject({ parcelId: '41', trackingNumber: 'TRK000041', statusId: 11, timestampMs: 1_793_000_000_000 })
    expect(await verify(body, { 'sendcloud-signature': sendcloudSignature(SECRET, body) })).toEqual({ ok: true, dedupeKey: statusChangeKey(change), externalId: 'TRK000041', eventType: 'parcel_status_changed' })
    expect(parseStatusChange(body.replace('1793000000', '1793000000000'))?.timestampMs).toBe(1_793_000_000_000)
  })

  it('refuses a missing, malformed or wrong signature, another body, and an account without a secret', async () => {
    expect(await verify(body, {})).toEqual({ ok: false, reason: 'missing_signature' })
    expect(await verify(body, { 'sendcloud-signature': 'nope' })).toEqual({ ok: false, reason: 'malformed_signature' })
    expect(await verify(body.replace('11', '12'), { 'sendcloud-signature': sendcloudSignature(SECRET, body) })).toEqual({ ok: false, reason: 'signature_mismatch' })
    expect(await verify(body, { 'sendcloud-signature': sendcloudSignature('another-secret', body) })).toEqual({ ok: false, reason: 'signature_mismatch' })
    expect(await verify(body, { 'sendcloud-signature': sendcloudSignature(SECRET, body) }, null)).toEqual({ ok: false, reason: 'no_webhook_secret' })
  })

  it('keeps a signed delivery of another action once, by its hash, as nothing to process', async () => {
    const other = JSON.stringify({ action: 'integration_updated', timestamp: 1 })
    expect(await verify(other, { 'sendcloud-signature': sendcloudSignature(SECRET, other) })).toMatchObject({ ok: true, dedupeKey: expect.stringMatching(/^body:[0-9a-f]{64}$/), eventType: 'other' })
    expect(parseStatusChange(other)).toBeNull()
    expect(parseStatusChange('not json')).toBeNull()
  })
})

describe('the FAKE Sendcloud (local and test only)', () => {
  it('is deterministic by reference: the same reference gives the same label, another a new one', async () => {
    const fake = new FakeSendcloud()
    const first = await fake.createLabel(call('FAKE'), request)
    expect(first.trackingNumber).toMatch(/^FK[0-9A-F]{12}$/)
    expect(await fake.createLabel(call('FAKE'), request)).toEqual(first)
    expect((await new FakeSendcloud().createLabel(call('FAKE'), request)).trackingNumber).toBe(first.trackingNumber)
    expect((await fake.createLabel(call('FAKE'), { ...request, externalReference: 'parcel-1.v4' })).trackingNumber).not.toBe(first.trackingNumber)
    const pdf = await fake.labelDocument(call('FAKE'), first.providerId, 'PDF')
    expect(Buffer.from(pdf.body).toString('latin1')).toMatch(/^%PDF-1\.4[\s\S]*FAKE LABEL FK[0-9A-F]{12} SH-00002\/1[\s\S]*%%EOF\n$/)
    expect(Buffer.from((await fake.labelDocument(call('FAKE'), first.providerId, 'ZPL')).body).toString('utf8')).toContain(`^FD${first.trackingNumber}^FS`)
  })

  it(`refuses a parcel over ${FAKE_MAX_WEIGHT_KG} kg, scripted failures, a LIVE account, and a void once the carrier has the parcel`, async () => {
    const fake = new FakeSendcloud()
    await expect(fake.createLabel(call('FAKE'), { ...request, weightKg: '30.0001' })).rejects.toMatchObject({ httpStatus: 400, retryable: false })
    fake.failNext(1)
    await expect(fake.createLabel(call('FAKE'), request)).rejects.toMatchObject({ httpStatus: 503, retryable: true })
    await expect(fake.createLabel(call('LIVE'), request)).rejects.toThrow('Only a FAKE')
    const label = await fake.createLabel(call('FAKE'), request)
    fake.refuseVoidNext()
    await expect(fake.voidLabel(call('FAKE'), label.providerId)).rejects.toMatchObject({ httpStatus: 409 })
    fake.advance(label.trackingNumber, 'IN_TRANSIT', SECRET)
    await expect(fake.voidLabel(call('FAKE'), label.providerId)).rejects.toMatchObject({ httpStatus: 409 })
    const other = await fake.createLabel(call('FAKE'), { ...request, externalReference: 'parcel-2.v1' })
    expect(await fake.voidLabel(call('FAKE'), other.providerId)).toBe('CANCELLED')
  })

  it("scripts the carrier's events: webhooks signed like Sendcloud's (and the factory's fake header), and the same events for a poll", async () => {
    const fake = new FakeSendcloud()
    const label = await fake.createLabel(call('FAKE'), request)
    const hooks = fake.play(label.trackingNumber, 'delivered', SECRET, new Date('2026-10-29T08:00:00.000Z'))
    expect(hooks.map((hook) => JSON.parse(hook.body).parcel.status.id)).toEqual([3, 92, 11])
    for (const hook of hooks) {
      const raw = Buffer.from(hook.body)
      expect(await sendcloudVerifier.verify({ rawBody: raw, headers: hook.headers, secret: SECRET, now: new Date() })).toMatchObject({ ok: true, dedupeKey: hook.key })
      expect(await fakeVerifier.verify({ rawBody: raw, headers: hook.headers, secret: SECRET, now: new Date() })).toMatchObject({ ok: true, dedupeKey: hook.key })
    }
    const events = await fake.tracking(call('FAKE'), { providerId: label.providerId, trackingNumber: label.trackingNumber })
    expect(events.map((event) => event.code)).toEqual(['ready_to_send', 'in_transit', 'in_delivery', 'delivered'])
    expect(fake.play(label.trackingNumber, 'returned', SECRET).map((hook) => JSON.parse(hook.body).parcel.status.id)).toEqual([3, 8, 62993])
  })
})
