/**
 * Google Ads changes, PR 2 (2026-10-15) — the campaign tools as the approval gate uses them (Google, the account and the
 * live reads are stand-ins): a new campaign is made PAUSED on Google's check; enabling reads what would make it spend
 * where nobody meant it to; a removal needs the person's explicit ask and has no undo; every undo request parses as its
 * tool's own arguments and goes to the account the change was made on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  live: {
    campaigns: [] as unknown[], budgets: [] as unknown[], lists: [] as unknown[], settings: null as unknown,
    criteria: [] as unknown[], productGroups: [] as unknown[], statuses: [] as unknown[], adGroups: [] as unknown[], adGroupDevices: [] as unknown[],
  },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveBudgets: vi.fn(async () => structuredClone(h.live.budgets)),
  liveNegativeLists: vi.fn(async () => structuredClone(h.live.lists)),
  liveCampaignSettings: vi.fn(async () => structuredClone(h.live.settings)),
  liveProductGroups: vi.fn(async () => structuredClone(h.live.productGroups)),
}))
vi.mock('../../marketing/google-ads/live-campaigns.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-campaigns.js')>()),
  liveCampaignCriteria: vi.fn(async () => structuredClone(h.live.criteria)),
  liveStatuses: vi.fn(async () => structuredClone(h.live.statuses)),
}))
vi.mock('../../marketing/google-ads/live-targeting.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-targeting.js')>()),
  liveTargetingCriteria: vi.fn(async () => structuredClone(h.live.criteria)),
  liveTargetingAdGroups: vi.fn(async () => structuredClone(h.live.adGroups)),
  liveAdGroupDevices: vi.fn(async () => structuredClone(h.live.adGroupDevices)),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))

import { GOOGLE_ADS_CAMPAIGN_TOOLS } from './google-ads-campaigns.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_CAMPAIGN_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const SHOP = { campaignId: '21', name: 'Shop A', status: 'PAUSED', servingStatus: null, primaryStatus: null, type: 'SHOPPING', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: { merchantId: '5', feedLabel: 'IT', priority: 'LOW' }, budget: { budgetId: '11', name: 'Shared A', amountCents: 1500, shared: true } }
const ok = { responses: [], ops: 1, requestId: null }

beforeEach(() => {
  h.mutate.mockReset()
  h.live.campaigns = [SHOP]
  h.live.budgets = [{ budgetId: '11', name: 'Shared A', amountCents: 1500, shared: true, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '21', name: 'Shop A', status: 'PAUSED' }] }]
  h.live.lists = []
  h.live.criteria = []
  h.live.productGroups = []
  h.live.statuses = []
  h.live.adGroups = []
  h.live.adGroupDevices = []
})

describe('the campaign tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, re-check fields declared; remove has no undo', () => {
    for (const t of GOOGLE_ADS_CAMPAIGN_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('remove-google-ads-items')).toMatchObject({ reversibility: 'none' })
    expect(tool('remove-google-ads-items').undo).toBeUndefined()
  })

  it('create-google-campaign: Google checks a PAUSED campaign; the run records Google\'s id; undo asks to remove it on the same account', async () => {
    const ask = { type: 'SEARCH', name: 'Search B', dailyBudgetCents: 600, locations: [{ id: '2380' }], languages: ['1004'] }
    h.mutate.mockResolvedValue(ok)
    const out = await tool('create-google-campaign').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    const create = h.mutate.mock.calls[0][1].find((o: Record<string, unknown>) => 'campaignOperation' in o).campaignOperation.create
    expect(create.status).toBe('PAUSED')
    expect(out.preview).toMatchObject({ spendsMoney: false, googleCheck: { checked: true } })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/55' } }, { campaignResult: { resourceName: 'customers/1234567890/campaigns/99' } }, {}, {}], ops: 4, requestId: null })
    const run = await tool('create-google-campaign').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(run.change?.after).toEqual({ campaignId: '99', name: 'Search B', ownBudgetId: '55', accountId: 'g-1', customerId: '1234567890' })
    const undo = tool('create-google-campaign').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'remove-google-ads-items', args: { accountId: 'g-1', items: [{ kind: 'campaign', id: '99' }, { kind: 'budget', id: '55' }], confirmRemove: true, why: 'undo of an earlier campaign create' } })
    expect(tool('remove-google-ads-items').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('set-google-status ENABLE of a Shopping campaign reads its product groups and locations, and says what it finds', async () => {
    h.live.productGroups = [{ adGroupId: '51', criterionId: '603', parentId: '601', kind: 'UNIT', dimension: 'productItemId', value: null, everythingElse: true, excluded: false, bidCents: 25, status: 'ENABLED' }]
    h.mutate.mockResolvedValue(ok)
    const out = await tool('set-google-status').handler({ items: [{ kind: 'campaign', id: '21' }], status: 'ENABLED' }, asker)
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({
      spendsMoney: true,
      spendsMoneyBecause: [
        'Enables the campaign "Shop A": it can spend its daily budget from now.',
        '"Shop A" leaves "everything else" open in 1 product group: it can advertise EVERY other product of the feed.',
      ],
    })
    expect((out.preview as { warnings: string[] }).warnings).toContain('"Shop A" targets no location: it can show in every country.')
  })

  it('set-google-status ENABLE: a campaign that targets only a radius targets a place (no "targets no location" warning)', async () => {
    h.live.criteria = [{ criterionId: '8', type: 'PROXIMITY', negative: false, name: null, bidModifier: null }]
    h.mutate.mockResolvedValue(ok)
    const out = await tool('set-google-status').handler({ items: [{ kind: 'campaign', id: '21' }], status: 'ENABLED' }, asker)
    expect(out.ok).toBe(true)
    expect(JSON.stringify((out.preview as { warnings?: string[] }).warnings ?? [])).not.toContain('targets no location')
    h.live.criteria = []
    const none = await tool('set-google-status').handler({ items: [{ kind: 'campaign', id: '21' }], status: 'ENABLED' }, asker)
    expect((none.preview as { warnings: string[] }).warnings).toContain('"Shop A" targets no location: it can show in every country.')
  })

  it('remove-google-ads-items: only with confirmRemove true (the person\'s ask)', () => {
    const input = tool('remove-google-ads-items').input
    expect(input.safeParse({ items: [{ kind: 'campaign', id: '21' }] }).success).toBe(false)
    expect(input.safeParse({ items: [{ kind: 'campaign', id: '21' }], confirmRemove: false }).success).toBe(false)
    expect(input.safeParse({ items: [{ kind: 'campaign', id: '21' }], confirmRemove: true }).success).toBe(true)
  })

  it('every undo request parses as its tool\'s own arguments', () => {
    const samples: Record<string, { before: unknown; after: unknown }> = {
      'set-google-campaign': { before: { campaignId: '21', settings: { searchPartners: false, bidding: { strategy: 'MANUAL_CPC' }, endDate: 'none' }, accountId: 'g-1' }, after: { campaignId: '21', settings: {}, accountId: 'g-1' } },
      'set-google-targeting': { before: { campaignId: '21', undo: {} }, after: { campaignId: '21', undo: { addLocations: [{ id: '2380', bidModifier: 1.2 }, { id: '2250', exclude: true }], schedule: [{ days: ['MONDAY'], from: '00:00', to: '08:00', bidModifier: 0.1 }], removeAudiences: ['80000'] }, accountId: 'g-1' } },
      'set-google-status': { before: { items: [{ kind: 'keyword', id: '51~601', status: 'PAUSED' }], accountId: 'g-1' }, after: { items: [], accountId: 'g-1' } },
    }
    for (const [name, change] of Object.entries(samples)) {
      const request = tool(name).undo!.request(change as never)
      expect('tool' in request, name).toBe(true)
      const parsed = tool((request as { tool: string }).tool).input.safeParse((request as { args: unknown }).args)
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
      expect((request as { args: { accountId?: string } }).args.accountId).toBe('g-1')
    }
  })
})
