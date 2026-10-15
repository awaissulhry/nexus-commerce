/**
 * Google Ads changes, G9 (2026-10-15) — the pure builders of experiments and campaign drafts: request + live state → the
 * ONE request Google gets, what a person reads (from → to, SPENDS MONEY, that Google's long-running work is not done
 * when it answers), what it stands on and what undo needs, or a refusal with the reason. Ids and names are made up.
 */
import { describe, expect, it } from 'vitest'
import {
  campaignDraftChange, createExperimentDraft, endExperimentDraft, graduateExperimentDraft, NOT_DONE_YET, promoteCampaignDraftDraft,
  promoteExperimentDraft, scheduleExperimentDraft, setExperimentDraft, type CreateExperimentLive, type CreateExperimentRequest,
} from './change-experiments.js'
import type { GoogleChangeDraft } from './change-draft.js'
import type { LiveBudget, LiveCampaignDetail } from './live.js'
import type { LiveCampaignDraft, LiveExperimentArm, LiveExperimentCampaign, LiveExperimentState } from './live-experiments.js'

const CUSTOMER = 'customers/1234567890'
const draft = (out: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => {
  if ('refusal' in out) throw new Error(`refused: ${out.refusal}`)
  return out
}
const refusal = (out: GoogleChangeDraft | { refusal: string }): string => ('refusal' in out ? out.refusal : 'NOT REFUSED')

const OWN_BUDGET = { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false, period: 'DAILY', status: 'ENABLED' }
const campaign = (id: string, name: string, over: Partial<LiveExperimentCampaign> = {}): LiveExperimentCampaign => ({
  campaignId: id, name, status: 'ENABLED', type: 'SEARCH', bidding: 'MANUAL_CPC', experimentType: 'BASE', baseCampaignId: null,
  start: null, end: null, budget: OWN_BUDGET, ...over,
})
const arm = (over: Partial<LiveExperimentArm>): LiveExperimentArm => ({ armId: '31~1', name: 'Control', control: true, trafficSplitPct: 50, campaignIds: [], inDesignCampaignIds: [], ...over })
const CONTROL = arm({ armId: '31~1', name: 'Control', control: true, campaignIds: ['21'] })
const TREATMENT_SETUP = arm({ armId: '31~2', name: 'Treatment', control: false, inDesignCampaignIds: ['22'] })
const TREATMENT_RUNNING = arm({ armId: '31~2', name: 'Treatment', control: false, campaignIds: ['23'] })
const experiment = (over: Partial<LiveExperimentState> = {}): LiveExperimentState => ({
  experimentId: '31', resourceName: `${CUSTOMER}/experiments/31`, name: 'Test A', description: null, type: 'SEARCH_CUSTOM', status: 'SETUP',
  start: '2026-11-01', end: '2026-11-30', suffix: ' [experiment]', syncEnabled: false, promoteStatus: null, operation: null,
  arms: [CONTROL, TREATMENT_SETUP], ...over,
})
const settings = (id: string, name: string, over: Partial<LiveCampaignDetail['campaign']> = {}): LiveCampaignDetail['campaign'] => ({
  campaignId: id, name, status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MAXIMIZE_CONVERSIONS',
  start: null, end: null, shopping: null, budget: { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false },
  networks: { googleSearch: true, searchPartners: false, display: false, partnerSearch: false }, locationOption: { include: null, exclude: null },
  audienceMode: [], euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', aiMax: false, keywordMatchType: null, assetAutomation: [],
  manualCpcEnhanced: false, maxCpcCeilingCents: null, targetCpaCents: 900, targetRoas: null, biddingStrategyId: null, localInventory: false,
  trackingTemplate: null, finalUrlSuffix: null, primaryStatusReasons: [], ...over,
})
const budget = (id: string, over: Partial<LiveBudget> = {}): LiveBudget => ({
  budgetId: id, name: `Budget ${id}`, amountCents: 1500, shared: true, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 0, campaigns: [], ...over,
})

// ── create-google-experiment ─────────────────────────────────────────────────────────────────────────────────────

describe('create-google-experiment', () => {
  const live = (over: Partial<CreateExperimentLive> = {}): CreateExperimentLive => ({
    campaign: campaign('21', 'Search A'), experiments: [], campaignNames: [{ campaignId: '21', name: 'Search A' }], ...over,
  })
  const ask = (over: Partial<CreateExperimentRequest> = {}): CreateExperimentRequest => ({ type: 'SEARCH_CUSTOM', campaignId: '21', name: 'Test Z', ...over })

  it('a custom Search experiment: the experiment (temporary id, SETUP) and its two arms in ONE request; nothing spends', () => {
    const d = draft(createExperimentDraft(CUSTOMER, ask({ trafficSplitPct: 30, startDate: '2026-11-01', description: 'bids' }), live()))
    expect(d.operations).toEqual([
      { experimentOperation: { create: { resourceName: `${CUSTOMER}/experiments/-1`, name: 'Test Z', description: 'bids', suffix: ' [experiment]', type: 'SEARCH_CUSTOM', status: 'SETUP', startDate: '2026-11-01' } } },
      { experimentArmOperation: { create: { experiment: `${CUSTOMER}/experiments/-1`, name: 'Control', control: true, trafficSplit: 70, campaigns: [`${CUSTOMER}/campaigns/21`] } } },
      // The treatment names no campaign: Google makes its in-design copy, which never serves.
      { experimentArmOperation: { create: { experiment: `${CUSTOMER}/experiments/-1`, name: 'Treatment', control: false, trafficSplit: 30 } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/Nothing serves yet: the experiment is made in SETUP/)
    expect(d.warnings.join(' ')).toMatch(/Once scheduled \(schedule-google-experiment, SPENDS MONEY\)/)
    expect(d.after).toEqual({ experimentId: 'new', name: 'Test Z', type: 'SEARCH_CUSTOM', campaignId: '21', status: 'SETUP' })
    expect(d.before).toEqual({ experimentId: null })
  })

  it('broad match keywords: made ENABLED, both arms on the campaign, 50/50 — SPENDS MONEY (said paused when the campaign is)', () => {
    const d = draft(createExperimentDraft(CUSTOMER, ask({ type: 'ADOPT_BROAD_MATCH_KEYWORDS', suffix: ' x' }), live()))
    expect(d.operations[0]).toEqual({ experimentOperation: { create: { resourceName: `${CUSTOMER}/experiments/-1`, name: 'Test Z', type: 'ADOPT_BROAD_MATCH_KEYWORDS', status: 'ENABLED' } } })
    expect(d.operations.slice(1).map((o) => (o.experimentArmOperation as any).create.campaigns)).toEqual([[`${CUSTOMER}/campaigns/21`], [`${CUSTOMER}/campaigns/21`]])
    expect(d.spendsMoney).toEqual(['From now campaign "Search A" uses broad match for half of its traffic: its ads can show on more searches, on the same budget.'])
    expect(d.skipped).toEqual([expect.stringMatching(/^suffix: a broad match keywords experiment makes no treatment campaign/)])
    const paused = draft(createExperimentDraft(CUSTOMER, ask({ type: 'ADOPT_BROAD_MATCH_KEYWORDS' }), live({ campaign: campaign('21', 'Search A', { status: 'PAUSED' }) })))
    expect(paused.spendsMoney[0]).toMatch(/\(Campaign "Search A" is PAUSED: nothing spends until it is enabled\.\)$/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask({ type: 'ADOPT_BROAD_MATCH_KEYWORDS', trafficSplitPct: 30 }), live()))).toMatch(/50\/50/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask({ type: 'ADOPT_BROAD_MATCH_KEYWORDS', syncEnabled: true }), live()))).toMatch(/syncs changes only for custom Search and Display/)
  })

  it('refuses what Google would refuse to schedule, with the reason', () => {
    expect(refusal(createExperimentDraft(CUSTOMER, ask(), live({ campaign: null })))).toMatch(/Campaign 21 is not in the Google Ads account/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask(), live({ campaign: campaign('21', 'Search A', { budget: { ...OWN_BUDGET, shared: true } }) })))).toMatch(/CANNOT_CREATE_EXPERIMENT_CAMPAIGN_WITH_SHARED_BUDGET/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask(), live({ campaign: campaign('21', 'Search A', { budget: { ...OWN_BUDGET, period: 'CUSTOM_PERIOD' } }) })))).toMatch(/custom-period budget/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask(), live({ campaign: campaign('21', 'Shop A', { type: 'SHOPPING' }) })))).toMatch(/is for a SEARCH campaign; "Shop A" is SHOPPING/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask(), live({ campaign: campaign('21', 'Search A', { experimentType: 'EXPERIMENT', baseCampaignId: '20' }) })))).toMatch(/"Search A" is itself an experiment campaign: an experiment starts from a campaign of its own \(its campaign is 20\)/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask({ name: 'test a' }), live({ experiments: [experiment()] })))).toMatch(/An experiment named "Test A" is already in the account/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask(), live({ campaignNames: [{ campaignId: '21', name: 'Search A' }, { campaignId: '29', name: 'Search A [experiment]' }] })))).toMatch(/campaign 29 has that name/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask({ controlArmName: 'Same', treatmentArmName: 'same' }), live()))).toMatch(/different names/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask({ startDate: '2026-12-10', endDate: '2026-12-01' }), live()))).toMatch(/before startDate/)
    expect(refusal(createExperimentDraft(CUSTOMER, ask({ startDate: '2026-02-30' }), live()))).toMatch(/is not a day/)
  })

  it('a campaign already in an experiment that has not ended: warned (Google refuses overlapping dates)', () => {
    const d = draft(createExperimentDraft(CUSTOMER, ask(), live({ experiments: [experiment({ name: 'Old', status: 'ENABLED', arms: [CONTROL, TREATMENT_RUNNING] })] })))
    expect(d.warnings.join(' ')).toMatch(/already in 1 experiment that has not ended \("Old"\)/)
  })
})

// ── set-google-experiment ────────────────────────────────────────────────────────────────────────────────────────

describe('set-google-experiment', () => {
  it('name and end day: one update with its field mask (snake_case); a later end of a running one SPENDS MONEY', () => {
    const e = experiment({ status: 'ENABLED', arms: [CONTROL, TREATMENT_RUNNING] })
    const d = draft(setExperimentDraft(CUSTOMER, { experimentId: '31', name: 'Test B', endDate: '2026-12-10' }, { experiment: e, experiments: [e] }))
    expect(d.operations).toEqual([{ experimentOperation: { update: { resourceName: `${CUSTOMER}/experiments/31`, name: 'Test B', endDate: '2026-12-10' }, updateMask: 'name,end_date' } }])
    expect(d.spendsMoney).toEqual(['The treatment of "Test A" serves 10 days longer (to 2026-12-10), on part of the campaign\'s budget.'])
    expect(d.before).toEqual({ experimentId: '31', fields: { name: 'Test A', endDate: '2026-11-30' } })
    expect(d.after).toEqual({ experimentId: '31', fields: { name: 'Test B', endDate: '2026-12-10' } })
  })

  it('remove: only one never scheduled, alone; it says its in-design campaign goes with it', () => {
    const d = draft(setExperimentDraft(CUSTOMER, { experimentId: '31', remove: true }, { experiment: experiment(), experiments: [] }))
    expect(d.operations).toEqual([{ experimentOperation: { remove: `${CUSTOMER}/experiments/31` } }])
    expect(d.warnings[0]).toMatch(/in-design campaign \(22\)/)
    expect(d.after).toEqual({ experimentId: '31', removed: true })
    expect(refusal(setExperimentDraft(CUSTOMER, { experimentId: '31', remove: true }, { experiment: experiment({ status: 'ENABLED' }), experiments: [] }))).toMatch(/end it with end-google-experiment/)
    expect(refusal(setExperimentDraft(CUSTOMER, { experimentId: '31', remove: true, name: 'X' }, { experiment: experiment(), experiments: [] }))).toMatch(/alone/)
  })

  it('refuses: an experiment that is over, nothing that changes, a name taken, an end before the start', () => {
    expect(refusal(setExperimentDraft(CUSTOMER, { experimentId: '31', name: 'B' }, { experiment: experiment({ status: 'HALTED' }), experiments: [] }))).toMatch(/is over/)
    expect(refusal(setExperimentDraft(CUSTOMER, { experimentId: '31', name: 'Test A' }, { experiment: experiment(), experiments: [] }))).toMatch(/^Nothing to change/)
    expect(refusal(setExperimentDraft(CUSTOMER, { experimentId: '31', name: 'Test C' }, { experiment: experiment(), experiments: [experiment({ experimentId: '32', name: 'Test C' })] }))).toMatch(/already in the account \(32\)/)
    expect(refusal(setExperimentDraft(CUSTOMER, { experimentId: '31', endDate: '2026-10-01' }, { experiment: experiment(), experiments: [] }))).toMatch(/would end \(2026-10-01\) before it starts/)
    expect(refusal(setExperimentDraft(CUSTOMER, { experimentId: '99' }, { experiment: null, experiments: [] }))).toMatch(/Experiment 99 is not in the Google Ads account/)
  })
})

// ── schedule / end ───────────────────────────────────────────────────────────────────────────────────────────────

describe('schedule-google-experiment and end-google-experiment', () => {
  const campaigns = [campaign('21', 'Search A'), campaign('22', 'Search A [experiment]', { experimentType: 'DRAFT', baseCampaignId: '21' })]

  it('schedule: ONE scheduleExperiment action; SPENDS MONEY; the answer is not "done" (long-running)', () => {
    const d = draft(scheduleExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment(), campaigns }))
    expect(d.operations).toEqual([{ scheduleExperiment: { resourceName: `${CUSTOMER}/experiments/31` } }])
    expect(d.spendsMoney).toEqual(['From 2026-11-01 to 2026-11-30 the treatment "Treatment" (campaign "Search A [experiment]") serves 50 % of campaign "Search A"\'s traffic with the treatment\'s settings, on "Search A"\'s budget, shared by both arms (not raised).'])
    expect(d.warnings).toContain(NOT_DONE_YET)
    expect(d.after).toEqual({ experimentId: '31', scheduled: true })
  })

  it('schedule of a paused campaign\'s experiment: still a SPENDS MONEY line, saying nothing spends yet', () => {
    const d = draft(scheduleExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment(), campaigns: [campaign('21', 'Search A', { status: 'PAUSED' }), campaigns[1]] }))
    expect(d.spendsMoney[0]).toMatch(/\(Campaign "Search A" is PAUSED: nothing spends until it is enabled\.\)$/)
  })

  it('schedule refuses: not a custom type, already being scheduled, a shared budget now, no in-design campaign', () => {
    expect(refusal(scheduleExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment({ type: 'ADOPT_BROAD_MATCH_KEYWORDS', status: 'ENABLED' }), campaigns }))).toMatch(/is not scheduled: it serves from when it was made/)
    expect(refusal(scheduleExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment({ status: 'INITIATED', operation: `${CUSTOMER}/operations/op-1` }), campaigns }))).toMatch(/Google is scheduling "Test A" already/)
    expect(refusal(scheduleExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment(), campaigns: [campaign('21', 'Search A', { budget: { ...OWN_BUDGET, shared: true } })] }))).toMatch(/shared budget now/)
    expect(refusal(scheduleExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment({ arms: [CONTROL, arm({ armId: '31~2', name: 'T', control: false })] }), campaigns }))).toMatch(/IN_DESIGN_CAMPAIGNS_NOT_SET/)
  })

  it('end: ONE endExperiment action, a safe step (no SPENDS MONEY); never-scheduled and ended ones refused', () => {
    const d = draft(endExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment({ status: 'ENABLED', arms: [CONTROL, TREATMENT_RUNNING] }), campaigns }))
    expect(d.operations).toEqual([{ endExperiment: { resourceName: `${CUSTOMER}/experiments/31` } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.after).toEqual({ experimentId: '31', status: 'HALTED' })
    expect(refusal(endExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment(), campaigns }))).toMatch(/never scheduled.*set-google-experiment \(remove\)/)
    expect(refusal(endExperimentDraft(CUSTOMER, { experimentId: '31', experiment: experiment({ status: 'HALTED' }), campaigns }))).toMatch(/ended \(HALTED\) already/)
  })
})

// ── promote ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('promote-google-experiment', () => {
  const running = experiment({ status: 'ENABLED', arms: [CONTROL, TREATMENT_RUNNING] })

  it('a custom experiment: ONE promoteExperiment action; the main settings from → to; raises named as SPENDS MONEY', () => {
    const d = draft(promoteExperimentDraft(CUSTOMER, 'EUR', {
      experimentId: '31', experiment: running, base: settings('21', 'Search A'),
      treatment: settings('23', 'Search A [experiment]', { targetCpaCents: 1200, networks: { googleSearch: true, searchPartners: true, display: false, partnerSearch: false } }),
    }))
    expect(d.operations).toEqual([{ promoteExperiment: { resourceName: `${CUSTOMER}/experiments/31` } }])
    expect(d.changes).toMatchObject({ 'target CPA': { from: 'EUR 9.00', to: 'EUR 12.00' }, 'search partners': { from: false, to: true } })
    expect(d.spendsMoney).toEqual([
      expect.stringMatching(/^Applies every change of the treatment to campaign "Search A" for ALL its traffic/),
      'Raises the target CPA from EUR 9.00 to EUR 12.00.',
      'Turns on the search partners.',
    ])
    expect(d.warnings).toContain(NOT_DONE_YET)
    expect(d.warnings.join(' ')).toMatch(/Google cannot undo a promote/)
    expect(d.before).toMatchObject({ experimentId: '31', campaignId: '21', settings: { targetCpaCents: 900, searchPartners: false } })
  })

  it('broad match: the feature for all traffic is SPENDS MONEY; Performance Max types, a second promote and not-running ones refused', () => {
    const broad = experiment({ type: 'ADOPT_BROAD_MATCH_KEYWORDS', status: 'ENABLED', arms: [CONTROL, arm({ armId: '31~2', name: 'T', control: false, campaignIds: ['21'] })] })
    const d = draft(promoteExperimentDraft(CUSTOMER, 'EUR', { experimentId: '31', experiment: broad, base: settings('21', 'Search A'), treatment: null }))
    expect(d.spendsMoney).toEqual(['All of campaign "Search A"\'s traffic uses broad match from then on: its ads can show on more searches.'])
    expect(refusal(promoteExperimentDraft(CUSTOMER, 'EUR', { experimentId: '31', experiment: experiment({ type: 'PMAX_REPLACEMENT_SHOPPING', status: 'ENABLED' }), base: null, treatment: null }))).toMatch(/cannot promote a Performance Max versus Shopping experiment/)
    expect(refusal(promoteExperimentDraft(CUSTOMER, 'EUR', { experimentId: '31', experiment: { ...running, promoteStatus: 'IN_PROGRESS' }, base: settings('21', 'Search A'), treatment: null }))).toMatch(/promoting "Test A" already/)
    expect(refusal(promoteExperimentDraft(CUSTOMER, 'EUR', { experimentId: '31', experiment: experiment(), base: settings('21', 'Search A'), treatment: null }))).toMatch(/promotes an experiment that is running/)
  })
})

// ── graduate ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('graduate-google-experiment', () => {
  const running = experiment({ status: 'ENABLED', arms: [CONTROL, TREATMENT_RUNNING] })
  const campaigns = [campaign('21', 'Search A'), campaign('23', 'Search A [experiment]', { experimentType: 'EXPERIMENT', baseCampaignId: '21' })]

  it('ONE treatment campaign onto ONE budget (Google: at most one mapping); it keeps serving — SPENDS MONEY', () => {
    const d = draft(graduateExperimentDraft(CUSTOMER, 'EUR', { experimentId: '31', budgetId: '14' }, { experiment: running, campaigns, budgets: [budget('14')] }))
    expect(d.operations).toEqual([{ graduateExperiment: { resourceName: `${CUSTOMER}/experiments/31`, campaignBudgetMappings: [{ experimentCampaign: `${CUSTOMER}/campaigns/23`, campaignBudget: `${CUSTOMER}/campaignBudgets/14` }] } }])
    expect(d.spendsMoney).toEqual([expect.stringMatching(/^Campaign "Search A \[experiment\]" becomes a campaign of its own .* on budget "Budget 14" \(EUR 15\.00 a day\)\. To graduate it paused, pause it first with set-google-status\.$/)])
    expect(d.before).toEqual({ experimentId: '31', campaignId: '23', budgetId: '11' })
    expect(d.after).toEqual({ experimentId: '31', campaignId: '23', budgetId: '14' })
  })

  it('a paused treatment campaign: still SPENDS MONEY, saying nothing spends until it is enabled', () => {
    const d = draft(graduateExperimentDraft(CUSTOMER, 'EUR', { experimentId: '31', budgetId: '14' }, { experiment: running, campaigns: [campaigns[0], { ...campaigns[1], status: 'PAUSED' }], budgets: [budget('14')] }))
    expect(d.spendsMoney[0]).toMatch(/is PAUSED: nothing spends until it is enabled\.\)$/)
  })

  it('refuses: the campaign\'s own budget, another campaign\'s own budget, an unknown budget, several treatments unnamed, broad match', () => {
    const at = (budgetId: string, budgets: LiveBudget[], over: Partial<LiveExperimentState> = {}, campaignId?: string) =>
      refusal(graduateExperimentDraft(CUSTOMER, 'EUR', { experimentId: '31', budgetId, ...(campaignId ? { campaignId } : {}) }, { experiment: { ...running, ...over }, campaigns, budgets }))
    expect(at('11', [budget('11', { shared: false, usedBy: 2 })])).toMatch(/own budget, which the treatment shares today/)
    expect(at('15', [budget('15', { shared: false, usedBy: 1 })])).toMatch(/another campaign's own budget/)
    expect(at('16', [])).toMatch(/Budget 16 is not an enabled budget/)
    const two = { arms: [CONTROL, TREATMENT_RUNNING, arm({ armId: '31~3', name: 'T2', control: false, campaignIds: ['24'] })] }
    expect(at('14', [budget('14')], two)).toMatch(/2 treatment campaigns \(23, 24\) and Google graduates one per request/)
    expect(at('14', [budget('14')], {}, '29')).toMatch(/Campaign 29 is not a treatment campaign/)
    expect(at('14', [budget('14')], { type: 'ADOPT_BROAD_MATCH_KEYWORDS' })).toMatch(/cannot graduate a broad match keywords experiment/)
    expect(at('14', [budget('14')], { status: 'SETUP' })).toMatch(/graduates an experiment that runs or has ended/)
  })
})

// ── campaign drafts ──────────────────────────────────────────────────────────────────────────────────────────────

describe('campaign drafts', () => {
  const D = (over: Partial<LiveCampaignDraft> = {}): LiveCampaignDraft => ({
    draftId: '21~3', resourceName: `${CUSTOMER}/campaignDrafts/21~3`, name: 'Draft A', status: 'PROPOSED', baseCampaignId: '21', draftCampaignId: '25', experimentRunning: false, operation: null, ...over,
  })

  it('create: ONE campaignDraftOperation (base campaign + name); nothing serves, nothing spends', () => {
    const d = draft(campaignDraftChange(CUSTOMER, { create: { campaignId: '21', name: 'Draft Z' } }, { drafts: [D()], campaign: campaign('21', 'Search A') }))
    expect(d.operations).toEqual([{ campaignDraftOperation: { create: { baseCampaign: `${CUSTOMER}/campaigns/21`, name: 'Draft Z' } } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.after).toEqual({ action: 'create', draftId: 'new', campaignId: '21', name: 'Draft Z', status: 'PROPOSED' })
  })

  it('rename (update + mask "name") and remove; refusals: a name taken, a line break, a promoted draft, two asks', () => {
    expect(draft(campaignDraftChange(CUSTOMER, { draftId: '21~3', name: 'Draft B' }, { drafts: [D()], campaign: null })).operations)
      .toEqual([{ campaignDraftOperation: { update: { resourceName: `${CUSTOMER}/campaignDrafts/21~3`, name: 'Draft B' }, updateMask: 'name' } }])
    expect(draft(campaignDraftChange(CUSTOMER, { draftId: '21~3', remove: true }, { drafts: [D()], campaign: null })).operations)
      .toEqual([{ campaignDraftOperation: { remove: `${CUSTOMER}/campaignDrafts/21~3` } }])
    expect(refusal(campaignDraftChange(CUSTOMER, { create: { campaignId: '21', name: 'draft a' } }, { drafts: [D()], campaign: campaign('21', 'Search A') }))).toMatch(/has a draft named "Draft A" already/)
    expect(refusal(campaignDraftChange(CUSTOMER, { create: { campaignId: '21', name: 'Draft\nZ' } }, { drafts: [], campaign: campaign('21', 'Search A') }))).toMatch(/one line/)
    expect(refusal(campaignDraftChange(CUSTOMER, { draftId: '21~3', remove: true }, { drafts: [D({ status: 'PROMOTED' })], campaign: null }))).toMatch(/is PROMOTED/)
    expect(refusal(campaignDraftChange(CUSTOMER, { draftId: '21~3', name: 'X', remove: true }, { drafts: [D()], campaign: null }))).toMatch(/^Ask for one thing/)
  })

  it('promote: ONE promote action (long-running), SPENDS MONEY with the main settings; a failed promote is not tried again', () => {
    const d = draft(promoteCampaignDraftDraft(CUSTOMER, 'EUR', { draftId: '21~3', draft: D(), base: settings('21', 'Search A', { status: 'PAUSED' }), draftCampaign: settings('25', 'Search A (draft)', { aiMax: true }) }))
    expect(d.operations).toEqual([{ promoteCampaignDraft: { resourceName: `${CUSTOMER}/campaignDrafts/21~3` } }])
    expect(d.spendsMoney).toEqual([
      expect.stringMatching(/^Applies every change of the draft to campaign "Search A".*\(Campaign "Search A" is PAUSED: nothing spends until it is enabled\.\)$/),
      'Turns on AI Max (wider matching, Google writes text). (Campaign "Search A" is PAUSED: nothing spends until it is enabled.)',
    ])
    expect(d.warnings).toContain(NOT_DONE_YET)
    expect(refusal(promoteCampaignDraftDraft(CUSTOMER, 'EUR', { draftId: '21~3', draft: D({ status: 'PROMOTE_FAILED' }), base: null, draftCampaign: null }))).toMatch(/cannot be promoted again safely/)
    expect(refusal(promoteCampaignDraftDraft(CUSTOMER, 'EUR', { draftId: '21~3', draft: D({ status: 'PROMOTING' }), base: null, draftCampaign: null }))).toMatch(/promoting "Draft A" already/)
  })
})
