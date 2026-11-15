import { describe, expect, it } from 'vitest'
import type { CarrierCall } from '@nexus/factory-domain/ports/carrier'
import type { IntegrationMode } from '@nexus/factory-domain/ports/provider'
import type { PickupBookingRequest } from '@nexus/factory-domain/shipping/pickups/port'
import { ProviderError } from '../../platform/gateway/gateway'
import { FakeSendcloudPickups, pickupBody, sendcloudPickupsAdapter } from './pickups'
import { SENDCLOUD_API } from './sendcloud'

/**
 * The Sendcloud pickup adapters (B-W2b-395; LOG-048) without any network: the v3 adapter on a scripted fetch (the request
 * checked, the answers made up) and the FAKE. Every name and number is made up.
 */

const answers: unknown[] = []
const call = (mode: IntegrationMode = 'LIVE', credentials: Record<string, unknown> | null = { publicKey: 'pub-made-up', secretKey: 'sec-made-up' }): CarrierCall => ({
  account: { id: 'acc', tenantId: 't', companyId: 'c', provider: 'SENDCLOUD', mode, settings: { partnerId: 'made-up-partner' } },
  attempt: 1,
  signal: new AbortController().signal,
  idempotencyKey: null,
  credentials: async <T,>() => credentials as T | null,
  answer: (details) => void answers.push(details),
})
const request = (over: Partial<PickupBookingRequest> = {}): PickupBookingRequest => ({
  carrierCode: 'brt',
  address: { name: 'Made-up Factory', companyName: null, line1: 'Via Seed 1', line2: null, postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT', phone: '+39 000', email: null },
  readyFrom: '2026-11-16T14:00:00.000Z',
  readyUntil: '2026-11-16T18:00:00.000Z',
  parcels: 3,
  pallets: 1,
  weightKg: '42.5',
  reference: 'PU-0001',
  ...over,
})

function scripted(...replies: { status: number; body?: unknown }[]) {
  const sent: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected request')
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { sent, adapter: sendcloudPickupsAdapter({ fetch: fetcher }) }
}

describe('Sendcloud API v3 pickups', () => {
  it('asks for one pickup: the address, the window, parcels and pallets, the weight once, our reference', async () => {
    expect(pickupBody(request())).toEqual({
      carrier_code: 'brt',
      address: { name: 'Made-up Factory', address_line_1: 'Via Seed 1', postal_code: '00000', city: 'Seedtown', country_code: 'IT', state_province_code: 'MI', phone_number: '+39 000' },
      time_slots: [{ start_at: '2026-11-16T14:00:00.000Z', end_at: '2026-11-16T18:00:00.000Z' }],
      items: [
        { quantity: 3, container_type: 'parcel' },
        { quantity: 1, container_type: 'pallet' },
      ],
      reference: 'PU-0001',
    })
    expect(pickupBody(request({ pallets: 0 })).items).toEqual([{ quantity: 3, container_type: 'parcel', total_weight: { value: '42.5', unit: 'kg' } }])
  })

  it('books with the account keys and keeps the pickup id; a refusal is final, in its words', async () => {
    const { sent, adapter } = scripted({ status: 201, body: { data: { id: 98765, status: 'ANNOUNCED' } } }, { status: 422, body: { errors: [{ detail: 'Carrier brt offers no pickups in this country.' }] } })
    expect(await adapter.book(call(), request())).toEqual({ providerReference: '98765' })
    expect(sent[0]!.url).toBe(`${SENDCLOUD_API}/pickups`)
    const headers = sent[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from('pub-made-up:sec-made-up').toString('base64')}`)
    expect(headers['sendcloud-partner-id']).toBe('made-up-partner')
    const refused = await adapter.book(call(), request()).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ProviderError)
    expect(refused).toMatchObject({ httpStatus: 422, retryable: false, message: 'Sendcloud answered 422: Carrier brt offers no pickups in this country.' })
  })

  it('never calls for a FAKE account or without keys; its call-off is not wired (nothing sent)', async () => {
    const { sent, adapter } = scripted()
    await expect(adapter.book(call('FAKE'), request())).rejects.toThrow(/Only a LIVE or SANDBOX/)
    await expect(adapter.book(call('LIVE', null), request())).rejects.toThrow(/no API keys/)
    expect(await adapter.cancel(call(), '98765')).toBe('NOT_MAPPED')
    expect(sent).toEqual([])
  })
})

describe('the FAKE pickups', () => {
  const clock = { now: () => new Date('2026-11-16T09:00:00.000Z') }
  it('books on a working day, refuses a weekend or too far ahead in words, cancels once booked', async () => {
    const fake = new FakeSendcloudPickups(clock)
    const booked = await fake.book(call('FAKE'), request())
    expect(booked.providerReference).toMatch(/^FPU-[0-9A-F]{10}$/)
    expect(fake.pickupOf(booked.providerReference)).toMatchObject({ cancelled: false, request: { parcels: 3 } })
    await expect(fake.book(call('FAKE'), request({ readyFrom: '2026-11-21T09:00:00.000Z' }))).rejects.toMatchObject({ httpStatus: 422, retryable: false, message: expect.stringMatching(/does not collect at weekends/) })
    await expect(fake.book(call('FAKE'), request({ readyFrom: '2026-12-10T09:00:00.000Z' }))).rejects.toMatchObject({ httpStatus: 422 })
    expect(await fake.cancel(call('FAKE'), booked.providerReference)).toBe('CANCELLED')
    expect(fake.pickupOf(booked.providerReference)?.cancelled).toBe(true)
    await expect(fake.cancel(call('FAKE'), 'FPU-NONE')).rejects.toMatchObject({ httpStatus: 404 })
    expect(fake.booked).toBe(1)
  })

  it('scripts failures and refuses a live account', async () => {
    const fake = new FakeSendcloudPickups(clock)
    fake.failNext(1, 503)
    await expect(fake.book(call('FAKE'), request())).rejects.toMatchObject({ httpStatus: 503, retryable: true })
    await expect(fake.book(call('LIVE'), request())).rejects.toThrow(/Only a FAKE Sendcloud account/)
  })
})
