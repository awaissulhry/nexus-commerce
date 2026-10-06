import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

// 5f — the live describe at the bottom drives updateTarget through the REAL liveCall and the REAL
// channel gateway with `fetch` stubbed (the pattern of gateway/ads.p12.vitest.test.ts). These stand
// in only for the gateway's database touches and the account/token lookups; the sandbox tests
// above short-circuit before any of them.
const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
// 5a — the wire's negation policy reads the protected terms, the campaign behind an Amazon id and the text Nexus holds
// for a negative id. Every negative id these tests re-enable is held, and nothing is protected unless a test says so.
const db = vi.hoisted(() => ({
  protections: [] as Array<{ term: string; matchType: string | null; isPrefix: boolean; reason: string | null }>,
  target: { expressionValue: 'giacca pelle', expressionType: 'NEGATIVE_EXACT', adGroup: { campaign: { id: 'c-1', marketplace: 'IT' } } } as unknown,
}))
vi.mock('../../db.js', () => ({
  default: {
    adKeywordProtection: { findMany: async () => db.protections },
    // W1-7 — no ads strategy anywhere: no product is protected, so only the protected terms refuse.
    adsStrategy: { findMany: async () => [] },
    campaign: { findFirst: async () => ({ id: 'c-1', marketplace: 'IT' }) },
    adTarget: { findFirst: async () => db.target },
  },
}))
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../lib/workspace-context.js', async (original) => ({ ...(await original<object>()), requireWorkspace: () => ({ workspaceId: 'ws' }) }))
vi.mock('../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from '../gateway/rate.js'
import { archiveSpEntity, createNegativeKeyword, createNegativeProductTarget, liveCall, v3BatchResult, updateCampaign, updatePortfolio, updateTarget, type SpArchiveEntity } from './ads-api-client.js'
import { NegativeRefusedError } from './ads-negation-policy.js'

// A3 — the v3 batch-response parser must be CONSERVATIVE: flip to failure only on a recognized
// non-empty error[], and treat any unknown/!2xx-handled shape as ok (no false failures).
describe('v3BatchResult (A3 — 2xx-with-error-body detection)', () => {
  it('non-empty error[] → ok:false with a message', () => {
    const r = v3BatchResult({ keywords: { success: [], error: [{ index: 0, errors: [{ errorType: 'BID_TOO_LOW' }] }] } }, 'keywords')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/amazon_rejected/)
    expect(r.error).toMatch(/BID_TOO_LOW/)
  })
  it('success-only response → ok', () => {
    expect(v3BatchResult({ keywords: { success: [{ index: 0, keywordId: '123' }], error: [] } }, 'keywords')).toEqual({ ok: true, error: null })
  })
  it('empty error[] → ok', () => {
    expect(v3BatchResult({ adGroups: { error: [] } }, 'adGroups').ok).toBe(true)
  })
  it('unrecognized / missing block → ok (no false failure)', () => {
    expect(v3BatchResult({ somethingElse: true }, 'keywords').ok).toBe(true)
    expect(v3BatchResult(null, 'keywords').ok).toBe(true)
    expect(v3BatchResult({}, 'campaigns').ok).toBe(true)
    expect(v3BatchResult({ sandbox: true, patch: {} }, 'keywords').ok).toBe(true)
  })
  it('wrong resource key → ok (only inspects the named resource)', () => {
    expect(v3BatchResult({ keywords: { error: [{ x: 1 }] } }, 'adGroups').ok).toBe(true)
  })
})

// ── DL.1 — a target's bid/state update must reach the endpoint that owns its id ──────────────
//
// updateTarget used to PUT /sp/keywords for EVERY AdTarget. A product or auto target's external id
// is a `targetId` under /sp/targets, so Amazon rejected those writes with entityNotFoundError at
// "$.keywords[0].keywordId" — permanently, and silently, while the engine reported success.
// Measured live: 413 keyword writes APPLIED, all 27 product/auto targets FAILED with zero successes.
//
// Sandbox short-circuits before any HTTP, and reports the route it WOULD have taken, so routing is
// assertable without touching Amazon.
describe('DL.1 updateTarget routing by target kind', () => {
  const ctx = { profileId: 'p1', region: 'EU' as const }
  const route = async (kind: string | null | undefined) => {
    const r = await updateTarget(ctx, 'ext-1', { bid: 0.42 }, kind)
    return (r.rawResponse as { route?: string }).route
  }

  it('sends PRODUCT targets to /sp/targets', async () => {
    expect(await route('PRODUCT')).toBe('targets')
  })
  it('sends AUTO targets to /sp/targets', async () => {
    expect(await route('AUTO')).toBe('targets')
  })
  it('sends KEYWORD targets to /sp/keywords, exactly as before', async () => {
    expect(await route('KEYWORD')).toBe('keywords')
  })
  it('is case-insensitive about the kind', async () => {
    expect(await route('product')).toBe('targets')
    expect(await route('auto')).toBe('targets')
  })
  // The fallback matters: an absent kind must behave the way it always did, so this change can
  // never introduce a NEW failure for a shape we did not anticipate.
  it('falls back to the keyword path when the kind is unknown, null or omitted', async () => {
    expect(await route(null)).toBe('keywords')
    expect(await route(undefined)).toBe('keywords')
    expect(await route('SOMETHING_NEW')).toBe('keywords')
    expect(await route('')).toBe('keywords')
  })
})

// ── NEG.3 — the same bug, one entity class over, caught before it ever fired ─────────────────
//
// A NEGATIVE keyword is also `kind = 'KEYWORD'`, so DL.1's fix routed it to /sp/keywords — where
// its id is not a keywordId. Its id lives under /sp/negativeKeywords (ad group) or
// /sp/campaignNegativeKeywords (campaign), which is where `ads-negative-kw.service.ts:61-65`
// creates it.
//
// Measured on prod 2026-08-12 before the fix: 0 of the 23 `AD_ENTITY_STATE_UPDATE` logs are on a
// negative and 0 negatives have ever been enqueued for an outbound write. That is the ONLY reason
// `orphanedAt` is still 0 across all 2,059 — the first archive would have sprung it.
describe('NEG.3 updateTarget routing for NEGATIVE targets', () => {
  const ctx = { profileId: 'p1', region: 'EU' as const }
  const route = async (r: Parameters<typeof updateTarget>[3]) =>
    ((await updateTarget(ctx, 'ext-1', { state: 'archived' }, r)).rawResponse as { route?: string }).route

  it('🔴 an ad-group negative keyword goes to /sp/negativeKeywords, NOT /sp/keywords', async () => {
    expect(await route({ kind: 'KEYWORD', isNegative: true, negativeLevel: 'AD_GROUP' })).toBe('negativeKeywords')
  })
  it('🔴 a campaign negative keyword goes to /sp/campaignNegativeKeywords', async () => {
    expect(await route({ kind: 'KEYWORD', isNegative: true, negativeLevel: 'CAMPAIGN' })).toBe('campaignNegativeKeywords')
  })
  it('a negative PRODUCT target goes to /sp/negativeTargets', async () => {
    expect(await route({ kind: 'PRODUCT', isNegative: true, negativeLevel: 'AD_GROUP' })).toBe('negativeTargets')
  })
  it('a negative with no level defaults to the ad-group endpoint, which is where 2,037 of them are', async () => {
    expect(await route({ kind: 'KEYWORD', isNegative: true })).toBe('negativeKeywords')
    expect(await route({ kind: 'KEYWORD', isNegative: true, negativeLevel: null })).toBe('negativeKeywords')
  })

  // The descriptor is additive. Every pre-NEG.3 caller passed a bare string and meant "positive";
  // all of those must be byte-identical, or this fix becomes a new failure mode for bid writes.
  it('a bare kind string still means POSITIVE and routes exactly as before', async () => {
    expect(await route('KEYWORD')).toBe('keywords')
    expect(await route('PRODUCT')).toBe('targets')
    expect(await route(null)).toBe('keywords')
    expect(await route(undefined)).toBe('keywords')
  })
  it('isNegative:false is explicitly the old behaviour, not a third state', async () => {
    expect(await route({ kind: 'KEYWORD', isNegative: false })).toBe('keywords')
    expect(await route({ kind: 'PRODUCT', isNegative: false })).toBe('targets')
    // 🔴 negativeLevel on a POSITIVE row must be ignored — the v1 sync sets negativeLevel null for
    // positives, but a stale or hand-written row must not be able to divert a bid write.
    expect(await route({ kind: 'KEYWORD', isNegative: false, negativeLevel: 'CAMPAIGN' })).toBe('keywords')
  })
})

// ── 5f — an ARCHIVE of a negative is SP v3 `POST {path}/delete`; the PUT does not accept ARCHIVED ──
//
// Every value in this fixture is copied from Amazon's Sponsored Products 3.0 OpenAPI document, read
// 2026-10-04 from `https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json`
// (the file advertising.amazon.com/API/docs/en-us/sponsored-products/3-0/openapi/prod loads):
//   - operationIds DeleteSponsoredProductsNegativeKeywords / …CampaignNegativeKeywords /
//     …NegativeTargetingClauses: `post` on the paths below, requestBody content = the mime below,
//     schema `{ <idFilter>: SponsoredProductsObjectIdFilter }` with `required: ["include"]`;
//   - 207 answer `{ <responseKey>: { success: [...], error: [{ index, errors }] } }`;
//   - the negative PUTs' state is `SponsoredProductsCreateOrUpdateEntityState`,
//     `enum: ["ENABLED","PAUSED","PROPOSED"]` — no ARCHIVED.
const SP_V3_NEGATIVE_DELETE = {
  adGroupKeyword: {
    route: { kind: 'KEYWORD', isNegative: true, negativeLevel: 'AD_GROUP' },
    path: '/sp/negativeKeywords/delete', mime: 'application/vnd.spNegativeKeyword.v3+json',
    idFilter: 'negativeKeywordIdFilter', responseKey: 'negativeKeywords',
  },
  campaignKeyword: {
    route: { kind: 'KEYWORD', isNegative: true, negativeLevel: 'CAMPAIGN' },
    path: '/sp/campaignNegativeKeywords/delete', mime: 'application/vnd.spCampaignNegativeKeyword.v3+json',
    idFilter: 'campaignNegativeKeywordIdFilter', responseKey: 'campaignNegativeKeywords',
  },
  adGroupProduct: {
    route: { kind: 'PRODUCT', isNegative: true, negativeLevel: 'AD_GROUP' },
    path: '/sp/negativeTargets/delete', mime: 'application/vnd.spNegativeTargetingClause.v3+json',
    idFilter: 'negativeTargetIdFilter', responseKey: 'negativeTargetingClauses',
  },
} as const

describe('5f updateTarget — archiving a negative uses the SP v3 delete operation (live, through the gateway)', () => {
  const ctx = { profileId: '123', region: 'EU' as const }

  beforeEach(() => {
    __rateTest.useMemory()
    h.calls = []; h.answers = []; gatewayLedger.length = 0
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      h.calls.push({ url: String(url), init })
      return h.answers.shift()?.() ?? new Response('{}', { status: 207 })
    }))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

  for (const [name, spec] of Object.entries(SP_V3_NEGATIVE_DELETE)) {
    it(`🔴 ${name}: archive → POST ${spec.path} with { ${spec.idFilter}: { include: [id] } }, through the gateway`, async () => {
      h.answers.push(() => new Response(JSON.stringify({ [spec.responseKey]: { success: [{ index: 0 }], error: [] } }), { status: 207 }))
      const r = await updateTarget(ctx, 'neg-9', { state: 'archived' }, spec.route)

      expect(r).toMatchObject({ ok: true, mode: 'live', error: null })
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0].url).toBe(`https://advertising-api-eu.amazon.com${spec.path}`)
      expect(h.calls[0].init.method).toBe('POST')
      expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ [spec.idFilter]: { include: ['neg-9'] } })
      expect(h.calls[0].init.headers).toMatchObject({ 'Content-Type': spec.mime, Accept: spec.mime, 'Amazon-Advertising-API-Scope': '123' })
      // The gateway sent it (one ledger row against the resolved account), as an action, not a read.
      expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS', connectionId: 'ads-1', outcome: 'sent', success: true })])
    })

    it(`${name}: a 207 with an error item is a failure, read from the "${spec.responseKey}" block`, async () => {
      h.answers.push(() => new Response(JSON.stringify({ [spec.responseKey]: { success: [], error: [{ index: 0, errors: [{ errorType: 'entityNotFoundError' }] }] } }), { status: 207 }))
      const r = await updateTarget(ctx, 'neg-9', { state: 'archived' }, spec.route)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/amazon_rejected/)
      expect(r.error).toMatch(/entityNotFoundError/)
    })
  }

  it('enable and pause of a negative stay PUT with the state (ENABLED / PAUSED are in the PUT enum)', async () => {
    await updateTarget(ctx, 'neg-9', { state: 'paused' }, SP_V3_NEGATIVE_DELETE.adGroupKeyword.route)
    await updateTarget(ctx, 'neg-9', { state: 'enabled' }, SP_V3_NEGATIVE_DELETE.campaignKeyword.route)
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, JSON.parse(String(c.init.body))])).toEqual([
      ['PUT', '/sp/negativeKeywords', { negativeKeywords: [{ keywordId: 'neg-9', state: 'PAUSED' }] }],
      ['PUT', '/sp/campaignNegativeKeywords', { campaignNegativeKeywords: [{ keywordId: 'neg-9', state: 'ENABLED' }] }],
    ])
  })

  it('a POSITIVE keyword or target archive is unchanged — still the PUT it always was', async () => {
    await updateTarget(ctx, 'kw-1', { state: 'archived' }, { kind: 'KEYWORD', isNegative: false })
    await updateTarget(ctx, 't-1', { state: 'archived' }, 'PRODUCT')
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname, JSON.parse(String(c.init.body))])).toEqual([
      ['PUT', '/sp/keywords', { keywords: [{ keywordId: 'kw-1', state: 'ARCHIVED' }] }],
      ['PUT', '/sp/targets', { targetingClauses: [{ targetId: 't-1', state: 'ARCHIVED' }] }],
    ])
  })
})

describe('5f updateTarget — sandbox says when a negative archive would be a delete', () => {
  const ctx = { profileId: 'p1', region: 'EU' as const }
  it('archive of a negative reports operation "delete"; a pause does not', async () => {
    const archive = (await updateTarget(ctx, 'ext-1', { state: 'archived' }, SP_V3_NEGATIVE_DELETE.adGroupProduct.route)).rawResponse
    const pause = (await updateTarget(ctx, 'ext-1', { state: 'paused' }, SP_V3_NEGATIVE_DELETE.adGroupProduct.route)).rawResponse
    expect(archive).toMatchObject({ sandbox: true, route: 'negativeTargets', operation: 'delete' })
    expect(pause).not.toHaveProperty('operation')
  })
})

// ── 5a — protected terms bind every negative at the wire, and in sandbox ─────────────────────────
const XAVIA = { term: 'xavia', matchType: 'CONTAINS', isPrefix: false, reason: 'brand' }

describe('5a liveCall — a negative that would block a protected term is never sent (live, through the gateway)', () => {
  const ctx = { profileId: '123', region: 'EU' as const }
  const kwBody = (keywordText: string, matchType = 'NEGATIVE_EXACT') => ({ campaignNegativeKeywords: [{ campaignId: 'EXT-1', keywordText, matchType, state: 'ENABLED' }] })

  beforeEach(() => {
    __rateTest.useMemory()
    h.calls = []; h.answers = []; gatewayLedger.length = 0
    db.protections = [XAVIA]
    db.target = { expressionValue: 'giacca pelle', expressionType: 'NEGATIVE_EXACT', adGroup: { campaign: { id: 'c-1', marketplace: 'IT' } } }
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      h.calls.push({ url: String(url), init })
      return h.answers.shift()?.() ?? new Response('{}', { status: 207 })
    }))
  })
  afterEach(() => { db.protections = []; vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

  it('🔴 POST /sp/campaignNegativeKeywords with a protected term (the createNegative call): refused, nothing sent, no gateway row', async () => {
    const err = await liveCall({ ...ctx, method: 'POST', path: '/sp/campaignNegativeKeywords', body: kwBody('giacca xavia') }).catch((e) => e)
    expect(err).toBeInstanceOf(NegativeRefusedError)
    expect(err.message).toBe('"giacca xavia" cannot be negated: it matches the protected term "xavia" (brand).')
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toHaveLength(0)
  })

  it('🔴 createNegativeKeyword (launches, bulk, bulk sheet, AI goals, blueprint, launch-repair) with a protected term: refused before Amazon', async () => {
    await expect(createNegativeKeyword(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', keywordText: 'Xavia Gale', matchType: 'PHRASE' }))
      .rejects.toThrow(/protected term "xavia"/)
    expect(h.calls).toHaveLength(0)
  })

  it('🔴 re-enabling a negative whose text is protected: refused; a pause still goes out', async () => {
    db.target = { expressionValue: 'xavia', expressionType: 'NEGATIVE_EXACT', adGroup: { campaign: { id: 'c-1', marketplace: 'IT' } } }
    await expect(updateTarget(ctx, 'neg-9', { state: 'enabled' }, { kind: 'KEYWORD', isNegative: true, negativeLevel: 'AD_GROUP' }))
      .rejects.toThrow(/^Not re-enabled: "xavia" cannot be negated/)
    expect(h.calls).toHaveLength(0)
    await updateTarget(ctx, 'neg-9', { state: 'paused' }, { kind: 'KEYWORD', isNegative: true, negativeLevel: 'AD_GROUP' })
    expect(h.calls).toHaveLength(1)
  })

  it('a negative over Amazon\'s text limits is refused with a sentence; an unprotected one within them is sent', async () => {
    await expect(createNegativeKeyword(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', keywordText: 'giacca moto donna estiva rete', matchType: 'PHRASE' }))
      .rejects.toThrow(/has 5 words; Amazon accepts at most 4 in a negative phrase keyword/)
    expect(h.calls).toHaveLength(0)
    h.answers.push(() => new Response(JSON.stringify({ negativeKeywords: { success: [{ negativeKeywordId: 'nk-1', index: 0 }], error: [] } }), { status: 207 }))
    const r = await createNegativeKeyword(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', keywordText: 'giacca pelle', matchType: 'EXACT' })
    expect(r).toMatchObject({ ok: true, mode: 'live', externalId: 'nk-1' })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['POST', '/sp/negativeKeywords']])
  })
})

describe('5a sandbox — the negative creators refuse what liveCall would refuse', () => {
  const ctx = { profileId: 'p1', region: 'EU' as const }
  beforeEach(() => { db.protections = [XAVIA, { term: 'B07XJ8C8F5', matchType: 'EXACT', isPrefix: false, reason: null }] })
  afterEach(() => { db.protections = [] })

  it('createNegativeKeyword: a protected term throws; an unprotected one gets its sandbox id', async () => {
    await expect(createNegativeKeyword(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', keywordText: 'casco xavia', matchType: 'EXACT' }))
      .rejects.toBeInstanceOf(NegativeRefusedError)
    expect(await createNegativeKeyword(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', keywordText: 'casco', matchType: 'EXACT' }))
      .toMatchObject({ ok: true, mode: 'sandbox', externalId: expect.stringMatching(/^sb-nkw-/) })
  })

  it('createNegativeProductTarget: a protected ASIN throws; another gets its sandbox id', async () => {
    await expect(createNegativeProductTarget(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', asin: 'B07XJ8C8F5' }))
      .rejects.toThrow(/protected term "b07xj8c8f5"/)
    expect(await createNegativeProductTarget(ctx, { externalCampaignId: 'EXT-1', externalAdGroupId: 'EXT-G', asin: 'B000000001' }))
      .toMatchObject({ ok: true, mode: 'sandbox', externalId: expect.stringMatching(/^sb-ntgt-/) })
  })
})

// ── 1a — what a campaign-manager edit puts on the wire (live, through the gateway) ──────────────────
describe('1a updateCampaign / updatePortfolio on the wire', () => {
  const ctx = { profileId: '123', region: 'EU' as const }
  beforeEach(() => {
    __rateTest.useMemory()
    h.calls = []; h.answers = []; gatewayLedger.length = 0
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      h.calls.push({ url: String(url), init })
      return h.answers.shift()?.() ?? new Response('{}', { status: 207 })
    }))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

  it('CM-1/2/3: strategy with the lanes, a cleared end date and a cleared portfolio are all in the PUT body', async () => {
    h.answers.push(() => new Response(JSON.stringify({ campaigns: { success: [{ index: 0, campaignId: 'c-1' }], error: [] } }), { status: 207 }))
    const r = await updateCampaign(ctx, 'c-1', {
      biddingStrategy: 'autoForSales', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 35 }], endDate: null, portfolioId: null,
    })
    expect(r).toMatchObject({ ok: true, mode: 'live', error: null })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['PUT', '/sp/campaigns']])
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ campaigns: [{
      campaignId: 'c-1', portfolioId: null, endDate: null,
      dynamicBidding: { strategy: 'AUTO_FOR_SALES', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 35 }] },
    }] })
  })

  it('CM-23: a portfolio Amazon refuses (207 with portfolios.error[]) is a failure with Amazon\'s reason', async () => {
    h.answers.push(() => new Response(JSON.stringify({ portfolios: { success: [], error: [{ index: 0, errors: [{ errorType: 'DUPLICATE_VALUE' }] }] } }), { status: 207 }))
    const r = await updatePortfolio(ctx, { portfolioId: 'pf-1', name: 'Core' })
    expect(h.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([['PUT', '/portfolios']])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/amazon_rejected/)
    expect(r.error).toMatch(/DUPLICATE_VALUE/)
  })

  it('CM-23: a portfolio Amazon accepts is ok', async () => {
    h.answers.push(() => new Response(JSON.stringify({ portfolios: { success: [{ index: 0, portfolioId: 'pf-1' }], error: [] } }), { status: 207 }))
    expect(await updatePortfolio(ctx, { portfolioId: 'pf-1', name: 'Core' })).toMatchObject({ ok: true, mode: 'live', error: null })
  })
})

// ── AA-W2-13 — an ARCHIVE of a campaign, ad group, keyword, target or product ad is SP v3 `POST {path}/delete` ──────
//
// Every value below is copied from Amazon's Sponsored Products 3.0 OpenAPI document (the file 5f read), read again
// 2026-10-06: operationIds DeleteSponsoredProducts{Campaigns,AdGroups,Keywords,TargetingClauses,ProductAds}, `post` on
// the paths below, requestBody content = the mime below with `{ <idFilter>: { include } }` required, a 207 answer
// `{ <responseKey>: { success, error } }`; the PUTs' state is `["ENABLED","PAUSED","PROPOSED"]` — no ARCHIVED.
const SP_V3_DELETE: Record<SpArchiveEntity, { path: string; mime: string; idFilter: string; responseKey: string }> = {
  campaign: { path: '/sp/campaigns/delete', mime: 'application/vnd.spCampaign.v3+json', idFilter: 'campaignIdFilter', responseKey: 'campaigns' },
  adGroup: { path: '/sp/adGroups/delete', mime: 'application/vnd.spAdGroup.v3+json', idFilter: 'adGroupIdFilter', responseKey: 'adGroups' },
  keyword: { path: '/sp/keywords/delete', mime: 'application/vnd.spKeyword.v3+json', idFilter: 'keywordIdFilter', responseKey: 'keywords' },
  target: { path: '/sp/targets/delete', mime: 'application/vnd.spTargetingClause.v3+json', idFilter: 'targetIdFilter', responseKey: 'targetingClauses' },
  productAd: { path: '/sp/productAds/delete', mime: 'application/vnd.spProductAd.v3+json', idFilter: 'adIdFilter', responseKey: 'productAds' },
}

describe('AA-W2-13 archiveSpEntity — an archive is the SP v3 delete operation (live, through the gateway)', () => {
  const ctx = { profileId: '123', region: 'EU' as const }
  beforeEach(() => {
    __rateTest.useMemory()
    h.calls = []; h.answers = []; gatewayLedger.length = 0
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off')
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      h.calls.push({ url: String(url), init })
      return h.answers.shift()?.() ?? new Response('{}', { status: 207 })
    }))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

  for (const [entity, spec] of Object.entries(SP_V3_DELETE) as Array<[SpArchiveEntity, (typeof SP_V3_DELETE)[SpArchiveEntity]]>) {
    it(`🔴 ${entity}: archive → POST ${spec.path} with { ${spec.idFilter}: { include: [id] } }, through the gateway`, async () => {
      h.answers.push(() => new Response(JSON.stringify({ [spec.responseKey]: { success: [{ index: 0 }], error: [] } }), { status: 207 }))
      const r = await archiveSpEntity(ctx, entity, 'ext-7')
      expect(r).toMatchObject({ ok: true, mode: 'live', error: null })
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0].url).toBe(`https://advertising-api-eu.amazon.com${spec.path}`)
      expect(h.calls[0].init.method).toBe('POST')
      expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ [spec.idFilter]: { include: ['ext-7'] } })
      expect(h.calls[0].init.headers).toMatchObject({ 'Content-Type': spec.mime, Accept: spec.mime, 'Amazon-Advertising-API-Scope': '123' })
      expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS', connectionId: 'ads-1', outcome: 'sent', success: true })])
    })

    it(`${entity}: a 207 with an error item is a failure, read from the "${spec.responseKey}" block`, async () => {
      h.answers.push(() => new Response(JSON.stringify({ [spec.responseKey]: { success: [], error: [{ index: 0, errors: [{ errorType: 'entityNotFoundError' }] }] } }), { status: 207 }))
      const r = await archiveSpEntity(ctx, entity, 'ext-7')
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/amazon_rejected.*entityNotFoundError/)
    })
  }

  it('sandbox: nothing is sent; it says it would be a delete', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'sandbox')
    expect((await archiveSpEntity(ctx, 'campaign', 'ext-7')).rawResponse).toMatchObject({ sandbox: true, operation: 'delete', route: '/sp/campaigns/delete' })
    expect(h.calls).toEqual([])
  })
})
