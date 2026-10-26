/**
 * Meta on the gateway, step 23 (create-meta-media): an upload reaches Meta ONLY as one of its exact allow-list entries
 * (meta-media-rules.ts) — an image's strict Base64 bytes (a JPG or PNG of at most 8 MB), a video's public link (Meta
 * fetches it), a video of the chosen Instagram account, Meta's video-ads upload (start, the link on rupload.facebook.com as
 * its file_url header, finish), a folder in the chosen portfolio, captions and a video's default caption — on the business's
 * CHOSEN ad account (the act_<id> in the path), its own portfolio (not shared with another Nexus business), its chosen
 * Instagram account's media, a video upload THIS connection started (`startedvideo`), a video of its library (step 22's
 * `video`). The undo's removals go through step 22's rules (meta-remove-writes.vitest.test.ts). Image bytes never reach the ledger; no 30-s
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

import { gatewayLedger, gatewayMetaChosen, gatewayMetaInstagram, gatewayMetaPage, gatewayMetaSharedPortfolios } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { gatewayCall } from './gateway.js'
import { metaRuploadCall, metaWriteCall } from './meta.js'
import { metaWriteVerdict } from './meta-calls.js'
import { __metaMediaRulesTest, META_CAPTIONS_MAX_BYTES, META_IMAGE_BASE64_MAX, metaFileUrlProblem, metaImageBytesProblem, metaMediaTextProblem, metaMultipartBody, metaRuploadUrl, metaSrtProblem, metaVideoStartedOn, noteMetaVideoStarted } from './meta-media-rules.js'
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
  for (const key of Object.keys(gatewayMetaInstagram)) delete gatewayMetaInstagram[key]
  // Step 21's chosen Instagram account (metaChosenInstagramOf) of the connection these tests use.
  gatewayMetaInstagram['m-1'] = IG
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
    expect(verdict({ url, objectKind: 'business', body: form({ name: 'Spring 2026', parent_folder_id: '120000000000701' }) })).toMatchObject({ write: { rule: 'portfolio.folder.create', objectId: PORTFOLIO, assets: [{ id: '120000000000701', kind: 'creativefolder' }] } })
    expect(problem({ url, objectKind: 'adaccount', body: form({ name: 'x' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'business', body: form({ name: ' ' }) })).toMatch(/name is 1 to 100/)
    expect(problem({ url, objectKind: 'business', body: form({ name: 'x', parent_folder_id: 'abc' }) })).toMatch(/digits only/)
  })
  it('review A6 — step 23\'s own text: no bidirectional control, a visible character, a title counted in UTF-8 bytes', () => {
    const url = `${BASE}/${ACT}/advideos`
    const link = 'https://cdn.example.com/v.mp4'
    expect(problem({ url, body: form({ file_url: link, name: 'Spot \u202Egnp.exe' }) })).toMatch(/no control or format characters/)
    expect(problem({ url, body: form({ file_url: link, name: 'A\u2066b\u2069' }) })).toMatch(/no control or format characters/)
    expect(problem({ url, body: form({ file_url: link, name: '\u200B\u200B\u2060' }) })).toMatch(/no control or format characters/)
    expect(problem({ url, body: form({ file_url: link, name: '\u3164\u2800' }) })).toMatch(/visible character/)
    expect(problem({ url, body: form({ file_url: link, title: 'ä'.repeat(127) }) })).toBeNull()
    expect(problem({ url, body: form({ file_url: link, title: 'ä'.repeat(128) }) })).toMatch(/254 bytes/)
    expect(problem({ url: `${BASE}/${PORTFOLIO}/creative_folders`, objectKind: 'business', body: form({ name: '\u200E\uFEFF' }) })).toMatch(/no control or format characters/)
    expect(metaMediaTextProblem('Spring 2026 è ✓', 100, 'name')).toBeNull()
    // Review round 2 — blanks that draw nothing (Hangul fillers, braille blank) and a combining mark alone are not visible;
    // a mark on a base is, and a joiner only between two emoji is fine.
    for (const blank of ['\u3164', '\u115F\u1160', '\u2800\u2800', '\uFFA0', '\u0301', '\u0301\u0302']) expect(metaMediaTextProblem(blank, 100, 'name'), JSON.stringify(blank)).toMatch(/visible character/)
    expect(metaMediaTextProblem('Cafe\u0301', 100, 'name')).toBeNull()
    expect(metaMediaTextProblem('Team \u{1F469}\u200D\u{1F4BB}', 100, 'name')).toBeNull()
    expect(metaMediaTextProblem('Te\u200Dam', 100, 'name')).toMatch(/control or format character/)
    expect(metaMediaTextProblem('Spot\u00ADA', 100, 'name')).toMatch(/control or format character/)
  })
  it('MD-026 captions: an SRT file part the gateway encodes, its name <name>.<locale>.srt, at most 200,000 bytes; the undo by step 22\'s locales_to_delete, then the default caption alone', () => {
    const url = `${BASE}/${VIDEO}/captions`
    const srt = '1\n00:00:01,000 --> 00:00:03,500\nCiao!\n\n2\n00:00:04,000 --> 00:00:06,000\nSpedizione gratuita ✓'
    const ok = verdict({ url, objectKind: 'video', body: form({ captions_file: srt, captions_file_name: 'spot.it_IT.srt', default_locale: 'it_IT' }) })
    expect(ok).toEqual({ write: { rule: 'video.captions.upload', objectId: VIDEO, check: false, body: '', budget: false, kinds: ['video'], edgeCall: true, bulky: true, multipart: { fields: [['default_locale', 'it_IT']], file: { key: 'captions_file', filename: 'spot.it_IT.srt', contentType: 'application/x-subrip', text: srt } } } })
    expect(problem({ url, objectKind: 'video', body: form({ captions_file: srt, captions_file_name: 'spot.srt' }) })).toMatch(/<name>\.<locale>\.srt/)
    expect(problem({ url, objectKind: 'video', body: form({ captions_file: srt, captions_file_name: '../x.it_IT.srt' }) })).toMatch(/<name>\.<locale>\.srt/)
    expect(problem({ url, objectKind: 'video', body: form({ captions_file: 'not subtitles', captions_file_name: 'a.it_IT.srt' }) })).toMatch(/SubRip/)
    expect(problem({ url, objectKind: 'video', body: form({ captions_file: `${srt}\u0000`, captions_file_name: 'a.it_IT.srt' }) })).toMatch(/plain text/)
    expect(problem({ url, objectKind: 'video', body: form({ captions_file: srt, captions_file_name: 'a.it_IT.srt', default_locale: 'Italian' }) })).toMatch(/default_locale is a locale/)
    expect(problem({ url, objectKind: 'video', body: form({ captions_file: srt, captions_file_name: 'a.it_IT.srt', locales_to_delete: '["it_IT"]' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'adaccount', body: form({ captions_file: srt, captions_file_name: 'a.it_IT.srt' }) })).toMatch(/only Meta change/)
    const big = `1\n00:00:01,000 --> 00:00:02,000\n${'x'.repeat(META_CAPTIONS_MAX_BYTES)}`
    expect(META_CAPTIONS_MAX_BYTES).toBe(200_000)
    expect(metaSrtProblem(big)).toMatch(/at most 200,000 bytes/)
    expect(problem({ url, objectKind: 'video', body: form({ captions_file: big, captions_file_name: 'a.it_IT.srt' }) })).toMatch(/at most 200,000 bytes|at most \d+ characters/)
    // Review round 2 — every control character but tab, line feed and carriage return: C0 and C1 (U+0080–U+009F).
    for (const bad of ['\u0085', '\u0080', '\u009F', '\u001B', '\u007F']) expect(metaSrtProblem(`${srt}${bad}`), JSON.stringify(bad)).toMatch(/plain text/)
    expect(metaSrtProblem(srt.replace(/\n/g, '\r\n').replace('Ciao!', 'Ciao!\tok'))).toBeNull()
    // The undo: the language by step 22's captions.delete (alone), then the default caption it replaced by this step's own call.
    expect(verdict({ url, objectKind: 'video', body: form({ locales_to_delete: '["it_IT"]' }) })).toMatchObject({ write: { rule: 'captions.delete', body: 'locales_to_delete=%5B%22it_IT%22%5D', kinds: ['video'] } })
    expect(verdict({ url, objectKind: 'video', body: form({ default_locale: 'en_US' }) })).toEqual({ write: { rule: 'video.captions.default', objectId: VIDEO, check: false, body: 'default_locale=en_US', budget: false, kinds: ['video'], edgeCall: true } })
    expect(verdict({ url, objectKind: 'video', body: form({ default_locale: 'none' }) })).toMatchObject({ write: { rule: 'video.captions.default' } })
    expect(problem({ url, objectKind: 'video', body: form({ default_locale: 'English' }) })).toMatch(/default_locale is a locale/)
    expect(problem({ url, objectKind: 'video', body: form({ locales_to_delete: '["it_IT"]', default_locale: 'none' }) })).toMatch(/only Meta change/)
    expect(problem({ url, objectKind: 'ad', body: form({ default_locale: 'en_US' }) })).toMatch(/only Meta change/)
  })
  it('Meta\'s upload host: exactly the documented address, a write of kind startedvideo, one file_url — sent as its header, no body', () => {
    const url = metaRuploadUrl(VIDEO)
    expect(url).toBe(`https://rupload.facebook.com/video-ads-upload/v26.0/${VIDEO}`)
    expect(verdict({ url, objectKind: 'startedvideo', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toEqual({ write: { rule: 'video.rupload', objectId: VIDEO, check: false, body: '', budget: false, kinds: ['startedvideo'], edgeCall: true, host: 'rupload', headers: { file_url: 'https://cdn.example.com/v.mp4' } } })
    expect(problem({ url: `${url}?x=1`, objectKind: 'startedvideo', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/nothing else on the address/)
    expect(problem({ url: url.replace('v26.0', 'v25.0'), objectKind: 'startedvideo', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/only https:\/\/rupload/)
    expect(problem({ url: url.replace('video-ads-upload', 'upload'), objectKind: 'startedvideo', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/only https:\/\/rupload/)
    expect(problem({ url: `https://rupload.facebook.com:8443/video-ads-upload/v26.0/${VIDEO}`, objectKind: 'startedvideo', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/only https:\/\/rupload/)
    expect(problem({ url, objectKind: 'adaccount', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/kind startedvideo/)
    expect(problem({ url, objectKind: 'startedvideo', body: form({ file_url: 'https://cdn.example.com/v.mp4', offset: '0' }) })).toMatch(/exactly one key/)
    expect(problem({ url, objectKind: 'startedvideo', body: 'raw-video-bytes' })).toMatch(/exactly one key/)
    expect(problem({ url, objectKind: 'startedvideo', body: form({ file_url: 'https://cdn.example.com/v.mp4?Signature=x' }) })).toMatch(/no key, signature/)
    expect(problem({ url, objectKind: 'startedvideo', method: 'PUT', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/POST only/)
    expect(problem({ url, objectKind: 'startedvideo', headers: { file_url: 'https://cdn.example.com/v.mp4' }, body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/no header/)
    expect(problem({ url, objectKind: 'startedvideo', auth: 'app', body: form({ file_url: 'https://cdn.example.com/v.mp4' }) })).toMatch(/system-user token/)
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
  it('another ad account (another business\'s, or none chosen): refused by step 19\'s ad-account check before anything is sent, the other account never read', async () => {
    const err = await metaWriteCall({ connectionId: 'm-1', operation: 'media.imageUpload', objectId: OTHER_ACT, objectKind: 'adaccount', edge: 'adimages', params: { bytes: PNG }, check: false }).catch((e) => e)
    expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/goes only to the Meta ad account this business chose/) })
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
  it('review round 2 — the parent folder is confirmed when SEEN in the first 500 rows (counted in rows): row 450 of 600 passes, row 550 is refused', async () => {
    const page = (from: number, more: boolean) => json({ data: Array.from({ length: 100 }, (_, i) => ({ id: String(120000000001000 + from + i) })), ...(more ? { paging: { cursors: { after: `c${from}` }, next: 'more' } } : {}) })
    const folderCall = (parent: string) => metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'business', edge: 'creative_folders', params: { name: 'Inner', parent_folder_id: parent }, check: false })
    h.answers.push(json({ id: ACT, business: { id: PORTFOLIO } }))
    for (let p = 0; p < 6; p++) h.answers.push(page(1 + p * 100, p < 5))
    expect((await folderCall(String(120000000001000 + 450))).ok).toBe(true)
    // Step 28's read of the chosen account's portfolio, five reads of 100 rows (500), never the sixth page, then the POST.
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'POST'])
    h.calls = []; h.answers = []
    h.answers.push(json({ id: ACT, business: { id: PORTFOLIO } }))
    for (let p = 0; p < 6; p++) h.answers.push(page(1 + p * 100, p < 5))
    expect(await folderCall(String(120000000001000 + 550)).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/folder 120000000001550 is not one Nexus can confirm/) })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
  })
  it('a folder: on the chosen account\'s OWN portfolio (step 28\'s `business` check), never one another Nexus business shares; its parent among the portfolio\'s folders', async () => {
    const business = () => json({ id: ACT, business: { id: PORTFOLIO } })
    h.answers.push(business(), json({ id: '120000000000702' }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'business', edge: 'creative_folders', params: { name: 'Spring 2026' }, check: false })).ok).toBe(true)
    expect([sent(0).method, sent(0).url.pathname, sent(0).url.searchParams.get('fields')]).toEqual(['GET', `/v26.0/${ACT}`, 'business{id}'])
    expect([sent(1).method, sent(1).url.pathname]).toEqual(['POST', `/v26.0/${PORTFOLIO}/creative_folders`])
    h.calls = []
    h.answers.push(business())
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: '1111111111', objectKind: 'business', edge: 'creative_folders', params: { name: 'x' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/is not the business portfolio of the ad account this business chose/) })
    gatewayMetaSharedPortfolios.add(PORTFOLIO)
    h.answers.push(business())
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'business', edge: 'creative_folders', params: { name: 'x' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', message: expect.stringMatching(/another business in Nexus uses an ad account of this business portfolio/) })
    gatewayMetaSharedPortfolios.clear()
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET'])
    h.calls = []
    h.answers.push(business(), json({ data: [{ id: '120000000000701' }] }), json({ id: '120000000000703' }))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'business', edge: 'creative_folders', params: { name: 'Inner', parent_folder_id: '120000000000701' }, check: false })).ok).toBe(true)
    expect([sent(1).method, sent(1).url.pathname]).toEqual(['GET', `/v26.0/${PORTFOLIO}/creative_folders`])
    h.calls = []
    h.answers.push(business(), json({ data: [{ id: '120000000000701' }] }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'folder', objectId: PORTFOLIO, objectKind: 'business', edge: 'creative_folders', params: { name: 'Inner', parent_folder_id: '120000000000799' }, check: false }).catch((e) => e)).toMatchObject({ message: expect.stringMatching(/folder 120000000000799 is not one Nexus can confirm/) })
    expect(h.calls.map((c) => c.init.method)).toEqual(['GET', 'GET'])
  })
  it('MD-026 — captions go as ONE multipart body the gateway builds (no form type, no caller header), on a library video, never to the ledger', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,500\nCiao!'
    h.answers.push(json({ data: [{ id: VIDEO }] }), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'media.captionsUpload', objectId: VIDEO, objectKind: 'video', edge: 'captions', params: { captions_file: srt, captions_file_name: 'spot.it_IT.srt' }, check: false })
    expect(res.ok).toBe(true)
    const call = sent(1)
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe(`/v26.0/${VIDEO}/captions`)
    expect(call.headers['Content-Type']).toBeUndefined()
    expect(call.body).toBeInstanceOf(FormData)
    const body = call.body as FormData
    expect([...body.keys()]).toEqual(['captions_file'])
    const file = body.get('captions_file') as File
    expect([file.name, file.type, await file.text()]).toEqual(['spot.it_IT.srt', 'application/x-subrip', srt])
    // Not a library video (step 22's check: listed on the chosen account's advideos): refused before anything is sent.
    h.calls = []
    h.answers.push(json({ data: [] }))
    expect(await metaWriteCall({ connectionId: 'm-1', operation: 'x', objectId: '120000000000599', objectKind: 'video', edge: 'captions', params: { captions_file: srt, captions_file_name: 'spot.it_IT.srt' }, check: false }).catch((e) => e)).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls.every((c) => c.init.method === 'GET')).toBe(true)
    // A failed upload keeps the body's length only.
    h.calls = []
    gatewayLedger.length = 0
    h.answers.push(json({ data: [{ id: VIDEO }] }), json({ error: { code: 100, error_subcode: 482, message: 'locale already applied' } }, 400))
    expect((await metaWriteCall({ connectionId: 'm-1', operation: 'media.captionsUpload', objectId: VIDEO, objectKind: 'video', edge: 'captions', params: { captions_file: srt, captions_file_name: 'spot.it_IT.srt' }, check: false })).ok).toBe(false)
    expect(JSON.stringify(gatewayLedger)).not.toContain('Ciao')
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
    const raw = await gatewayCall({ channel: 'META', operation: 'x', kind: 'write', connectionId: 'm-1', url: metaRuploadUrl(VIDEO), method: 'POST', headers: { file_url: 'https://cdn.example.com/v.mp4', offset: '0' }, body: 'bytes', metaObjectKind: 'startedvideo' }).catch((e) => e)
    expect(raw).toMatchObject({ code: 'META_WRITE_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('gap 46b (master MD-024) — a Page video\'s custom thumbnail, made its preferred one, AS the chosen Page', () => {
  const PAGE = '120000000000010'
  const PAGE_VIDEO = '120000000000601'
  const PAGE_TOKEN = 'EAAPageTokenForGap46bTests1234567890'
  const thumb = (params: Record<string, string>, objectKind = 'ownpagevideo') => metaWriteVerdict({ method: 'POST', url: `${BASE}/${PAGE_VIDEO}/thumbnails`, kind: 'write', objectKind, body: form(params) })
  const thumbProblem = (params: Record<string, string>, objectKind?: string) => { const v = thumb(params, objectKind); return 'problem' in v ? v.problem : null }
  const good = { source: JPG, source_file_name: 'thumbnail.jpg', is_preferred: 'true' }

  it('the rule: source as an image FILE part (Base64 in, bytes out, typed by its bytes), its name as its type, is_preferred true — made as the Page', () => {
    const v = thumb(good)
    expect(v).toMatchObject({ write: { rule: 'pagevideo.thumbnail', objectId: PAGE_VIDEO, auth: 'page', bulky: true, edgeCall: true, body: '', kinds: ['ownpagevideo'] } })
    const multipart = 'write' in v ? v.write.multipart! : null
    expect(multipart).toEqual({ fields: [['is_preferred', 'true']], file: { key: 'source', filename: 'thumbnail.jpg', contentType: 'image/jpeg', text: JPG, base64: true } })
    expect(thumb({ ...good, source: PNG, source_file_name: 'thumbnail.png' })).toMatchObject({ write: { multipart: { file: { contentType: 'image/png', filename: 'thumbnail.png' } } } })
    // The file name says what the bytes are; is_preferred only true (MD-024: made the preferred one); nothing else.
    expect(thumbProblem({ ...good, source: PNG })).toMatch(/thumbnail\.png for a PNG/)
    expect(thumbProblem({ ...good, source_file_name: 'cover.jpg' })).toMatch(/source_file_name is thumbnail\.jpg for a JPG/)
    expect(thumbProblem({ ...good, is_preferred: 'false' })).toMatch(/is_preferred is true/)
    expect(thumbProblem({ source: JPG, source_file_name: 'thumbnail.jpg' })).toBeTruthy()
    expect(thumbProblem({ ...good, name: 'x' })).toBeTruthy()
    // Not a JPG or PNG: its name cannot say what it is (the name is judged first), and the bytes are never quoted.
    const gif = Buffer.from('GIF89a-not-for-meta').toString('base64')
    expect(thumbProblem({ ...good, source: gif })).toMatch(/thumbnail\.jpg for a JPG and thumbnail\.png for a PNG/)
    expect(thumbProblem({ ...good, source: gif })).not.toContain(gif)
    expect(thumbProblem({ ...good, source: `${JPG.slice(0, -1)}-` })).toMatch(/source is strict Base64/)
    const big = `${JPG}${'A'.repeat(META_IMAGE_BASE64_MAX - JPG.length + 4)}`
    expect(thumbProblem({ ...good, source: big })).toMatch(/source is at most|source is an image of at most/)
    // Only the Page video kind; another object kind (a library video, a Page) has no thumbnail rule.
    for (const kind of ['video', 'page', 'adaccount']) expect(thumbProblem(good, kind), kind).toMatch(/only Meta change Nexus sends on a media edge is create-meta-media's upload.*a Page video's thumbnail/)
    // On the Graph host only (the thumbnails reference's example; the video host takes only a Page's video post).
    const onVideoHost = metaWriteVerdict({ method: 'POST', url: `https://graph-video.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${PAGE_VIDEO}/thumbnails`, kind: 'write', objectKind: 'ownpagevideo', body: form(good) })
    expect('problem' in onVideoHost && onVideoHost.problem).toMatch(/video host/)
  })
  it('the multipart body carries the decoded BYTES, typed, named; the Base64 itself is never sent', async () => {
    const body = metaMultipartBody({ fields: [['is_preferred', 'true']], file: { key: 'source', filename: 'thumbnail.png', contentType: 'image/png', text: PNG, base64: true } })
    expect([...body.keys()]).toEqual(['is_preferred', 'source'])
    const file = body.get('source') as File
    expect([file.name, file.type]).toEqual(['thumbnail.png', 'image/png'])
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(PNG, 'base64'))).toBe(true)
    // Captions (a text file) stay as they were.
    const srt = metaMultipartBody({ fields: [], file: { key: 'captions_file', filename: 'spot.it_IT.srt', contentType: 'application/x-subrip', text: '1\n00:00:01,000 --> 00:00:02,000\nCiao' } })
    expect(await (srt.get('captions_file') as File).text()).toBe('1\n00:00:01,000 --> 00:00:02,000\nCiao')
  })
  it('through the gateway: ONE owner read (the chosen Page posted it, a video), the Page\'s token, then ONE multipart POST — never the ledger', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
    gatewayMetaPage['m-1'] = PAGE
    h.answers.push(json({ id: PAGE_VIDEO, from: { id: PAGE }, length: 12.5 }), json({ id: PAGE, access_token: PAGE_TOKEN }), json({ success: true }))
    const res = await metaWriteCall({ connectionId: 'm-1', operation: 'media.pageVideoThumbnail', objectId: PAGE_VIDEO, objectKind: 'ownpagevideo', edge: 'thumbnails', params: good, check: false })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => `${c.init.method} ${new URL(c.url).pathname.replace(`/${META_DEFAULT_GRAPH_API_VERSION}`, '')}`)).toEqual([`GET /${PAGE_VIDEO}`, `GET /${PAGE}`, `POST /${PAGE_VIDEO}/thumbnails`])
    expect(new URL(h.calls[0].url).searchParams.get('fields')).toBe('id,from{id},length')
    expect(new URL(h.calls[0].url).searchParams.get('access_token')).toBe('meta-system-user-token')
    const post = sent(2)
    expect(post.url.host).toBe('graph.facebook.com')
    expect(post.url.searchParams.get('access_token')).toBe(PAGE_TOKEN)
    expect(post.body).toBeInstanceOf(FormData)
    const file = (post.body as FormData).get('source') as File
    expect([file.name, file.type, (post.body as FormData).get('is_preferred')]).toEqual(['thumbnail.jpg', 'image/jpeg', 'true'])
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(JPG, 'base64'))).toBe(true)
    expect(JSON.stringify(gatewayLedger)).not.toContain(JPG.slice(0, 40))
    expect(JSON.stringify(gatewayLedger)).not.toContain(PAGE_TOKEN)
  })
  it('another Page\'s video, a post or photo (no length), an unreadable one, or no Page chosen: nothing sent, no token read', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
    gatewayMetaPage['m-1'] = PAGE
    const call = () => metaWriteCall({ connectionId: 'm-1', operation: 'media.pageVideoThumbnail', objectId: PAGE_VIDEO, objectKind: 'ownpagevideo', edge: 'thumbnails', params: good, check: false }).catch((e) => e)
    for (const [answer, code, words] of [
      [json({ id: PAGE_VIDEO, from: { id: '120000000000099' }, length: 9 }), 'META_PAGE_NOT_CHOSEN', /not one the Facebook Page this business chose posted/],
      [json({ error: { message: '(#100) Tried accessing nonexisting field (length) on node type (Photo)', code: 100 } }, 400), 'META_WRITE_NOT_ALLOWED', /is not a video/],
      [json({ id: PAGE_VIDEO, from: { id: PAGE } }), 'META_WRITE_NOT_ALLOWED', /names no length/],
      [json({ id: '120000000000602', from: { id: PAGE }, length: 9 }), 'META_PAGE_UNCONFIRMED', /another object than video/],
      [json({ error: { message: 'Unsupported get request.', code: 100 } }, 400), 'META_PAGE_UNCONFIRMED', /could not confirm that video/],
    ] as const) {
      h.calls = []
      h.answers.push(answer)
      const refused = await call()
      expect(refused, String(words)).toMatchObject({ code, message: expect.stringMatching(words) })
      expect(h.calls.map((c) => c.init.method)).toEqual(['GET'])
    }
    h.calls = []
    delete gatewayMetaPage['m-1']
    expect(await call()).toMatchObject({ code: 'META_PAGE_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
})
