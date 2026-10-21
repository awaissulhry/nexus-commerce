/**
 * Meta step 22 on the gateway: remove-meta-ads-items' deletes reach Meta only on their EXACT allow-list entries — a
 * creative (DELETE /<id>, no body, kind creative), an image of the chosen ad account's library (DELETE act_<id>/adimages,
 * `hash` the only body key), a video of that library (DELETE act_<id>/advideos, `video_id`), a video's caption languages
 * (POST /<video id>/captions, `locales_to_delete` in one spelling), an Instant Experience part (DELETE /<id>, kind
 * canvaselement) — and each object is confirmed to be the chosen ad account's (or Page's) before anything is sent: a
 * creative by its account_id and a creative's own fields, a video by the account's library, a part by the Page's parts.
 * Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async () => new Set<string>()) }))
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaPage, gatewayMetaStored } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { __metaObjectLimitsTest } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const CREATIVE = '120000000000040'
const VIDEO = '120000000000060'
const PART = '120000000000070'
const PAGE = '120000000000080'
const HASH = '0d500843a1d4699a0b41e99f4137a5c3'
const verdict = (input: { body?: unknown; objectKind?: string; url: string; method?: string; kind?: string }) =>
  metaWriteVerdict({ method: input.method ?? 'DELETE', url: input.url, kind: input.kind ?? 'write', body: input.body, objectKind: input.objectKind })
const problem = (input: Parameters<typeof verdict>[0]) => { const v = verdict(input); return 'problem' in v ? v.problem : null }
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaStored)) delete gatewayMetaStored[key]
  for (const key of Object.keys(gatewayMetaPage)) delete gatewayMetaPage[key]
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the allow-list: each delete exactly as Meta documents it, nothing more', () => {
  it('a creative: DELETE /<id> named kind creative, no body', () => {
    expect(verdict({ url: `${BASE}/${CREATIVE}`, objectKind: 'creative' })).toMatchObject({ write: { rule: 'creative.delete', method: 'DELETE', body: '', kinds: ['creative'] } })
    expect(problem({ url: `${BASE}/${CREATIVE}`, objectKind: 'creative', body: 'status=DELETED' })).toMatch(/deletes on Meta only/)
    expect(problem({ url: `${BASE}/${CREATIVE}`, objectKind: 'creative', method: 'POST', body: 'status=DELETED' })).toMatch(/deletes nothing by a status change|only Meta change/)
    expect(problem({ url: `${BASE}/${CREATIVE}/adlabels`, objectKind: 'creative' })).toMatch(/deletes on Meta only/)
  })
  it('an image: DELETE act_<id>/adimages with its hash as the ONLY body key; never in the URL, never image_id', () => {
    expect(verdict({ url: `${BASE}/${ACT}/adimages`, objectKind: 'adaccount', body: `hash=${HASH}` })).toMatchObject({ write: { rule: 'image.delete', method: 'DELETE', body: `hash=${HASH}`, objectId: ACT, kinds: ['adaccount'] } })
    expect(problem({ url: `${BASE}/${ACT}/adimages`, objectKind: 'adaccount' })).toMatch(/deletes on Meta only/)
    expect(problem({ url: `${BASE}/${ACT}/adimages?hash=${HASH}`, objectKind: 'adaccount' })).toMatch(/never in the URL/)
    expect(problem({ url: `${BASE}/${ACT}/adimages`, objectKind: 'adaccount', body: `hash=${HASH}&image_id=1` })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${ACT}/adimages`, objectKind: 'adaccount', body: 'hash=abc%2Fdef' })).toMatch(/image hash/)
    expect(problem({ url: `${BASE}/${ACT}/adimages`, objectKind: 'adaccount', body: `hash=${HASH}&hash=${HASH}` })).toMatch(/more than once/)
    expect(problem({ url: `${BASE}/${ACT}/adimages`, objectKind: 'campaign', body: `hash=${HASH}` })).toMatch(/deletes on Meta only/)
    expect(problem({ url: `${BASE}/${ACT}/adimages`, objectKind: 'adaccount', body: `hash=${HASH}`, kind: 'read' })).toMatch(/goes as a write/)
    // POST to the same edge is an upload (step 23's), not a delete.
    expect(problem({ url: `${BASE}/${ACT}/adimages`, objectKind: 'adaccount', body: `hash=${HASH}`, method: 'POST' })).toMatch(/only Meta change/)
  })
  it('a video: DELETE act_<id>/advideos with video_id (digits) as the only key, and the video named for the account check', () => {
    expect(verdict({ url: `${BASE}/${ACT}/advideos`, objectKind: 'adaccount', body: `video_id=${VIDEO}` })).toMatchObject({ write: { rule: 'video.remove', method: 'DELETE', body: `video_id=${VIDEO}`, ids: [{ id: VIDEO, kind: 'video' }] } })
    expect(problem({ url: `${BASE}/${ACT}/advideos`, objectKind: 'adaccount', body: 'video_id=act_1' })).toMatch(/digits only/)
    expect(problem({ url: `${BASE}/${ACT}/advideos`, objectKind: 'adaccount', body: `video_id=${VIDEO}&name=x` })).toMatch(/only Meta change/)
  })
  it('caption languages: POST /<video id>/captions locales_to_delete in one spelling, named kind video', () => {
    const body = new URLSearchParams({ locales_to_delete: '["en_US","it_IT"]' }).toString()
    expect(verdict({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'video', method: 'POST', body })).toMatchObject({ write: { rule: 'captions.delete', objectId: VIDEO, kinds: ['video'] } })
    expect(problem({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'video', method: 'POST', body: new URLSearchParams({ locales_to_delete: '["en_US", "it_IT"]' }).toString() })).toMatch(/one spelling/)
    expect(problem({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'video', method: 'POST', body: new URLSearchParams({ locales_to_delete: '["en_US","en_US"]' }).toString() })).toMatch(/each language once/)
    expect(problem({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'video', method: 'POST', body: new URLSearchParams({ locales_to_delete: '["english"]' }).toString() })).toMatch(/as Meta names them/)
    expect(problem({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'video', method: 'POST', body: new URLSearchParams({ locales_to_delete: '[]' }).toString() })).toMatch(/1 to 50/)
    expect(problem({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'video', method: 'POST', body: `${body}&default_locale=none` })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'ad', method: 'POST', body })).toMatch(/only Meta change/)
    expect(problem({ url: `${BASE}/${VIDEO}/captions`, objectKind: 'video', method: 'DELETE', body })).toMatch(/deletes on Meta only/)
  })
  it('an Instant Experience part: DELETE /<id> named kind canvaselement, no body', () => {
    expect(verdict({ url: `${BASE}/${PART}`, objectKind: 'canvaselement' })).toMatchObject({ write: { rule: 'canvaselement.delete', method: 'DELETE', body: '' } })
    expect(problem({ url: `${BASE}/${PART}`, objectKind: 'canvaselement', body: 'x=1' })).toMatch(/deletes on Meta only/)
    expect(problem({ url: `${BASE}/${PART}`, objectKind: 'page' })).toMatch(/deletes on Meta only/)
  })
  it('Meta\'s bulk campaign delete is not on the list (CMP-051: Meta picks which die)', () => {
    for (const body of ['delete_strategy=DELETE_ANY', 'delete_strategy=DELETE_ARCHIVED_BEFORE&before_date=2026-01-01', 'delete_strategy=DELETE_OLDEST&object_count=5']) {
      expect(problem({ url: `${BASE}/${ACT}/campaigns`, objectKind: 'adaccount', body })).toMatch(/deletes on Meta only/)
    }
  })
})

describe('through the gateway: only the chosen ad account\'s (or Page\'s) own', () => {
  it('a creative of another ad account sends nothing; its own goes as a bodiless DELETE', async () => {
    h.answers.push(json({ id: CREATIVE, account_id: '5555555555', object_type: 'SHARE', status: 'ACTIVE' }))
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'creative.delete', objectId: CREATIVE, objectKind: 'creative', params: {}, check: false, method: 'DELETE' }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(other.message).not.toContain('5555555555')
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('account_id,object_type,status')
    h.calls = []
    h.answers.push(json({ id: CREATIVE, account_id: '1234567890', object_type: 'SHARE', status: 'ACTIVE' }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'creative.delete', objectId: CREATIVE, objectKind: 'creative', params: {}, check: false, method: 'DELETE' })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, c.init.body || null])).toEqual([['GET', `/v26.0/${CREATIVE}`, null], ['DELETE', `/v26.0/${CREATIVE}`, null]])
  })
  it('an id that is not a creative (no object_type) is refused', async () => {
    h.answers.push(json({ id: CREATIVE, account_id: '1234567890', status: 'ACTIVE' }))
    const wrong = await metaWriteCall({ connectionId: 'm-1', operation: 'creative.delete', objectId: CREATIVE, objectKind: 'creative', params: {}, check: false, method: 'DELETE' }).catch((e) => e)
    expect(wrong).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED', message: expect.stringMatching(/not a creative Nexus can confirm/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('an image goes only to act_<chosen>/adimages, its hash as the form body', async () => {
    const other = await metaWriteCall({ connectionId: 'm-1', operation: 'image.delete', objectId: 'act_5555555555', objectKind: 'adaccount', edge: 'adimages', params: { hash: HASH }, check: false, method: 'DELETE' }).catch((e) => e)
    expect(other).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'image.delete', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', params: { hash: HASH }, check: false, method: 'DELETE' })).ok).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].init.method).toBe('DELETE')
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${ACT}/adimages`)
    expect(new URL(h.calls[0].url).searchParams.get('hash')).toBeNull()
    expect(h.calls[0].init.body).toBe(`hash=${HASH}`)
    expect((h.calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
  })
  it('a video is removed only when it is in the chosen ad account\'s library (paged by cursor, never by Meta\'s next link)', async () => {
    h.answers.push(json({ data: [{ id: '120000000000061' }], paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/next?access_token=x' } }))
    h.answers.push(json({ data: [{ id: '120000000000062' }], paging: { cursors: { after: 'CUR2' } } }))
    const missing = await metaWriteCall({ connectionId: 'm-1', operation: 'video.remove', objectId: ACT, objectKind: 'adaccount', edge: 'advideos', params: { video_id: VIDEO }, check: false, method: 'DELETE' }).catch((e) => e)
    expect(missing).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/inside this change, video 120000000000060 is not in the chosen ad account's video library/) })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, new URL(c.url).searchParams.get('after')])).toEqual([['GET', `/v26.0/${ACT}/advideos`, null], ['GET', `/v26.0/${ACT}/advideos`, 'CUR1']])
    h.calls = []
    h.answers.push(json({ data: [{ id: '120000000000061' }], paging: { cursors: { after: 'CUR1' }, next: 'x' } }))
    h.answers.push(json({ data: [{ id: VIDEO }] }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'video.remove', objectId: ACT, objectKind: 'adaccount', edge: 'advideos', params: { video_id: VIDEO }, check: false, method: 'DELETE' })).ok).toBe(true)
    expect(h.calls.at(-1)!.init.method).toBe('DELETE')
    expect(h.calls.at(-1)!.init.body).toBe(`video_id=${VIDEO}`)
  })
  it('a library that cannot be read sends nothing', async () => {
    h.answers.push(json({ error: { message: 'Unsupported get request', code: 100 } }, 400))
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'captions.delete', objectId: VIDEO, objectKind: 'video', edge: 'captions', params: { locales_to_delete: '["en_US"]' }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_UNCONFIRMED' })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('caption languages of a library video go as a POST of locales_to_delete', async () => {
    h.answers.push(json({ data: [{ id: VIDEO }] }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'captions.delete', objectId: VIDEO, objectKind: 'video', edge: 'captions', params: { locales_to_delete: '["en_US"]' }, check: false })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${ACT}/advideos`], ['POST', `/v26.0/${VIDEO}/captions`]])
    expect(new URLSearchParams(String(h.calls[1].init.body)).get('locales_to_delete')).toBe('["en_US"]')
  })
  it('an Instant Experience part goes only when it is the chosen Page\'s (its own id or its element\'s)', async () => {
    const noPage = await metaWriteCall({ connectionId: 'm-1', operation: 'canvaselement.delete', objectId: PART, objectKind: 'canvaselement', params: {}, check: false, method: 'DELETE' }).catch((e) => e)
    expect(noPage).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/no Facebook Page chosen/) })
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(json({ data: [{ element: { id: '120000000000071' } }] }))
    const foreign = await metaWriteCall({ connectionId: 'm-1', operation: 'canvaselement.delete', objectId: PART, objectKind: 'canvaselement', params: {}, check: false, method: 'DELETE' }).catch((e) => e)
    expect(foreign).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not a part of the chosen Page's Instant Experiences/) })
    expect(new URL(h.calls[0].url).pathname).toBe(`/v26.0/${PAGE}/canvas_elements`)
    h.calls = []
    h.answers.push(json({ data: [{ element: { id: PART } }] }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'canvaselement.delete', objectId: PART, objectKind: 'canvaselement', params: {}, check: false, method: 'DELETE' })).ok).toBe(true)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['GET', `/v26.0/${PAGE}/canvas_elements`], ['DELETE', `/v26.0/${PART}`]])
  })
  it('Meta\'s check is never asked of a delete', async () => {
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'creative.delete.check', objectId: CREATIVE, objectKind: 'creative', params: {}, check: true, method: 'DELETE' }).catch((e) => e)
    expect(err).toBeTruthy()
    expect(h.calls.filter((c) => c.init.method === 'DELETE')).toHaveLength(0)
  })
})
