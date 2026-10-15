/**
 * Google Ads changes, G7 (2026-10-15) — the exclusion tools as the approval gate uses them (Google, the account and the
 * live reads are stand-ins): the preview is built on Google's check (validate_only); the run is ONE request of an
 * approved change, as a person; undo puts exclusions, brands and links back exactly; a brand named by its name is found
 * through Google's brand lookup, and an unclear name is refused with Google's suggestions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  suggest: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: {
    account: { items: [] as unknown[], keywordList: null as unknown, placementLists: [] as unknown[], other: [] as unknown[] },
    campaign: { items: [] as unknown[], brandLists: [] as unknown[], targeted: 0 },
    lists: [] as unknown[],
    campaigns: [] as unknown[],
  },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-exclusions.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-exclusions.js')>()),
  liveAccountExclusions: vi.fn(async () => structuredClone(h.live.account)),
  liveCampaignExclusions: vi.fn(async () => structuredClone(h.live.campaign)),
  liveExclusionLists: vi.fn(async (_t: unknown, o: { listId?: string }) => ({
    // As Google answers: only the list asked for comes with its content.
    lists: structuredClone(h.live.lists).map((l: any) => (o.listId === l.listId ? l : { ...l, brands: undefined, items: undefined, keywords: undefined })),
    account: structuredClone(h.live.account),
  })),
  suggestBrands: h.suggest,
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveCampaignSettings: vi.fn(async (_t: unknown, id: string) => structuredClone(h.live.campaigns).find((c: any) => c.campaignId === id) ?? null),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_EXCLUSIONS_TOOLS } from './google-ads-exclusions.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_EXCLUSIONS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const campaign = (campaignId: string, name: string, status: string, type = 'SEARCH') => ({
  campaignId, name, status, servingStatus: null, primaryStatus: null, type, subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null,
})
const BRANDS = {
  listId: '42', name: 'Rivals', type: 'BRANDS', itemCount: 1,
  campaigns: [{ campaignId: '21', name: 'Search A', status: 'PAUSED', type: 'SEARCH', mode: 'exclude', criterionId: '601' }],
  adGroups: [], account: null,
  brands: [{ criterionId: '701', entityId: 'b-1', name: 'Brand A', status: 'ENABLED', url: null }],
}

beforeEach(() => {
  h.mutate.mockReset()
  h.suggest.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.live.account = { items: [{ kind: 'ip-block', value: '192.0.2.0/24', criterionId: '902', name: null }], keywordList: null, placementLists: [], other: [] }
  h.live.campaign = { items: [], brandLists: [], targeted: 0 }
  h.live.lists = [structuredClone(BRANDS)]
  h.live.campaigns = [campaign('21', 'Search A', 'PAUSED'), campaign('22', 'Search B', 'ENABLED')]
})

describe('the exclusion tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, undo, their re-check fields declared', () => {
    expect(GOOGLE_ADS_EXCLUSIONS_TOOLS.map((t) => t.name)).toEqual(['set-google-account-exclusions', 'set-google-campaign-exclusions', 'set-google-exclusion-list'])
    for (const t of GOOGLE_ADS_EXCLUSIONS_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true, reversibility: 'full' })
      expect(t.undo).toBeDefined()
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
  })
})

describe('set-google-account-exclusions', () => {
  const ask = { add: [{ kind: 'content-label', value: 'TRAGEDY' }], remove: [{ kind: 'ip-block', value: '192.0.2.0/24' }] }

  it('preview on Google\'s check (a removal SPENDS MONEY); the run is ONE request as a person; undo puts it back exactly', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const out = await tool('set-google-account-exclusions').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(h.mutate.mock.calls[0][1]).toEqual([
      { customerNegativeCriterionOperation: { create: { contentLabel: { type: 'TRAGEDY' } } } },
      { customerNegativeCriterionOperation: { remove: 'customers/1234567890/customerNegativeCriteria/902' } },
    ])
    expect(out.preview).toMatchObject({ spendsMoney: true, operations: 2, googleCheck: { checked: true, accepted: true } })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{}, {}], ops: 2, requestId: 'r' })
    const run = await tool('set-google-account-exclusions').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    expect(run.change!.after).toEqual({ added: [{ kind: 'content-label', value: 'TRAGEDY' }], removed: [{ kind: 'ip-block', value: '192.0.2.0/24' }], accountId: 'g-1', customerId: '1234567890' })
    // The account now reads as the change left it: undo may run, and asks for the opposite through the same tool.
    h.live.account = { items: [{ kind: 'content-label', value: 'TRAGEDY', criterionId: '910', name: null }], keywordList: null, placementLists: [], other: [] }
    expect(await tool('set-google-account-exclusions').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-account-exclusions').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({
      tool: 'set-google-account-exclusions',
      args: { accountId: 'g-1', add: [{ kind: 'ip-block', value: '192.0.2.0/24' }], remove: [{ kind: 'content-label', value: 'TRAGEDY' }], why: 'undo of an earlier account exclusion change' },
    })
    expect(tool('set-google-account-exclusions').input.safeParse(undo.args).success).toBe(true)
    // Moved since (the label taken out by someone else): the undo's "now" differs, so it is not undone over it.
    h.live.account = { items: [], keywordList: null, placementLists: [], other: [] }
    expect(await tool('set-google-account-exclusions').undo!.current(run.change!)).not.toEqual(run.change!.after)
  })

  it('never by a rule; a bad value is refused before Google is asked', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const preview = (await tool('set-google-account-exclusions').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('set-google-account-exclusions').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
    const bad = await tool('set-google-account-exclusions').handler({ add: [{ kind: 'mobile-app', value: 'com.example' }] }, asker)
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/^Not queued: app "com.example"/) })
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-campaign-exclusions', () => {
  it('excludes for one campaign; the record names it; undo takes it out again', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const ask = { campaignId: '22', add: [{ kind: 'placement', value: 'example.com' }] }
    const out = await tool('set-google-campaign-exclusions').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([{ campaignCriterionOperation: { create: { campaign: 'customers/1234567890/campaigns/22', negative: true, placement: { url: 'example.com' } } } }])
    expect(out.preview).toMatchObject({ spendsMoney: false, warnings: [expect.stringMatching(/^Excludes 1 website for campaign "Search B"/)] })
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: 'r' })
    const run = await tool('set-google-campaign-exclusions').execute!(ask, approved(out.preview))
    expect(run.change!.after).toEqual({ campaignId: '22', added: [{ kind: 'placement', value: 'example.com' }], removed: [], accountId: 'g-1', customerId: '1234567890' })
    h.live.campaign = { items: [{ kind: 'placement', value: 'example.com', criterionId: '71', name: null }], brandLists: [], targeted: 0 }
    expect(await tool('set-google-campaign-exclusions').undo!.current(run.change!)).toEqual(run.change!.after)
    expect(tool('set-google-campaign-exclusions').undo!.request(run.change!)).toEqual({
      tool: 'set-google-campaign-exclusions', args: { accountId: 'g-1', campaignId: '22', remove: [{ kind: 'placement', value: 'example.com' }], why: 'undo of an earlier campaign exclusion change' },
    })
  })
})

describe('set-google-exclusion-list', () => {
  it('a brand by its exact name is found through Google\'s lookup; an unclear one is refused with Google\'s suggestions and ids', async () => {
    h.suggest.mockResolvedValue([{ entityId: '/m/0b2', name: 'Brand B', state: 'ENABLED', urls: ['https://brand-b.example'] }, { entityId: '/m/0b3', name: 'Brand B Moto', state: 'ENABLED', urls: [] }])
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const ask = { listId: '42', addBrands: [{ name: 'brand b' }], attachCampaigns: [{ campaignId: '22', mode: 'exclude' }] }
    const out = await tool('set-google-exclusion-list').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.suggest).toHaveBeenCalledWith(expect.anything(), 'brand b')
    expect(h.mutate.mock.calls[0][1]).toEqual([
      { sharedCriterionOperation: { create: { sharedSet: 'customers/1234567890/sharedSets/42', brand: { entityId: '/m/0b2' } } } },
      { campaignCriterionOperation: { create: { campaign: 'customers/1234567890/campaigns/22', negative: true, brandList: { sharedSet: 'customers/1234567890/sharedSets/42' } } } },
    ])
    expect(out.preview).toMatchObject({ spendsMoney: false })
    // Found through Google: Google's name, not labelled.
    expect(JSON.stringify(out.preview)).toContain('Brand B (/m/0b2)')
    expect(JSON.stringify(out.preview)).not.toContain('name as given')
    h.mutate.mockClear()
    const unclear = await tool('set-google-exclusion-list').handler({ listId: '42', addBrands: [{ name: 'Brand' }] }, asker)
    expect(unclear).toMatchObject({ ok: false, error: 'Google has no brand named exactly "Brand"; it suggests: Brand B = /m/0b2 (https://brand-b.example); Brand B Moto = /m/0b3. Give the one you mean by its entityId (or its exact name).' })
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('the run records Google\'s id of a list it made; undo of a content change puts brands and links back', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const make = { create: { name: 'Kids sites', type: 'NEGATIVE_PLACEMENTS' }, addItems: [{ kind: 'placement', value: 'kids.example' }] }
    const preview = (await tool('set-google-exclusion-list').handler(make, asker)).preview
    h.mutate.mockResolvedValue({ responses: [{ sharedSetResult: { resourceName: 'customers/1234567890/sharedSets/49' } }, {}], ops: 2, requestId: 'r' })
    const made = await tool('set-google-exclusion-list').execute!(make, approved(preview))
    expect(made.data).toMatchObject({ listId: '49', type: 'NEGATIVE_PLACEMENTS' })

    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const ask = { listId: '42', addBrands: [{ entityId: 'b-2', name: 'Brand B' }], removeBrands: ['b-1'], detachCampaignIds: ['21'] }
    const out = await tool('set-google-exclusion-list').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: true })
    // A name given with the id is not Google's: shown as given.
    expect(JSON.stringify(out.preview)).toContain('b-2 (name as given, not checked by Google: Brand B)')
    expect(h.suggest).not.toHaveBeenCalled()
    h.mutate.mockResolvedValue({ responses: [{}, {}, {}], ops: 3, requestId: 'r' })
    const run = await tool('set-google-exclusion-list').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    h.live.lists = [{ ...structuredClone(BRANDS), campaigns: [], brands: [{ criterionId: '702', entityId: 'b-2', name: 'Brand B', status: 'ENABLED', url: null }] }]
    expect(await tool('set-google-exclusion-list').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-exclusion-list').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({
      tool: 'set-google-exclusion-list',
      args: {
        accountId: 'g-1', listId: '42',
        addBrands: [{ entityId: 'b-1', name: 'Brand A' }], removeBrands: ['b-2'],
        attachCampaigns: [{ campaignId: '21', mode: 'exclude' }],
        why: 'undo of an earlier exclusion list change',
      },
    })
    expect(tool('set-google-exclusion-list').input.safeParse(undo.args).success).toBe(true)
  })

  it('a list it made: before and after name Google\'s id; undo takes its content and links back out (the list stays); no id from Google: undo says so', async () => {
    h.live.account = { items: [], keywordList: null, placementLists: [], other: [] }
    h.live.lists = []
    h.mutate.mockResolvedValue({ responses: [], ops: 4, requestId: null })
    const make = { create: { name: 'Kids sites', type: 'NEGATIVE_PLACEMENTS' }, addItems: [{ kind: 'placement', value: 'kids.example' }], attachCampaigns: [{ campaignId: '22' }], attachToAccount: true }
    const out = await tool('set-google-exclusion-list').handler(make, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([
      { sharedSetOperation: { create: { resourceName: 'customers/1234567890/sharedSets/-1', name: 'Kids sites', type: 'NEGATIVE_PLACEMENTS' } } },
      { sharedCriterionOperation: { create: { sharedSet: 'customers/1234567890/sharedSets/-1', placement: { url: 'kids.example' } } } },
      { campaignSharedSetOperation: { create: { campaign: 'customers/1234567890/campaigns/22', sharedSet: 'customers/1234567890/sharedSets/-1' } } },
      { customerNegativeCriterionOperation: { create: { placementList: { sharedSet: 'customers/1234567890/sharedSets/-1' } } } },
    ])
    h.mutate.mockResolvedValue({ responses: [{ sharedSetResult: { resourceName: 'customers/1234567890/sharedSets/49' } }, {}, {}, {}], ops: 4, requestId: 'r' })
    const made = await tool('set-google-exclusion-list').execute!(make, approved(out.preview))
    expect(made.ok).toBe(true)
    expect(made.change!.before).toMatchObject({ listId: '49' })
    expect(made.change!.after).toMatchObject({
      listId: '49', created: true, addedItems: [{ kind: 'placement', value: 'kids.example' }], attached: [{ campaignId: '22', mode: 'exclude' }], accountAttached: true,
    })
    // The list as the change left it: undo may run; it takes the content and the links back out, and the list stays.
    h.live.lists = [{
      listId: '49', name: 'Kids sites', type: 'NEGATIVE_PLACEMENTS', itemCount: 1,
      campaigns: [{ campaignId: '22', name: 'Search B', status: 'ENABLED', type: 'SEARCH', mode: 'exclude', criterionId: null }],
      adGroups: [], account: { criterionId: '906' }, items: [{ kind: 'placement', value: 'kids.example', criterionId: '511', name: null }],
    }]
    expect(await tool('set-google-exclusion-list').undo!.current(made.change!)).toEqual(made.change!.after)
    const undo = tool('set-google-exclusion-list').undo!.request(made.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({
      tool: 'set-google-exclusion-list',
      args: {
        accountId: 'g-1', listId: '49', removeItems: [{ kind: 'placement', value: 'kids.example' }], detachCampaignIds: ['22'], detachFromAccount: true,
        why: 'undo of an earlier exclusion list change (the list it made stays)',
      },
    })
    expect(tool('set-google-exclusion-list').input.safeParse(undo.args).success).toBe(true)

    // Google answered without the new list's id: the record says 'new' on both sides, and undo says why it cannot run.
    h.live.lists = []
    h.mutate.mockResolvedValue({ responses: [{}, {}, {}, {}], ops: 4, requestId: 'r' })
    const noId = await tool('set-google-exclusion-list').execute!(make, approved(out.preview))
    expect(noId.ok).toBe(true)
    expect(noId.change!.before).toMatchObject({ listId: 'new' })
    expect(noId.change!.after).toMatchObject({ listId: 'new', created: true })
    expect(await tool('set-google-exclusion-list').undo!.current(noId.change!)).toEqual(noId.change!.after)
    expect(tool('set-google-exclusion-list').undo!.request(noId.change!)).toEqual({ refusal: expect.stringMatching(/^Google did not return the list's id/) })
  })

  it('a placement list put on the account: undo takes it off; a link taken off since shows as moved (not undone over it)', async () => {
    const PLACEMENTS = { listId: '41', name: 'Bad sites', type: 'NEGATIVE_PLACEMENTS', itemCount: 0, campaigns: [], adGroups: [], account: null, items: [] }
    h.live.lists = [structuredClone(PLACEMENTS)]
    h.live.account = { items: [], keywordList: null, placementLists: [], other: [] }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const ask = { listId: '41', attachToAccount: true }
    const out = await tool('set-google-exclusion-list').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([{ customerNegativeCriterionOperation: { create: { placementList: { sharedSet: 'customers/1234567890/sharedSets/41' } } } }])
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: 'r' })
    const run = await tool('set-google-exclusion-list').execute!(ask, approved(out.preview))
    expect(run.change!.after).toMatchObject({ listId: '41', accountAttached: true })
    h.live.lists = [{ ...structuredClone(PLACEMENTS), account: { criterionId: '904' } }]
    expect(await tool('set-google-exclusion-list').undo!.current(run.change!)).toEqual(run.change!.after)
    expect(tool('set-google-exclusion-list').undo!.request(run.change!)).toEqual({
      tool: 'set-google-exclusion-list', args: { accountId: 'g-1', listId: '41', detachFromAccount: true, why: 'undo of an earlier exclusion list change' },
    })
    h.live.lists = [structuredClone(PLACEMENTS)]
    expect(await tool('set-google-exclusion-list').undo!.current(run.change!)).not.toEqual(run.change!.after)
  })
})
