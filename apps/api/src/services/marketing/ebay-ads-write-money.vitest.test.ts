/**
 * The eBay ad write layer and money (PGlite, production schema; eBay's Marketing API replaced by recorders, so nothing
 * leaves the test):
 *
 *   currency   a budget or a bid is sent to eBay in its campaign's OWN marketplace currency — a GB campaign's in pounds,
 *              a DE one's in euros. Bids, ad group defaults and Priority budgets used to be sent in euros on every
 *              market, and a new campaign was stored as euros whatever its market.
 *   the gate   a write the marketing write gate refuses (its value cap) writes nothing — no eBay call, no Nexus row, no
 *              audit — in live AND in sandbox mode. The layer used to read only the gate's mode, so a refused write still
 *              ran in sandbox; and bids were judged as worth nothing, so the cap never bound a bid.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// eBay's Marketing API: every call recorded, none made.
const api = vi.hoisted(() => ({
  createCampaignApi: vi.fn(async (_token: string, payload: Record<string, any>) => `EXT-NEW-${payload.marketplaceId}`),
  createAdGroupApi: vi.fn(async (_token: string, _campaign: string, _body: Record<string, any>) => 'EXT-NEW-GROUP'),
  bulkCreateKeywordApi: vi.fn(async (_token: string, _campaign: string, items: Array<{ keywordText: string }>) => items.map((k, i) => ({ key: k.keywordText, ok: true, id: `EXT-NEW-KW-${i}` }))),
  bulkUpdateKeywordApi: vi.fn(async (_token: string, _campaign: string, items: Array<{ keywordId: string }>) => items.map((k) => ({ key: k.keywordId, ok: true }))),
  updateCampaignBudgetApi: vi.fn(async (_token: string, _campaign: string, _body: Record<string, any>) => undefined),
}))
vi.mock('./ebay-ads-api.service.js', () => ({
  getEbayAdsAuthFor: vi.fn(async () => ({ token: 'test-token' })),
  ...api,
  campaignLifecycleApi: vi.fn(), cloneCampaignApi: vi.fn(), updateAdRateStrategyApi: vi.fn(), updateCampaignIdentificationApi: vi.fn(),
  bulkCreateAdsByListingIdApi: vi.fn(async () => []), bulkUpdateAdsBidApi: vi.fn(async () => []), bulkDeleteAdsApi: vi.fn(async () => []),
  bulkCreateNegativeKeywordApi: vi.fn(async () => []),
}))

import { addKeywords, createAdGroup, createCampaign, updateBudget, updateKeywords } from './ebay-ads-write.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const op = { actorUserId: 'u-test' }

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    const account = await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, isPrimary: true, accountLabel: 'Test eBay account', externalAccountId: 'TEST-SELLER-1' } })
    for (const [code, marketplaceId, currency] of [['UK', 'EBAY_GB', 'GBP'], ['DE', 'EBAY_DE', 'EUR']]) {
      await db.marketplace.create({ data: { channel: 'EBAY', code, name: `eBay ${code}`, region: 'EU', currency, language: 'en', marketplaceId } })
    }
    // The GB campaign was stored as euros by the old create: the marketplace's currency is the one that counts.
    for (const [id, marketplace, stored] of [['e-gb', 'EBAY_GB', 'EUR'], ['e-de', 'EBAY_DE', null]] as const) {
      await db.ebayCampaign.create({
        data: { id, channelConnectionId: account.id, marketplace, externalCampaignId: `EXT-${id}`, name: `Test ${id}`, fundingStrategy: 'ADVANCED', fundingModel: 'COST_PER_CLICK', campaignTargetingType: 'MANUAL', dailyBudget: '10.00', budgetCurrency: stored, status: 'RUNNING', startDate: new Date('2026-01-01T00:00:00Z') },
      })
      await db.ebayAdGroup.create({ data: { id: `g-${id}`, campaignId: id, externalAdGroupId: `EXT-g-${id}`, name: `group ${id}`, status: 'ACTIVE' } })
      await db.ebayKeyword.create({ data: { id: `k-${id}`, campaignId: id, adGroupId: `g-${id}`, externalKeywordId: `EXT-k-${id}`, text: `gloves ${id}`, matchType: 'EXACT', bidCents: 40, status: 'ACTIVE' } })
    }
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_MARKETING_WRITES_EBAY', '1')
  for (const fn of Object.values(api)) fn.mockClear()
})

describe('eBay money is sent in the campaign\'s own marketplace currency', () => {
  const cases = [['e-gb', 'GBP'], ['e-de', 'EUR']] as const

  it.each(cases)('%s: a keyword bid change, a new keyword and an ad group default bid', async (id, currency) => {
    await inside(() => updateKeywords(op, id, [{ keywordId: `k-${id}`, bidCents: 55 }]))
    expect(api.bulkUpdateKeywordApi.mock.calls[0][2]).toEqual([{ keywordId: `EXT-k-${id}`, bid: { currency, value: '0.55' } }])
    await inside(() => addKeywords(op, id, `g-${id}`, [{ text: 'winter gloves', matchType: 'EXACT', bidCents: 30 }]))
    expect(api.bulkCreateKeywordApi.mock.calls[0][2]).toEqual([{ adGroupId: `EXT-g-${id}`, keywordText: 'winter gloves', matchType: 'EXACT', bid: { currency, value: '0.30' } }])
    await inside(() => createAdGroup(op, id, 'new group', 25))
    expect(api.createAdGroupApi.mock.calls[0][2]).toEqual({ name: 'new group', defaultBid: { currency, value: '0.25' } })
  })

  it.each(cases)('%s: a daily budget', async (id, currency) => {
    await inside(() => updateBudget(op, id, 1500))
    expect(api.updateCampaignBudgetApi.mock.calls[0][2]).toEqual({ budget: { daily: { amount: { currency, value: '15.00' } } } })
  })

  it.each([['EBAY_GB', 'GBP'], ['EBAY_DE', 'EUR']] as const)('%s: a new Priority campaign\'s budget and max CPC, and the currency it is stored with', async (marketplace, currency) => {
    const out = await inside(() => createCampaign(op, { name: `Smart ${marketplace}`, marketplace, fundingModel: 'COST_PER_CLICK', targetingType: 'SMART', dailyBudgetCents: 2000, maxCpcCents: 35 }))
    const payload = api.createCampaignApi.mock.calls[0][1]
    expect(payload.budget).toEqual({ daily: { amount: { currency, value: '20.00' } } })
    expect(payload.fundingStrategy.bidPreferences).toEqual([{ maxCpc: { amount: { currency, value: '0.35' } } }])
    expect((await inside(() => database.client.ebayCampaign.findUniqueOrThrow({ where: { id: out.campaignId } }))).budgetCurrency).toBe(currency)
  })
})

describe('a write the gate refuses writes nothing, in sandbox as in live', () => {
  const counts = () => inside(async () => ({
    campaigns: await database.client.ebayCampaign.count(),
    groups: await database.client.ebayAdGroup.count(),
    keywords: await database.client.ebayKeyword.count(),
    audit: await database.client.campaignAction.count(),
    bid: (await database.client.ebayKeyword.findUniqueOrThrow({ where: { id: 'k-e-de' } })).bidCents,
  }))

  it.each([['sandbox', '0'], ['live', '1']])('%s: a budget, a bid, a new keyword or an ad group default above the value cap is refused before anything is written', async (_mode, live) => {
    vi.stubEnv('NEXUS_MARKETING_WRITES_EBAY', live)
    vi.stubEnv('NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS', '100')
    const before = await counts()
    await expect(inside(() => createCampaign(op, { name: `Over the cap ${live}`, marketplace: 'EBAY_DE', fundingModel: 'COST_PER_CLICK', targetingType: 'MANUAL', dailyBudgetCents: 500 }))).rejects.toThrow(/write gate blocked: payload value 500¢ exceeds cap 100¢/)
    await expect(inside(() => updateKeywords(op, 'e-de', [{ keywordId: 'k-e-de', bidCents: 150 }]))).rejects.toThrow(/write gate blocked/)
    await expect(inside(() => addKeywords(op, 'e-de', 'g-e-de', [{ text: 'over the cap', matchType: 'EXACT', bidCents: 150 }]))).rejects.toThrow(/write gate blocked/)
    await expect(inside(() => createAdGroup(op, 'e-de', 'over the cap', 150))).rejects.toThrow(/write gate blocked/)
    expect(await counts()).toEqual(before)
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled()
    // Under the cap the same writes go through (control).
    await inside(() => updateKeywords(op, 'e-de', [{ keywordId: 'k-e-de', bidCents: 60 }]))
    expect((await counts()).bid).toBe(60)
  })
})

