/**
 * Meta step 33 on the gateway: Conversions API events (upload-meta-events) reach Meta only on their EXACT allow-list
 * entry — POST /<pixel id>/events, named a pixel, with Nexus's own partner_agent and a `data` list whose every key at
 * every depth is on the list, hashes only where Meta hashes, no website event, nothing older than 7 days at the moment
 * it is sent — only for a pixel the business may send to (the switch and the pixel rule), with no body kept in the ledger,
 * Meta's answer scrubbed of hashes, and none of Meta's per-object limits. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response>, pixelProblem: null as string | null, asked: [] as string[] }))
vi.mock('../marketing/meta-ads/events-rule.js', () => ({
  metaEventsPixelProblem: vi.fn(async (_connectionId: string, pixelId: string) => { h.asked.push(pixelId); return h.pixelProblem }),
}))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaAppAccessToken: vi.fn(async () => '1234567|app-secret-for-tests'),
  metaAppIdOf: vi.fn(async () => '1234567'),
  metaRenewalToken: vi.fn(async () => 'stored-meta-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
vi.mock('../cx/connectors/meta/token-check.js', () => ({ forgetMetaTokenCheck: vi.fn(async () => undefined) }))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaPersonalScrub, metaWriteVerdict } from './meta-calls.js'
import { metaEventsDataProblem, metaEventsJson, NEXUS_PARTNER_AGENT } from './meta-events-rules.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const PIXEL = '120000000000050'
const HASH = 'a'.repeat(64)
const NOW_S = Math.floor(Date.now() / 1000)
const event = (o: Record<string, unknown> = {}) => ({
  event_name: 'Purchase', event_time: NOW_S - 3600, event_id: 'nexus.order-1', action_source: 'phone_call',
  user_data: { em: [HASH], country: ['b'.repeat(64)] }, custom_data: { value: 49.9, currency: 'EUR', order_id: 'order-1' }, ...o,
})
const body = (events: unknown[], extra: Record<string, string> = {}) => new URLSearchParams({ data: metaEventsJson(events), partner_agent: NEXUS_PARTNER_AGENT, ...extra }).toString()
const verdict = (b: string, objectKind: string | undefined, url = `${BASE}/${PIXEL}/events`) => metaWriteVerdict({ method: 'POST', url, kind: 'write', body: b, objectKind })
const problem = (b: string, objectKind: string | undefined = 'pixel') => { const v = verdict(b, objectKind); return 'problem' in v ? v.problem : null }
const data = (events: unknown[]) => metaEventsDataProblem(metaEventsJson(events), NOW_S)

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; h.pixelProblem = null; h.asked = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ events_received: 1, messages: [], fbtrace_id: 'AbCdEfTrace' }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('pixel.events — the one shape Nexus sends', () => {
  it('passes as a write named a pixel, marked personal and free of per-object limits', () => {
    const b = body([event()])
    expect(verdict(b, 'pixel')).toEqual({ write: { rule: 'pixel.events', objectId: PIXEL, check: false, body: b, budget: false, kinds: ['pixel'], personal: true, objectLimits: false } })
    expect(problem(body([event()], { test_event_code: 'TEST12345' }), 'pixel')).toBeNull()
  })
  it('only on a pixel\'s events edge, named a pixel; never with Meta\'s check or an extra key', () => {
    expect((verdict(body([event()]), undefined) as { problem: string }).problem).toMatch(/only Meta change/)
    expect(problem(body([event()]), 'campaign')).toMatch(/only Meta change/)
    expect('problem' in verdict(body([event()]), 'pixel', `${BASE}/${PIXEL}`)).toBe(true)
    expect(problem(body([event()], { execution_options: '["validate_only"]' }), 'pixel')).toMatch(/only Meta change/)
    expect(problem(body([event()], { upload_tag: 'x' }), 'pixel')).toMatch(/only Meta change/)
    expect(problem(new URLSearchParams({ data: metaEventsJson([event()]), partner_agent: 'someone' }).toString(), 'pixel')).toMatch(/partner_agent is "nexus"/)
    expect(problem(body([event()], { test_event_code: 'TEST 1' }), 'pixel')).toMatch(/test_event_code/)
  })
  it('never a plain e-mail or phone: em and ph are SHA-256 hex only', () => {
    expect(data([event({ user_data: { em: ['shop@example.com'] } })])).toMatch(/SHA-256/)
    expect(data([event({ user_data: { ph: ['393331234567'] } })])).toMatch(/SHA-256/)
    expect(data([event({ user_data: { em: HASH } })])).toMatch(/list of 1–5/)
    expect(data([event({ user_data: { country: [HASH] } })])).toMatch(/hashed e-mail or phone/)
    expect(data([event({ user_data: { em: [HASH], fn: [HASH] } })])).toMatch(/fn, which no Nexus event sends/)
    expect(data([event({ user_data: { em: [HASH], client_ip_address: '10.0.0.1' } })])).toMatch(/client_ip_address/)
  })
  it('never a website event (the shop platform sends those): no website source, page or browser', () => {
    expect(data([event({ action_source: 'website' })])).toMatch(/no website event/)
    expect(data([event({ event_source_url: 'https://shop.example/thanks' })])).toMatch(/event_source_url, which no Nexus event sends/)
    expect(data([event({ user_data: { em: [HASH], client_user_agent: 'Mozilla/5.0' } })])).toMatch(/client_user_agent/)
  })
  it('one event older than 7 days at the moment it is judged refuses the request; nothing in the future', () => {
    expect(data([event(), event({ event_id: 'nexus.order-2', event_time: NOW_S - 7 * 86_400 })])).toMatch(/older than 7 days/)
    expect(data([event({ event_time: NOW_S + 3600 })])).toMatch(/in the future/)
    expect(data([event({ event_time: '1760000000' })])).toMatch(/Unix seconds/)
  })
  it('every event carries its own event_id, once; Purchase only; value and currency of the order', () => {
    expect(data([event({ event_id: undefined })])).toMatch(/lacks event_id/)
    expect(data([event(), event()])).toMatch(/repeats an event_id/)
    expect(data([event({ event_name: 'Lead' })])).toMatch(/Purchase only/)
    expect(data([event({ custom_data: { value: 49.999, currency: 'EUR', order_id: 'order-1' } })])).toMatch(/2 decimals/)
    expect(data([event({ custom_data: { value: 0, currency: 'EUR', order_id: 'order-1' } })])).toMatch(/above 0/)
    expect(data([event({ custom_data: { value: 10, currency: 'eur', order_id: 'order-1' } })])).toMatch(/ISO 4217/)
    expect(data([event({ custom_data: { value: 10, currency: 'EUR' } })])).toMatch(/lacks order_id/)
    expect(data([event({ custom_data: { value: 10, currency: 'EUR', order_id: 'order-1', predicted_ltv: 5 } })])).toMatch(/predicted_ltv/)
    expect(data([event({ data_processing_options: ['LDU'] })])).toMatch(/data_processing_options/)
  })
  it('contents and the buyer segment only in Meta\'s shapes', () => {
    const custom = (o: Record<string, unknown>) => data([event({ custom_data: { value: 10, currency: 'EUR', order_id: 'order-1', ...o } })])
    expect(custom({ content_type: 'product', contents: [{ id: 'SKU-1', quantity: 2, item_price: 5 }] })).toBeNull()
    expect(custom({ contents: [{ id: 'SKU-1', quantity: 2 }] })).toMatch(/content_type is product/)
    expect(custom({ content_type: 'product', contents: [{ id: 'SKU-1', quantity: 0 }] })).toMatch(/quantity/)
    expect(custom({ customer_segmentation: 'new_customer_to_business' })).toBeNull()
    expect(custom({ customer_segmentation: 'vip' })).toMatch(/customer_segmentation/)
  })
  it('one spelling only (no key twice, compact), at most Meta\'s 1,000 events, a list', () => {
    const raw = metaEventsJson([event()])
    expect(metaEventsDataProblem(raw.replace('"event_name":"Purchase"', '"event_name":"Purchase","event_name":"Purchase"'), NOW_S)).toMatch(/one spelling/)
    expect(metaEventsDataProblem(raw.replace('{', '{ '), NOW_S)).toMatch(/one spelling/)
    expect(metaEventsDataProblem('{}', NOW_S)).toMatch(/list of events/)
    expect(data(Array.from({ length: 1001 }, (_, i) => event({ event_id: `nexus.order-${i}` })))).toMatch(/at most 1000 events/)
    expect(metaEventsJson({ id: 'Città' })).toBe('{"id":"Citt\\u00e0"}')
  })
})

describe('metaWriteCall of events', () => {
  const send = (params: Record<string, string>) => metaWriteCall({ connectionId: 'conn-1', operation: 'events.send', objectId: PIXEL, objectKind: 'pixel', params, check: false, edge: 'events' })
  const params = () => ({ data: metaEventsJson([event()]), partner_agent: NEXUS_PARTNER_AGENT })

  it('asks the pixel rule, sends the judged body once, and keeps no body in the ledger', async () => {
    const answer = await send(params())
    expect(answer.ok).toBe(true)
    expect(h.asked).toEqual([PIXEL])
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toContain(`/${PIXEL}/events?`)
    expect(h.calls[0].init.method).toBe('POST')
    expect(String(h.calls[0].init.body)).toBe(body([event()]))
    expect(JSON.stringify(gatewayLedger)).not.toContain(HASH)
  })
  it('a pixel the rule refuses (switch off, taken, not the account\'s) gets nothing sent', async () => {
    h.pixelProblem = 'Sending sales to Meta (Conversions API) is switched off for this business.'
    await expect(send(params())).rejects.toThrow(/Nothing was sent to Meta: Sending sales to Meta/)
    expect(h.calls).toHaveLength(0)
  })
  it('with Meta changes switched off nothing is sent', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    await expect(send(params())).rejects.toThrow(/switched off/)
    expect(h.calls).toHaveLength(0)
  })
  it('a failed call keeps only the body\'s size, and Meta\'s answer comes back with every hash and e-mail removed', async () => {
    h.answers.push(() => new Response(JSON.stringify({ error: { message: `Invalid parameter em ${HASH} for shop@example.com`, code: 100, error_subcode: 2804050, fbtrace_id: 'AbCdEfTrace' } }), { status: 400 }))
    const answer = await send(params())
    expect(answer.ok).toBe(false)
    expect(answer.text).not.toContain(HASH)
    expect(answer.text).not.toContain('shop@example.com')
    expect(answer.verdict?.channelMessage ?? '').not.toContain(HASH)
    const row = gatewayLedger.at(-1) as unknown as Record<string, unknown>
    expect(row.requestPayload).toEqual({ __personal: true, bytes: body([event()]).length })
    expect(JSON.stringify(gatewayLedger)).not.toContain(HASH)
    expect(JSON.stringify(gatewayLedger)).not.toContain('shop@example.com')
  })
  it('no per-object limit: a second request to the same pixel goes at once', async () => {
    await send(params())
    await send(params())
    expect(h.calls).toHaveLength(2)
  })
})

describe('metaPersonalScrub', () => {
  it('removes hashes, e-mails and Meta browser ids, and leaves JSON readable', () => {
    const text = JSON.stringify({ error: { message: `em ${HASH} of a@b.example, fbp fb.1.1558571054389.1098115397`, fbtrace_id: 'AbCdEfTrace' } })
    const clean = metaPersonalScrub(text)
    expect(JSON.parse(clean).error.message).toBe('em [hash] of [e-mail], fbp [browser id]')
    expect(JSON.parse(clean).error.fbtrace_id).toBe('AbCdEfTrace')
  })
})
