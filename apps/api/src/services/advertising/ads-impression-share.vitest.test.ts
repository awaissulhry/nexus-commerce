/**
 * B6 (2026-10-10, honest numbers) — `analyzeShareOfVoice` reads only OUR search-term report, so its per-query number is
 * our own impression mix, not a share of voice: renamed `impressionMixPct` (no web reader used `sovPct`), null when there
 * are no impressions to divide by (it read 0), and every answer carries the note that says what it is. Fake queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMany = vi.fn()
vi.mock('../../db.js', () => ({ default: { amazonAdsSearchTerm: { findMany: (...a: unknown[]) => findMany(...a) } } }))

import { analyzeShareOfVoice, IMPRESSION_MIX_NOTE } from './ads-impression-share.service.js'

const term = (query: string, campaignId: string, impressions: number, clicks = 0) =>
  ({ query, campaignId, impressions, clicks, costMicros: BigInt(clicks * 500_000), orders7d: 0 })

beforeEach(() => findMany.mockReset())

describe('analyzeShareOfVoice — our own impression mix (B6)', () => {
  it('impressionMixPct = the query\'s impressions ÷ all our search-term impressions; no sovPct key; the note says what it is', async () => {
    findMany.mockResolvedValue([term('test jacket', 'c1', 300), term('test jacket', 'c2', 100), term('test gloves', 'c1', 600)])
    const r = await analyzeShareOfVoice({ marketplace: 'IT' })
    const jacket = r.rows.find((x) => x.query === 'test jacket')!
    expect(jacket.impressionMixPct).toBeCloseTo(0.4, 10)
    expect('sovPct' in jacket).toBe(false)
    expect(r.note).toBe(IMPRESSION_MIX_NOTE)
    expect(r.note).toContain('our own impression mix (our search-term impressions only), not a market share')
  })

  it('no impressions to divide by → null, never 0', async () => {
    findMany.mockResolvedValue([term('test jacket', 'c1', 0, 2)])
    const r = await analyzeShareOfVoice({ marketplace: 'IT' })
    expect(r.totalImpressions).toBe(0)
    expect(r.rows[0].impressionMixPct).toBeNull()
  })

  it('the leading campaign\'s share of a query with no impressions is null (no reading), never 0', async () => {
    findMany.mockResolvedValue([term('test jacket', 'c1', 0, 2), term('test jacket', 'c2', 0, 1), term('test gloves', 'c1', 300), term('test gloves', 'c2', 100)])
    const r = await analyzeShareOfVoice({ marketplace: 'IT' })
    expect(r.rows.find((x) => x.query === 'test jacket')!.topCampaignSharePct).toBeNull()
    expect(r.rows.find((x) => x.query === 'test gloves')!.topCampaignSharePct).toBeCloseTo(0.75, 10)
  })
})
