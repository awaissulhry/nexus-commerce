/**
 * Google Ads changes, G9 (2026-10-15) — the live reads of experiments, their arms, their campaigns (Google's drafts and
 * in-design campaigns included: `PARAMETERS include_drafts=true`) and campaign drafts: what each query asks, that a field
 * filtered on is of the FROM resource or selected too (the 2026-10-15 trap), that an id is checked before anything is
 * sent, and how Google's rows read. Ids and names are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: vi.fn() }))
vi.mock('./write-client.js', () => ({ liveRows: h.rows }))

import {
  ALL_ARMS_QUERY, CAMPAIGN_DRAFTS_QUERY, CAMPAIGN_NAMES_QUERY, campaignsByIdQuery, experimentArmsQuery, experimentQuery, EXPERIMENTS_LIST_QUERY,
  liveCampaignDrafts, liveExperiment, liveExperimentCampaigns, liveExperimentList, liveSettingsWithDrafts,
} from './live-experiments.js'

const target = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }
const EXP = 'customers/1234567890/experiments/31'
const expRow = (over: Record<string, unknown> = {}) => ({
  experiment: { resourceName: EXP, experimentId: '31', name: 'Test A', type: 'SEARCH_CUSTOM', status: 'SETUP', startDate: '2026-11-01', suffix: ' [experiment]', syncEnabled: false, promoteStatus: 'NOT_STARTED', ...over },
})
const armRows = [
  { experimentArm: { resourceName: 'customers/1234567890/experimentArms/31~1', experiment: EXP, name: 'Control', control: true, trafficSplit: '50', campaigns: ['customers/1234567890/campaigns/21'] } },
  { experimentArm: { resourceName: 'customers/1234567890/experimentArms/31~2', experiment: EXP, name: 'Treatment', trafficSplit: '50', inDesignCampaigns: ['customers/1234567890/campaigns/22'] } },
]

beforeEach(() => h.rows.mockReset())

describe('the queries', () => {
  const all = {
    experiment: experimentQuery('31'), list: EXPERIMENTS_LIST_QUERY, arms: experimentArmsQuery(EXP), allArms: ALL_ARMS_QUERY,
    campaigns: campaignsByIdQuery(['21', '22']), names: CAMPAIGN_NAMES_QUERY, drafts: CAMPAIGN_DRAFTS_QUERY,
  }

  it('every field filtered on is of the FROM resource or selected too', () => {
    for (const [name, q] of Object.entries(all)) {
      const from = /FROM (\w+)/.exec(q)![1]
      const select = q.slice(7, q.indexOf(' FROM ')).split(', ')
      const where = /WHERE (.*?)(?: ORDER BY| LIMIT| PARAMETERS|$)/.exec(q)?.[1] ?? ''
      for (const field of where.replace(/'[^']*'/g, "''").match(/\b[a-z_]+\.[a-z_.]+/g) ?? []) {
        if (!field.startsWith(`${from}.`)) expect(select, `${name}: ${field}`).toContain(field)
      }
    }
  })

  it('arms and campaigns ask for Google\'s drafts (in-design and draft campaigns are returned only so); experiments and drafts need not', () => {
    for (const q of [all.arms, all.allArms, all.campaigns, all.names]) expect(q.endsWith(' PARAMETERS include_drafts=true')).toBe(true)
    for (const q of [all.experiment, all.list, all.drafts]) expect(q).not.toContain('PARAMETERS')
    expect(all.experiment).toBe(`${EXPERIMENTS_LIST_QUERY.slice(0, EXPERIMENTS_LIST_QUERY.indexOf(' WHERE'))} WHERE experiment.experiment_id = 31`)
    expect(all.campaigns).toContain('WHERE campaign.id IN (21, 22)')
  })

  it('an id that is not Google\'s is refused before anything is sent', () => {
    expect(() => experimentQuery("31' OR 1=1")).toThrow(/Nothing was sent/)
    expect(() => experimentArmsQuery("customers/1/experiments/31' OR '1")).toThrow(/Nothing was sent/)
    expect(() => campaignsByIdQuery(['21', 'x'])).toThrow(/Nothing was sent/)
    expect(h.rows).not.toHaveBeenCalled()
  })
})

describe('how Google\'s rows read', () => {
  it('one experiment with its arms (traffic split a number, campaign ids from resource names); a removed one is none', async () => {
    h.rows.mockResolvedValueOnce([expRow({ longRunningOperation: 'customers/1234567890/operations/op-1' })]).mockResolvedValueOnce(armRows)
    const e = await liveExperiment(target, '31')
    expect(e).toEqual({
      experimentId: '31', resourceName: EXP, name: 'Test A', description: null, type: 'SEARCH_CUSTOM', status: 'SETUP', start: '2026-11-01', end: null,
      suffix: ' [experiment]', syncEnabled: false, promoteStatus: 'NOT_STARTED', operation: 'customers/1234567890/operations/op-1',
      arms: [
        { armId: '31~1', name: 'Control', control: true, trafficSplitPct: 50, campaignIds: ['21'], inDesignCampaignIds: [] },
        { armId: '31~2', name: 'Treatment', control: false, trafficSplitPct: 50, campaignIds: [], inDesignCampaignIds: ['22'] },
      ],
    })
    expect(h.rows.mock.calls[1][1]).toBe(experimentArmsQuery(EXP))
    h.rows.mockResolvedValueOnce([expRow({ status: 'REMOVED' })])
    expect(await liveExperiment(target, '31')).toBeNull()
    expect(h.rows).toHaveBeenCalledTimes(3)
  })

  it('the list: the arms read once and given to their experiment; no experiment, no arms query', async () => {
    h.rows.mockResolvedValueOnce([expRow(), expRow({ resourceName: 'customers/1234567890/experiments/32', experimentId: '32', name: 'Test B' })]).mockResolvedValueOnce(armRows)
    const list = await liveExperimentList(target)
    expect(list.map((e) => [e.experimentId, e.arms.length])).toEqual([['31', 2], ['32', 0]])
    h.rows.mockReset().mockResolvedValueOnce([])
    expect(await liveExperimentList(target)).toEqual([])
    expect(h.rows).toHaveBeenCalledTimes(1)
  })

  it('campaigns (drafts included): the budget in cents, shared or not, its period; none asked, none read', async () => {
    h.rows.mockResolvedValueOnce([{
      campaign: { id: '22', name: 'Search A [experiment]', status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MANUAL_CPC', experimentType: 'DRAFT', baseCampaign: 'customers/1234567890/campaigns/21' },
      campaignBudget: { id: '11', name: 'Budget A', amountMicros: '10000000', explicitlyShared: false, period: 'DAILY', status: 'ENABLED' },
    }])
    expect(await liveExperimentCampaigns(target, ['22', '22'])).toEqual([{
      campaignId: '22', name: 'Search A [experiment]', status: 'ENABLED', type: 'SEARCH', bidding: 'MANUAL_CPC', experimentType: 'DRAFT', baseCampaignId: '21',
      start: null, end: null, budget: { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false, period: 'DAILY', status: 'ENABLED' },
    }])
    expect(h.rows.mock.calls[0][1]).toBe(campaignsByIdQuery(['22']))
    expect(await liveExperimentCampaigns(target, [])).toEqual([])
    expect(h.rows).toHaveBeenCalledTimes(1)
  })

  it('campaign drafts: the id the tools take is campaignId~draftId; the settings read of a draft campaign asks for drafts', async () => {
    h.rows.mockResolvedValueOnce([{ campaignDraft: { resourceName: 'customers/1234567890/campaignDrafts/21~3', draftId: '3', name: 'Draft A', status: 'PROPOSED', baseCampaign: 'customers/1234567890/campaigns/21', draftCampaign: 'customers/1234567890/campaigns/25', hasExperimentRunning: false } }])
    expect(await liveCampaignDrafts(target)).toEqual([{ draftId: '21~3', resourceName: 'customers/1234567890/campaignDrafts/21~3', name: 'Draft A', status: 'PROPOSED', baseCampaignId: '21', draftCampaignId: '25', experimentRunning: false, operation: null }])
    h.rows.mockResolvedValueOnce([])
    expect(await liveSettingsWithDrafts(target, '25')).toBeNull()
    expect(h.rows.mock.calls[1][1]).toMatch(/FROM campaign WHERE campaign\.id = 25 PARAMETERS include_drafts=true$/)
  })
})
