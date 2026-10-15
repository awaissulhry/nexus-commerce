/**
 * Google Ads changes, G9 (2026-10-15) — the experiment and campaign draft tools as the approval gate uses them (Google,
 * the account and the live reads are stand-ins). Create, change and a draft's create / rename / remove are mutates that
 * Google checks (validate_only); schedule, end, promote, graduate and a draft's promote are actions on their own endpoint,
 * checked there (validateOnly) — never through a mutate. A run sends ONE request, as the approver, and says Google's
 * long-running work is started, not done. Undo: remove an experiment never scheduled, end a scheduled one, pause a
 * graduated campaign, remove a draft made. Ids and names are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  action: vi.fn(),
  operation: vi.fn(),
  asyncErrors: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: { experiments: [] as any[], campaigns: [] as any[], names: [] as any[], drafts: [] as any[], settings: {} as Record<string, any>, budgets: [] as any[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-experiments.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-experiments.js')>()),
  liveExperiment: vi.fn(async (_t: unknown, id: string) => structuredClone(h.live.experiments.find((e) => e.experimentId === id) ?? null)),
  liveExperimentList: vi.fn(async () => structuredClone(h.live.experiments)),
  liveExperimentCampaigns: vi.fn(async (_t: unknown, ids: string[]) => structuredClone(h.live.campaigns.filter((c) => ids.includes(c.campaignId)))),
  liveCampaignNames: vi.fn(async () => structuredClone(h.live.names)),
  liveCampaignDrafts: vi.fn(async () => structuredClone(h.live.drafts)),
  liveSettingsWithDrafts: vi.fn(async (_t: unknown, id: string) => structuredClone(h.live.settings[id] ?? null)),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveBudgets: vi.fn(async () => structuredClone(h.live.budgets)),
}))
vi.mock('../../marketing/google-ads/experiment-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/experiment-client.js')>()),
  sendExperimentAction: h.action,
  readLongRunningOperation: h.operation,
  readAsyncErrors: h.asyncErrors,
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_EXPERIMENT_TOOLS } from './google-ads-experiments.tools.js'
import { GOOGLE_CHANGE_RULES } from './google-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { GoogleAdsWriteError } from '../../marketing/google-ads/write-client.js'
import { localFailure } from '../../marketing/google-ads/errors.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_EXPERIMENT_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })

const CUSTOMER = 'customers/1234567890'
const EXP = `${CUSTOMER}/experiments/31`
const OP = `${CUSTOMER}/operations/op-1`
const BUDGET = { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false, period: 'DAILY', status: 'ENABLED' }
const C21 = { campaignId: '21', name: 'Search A', status: 'ENABLED', type: 'SEARCH', bidding: 'MANUAL_CPC', experimentType: 'BASE', baseCampaignId: null, start: null, end: null, budget: BUDGET }
const C22 = { ...C21, campaignId: '22', name: 'Search A [experiment]', experimentType: 'DRAFT', baseCampaignId: '21' }
const C23 = { ...C21, campaignId: '23', name: 'Search A [experiment]', experimentType: 'EXPERIMENT', baseCampaignId: '21' }
const SETUP = {
  experimentId: '31', resourceName: EXP, name: 'Test A', description: null, type: 'SEARCH_CUSTOM', status: 'SETUP', start: '2026-11-01', end: '2026-11-30',
  suffix: ' [experiment]', syncEnabled: false, promoteStatus: null, operation: null,
  arms: [
    { armId: '31~1', name: 'Control', control: true, trafficSplitPct: 50, campaignIds: ['21'], inDesignCampaignIds: [] },
    { armId: '31~2', name: 'Treatment', control: false, trafficSplitPct: 50, campaignIds: [], inDesignCampaignIds: ['22'] },
  ],
}
const RUNNING = { ...SETUP, status: 'ENABLED', arms: [SETUP.arms[0], { ...SETUP.arms[1], campaignIds: ['23'], inDesignCampaignIds: [] }] }
const DRAFT = { draftId: '21~3', resourceName: `${CUSTOMER}/campaignDrafts/21~3`, name: 'Draft A', status: 'PROPOSED', baseCampaignId: '21', draftCampaignId: '25', experimentRunning: false, operation: null }
const pick = (p: unknown) => { const { basis, plan, reach } = p as Record<string, unknown>; return { basis, plan, reach } }

beforeEach(() => {
  for (const f of [h.mutate, h.action, h.operation, h.asyncErrors]) f.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.live.experiments = []
  h.live.campaigns = [C21, C22, C23]
  h.live.names = [{ campaignId: '21', name: 'Search A' }]
  h.live.drafts = [DRAFT]
  h.live.settings = {}
  h.live.budgets = [{ budgetId: '14', name: 'Budget B', amountCents: 1500, shared: true, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 0, campaigns: [] }]
})

describe('every G9 tool', () => {
  it('a change: a Nexus change a person approves, never by rule; its re-check fields declared; descriptions end with the rules', () => {
    const changes = GOOGLE_ADS_EXPERIMENT_TOOLS.filter((t) => !t.readOnly)
    expect(changes.map((t) => t.name).sort()).toEqual([
      'create-google-experiment', 'end-google-experiment', 'graduate-google-experiment', 'promote-google-campaign-draft', 'promote-google-experiment',
      'schedule-google-experiment', 'set-google-campaign-draft', 'set-google-experiment',
    ])
    for (const t of changes) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.description.endsWith(GOOGLE_CHANGE_RULES)).toBe(true)
      expect(t.reversibility === 'none' || !!t.undo).toBe(true)
    }
    expect(['end-google-experiment', 'promote-google-experiment', 'promote-google-campaign-draft'].map((n) => tool(n).reversibility)).toEqual(['none', 'none', 'none'])
    expect(tool('google-ads-experiments')).toMatchObject({ readOnly: true, openWorld: true, riskTier: 'low' })
  })
})

describe('create-google-experiment', () => {
  const ask = { type: 'SEARCH_CUSTOM', campaignId: '21', name: 'Test Z' }

  it('Google checks the mutate (validate_only); the run makes it, names its in-design campaign; undo removes it while never scheduled', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const out = await tool('create-google-experiment').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(h.mutate.mock.calls[0][1].map((o: object) => Object.keys(o)[0])).toEqual(['experimentOperation', 'experimentArmOperation', 'experimentArmOperation'])
    expect(out.preview).toMatchObject({ spendsMoney: false, operations: 3, googleCheck: { checked: true, accepted: true } })
    expect(h.action).not.toHaveBeenCalled()
    // The gate's re-check reads again, does not ask Google again, and reaches the same facts.
    const again = await tool('create-google-experiment').handler(ask, recheck)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(pick(again.preview)).toEqual(pick(out.preview))

    h.mutate.mockResolvedValue({ responses: [{ experimentResult: { resourceName: EXP } }, { experimentArmResult: {} }, { experimentArmResult: {} }], ops: 3, requestId: null })
    h.live.experiments = [SETUP]
    const run = await tool('create-google-experiment').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate.mock.calls[1][2]).toEqual({ validateOnly: false, operation: 'ads.mutate' })
    expect(run.data).toMatchObject({ experimentId: '31', status: 'SETUP', inDesignCampaignIds: ['22'] })
    expect(run.change!.after).toEqual({ experimentId: '31', name: 'Test Z', type: 'SEARCH_CUSTOM', campaignId: '21', status: 'SETUP', accountId: 'g-1', customerId: '1234567890' })
    const undo = tool('create-google-experiment').undo!
    expect(await undo.current(run.change!)).toEqual(run.change!.after)
    const back = undo.request(run.change!)
    expect(back).toEqual({ tool: 'set-google-experiment', args: { accountId: 'g-1', experimentId: '31', remove: true, why: 'undo of an experiment made (never scheduled)' } })
    expect(tool('set-google-experiment').input.safeParse((back as { args: unknown }).args).success).toBe(true)
    // Scheduled since: it moved, so undo of the create is not offered (the experiment is ended instead).
    h.live.experiments = [{ ...SETUP, status: 'ENABLED' }]
    expect(await undo.current(run.change!)).toMatchObject({ status: 'ENABLED' })
  })

  it('a change Google refuses is never queued', async () => {
    h.mutate.mockRejectedValue(new GoogleAdsWriteError({ ...localFailure('x', 'X'), errors: [{ message: 'The experiment campaign name conflicts with a pre-existing campaign.', path: null, trigger: null, code: 'DUPLICATE_EXPERIMENT_CAMPAIGN_NAME' }] } as never, 'ads.mutate.check', 'refused'))
    const out = await tool('create-google-experiment').handler(ask, asker)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/Google Ads refused it: The experiment campaign name conflicts/)
  })
})

describe('schedule-google-experiment', () => {
  const ask = { experimentId: '31' }

  it('checked on its own endpoint (validateOnly), never as a mutate; SPENDS MONEY; the run says Google started it, not done', async () => {
    h.live.experiments = [SETUP]
    h.action.mockResolvedValue({ responses: [{}], ops: 1 })
    const out = await tool('schedule-google-experiment').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.action.mock.calls[0].slice(1)).toEqual([[{ scheduleExperiment: { resourceName: EXP } }], { validateOnly: true }])
    expect(out.preview).toMatchObject({ spendsMoney: true, googleCheck: { checked: true, accepted: true }, operations: 1 })
    expect((out.preview as { warnings: string[] }).warnings.join(' ')).toMatch(/Nexus never says it is done before Google does/)

    h.action.mockResolvedValue({ responses: [{ experimentActionResult: { resourceName: EXP }, longRunningOperation: { resourceName: OP } }], ops: 1 })
    const run = await tool('schedule-google-experiment').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.action.mock.calls[1].slice(1)).toEqual([[{ scheduleExperiment: { resourceName: EXP } }], { validateOnly: false }])
    expect(run.data).toMatchObject({ experimentId: '31', operation: OP, state: expect.stringMatching(/^Google started scheduling it: not done until google-ads-experiments shows it ENABLED/) })
    // Undo: Google cannot unschedule; it ends the experiment.
    h.live.experiments = [{ ...SETUP, status: 'INITIATED' }]
    expect(await tool('schedule-google-experiment').undo!.current(run.change!)).toEqual(run.change!.after)
    expect(tool('schedule-google-experiment').undo!.request(run.change!)).toMatchObject({ tool: 'end-google-experiment', args: { accountId: 'g-1', experimentId: '31' } })
  })

  it('not sent when the experiment moved since it was approved', async () => {
    h.live.experiments = [SETUP]
    h.action.mockResolvedValue({ responses: [{}], ops: 1 })
    const out = await tool('schedule-google-experiment').handler(ask, asker)
    h.live.experiments = [{ ...SETUP, arms: [SETUP.arms[0], { ...SETUP.arms[1], trafficSplitPct: 60 }] }]
    const run = await tool('schedule-google-experiment').execute!(ask, approved(out.preview))
    expect(run.error).toMatch(/changed since this was approved/)
    // The in-design campaign the SPENDS MONEY line names moved to another budget: not sent either.
    h.live.experiments = [SETUP]
    h.live.campaigns = [C21, { ...C22, budget: { ...BUDGET, budgetId: '19', name: 'Budget C' } }, C23]
    const moved = await tool('schedule-google-experiment').execute!(ask, approved(out.preview))
    expect(moved.error).toMatch(/changed since this was approved/)
    expect(h.action).toHaveBeenCalledTimes(1)
  })
})

describe('end, promote and graduate', () => {
  it('end: a safe step checked on its endpoint; no undo (an ended experiment does not start again)', async () => {
    h.live.experiments = [RUNNING]
    h.action.mockResolvedValue({ responses: [{}], ops: 1 })
    const out = await tool('end-google-experiment').handler({ experimentId: '31' }, asker)
    expect(out.preview).toMatchObject({ spendsMoney: false })
    expect(h.action.mock.calls[0].slice(1)).toEqual([[{ endExperiment: { resourceName: EXP } }], { validateOnly: true }])
    const run = await tool('end-google-experiment').execute!({ experimentId: '31' }, approved(out.preview))
    expect(run.data).toMatchObject({ experimentId: '31', ended: true })
    expect(tool('end-google-experiment').undo).toBeUndefined()
  })

  it('promote: SPENDS MONEY with the main settings; started, not done', async () => {
    h.live.experiments = [RUNNING]
    h.live.settings = { 21: { ...C21, networks: { searchPartners: false, display: false }, targetCpaCents: 900, targetRoas: null, maxCpcCeilingCents: null, aiMax: false, keywordMatchType: null }, 23: { ...C23, networks: { searchPartners: false, display: false }, targetCpaCents: 1200, targetRoas: null, maxCpcCeilingCents: null, aiMax: false, keywordMatchType: null } }
    h.action.mockResolvedValue({ responses: [{}], ops: 1 })
    const out = await tool('promote-google-experiment').handler({ experimentId: '31' }, asker)
    expect(out.ok).toBe(true)
    expect((out.preview as { spendsMoneyBecause: string[] }).spendsMoneyBecause).toContain('Raises the target CPA from EUR 9.00 to EUR 12.00.')
    // The treatment campaign changed after the preview (a higher target CPA than the one approved): not sent.
    const approvedTreatment = h.live.settings[23]
    h.live.settings = { ...h.live.settings, 23: { ...approvedTreatment, targetCpaCents: 2500 } }
    const moved = await tool('promote-google-experiment').execute!({ experimentId: '31' }, approved(out.preview))
    expect(moved.error).toMatch(/changed since this was approved/)
    expect(h.action).toHaveBeenCalledTimes(1)
    h.live.settings = { ...h.live.settings, 23: approvedTreatment }
    h.action.mockResolvedValue({ responses: [{ experimentActionResult: { resourceName: EXP }, longRunningOperation: { resourceName: OP } }], ops: 1 })
    const run = await tool('promote-google-experiment').execute!({ experimentId: '31' }, approved(out.preview))
    expect(run.data).toMatchObject({ operation: OP, state: expect.stringMatching(/^Google started the promote: not done until/) })
    expect(run.change!.after).toEqual({ experimentId: '31', promoted: 'started', accountId: 'g-1', customerId: '1234567890' })
  })

  it('graduate: ONE campaign onto ONE budget, SPENDS MONEY; undo pauses the graduated campaign through set-google-status', async () => {
    h.live.experiments = [RUNNING]
    h.action.mockResolvedValue({ responses: [{}], ops: 1 })
    const ask = { experimentId: '31', budgetId: '14' }
    const out = await tool('graduate-google-experiment').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: true })
    expect(h.action.mock.calls[0][1]).toEqual([{ graduateExperiment: { resourceName: EXP, campaignBudgetMappings: [{ experimentCampaign: `${CUSTOMER}/campaigns/23`, campaignBudget: `${CUSTOMER}/campaignBudgets/14` }] } }])
    const run = await tool('graduate-google-experiment').execute!(ask, approved(out.preview))
    expect(run.change).toEqual({
      before: { experimentId: '31', campaignId: '23', budgetId: '11', accountId: 'g-1', customerId: '1234567890' },
      after: { experimentId: '31', campaignId: '23', budgetId: '14', accountId: 'g-1', customerId: '1234567890' },
    })
    h.live.campaigns = [C21, { ...C23, experimentType: 'BASE', budget: { ...BUDGET, budgetId: '14' } }]
    const undo = tool('graduate-google-experiment').undo!
    expect(await undo.current(run.change!)).toEqual(run.change!.after)
    expect(undo.request(run.change!)).toMatchObject({ tool: 'set-google-status', args: { accountId: 'g-1', items: [{ kind: 'campaign', id: '23' }], status: 'PAUSED' } })
  })
})

describe('campaign drafts', () => {
  it('create: a mutate Google checks; the run names the draft (campaignId~draftId) and its draft campaign; undo removes it', async () => {
    const ask = { create: { campaignId: '21', name: 'Draft Z' } }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-campaign-draft').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: false, googleCheck: { checked: true } })
    // Google makes the draft (and its draft campaign) when the run sends it.
    h.mutate.mockImplementation(async () => {
      h.live.drafts = [DRAFT, { ...DRAFT, draftId: '21~4', resourceName: `${CUSTOMER}/campaignDrafts/21~4`, name: 'Draft Z', draftCampaignId: '26' }]
      return { responses: [{ campaignDraftResult: { resourceName: `${CUSTOMER}/campaignDrafts/21~4` } }], ops: 1, requestId: null }
    })
    const run = await tool('set-google-campaign-draft').execute!(ask, approved(out.preview))
    expect(run.data).toMatchObject({ draftId: '21~4', draftCampaignId: '26' })
    const undo = tool('set-google-campaign-draft').undo!
    expect(await undo.current(run.change!)).toEqual(run.change!.after)
    const back = undo.request(run.change!)
    expect(back).toEqual({ tool: 'set-google-campaign-draft', args: { accountId: 'g-1', draftId: '21~4', remove: true, why: 'undo of a campaign draft made' } })
    expect(tool('set-google-campaign-draft').input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })

  it('promote: checked on its endpoint (":promote", validateOnly); SPENDS MONEY; started, not done', async () => {
    h.live.settings = { 21: { ...C21, networks: { searchPartners: false, display: false }, aiMax: false }, 25: { ...C21, campaignId: '25', networks: { searchPartners: false, display: true }, aiMax: false } }
    h.action.mockResolvedValue({ responses: [{}], ops: 1 })
    const out = await tool('promote-google-campaign-draft').handler({ draftId: '21~3' }, asker)
    expect(h.action.mock.calls[0].slice(1)).toEqual([[{ promoteCampaignDraft: { resourceName: `${CUSTOMER}/campaignDrafts/21~3` } }], { validateOnly: true }])
    expect((out.preview as { spendsMoneyBecause: string[] }).spendsMoneyBecause).toContain('Turns on the display network.')
    // The draft campaign changed after the preview: not sent.
    h.live.settings = { ...h.live.settings, 25: { ...h.live.settings[25], aiMax: true } }
    expect((await tool('promote-google-campaign-draft').execute!({ draftId: '21~3' }, approved(out.preview))).error).toMatch(/changed since this was approved/)
    h.live.settings = { ...h.live.settings, 25: { ...h.live.settings[25], aiMax: false } }
    h.action.mockResolvedValue({ responses: [{ longRunningOperation: { resourceName: OP } }], ops: 1 })
    const run = await tool('promote-google-campaign-draft').execute!({ draftId: '21~3' }, approved(out.preview))
    expect(run.data).toMatchObject({ draftId: '21~3', operation: OP, state: expect.stringMatching(/not done until google-ads-experiments shows the draft PROMOTED/) })
  })
})

describe('google-ads-experiments (read)', () => {
  it('lists experiments with their state in words and the drafts', async () => {
    h.live.experiments = [SETUP]
    const out = await tool('google-ads-experiments').handler({}, asker)
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ experiments: [{ experimentId: '31', state: expect.stringMatching(/^Not scheduled/) }], drafts: [{ draftId: '21~3' }], total: { experiments: 1, drafts: 1 } })
  })

  it('one experiment: Google\'s long-running work, done or not; when it failed, the errors Google kept', async () => {
    h.live.experiments = [{ ...SETUP, status: 'INITIATED', operation: OP }]
    h.operation.mockResolvedValue({ name: OP, done: false, error: null })
    const pending = await tool('google-ads-experiments').handler({ experimentId: '31' }, asker)
    expect(pending.data).toMatchObject({ experiment: { state: expect.stringMatching(/not done yet/) }, operation: { done: false } })
    expect(h.asyncErrors).not.toHaveBeenCalled()
    h.live.experiments = [{ ...SETUP, operation: OP }]
    h.operation.mockResolvedValue({ name: OP, done: true, error: 'failed' })
    h.asyncErrors.mockResolvedValue(['The in-design campaign has no change.'])
    const failed = await tool('google-ads-experiments').handler({ experimentId: '31' }, asker)
    expect(failed.data).toMatchObject({ operation: { done: true, error: 'failed' }, asyncErrors: ['The in-design campaign has no change.'] })
    expect(h.asyncErrors.mock.calls[0].slice(1, 3)).toEqual([EXP, 'experiment'])
  })
})
