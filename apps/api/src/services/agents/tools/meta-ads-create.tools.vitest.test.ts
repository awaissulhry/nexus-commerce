/**
 * Meta step 19 — create-meta-campaign, create-meta-ad-set and copy-meta-ads as the approval gate uses them (Meta, the
 * account, the live reads and the change record are stand-ins): the change contract of every Meta change tool; a create
 * checked by Meta first (validate_only with its recommendations, shown), a copy never; born PAUSED; a run only as a request
 * a person approved, recording the ids Meta made; undo asks the same tool to delete ONLY what that change made (its own
 * record, read again), refuses a background copy and a deletion, and nothing else is deleted. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  campaign: {} as Record<string, unknown>,
  source: {} as Record<string, unknown>,
  dsaDefaults: { payor: 'Shop A', beneficiary: 'Shop A' } as Record<string, string> | null,
  made: {} as Record<string, Record<string, unknown>>,
  changes: {} as Record<string, { toolName: string; after: unknown; undoneAt: Date | null; undoneByApprovalId?: string | null }>,
  check: vi.fn(async (): Promise<unknown> => ({ recommendations: [] })),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-settings.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-settings.js')>()),
  liveCampaign: vi.fn(async (_t: unknown, id: string) => ({ ...structuredClone(h.campaign), id })),
  liveAccountPixels: vi.fn(async () => new Set(['120000000000050'])),
  liveAccountCapabilities: vi.fn(async () => ['CAN_USE_BUDGET_SCHEDULING_API']),
}))
vi.mock('../../marketing/meta-ads/live-create.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-create.js')>()),
  liveDsaDefaults: vi.fn(async () => h.dsaDefaults),
  liveChosenPage: vi.fn(async () => '120000000000080'),
  liveCopySource: vi.fn(async () => structuredClone(h.source)),
  liveCopyTargetAdSet: vi.fn(async () => null),
  liveMadeObject: vi.fn(async (_t: unknown, kind: string, id: string) => ({ kind, id, there: true, status: 'PAUSED', effectiveStatus: 'PAUSED', children: [], childrenMore: false, childrenOn: [], spend: 0, undeletable: null, ...(h.made[id] ?? {}) })),
  liveWhatsAppMarketing: vi.fn(async () => ({ status: 'MARKETING_MESSAGE_ONBOARDED' })),
}))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ timeZone: 'Europe/Rome' })),
}))
vi.mock('../../marketing/meta-ads/catalog-rule.js', () => ({ metaCatalogProblem: vi.fn(async () => null) }))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))
vi.mock('../../../db.js', () => ({
  default: {
    agentChange: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; toolName: string } }) => {
        const row = h.changes[where.id]
        return row && row.toolName === where.toolName ? { after: row.after, undoneAt: row.undoneAt, undoneByApprovalId: row.undoneByApprovalId ?? null } : null
      }),
    },
  },
}))

import { META_ADS_CREATE_TOOLS } from './meta-ads-create.tools.js'
import { liveMadeObject, liveWhatsAppMarketing } from '../../marketing/meta-ads/live-create.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_CREATE_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(tool(name), args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>, p: unknown) => (await tool(name).execute!(ask(tool(name), args), approved(p))) as ToolResult & { data: Record<string, any> }

const C = '120000000000001'
const NEW = '120000000000099'
const CAMPAIGN = {
  id: C, name: 'Campaign A', status: 'PAUSED', effectiveStatus: 'PAUSED', objective: 'OUTCOME_SALES', buyingType: 'AUCTION', smartPromotionType: null, dailyBudget: null, lifetimeBudget: null,
  spendCap: null, canUseSpendCap: true, bidStrategy: null, pacingType: null, promotedObject: null, specialAdCategories: [], specialAdCategory: null, specialAdCategoryCountry: null,
  budgetSharing: false, budgetScheduling: null, reelsTrendingAds: null, advantageState: null,
}
const SOURCE = {
  kind: 'campaign', id: C, name: 'Campaign A', status: 'PAUSED', effectiveStatus: 'PAUSED', campaignId: C, adSetId: null, campaignStatus: 'PAUSED', adSetStatus: null,
  objective: 'OUTCOME_SALES', specialAdCategories: [], smartPromotionType: null, adCount: 2, adSets: [{ id: '120000000000002', name: 'Ad set B', countries: ['IT'], dsaPayor: 'Shop A', dsaBeneficiary: 'Shop A' }], adSetsMore: false,
}
const CREATE = { name: 'Campaign new', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000 }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.check.mockImplementation(async () => ({ recommendations: [] }))
  h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.campaign = structuredClone(CAMPAIGN)
  h.source = structuredClone(SOURCE)
  h.dsaDefaults = { payor: 'Shop A', beneficiary: 'Shop A' }
  h.made = {}
  h.changes = {}
})

describe('the tools', () => {
  it('each is a change a person always approves, with an undo, the #691 truth, money keys and its MATERIAL fields', () => {
    for (const name of ['create-meta-campaign', 'create-meta-ad-set', 'copy-meta-ads']) {
      const t = tool(name)
      expect(t, name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', category: 'advertising' })
      expect(t.requires).toEqual(['ads.campaigns.manage', 'financials.adspend.view'])
      expect(t.undo, name).toBeDefined()
      expect(t.description.endsWith(META_CHANGE_RULES), name).toBe(true)
      expect(t.description, name).toMatch(/PAUSED/)
      expect(t.description, name).toMatch(/SPENDS MONEY/)
      expect(t.restrictedFields, name).toMatchObject({ changes: 'financials.adspend.view', spendsMoneyBecause: 'financials.adspend.view', metaRecommendations: 'financials.adspend.view' })
      expect(MATERIAL_PREVIEW_FIELDS[name], name).toEqual(['basis', 'plan', 'reach'])
      expect(t.consequencesFor!({ removeMade: true, undoOf: 'c1' })).toEqual({ reversibility: 'none' })
      expect(t.consequencesFor!({})).toBeNull()
    }
    expect(tool('copy-meta-ads').consequencesFor!({ kind: 'campaign', sourceId: C, background: true })).toEqual({ reversibility: 'none' })
    expect(() => tool('create-meta-campaign').input.parse({ ...CREATE, specialAdCategories: ['ISSUES_ELECTIONS_POLITICS'] })).toThrow()
    expect(() => tool('create-meta-campaign').input.parse({ ...CREATE, objective: 'CONVERSIONS' })).toThrow()
    expect(() => tool('create-meta-campaign').input.parse({ ...CREATE, name: 'Shop ‮A' })).toThrow()
    // Review A7 — at most 70 included and 70 excluded custom audiences (the gateway confirms at most 150 ids in one change).
    const audiences = (n: number) => Array.from({ length: n }, (_, i) => String(120000000000100 + i))
    const adSet = { campaignId: C, name: 'Ad set B', optimizationGoal: 'LINK_CLICKS', targeting: { countries: ['IT'] } }
    expect(tool('create-meta-ad-set').input.safeParse({ ...adSet, targeting: { countries: ['IT'], customAudienceIds: audiences(70), excludedCustomAudienceIds: audiences(70) } }).success).toBe(true)
    expect(tool('create-meta-ad-set').input.safeParse({ ...adSet, targeting: { countries: ['IT'], customAudienceIds: audiences(71) } }).success).toBe(false)
    expect(tool('create-meta-ad-set').input.safeParse({ ...adSet, targeting: { countries: ['IT'], excludedCustomAudienceIds: audiences(71) } }).success).toBe(false)
    expect(tool('create-meta-campaign').description).toMatch(/message_campaign/)
    expect(tool('copy-meta-ads').description).toMatch(/Meta cannot move an ad|cannot change an ad's ad set/)
  })
})

describe('create-meta-campaign', () => {
  it('Meta checks the create first (validate_only with its recommendations, on the ad account\'s edge); the preview shows them; PAUSED, no spending', async () => {
    h.check.mockImplementationOnce(async () => ({ recommendations: [{ title: 'Use Advantage+ placements', code: 1 }] }))
    const out = await preview('create-meta-campaign', CREATE)
    expect(out.ok).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect((h.check.mock.calls[0] as unknown[])[1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'campaigns', operation: 'campaign.create', recommendations: true, params: expect.objectContaining({ status: 'PAUSED', special_ad_categories: '[]' }) })
    expect(out.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'all' }, requests: [{ step: 1, metaCheck: 'accepted' }], metaRecommendations: [{ title: 'Use Advantage+ placements', code: 1 }] })
  })
  it('a create Meta would refuse is not queued: Meta\'s words', async () => {
    h.check.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): Invalid parameter. Nothing was changed.', '100'), 'campaign.create.check', 'refused') })
    expect(await preview('create-meta-campaign', CREATE)).toEqual({ ok: false, error: expect.stringMatching(/^Meta would refuse step 1 .*Invalid parameter.*Nothing was queued/) })
  })
  it('activate: SPENDS MONEY in the preview', async () => {
    const out = await preview('create-meta-campaign', { ...CREATE, activate: true })
    expect(out.preview.spendsMoney).toBe(true)
    expect(out.preview.warnings[0]).toMatch(/^SPENDS MONEY \(your decision\): Made ACTIVE/)
  })
  it('runs as approved, records the new id; undo asks the same tool to delete it, which reads that change\'s record and the object live', async () => {
    const p = (await preview('create-meta-campaign', CREATE)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: NEW, name: 'Campaign new', status: 'PAUSED', objective: 'OUTCOME_SALES', daily_budget: '5000' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('create-meta-campaign', CREATE, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'campaigns', operation: 'campaign.create', expect: { status: 'PAUSED' } })
    expect(ran.data).toMatchObject({ id: NEW, made: [{ kind: 'campaign', id: NEW }] })
    expect(ran.change!.after).toMatchObject({ op: 'create', made: [{ kind: 'campaign', id: NEW, name: 'Campaign new' }], top: [{ kind: 'campaign', id: NEW }], accountId: 'm-1', adAccountId: '1234567890' })
    const t = tool('create-meta-campaign')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request({ ...ran.change!, id: 'chg-1' })
    expect(back).toEqual({ tool: 'create-meta-campaign', args: { connectionId: 'm-1', removeMade: true, undoOf: 'chg-1', why: 'undo of an earlier create-meta-campaign: delete what it made' } })
    expect(t.input.safeParse((back as { args: unknown }).args).success).toBe(true)

    // The undo itself: the record of THAT change, read again (in this business), and the object live.
    h.changes['chg-1'] = { toolName: 'create-meta-campaign', after: ran.change!.after, undoneAt: null }
    const undoArgs = (back as { args: Record<string, unknown> }).args
    const up = await preview('create-meta-campaign', undoArgs)
    expect(up.ok).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1) // Meta has no check for a delete
    expect(up.preview).toMatchObject({ spendsMoney: false, requests: [{ step: 1, metaCheck: 'no-check' }] })
    // Step 20 re-review 2 — the delete runs only as the request undo-change tied to that change (linkUndoRequest).
    expect(await t.execute!(undoArgs, { can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: up.preview }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: an undo runs through undo-change/) })
    expect(h.send).toHaveBeenCalledTimes(1)
    h.changes['chg-1'].undoneByApprovalId = 'ap-1'
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const removed = await run('create-meta-campaign', undoArgs, up.preview)
    expect(removed.ok).toBe(true)
    expect(h.send.mock.calls[1][1]).toMatchObject({ objectId: NEW, kind: 'campaign', method: 'DELETE', params: {}, operation: 'campaign.delete' })
    expect(removed.change!.after).toMatchObject({ op: 'remove', removed: [{ kind: 'campaign', id: NEW }] })
    expect(t.undo!.request(removed.change!)).toEqual({ refusal: expect.stringMatching(/final/) })
  })
  it('the undo keeps what spent or what holds something the change did not make; deletes nothing a caller names', async () => {
    const after = { op: 'create', made: [{ kind: 'campaign', id: NEW }], top: [{ kind: 'campaign', id: NEW }], madeAt: '2026-10-21T08:00:00.000Z', accountId: 'm-1', adAccountId: '1234567890' }
    h.changes['chg-2'] = { toolName: 'create-meta-campaign', after, undoneAt: null }
    h.made[NEW] = { spend: 3.2 }
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-2' })).toEqual({ ok: false, error: expect.stringMatching(/has spent since it was made.*remove-meta-ads-items/) })
    h.made[NEW] = { children: ['120000000000077'] }
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-2' })).toEqual({ ok: false, error: expect.stringMatching(/did not make \(120000000000077\)/) })
    expect(await preview('create-meta-campaign', { removeMade: true })).toEqual({ ok: false, error: expect.stringMatching(/only the undo of an earlier create-meta-campaign change/) })
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-2', name: 'x' })).toEqual({ ok: false, error: expect.stringMatching(/takes nothing else \(name\)/) })
    h.changes['chg-3'] = { toolName: 'copy-meta-ads', after, undoneAt: null }
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-3' })).toEqual({ ok: false, error: expect.stringMatching(/is not a create-meta-campaign change/) })
    h.changes['chg-4'] = { toolName: 'create-meta-campaign', after: { ...after, adAccountId: '5555555555' }, undoneAt: null }
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-4' })).toEqual({ ok: false, error: expect.stringMatching(/another Meta ad account/) })
    h.changes['chg-5'] = { toolName: 'create-meta-campaign', after, undoneAt: new Date() }
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-5' })).toEqual({ ok: false, error: expect.stringMatching(/undone already/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('fix round 1', () => {
  it('review A4 — a create that reads back otherwise is still recorded (with what it read), so its undo can delete it', async () => {
    const p = (await preview('create-meta-campaign', CREATE)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: NEW, status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '5000' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('create-meta-campaign', CREATE, p)
    expect(ran.ok).toBe(true)
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'not_confirmed', sentence: expect.stringMatching(/Meta made it, but it reads back .*status ACTIVE, not what was asked \(status\)\. Nexus records what Meta made/) })
    expect(ran.data.sentence).toMatch(/0 of 1 requests as asked/)
    expect(ran.data.sentence).toMatch(/Undo puts back only what Meta made\.$/)
    expect(ran.change!.after).toMatchObject({ op: 'create', top: [{ kind: 'campaign', id: NEW }], notAsAsked: expect.stringMatching(/status ACTIVE/) })
    expect(tool('create-meta-campaign').undo!.request({ ...ran.change!, id: 'chg-9' })).toMatchObject({ tool: 'create-meta-campaign', args: { removeMade: true, undoOf: 'chg-9' } })
  })
  it('review A3 — the undo reads what the change made in the ad account\'s time zone', async () => {
    h.changes['chg-6'] = { toolName: 'create-meta-campaign', after: { op: 'create', made: [{ kind: 'campaign', id: NEW }], top: [{ kind: 'campaign', id: NEW }], madeAt: '2026-10-21T08:00:00.000Z', accountId: 'm-1', adAccountId: '1234567890' }, undoneAt: null }
    expect((await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-6' })).ok).toBe(true)
    expect(vi.mocked(liveMadeObject).mock.calls.at(-1)).toEqual([expect.anything(), 'campaign', NEW, '2026-10-21T08:00:00.000Z', 'Europe/Rome'])
    h.made[NEW] = { status: 'ACTIVE', effectiveStatus: 'ACTIVE' }
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-6' })).toEqual({ ok: false, error: expect.stringMatching(/is on: Meta reports spend late/) })
  })
  it('2026-10-22 live — what the undo cannot read is kept in the read\'s own words (never only "could not read")', async () => {
    h.changes['chg-6'] = { toolName: 'create-meta-campaign', after: { op: 'create', made: [{ kind: 'campaign', id: NEW }], top: [{ kind: 'campaign', id: NEW }], madeAt: '2026-10-21T08:00:00.000Z', accountId: 'm-1', adAccountId: '1234567890' }, undoneAt: null }
    vi.mocked(liveMadeObject).mockRejectedValueOnce(new MetaLiveRefusal(`Nexus could not read campaign ${NEW} from Meta: Meta refused the read: Syntax error.`))
    expect(await preview('create-meta-campaign', { removeMade: true, undoOf: 'chg-6' })).toEqual({ ok: false, error: `Nothing is deleted: Nexus could not read campaign ${NEW} from Meta: Meta refused the read: Syntax error — so campaign ${NEW} is kept.` })
  })
  it('review B3 — the WhatsApp onboarding is read for an eligible goal only, and named in the preview', async () => {
    vi.mocked(liveWhatsAppMarketing).mockClear()
    const args = { campaignId: C, name: 'Ad set B', optimizationGoal: 'LINK_CLICKS', dailyBudgetCents: 2000, targeting: { countries: ['IT'] } }
    const out = await preview('create-meta-ad-set', args)
    expect(liveWhatsAppMarketing).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(out.preview.changes)).toMatch(/Meta adds WhatsApp marketing messages/)
    await preview('create-meta-ad-set', { ...args, optimizationGoal: 'REACH' })
    expect(liveWhatsAppMarketing).toHaveBeenCalledTimes(1)
  })
})

describe('create-meta-ad-set', () => {
  it('an EU ad set without the account\'s saved payer / beneficiary: refused in words, nothing checked; with dsa it goes, PAUSED', async () => {
    h.dsaDefaults = null
    const args = { campaignId: C, name: 'Ad set B', optimizationGoal: 'LINK_CLICKS', dailyBudgetCents: 2000, targeting: { countries: ['IT'] } }
    expect(await preview('create-meta-ad-set', args)).toEqual({ ok: false, error: expect.stringMatching(/EU Digital Services Act/) })
    expect(h.check).not.toHaveBeenCalled()
    const out = await preview('create-meta-ad-set', { ...args, dsa: { payor: 'Shop A', beneficiary: 'Shop A' } })
    expect(out.ok).toBe(true)
    expect((h.check.mock.calls[0] as unknown[])[1]).toMatchObject({ kind: 'adaccount', edge: 'adsets', params: expect.objectContaining({ status: 'PAUSED', dsa_payor: 'Shop A', targeting: expect.stringContaining('"advantage_audience":0') }) })
  })
})

describe('copy-meta-ads', () => {
  it('a copy has no check (said); it runs, recording the copy and everything Meta made with it', async () => {
    const args = { kind: 'campaign', sourceId: C, deepCopy: true }
    const out = await preview('copy-meta-ads', args)
    expect(out.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(out.preview.metaCheck.sentence).toMatch(/Meta has no check/)
    h.send.mockImplementationOnce(async () => ({ node: { copied_campaign_id: NEW, ad_object_ids: [{ ad_object_type: 'ad_set', source_id: '120000000000002', copied_id: '120000000000098' }], id: NEW, status: 'PAUSED' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('copy-meta-ads', args, out.preview)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: C, kind: 'campaign', edge: 'copies', params: { status_option: 'PAUSED', deep_copy: 'true' }, expect: { status: 'PAUSED' } })
    expect(ran.change!.after).toMatchObject({ op: 'copy', made: [{ kind: 'campaign', id: NEW }, { kind: 'adset', id: '120000000000098' }], top: [{ kind: 'campaign', id: NEW }] })
  })
  it('a background copy records Meta\'s request id only: no undo, said', async () => {
    h.source = { ...SOURCE, adCount: 12 }
    const args = { kind: 'campaign', sourceId: C, deepCopy: true, background: true }
    const out = await preview('copy-meta-ads', args)
    expect(out.ok).toBe(true)
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000555' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('copy-meta-ads', args, out.preview)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'async_batch_requests' })
    expect(ran.change!.after).toMatchObject({ op: 'background-copy', requestSetId: '120000000000555', made: [], top: [] })
    expect(tool('copy-meta-ads').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/background copy is made by Meta later/) })
  })
})
