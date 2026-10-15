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
const without = (permission: string): ToolContext => ({ can: (p) => p !== permission, via: 'claude', userId: 'u-2' })
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
    expect(GOOGLE_LIVE_VIEWS).toEqual(expect.arrayContaining(['account', 'conversions', 'labels', 'experiments', 'users', 'billing', 'links']))
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
    expect(h.rows).not.toHaveBeenCalled()
  })
})
