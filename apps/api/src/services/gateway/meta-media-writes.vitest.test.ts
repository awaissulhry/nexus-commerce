/**
 * Meta on the gateway, step 23 (create-meta-media): an upload reaches Meta ONLY as one of its exact allow-list entries
 * (meta-media-rules.ts) — an image's strict Base64 bytes (a JPG or PNG of at most 8 MB), a video's public link (Meta
 * fetches it), a video of the chosen Instagram account, Meta's video-ads upload (start, the link on rupload.facebook.com as
 * its file_url header, finish), a folder in the chosen portfolio, and the removal of an image or a video — on the business's
 * CHOSEN ad account (the act_<id> in the path), its own portfolio (not shared with another Nexus business), its chosen
 * Instagram account's media, a video upload THIS connection started. Image bytes never reach the ledger; no 30-s
 * per-object gap holds an edge call; the token goes to the upload host only in its Authorization header. Made-up ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaMedia, gatewayMetaSharedPortfolios } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { gatewayCall } from './gateway.js'
import { metaRuploadCall, metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { __metaMediaRulesTest, META_IMAGE_BASE64_MAX, metaFileUrlProblem, metaImageBytesProblem, metaRuploadUrl, metaVideoStartedOn, noteMetaVideoStarted } from './meta-media-rules.js'
import { __metaObjectLimitsTest, metaObjectState } from './meta-object-limits.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../meta/api-version.js'

const BASE = `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}`
const ACT = 'act_1234567890'
const OTHER_ACT = 'act_5555555555'
const PORTFOLIO = '9876543210'
const IG = '17841400000000001'
const VIDEO = '120000000000501'
/** A 1×1 PNG and the start of a JPG, as Base64. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/'
const form = (params: Record<string, string>) => new URLSearchParams(params).toString()

const verdict = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => metaWriteVerdict({ method: 'POST', url: `${BASE}/${ACT}/adimages`, kind: 'write', objectKind: 'adaccount', ...input })
const problem = (input: Partial<Parameters<typeof metaWriteVerdict>[0]>) => {
  const v = verdict(input)
  return 'problem' in v ? v.problem : null
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const sent = (i: number) => ({ method: h.calls[i].init.method, url: new URL(h.calls[i].url), body: h.calls[i].init.body, headers: h.calls[i].init.headers as Record<string, string> })

beforeEach(() => {
  __rateTest.useMemory()
  __metaObjectLimitsTest.useMemory()
  __metaMediaRulesTest.reset()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  for (const key of Object.keys(gatewayMetaChosen)) delete gatewayMetaChosen[key]
  for (const key of Object.keys(gatewayMetaMedia)) delete gatewayMetaMedia[key]
  gatewayMetaSharedPortfolios.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset(); __metaObjectLimitsTest.reset() })

describe('the image bytes and the link judges', () => {
  it('bytes: strict Base64 of a JPG or PNG, at most 8 MB — never quoted back', () => {
    expect(metaImageBytesProblem(PNG)).toBeNull()
    expect(metaImageBytesProblem(JPG)).toBeNull()
    expect(metaImageBytesProblem('')).toMatch(/Base64/)
    expect(metaImageBytesProblem(Buffer.from('GIF89a-not-for-meta').toString('base64'))).toMatch(/JPG or PNG/)
    expect(metaImageBytesProblem(`${PNG.slice(0, -2)}`)).toMatch(/strict Base64/)
    expect(metaImageBytesProblem(PNG.replace('A', '-'))).toMatch(/strict Base64/)
    expect(metaImageBytesProblem(`${PNG} `)).toMatch(/strict Base64/)
    expect(metaImageBytesProblem('iVBO=RAA')).toMatch(/strict Base64/)
    expect(metaImageBytesProblem(`iVBOR${'A'.repeat(META_IMAGE_BASE64_MAX)}`.slice(0, META_IMAGE_BASE64_MAX + 4))).toMatch(/at most 8 MB/)
    expect(metaImageBytesProblem(Buffer.from('<svg>secret</svg>').toString('base64'))).not.toMatch(/secret/)
  })
  it('a link Meta fetches: https, one spelling, a public name, no user, port, fragment, key or signature', () => {
    expect(metaFileUrlProblem('https://cdn.example.com/media/video-a.mp4')).toBeNull()
    expect(metaFileUrlProblem('https://res.example.com/v1/video/upload/clip.mp4?quality=auto')).toBeNull()
    expect(metaFileUrlProblem('http://cdn.example.com/a.mp4')).toMatch(/https/)
    expect(metaFileUrlProblem('https://CDN.example.com/a.mp4')).toMatch(/one spelling/)
    expect(metaFileUrlProblem('https://cdn.example.com/a b.mp4')).toMatch(/plain link/)
    expect(metaFileUrlProblem('https://user:pw@cdn.example.com/a.mp4')).toMatch(/no user/)
    expect(metaFileUrlProblem('https://cdn.example.com:8443/a.mp4')).toMatch(/no user, password, port/)
    expect(metaFileUrlProblem('https://cdn.example.com/a.mp4#t=1')).toMatch(/fragment/)
    expect(metaFileUrlProblem('https://10.0.0.5/a.mp4')).toMatch(/by its name/)
    expect(metaFileUrlProblem('https://[::1]/a.mp4')).toMatch(/by its name/)
    expect(metaFileUrlProblem('https://localhost/a.mp4')).toMatch(/by its name|local/)
    expect(metaFileUrlProblem('https://media.internal/a.mp4')).toMatch(/local or internal/)
    expect(metaFileUrlProblem('https://cdn.example.com/a.mp4?X-Amz-Signature=abc')).toMatch(/no key, signature/)
    expect(metaFileUrlProblem('https://cdn.example.com/a.mp4?access_token=EAAx')).toMatch(/no key, signature/)
    expect(metaFileUrlProblem(`https://cdn.example.com/${'a'.repeat(2000)}`)).toMatch(/at most 2000/)
  })
})

describe('the write allow-list for media (metaWriteVerdict)', () => {
  it('an image upload on the account edge: the bytes only, named the ad account, an edge call with a bulky body', () => {
    const ok = verdict({ body: form({ bytes: PNG }) })
    expect(ok).toEqual({ write: { rule: 'adaccount.image.upload', objectId: ACT, check: false, body: form({ bytes: PNG }), budget: false, kinds: ['adaccount'], edgeCall: true, bulky: true } })
    expect(problem({ body: form({ bytes: PNG, name: 'Shop A' }) })).toMatch(/only Meta change/)
    expect(problem({ body: form({ bytes: PNG }), objectKind: 'campaign' })).toMatch(/only Meta change/)
    expect(problem({ body: form({ bytes: PNG }), objectKind: undefined })).toMatch(/only Meta change/)
    expect(problem({ body: form({ bytes: Buffer.from('not an image at all').toString('base64') }) })).toMatch(/JPG or PNG/)
    expect(problem({ body: `${form({ bytes: PNG })}&bytes=${encodeURIComponent(JPG)}` })).toMatch(/more than once/)
    expect(problem({ body: form({ bytes: PNG, execution_options: '["validate_only"]' }) })).toMatch(/only Meta change/)
    expect(problem({ body: form({ bytes: PNG }), kind: 'read' })).toMatch(/goes as a write/)
  })
  it('an image of 8 MB passes (the body form-encoded), one byte more is refused — judged quickly, never quoted', () => {
    const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const eight = Buffer.concat([head, Buffer.alloc(8 * 1024 * 1024 - head.length, 0xfb)]).toString('base64')
    const started = Date.now()
    expect(verdict({ body: form({ bytes: eight }) })).toMatchObject({ write: { rule: 'adaccount.image.upload', bulky: true } })
    expect(Date.now() - started).toBeLessThan(5_000)
    const more = Buffer.concat([head, Buffer.alloc(8 * 1024 * 1024 - head.length + 1, 0xfb)]).toString('base64')
    const refused = problem({ body: form({ bytes: more }) })
    expect(refused).toMatch(/at most 8 MB/)
    expect(refused!.length).toBeLessThan(200)
  })
  it('MD-006 copy_from is not on the list (Nexus refuses it in the tool too)', () => {
    expect(problem({ body: form({ copy_from: JSON.stringify({ source_account_id: '5555555555', hash: 'abc' }) }) })).toMatch(/only Meta change/)
  })
  it('a video by its link, or the chosen Instagram account\'s with its music swapped — exact keys, JSON in one spelling', () => {
    const url = `${BASE}/${ACT}/advideos`
    expect(verdict({ url, body: form({ file_url: 'https://cdn.example.com/v.mp4', name: 'Clip A', title: 'Spot è ✓' }) })).toMatchObject({ write: { rule: 'adaccount.video.link', edgeCall: true } })
    expect(problem({ url, body: form({ file_url: 'http://cdn.example.com/v.mp4' }) })).toMatch(/https/)
    expect(problem({ url, body: form({ file_url: 'https://cdn.example.com/v.mp4', title: 'x'.repeat(255) }) })).toMatch(/title is 1 to 254/)
    expect(problem({ url, body: form({ file_url: 'https://cdn.example.com/v.mp4', title: 'a\u0007b' }) })).toMatch(/printable text/)
    expect(problem({ url, body: form({ file_url: 'https://cdn.example.com/v.mp4', upload_phase: 'start' }) })).toMatch(/only Meta change/)
    expect(problem({ url, body: form({ source: 'x' }) })).toMatch(/only Meta change/)
    const ig = verdict({ url, body: form({ source_instagram_media_id: '17900000000000001', selected_audio_spec: '{"audio_asset_id":"1234567"}' }) })
    expect(ig).toMatchObject({ write: { rule: 'adaccount.video.instagram', assets: [{ id: '17900000000000001', kind: 'instagrammedia' }] } })
    expect(problem({ url, body: form({ source_instagram_media_id: '17900000000000001', selected_audio_spec: '{ "audio_asset_id": "1234567" }' }) })).toMatch(/exactly \{"audio_asset_id"/)
    expect(problem({ url, body: form({ source_instagram_media_id: '17900000000000001', selected_audio_spec: '{"audio_asset_id":"1","x":1}' }) })).toMatch(/exactly/)
    expect(problem({ url, body: form({ source_instagram_media_id: '17900000000000001', file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/only Meta change/)
  })
  it('Meta\'s video-ads upload: start alone, finish with a video id (checked as started), nothing else', () => {
    const url = `${BASE}/${ACT}/video_ads`
    expect(verdict({ url, body: form({ upload_phase: 'start' }) })).toMatchObject({ write: { rule: 'adaccount.video_ads.start' } })
    expect(problem({ url, body: form({ upload_phase: 'finish' }) })).toMatch(/upload_phase is start/)
    expect(verdict({ url, body: form({ upload_phase: 'finish', video_id: VIDEO }) })).toMatchObject({ write: { rule: 'adaccount.video_ads.finish', assets: [{ id: VIDEO, kind: 'startedvideo' }] } })
    expect(problem({ url, body: form({ upload_phase: 'start', video_id: VIDEO }) })).toMatch(/upload_phase is finish/)
    expect(problem({ url, body: form({ upload_phase: 'start', title: 'x' }) })).toMatch(/only Meta change/)
  })
  it('a folder on the portfolio\'s edge (BM-058): a name, a description, a parent folder (checked)', () => {
    const url = `${BASE}/${PORTFOLIO}/creative_folders`
    expect(verdict({ url, objectKind: 'portfolio', body: form({ name: 'Spring 2026', parent_folder_id: '120000000000701' }) })).toMatchObject({ write: { rule: 'portfolio.folder.create', objectId: PORTFOLIO, assets: [{ id: '120000000000701', kind: 'creativefolder' }] } })
    expect(problem({ url, objectKind: 'adaccount', body: form({ name: 'x' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'portfolio', body: form({ name: ' ' }) })).toMatch(/name is 1 to 100/)
    expect(problem({ url, objectKind: 'portfolio', body: form({ name: 'x', parent_folder_id: 'abc' }) })).toMatch(/digits only/)
  })
  it('a removal: DELETE with its one key in the form body (an image\'s hash, a video\'s id); no body, no removal', () => {
    expect(verdict({ method: 'DELETE', body: form({ hash: '0123456789abcdef0123456789abcdef' }) })).toEqual({ write: { rule: 'adaccount.image.remove', objectId: ACT, check: false, body: 'hash=0123456789abcdef0123456789abcdef', budget: false, kinds: ['adaccount'], edgeCall: true, method: 'DELETE' } })
    expect(verdict({ method: 'DELETE', url: `${BASE}/${ACT}/advideos`, body: form({ video_id: VIDEO }) })).toMatchObject({ write: { rule: 'adaccount.video.remove', method: 'DELETE' } })
    expect(problem({ method: 'DELETE', body: undefined })).toMatch(/form body/)
    expect(problem({ method: 'DELETE', body: form({ hash: 'abc', image_id: '1' }) })).toMatch(/only Meta change/)
    expect(problem({ method: 'DELETE', body: form({ hash: 'ab/c' }) })).toMatch(/hash is an image hash/)
    expect(problem({ method: 'DELETE', url: `${BASE}/${ACT}/video_ads`, body: form({ video_id: VIDEO }) })).toMatch(/deletes nothing on Meta yet/)
  })
  it('Meta\'s upload host: exactly the documented address, a write of kind video, one file_url — sent as its header, no body', () => {
    const url = metaRuploadUrl(VIDEO)
    expect(url).toBe(`https://rupload.facebook.com/video-ads-upload/v26.0/${VIDEO}`)
    expect(verdict({ url, objectKind: 'video', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toEqual({ write: { rule: 'video.rupload', objectId: VIDEO, check: false, body: '', budget: false, kinds: ['video'], edgeCall: true, host: 'rupload', headers: { file_url: 'https://cdn.example.com/v.mp4' } } })
    expect(problem({ url: `${url}?x=1`, objectKind: 'video', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/nothing else on the address/)
    expect(problem({ url: url.replace('v26.0', 'v25.0'), objectKind: 'video', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/only https:\/\/rupload/)
    expect(problem({ url: url.replace('video-ads-upload', 'upload'), objectKind: 'video', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/only https:\/\/rupload/)
    expect(problem({ url: `https://rupload.facebook.com:8443/video-ads-upload/v26.0/${VIDEO}`, objectKind: 'video', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/only https:\/\/rupload/)
    expect(problem({ url, objectKind: 'adaccount', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/kind video/)
    expect(problem({ url, objectKind: 'video', body: form({ file_url: 'https://cdn.example.com/v.mp4', offset: '0' }) })).toMatch(/exactly one key/)
    expect(problem({ url, objectKind: 'video', body: 'raw-video-bytes' })).toMatch(/exactly one key/)
    expect(problem({ url, objectKind: 'video', body: form({ file_url: 'https://cdn.example.com/v.mp4?Signature=x' }) })).toMatch(/no key, signature/)
    expect(problem({ url, objectKind: 'video', method: 'PUT', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/POST only/)
    expect(problem({ url, objectKind: 'video', headers: { file_url: 'https://cdn.example.com/v.mp4' }, body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/no header/)
    expect(problem({ url, objectKind: 'video', auth: 'app', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/system-user token/)
    // The graph-video host stays refused (no Nexus path uses it: Meta's v26 advideos reference names graph.facebook.com).
    expect(problem({ url: `https://graph-video.facebook.com/v26.0/${ACT}/advideos`, body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/graph\.facebook\.com/)
  })
  it('a batch holding a media upload is refused like every batch', () => {
    const batch = `batch=${encodeURIComponent(JSON.stringify([{ method: 'POST', relative_url: `v26.0/${ACT}/adimages`, body: form({ bytes: PNG }) }]))}`
    expect(metaWriteVerdict({ method: 'POST', url: `${BASE}/`, kind: 'write', body: batch })).toMatchObject({ batch: true })
  })
})

describe('through the gateway', () => {
  it('an image upload to the CHOSEN account goes once (no owner read needed), the bytes as the body, an edge call', async () => {
    h.answers.push(json({ images: { bytes: { hash: '0123456789abcdef0123456789abcdef', url: 'https://scontent.example.com/x' } } }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'media.imageUpload', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: PNG }, check: false })
    expect(res.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(sent(0).method).toBe('POST')
    expect(sent(0).url.pathname).toBe(`/v26.0/${ACT}/adimages`)
    expect(sent(0).body).toBe(form({ bytes: PNG }))
    // An edge call is no edit of the account: no 30-s gap is noted for it.
    expect((await metaObjectState('m-1', ACT)).touchedAt).toBeNull()
    h.answers.push(json({ images: { bytes: { hash: 'ffffffffffffffffffffffffffffffff' } } }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'media.imageUpload', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: JPG }, check: false })).ok).toBe(true)
  })
  it('another ad account (another business\'s, or none chosen): refused before anything is sent, the other account never read', async () => {
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'media.imageUpload', objectId: OTHER_ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: PNG }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/the ad account this change names is not the one this business chose/) })
    expect(err.message).not.toContain('5555555555')
    gatewayMetaChosen['m-2'] = null
    expect(await metaWriteCall({ connectionId: 'm-2', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: PNG }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
  it('the bytes of a failed upload never reach the ledger: their length only', async () => {
    h.answers.push(json({ error: { code: 100, message: 'Invalid parameter' } }, 400))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'media.imageUpload', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: PNG }, check: false })
    expect(res.ok).toBe(false)
    const row = gatewayLedger.find((r) => r.operation === 'media.imageUpload')!
    expect(row.requestPayload).toEqual({ __omitted: 'the bytes of a Meta upload are never kept', bytes: form({ bytes: PNG }).length })
    expect(JSON.stringify(gatewayLedger)).not.toContain(PNG.slice(0, 20))
  })
  it('an Instagram media: ONE owner read, then the import — another account\'s media refused, nothing sent', async () => {
    h.answers.push(json({ id: '17900000000000001', owner: { id: IG } }), json({ id: VIDEO }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'media.videoUpload', objectId: ACT, objectKind: 'adaccount', edge: 'advideos', params: { source_instagram_media_id: '17900000000000001' }, check: false })).ok).toBe(true)
    expect(sent(0).method).toBe('GET')
    expect(sent(0).url.searchParams.get('fields')).toBe('id,owner,username')
    expect(sent(1).method).toBe('POST')
    h.calls = []
    h.answers.push(json({ id: '17900000000000002', owner: { id: '17841400000000999' } }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'advideos', params: { source_instagram_media_id: '17900000000000002' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not one Nexus can confirm as the chosen Instagram account's/) })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
    // No owner from Meta: its username against the chosen account's, read live.
    h.calls = []
    h.answers.push(json({ id: '17900000000000003', username: 'shop_a' }), json({ id: IG, username: 'Shop_A' }), json({ id: VIDEO }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'advideos', params: { source_instagram_media_id: '17900000000000003' }, check: false })).ok).toBe(true)
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'POST'])
    // No Instagram account chosen: refused before any read.
    h.calls = []
    gatewayMetaMedia['m-3'] = { instagramId: null, portfolioId: PORTFOLIO }
    expect(await metaWriteCall({ connectionId: 'm-3', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'advideos', params: { source_instagram_media_id: '17900000000000001' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
  it('Meta\'s video-ads upload: start (noted) → the link on the upload host (OAuth header, file_url header, no body, no token on the address) → finish', async () => {
    expect(await metaRuploadCall({ connectionId: 'm-1', operation: 'up', videoId: VIDEO, fileUrl: 'https://cdn.example.com/v.mp4' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/not an upload Nexus started/) })
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'fin', objectId: ACT, objectKind: 'adaccount', edge: 'video_ads', params: { upload_phase: 'finish', video_id: VIDEO }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ video_id: VIDEO, upload_url: metaRuploadUrl(VIDEO) }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'start', objectId: ACT, objectKind: 'adaccount', edge: 'video_ads', params: { upload_phase: 'start' }, check: false })).ok).toBe(true)
    expect(metaVideoStartedOn('m-1', VIDEO)).toBe('1234567890')
    expect(metaVideoStartedOn('m-9', VIDEO)).toBeNull()
    h.answers.push(json({ success: true }))
    expect((await metaRuploadCall({ connectionId: 'm-1', operation: 'up', videoId: VIDEO, fileUrl: 'https://cdn.example.com/v.mp4' })).ok).toBe(true)
    const up = sent(1)
    expect(up.url.origin).toBe('https://rupload.facebook.com')
    expect(up.url.pathname).toBe(`/video-ads-upload/v26.0/${VIDEO}`)
    expect([...up.url.searchParams.keys()].sort()).toEqual(['appsecret_proof', 'appsecret_time'])
    expect(up.headers.Authorization).toBe('OAuth meta-system-user-token')
    expect(up.headers.file_url).toBe('https://cdn.example.com/v.mp4')
    expect(up.headers['Content-Type']).toBeUndefined()
    expect(up.body).toBeUndefined()
    h.answers.push(json({ success: true }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'fin', objectId: ACT, objectKind: 'adaccount', edge: 'video_ads', params: { upload_phase: 'finish', video_id: VIDEO }, check: false })).ok).toBe(true)
    expect(sent(2).body).toBe(form({ upload_phase: 'finish', video_id: VIDEO }))
    expect(JSON.stringify(gatewayLedger)).not.toContain('meta-system-user-token')
    expect(gatewayLedger.map((r) => r.endpoint)).toContain(`rupload.facebook.com/video-ads-upload/v26.0/${VIDEO}`)
    // Another connection may not use this started upload; a note kept too long is forgotten.
    expect(await metaRuploadCall({ connectionId: 'm-4', operation: 'up', videoId: VIDEO, fileUrl: 'https://cdn.example.com/v.mp4' }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    noteMetaVideoStarted('m-5', '1234567890', VIDEO, Date.now() - 7 * 60 * 60_000)
    expect(metaVideoStartedOn('m-5', VIDEO)).toBeNull()
  })
  it('a folder: on the chosen account\'s OWN portfolio, never one another Nexus business shares; its parent among the portfolio\'s folders', async () => {
    h.answers.push(json({ id: '120000000000702' }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'portfolio', edge: 'creative_folders', params: { name: 'Spring 2026' }, check: false })).ok).toBe(true)
    expect(sent(0).url.pathname).toBe(`/v26.0/${PORTFOLIO}/creative_folders`)
    h.calls = []
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: '1111111111', objectKind: 'portfolio', edge: 'creative_folders', params: { name: 'x' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/business portfolio this change names is not the one/) })
    gatewayMetaSharedPortfolios.add(PORTFOLIO)
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'portfolio', edge: 'creative_folders', params: { name: 'x' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/another business in Nexus uses an ad account of this business portfolio/) })
    gatewayMetaSharedPortfolios.clear()
    expect(h.calls).toHaveLength(0)
    h.answers.push(json({ data: [{ id: '120000000000701' }] }), json({ id: '120000000000703' }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'portfolio', edge: 'creative_folders', params: { name: 'Inner', parent_folder_id: '120000000000701' }, check: false })).ok).toBe(true)
    expect(sent(0).url.pathname).toBe(`/v26.0/${PORTFOLIO}/creative_folders`)
    expect(sent(0).method).toBe('GET')
    h.calls = []
    h.answers.push(json({ data: [{ id: '120000000000701' }] }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'portfolio', edge: 'creative_folders', params: { name: 'Inner', parent_folder_id: '120000000000799' }, check: false }).catch((e) => e)).toMatchObject({ message: expect.stringMatching(/folder 120000000000799 is not one Nexus can confirm/) })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
  })
  it('a removal goes as DELETE with its key in the form body, on the chosen account only', async () => {
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'media.imageRemove', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', method: 'DELETE', params: { hash: '0123456789abcdef0123456789abcdef' }, check: false })
    expect(res.ok).toBe(true)
    expect(sent(0).method).toBe('DELETE')
    expect(sent(0).body).toBe('hash=0123456789abcdef0123456789abcdef')
    expect(sent(0).headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: OTHER_ACT, objectKind: 'adaccount', edge: 'advideos', method: 'DELETE', params: { video_id: VIDEO }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(1)
  })
  it('writes switched off: no upload, no upload-host call', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    noteMetaVideoStarted('m-1', '1234567890', VIDEO)
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: PNG }, check: false }).catch((e) => e)).toMatchObject({ code: 'PUBLISH_GATED' })
    expect(await metaRuploadCall({ connectionId: 'm-1', operation: 'up', videoId: VIDEO, fileUrl: 'https://cdn.example.com/v.mp4' }).catch((e) => e)).toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
  })
  it('a caller cannot slip a header or a raw rupload call past the judge', async () => {
    noteMetaVideoStarted('m-1', '1234567890', VIDEO)
    const raw = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: metaRuploadUrl(VIDEO), method: 'POST', headers: { file_url: 'https://cdn.example.com/v.mp4', offset: '0' }, body: 'bytes', metaObjectKind: 'video' }).catch((e) => e)
    expect(raw).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
  })
})
