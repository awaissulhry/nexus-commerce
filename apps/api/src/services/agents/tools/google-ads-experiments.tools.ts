/**
 * Google Ads changes, G9 (2026-10-15, Owner's brief "full control of Google Ads through Nexus") — experiments and
 * campaign drafts. Every change tool here is a Nexus change a person approves in Nexus; it runs as that person, never by
 * rule (google-ads-kit.ts). Google checks each first (validate_only: a mutate, or the action's own endpoint).
 *
 *   create-google-experiment        a custom Search / Display experiment (SETUP: the treatment is an in-design copy that
 *                                   never serves until scheduled) or a broad match keywords experiment (runs at once)
 *   set-google-experiment           name, description, dates; remove one never scheduled (the undo of a create)
 *   schedule-google-experiment      Google turns the in-design treatment into the experiment campaign (long-running)
 *   end-google-experiment           stop it now (safe; cannot be started again)
 *   promote-google-experiment       apply the treatment to the campaign (long-running; Google cannot undo it)
 *   graduate-google-experiment      make the treatment campaign a campaign of its own on a budget (Google cannot undo it)
 *   set-google-campaign-draft       make, rename or remove a campaign draft (CampaignDraftService, still in v25)
 *   promote-google-campaign-draft   apply a draft to its campaign (long-running; Google cannot undo it)
 *   google-ads-experiments          read: experiments, arms, their campaigns (in-design ones included), drafts, and the
 *                                   state of Google's long-running work with its errors
 *
 * Changes to a treatment or draft campaign itself go through the set-google-… tools on that campaign's id — once it is a
 * campaign they can read: an in-design campaign (before scheduling) and a draft campaign are Google drafts, which those
 * tools' live reads do not ask for (PARAMETERS include_drafts), so until they do those are changed in Google Ads.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, resultId, runGoogleChange,
  type GoogleDraftBuilder, type GoogleSender,
} from './google-ads-kit.js'
import { googleChangeAccount } from '../../marketing/google-ads/change-account.js'
import { GoogleAdsReadError } from '../../marketing/google-ads/errors.js'
import {
  campaignDraftChange, createExperimentDraft, CREATE_EXPERIMENT_TYPES, endExperimentDraft, graduateExperimentDraft, promoteCampaignDraftDraft,
  promoteExperimentDraft, scheduleExperimentDraft, setExperimentDraft, SYSTEM_MANAGED_TYPES,
  type CampaignDraftRecord, type CampaignDraftRequest, type CreateExperimentRecord, type CreateExperimentRequest, type GraduateRecord,
  type ScheduleRecord, type SetExperimentRecord, type SetExperimentRequest,
} from '../../marketing/google-ads/change-experiments.js'
import { LONG_RUNNING_OPERATION, readAsyncErrors, readLongRunningOperation, sendExperimentAction } from '../../marketing/google-ads/experiment-client.js'
import {
  liveCampaignDrafts, liveCampaignNames, liveExperiment, liveExperimentCampaigns, liveExperimentList, liveSettingsWithDrafts,
  type LiveExperimentState,
} from '../../marketing/google-ads/live-experiments.js'
import { liveBudgets } from '../../marketing/google-ads/live.js'
import { asLiveRead, customerResource, type GoogleMutateResponse } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of the previews that quote budgets, bids and targets (promote, graduate). */
const SETTINGS_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

const experimentIdArg = googleIdArg('the experiment (google-ads-experiments lists them)')
const draftIdArg = z.string().trim().regex(/^\d{1,20}~\d{1,20}$/, 'campaignId~draftId (google-ads-experiments lists drafts)')
  .describe('the campaign draft as campaignId~draftId (google-ads-experiments lists drafts)')
const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day YYYY-MM-DD').describe(`${what} (YYYY-MM-DD, the account's time zone)`)

/** Google's own check of an action (validate_only on its endpoint), and the action itself: one request each. */
const actionSender: GoogleSender = {
  check: (target, operations) => sendExperimentAction(target, operations, { validateOnly: true }),
  send: (target, operations) => sendExperimentAction(target, operations, { validateOnly: false }),
}

const operationOf = (responses: GoogleMutateResponse[]) => responses[0]?.[LONG_RUNNING_OPERATION]?.resourceName ?? null
const armCampaignIds = (e: LiveExperimentState | null) => (e ? [...new Set(e.arms.flatMap((a) => [...a.campaignIds, ...a.inDesignCampaignIds]))] : [])
const NUMERIC = /^\d{1,20}$/

/** After a run: the treatment's in-design campaigns, read again (never fails the run). */
async function withInDesign(out: ToolResult, args: Record<string, unknown>): Promise<ToolResult> {
  const data = out.data as Record<string, unknown> | undefined
  const id = typeof data?.experimentId === 'string' ? data.experimentId : null
  if (!out.ok || !data || !id || !NUMERIC.test(id)) return out
  try {
    const account = await googleChangeAccount(typeof args.accountId === 'string' ? args.accountId : null)
    if ('refusal' in account) return out
    const e = await liveExperiment(account.target, id)
    data.inDesignCampaignIds = e ? e.arms.filter((a) => !a.control).flatMap((a) => a.inDesignCampaignIds) : []
  } catch {
    data.inDesignCampaignIds = 'not read: google-ads-experiments shows them'
  }
  return out
}

// ── create-google-experiment ────────────────────────────────────────────────────────────────────────────────────

const createRequest = (a: Record<string, unknown>): CreateExperimentRequest => ({
  type: a.type as CreateExperimentRequest['type'],
  campaignId: String(a.campaignId ?? ''),
  name: String(a.name ?? ''),
  description: a.description as string | undefined,
  suffix: a.suffix as string | undefined,
  trafficSplitPct: a.trafficSplitPct as number | undefined,
  startDate: a.startDate as string | undefined,
  endDate: a.endDate as string | undefined,
  syncEnabled: a.syncEnabled as boolean | undefined,
  controlArmName: a.controlArmName as string | undefined,
  treatmentArmName: a.treatmentArmName as string | undefined,
})

const buildCreate = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = createRequest(args)
  const [campaign] = await liveExperimentCampaigns(account.target, [request.campaignId])
  const experiments = await liveExperimentList(account.target)
  const campaignNames = SYSTEM_MANAGED_TYPES.has(request.type) ? await liveCampaignNames(account.target) : []
  return createExperimentDraft(customerResource(account.target), request, { campaign: campaign ?? null, experiments, campaignNames })
}

const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CreateExperimentRecord & { accountId?: string; customerId?: string }
    if (!after.experimentId || !NUMERIC.test(after.experimentId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const e = await liveExperiment(account.target, after.experimentId)
    return { ...after, status: e?.status ?? 'REMOVED' }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as CreateExperimentRecord & { accountId?: string }
    if (!after.experimentId || !NUMERIC.test(after.experimentId)) return { refusal: 'This change does not record the experiment it made.' }
    const account = after.accountId ? { accountId: after.accountId } : {}
    if (after.status === 'SETUP') return { tool: 'set-google-experiment', args: { ...account, experimentId: after.experimentId, remove: true, why: 'undo of an experiment made (never scheduled)' } }
    return { tool: 'end-google-experiment', args: { ...account, experimentId: after.experimentId, why: 'undo of an experiment made (it ran from when it was made: ending it stops it)' } }
  },
}

const createGoogleExperiment: AgentTool = {
  ...common,
  name: 'create-google-experiment',
  title: 'Make a Google Ads experiment',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    type: z.enum(CREATE_EXPERIMENT_TYPES).describe('SEARCH_CUSTOM (a Search campaign against a changed copy), DISPLAY_CUSTOM (the same for Display), ADOPT_BROAD_MATCH_KEYWORDS (broad match on half of a Search campaign\'s traffic, from now)'),
    campaignId: googleIdArg('the campaign to test (the control)'),
    name: z.string().trim().min(1).max(1024).describe('the experiment\'s name (unique in the account)'),
    description: z.string().trim().min(1).max(2048).optional().describe('what it tests, in a sentence'),
    suffix: z.string().min(1).max(100).optional().describe('custom experiments: added to the campaign\'s name to name the treatment campaign (default " [experiment]")'),
    trafficSplitPct: z.coerce.number().int().min(1).max(99).optional().describe('custom experiments: the treatment\'s share of the traffic in % (default 50; the campaign keeps the rest). Broad match: 50 only'),
    startDate: dayArg('the first day it serves (default: when scheduled, or now)').optional(),
    endDate: dayArg('the last day it serves (default: the campaign\'s end)').optional(),
    syncEnabled: z.boolean().optional().describe('custom experiments: copy changes made to the campaign to the treatment while it runs (cannot be turned off later)'),
    controlArmName: z.string().trim().min(1).max(1024).optional().describe('the control arm\'s name (default "Control")'),
    treatmentArmName: z.string().trim().min(1).max(1024).optional().describe('the treatment arm\'s name (default "Treatment")'),
    why: googleWhyArg,
  }),
  description:
    'Make a Google Ads experiment on one campaign of the business\'s chosen Google Ads account: the experiment and its two '
    + 'arms (control = the campaign, treatment = its share of the traffic) in one request. SEARCH_CUSTOM / DISPLAY_CUSTOM: '
    + 'made in SETUP, nothing serves; Google makes the treatment\'s in-design campaign (a copy that never serves) which '
    + 'must be changed before schedule-google-experiment (Google refuses a treatment with no change). Nexus\'s '
    + 'set-google-… tools do not read Google\'s drafts yet, so change the in-design campaign in Google Ads for now; once '
    + 'scheduled, the experiment campaign is changed with the set-google-… tools on its id. The campaign must be on a '
    + 'budget of its own (Google cannot schedule one on a shared budget). ADOPT_BROAD_MATCH_KEYWORDS: runs from its '
    + 'start (or now), 50/50, broad match on the treatment half — SPENDS MONEY when the campaign is enabled. Other types '
    + '(AI Max, Performance Max ones, video, hotel, campaign mixes) are not made here. Undo removes an experiment never '
    + 'scheduled, or ends a broad match one.' + GOOGLE_CHANGE_RULES,
  undo: createUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildCreate(args)),
  execute: async (args, ctx) => withInDesign(await runGoogleChange(args, ctx, buildCreate(args), (draft, responses) => {
    const experimentId = resultId(responses[0], 'experimentResult') ?? 'new'
    const after = { ...(draft.after as CreateExperimentRecord), experimentId }
    return { data: { experimentId, status: after.status }, before: draft.before, after }
  }), args),
}

// ── set-google-experiment ────────────────────────────────────────────────────────────────────────────────────────

const setRequest = (a: Record<string, unknown>): SetExperimentRequest => ({
  experimentId: String(a.experimentId ?? ''),
  name: a.name as string | undefined,
  description: a.description as string | undefined,
  startDate: a.startDate as string | undefined,
  endDate: a.endDate as string | undefined,
  remove: a.remove === true,
})

const buildSet = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = setRequest(args)
  const experiment = await liveExperiment(account.target, request.experimentId)
  const experiments = request.name !== undefined ? await liveExperimentList(account.target) : []
  return setExperimentDraft(customerResource(account.target), request, { experiment, experiments })
}

const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as SetExperimentRecord & { accountId?: string; customerId?: string }
    if (after.removed) return change.after
    const account = await recordAccount(after)
    if (!account) return null
    const e = await liveExperiment(account.target, after.experimentId)
    if (!e) return null
    const now = { name: e.name, description: e.description, startDate: e.start, endDate: e.end }
    return { ...after, fields: Object.fromEntries(Object.keys(after.fields ?? {}).map((k) => [k, now[k as keyof typeof now]])) }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as SetExperimentRecord & { accountId?: string }
    const after = (change.after ?? {}) as SetExperimentRecord & { accountId?: string }
    if (after.removed) return { refusal: 'A removed experiment cannot be brought back: make it again with create-google-experiment.' }
    const fields = before.fields ?? {}
    const empty = Object.entries(fields).filter(([, v]) => v === null || v === undefined || v === '').map(([k]) => k)
    if (empty.length) return { refusal: `The experiment had no ${empty.join(' or ')} before this change, and Nexus cannot clear one in Google: change it by hand.` }
    if (!Object.keys(fields).length) return { refusal: 'This change records nothing it replaced.' }
    const accountId = after.accountId ?? before.accountId
    return { tool: 'set-google-experiment', args: { ...(accountId ? { accountId } : {}), experimentId: after.experimentId, ...fields, why: 'undo of an earlier experiment change' } }
  },
}

const setGoogleExperiment: AgentTool = {
  ...common,
  name: 'set-google-experiment',
  title: 'Change a Google Ads experiment',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    experimentId: experimentIdArg,
    name: z.string().trim().min(1).max(1024).optional().describe('its new name (unique in the account)'),
    description: z.string().trim().min(1).max(2048).optional().describe('its new description'),
    startDate: dayArg('its new first day (not once the old one has passed)').optional(),
    endDate: dayArg('its new last day (not in the past)').optional(),
    remove: z.boolean().optional().describe('true: remove an experiment that was never scheduled (SETUP), with its in-design campaign; alone, without other changes'),
    why: googleWhyArg,
  }),
  description:
    'Change one Google Ads experiment of the business\'s chosen Google Ads account: its name, description, start or end '
    + 'day (not of an experiment that is over), or remove one that was never scheduled (its in-design campaign goes with '
    + 'it; nothing of it served). A later end day or an earlier start day of a running experiment is marked SPENDS MONEY '
    + '(the treatment serves longer on part of the campaign\'s budget). To stop a running one use end-google-experiment. '
    + 'Undo puts the old name, description and days back; a removal cannot be undone.' + GOOGLE_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildSet(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildSet(args), (draft) => ({
    data: { experimentId: (draft.after as SetExperimentRecord).experimentId, ...(draft.after as SetExperimentRecord).removed ? { removed: true } : { fields: (draft.after as SetExperimentRecord).fields } },
    before: draft.before,
    after: draft.after,
  })),
}

// ── schedule-google-experiment ───────────────────────────────────────────────────────────────────────────────────

const buildSchedule = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const experimentId = String(args.experimentId ?? '')
  const experiment = await liveExperiment(account.target, experimentId)
  const campaigns = await liveExperimentCampaigns(account.target, armCampaignIds(experiment))
  return scheduleExperimentDraft(customerResource(account.target), { experimentId, experiment, campaigns })
}

const scheduleUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ScheduleRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const e = await liveExperiment(account.target, after.experimentId)
    return { ...after, scheduled: e?.status === 'INITIATED' || e?.status === 'ENABLED' }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as ScheduleRecord & { accountId?: string }
    if (!after.experimentId || !NUMERIC.test(after.experimentId)) return { refusal: 'This change does not record the experiment it scheduled.' }
    return { tool: 'end-google-experiment', args: { ...(after.accountId ? { accountId: after.accountId } : {}), experimentId: after.experimentId, why: 'undo of a scheduled experiment (ends it; Google cannot unschedule one)' } }
  },
}

const scheduleGoogleExperiment: AgentTool = {
  ...common,
  name: 'schedule-google-experiment',
  title: 'Schedule a Google Ads experiment',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage],
  input: z.object({ accountId: googleAccountArg, experimentId: experimentIdArg, why: googleWhyArg }),
  description:
    'Schedule a custom Google Ads experiment that is in SETUP (business\'s chosen Google Ads account): Google turns the '
    + 'treatment\'s in-design campaign into the experiment campaign, which serves its share of the campaign\'s traffic '
    + 'from the start day, on the campaign\'s own budget shared by both arms (not raised) — SPENDS MONEY when the campaign '
    + 'is enabled. Google does it over a while (a long-running operation): the answer names Google\'s operation, and '
    + 'google-ads-experiments shows when it is done or why it failed (Google refuses a treatment with no change, and a '
    + 'campaign on a shared budget). Undo ends the experiment (Google cannot unschedule one).' + GOOGLE_CHANGE_RULES,
  undo: scheduleUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildSchedule(args), actionSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildSchedule(args), (draft, responses) => ({
    data: { experimentId: (draft.after as ScheduleRecord).experimentId, operation: operationOf(responses), state: 'Google started scheduling it: not done until google-ads-experiments shows it ENABLED.' },
    before: draft.before,
    after: draft.after,
  }), actionSender),
}

// ── end-google-experiment ────────────────────────────────────────────────────────────────────────────────────────

const buildEnd = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const experimentId = String(args.experimentId ?? '')
  const experiment = await liveExperiment(account.target, experimentId)
  const campaigns = await liveExperimentCampaigns(account.target, (experiment?.arms.find((a) => a.control)?.campaignIds ?? []))
  return endExperimentDraft(customerResource(account.target), { experimentId, experiment, campaigns })
}

const endGoogleExperiment: AgentTool = {
  ...common,
  name: 'end-google-experiment',
  title: 'End a Google Ads experiment',
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({ accountId: googleAccountArg, experimentId: experimentIdArg, why: googleWhyArg }),
  description:
    'End a scheduled or running Google Ads experiment now (business\'s chosen Google Ads account): the treatment stops '
    + 'serving (Google keeps its campaign and numbers) and the campaign serves all its traffic as it is; a broad match '
    + 'experiment\'s feature is turned off. A safe step. It cannot be undone: an ended experiment does not start again '
    + '(a new test is a new experiment).' + GOOGLE_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildEnd(args), actionSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildEnd(args), (draft) => ({ data: { experimentId: String(args.experimentId), ended: true }, before: draft.before, after: draft.after }), actionSender),
}

// ── promote-google-experiment ───────────────────────────────────────────────────────────────────────────────────

const buildPromote = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const experimentId = String(args.experimentId ?? '')
  const experiment = await liveExperiment(account.target, experimentId)
  const baseId = experiment?.arms.find((a) => a.control)?.campaignIds[0]
  const treatmentId = experiment && SYSTEM_MANAGED_TYPES.has(experiment.type ?? '') ? experiment.arms.find((a) => !a.control)?.campaignIds[0] : undefined
  const base = baseId ? await liveSettingsWithDrafts(account.target, baseId) : null
  const treatment = treatmentId ? await liveSettingsWithDrafts(account.target, treatmentId) : null
  return promoteExperimentDraft(customerResource(account.target), account.currency, { experimentId, experiment, base, treatment })
}

const promoteGoogleExperiment: AgentTool = {
  ...common,
  name: 'promote-google-experiment',
  title: 'Promote a Google Ads experiment',
  reversibility: 'none',
  requires: [F.adsCampaignsManage, F.adsBidsEdit, ADSPEND],
  restrictedFields: SETTINGS_MONEY,
  input: z.object({ accountId: googleAccountArg, experimentId: experimentIdArg, why: googleWhyArg }),
  description:
    'Promote a running Google Ads experiment (business\'s chosen Google Ads account): Google applies the treatment to the '
    + 'campaign for ALL its traffic — settings, bids, keywords and ads — and the treatment stops serving. The preview '
    + 'shows the main settings from → to; it is marked SPENDS MONEY (Nexus cannot list every difference; a higher target '
    + 'CPA, a lower target ROAS, a higher CPC ceiling, wider networks, AI Max or broad match are named). Google does it '
    + 'over a while (a long-running operation): google-ads-experiments shows when it is done. Not for Performance Max '
    + 'experiments (graduate those). It cannot be undone: Google has no un-promote; the preview\'s "from" side is what '
    + 'the campaign had, to put back by hand.' + GOOGLE_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildPromote(args), actionSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildPromote(args), (draft, responses) => ({
    data: { experimentId: String(args.experimentId), operation: operationOf(responses), state: 'Google started the promote: not done until google-ads-experiments shows it COMPLETED.' },
    before: draft.before,
    after: draft.after,
  }), actionSender),
}

// ── graduate-google-experiment ──────────────────────────────────────────────────────────────────────────────────

const buildGraduate = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const experimentId = String(args.experimentId ?? '')
  const experiment = await liveExperiment(account.target, experimentId)
  const campaigns = await liveExperimentCampaigns(account.target, armCampaignIds(experiment))
  const budgets = await liveBudgets(account.target)
  const request = { experimentId, budgetId: String(args.budgetId ?? ''), ...(typeof args.campaignId === 'string' ? { campaignId: args.campaignId } : {}) }
  return graduateExperimentDraft(customerResource(account.target), account.currency, request, { experiment, campaigns, budgets })
}

const graduateUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as GraduateRecord & { accountId?: string; customerId?: string }
    if (!after.campaignId || !NUMERIC.test(after.campaignId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const [campaign] = await liveExperimentCampaigns(account.target, [after.campaignId])
    return { ...after, budgetId: campaign?.budget?.budgetId ?? null }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as GraduateRecord & { accountId?: string }
    if (!after.campaignId || !NUMERIC.test(after.campaignId)) return { refusal: 'This change does not record the campaign it graduated.' }
    return {
      tool: 'set-google-status',
      args: { ...(after.accountId ? { accountId: after.accountId } : {}), items: [{ kind: 'campaign', id: after.campaignId }], status: 'PAUSED', why: 'undo of a graduation (Google cannot undo one): the graduated campaign is paused' },
    }
  },
}

const graduateGoogleExperiment: AgentTool = {
  ...common,
  name: 'graduate-google-experiment',
  title: 'Graduate a Google Ads experiment',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: SETTINGS_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    experimentId: experimentIdArg,
    budgetId: googleIdArg('the budget the graduated campaign uses from now: not the experiment campaign\'s (it shares it with the campaign); a shared budget, or one set-google-budget made'),
    campaignId: googleIdArg('the treatment\'s experiment campaign to graduate (google-ads-experiments shows it); needed only when the experiment has more than one').optional(),
    why: googleWhyArg,
  }),
  description:
    'Graduate a running or ended custom Google Ads experiment (business\'s chosen Google Ads account): its treatment '
    + 'campaign becomes a campaign of its own on the budget named for it, beside the campaign (which is not changed). '
    + 'Google graduates one campaign per request. It keeps serving on that budget — SPENDS MONEY (the preview names the '
    + 'budget and its daily amount); to graduate it paused, pause it first with set-google-status. Not for '
    + 'broad match or AI Max experiments (no campaign of their own: promote or end them). Google cannot undo a '
    + 'graduation: undo pauses the graduated campaign.' + GOOGLE_CHANGE_RULES,
  undo: graduateUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildGraduate(args), actionSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildGraduate(args), (draft) => ({
    data: { experimentId: String(args.experimentId), graduated: { campaignId: (draft.after as GraduateRecord).campaignId, budgetId: (draft.after as GraduateRecord).budgetId } },
    before: draft.before,
    after: draft.after,
  }), actionSender),
}

// ── set-google-campaign-draft ───────────────────────────────────────────────────────────────────────────────────

const draftRequest = (a: Record<string, unknown>): CampaignDraftRequest => ({
  create: a.create as CampaignDraftRequest['create'],
  draftId: a.draftId as string | undefined,
  name: a.name as string | undefined,
  remove: a.remove === true,
})

const buildDraft = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = draftRequest(args)
  const drafts = await liveCampaignDrafts(account.target)
  const [campaign] = request.create ? await liveExperimentCampaigns(account.target, [request.create.campaignId]) : []
  return campaignDraftChange(customerResource(account.target), request, { drafts, campaign: campaign ?? null })
}

const DRAFT_ID = /^\d{1,20}~\d{1,20}$/

const draftUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CampaignDraftRecord & { accountId?: string; customerId?: string }
    if (after.action === 'remove') return change.after
    if (!after.draftId || !DRAFT_ID.test(after.draftId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const d = (await liveCampaignDrafts(account.target)).find((x) => x.draftId === after.draftId)
    if (after.action === 'create') return { ...after, status: d?.status ?? 'REMOVED' }
    return { ...after, name: d?.name ?? null }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as CampaignDraftRecord
    const after = (change.after ?? {}) as CampaignDraftRecord & { accountId?: string }
    const account = after.accountId ? { accountId: after.accountId } : {}
    if (after.action === 'remove') return { refusal: 'A removed campaign draft cannot be brought back: make a new one with set-google-campaign-draft.' }
    if (!after.draftId || !DRAFT_ID.test(after.draftId)) return { refusal: 'This change does not record the campaign draft it changed.' }
    if (after.action === 'create') return { tool: 'set-google-campaign-draft', args: { ...account, draftId: after.draftId, remove: true, why: 'undo of a campaign draft made' } }
    const old = before.action === 'rename' ? before.name : null
    if (!old) return { refusal: 'The draft had no name before this change: there is no name to put back.' }
    return { tool: 'set-google-campaign-draft', args: { ...account, draftId: after.draftId, name: old, why: 'undo of a campaign draft renamed' } }
  },
}

const setGoogleCampaignDraft: AgentTool = {
  ...common,
  name: 'set-google-campaign-draft',
  title: 'Make or change a campaign draft',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    create: z.object({
      campaignId: googleIdArg('the campaign the draft is of'),
      name: z.string().trim().min(1).max(255).describe('the draft\'s name'),
    }).optional().describe('make a campaign draft (give create, or draftId with name or remove)'),
    draftId: draftIdArg.optional(),
    name: z.string().trim().min(1).max(255).optional().describe('with draftId: the draft\'s new name'),
    remove: z.boolean().optional().describe('with draftId: true removes the draft (not one being or already promoted)'),
    why: googleWhyArg,
  }),
  description:
    'A campaign draft of the business\'s chosen Google Ads account (Google Ads "Drafts"): make one of a campaign (Google '
    + 'makes its draft campaign, a copy that never serves), rename one, or remove one. Nothing serves and nothing spends. '
    + 'Nexus\'s set-google-… tools do not read Google\'s drafts yet, so the draft campaign is changed in Google Ads for '
    + 'now; promote-google-campaign-draft applies a draft to its campaign. Undo removes a draft it made or puts the old '
    + 'name back; a removal cannot be undone.' + GOOGLE_CHANGE_RULES,
  undo: draftUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildDraft(args)),
  execute: async (args, ctx) => {
    const out = await runGoogleChange(args, ctx, buildDraft(args), (draft, responses) => {
      const record = draft.after as CampaignDraftRecord
      if (record.action !== 'create') return { data: { draftId: record.draftId }, before: draft.before, after: draft.after }
      const draftId = resultId(responses[0], 'campaignDraftResult') ?? 'new'
      return { data: { draftId }, before: draft.before, after: { ...record, draftId } }
    })
    const data = out.data as Record<string, unknown> | undefined
    if (!out.ok || !data || !args.create || typeof data.draftId !== 'string' || !DRAFT_ID.test(data.draftId)) return out
    try {
      const account = await googleChangeAccount(typeof args.accountId === 'string' ? args.accountId : null)
      if (!('refusal' in account)) data.draftCampaignId = (await liveCampaignDrafts(account.target)).find((d) => d.draftId === data.draftId)?.draftCampaignId ?? null
    } catch { data.draftCampaignId = 'not read: google-ads-experiments shows it' }
    return out
  },
}

// ── promote-google-campaign-draft ───────────────────────────────────────────────────────────────────────────────

const buildPromoteDraft = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const draftId = String(args.draftId ?? '')
  const draft = (await liveCampaignDrafts(account.target)).find((d) => d.draftId === draftId) ?? null
  const base = draft?.baseCampaignId ? await liveSettingsWithDrafts(account.target, draft.baseCampaignId) : null
  const draftCampaign = draft?.draftCampaignId ? await liveSettingsWithDrafts(account.target, draft.draftCampaignId) : null
  return promoteCampaignDraftDraft(customerResource(account.target), account.currency, { draftId, draft, base, draftCampaign })
}

const promoteGoogleCampaignDraft: AgentTool = {
  ...common,
  name: 'promote-google-campaign-draft',
  title: 'Promote a Google Ads campaign draft',
  reversibility: 'none',
  requires: [F.adsCampaignsManage, F.adsBidsEdit, ADSPEND],
  restrictedFields: SETTINGS_MONEY,
  input: z.object({ accountId: googleAccountArg, draftId: draftIdArg, why: googleWhyArg }),
  description:
    'Promote a campaign draft of the business\'s chosen Google Ads account: Google applies the draft\'s changes to its '
    + 'campaign — settings, bids, keywords and ads. The preview shows the main settings from → to and is marked SPENDS '
    + 'MONEY (Nexus cannot list every difference). Google does it over a while (a long-running operation): '
    + 'google-ads-experiments shows when it is done. If it fails part-way, Google says the draft cannot be promoted again '
    + 'safely and the campaign is put right by hand. It cannot be undone (Google has no un-promote).' + GOOGLE_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildPromoteDraft(args), actionSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildPromoteDraft(args), (draft, responses) => ({
    data: { draftId: String(args.draftId), operation: operationOf(responses), state: 'Google started the promote: not done until google-ads-experiments shows the draft PROMOTED.' },
    before: draft.before,
    after: draft.after,
  }), actionSender),
}

// ── google-ads-experiments (read) ───────────────────────────────────────────────────────────────────────────────

const STATE: Record<string, string> = {
  SETUP: 'Not scheduled: change the treatment\'s in-design campaign, then schedule-google-experiment.',
  INITIATED: 'Google is scheduling it (making the experiment campaign): not done yet.',
  ENABLED: 'Scheduled: it serves from its start day to its end day.',
  HALTED: 'Ended.',
  PROMOTED: 'Promoted into the campaign.',
  GRADUATED: 'Graduated: the treatment campaign is a campaign of its own.',
}
const PROMOTE_STATE: Record<string, string> = {
  IN_PROGRESS: 'Google is promoting it: not done yet.', COMPLETED: 'Google finished the promote.',
  COMPLETED_WITH_WARNING: 'Google finished the promote, with warnings.', FAILED: 'Google\'s promote failed (errors below).',
}

async function readExperiments(args: Record<string, unknown>): Promise<ToolResult> {
  const account = await googleChangeAccount(typeof args.accountId === 'string' ? args.accountId : null)
  if ('refusal' in account) return { ok: false, error: account.refusal }
  const base = { account: { accountId: account.accountId, customerId: account.customerId, name: account.name, currency: account.currency }, readAt: new Date().toISOString(), source: 'Read live from Google now.' }
  const notRead: Array<{ part: string; why: string }> = []
  const soft = async <T>(part: string, read: () => Promise<T>): Promise<T | null> => {
    try { return await read() } catch (err) { notRead.push({ part, why: err instanceof Error ? err.message : String(err) }); return null }
  }
  try {
    if (typeof args.experimentId === 'string') {
      const e = await liveExperiment(account.target, args.experimentId)
      if (!e) return { ok: false, error: `Experiment ${args.experimentId} is not in the Google Ads account (or it was removed).` }
      const campaigns = await liveExperimentCampaigns(account.target, armCampaignIds(e))
      const operation = e.operation ? await soft('long-running-operation', () => readLongRunningOperation(account.target, e.operation!)) : null
      const failed = e.promoteStatus === 'FAILED' || !!operation?.error
      const errors = failed ? await soft('async-errors', () => readAsyncErrors(account.target, e.resourceName, 'experiment')) : null
      return {
        ok: true,
        data: {
          ...base,
          experiment: { ...e, state: STATE[e.status ?? ''] ?? e.status, ...(e.promoteStatus && PROMOTE_STATE[e.promoteStatus] ? { promoteState: PROMOTE_STATE[e.promoteStatus] } : {}) },
          campaigns,
          ...(operation ? { operation } : {}),
          ...(errors ? { asyncErrors: errors } : {}),
          ...(notRead.length ? { notRead } : {}),
        },
      }
    }
    if (typeof args.draftId === 'string') {
      const d = (await liveCampaignDrafts(account.target)).find((x) => x.draftId === args.draftId)
      if (!d) return { ok: false, error: `Campaign draft ${args.draftId} is not in the Google Ads account (or it was removed).` }
      const campaigns = await liveExperimentCampaigns(account.target, [d.baseCampaignId, d.draftCampaignId].filter((x): x is string => !!x))
      const operation = d.operation ? await soft('long-running-operation', () => readLongRunningOperation(account.target, d.operation!)) : null
      const errors = d.status === 'PROMOTE_FAILED' || operation?.error ? await soft('async-errors', () => readAsyncErrors(account.target, d.resourceName, 'draft')) : null
      return { ok: true, data: { ...base, draft: d, campaigns, ...(operation ? { operation } : {}), ...(errors ? { asyncErrors: errors } : {}), ...(notRead.length ? { notRead } : {}) } }
    }
    const experiments = await liveExperimentList(account.target)
    const drafts = await soft('campaign-drafts', () => liveCampaignDrafts(account.target))
    return {
      ok: true,
      data: {
        ...base,
        experiments: experiments.map((e) => ({ ...e, state: STATE[e.status ?? ''] ?? e.status })),
        drafts: drafts ?? [],
        total: { experiments: experiments.length, drafts: drafts?.length ?? 0 },
        ...(notRead.length ? { notRead } : {}),
      },
    }
  } catch (err) {
    if (err instanceof GoogleAdsReadError) return { ok: false, error: err.message }
    if (err instanceof Error && /Nothing was sent/.test(err.message)) return { ok: false, error: err.message }
    throw err
  }
}

const googleAdsExperiments: AgentTool = {
  name: 'google-ads-experiments',
  title: 'Google Ads experiments and drafts',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: { amountCents: ADSPEND },
  input: z.object({
    accountId: googleAccountArg,
    experimentId: googleIdArg('one experiment: its arms, campaigns, Google\'s long-running work and its errors').optional(),
    draftId: draftIdArg.optional(),
  }),
  description:
    'Google Ads experiments and campaign drafts of the business\'s chosen Google Ads account, read LIVE from Google: '
    + 'every experiment with its status in words, arms, traffic split, the campaign of each arm and the treatment\'s '
    + 'in-design campaign (Google\'s drafts included), and every campaign draft with its draft campaign. experimentId: one '
    + 'experiment with its campaigns (status, type, budget) and the state of Google\'s long-running schedule or promote '
    + '(done or not, and the errors Google kept when it failed). draftId (campaignId~draftId): one draft and its promote. '
    + 'Each read costs a few operations of the account\'s daily Google Ads allowance. Read only.',
  handler: (args) => asLiveRead(() => readExperiments(args)),
}

export const GOOGLE_ADS_EXPERIMENT_TOOLS: AgentTool[] = [
  googleAdsExperiments, createGoogleExperiment, setGoogleExperiment, scheduleGoogleExperiment, endGoogleExperiment,
  promoteGoogleExperiment, graduateGoogleExperiment, setGoogleCampaignDraft, promoteGoogleCampaignDraft,
]
