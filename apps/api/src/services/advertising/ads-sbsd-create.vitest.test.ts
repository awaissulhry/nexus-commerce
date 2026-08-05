/**
 * ACR Stage 5 — SD and SB create payload shapes.
 *
 * These assertions are transcribed from this account's OWN live entities, captured raw by
 * `scripts/_acr5-sbsd-shapes.mts` (15 SD + 4 SB campaigns on Amazon). They exist because the
 * three ad products disagree on date format, enum casing and id type, and every one of those
 * disagreements is silent: Amazon answers 200 with an empty success array rather than an error.
 *
 * The single most valuable line here is the SD startDate one. SD wants YYYYMMDD; SP and SB both
 * want YYYY-MM-DD. Writing that from memory produces a create that looks fine and does nothing.
 */
import { describe, it, expect } from 'vitest'
import { createSdCampaign, createSdAdGroup, createSbCampaign, createSdProductAd, createSbAdGroup, createSbKeyword } from './ads-api-client.js'

const CTX = { profileId: 'test-profile', region: 'EU' as const }
const AT = new Date(Date.UTC(2026, 7, 5, 12, 0, 0)) // 2026-08-05

const sent = (r: { rawResponse: unknown }) =>
  (r.rawResponse as { wouldSend: { method: string; path: string; body: unknown } }).wouldSend

describe('SD campaign create — legacy JSON, lowercase, YYYYMMDD', () => {
  it('builds the body Amazon actually accepts', async () => {
    const r = await createSdCampaign(CTX, { name: 'GALE Display IT', dailyBudget: 30, startDate: AT, dryRun: true })
    const w = sent(r)
    expect(w.method).toBe('POST')
    expect(w.path).toBe('/sd/campaigns')
    // A BARE ARRAY — not { campaigns: [...] } like SP and SB.
    expect(Array.isArray(w.body)).toBe(true)
    expect((w.body as unknown[])[0]).toEqual({
      name: 'GALE Display IT',
      budgetType: 'daily',   // lowercase, unlike SB's "DAILY"
      budget: 30,
      costType: 'cpc',
      startDate: '20260805', // NOT 2026-08-05 — the trap this test exists for
      state: 'paused',       // lowercase, and PAUSED by default
      tactic: 'T00020',
    })
  })

  it('is born PAUSED unless explicitly enabled', async () => {
    const off = sent(await createSdCampaign(CTX, { name: 'x', dailyBudget: 1, dryRun: true }))
    const on = sent(await createSdCampaign(CTX, { name: 'x', dailyBudget: 1, state: 'enabled', dryRun: true }))
    expect((off.body as Array<{ state: string }>)[0].state).toBe('paused')
    expect((on.body as Array<{ state: string }>)[0].state).toBe('enabled')
  })

  it('sends portfolioId as a NUMBER, matching SD\'s numeric ids', async () => {
    const w = sent(await createSdCampaign(CTX, { name: 'x', dailyBudget: 1, portfolioId: '12345', dryRun: true }))
    expect((w.body as Array<{ portfolioId: unknown }>)[0].portfolioId).toBe(12345)
  })

  it('omits portfolioId entirely when absent — an explicit null means "un-portfolio"', async () => {
    const w = sent(await createSdCampaign(CTX, { name: 'x', dailyBudget: 1, dryRun: true }))
    expect('portfolioId' in (w.body as Array<Record<string, unknown>>)[0]).toBe(false)
  })
})

describe('SD ad group create', () => {
  it('carries tactic and creativeType, and a NUMERIC campaignId', async () => {
    const w = sent(await createSdAdGroup(CTX, { externalCampaignId: '292043476568515', name: 'CONTEXTUAL ONLY', defaultBid: 0.5, dryRun: true }))
    expect(w.path).toBe('/sd/adGroups')
    expect((w.body as Array<Record<string, unknown>>)[0]).toEqual({
      campaignId: 292043476568515, // number, not the string we store locally
      name: 'CONTEXTUAL ONLY',
      defaultBid: 0.5,
      state: 'paused',
      tactic: 'T00020',
      bidOptimization: 'conversions',
      creativeType: 'IMAGE',
    })
  })
})

describe('SD product ad create', () => {
  it('carries numeric campaign/adGroup ids and both identifiers', async () => {
    const w = sent(await createSdProductAd(CTX, {
      externalCampaignId: '543917214584094', externalAdGroupId: '307064886584043',
      sku: 'MISANO-JACKET-3XL-BLACK', asin: 'B0CFYQQFT9', dryRun: true,
    }))
    expect(w.path).toBe('/sd/productAds')
    expect((w.body as Array<Record<string, unknown>>)[0]).toEqual({
      campaignId: 543917214584094,
      adGroupId: 307064886584043,
      sku: 'MISANO-JACKET-3XL-BLACK',
      asin: 'B0CFYQQFT9',
      state: 'paused',
    })
  })

  it('accepts an ASIN alone — SD does not require a seller SKU the way SP does', async () => {
    const w = sent(await createSdProductAd(CTX, { externalCampaignId: '1', externalAdGroupId: '2', asin: 'B0CFYQQFT9', dryRun: true }))
    const row = (w.body as Array<Record<string, unknown>>)[0]
    expect(row.asin).toBe('B0CFYQQFT9')
    expect('sku' in row).toBe(false)
  })
})

describe('SB campaign create — v4, UPPERCASE, ISO dates', () => {
  it('builds the body Amazon actually accepts', async () => {
    const w = sent(await createSbCampaign(CTX, {
      name: 'MISANO Brand IT', dailyBudget: 15, brandEntityId: 'ENTITY3LAY8CBA0R3XI', startDate: AT, dryRun: true,
    }))
    expect(w.path).toBe('/sb/v4/campaigns')
    const body = w.body as { campaigns: Array<Record<string, unknown>> }
    // Wrapped in { campaigns: [...] } — unlike SD's bare array.
    expect(Array.isArray(body.campaigns)).toBe(true)
    expect(body.campaigns[0]).toEqual({
      name: 'MISANO Brand IT',
      budgetType: 'DAILY',      // UPPERCASE, unlike SD's "daily"
      budget: 15,
      costType: 'CPC',
      startDate: '2026-08-05',  // ISO, unlike SD's 20260805
      state: 'PAUSED',
      brandEntityId: 'ENTITY3LAY8CBA0R3XI',
      goal: 'PAGE_VISIT',
      kpi: 'CLICKS',
      isMultiAdGroupsEnabled: true,
      bidding: { bidOptimization: false },
    })
  })

  it('keeps portfolioId a STRING — SB ids are strings where SD ids are numbers', async () => {
    const w = sent(await createSbCampaign(CTX, { name: 'x', dailyBudget: 1, brandEntityId: 'E1', portfolioId: '12345', dryRun: true }))
    expect((w.body as { campaigns: Array<{ portfolioId: unknown }> }).campaigns[0].portfolioId).toBe('12345')
  })
})

describe('SB ad group create — the fourth /sp/* trap', () => {
  it('posts to /sb/v4/adGroups with STRING ids and UPPERCASE state', async () => {
    const w = sent(await createSbAdGroup(CTX, { externalCampaignId: '484743497652875', name: 'Broad Only', dryRun: true }))
    expect(w.path).toBe('/sb/v4/adGroups')
    expect((w.body as { adGroups: Array<Record<string, unknown>> }).adGroups[0]).toEqual({
      name: 'Broad Only',
      campaignId: '484743497652875', // STRING — SD's equivalent is a number
      state: 'PAUSED',
    })
  })

  it('sends NO defaultBid — the SB ad group resource has no such field', async () => {
    // SB bids at the target level. The 5 live SB ad groups return only
    // {adGroupId, campaignId, name, state}; sending a bid invents a field.
    const w = sent(await createSbAdGroup(CTX, { externalCampaignId: '1', name: 'x', dryRun: true }))
    const row = (w.body as { adGroups: Array<Record<string, unknown>> }).adGroups[0]
    expect('defaultBid' in row).toBe(false)
  })

  it('disagrees with the SD ad group on every convention it shares a purpose with', async () => {
    const sb = sent(await createSbAdGroup(CTX, { externalCampaignId: '123', name: 'same', dryRun: true }))
    const sd = sent(await createSdAdGroup(CTX, { externalCampaignId: '123', name: 'same', defaultBid: 0.5, dryRun: true }))
    const sbRow = (sb.body as { adGroups: Array<Record<string, unknown>> }).adGroups[0]
    const sdRow = (sd.body as Array<Record<string, unknown>>)[0]
    expect(sbRow.campaignId).toBe('123')   // string
    expect(sdRow.campaignId).toBe(123)     // number
    expect(sbRow.state).toBe('PAUSED')
    expect(sdRow.state).toBe('paused')
    expect(Array.isArray(sd.body)).toBe(true)          // bare array
    expect(Array.isArray(sb.body)).toBe(false)         // { adGroups: [...] }
  })
})

describe('SB keywords — the LEGACY v3 API, not v4', () => {
  it('posts to /sb/keywords with numeric ids and a LOWERCASE match type', async () => {
    const w = sent(await createSbKeyword(CTX, {
      externalCampaignId: '484743497652875', externalAdGroupId: '451325355136482',
      keywordText: 'giacca pelle uomo', matchType: 'EXACT', bid: 1.67, dryRun: true,
    }))
    expect(w.path).toBe('/sb/keywords')       // NOT /sb/v4/keywords — that path 403s
    expect(Array.isArray(w.body)).toBe(true)  // bare array, the SD legacy convention
    expect((w.body as Array<Record<string, unknown>>)[0]).toEqual({
      campaignId: 484743497652875,
      adGroupId: 451325355136482,
      keywordText: 'giacca pelle uomo',
      matchType: 'exact', // lowercase, where SP v3 sends EXACT
      state: 'enabled',
      bid: 1.67,
    })
  })

  it('lowercases every match type SP sends in caps', async () => {
    for (const m of ['EXACT', 'PHRASE', 'BROAD'] as const) {
      const w = sent(await createSbKeyword(CTX, { externalCampaignId: '1', externalAdGroupId: '2', keywordText: 'k', matchType: m, bid: 1, dryRun: true }))
      expect((w.body as Array<{ matchType: string }>)[0].matchType).toBe(m.toLowerCase())
    }
  })
})

describe('the two families never share a convention', () => {
  it('SD and SB disagree on date format and casing for the SAME logical campaign', async () => {
    const sd = sent(await createSdCampaign(CTX, { name: 'same', dailyBudget: 20, startDate: AT, dryRun: true }))
    const sb = sent(await createSbCampaign(CTX, { name: 'same', dailyBudget: 20, brandEntityId: 'E1', startDate: AT, dryRun: true }))
    const sdRow = (sd.body as Array<Record<string, string>>)[0]
    const sbRow = (sb.body as { campaigns: Array<Record<string, string>> }).campaigns[0]
    expect(sdRow.startDate).not.toBe(sbRow.startDate)
    expect(sdRow.state).toBe('paused')
    expect(sbRow.state).toBe('PAUSED')
  })

  it('a dry run never reaches Amazon — no credentials are required to build a payload', async () => {
    // If this ever starts making a network call it will throw on the missing connection,
    // which is precisely the regression worth catching: dry-run must stay free and offline.
    await expect(createSdCampaign(CTX, { name: 'x', dailyBudget: 1, dryRun: true })).resolves.toMatchObject({ mode: 'dry-run', externalId: null })
    await expect(createSbCampaign(CTX, { name: 'x', dailyBudget: 1, brandEntityId: 'E1', dryRun: true })).resolves.toMatchObject({ mode: 'dry-run', externalId: null })
  })
})
