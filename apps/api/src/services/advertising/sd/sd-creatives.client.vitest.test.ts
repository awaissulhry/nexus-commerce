/**
 * SD creatives (2026-10-20) — the creatives and asset-library clients, sent through the REAL Ads client (`liveCall`,
 * profiles ON) and the channel gateway with `fetch` stubbed, answered in the shapes of Amazon's SD 3.0 and Creative assets
 * 3.0 specs (Creative, CreativeModeration, CreativeResponse 207, CreativePreviewResponse; caAsset, the upload location,
 * the registration). Plus the rules Nexus checks before it asks (sd-creative-rules.ts). No call leaves this machine;
 * every id is made up (public repo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>,
  route: (_method: string, _url: string, _body: unknown): { status: number; json: unknown } => ({ status: 200, json: [] }),
}))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { __rateTest } from '../../gateway/rate.js'
import {
  listSdAdGroupCreativeTypes, listSdCreativeModerations, listSdCreatives, previewSdCreative, sdAmazonErrorWords, sdCreativeCreateRequest,
  sdCreativeResult, sdCreativeUpdateRequest, sdModerationLanguageFor, sendSdCreativeWrite,
} from './sd-creatives.client.js'
import { adsAssetRegisterBody, adsAssetSearchBody, getAdsAsset, searchAdsAssets, uploadAdsImageAsset } from './ads-assets.client.js'
import {
  sdAssetUseProblem, sdDefaultCrop, sdHeadlineProblem, sdModerationWords, sdPropertiesProblem, sdPropertiesWords, sdViolationWords,
} from './sd-creative-rules.js'

const CTX = { profileId: '123', region: 'EU' as const }
const LOGO = { assetId: 'amzn1.assetlibrary.asset1.testlogo0001', assetVersion: 'version_v1', croppingCoordinates: { top: 0, left: 0, width: 600, height: 100 } }
const IMAGE = { assetId: 'amzn1.assetlibrary.asset1.testimage001', assetVersion: 'version_v2' }

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []
  h.route = () => ({ status: 200, json: [] })
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off'); vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = String(init.method ?? 'GET')
    const body = init.body == null ? null : typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    h.calls.push({ method, url: String(url), body, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)) })
    const answer = h.route(method, String(url), body)
    return new Response(answer.json == null ? '' : JSON.stringify(answer.json), { status: answer.status })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('reads: creatives, moderation, the ad group\'s creative type', () => {
  it('reads the creatives of ad groups by Amazon id, every page, and their moderation in the language asked', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ creativeId: from + i, adGroupId: 300000000101, creativeType: 'IMAGE', properties: { headline: `H ${i}` }, moderationStatus: 'APPROVED' }))
    h.route = (_m, url) => {
      const q = new URL(url).searchParams
      if (url.includes('/sd/moderation/creatives')) return { status: 200, json: [{ creativeId: 400000000001, creativeType: 'IMAGE', moderationStatus: 'REJECTED', etaForModeration: '2026-10-21T10:00:00Z', policyViolations: [{ policyDescription: 'Unsubstantiated claim', policyLinkUrl: 'https://advertising.amazon.com/policy', violatingHeadlineContents: [{ reviewedText: 'Best jacket ever', textEvidence: [{ violatingText: 'Best' }] }] }] }] }
      return { status: 200, json: q.get('startIndex') === '0' ? page(100, 400000000001) : page(3, 400000000101) }
    }
    const creatives = await listSdCreatives(CTX, { externalAdGroupIds: ['300000000101', '300000000101'] })
    expect(creatives).toHaveLength(103)
    expect(creatives[0]).toEqual({ creativeId: '400000000001', adGroupId: '300000000101', creativeType: 'IMAGE', properties: { headline: 'H 0' }, moderationStatus: 'APPROVED' })
    const urls = h.calls.map((c) => new URL(c.url))
    expect(urls.map((u) => u.pathname)).toEqual(['/sd/creatives', '/sd/creatives'])
    expect(urls.map((u) => [u.searchParams.get('adGroupIdFilter'), u.searchParams.get('startIndex'), u.searchParams.get('count')])).toEqual([['300000000101', '0', '100'], ['300000000101', '100', '100']])

    h.calls = []
    const moderation = await listSdCreativeModerations(CTX, { creativeIds: ['400000000001'], language: 'en-IT' })
    expect(new URL(h.calls[0].url).searchParams.get('language')).toBe('en-IT')
    expect(new URL(h.calls[0].url).searchParams.get('creativeIdFilter')).toBe('400000000001')
    expect(moderation[0]).toMatchObject({ creativeId: '400000000001', moderationStatus: 'REJECTED', etaForModeration: '2026-10-21T10:00:00Z' })
    expect(sdViolationWords(moderation[0].policyViolations[0])).toBe('Unsubstantiated claim (https://advertising.amazon.com/policy) — headline "Best jacket ever": "Best"')
  })

  it('nothing named → nothing read (no unfiltered GET); sandbox → nothing read at all', async () => {
    expect(await listSdCreatives(CTX, {})).toEqual([])
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    expect(await listSdCreatives(CTX, { externalAdGroupIds: ['300000000101'] })).toEqual([])
    expect(await listSdAdGroupCreativeTypes(CTX, ['300000000101'])).toEqual(new Map())
    expect(await previewSdCreative(CTX, { creativeType: 'IMAGE', properties: {}, size: '300x250', asin: 'B0FXTEST01', isMobile: false, isOnAmazon: true })).toBeNull()
    expect(h.calls).toEqual([])
  })

  it('reads each ad group\'s creative type (null when Amazon states none)', async () => {
    h.route = () => ({ status: 200, json: [{ adGroupId: 300000000101, creativeType: 'VIDEO' }, { adGroupId: 300000000102 }] })
    const types = await listSdAdGroupCreativeTypes(CTX, ['300000000101', '300000000102'])
    expect([...types]).toEqual([['300000000101', 'VIDEO'], ['300000000102', null]])
    expect(new URL(h.calls[0].url).pathname).toBe('/sd/adGroups')
  })

  it('English moderation for the market (UK → en-GB, an unknown one → en-US)', () => {
    expect(['IT', 'DE', 'UK', 'US', 'PL'].map(sdModerationLanguageFor)).toEqual(['en-IT', 'en-DE', 'en-GB', 'en-US', 'en-US'])
  })
})

describe('writes: create and update, Amazon\'s 207 in its words', () => {
  it('builds the SD 3.0 bodies: int64 ids as numbers, Amazon\'s own read-only fields left out', () => {
    const create = sdCreativeCreateRequest({ externalAdGroupId: '300000000101', creativeType: 'IMAGE', properties: { headline: 'Ride dry', originalHeadline: 'Ride dry', brandLogo: LOGO }, consentToTranslate: true })
    expect(create).toEqual({ method: 'POST', path: '/sd/creatives', body: [{ adGroupId: 300000000101, creativeType: 'IMAGE', properties: { headline: 'Ride dry', brandLogo: LOGO }, consentToTranslate: true }] })
    const update = sdCreativeUpdateRequest({ creativeId: '400000000001', creativeType: 'VIDEO', properties: { video: { ...IMAGE, originalAssetId: 'x', originalAssetVersion: 'y' } } })
    expect(update.body).toEqual([{ creativeId: 400000000001, creativeType: 'VIDEO', properties: { video: IMAGE } }])
    expect(() => sdCreativeUpdateRequest({ creativeId: '99999999999999999999', creativeType: 'IMAGE', properties: {} })).toThrow(/cannot be sent as a number/)
  })

  it('reads the 207: a create by its new id, an update by SUCCESS; a refusal is Amazon\'s code and description', () => {
    expect(sdCreativeResult([{ code: 'SUCCESS', creativeId: 400000000001 }], 'POST')).toEqual({ ok: true, creativeId: '400000000001', error: null })
    expect(sdCreativeResult([{ code: 'INVALID_ARGUMENT', description: 'Headline contains invalid characters' }], 'POST')).toEqual({ ok: false, creativeId: null, error: 'Amazon refused it: INVALID_ARGUMENT — Headline contains invalid characters' })
    expect(sdCreativeResult([{ code: 'SUCCESS', creativeId: 400000000001 }], 'PUT')).toEqual({ ok: true, creativeId: '400000000001', error: null })
    expect(sdCreativeResult([{ code: 'CREATIVE_UNDER_MODERATION', description: 'Creative is pending review', creativeId: 400000000001 }], 'PUT').error).toBe('amazon_rejected: CREATIVE_UNDER_MODERATION — Creative is pending review')
    expect(sdCreativeResult([], 'PUT').ok).toBe(false)
  })

  it('sends a create once and gives its id; a refused one says Amazon\'s words', async () => {
    h.route = () => ({ status: 207, json: [{ code: 'SUCCESS', creativeId: 400000000009 }] })
    const request = sdCreativeCreateRequest({ externalAdGroupId: '300000000101', creativeType: 'IMAGE', properties: { headline: 'Ride dry' } })
    expect(await sendSdCreativeWrite(CTX, request, { externalAdGroupId: '300000000101' })).toEqual({ ok: true, mode: 'live', creativeId: '400000000009', error: null })
    expect(h.calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([['POST', '/sd/creatives', request.body]])

    h.route = () => ({ status: 207, json: [{ code: 'INVALID_ARGUMENT', description: 'Logo asset not found' }] })
    expect(await sendSdCreativeWrite(CTX, request, { externalAdGroupId: '300000000101' })).toMatchObject({ ok: false, creativeId: null, error: 'Amazon refused it: INVALID_ARGUMENT — Logo asset not found' })

    h.route = () => ({ status: 400, json: { code: '400', details: 'Malformed request' } })
    const refused = await sendSdCreativeWrite(CTX, sdCreativeUpdateRequest({ creativeId: '400000000009', creativeType: 'IMAGE', properties: { headline: 'x' } }), { externalAdGroupId: '300000000101' })
    expect(refused.error).toBe('Amazon answered HTTP 400: 400 — Malformed request')
  })

  it('a create whose answer is lost is not sent again: the ad group is read back and its creative linked', async () => {
    const request = sdCreativeCreateRequest({ externalAdGroupId: '300000000101', creativeType: 'IMAGE', properties: { headline: 'Ride dry' } })
    let made = false
    h.route = (method) => {
      if (method === 'POST') { made = true; return { status: 502, json: { message: 'Bad gateway' } } }
      return { status: 200, json: made ? [{ creativeId: 400000000010, adGroupId: 300000000101, creativeType: 'IMAGE', properties: { headline: 'Ride dry' }, moderationStatus: 'PENDING_REVIEW' }] : [] }
    }
    expect(await sendSdCreativeWrite(CTX, request, { externalAdGroupId: '300000000101' })).toEqual({ ok: true, mode: 'live', creativeId: '400000000010', error: null, recoveredByReadBack: true })
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1)

    h.calls = []; made = false
    h.route = (method) => (method === 'POST' ? { status: 504, json: { message: 'Timeout' } } : { status: 200, json: [] })
    const lost = await sendSdCreativeWrite(CTX, request, { externalAdGroupId: '300000000101' })
    expect(lost.ok).toBe(false)
    expect(lost.error).toMatch(/^Amazon did not confirm the creative \(Amazon answered HTTP 504: .*\), and it is not on the ad group\. It was not sent again/)
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('sandbox sends nothing: a create gets a sandbox id, an update keeps its own', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    const created = await sendSdCreativeWrite(CTX, sdCreativeCreateRequest({ externalAdGroupId: '300000000101', creativeType: 'IMAGE', properties: { headline: 'x' } }), { externalAdGroupId: '300000000101' })
    expect(created).toMatchObject({ ok: true, mode: 'sandbox', creativeId: expect.stringMatching(/^sandbox-creative-/) })
    const updated = await sendSdCreativeWrite(CTX, sdCreativeUpdateRequest({ creativeId: '400000000001', creativeType: 'IMAGE', properties: { headline: 'x' } }), { externalAdGroupId: '300000000101' })
    expect(updated.creativeId).toBe('400000000001')
    expect(h.calls).toEqual([])
  })

  it('the preview asks for one slot and one product, and gives Amazon\'s HTML back', async () => {
    h.route = () => ({ status: 200, json: { previewHtml: '&lt;div&gt;ad&lt;/div&gt;' } })
    const shown = await previewSdCreative(CTX, { creativeType: 'IMAGE', properties: { headline: 'Ride dry', brandLogo: LOGO }, size: '728x90', asin: 'B0FXTEST01', isMobile: false, isOnAmazon: true })
    expect(shown).toEqual({ previewHtml: '&lt;div&gt;ad&lt;/div&gt;', previewHtmls: [] })
    expect(h.calls[0].body).toEqual({
      creative: { creativeType: 'IMAGE', properties: { headline: 'Ride dry', brandLogo: LOGO } },
      previewConfiguration: { size: { width: 728, height: 90 }, products: [{ asin: 'B0FXTEST01' }], isMobile: false, isOnAmazon: true },
    })
  })

  it('a thrown Ads error is said with Amazon\'s code and words', () => {
    expect(sdAmazonErrorWords(Object.assign(new Error('x'), { statusCode: 422, body: JSON.stringify({ code: 'UNPROCESSABLE', description: 'Asset is not active' }) }))).toBe('Amazon answered HTTP 422: UNPROCESSABLE — Asset is not active')
    expect(sdAmazonErrorWords(Object.assign(new Error('x'), { statusCode: 500, body: 'oops' }))).toBe('Amazon answered HTTP 500: oops')
  })
})

describe('the asset library', () => {
  const ASSET = {
    assetId: 'amzn1.assetlibrary.asset1.testlogo0001', version: 'version_v1', name: 'Test logo', assetType: 'IMAGE', assetSubTypes: ['LOGO'], status: 'ACTIVE',
    fileMetadata: { width: 1200, height: 200, fileSize: 40_000, contentType: 'image/png', extension: 'png' }, creationTime: 1_760_000_000_000, tags: ['nexus'],
    storageLocationUrls: { defaultUrl: 'https://m.media-amazon.com/images/S/test.png' },
  }

  it('searches newest first with the type and sub-type filters, and pages by Amazon\'s token', async () => {
    expect(adsAssetSearchBody({ text: 'logo', assetType: 'IMAGE', subTypes: ['LOGO'], pageSize: 25, token: 'T2' })).toEqual({
      text: 'logo', filterCriteria: { valueFilters: [{ valueField: 'ASSET_TYPE', values: ['IMAGE'] }, { valueField: 'ASSET_SUB_TYPE', values: ['LOGO'] }] },
      sortCriteria: { field: 'CREATED_TIME', order: 'DESC' }, pageCriteria: { size: 25, identifier: { token: 'T2' } },
    })
    h.route = () => ({ status: 200, json: { totalRecords: 1, assetList: [ASSET], token: 'T3' } })
    const page = await searchAdsAssets(CTX, { assetType: 'IMAGE', pageSize: 10 })
    expect(page).toEqual({ total: 1, token: 'T3', assets: [expect.objectContaining({ assetId: ASSET.assetId, version: 'version_v1', width: 1200, height: 200, bytes: 40_000, url: 'https://m.media-amazon.com/images/S/test.png', createdAt: new Date(1_760_000_000_000).toISOString() })] })
    expect(h.calls[0].headers.Accept).toBe('application/vnd.creativeassetssearchassetsresponse.v3+json')
  })

  it('reads one asset: the version asked for, else its newest', async () => {
    h.route = () => ({ status: 200, json: {
      assetGlobal: { assetId: ASSET.assetId, assetType: 'IMAGE' },
      assetVersionList: [
        { assetIdentifier: { assetId: ASSET.assetId, version: 'version_v1' }, creationTime: 1_700_000_000_000, assetStatus: 'ACTIVE', fileMetadata: { width: 600, height: 100 } },
        { assetIdentifier: { assetId: ASSET.assetId, version: 'version_v2' }, creationTime: 1_760_000_000_000, assetStatus: 'ACTIVE', fileMetadata: { width: 1200, height: 200 }, url: 'https://x.s3.amazonaws.com/a.png?X-Amz-Signature=secret' },
      ],
    } })
    const newest = await getAdsAsset(CTX, ASSET.assetId)
    expect(newest).toMatchObject({ asset: { version: 'version_v2', assetType: 'IMAGE', width: 1200, url: null }, versions: ['version_v1', 'version_v2'] })
    expect((await getAdsAsset(CTX, ASSET.assetId, 'version_v1'))?.asset.width).toBe(600)
    expect(new URL(h.calls[1].url).searchParams.get('version')).toBe('version_v1')
  })

  it('uploads an image: an upload location, the file to Amazon\'s storage, the registration as the sub-type asked', async () => {
    const bytes = Buffer.from('png-bytes')
    h.route = (method, url) => {
      if (url.endsWith('/assets/upload')) return { status: 200, json: { url: 'https://test-bucket.s3.amazonaws.com/upload.png?X-Amz-Signature=fake' } }
      if (url.endsWith('/assets/register')) return { status: 200, json: { assetId: 'amzn1.assetlibrary.asset1.testupload01', versionId: 'version_v1', failedSpecChecks: [{ specProgramName: 'SPONSORED_DISPLAY', specifications: [{ isPassed: false, failureReason: 'Image too small', actualValue: '500' }] }] } }
      return { status: method === 'PUT' ? 200 : 404, json: null }
    }
    const done = await uploadAdsImageAsset(CTX, { fileName: 'nexus_logo_abc.png', name: 'Nexus logo', subType: 'LOGO', bytes, mimeType: 'image/png', tags: ['nexus'] })
    expect(done).toEqual({ mode: 'live', assetId: 'amzn1.assetlibrary.asset1.testupload01', versionId: 'version_v1', failedSpecChecks: ['SPONSORED_DISPLAY: Image too small: (it is 500)'] })
    expect(h.calls.map((c) => [c.method, new URL(c.url).host, new URL(c.url).pathname])).toEqual([
      ['POST', 'advertising-api-eu.amazon.com', '/assets/upload'],
      ['PUT', 'test-bucket.s3.amazonaws.com', '/upload.png'],
      ['POST', 'advertising-api-eu.amazon.com', '/assets/register'],
    ])
    expect(h.calls[0].body).toEqual({ fileName: 'nexus_logo_abc.png' })
    expect(h.calls[1].headers['Content-Type']).toBe('image/png')
    expect(h.calls[2].body).toEqual(adsAssetRegisterBody('https://test-bucket.s3.amazonaws.com/upload.png?X-Amz-Signature=fake', { name: 'Nexus logo', subType: 'LOGO', tags: ['nexus'] }))
    expect(h.calls[2].body).toMatchObject({ assetType: 'IMAGE', assetSubTypeList: ['LOGO'], skipAssetSubTypesDetection: true })
  })

  it('sends no file to an upload address outside Amazon\'s storage, and registers nothing', async () => {
    h.route = (_m, url) => (url.endsWith('/assets/upload') ? { status: 200, json: { url: 'https://example.com/upload.png' } } : { status: 200, json: {} })
    await expect(uploadAdsImageAsset(CTX, { fileName: 'nexus_logo_abc.png', name: 'x', subType: 'LOGO', bytes: Buffer.from('x'), mimeType: 'image/png' })).rejects.toThrow(/outside its storage; Nexus sends no file there/)
    expect(h.calls.map((c) => new URL(c.url).pathname)).toEqual(['/assets/upload'])
  })
})

describe('the rules Nexus checks before it asks', () => {
  it('headline: empty, longer than 50, a forbidden character, an emoji, more than half capitals', () => {
    expect(sdHeadlineProblem('Ride dry all winter')).toBeNull()
    expect(sdHeadlineProblem('  ')).toMatch(/cannot be empty/)
    expect(sdHeadlineProblem('x'.repeat(51))).toBe('the headline is 51 characters; Amazon takes at most 50')
    expect(sdHeadlineProblem('Ride dry!')).toMatch(/"!"/)
    expect(sdHeadlineProblem('Ride dry 🏍')).toMatch(/emoji/)
    expect(sdHeadlineProblem('RIDE DRY ALL WINTER')).toMatch(/capitals/)
    expect(sdHeadlineProblem('RIDE DRY')).toBeNull()
  })

  it('creative type: no video in an IMAGE ad group, a video in a VIDEO one; one custom image in both crops', () => {
    expect(sdPropertiesProblem({ headline: 'Ride dry' }, 'IMAGE')).toBeNull()
    expect(sdPropertiesProblem({ video: IMAGE }, 'IMAGE')).toMatch(/creative type is IMAGE/)
    expect(sdPropertiesProblem({ headline: 'Ride dry' }, 'VIDEO')).toMatch(/creative type is VIDEO: Amazon needs a video/)
    expect(sdPropertiesProblem({ video: IMAGE }, 'VIDEO')).toBeNull()
    expect(sdPropertiesProblem({ rectCustomImage: IMAGE }, 'IMAGE')).toMatch(/two crops together/)
    expect(sdPropertiesProblem({ rectCustomImage: IMAGE, squareCustomImage: { ...IMAGE, assetVersion: 'version_v1' } }, 'IMAGE')).toMatch(/same asset and version/)
    expect(sdPropertiesProblem({}, 'IMAGE')).toMatch(/at least one/)
  })

  it('assets: a logo\'s and a custom image\'s file limits, and each crop inside the image and over its minimum', () => {
    const asset = { assetId: 'a', version: 'v', assetType: 'IMAGE', status: 'ACTIVE', width: 1200, height: 628, bytes: 900_000, contentType: 'image/png', extension: null }
    const use = (kind: 'logo' | 'rect' | 'square', crop: { top: number; left: number; width: number; height: number } | null) => ({ place: kind, kind, assetId: 'a', assetVersion: 'v', crop })
    expect(sdAssetUseProblem(use('logo', null), asset)).toBeNull()
    expect(sdAssetUseProblem(use('logo', null), { ...asset, bytes: 2_000_000 })).toMatch(/at most 1\.0 MB/)
    expect(sdAssetUseProblem(use('logo', null), { ...asset, width: 500 })).toMatch(/at least 600 × 100/)
    expect(sdAssetUseProblem(use('logo', null), { ...asset, assetType: 'VIDEO' })).toMatch(/is a video, not an image/)
    expect(sdAssetUseProblem(use('logo', null), { ...asset, status: 'PROCESSING' })).toMatch(/still processing/)
    expect(sdAssetUseProblem(use('rect', { top: 0, left: 0, width: 1200, height: 628 }), asset)).toBeNull()
    expect(sdAssetUseProblem(use('rect', { top: 10, left: 0, width: 1200, height: 628 }), asset)).toMatch(/reaches outside the image/)
    expect(sdAssetUseProblem(use('square', { top: 0, left: 0, width: 600, height: 600 }), asset)).toMatch(/at least 628 × 628/)
  })

  it('the default crops are the largest centred ones in the shape Amazon shows', () => {
    expect(sdDefaultCrop({ width: 2400, height: 1600 }, { minWidth: 1200, minHeight: 628 })).toEqual({ left: 0, top: 172, width: 2400, height: 1256 })
    expect(sdDefaultCrop({ width: 2400, height: 1600 }, { minWidth: 628, minHeight: 628 })).toEqual({ left: 400, top: 0, width: 1600, height: 1600 })
    expect(sdDefaultCrop({ width: null, height: null }, { minWidth: 628, minHeight: 628 })).toBeNull()
  })

  it('says a creative and its moderation in words', () => {
    expect(sdPropertiesWords({ headline: 'Ride dry', brandLogo: LOGO })).toEqual({ headline: '"Ride dry"', brandLogo: 'asset amzn1.assetlibrary.asset1.testlogo0001 (version_v1, crop 600 × 100 at 0,0)', customImage: null, video: null })
    expect(sdModerationWords('PENDING_REVIEW', '2026-10-21T10:00:00Z')).toBe('in review at Amazon (expected by 2026-10-21T10:00:00Z): it cannot be changed until Amazon approves or rejects it')
    expect(sdModerationWords('APPROVED')).toMatch(/^approved/)
    expect(sdModerationWords('REJECTED')).toMatch(/^rejected by Amazon/)
  })
})
