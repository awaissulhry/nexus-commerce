/**
 * Meta step 28 — apply-meta-recommendations, create-meta-experiment, set-meta-experiment and end-meta-experiment as the
 * approval gate uses them (Meta, the account and the live reads are stand-ins): the change contract of every Meta change
 * tool; previews from the live state that say SPENDS MONEY and that Meta has no check; a run only as a request a person
 * approved, the request sent as the kit builds it (its own gateway operation, object kind and edge); an apply's objects
 * read back and its copies found; undo through the apply's restore and set-meta-experiment, valid for their own input; no
 * undo where Meta has none; a study with another account's objects refused. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown>,
  chosen: { connectionId: 'm-1', adAccountId: '1234567890', pageId: '120000000000010', businessId: '120000000000090' } as Record<string, unknown>,
  rec: null as Record<string, unknown> | null,
  targets: new Map<string, Record<string, unknown>>(),
  copies: [] as Array<Record<string, unknown>> | null,
  study: null as Record<string, unknown> | null,
  foreign: null as string | null,
  people: new Set<string>(['100000000000001', '100000000000002']),
  accountFails: false,
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => { if (h.accountFails) throw new Error('connection to the database lost'); return h.account }) }))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => h.chosen),
}))
vi.mock('../../marketing/meta-ads/live-settings.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-settings.js')>()),
  liveAccountPixels: vi.fn(async () => new Set(['120000000000050'])),
}))
vi.mock('../../marketing/meta-ads/live-optimize-changes.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/meta-ads/live-optimize-changes.js')>()
  return {
    ...actual,
    liveRecommendation: vi.fn(async (_t: unknown, signature: string) => (h.rec && h.rec.signature === signature ? structuredClone(h.rec) : null)),
    liveApplyTargets: vi.fn(async (_t: unknown, ids: string[], level: string) => {
      const out = []
      for (const id of ids) {
        const t = h.targets.get(id)
        if (!t || (level !== 'adset-or-campaign' && t.kind !== level)) return { refusal: `${id} is not of the chosen ad account.` }
        out.push(structuredClone(t))
      }
      return out
    }),
    liveNewCopies: vi.fn(async () => (h.copies ? structuredClone(h.copies) : null)),
    liveStudy: vi.fn(async () => { if (!h.study) throw new (await import('../../marketing/meta-ads/live.js')).MetaLiveRefusal('That study does not touch the ad account this business chose.'); return structuredClone(h.study) }),
    studyForeignProblem: vi.fn(async () => h.foreign),
    liveOpenStudies: vi.fn(async () => ({ open: 2, read: 2, more: false, openLifts: [] })),
    liveObjectStudies: vi.fn(async () => []),
    liveAccountBusiness: vi.fn(async () => '120000000000090'),
    liveAccountCustomConversions: vi.fn(async () => new Set<string>()),
    liveAccountPeople: vi.fn(async () => h.people),
    livePageVideo: vi.fn(async (_t: unknown, _p: string, id: string) => ({ id, title: null, published: false })),
    livePageVideoTest: vi.fn(async (_t: unknown, _p: string, id: string) => ({ id, name: 'Reels', publishStatus: null, controlVideoId: '1', videoIds: [], concluded: null })),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_OPTIMIZE_CHANGES_TOOLS } from './meta-ads-optimize-changes.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest, metaObjectState } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_OPTIMIZE_CHANGES_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(tool(name), args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>, p: unknown, extra: Partial<ToolContext> = {}) => (await tool(name).execute!(ask(tool(name), args), approved(p, extra))) as ToolResult & { data: Record<string, any> }

const S1 = '120000000000201'
const C1 = '120000000000101'
const STUDY = '120000000000041'
const NOW = Math.floor(Date.now() / 1000)
const iso = (unix: number) => new Date(unix * 1000).toISOString()
const adSet = (o: Record<string, unknown> = {}) => ({
  kind: 'adset', id: S1, name: 'Ad set B', status: 'ACTIVE', effectiveStatus: 'ACTIVE', dailyBudget: '5000', lifetimeBudget: null, campaignId: C1, campaignStatus: 'ACTIVE',
  campaignHasBudget: false, optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS', destinationType: 'WEBSITE', advantageAudience: 0, placements: { publisher_platforms: ['facebook'] },
  adSetId: null, adSetStatus: null, creativeId: null, ...o,
})
const STUDY_LIVE = {
  id: STUDY, name: 'Audience test', description: 'Two audiences', type: 'SPLIT_TEST', businessId: '120000000000090', startTime: NOW - 86400, endTime: NOW + 6 * 86400,
  observationEndTime: null, cooldownStartTime: null, canceled: false, state: 'running',
  cells: [{ id: '120000000000061', name: 'A', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [S1], ads: [] }, { id: '120000000000062', name: 'B', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: ['120000000000202'], ads: [] }],
  cellsNote: null, objectives: [], viewers: ['100000000000001'],
}

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  h.check.mockReset(); h.check.mockImplementation(async () => undefined)
  h.send.mockReset()
  h.rec = { signature: '1234567', type: 'SCALE_GOOD_CAMPAIGN', stage: 'mid_flight_recommendation', objectIds: [S1], adsManagerUrl: null, time: null }
  h.targets = new Map([[S1, adSet()], ['120000000000202', adSet({ id: '120000000000202', name: 'Ad set C' })], [C1, { ...adSet({ kind: 'campaign', id: C1, name: 'Campaign A' }) }]])
  h.copies = []
  h.accountFails = false
  h.study = structuredClone(STUDY_LIVE)
  h.foreign = null
})

describe('the tools', () => {
  it('each is a change a person always approves, with its MATERIAL fields and the #691 truth; undo where Meta allows one', () => {
    for (const t of META_ADS_OPTIMIZE_CHANGES_TOOLS) {
      expect(t, t.name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising' })
      expect(t.description.endsWith(META_CHANGE_RULES), t.name).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[t.name], t.name).toEqual(['basis', 'plan', 'reach'])
      expect(t.requires![0]).toBe('ads.campaigns.manage')
    }
    expect(Object.fromEntries(META_ADS_OPTIMIZE_CHANGES_TOOLS.map((t) => [t.name, [t.reversibility, !!t.undo]]))).toEqual({
      'apply-meta-recommendations': ['partial', true], 'create-meta-experiment': ['none', false], 'set-meta-experiment': ['partial', true], 'end-meta-experiment': ['none', false],
    })
    expect(tool('apply-meta-recommendations').requires).toEqual(['ads.campaigns.manage', 'financials.adspend.view'])
    expect(tool('apply-meta-recommendations').restrictedFields).toMatchObject({ changes: 'financials.adspend.view', spendsMoneyBecause: 'financials.adspend.view', steps: 'financials.adspend.view' })
    expect(tool('set-meta-experiment').consequencesFor!({ action: 'delete-page-video-test' })).toEqual({ reversibility: 'none' })
    expect(tool('apply-meta-recommendations').description).toMatch(/SPENDS MONEY/)
    expect(() => tool('end-meta-experiment').input.parse({ studyId: STUDY })).toThrow()
  })
})

describe('apply-meta-recommendations', () => {
  const args = { signature: '1234567', budgetRaises: [{ objectId: S1, additionalBudgetCents: 6000 }] }
  it('a budget raise: preview from the live recommendation, SPENDS MONEY, "Meta has no check", plan stable on the re-check', async () => {
    const out = await preview('apply-meta-recommendations', args)
    expect(out.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(out.preview).toMatchObject({ spendsMoney: true, requests: [{ step: 1, metaCheck: 'no-check' }] })
    expect(out.preview.metaCheck.sentence).toMatch(/Meta has no check/)
    expect(out.preview.warnings.join(' ')).toMatch(/SPENDS MONEY \(your decision\): A daily budget raise of 60.00 EUR/)
    const again = await preview('apply-meta-recommendations', args, recheck)
    expect([again.preview.basis, again.preview.plan]).toEqual([out.preview.basis, out.preview.plan])
  })
  it('runs as approved, reads the ad set back, records it; undo puts the old budget back through the restore', async () => {
    const p = (await preview('apply-meta-recommendations', args)).preview
    h.send.mockImplementationOnce(async () => { h.targets.set(S1, adSet({ dailyBudget: '11000' })); return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('apply-meta-recommendations', args, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toEqual({
      objectId: 'act_1234567890', kind: 'adaccount', edge: 'recommendations', operation: 'recommendation.apply', budget: false, readBackInPost: false,
      params: { recommendation_signature: '"1234567"', extra_data: JSON.stringify({ adsets: JSON.stringify([{ ad_object_id: S1, additional_budget: 6000 }]) }) },
    })
    expect(ran.data.readBack).toEqual([{ kind: 'adset', id: S1, name: 'Ad set B', now: { daily_budget: '11000', lifetime_budget: null } }])
    expect(ran.change!.after).toMatchObject({ type: 'SCALE_GOOD_CAMPAIGN', objects: [{ id: S1, fields: { daily_budget: '11000' } }], accountId: 'm-1', adAccountId: '1234567890' })
    // Meta's 4-an-hour limit learns the ad set's budget change.
    expect((await metaObjectState('m-1', S1)).budgetChanges).toHaveLength(1)
    const t = tool('apply-meta-recommendations')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.targets.set(S1, adSet({ dailyBudget: '9000' }))
    expect(await t.undo!.current(ran.change!)).not.toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'apply-meta-recommendations', args: { connectionId: 'm-1', restore: { type: 'SCALE_GOOD_CAMPAIGN', items: [{ kind: 'adset', id: S1, dailyBudgetCents: 5000 }] }, why: 'undo of an applied Meta SCALE_GOOD_CAMPAIGN recommendation' } })
    expect(t.input.safeParse((back as { args: unknown }).args).success).toBe(true)
    // The restore itself: step 18's ad set rule, read back, no undo of its own.
    h.targets.set(S1, adSet({ dailyBudget: '11000' }))
    const restoreArgs = (back as { args: Record<string, unknown> }).args
    const rp = (await preview('apply-meta-recommendations', restoreArgs)).preview
    expect(rp).toMatchObject({ spendsMoney: false, requests: [{ metaCheck: 'no-check' }] })
    h.send.mockImplementationOnce(async () => ({ node: { id: S1, daily_budget: '5000' }, readBack: 'second-read', waitedMs: 0 }))
    const restored = await run('apply-meta-recommendations', restoreArgs, rp)
    expect(h.send.mock.calls[1][1]).toMatchObject({ objectId: S1, kind: 'adset', operation: 'adset.settings', params: { daily_budget: '5000' }, budget: true, expect: { daily_budget: '5000' } })
    expect(t.undo!.request(restored.change!)).toEqual({ refusal: expect.stringMatching(/was the undo of an apply/) })
    expect(t.consequencesFor!(restoreArgs)).toEqual({ reversibility: 'none' })
  })
  it('copies Meta makes: always SPENDS MONEY; the copies found are recorded and undo pauses them', async () => {
    h.rec = { ...h.rec!, type: 'CONVERSION_LEADS_OPTIMIZATION' }
    // Meta's copies may run: only with the person's explicit word (like activate: true on a create).
    expect(await preview('apply-meta-recommendations', { signature: '1234567' })).toEqual({ ok: false, error: expect.stringMatching(/allowNewObjects: true/) })
    const p = (await preview('apply-meta-recommendations', { signature: '1234567', allowNewObjects: true })).preview
    expect(p.spendsMoneyBecause.join(' ')).toMatch(/does not say whether they start running/)
    h.copies = [
      { kind: 'adset', id: '120000000000209', name: 'Ad set B – Copy', status: 'ACTIVE', sourceId: S1, foundBy: 'source' },
      { kind: 'adset', id: '120000000000210', name: 'Made by hand?', status: 'ACTIVE', sourceId: null, foundBy: 'time' },
    ]
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const startedAt = Math.floor(Date.now() / 1000)
    const ran = await run('apply-meta-recommendations', { signature: '1234567', allowNewObjects: true }, p)
    expect(ran.data.copiesSentence).toMatch(/2 new ad sets \(120000000000209: ACTIVE, 120000000000210: ACTIVE, found by its time only\) — 2 are ACTIVE and can spend/)
    // Review A4 — found by Meta's source field, in the account's ad sets changed since the run started (never earlier).
    const { liveNewCopies } = await import('../../marketing/meta-ads/live-optimize-changes.js')
    const call = vi.mocked(liveNewCopies).mock.calls.at(-1)!
    expect([call[1], [...call[2]], [...call[3]]]).toEqual(['adset', [S1], [C1]])
    expect(call[4]).toBeGreaterThanOrEqual(startedAt)
    const back = tool('apply-meta-recommendations').undo!.request(ran.change!)
    expect(back).toMatchObject({ tool: 'apply-meta-recommendations', args: { restore: { items: [{ kind: 'adset', id: '120000000000209', status: 'PAUSED' }, { kind: 'adset', id: '120000000000210', status: 'PAUSED', foundBy: 'time' }] } } })
    expect(tool('apply-meta-recommendations').input.safeParse((back as { args: unknown }).args).success).toBe(true)
    h.targets.set('120000000000209', adSet({ id: '120000000000209' }))
    h.targets.set('120000000000210', adSet({ id: '120000000000210' }))
    const undoPreview = (await preview('apply-meta-recommendations', (back as { args: Record<string, unknown> }).args)).preview
    expect(undoPreview.warnings.join(' ')).toMatch(/found by its time only/)
    // Follow-up — the answer says plainly that copies Meta makes later are not found by the undo.
    expect(ran.data.copiesSentence).toMatch(/Copies Meta makes LATER are not found by the undo/)
    // Copies Nexus could not read: no undo, said.
    h.copies = null
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const blind = await run('apply-meta-recommendations', { signature: '1234567', allowNewObjects: true }, p)
    expect(tool('apply-meta-recommendations').undo!.request(blind.change!)).toEqual({ refusal: expect.stringMatching(/could not read the copies/) })
  })
  it('review A7 — a failure after Meta applied it never drops the record or its undo; the answer says what was not read', async () => {
    const p = (await preview('apply-meta-recommendations', args)).preview
    h.send.mockImplementationOnce(async () => { h.accountFails = true; return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('apply-meta-recommendations', args, p)
    expect(ran.ok).toBe(true)
    expect(ran.data.nexusNote).toMatch(/^Meta applied it\. Nexus could not open the account again.*database lost/)
    expect(ran.change!.before).toMatchObject({ undo: [{ kind: 'adset', id: S1, dailyBudgetCents: 5000 }] })
    expect(ran.change!.after).toMatchObject({ objects: [{ id: S1, fields: { daily_budget: '11000' } }], accountId: 'm-1' })
  })
  it('Advantage+ audience: no undo in Nexus (targeting is set-meta-targeting\'s), said before and after', async () => {
    h.rec = { ...h.rec!, type: 'ADVANTAGE_PLUS_AUDIENCE' }
    const p = (await preview('apply-meta-recommendations', { signature: '1234567' })).preview
    expect(p.warnings.join(' ')).toMatch(/No undo in Nexus: .*set-meta-targeting/)
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('apply-meta-recommendations', { signature: '1234567' }, p)
    expect(await tool('apply-meta-recommendations').undo!.current(ran.change!)).toEqual(ran.change!.after)
    expect(tool('apply-meta-recommendations').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/set-meta-targeting/) })
  })
  it('a stale signature, a type Meta does not apply, a run nobody approved: refused, nothing sent', async () => {
    expect(await preview('apply-meta-recommendations', { signature: '7654321' })).toEqual({ ok: false, error: expect.stringMatching(/no longer lists a recommendation with this signature/) })
    h.rec = { ...h.rec!, type: 'PIXEL_UPSELL' }
    expect(await preview('apply-meta-recommendations', { signature: '1234567' })).toEqual({ ok: false, error: expect.stringMatching(/does not apply PIXEL_UPSELL by API/) })
    h.rec = { ...h.rec!, type: 'SCALE_GOOD_CAMPAIGN' }
    const p = (await preview('apply-meta-recommendations', args)).preview
    const auto = await tool('apply-meta-recommendations').execute!(ask(tool('apply-meta-recommendations'), args), approved(p, { decidedVia: 'auto' }))
    expect(auto).toMatchObject({ ok: false, error: expect.stringMatching(/only when a person approved it/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('create-meta-experiment', () => {
  const ab = { kind: 'ab-test', name: 'Audience test', startTime: iso(NOW + 86400), endTime: iso(NOW + 15 * 86400), cells: [{ name: 'A', percent: 50, adSetIds: [S1] }, { name: 'B', percent: 50, adSetIds: ['120000000000202'] }] }
  it('an A/B test on the account\'s portfolio; Meta\'s new id is the answer; no undo (Meta cannot delete a study)', async () => {
    const p = (await preview('create-meta-experiment', ab)).preview
    expect(p).toMatchObject({ spendsMoney: false, requests: [{ metaCheck: 'no-check' }] })
    h.send.mockImplementationOnce(async () => ({ node: { id: STUDY, name: 'Audience test' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('create-meta-experiment', ab, p)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000090', kind: 'business', edge: 'ad_studies', operation: 'study.create', expect: { name: 'Audience test' } })
    expect(ran.data).toMatchObject({ id: STUDY, kind: 'study', type: 'SPLIT_TEST' })
    expect(ran.change!.after).toMatchObject({ kind: 'study', id: STUDY })
  })
  it('round 2 — "on" in the preview is deliversNow (configured status chain), not Meta\'s effective status', async () => {
    // Its own effective status says ACTIVE, but its campaign is paused: NOT on. The other is IN_PROCESS under active parents: on.
    h.targets.set(S1, adSet({ name: 'Stale active', effectiveStatus: 'ACTIVE', campaignStatus: 'PAUSED' }))
    h.targets.set('120000000000202', adSet({ id: '120000000000202', name: 'In review', effectiveStatus: 'IN_PROCESS' }))
    const p = (await preview('create-meta-experiment', ab)).preview
    expect(p.warnings.join(' ')).toMatch(/1 on, 1 not on/)
    const notOn = p.warnings.find((w: string) => w.startsWith('Not on now'))!
    expect(notOn).toMatch(/Stale active/)
    expect(notOn).not.toMatch(/In review/)
  })
  it('an object another account owns: refused before any change', async () => {
    h.targets.delete('120000000000202')
    expect(await preview('create-meta-experiment', ab)).toEqual({ ok: false, error: expect.stringMatching(/is not of the chosen ad account/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('set-meta-experiment and end-meta-experiment', () => {
  it('rename a running study; undo puts the old name back through set-meta-experiment, read live first', async () => {
    const args = { action: 'update', studyId: STUDY, name: 'Audience test 2' }
    const p = (await preview('set-meta-experiment', args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: STUDY, name: 'Audience test 2' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-experiment', args, p)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: STUDY, kind: 'adstudy', operation: 'study.update', params: { name: 'Audience test 2' } })
    h.study = { ...structuredClone(STUDY_LIVE), name: 'Audience test 2' }
    const t = tool('set-meta-experiment')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'set-meta-experiment', args: { connectionId: 'm-1', action: 'update', studyId: STUDY, name: 'Audience test', why: 'undo of an earlier Meta study change' } })
    expect(t.input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('follow-ups — adding objects reads the OTHER open lifts first (Nexus\'s one-test rule); a removal is read back after the run', async () => {
    const { liveOpenStudies, liveStudy } = await import('../../marketing/meta-ads/live-optimize-changes.js')
    vi.mocked(liveOpenStudies).mockResolvedValueOnce({ open: 2, read: 2, more: false, openLifts: [{ studyId: '120000000000049', name: 'Account lift', type: 'LIFT', state: 'running', startTime: null, endTime: null, wholeAccount: true }] })
    h.targets.set('120000000000203', adSet({ id: '120000000000203', name: 'Ad set D' }))
    expect(await preview('set-meta-experiment', { action: 'update', studyId: STUDY, addObjects: [{ cellId: '120000000000061', adSetIds: ['120000000000203'] }] })).toEqual({ ok: false, error: expect.stringMatching(/measured by study "Account lift".*Nexus's own rule/) })
    // A planned study's cell removed: after the run Nexus reads it again and says whether Meta removed it.
    const cell = (id: string, name: string, treatment: number, adSet: string) => ({ id, name, treatment, control: null, adAccounts: [], campaigns: [], adSets: [adSet], ads: [] })
    h.study = { ...structuredClone(STUDY_LIVE), state: 'planned', startTime: NOW + 86400, endTime: NOW + 6 * 86400, cells: [cell('120000000000061', 'A', 50, S1), cell('120000000000062', 'B', 40, '120000000000202'), cell('120000000000063', 'C', 10, '120000000000204')] }
    const args = { action: 'update', studyId: STUDY, removeCellIds: ['120000000000063'] }
    const p = (await preview('set-meta-experiment', args)).preview
    h.send.mockImplementationOnce(async () => { h.study = { ...h.study!, cells: (h.study!.cells as Array<{ id: string }>).filter((c) => c.id !== '120000000000063') }; return { node: { id: STUDY, name: 'Audience test' }, readBack: 'second-read', waitedMs: 0 } })
    const ran = await run('set-meta-experiment', args, p)
    expect(ran.data.removedCells).toBe('Meta removed cell 120000000000063 (read back).')
    vi.mocked(liveStudy).mockClear()
  })
  it('a study that also holds another account\'s objects: refused, nothing sent', async () => {
    h.foreign = 'Study 120000000000041 also measures another ad account: Nexus changes a study only when everything in it is the chosen ad account\'s.'
    expect(await preview('set-meta-experiment', { action: 'update', studyId: STUDY, name: 'x' })).toEqual({ ok: false, error: expect.stringMatching(/another ad account/) })
    expect(await preview('end-meta-experiment', { studyId: STUDY, endAt: iso(NOW + 900) })).toEqual({ ok: false, error: expect.stringMatching(/another ad account/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('end early: the end named goes as end_time; the plan is the same on the re-check (never "now")', async () => {
    const args = { studyId: STUDY, endAt: iso(NOW + 900) }
    const p = (await preview('end-meta-experiment', args)).preview
    expect(p.warnings.join(' ')).toMatch(/LIVE-PROBES EX-023/)
    const again = await preview('end-meta-experiment', args, recheck)
    expect(again.preview.plan).toBe(p.plan)
    h.send.mockImplementationOnce(async () => ({ node: { id: STUDY, end_time: NOW + 900 }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('end-meta-experiment', args, p)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: STUDY, kind: 'adstudy', operation: 'study.end', params: { end_time: String(NOW + 900) } })
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done' })
  })
})
