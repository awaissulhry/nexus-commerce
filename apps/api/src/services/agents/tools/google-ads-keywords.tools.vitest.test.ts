/**
 * Google Ads changes PR 3 (2026-10-15) — set-google-ad-groups, set-google-keywords and set-google-negatives as the approval
 * gate uses them (Google, the account, the live reads and the change record are stand-ins): the preview is built on
 * Google's check (validateOnly true) and says what spends money; the gate's re-check reads again without a second check;
 * a run happens only as a request a person approved, as ONE request with validateOnly false, and its record holds the ids
 * Google gave what it made; undo puts back what the change did — and the keyword tool removes only the keywords the
 * undone change added.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  findChange: vi.fn(),
  live: { campaigns: [] as unknown[], adGroups: [] as unknown[], keywords: [] as unknown[], negatives: [] as unknown[], matchType: null as string | null },
}))
vi.mock('../../../db.js', () => ({ default: { agentChange: { findFirst: h.findChange } } }))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
}))
vi.mock('../../marketing/google-ads/live-keywords.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-keywords.js')>()),
  liveAdGroups: vi.fn(async () => structuredClone(h.live.adGroups)),
  liveKeywords: vi.fn(async () => structuredClone(h.live.keywords)),
  liveCampaignNegatives: vi.fn(async () => structuredClone(h.live.negatives)),
  liveCampaignKeywordMatchType: vi.fn(async () => h.live.matchType),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_KEYWORDS_TOOLS } from './google-ads-keywords.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_KEYWORDS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ACCOUNT = { accountId: 'g-1', customerId: '1234567890' }
const C = 'customers/1234567890'

const base = { servingStatus: null, primaryStatus: null, subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null }
const SEARCH = { ...base, campaignId: '22', name: 'Search B', status: 'ENABLED', type: 'SEARCH' }
const SHOP = { ...base, campaignId: '23', name: 'Shop C', status: 'PAUSED', type: 'SHOPPING' }
const GROUP_A = { adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 40 }
const KW_1 = { adGroupId: '51', criterionId: '601', keywordId: '51~601', text: 'test term', matchType: 'EXACT', negative: false, status: 'ENABLED', cpcBidCents: 30, effectiveCpcBidCents: 30 }

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  h.findChange.mockReset()
  vi.unstubAllEnvs()
  h.live.campaigns = [SEARCH, SHOP]
  h.live.adGroups = [GROUP_A]
  h.live.keywords = [KW_1]
  h.live.negatives = [{ criterionId: '901', text: 'cheap', matchType: 'PHRASE' }]
  h.live.matchType = null
})

const pick = (p: unknown) => { const { basis, plan, reach } = p as Record<string, unknown>; return { basis, plan, reach } }

describe('the three tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, their re-check fields declared', () => {
    expect(GOOGLE_ADS_KEYWORDS_TOOLS.map((t) => t.name)).toEqual(['set-google-ad-groups', 'set-google-keywords', 'set-google-negatives'])
    for (const t of GOOGLE_ADS_KEYWORDS_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.description).toMatch(/never by a rule/)
    }
  })
})

describe('set-google-keywords', () => {
  const ask = { campaignId: '22', bids: [{ keywordId: '51~601', bidCents: 45 }], add: [{ adGroupId: '51', text: 'new term', matchType: 'PHRASE' }], enable: true }

  it('preview: Google checks it (validateOnly), the raise and the keyword that can serve at once SPEND MONEY; the re-check does not ask Google again', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const out = await tool('set-google-keywords').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(h.mutate.mock.calls[0][1]).toEqual([
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601`, cpcBidMicros: '450000' }, updateMask: 'cpc_bid_micros' } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, status: 'ENABLED', keyword: { text: 'new term', matchType: 'PHRASE' } } } },
    ])
    expect(out.preview).toMatchObject({
      spendsMoney: true,
      spendsMoneyBecause: [
        'Raises the max CPC of 1 keyword: [test term] ("Group A") EUR 0.30 → EUR 0.45.',
        'Adds 1 keyword that can show ads at once: ENABLED, in the enabled ad group "Group A" of the enabled campaign "Search B".',
      ],
      googleCheck: { checked: true, accepted: true },
      reach: { mode: 'live', ...ACCOUNT },
      operations: 2,
    })
    h.mutate.mockClear()
    const again = await tool('set-google-keywords').handler(ask, recheck)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(pick(again.preview)).toEqual(pick(out.preview))
  })

  it('runs only as a request a person approved, as ONE request; the record has Google\'s id; undo puts the bid back and removes only what it added', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const preview = (await tool('set-google-keywords').handler(ask, asker)).preview
    expect((await tool('set-google-keywords').execute!(ask, asker)).error).toMatch(/runs only as an approved request/)
    expect((await tool('set-google-keywords').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })).error).toMatch(/never by a rule/)
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~601` } }, { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~777` } }], ops: 2, requestId: 'r' })
    const run = await tool('set-google-keywords').execute!(ask, approved(preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    expect(run.change).toEqual({
      before: { campaignId: '22', bids: [{ keywordId: '51~601', bidCents: 30 }], ...ACCOUNT },
      after: { campaignId: '22', bids: [{ keywordId: '51~601', bidCents: 45 }], added: [{ keywordId: '51~777', adGroupId: '51', text: 'new term', matchType: 'PHRASE', bidCents: null, status: 'ENABLED' }], ...ACCOUNT },
    })
    expect(run.data).toMatchObject({ added: [{ keywordId: '51~777', text: 'new term', matchType: 'PHRASE', status: 'ENABLED' }], bidsChanged: 1 })

    // Google now holds what it wrote: undo may run. It asks for the old bid and the removal of the keyword it added.
    h.live.keywords = [{ ...KW_1, cpcBidCents: 45, effectiveCpcBidCents: 45 }, { ...KW_1, criterionId: '777', keywordId: '51~777', text: 'new term', matchType: 'PHRASE', cpcBidCents: null, effectiveCpcBidCents: 40 }]
    expect(await tool('set-google-keywords').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-keywords').undo!.request({ ...run.change!, id: 'ch-1' }) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-keywords', args: { accountId: 'g-1', campaignId: '22', bids: [{ keywordId: '51~601', bidCents: 30 }], removeAdded: ['51~777'], undoOf: 'ch-1' } })
    expect(tool('set-google-keywords').input.safeParse(undo.args).success).toBe(true)

    // The undo's preview: the removal is checked against the undone change's record (this business, that campaign).
    h.findChange.mockResolvedValue({ after: run.change!.after, undoneAt: null })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const undoPreview = await tool('set-google-keywords').handler(undo.args, asker)
    expect(undoPreview.ok).toBe(true)
    expect(h.findChange).toHaveBeenCalledWith({ where: { id: 'ch-1', toolName: 'set-google-keywords' }, select: { after: true, undoneAt: true } })
    expect(h.mutate.mock.calls[0][1]).toEqual([
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~777` } },
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601`, cpcBidMicros: '300000' }, updateMask: 'cpc_bid_micros' } },
    ])
    expect(undoPreview.preview).toMatchObject({ spendsMoney: false })
  })

  it('removeAdded is refused without the undone change, and for a keyword that change did not add', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const without = await tool('set-google-keywords').handler({ campaignId: '22', removeAdded: ['51~601'] }, asker)
    expect(without).toMatchObject({ ok: false, error: expect.stringContaining('removeAdded is only the undo of an earlier set-google-keywords change') })
    h.findChange.mockResolvedValue({ after: { campaignId: '22', bids: [], added: [{ keywordId: '51~777' }], ...ACCOUNT }, undoneAt: null })
    const other = await tool('set-google-keywords').handler({ campaignId: '22', removeAdded: ['51~601'], undoOf: 'ch-1' }, asker)
    expect(other).toMatchObject({ ok: false, error: expect.stringContaining('was not added by the change this undoes') })
    h.findChange.mockResolvedValue(null)
    expect(await tool('set-google-keywords').handler({ campaignId: '22', removeAdded: ['51~601'], undoOf: 'ch-9' }, asker)).toMatchObject({ ok: false, error: expect.stringContaining('is not a set-google-keywords change of this business') })
    // The change was undone already.
    const made = { keywordId: '51~601', adGroupId: '51', text: 'test term', matchType: 'EXACT', bidCents: 30, status: 'ENABLED' }
    h.findChange.mockResolvedValue({ after: { campaignId: '22', bids: [], added: [made], ...ACCOUNT }, undoneAt: new Date('2026-10-15T10:00:00Z') })
    expect(await tool('set-google-keywords').handler({ campaignId: '22', removeAdded: ['51~601'], undoOf: 'ch-1' }, asker)).toMatchObject({ ok: false, error: 'Change ch-1 was undone already.' })
    // The change added keywords to another campaign.
    h.findChange.mockResolvedValue({ after: { campaignId: '29', bids: [], added: [made], ...ACCOUNT }, undoneAt: null })
    expect(await tool('set-google-keywords').handler({ campaignId: '22', removeAdded: ['51~601'], undoOf: 'ch-1' }, asker)).toMatchObject({ ok: false, error: 'Change ch-1 added keywords to another campaign or account.' })
    // The keyword moved since that change made it (a person paused it): removing it would overwrite that.
    h.findChange.mockResolvedValue({ after: { campaignId: '22', bids: [], added: [made], ...ACCOUNT }, undoneAt: null })
    h.live.keywords = [{ ...KW_1, status: 'PAUSED' }]
    expect(await tool('set-google-keywords').handler({ campaignId: '22', removeAdded: ['51~601'], undoOf: 'ch-1' }, asker)).toMatchObject({ ok: false, error: expect.stringContaining('moved since it ran — [test term] (51~601): status ENABLED → PAUSED') })
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('the undo of a removal adds each keyword back with the status it had', () => {
    const change = {
      before: { campaignId: '22', bids: [], removed: [{ keywordId: '51~777', adGroupId: '51', text: 'new term', matchType: 'PHRASE', bidCents: null, status: 'PAUSED' }], ...ACCOUNT },
      after: { campaignId: '22', bids: [], ...ACCOUNT },
    }
    const undo = tool('set-google-keywords').undo!.request(change) as { tool: string; args: Record<string, unknown> }
    expect(undo.args).toMatchObject({ accountId: 'g-1', campaignId: '22', add: [{ adGroupId: '51', text: 'new term', matchType: 'PHRASE', status: 'PAUSED' }] })
    expect(undo.args).not.toHaveProperty('enable')
    expect(tool('set-google-keywords').input.safeParse(undo.args).success).toBe(true)
  })

  it('a campaign set to broad match for all keywords: an add is refused without allowBroad (read live)', async () => {
    h.live.matchType = 'BROAD'
    const out = await tool('set-google-keywords').handler({ campaignId: '22', add: [{ adGroupId: '51', text: 'new term', matchType: 'EXACT' }] }, asker)
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('its keyword match type is BROAD') })
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('not sent when the keyword\'s bid moved since it was approved', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const preview = (await tool('set-google-keywords').handler(ask, asker)).preview
    h.live.keywords = [{ ...KW_1, cpcBidCents: 35, effectiveCpcBidCents: 35 }]
    h.mutate.mockClear()
    const run = await tool('set-google-keywords').execute!(ask, approved(preview))
    expect(run.error).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-ad-groups', () => {
  const ask = { campaignId: '23', create: [{ name: 'Group X', defaultBidCents: 25 }] }

  it('a Shopping ad group with its product ad in one request; the record holds Google\'s ids; undo of a create only says to pause or remove it', async () => {
    h.live.adGroups = []
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const out = await tool('set-google-ad-groups').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([
      { adGroupOperation: { create: { resourceName: `${C}/adGroups/-1`, campaign: `${C}/campaigns/23`, name: 'Group X', type: 'SHOPPING_PRODUCT_ADS', status: 'ENABLED', cpcBidMicros: '250000' } } },
      { adGroupAdOperation: { create: { adGroup: `${C}/adGroups/-1`, status: 'ENABLED', ad: { shoppingProductAd: {} } } } },
    ])
    expect(out.preview).toMatchObject({ spendsMoney: false, totals: { adGroupsCreated: 1 } })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ adGroupResult: { resourceName: `${C}/adGroups/71` } }, { adGroupAdResult: { resourceName: `${C}/adGroupAds/71~801` } }], ops: 2, requestId: 'r' })
    const run = await tool('set-google-ad-groups').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(run.change!.after).toEqual({ campaignId: '23', adGroups: [], created: [{ adGroupId: '71', adId: '801', name: 'Group X', type: 'SHOPPING_PRODUCT_ADS', status: 'ENABLED', defaultBidCents: 25 }], ...ACCOUNT })
    expect(run.data).toMatchObject({ created: [{ adGroupId: '71', name: 'Group X', status: 'ENABLED', adId: '801' }] })
    expect(tool('set-google-ad-groups').undo!.request(run.change!)).toEqual({ refusal: 'This change made the ad group ("Group X"): Nexus does not remove ad groups as an undo. Pause or remove it (a status change, or in Google Ads).' })
  })

  it('a rename and a raise: undo asks for the old name and default max CPC through the same tool', async () => {
    const change = { campaignId: '22', change: [{ adGroupId: '51', name: 'Group Z', defaultBidCents: 55 }] }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const preview = (await tool('set-google-ad-groups').handler(change, asker)).preview
    expect(preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: ['Raises the default max CPC of 1 ad group: "Group A" EUR 0.40 → EUR 0.55.'] })
    h.mutate.mockResolvedValue({ responses: [{ adGroupResult: { resourceName: `${C}/adGroups/51` } }], ops: 1, requestId: 'r' })
    const run = await tool('set-google-ad-groups').execute!(change, approved(preview))
    expect(run.change).toEqual({
      before: { campaignId: '22', adGroups: [{ adGroupId: '51', name: 'Group A', defaultBidCents: 40 }], ...ACCOUNT },
      after: { campaignId: '22', adGroups: [{ adGroupId: '51', name: 'Group Z', defaultBidCents: 55 }], ...ACCOUNT },
    })
    h.live.adGroups = [{ ...GROUP_A, name: 'Group Z', cpcBidCents: 55 }]
    expect(await tool('set-google-ad-groups').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-ad-groups').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-ad-groups', args: { accountId: 'g-1', campaignId: '22', change: [{ adGroupId: '51', name: 'Group A', defaultBidCents: 40 }] } })
    expect(tool('set-google-ad-groups').input.safeParse(undo.args).success).toBe(true)
  })
})

describe('set-google-negatives', () => {
  it('adds at the campaign, removes in an ad group; the record has Google\'s criterion ids; undo is the inverse', async () => {
    h.live.keywords = [KW_1, { ...KW_1, criterionId: '701', keywordId: '51~701', text: 'free', negative: true, cpcBidCents: null }]
    const ask = { campaignId: '22', add: [{ text: 'used', matchType: 'PHRASE' }], remove: [{ text: 'free', matchType: 'EXACT', adGroupId: '51' }] }
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const out = await tool('set-google-negatives').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: ['Removes 1 negative keyword: more searches can show the ads of campaign "Search B".'], operations: 2 })
    h.mutate.mockResolvedValue({ responses: [{ campaignCriterionResult: { resourceName: `${C}/campaignCriteria/22~911` } }, {}], ops: 2, requestId: 'r' })
    const run = await tool('set-google-negatives').execute!(ask, approved(out.preview))
    expect(run.change!.after).toEqual({
      campaignId: '22', added: [{ adGroupId: null, text: 'used', matchType: 'PHRASE', criterionId: '911' }], removed: [{ adGroupId: '51', text: 'free', matchType: 'EXACT' }], ...ACCOUNT,
    })
    h.live.keywords = [KW_1]
    h.live.negatives = [{ criterionId: '901', text: 'cheap', matchType: 'PHRASE' }, { criterionId: '911', text: 'used', matchType: 'PHRASE' }]
    expect(await tool('set-google-negatives').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-negatives').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({ tool: 'set-google-negatives', args: { accountId: 'g-1', campaignId: '22', add: [{ text: 'free', matchType: 'EXACT', adGroupId: '51' }], remove: [{ text: 'used', matchType: 'PHRASE' }], why: 'undo of an earlier negative keyword change' } })
    expect(tool('set-google-negatives').input.safeParse(undo.args).success).toBe(true)
  })
})
