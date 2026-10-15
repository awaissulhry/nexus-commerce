/**
 * Google Ads programme 2, G1 (2026-10-15) — the live read tools as Claude calls them (the account and Google are
 * stand-ins): google-ads-live's new views, google-ads-numbers (today in the account's time zone, splits Google allows,
 * money stripped for a person without the ad-spend permission) and google-ads-query (only SELECT, only this account,
 * a LIMIT forced, the money permission required). All three are read only and registered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: vi.fn() }))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  liveRows: h.rows,
}))

import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { GOOGLE_ADS_LIVE_TOOLS, GOOGLE_LIVE_VIEWS } from './google-ads-live.tools.js'
import { getTool } from '../tool-registry.js'
import { financialPayloadCopy } from '../../../lib/auth/field-filter.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_LIVE_TOOLS.find((t) => t.name === name)!
const everyone: ToolContext = { can: () => true, via: 'claude', userId: 'u-1' }
const without = (...permissions: string[]): ToolContext => ({ can: (p) => !permissions.includes(p), via: 'claude', userId: 'u-2' })
/** Holds the ads permissions but no money permission at all. */
const noMoney = without(FIELDS.financialsView, FIELDS.financialsAdspendView, FIELDS.financialsCostsView, FIELDS.financialsMarginsView, FIELDS.financialsRevenueView)
const sent = () => h.rows.mock.calls.map((c) => String(c[1]))

beforeEach(() => { h.rows.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('registration', () => {
  it('the three live read tools are registered, read only, reaching Google', () => {
    expect(GOOGLE_ADS_LIVE_TOOLS.map((t) => t.name)).toEqual(['google-ads-live', 'google-ads-numbers', 'google-ads-query'])
    for (const t of GOOGLE_ADS_LIVE_TOOLS) {
      expect(getTool(t.name)).toBe(t)
      expect(t).toMatchObject({ readOnly: true, openWorld: true, riskTier: 'low' })
      expect(t.execute).toBeUndefined()
    }
    expect(tool('google-ads-query').requires).toEqual([F.adsView, FIELDS.financialsAdspendView])
    for (const key of ['spendCents', 'avgCpcCents', 'conversionValueCents', 'costPerConversionCents', 'roas', 'defaultValueCents', 'spendingLimitCents', 'amountServedCents']) {
      expect(tool('google-ads-numbers').restrictedFields?.[key] ?? tool('google-ads-live').restrictedFields?.[key]).toBe(FIELDS.financialsAdspendView)
    }
  })

  it('google-ads-live knows the new views and the account\'s own audience lookups', () => {
    expect(GOOGLE_LIVE_VIEWS).toEqual(expect.arrayContaining(['account', 'conversions', 'labels', 'experiments', 'users', 'billing', 'links', 'bid-strategies', 'auto-apply']))
    expect(tool('google-ads-live').input.safeParse({ view: 'lookup', lookup: 'user-lists' }).success).toBe(true)
    expect(tool('google-ads-live').input.safeParse({ view: 'lookup', lookup: 'custom-audiences', search: 'moto' }).success).toBe(true)
  })
})

describe('google-ads-live, new views', () => {
  it('users needs the users permission: refused before any Google call', async () => {
    const out = await tool('google-ads-live').handler({ view: 'users' }, without(F.usersManage))
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining(F.usersManage) })
    expect(h.rows).not.toHaveBeenCalled()
    h.rows.mockResolvedValue([])
    expect((await tool('google-ads-live').handler({ view: 'users' }, everyone)).ok).toBe(true)
  })

  it('billing needs the ad-spend permission: refused before any Google call', async () => {
    expect(await tool('google-ads-live').handler({ view: 'billing' }, noMoney)).toMatchObject({ ok: false, error: expect.stringContaining(FIELDS.financialsAdspendView) })
    expect(h.rows).not.toHaveBeenCalled()
  })

  it('change history: who made a change (an e-mail) only with the users permission; otherwise "a person"', async () => {
    const row = { changeEvent: { changeDateTime: '2026-10-15 10:00:00', userEmail: 'someone@example.com', clientType: 'GOOGLE_ADS_WEB_CLIENT' } }
    h.rows.mockResolvedValue([row])
    const hidden = await tool('google-ads-live').handler({ view: 'change-history', day: '2026-10-15' }, without(F.usersManage))
    expect((hidden.data as any).items[0]).toMatchObject({ by: 'a person', client: 'GOOGLE_ADS_WEB_CLIENT' })
    expect(JSON.stringify(hidden.data)).not.toContain('someone@example.com')
    const shown = await tool('google-ads-live').handler({ view: 'change-history', day: '2026-10-15' }, everyone)
    expect((shown.data as any).items[0]).toMatchObject({ by: 'someone@example.com' })
  })

  it('product-groups: every Shopping dimension, so a condition node is not "everything else"', async () => {
    h.rows.mockResolvedValue([
      { adGroup: { id: '51' }, adGroupCriterion: { criterionId: '601', listingGroup: { type: 'SUBDIVISION' } } },
      { adGroup: { id: '51' }, adGroupCriterion: { criterionId: '602', listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/1/adGroupCriteria/51~601', caseValue: { productCondition: { condition: 'NEW' } } } } },
      { adGroup: { id: '51' }, adGroupCriterion: { criterionId: '603', listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/1/adGroupCriteria/51~601', caseValue: { productCondition: {} } } } },
    ])
    const out = await tool('google-ads-live').handler({ view: 'product-groups', campaignId: '21' }, everyone)
    expect(sent()[0]).toContain('case_value.product_condition.condition')
    expect((out.data as any).items.map((i: any) => [i.criterionId, i.value, i.everythingElse])).toEqual([['601', null, false], ['602', 'NEW', false], ['603', null, true]])
    expect((out.data as any).warning).toMatch(/^1 "everything else" product group is NOT excluded/)
  })

  it('bid-strategies and auto-apply', async () => {
    h.rows.mockResolvedValue([{ biddingStrategy: { id: '81', name: 'Portfolio A', type: 'TARGET_SPEND', targetSpend: { cpcBidCeilingMicros: '800000' } } }])
    expect(await tool('google-ads-live').handler({ view: 'bid-strategies' }, everyone)).toMatchObject({ ok: true, data: { items: [{ strategyId: '81', maxCpcCeilingCents: 80 }] } })
    expect(sent()[0]).toContain('FROM bidding_strategy')
    h.rows.mockResolvedValue([{ recommendationSubscription: { type: 'KEYWORD', status: 'PAUSED' } }])
    expect(await tool('google-ads-live').handler({ view: 'auto-apply' }, everyone)).toMatchObject({ ok: true, data: { items: [{ type: 'KEYWORD', status: 'PAUSED' }] } })
  })

  it('account: the settings, read live', async () => {
    h.rows.mockResolvedValue([{ customer: { id: '1234567890', autoTaggingEnabled: true, timeZone: 'Europe/Rome', currencyCode: 'EUR' } }])
    const out = await tool('google-ads-live').handler({ view: 'account' }, everyone)
    expect(out).toMatchObject({ ok: true, data: { view: 'account', settings: { autoTagging: true, timeZone: 'Europe/Rome', currency: 'EUR' } } })
    expect(sent()[0]).toMatch(/FROM customer$/)
  })

  it('lookup user-lists: no search word needed; Google\'s ids', async () => {
    h.rows.mockResolvedValue([{ userList: { id: '3', name: 'Buyers', type: 'REMARKETING' } }])
    const out = await tool('google-ads-live').handler({ view: 'lookup', lookup: 'user-lists' }, everyone)
    expect(out).toMatchObject({ ok: true, data: { lookup: 'user-lists', items: [{ id: '3', name: 'Buyers' }] } })
    expect(sent()[0]).toContain('FROM user_list')
    expect((await tool('google-ads-live').handler({ view: 'lookup', lookup: 'locations' }, everyone)).ok).toBe(false)
    h.rows.mockResolvedValue([{ lifeEvent: { id: '5', name: 'Recently moved', launchedToAll: true, availabilities: [{ channel: { availabilityMode: 'ALL_CHANNELS' } }] } }])
    const life = await tool('google-ads-live').handler({ view: 'lookup', lookup: 'life-events' }, everyone)
    expect(life).toMatchObject({ ok: true, data: { lookup: 'life-events', items: [{ id: '5', name: 'Recently moved', type: 'LIFE_EVENT', channels: ['ALL'] }], note: expect.stringContaining('LIFE_EVENT') } })
    expect(sent().at(-1)).toMatch(/FROM life_event ORDER BY life_event\.name LIMIT 200$/)
  })
})

describe('google-ads-numbers', () => {
  it('today by default, in the account\'s time zone; rows, totals and a note that today is still running', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T22:30:00Z')) // already 2026-10-16 in Rome
    h.rows.mockResolvedValue([{ campaign: { id: '21', name: 'Shop A', status: 'ENABLED' }, metrics: { impressions: '100', clicks: '4', costMicros: '2000000', conversions: 1, conversionsValue: 50 } }])
    const out = await tool('google-ads-numbers').handler({ level: 'campaign' }, everyone)
    expect(out.ok).toBe(true)
    expect(sent()[0]).toContain("segments.date BETWEEN '2026-10-16' AND '2026-10-16'")
    const data = out.data as Record<string, any>
    expect(data.window).toEqual({ from: '2026-10-16', to: '2026-10-16', today: '2026-10-16', includesToday: true })
    expect(data.rows[0]).toMatchObject({ campaignId: '21', spendCents: 200, conversionValueCents: 5000 })
    expect(data.totals).toMatchObject({ spendCents: 200, roas: 25 })
    expect(data.notes[0]).toMatch(/^Today \(2026-10-16, Europe\/Rome\) is still running/)
  })

  it('a person without the ad-spend permission gets the numbers without cost, value and their ratios', async () => {
    h.rows.mockResolvedValue([{ campaign: { id: '21' }, metrics: { impressions: '100', clicks: '4', costMicros: '2000000', conversions: 1, conversionsValue: 50, averageCpc: 500000 } }])
    const out = await tool('google-ads-numbers').handler({ level: 'campaign', from: '2026-10-01', to: '2026-10-07' }, everyone)
    const seen = financialPayloadCopy(out.data, { isOwner: false, permissions: new Set([F.adsView]) }, tool('google-ads-numbers').restrictedFields) as Record<string, any>
    expect(seen.rows[0]).toMatchObject({ impressions: 100, clicks: 4, conversions: 1 })
    for (const key of ['spendCents', 'avgCpcCents', 'conversionValueCents']) expect(seen.rows[0]).not.toHaveProperty(key)
    for (const key of ['spendCents', 'costPerConversionCents', 'roas', 'conversionValueCents']) expect(seen.totals).not.toHaveProperty(key)
  })

  it('without the ad-spend permission: sorted by impressions, and a sort by cost or conversion value is refused (the ranking is money)', async () => {
    h.rows.mockResolvedValue([])
    expect((await tool('google-ads-numbers').handler({ level: 'keyword', from: '2026-10-01', to: '2026-10-02' }, noMoney)).ok).toBe(true)
    expect(sent()[0]).toMatch(/ORDER BY metrics\.impressions DESC LIMIT 100$/)
    for (const orderBy of ['cost', 'conversion-value']) {
      expect(await tool('google-ads-numbers').handler({ level: 'keyword', orderBy }, noMoney))
        .toMatchObject({ ok: false, error: `orderBy ${orderBy} ranks the rows by money: it needs the ${FIELDS.financialsAdspendView} permission. Nothing was sent.` })
    }
    expect(h.rows).toHaveBeenCalledTimes(1)
    expect((await tool('google-ads-numbers').handler({ level: 'keyword', from: '2026-10-01', to: '2026-10-02' }, everyone)).ok).toBe(true)
    expect(sent()[1]).toMatch(/ORDER BY metrics\.cost_micros DESC, metrics\.impressions DESC LIMIT 100$/)
  })

  it('no totals where one impression counts in several rows (assets, audiences, locations)', async () => {
    h.rows.mockResolvedValue([{ campaign: { id: '21' }, campaignAsset: { fieldType: 'SITELINK' }, asset: { id: '9' }, metrics: { impressions: '5' } }])
    const out = await tool('google-ads-numbers').handler({ level: 'asset', from: '2026-10-01', to: '2026-10-02' }, everyone)
    expect(out.data).not.toHaveProperty('totals')
    expect((out.data as any).notes).toEqual(expect.arrayContaining([expect.stringMatching(/^No totals: one impression can count under several assets/)]))
  })

  it('refuses before any Google call: hour below ad groups, an ad group where there is none, a day after today', async () => {
    expect(await tool('google-ads-numbers').handler({ level: 'keyword', segments: ['hour'] }, everyone)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot split keywords by hour/) })
    expect(await tool('google-ads-numbers').handler({ level: 'campaign', adGroupId: '51' }, everyone)).toMatchObject({ ok: false, error: expect.stringMatching(/not read per ad group/) })
    expect(await tool('google-ads-numbers').handler({ level: 'campaign', to: '2099-01-01' }, everyone)).toMatchObject({ ok: false, error: expect.stringMatching(/after the account's today/) })
    expect(h.rows).not.toHaveBeenCalled()
  })

  it('splits by device and hour for an ad group, with the ids in the rows', async () => {
    h.rows.mockResolvedValue([{ campaign: { id: '21' }, adGroup: { id: '51', name: 'AG', status: 'ENABLED' }, segments: { device: 'MOBILE', hour: 9 }, metrics: { impressions: '7' } }])
    const out = await tool('google-ads-numbers').handler({ level: 'ad-group', segments: ['device', 'hour'], campaignId: '21', from: '2026-10-01', to: '2026-10-02', limit: 1 }, everyone)
    expect(sent()[0]).toContain('segments.device, segments.hour')
    expect(out.data).toMatchObject({ rows: [{ adGroupId: '51', segments: { device: 'MOBILE', hour: 9 } }], truncated: true })
  })
})

describe('google-ads-query', () => {
  it('runs one SELECT on this account with a LIMIT forced, and answers Google\'s rows', async () => {
    h.rows.mockResolvedValue([{ campaign: { id: '21', name: 'Shop A' } }])
    const out = await tool('google-ads-query').handler({ query: 'SELECT campaign.id, campaign.name FROM campaign' }, everyone)
    expect(sent()).toEqual(['SELECT campaign.id, campaign.name FROM campaign LIMIT 200'])
    expect(out).toMatchObject({ ok: true, data: { query: 'SELECT campaign.id, campaign.name FROM campaign LIMIT 200', rows: [{ campaign: { id: '21' } }], total: 1 } })
  })

  it('refuses a write, another account, and the people list without the users permission — nothing sent', async () => {
    expect(await tool('google-ads-query').handler({ query: 'DELETE FROM campaign' }, everyone)).toMatchObject({ ok: false, error: expect.stringMatching(/Only a SELECT/) })
    expect(await tool('google-ads-query').handler({ query: 'SELECT customer.id FROM customer WHERE customer.id = 999' }, everyone)).toMatchObject({ ok: false, error: expect.stringMatching(/another Google Ads account/) })
    expect(await tool('google-ads-query').handler({ query: 'SELECT customer_user_access.email_address FROM customer_user_access' }, without(F.usersManage)))
      .toMatchObject({ ok: false, error: expect.stringContaining(F.usersManage) })
    expect(await tool('google-ads-query').handler({ query: "SELECT change_event.user_email FROM change_event WHERE change_event.change_date_time >= '2026-10-10'" }, without(F.usersManage)))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^change_event\.user_email name or reach people/) })
    expect(h.rows).not.toHaveBeenCalled()
  })

  it('cost of goods, gross profit and revenue need their own money permissions (or every money permission)', async () => {
    const q = 'SELECT campaign.id, metrics.gross_profit_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS'
    expect(await tool('google-ads-query').handler({ query: q }, without(FIELDS.financialsView, FIELDS.financialsMarginsView)))
      .toMatchObject({ ok: false, error: `metrics.gross_profit_micros is gross profit: the query needs the ${FIELDS.financialsMarginsView} permission. Nothing was sent.` })
    expect(await tool('google-ads-query').handler({ query: 'SELECT campaign.id, metrics.revenue_micros FROM campaign' }, without(FIELDS.financialsView, FIELDS.financialsRevenueView)))
      .toMatchObject({ ok: false, error: expect.stringContaining(FIELDS.financialsRevenueView) })
    expect(await tool('google-ads-query').handler({ query: 'SELECT campaign.id, metrics.cost_of_goods_sold_micros FROM campaign' }, without(FIELDS.financialsView, FIELDS.financialsCostsView)))
      .toMatchObject({ ok: false, error: expect.stringContaining(FIELDS.financialsCostsView) })
    expect(h.rows).not.toHaveBeenCalled()
    h.rows.mockResolvedValue([])
    expect((await tool('google-ads-query').handler({ query: q }, without(FIELDS.financialsMarginsView))).ok).toBe(true)
  })

  it('accepts a link field that names a linked account', async () => {
    h.rows.mockResolvedValue([])
    const out = await tool('google-ads-query').handler({ query: "SELECT conversion_action.id FROM conversion_action WHERE conversion_action.owner_customer = 'customers/999'" }, everyone)
    expect(out.ok).toBe(true)
  })
})
