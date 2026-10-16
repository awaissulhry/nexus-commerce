/**
 * Google Ads programme 2 G13 (2026-10-16) — a change tool on a Google draft or an experiment's trial: its live reads find
 * the campaign (PARAMETERS include_drafts=true), and the preview says what the campaign is (google-ads-kit
 * campaignKindNotes). Google, the account and the live rows are stand-ins; made-up ids and names only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: vi.fn(), mutate: vi.fn() }))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  liveRows: h.rows,
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))

import { GOOGLE_ADS_CAMPAIGN_TOOLS } from './google-ads-campaigns.tools.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_CAMPAIGN_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }

const campaign = (id: string, name: string, experimentType: string) => ({
  campaign: {
    id, name, status: 'PAUSED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MANUAL_CPC', experimentType,
    networkSettings: { targetGoogleSearch: true }, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
  },
  campaignBudget: { id: '11', name: null, amountMicros: '10000000', explicitlyShared: false },
})

beforeEach(() => {
  h.mutate.mockReset()
  h.rows.mockReset()
})

describe('a change on a Google draft or an experiment trial', () => {
  for (const [kind, words] of [['DRAFT', /"Trial A" is a Google draft/], ['EXPERIMENT', /"Trial A" is the trial campaign of a running experiment/]] as const) {
    it(`set-google-campaign on a ${kind} campaign: found with the drafts, and the preview says what it is`, async () => {
      h.rows.mockImplementation(async (_t: unknown, query: string) => {
        if (query.includes('FROM campaign_budget')) return [{ campaignBudget: { id: '11', amountMicros: '10000000', explicitlyShared: false, status: 'ENABLED', referenceCount: 1 } }]
        if (query.includes('FROM campaign ')) return [campaign('31', 'Trial A', kind), campaign('21', 'Shop A', 'BASE')].filter((r) => !query.includes('campaign.id = ') || query.includes(`campaign.id = ${r.campaign.id}`))
        return []
      })
      h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
      const out = await tool('set-google-campaign').handler({ campaignId: '31', name: 'Trial A renamed' }, asker)
      expect(out.ok, String(out.error)).toBe(true)
      expect((out.preview as { warnings: string[] }).warnings[0]).toMatch(words)
      // The settings read asked Google for its drafts.
      expect(h.rows.mock.calls.map((c) => String(c[1])).filter((q) => q.includes('campaign.id = 31'))[0]).toMatch(/PARAMETERS include_drafts=true$/)
    })
  }

  it('a campaign of its own: no note', async () => {
    h.rows.mockImplementation(async (_t: unknown, query: string) => {
      if (query.includes('FROM campaign_budget')) return []
      if (query.includes('FROM campaign ')) return [campaign('21', 'Shop A', 'BASE')]
      return []
    })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-campaign').handler({ campaignId: '21', name: 'Shop A renamed' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect(((out.preview as { warnings?: string[] }).warnings ?? []).join(' ')).not.toMatch(/Google draft|trial campaign/)
  })

  it('set-google-status on an ad group of a trial: the ad group read says its campaign is a trial, and the preview says so', async () => {
    h.rows.mockImplementation(async (_t: unknown, query: string) => {
      if (query.includes('FROM ad_group ')) return [{ adGroup: { id: '51', name: 'Group A', status: 'ENABLED' }, campaign: { id: '32', name: 'Trial B', status: 'ENABLED', experimentType: 'EXPERIMENT' } }]
      if (query.includes('FROM campaign ')) return [campaign('32', 'Trial B', 'EXPERIMENT')]
      return []
    })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-status').handler({ items: [{ kind: 'ad-group', id: '51' }], status: 'PAUSED' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect((out.preview as { warnings: string[] }).warnings.join(' ')).toMatch(/"Trial B" is the trial campaign of a running experiment/)
    expect(h.rows.mock.calls.map((c) => String(c[1])).find((q) => q.includes('FROM ad_group '))).toMatch(/campaign\.experiment_type .* PARAMETERS include_drafts=true$/)
  })

  it('an ad group of a campaign of its own: no note', async () => {
    h.rows.mockImplementation(async (_t: unknown, query: string) => {
      if (query.includes('FROM ad_group ')) return [{ adGroup: { id: '52', name: 'Group B', status: 'ENABLED' }, campaign: { id: '21', name: 'Shop A', status: 'ENABLED', experimentType: 'BASE' } }]
      if (query.includes('FROM campaign ')) return [campaign('21', 'Shop A', 'BASE')]
      return []
    })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-status').handler({ items: [{ kind: 'ad-group', id: '52' }], status: 'PAUSED' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect(((out.preview as { warnings?: string[] }).warnings ?? []).join(' ')).not.toMatch(/trial campaign|Google draft/)
  })
})
