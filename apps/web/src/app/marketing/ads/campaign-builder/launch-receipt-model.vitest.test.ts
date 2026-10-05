/**
 * W2-A (CC-2, CC-16) — when a create screen stops and shows the launch receipt, and what it says.
 */
import { describe, expect, it } from 'vitest'
import { launchHeadline, madeSummary, needsReceipt, recheckIds, type LaunchCampaignResult, type LaunchResult } from './launch-receipt-model'

const made = (over: Partial<LaunchCampaignResult['made']> = {}): LaunchCampaignResult['made'] => ({
  adGroups: 1, productAds: 2, keywords: 0, productTargets: 0, autoTargeting: 4, negativeKeywords: 1, negativeProducts: 0, placement: null, ...over,
})
const campaign = (name: string, status: LaunchCampaignResult['status'], ids: { id?: string | null; ext?: string | null } = {}): LaunchCampaignResult => ({
  name, status, campaignId: ids.id === undefined ? `id-${name}` : ids.id, externalCampaignId: ids.ext === undefined ? `ext-${name}` : ids.ext,
  reason: status === 'live' ? null : 'why', made: made(), failed: status === 'partial' ? [{ step: 'product_ad', item: 'SKU-2', reason: 'Amazon refused it' }] : [],
})
const launch = (campaigns: LaunchCampaignResult[]): LaunchResult => ({
  ok: campaigns.every((c) => c.status === 'live'), asked: campaigns.length,
  live: campaigns.filter((c) => c.status === 'live').length, partial: campaigns.filter((c) => c.status === 'partial').length,
  failed: campaigns.filter((c) => c.status === 'failed').length, campaigns,
})

describe('needsReceipt — a screen moves on only when everything is live and read back as asked', () => {
  it('all live and verified: move on', () => {
    expect(needsReceipt({ ok: true, launch: launch([campaign('a', 'live')]), verification: { ok: true } })).toBe(false)
  })
  it('any campaign partly made or not made: stop, even when the read-back of the rest is fine', () => {
    expect(needsReceipt({ ok: false, launch: launch([campaign('a', 'live'), campaign('b', 'failed', { ext: null })]), verification: { ok: true } })).toBe(true)
    expect(needsReceipt({ ok: false, launch: launch([campaign('a', 'partial')]), verification: { ok: true } })).toBe(true)
  })
  it('a read-back that is missing is never a pass (SPW used to treat null as one)', () => {
    expect(needsReceipt({ ok: true, launch: launch([campaign('a', 'live')]), verification: null })).toBe(true)
    expect(needsReceipt({ ok: true, launch: launch([campaign('a', 'live')]) })).toBe(true)
  })
  it('a read-back that disagrees: stop', () => {
    expect(needsReceipt({ ok: true, launch: launch([campaign('a', 'live')]), verification: { ok: false } })).toBe(true)
  })
})

describe('recheckIds — a Re-check reads the campaigns Amazon holds', () => {
  it('from the launch: only campaigns on Amazon (a refused one has nothing to read)', () => {
    expect(recheckIds({ launch: launch([campaign('a', 'live'), campaign('b', 'failed', { ext: null }), campaign('c', 'failed', { id: null, ext: null })]) })).toEqual(['id-a'])
  })
  it('an older answer without `launch`: the created list, else the single campaign', () => {
    expect(recheckIds({ created: [{ campaignId: 'x', externalCampaignId: 'e' }, { campaignId: 'y', externalCampaignId: null }] })).toEqual(['x'])
    expect(recheckIds({ campaignId: 'z' })).toEqual(['z'])
  })
})

describe('the words', () => {
  it('headline counts live, partly made and not made', () => {
    expect(launchHeadline(launch([campaign('a', 'live'), campaign('b', 'partial'), campaign('c', 'failed')]))).toBe('1 of 3 campaigns is live on Amazon · 1 partly made · 1 not made')
    expect(launchHeadline(launch([campaign('a', 'failed'), campaign('b', 'failed')]))).toBe('0 of 2 campaigns are live on Amazon · 2 not made')
  })
  it('what reached Amazon, in plain words', () => {
    expect(madeSummary(made({ placement: true }))).toBe('1 ad group · 2 product ads · 4 auto groups · 1 negative keyword · placements set')
    expect(madeSummary(made({ adGroups: 0, productAds: 0, autoTargeting: 0, negativeKeywords: 0 }))).toBe('nothing under it')
  })
})
