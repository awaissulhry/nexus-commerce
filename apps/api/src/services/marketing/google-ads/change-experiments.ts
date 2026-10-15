/**
 * Google Ads changes, G9 (2026-10-15) — experiments and campaign drafts, as pure builders: a request and the account's
 * live state (live-experiments.ts) → the change Google gets (one request) and what a person reads, or a refusal. No call.
 *
 * Google's facts, checked 2026-10-15 in the v25 reference and protos (developers.google.com/google-ads/api/reference/
 * rpc/v25/Experiment, ExperimentArm, ExperimentTypeEnum.ExperimentType, ExperimentStatusEnum.ExperimentStatus,
 * ExperimentErrorEnum, CampaignDraft, CampaignDraftStatusEnum; googleapis v25 experiment.proto, experiment_arm.proto,
 * experiment_service.proto, campaign_draft.proto, campaign_draft_service.proto, google_ads_service.proto) and Google's
 * guides (docs/experiments/overview, system-managed, intra-campaign, async-errors):
 *   - An experiment is made with GoogleAdsService.Mutate (MutateOperation.experiment_operation and
 *     experiment_arm_operation): the experiment with a temporary id (`customers/{id}/experiments/-1`, as Google's
 *     intra-campaign sample does) and its arms in ONE request (Google: all arms in one request, no partial failure).
 *     Google's system-managed sample sends the experiment and its arms as two requests; Nexus sends them as one (all or
 *     nothing, nothing half-made), and Google's validate_only check of exactly that request comes before it is queued.
 *     Experiment: name (1–1,024, unique in the account), description (≤ 2,048), suffix (added to the base campaign's name
 *     to name the treatment campaign), type, status, start_date / end_date (YYYY-MM-DD, the account's day; start not in
 *     the past, at most a year ahead), sync_enabled (immutable; SEARCH_CUSTOM and DISPLAY_CUSTOM only).
 *     Arm: experiment, name (1–1,024, unique in the experiment), control, traffic_split (1–100, the arms total 100),
 *     campaigns (at most one; the control arm names the base campaign).
 *   - System-managed types (SEARCH_CUSTOM, DISPLAY_CUSTOM, …) start in SETUP: Google makes the treatment's in-design
 *     campaign (a draft copy of the base campaign) when the treatment arm is made; it must be changed before
 *     ScheduleExperiment, which turns it into the experiment campaign (long-running). The treatment shares the base
 *     campaign's budget; Google refuses to schedule when that budget is shared or a custom-period one
 *     (CANNOT_CREATE_EXPERIMENT_CAMPAIGN_WITH_SHARED_BUDGET / _CUSTOM_BUDGET).
 *   - ADOPT_BROAD_MATCH_KEYWORDS (intra-campaign): made ENABLED, both arms name the same Search campaign, split 50/50;
 *     broad match serves the treatment half from the start. Ending it turns the feature off.
 *   - End (synchronous) stops the treatment; Promote (long-running) applies the treatment to the base campaign — not
 *     for PMAX_REPLACEMENT_SHOPPING or PMAX_TEXT_CUSTOMIZATION_FINAL_URL_EXPANSION; Graduate (synchronous) makes ONE
 *     treatment campaign a campaign of its own on the budget named for it (campaign_budget_mappings: "The maximum size
 *     is one") — not for ADOPT_AI_MAX or ADOPT_BROAD_MATCH_KEYWORDS. Google cannot undo a promote or a graduation.
 *   - REST (Google Ads v25 discovery document, googleads.googleapis.com/$discovery/rest?version=v25, 2026-10-15):
 *     customers.experiments.scheduleExperiment / endExperiment / promoteExperiment / graduateExperiment and
 *     customers.campaignDrafts.promote are POSTs on the resource name; their bodies hold validateOnly (and
 *     campaignBudgetMappings for a graduate) and nothing else. MutateOperation has experimentOperation,
 *     experimentArmOperation and campaignDraftOperation; MutateOperationResponse experimentResult and campaignDraftResult.
 *   - ExperimentErrorEnum (v25) names what the refusals and warnings here say before Google does:
 *     OVERLAPPING_MEMBERS_AND_DATE_RANGE, DUPLICATE_EXPERIMENT_NAME, DUPLICATE_EXPERIMENT_CAMPAIGN_NAME,
 *     CANNOT_ENABLE_SYNC_FOR_UNSUPPORTED_EXPERIMENT_TYPE, CANNOT_CREATE_EXPERIMENT_CAMPAIGN_WITH_SHARED_BUDGET / _CUSTOM_BUDGET,
 *     IN_DESIGN_CAMPAIGNS_NOT_SET, END_DATE_BEFORE_START_DATE, START_DATE_ALREADY_PASSED, CANNOT_SET_END_DATE_IN_PAST.
 *   - Campaign drafts are still in v25 (CampaignDraftService: MutateCampaignDrafts, PromoteCampaignDraft — long-running —
 *     and ListCampaignDraftAsyncErrors; MutateOperation.campaign_draft_operation): a draft has base_campaign
 *     (immutable), name; Google makes its draft campaign; status PROPOSED → PROMOTING → PROMOTED, or PROMOTE_FAILED
 *     ("failed after it was partially applied; cannot be attempted again safely").
 * Not offered (said in the tools): ADOPT_AI_MAX (it changes the campaign's own AI Max and text-asset settings),
 * PMAX_REPLACEMENT_SHOPPING / PMAX_TEXT_CUSTOMIZATION_FINAL_URL_EXPANSION / OPTIMIZE_ASSETS (Performance Max),
 * COMPARE_CAMPAIGNS, YOUTUBE_CUSTOM, HOTEL_CUSTOM (no such campaigns in Nexus's tools); the *_AUTOMATED_BIDDING_STRATEGY
 * and AD_VARIATION types are in no workflow of Google's v25 guides.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveBudget, LiveCampaignDetail } from './live.js'
import type { LiveCampaignDraft, LiveExperimentCampaign, LiveExperimentState } from './live-experiments.js'

type Refusal = { refusal: string }
type Settings = LiveCampaignDetail['campaign']

/** The experiment types Nexus makes. */
export const CREATE_EXPERIMENT_TYPES = ['SEARCH_CUSTOM', 'DISPLAY_CUSTOM', 'ADOPT_BROAD_MATCH_KEYWORDS'] as const
export type CreateExperimentType = typeof CREATE_EXPERIMENT_TYPES[number]

/** Google's system-managed types: a treatment campaign of their own, made when the experiment is scheduled. */
export const SYSTEM_MANAGED_TYPES: ReadonlySet<string> = new Set(['SEARCH_CUSTOM', 'DISPLAY_CUSTOM', 'HOTEL_CUSTOM', 'YOUTUBE_CUSTOM', 'PMAX_REPLACEMENT_SHOPPING'])
const NOT_PROMOTABLE: ReadonlySet<string> = new Set(['PMAX_REPLACEMENT_SHOPPING', 'PMAX_TEXT_CUSTOMIZATION_FINAL_URL_EXPANSION'])
const NOT_GRADUATABLE: ReadonlySet<string> = new Set(['ADOPT_AI_MAX', 'ADOPT_BROAD_MATCH_KEYWORDS'])
const BASE_CHANNEL: Record<CreateExperimentType, string> = { SEARCH_CUSTOM: 'SEARCH', DISPLAY_CUSTOM: 'DISPLAY', ADOPT_BROAD_MATCH_KEYWORDS: 'SEARCH' }
const TYPE_NAME: Record<string, string> = {
  SEARCH_CUSTOM: 'custom Search', DISPLAY_CUSTOM: 'custom Display', ADOPT_BROAD_MATCH_KEYWORDS: 'broad match keywords',
  ADOPT_AI_MAX: 'AI Max', HOTEL_CUSTOM: 'custom Hotel', YOUTUBE_CUSTOM: 'custom Video', PMAX_REPLACEMENT_SHOPPING: 'Performance Max versus Shopping',
  PMAX_TEXT_CUSTOMIZATION_FINAL_URL_EXPANSION: 'Performance Max final URL expansion', COMPARE_CAMPAIGNS: 'compare campaigns', OPTIMIZE_ASSETS: 'optimize assets',
}
const typeName = (type: string | null) => (type ? TYPE_NAME[type] ?? type.toLowerCase().replace(/_/g, ' ') : 'unknown')

/** Google's default suffix in its own samples. */
export const DEFAULT_SUFFIX = ' [experiment]'

export const NOT_DONE_YET = 'Google does this over a while (a long-running operation): the answer names Google\'s operation, and '
  + 'google-ads-experiments shows when Google has finished or why it failed. Nexus never says it is done before Google does.'

const DAY = /^\d{4}-\d{2}-\d{2}$/
function dayProblem(value: string | undefined, what: string): string | null {
  if (value === undefined) return null
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) return `${what} "${value}" is not a day (YYYY-MM-DD)`
  return null
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

const ENDED: ReadonlySet<string> = new Set(['HALTED', 'PROMOTED', 'GRADUATED', 'REMOVED'])
const statusWord: Record<string, string> = {
  SETUP: 'not scheduled yet (SETUP)', INITIATED: 'being scheduled by Google (INITIATED)', ENABLED: 'scheduled or running (ENABLED)',
  HALTED: 'ended (HALTED)', PROMOTED: 'promoted (PROMOTED)', GRADUATED: 'graduated (GRADUATED)', REMOVED: 'removed',
}
const statusOf = (s: string | null) => (s ? statusWord[s] ?? s : 'of unknown status')
/** Appended to a SPENDS MONEY line when the campaign it serves on is not enabled (the brief: say so, nothing spends yet). */
const pausedNote = (name: string, status: string | null) => ` (Campaign "${name}" is ${status ?? 'not enabled'}: nothing spends until it is enabled.)`

function draft(partial: Partial<GoogleChangeDraft> & Pick<GoogleChangeDraft, 'summary' | 'operations' | 'stands' | 'before' | 'after'>, lines: Array<[string, unknown, unknown]>, totals: Record<string, number> = {}): GoogleChangeDraft {
  const { changes, more } = changeLines(lines)
  return {
    changes,
    totals: { ...totals, ...(more ? { moreLines: more } : {}) },
    warnings: [],
    spendsMoney: [],
    skipped: [],
    ...partial,
  }
}

const armsOf = (e: LiveExperimentState) => ({ control: e.arms.find((a) => a.control) ?? null, treatments: e.arms.filter((a) => !a.control) })

// ── create-google-experiment ─────────────────────────────────────────────────────────────────────────────────────

export interface CreateExperimentRequest {
  type: CreateExperimentType
  campaignId: string
  name: string
  description?: string
  suffix?: string
  /** The treatment's share of the traffic, 1–99 (the control gets the rest). */
  trafficSplitPct?: number
  startDate?: string
  endDate?: string
  syncEnabled?: boolean
  controlArmName?: string
  treatmentArmName?: string
}

export interface CreateExperimentLive {
  campaign: LiveExperimentCampaign | null
  experiments: LiveExperimentState[]
  campaignNames: Array<{ campaignId: string; name: string }>
}

export interface CreateExperimentRecord {
  experimentId: string | null
  name?: string
  type?: string
  campaignId?: string
  status?: string | null
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function createExperimentDraft(customer: string, request: CreateExperimentRequest, live: CreateExperimentLive): GoogleChangeDraft | Refusal {
  const c = live.campaign
  if (!c || c.status === 'REMOVED') return { refusal: `Campaign ${request.campaignId} is not in the Google Ads account (google-ads-live view campaigns lists them).` }
  if (c.experimentType && c.experimentType !== 'BASE') {
    return { refusal: `Campaign "${c.name}" is itself ${c.experimentType === 'DRAFT' ? 'a draft' : 'an experiment'} campaign: an experiment starts from a campaign of its own${c.baseCampaignId ? ` (its campaign is ${c.baseCampaignId})` : ''}.` }
  }
  const systemManaged = SYSTEM_MANAGED_TYPES.has(request.type)
  if (c.type !== BASE_CHANNEL[request.type]) {
    return { refusal: `A ${typeName(request.type)} experiment is for a ${BASE_CHANNEL[request.type]} campaign; "${c.name}" is ${c.type ?? 'of an unknown type'}. Google has no custom experiment for a Standard Shopping campaign (only Performance Max versus Shopping, which Nexus does not make).` }
  }
  const name = request.name.trim()
  if (!name) return { refusal: 'The experiment needs a name.' }
  const taken = live.experiments.find((e) => sameName(e.name, name))
  if (taken) return { refusal: `An experiment named "${taken.name}" is already in the account (${taken.experimentId}, ${statusOf(taken.status)}): Google keeps experiment names unique. Pick another name.` }
  const pct = request.trafficSplitPct ?? 50
  if (!Number.isInteger(pct) || pct < 1 || pct > 99) return { refusal: 'trafficSplitPct is the treatment\'s share of the traffic: a whole number from 1 to 99.' }
  const skipped: string[] = []
  if (!systemManaged) {
    if (pct !== 50) return { refusal: 'Google splits a broad match keywords experiment 50/50 within the campaign: leave trafficSplitPct out or give 50.' }
    if (request.syncEnabled) return { refusal: 'Google syncs changes only for custom Search and Display experiments; a broad match keywords experiment has one campaign.' }
    if (request.suffix !== undefined) skipped.push('suffix: a broad match keywords experiment makes no treatment campaign, so there is no name to add it to.')
  }
  const problem = dayProblem(request.startDate, 'startDate') ?? dayProblem(request.endDate, 'endDate')
  if (problem) return { refusal: `${problem}.` }
  if (request.startDate && request.endDate && request.endDate < request.startDate) return { refusal: `endDate ${request.endDate} is before startDate ${request.startDate}.` }
  if (systemManaged && c.budget?.shared) {
    return { refusal: `Campaign "${c.name}" is on the shared budget "${c.budget.name ?? c.budget.budgetId}": Google cannot schedule an experiment of a campaign on a shared budget (CANNOT_CREATE_EXPERIMENT_CAMPAIGN_WITH_SHARED_BUDGET). Give it a budget of its own first (set-google-budget, campaigns with ownBudgetCents).` }
  }
  if (systemManaged && c.budget?.period === 'CUSTOM_PERIOD') {
    return { refusal: `Campaign "${c.name}" has a custom-period budget: Google cannot schedule an experiment of it (CANNOT_CREATE_EXPERIMENT_CAMPAIGN_WITH_CUSTOM_BUDGET). Give it a daily budget first.` }
  }
  const suffix = request.suffix ?? DEFAULT_SUFFIX
  const designName = `${c.name}${suffix}`
  if (systemManaged) {
    if (!suffix.trim()) return { refusal: 'The suffix names the treatment campaign (campaign name + suffix): it cannot be empty.' }
    const clash = live.campaignNames.find((n) => n.campaignId !== c.campaignId && sameName(n.name, designName))
    if (clash || sameName(designName, c.name)) return { refusal: `The treatment campaign would be named "${designName}", and campaign ${clash?.campaignId ?? c.campaignId} has that name: Google refuses a duplicate. Give another suffix.` }
  }
  const busy = live.experiments.filter((e) => !ENDED.has(e.status ?? '') && e.arms.some((a) => a.campaignIds.includes(c.campaignId)))
  const controlName = request.controlArmName?.trim() || 'Control'
  const treatmentName = request.treatmentArmName?.trim() || 'Treatment'
  if (sameName(controlName, treatmentName)) return { refusal: 'The two arms need different names (Google keeps arm names unique in an experiment).' }

  const experiment = `${customer}/experiments/-1`
  const campaign = `${customer}/campaigns/${c.campaignId}`
  const operations = [
    {
      experimentOperation: {
        create: {
          resourceName: experiment,
          name,
          ...(request.description?.trim() ? { description: request.description.trim() } : {}),
          ...(systemManaged ? { suffix } : {}),
          type: request.type,
          status: systemManaged ? 'SETUP' : 'ENABLED',
          ...(request.startDate ? { startDate: request.startDate } : {}),
          ...(request.endDate ? { endDate: request.endDate } : {}),
          ...(request.syncEnabled ? { syncEnabled: true } : {}),
        },
      },
    },
    { experimentArmOperation: { create: { experiment, name: controlName, control: true, trafficSplit: 100 - pct, campaigns: [campaign] } } },
    { experimentArmOperation: { create: { experiment, name: treatmentName, control: false, trafficSplit: pct, ...(systemManaged ? {} : { campaigns: [campaign] }) } } },
  ]
  const enabled = c.status === 'ENABLED'
  const spends: string[] = []
  const warnings: string[] = []
  if (systemManaged) {
    warnings.push(
      `Nothing serves yet: the experiment is made in SETUP. Google makes the treatment's in-design campaign "${designName}", a copy of "${c.name}" that never serves; `
      + 'it must be changed before scheduling (Google refuses to schedule a treatment with no change). Its id: google-ads-experiments, after this ran.',
      'Change the in-design campaign in Google Ads (Experiments) for now: Nexus\'s set-google-… tools read campaigns without Google\'s drafts, so they do not find an in-design campaign before it is scheduled.',
      `Once scheduled (schedule-google-experiment, SPENDS MONEY), the treatment serves ${pct} % of the campaign's traffic on "${c.name}"'s own budget, shared by both arms (not raised).`,
    )
  } else {
    // Intra-campaign (Google's guide): made ENABLED, the feature serves the treatment half from its start — no schedule.
    spends.push(`From ${request.startDate ?? 'now'} campaign "${c.name}" uses broad match for half of its traffic: its ads can show on more searches, on the same budget.${enabled ? '' : pausedNote(c.name, c.status)}`)
  }
  if (busy.length) warnings.push(`Campaign "${c.name}" is already in ${plural(busy.length, 'experiment')} that has not ended (${busy.map((e) => `"${e.name}"`).join(', ')}): Google refuses experiments on the same campaign whose dates overlap.`)
  if (request.syncEnabled) warnings.push('Sync on: changes made to the campaign while the experiment runs are copied to the treatment (it cannot be turned off later).')
  const lines: Array<[string, unknown, unknown]> = [
    ['experiment', null, `${name} (${typeName(request.type)})`],
    ['campaign', null, `${c.name} (${c.campaignId})`],
    ['traffic split', null, `control "${controlName}" ${100 - pct} % / treatment "${treatmentName}" ${pct} %`],
    ['dates', null, `${request.startDate ?? (systemManaged ? 'from when it is scheduled' : 'from now')} to ${request.endDate ?? 'the campaign\'s end'}`],
  ]
  if (systemManaged) lines.push(['treatment campaign', null, `${designName} (in-design copy; Google makes it)`])
  if (request.syncEnabled) lines.push(['sync from the campaign', null, 'on'])
  return draft({
    summary: `Make the ${typeName(request.type)} experiment "${name}" on campaign "${c.name}" (control ${100 - pct} % / treatment ${pct} %)${systemManaged ? ', not scheduled' : `, running from ${request.startDate ?? 'now'}`}.`,
    operations,
    spendsMoney: spends,
    warnings,
    skipped,
    stands: { campaign: { campaignId: c.campaignId, status: c.status, type: c.type, experimentType: c.experimentType, budgetShared: c.budget?.shared ?? null, budgetPeriod: c.budget?.period ?? null }, nameFree: true, designNameFree: true },
    before: { experimentId: null } satisfies CreateExperimentRecord,
    after: { experimentId: 'new', name, type: request.type, campaignId: c.campaignId, status: systemManaged ? 'SETUP' : 'ENABLED' } satisfies CreateExperimentRecord,
  }, lines, { experiments: 1, arms: 2 })
}

// ── set-google-experiment (name, description, dates; remove an unscheduled one) ───────────────────────────────

export interface SetExperimentRequest {
  experimentId: string
  name?: string
  description?: string
  startDate?: string
  endDate?: string
  remove?: boolean
}

export interface ExperimentFields { name?: string | null; description?: string | null; startDate?: string | null; endDate?: string | null }
export interface SetExperimentRecord { experimentId: string; removed?: boolean; fields?: ExperimentFields }

const FIELD_MASK: Record<keyof ExperimentFields, string> = { name: 'name', description: 'description', startDate: 'start_date', endDate: 'end_date' }

export const liveFieldsOf = (e: LiveExperimentState): Required<ExperimentFields> => ({ name: e.name, description: e.description, startDate: e.start, endDate: e.end })

export function setExperimentDraft(customer: string, request: SetExperimentRequest, live: { experiment: LiveExperimentState | null; experiments: LiveExperimentState[] }): GoogleChangeDraft | Refusal {
  const e = live.experiment
  if (!e) return { refusal: `Experiment ${request.experimentId} is not in the Google Ads account (google-ads-experiments lists them).` }
  const resourceName = `${customer}/experiments/${e.experimentId}`
  const asked = (['name', 'description', 'startDate', 'endDate'] as const).filter((k) => request[k] !== undefined)
  if (request.remove) {
    if (asked.length) return { refusal: 'remove takes the experiment away: ask for it alone, without other changes.' }
    if (e.status !== 'SETUP') {
      return { refusal: `Experiment "${e.name}" is ${statusOf(e.status)}: only an experiment that was never scheduled can be removed${e.status === 'ENABLED' || e.status === 'INITIATED' ? ' — end it with end-google-experiment (Google keeps its numbers)' : ''}.` }
    }
    const inDesign = e.arms.flatMap((a) => a.inDesignCampaignIds)
    return draft({
      summary: `Remove the experiment "${e.name}" (never scheduled; nothing of it served).`,
      operations: [{ experimentOperation: { remove: resourceName } }],
      warnings: [`Its treatment's in-design ${inDesign.length === 1 ? 'campaign' : 'campaigns'}${inDesign.length ? ` (${inDesign.join(', ')})` : ''} and the changes made to it go with it. A removed experiment cannot be brought back: a new one is made again with create-google-experiment.`],
      stands: { experimentId: e.experimentId, status: e.status, arms: e.arms },
      before: { experimentId: e.experimentId, removed: false, fields: liveFieldsOf(e) } satisfies SetExperimentRecord,
      after: { experimentId: e.experimentId, removed: true } satisfies SetExperimentRecord,
    }, [['experiment', `${e.name} (${statusOf(e.status)})`, 'removed']])
  }
  if (!asked.length) return { refusal: 'Name what changes: name, description, startDate or endDate (or remove).' }
  if (ENDED.has(e.status ?? '')) return { refusal: `Experiment "${e.name}" is ${statusOf(e.status)}: Google does not change an experiment that is over.` }
  const problem = dayProblem(request.startDate, 'startDate') ?? dayProblem(request.endDate, 'endDate')
  if (problem) return { refusal: `${problem}.` }
  if (request.name !== undefined) {
    const name = request.name.trim()
    if (!name) return { refusal: 'The experiment\'s name cannot be empty.' }
    const taken = live.experiments.find((x) => x.experimentId !== e.experimentId && sameName(x.name, name))
    if (taken) return { refusal: `An experiment named "${taken.name}" is already in the account (${taken.experimentId}): Google keeps experiment names unique.` }
  }
  const now = liveFieldsOf(e)
  const wanted: ExperimentFields = {
    ...(request.name !== undefined ? { name: request.name.trim() } : {}),
    ...(request.description !== undefined ? { description: request.description.trim() } : {}),
    ...(request.startDate !== undefined ? { startDate: request.startDate } : {}),
    ...(request.endDate !== undefined ? { endDate: request.endDate } : {}),
  }
  if (wanted.description === '') return { refusal: 'The description cannot be emptied through Nexus (Google needs 1 to 2,048 characters): give a new one.' }
  const start = wanted.startDate ?? now.startDate
  const end = wanted.endDate ?? now.endDate
  if (start && end && end < start) return { refusal: `The experiment would end (${end}) before it starts (${start}).` }
  const skipped: string[] = []
  const changed: ExperimentFields = {}
  for (const key of Object.keys(wanted) as Array<keyof ExperimentFields>) {
    if (wanted[key] === now[key]) skipped.push(`${key}: already "${wanted[key]}".`)
    else changed[key] = wanted[key]
  }
  const keys = Object.keys(changed) as Array<keyof ExperimentFields>
  if (!keys.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const running = e.status === 'ENABLED' || e.status === 'INITIATED'
  const spends: string[] = []
  if (running && changed.endDate && now.endDate && changed.endDate > now.endDate) {
    spends.push(`The treatment of "${e.name}" serves ${plural(daysBetween(now.endDate, changed.endDate), 'day')} longer (to ${changed.endDate}), on part of the campaign's budget.`)
  }
  if (running && changed.startDate && now.startDate && changed.startDate < now.startDate) {
    spends.push(`The treatment of "${e.name}" starts ${plural(daysBetween(changed.startDate, now.startDate), 'day')} earlier (${changed.startDate}), on part of the campaign's budget.`)
  }
  const warnings = running && (changed.startDate || changed.endDate) ? ['Google refuses a new start date once the old one has passed, and an end date in the past.'] : []
  return draft({
    summary: `Change the experiment "${e.name}": ${keys.join(', ')}.`,
    operations: [{ experimentOperation: { update: { resourceName, ...changed }, updateMask: keys.map((k) => FIELD_MASK[k]).join(',') } }],
    spendsMoney: spends,
    warnings,
    skipped,
    stands: { experimentId: e.experimentId, status: e.status, fields: now },
    before: { experimentId: e.experimentId, fields: Object.fromEntries(keys.map((k) => [k, now[k]])) } satisfies SetExperimentRecord,
    after: { experimentId: e.experimentId, fields: changed } satisfies SetExperimentRecord,
  }, keys.map((k) => [k, now[k], changed[k]]))
}

// ── schedule-google-experiment ───────────────────────────────────────────────────────────────────────────────────

/**
 * `scheduled: 'started'`: Google answered a schedule with its long-running operation — started, not done (the experiment
 * reads INITIATED, then ENABLED when Google has made the experiment campaign). Never recorded as done.
 */
export interface ScheduleRecord { experimentId: string; scheduled: false | 'started' }

export function scheduleExperimentDraft(customer: string, live: { experimentId: string; experiment: LiveExperimentState | null; campaigns: LiveExperimentCampaign[] }): GoogleChangeDraft | Refusal {
  const e = live.experiment
  if (!e) return { refusal: `Experiment ${live.experimentId} is not in the Google Ads account (google-ads-experiments lists them).` }
  if (!SYSTEM_MANAGED_TYPES.has(e.type ?? '')) return { refusal: `A ${typeName(e.type)} experiment is not scheduled: it serves from when it was made (end it with end-google-experiment).` }
  if (e.status !== 'SETUP') {
    return { refusal: e.status === 'INITIATED'
      ? `Google is scheduling "${e.name}" already (${e.operation ?? 'its operation'}): google-ads-experiments shows when it is done.`
      : `Experiment "${e.name}" is ${statusOf(e.status)}: only an experiment in SETUP is scheduled.` }
  }
  const { control, treatments } = armsOf(e)
  if (!control || !control.campaignIds.length) return { refusal: `Experiment "${e.name}" has no control arm with its campaign: make it again with create-google-experiment.` }
  if (!treatments.length) return { refusal: `Experiment "${e.name}" has no treatment arm.` }
  const empty = treatments.find((t) => !t.inDesignCampaignIds.length && !t.campaignIds.length)
  if (empty) return { refusal: `The treatment "${empty.name ?? empty.armId}" has no in-design campaign (Google: IN_DESIGN_CAMPAIGNS_NOT_SET).` }
  const byId = new Map(live.campaigns.map((c) => [c.campaignId, c]))
  const base = byId.get(control.campaignIds[0])
  if (!base || base.status === 'REMOVED') return { refusal: `The experiment's campaign ${control.campaignIds[0]} is not in the account any more.` }
  if (base.budget?.shared) return { refusal: `Campaign "${base.name}" is on a shared budget now: Google cannot schedule an experiment of it (CANNOT_CREATE_EXPERIMENT_CAMPAIGN_WITH_SHARED_BUDGET). Give it a budget of its own first (set-google-budget).` }
  if (base.budget?.period === 'CUSTOM_PERIOD') return { refusal: `Campaign "${base.name}" has a custom-period budget: Google cannot schedule an experiment of it.` }
  const enabled = base.status === 'ENABLED'
  const spends: string[] = []
  const warnings: string[] = []
  const lines: Array<[string, unknown, unknown]> = [['experiment', `${e.name} (${statusOf('SETUP')})`, 'scheduling started (Google makes the treatment campaign over a while)']]
  // What each SPENDS MONEY line is worded from (the in-design campaign's name and budget): stood on, so a change to it
  // after the preview stops the run.
  const designs: Array<{ armId: string; campaignId: string; name: string | null; budgetId: string | null; budgetName: string | null }> = []
  for (const t of treatments) {
    const designId = t.inDesignCampaignIds[0] ?? t.campaignIds[0]
    const design = byId.get(designId)
    designs.push({ armId: t.armId, campaignId: designId, name: design?.name ?? null, budgetId: design?.budget?.budgetId ?? null, budgetName: design?.budget?.name ?? null })
    const own = design?.budget?.budgetId && base.budget?.budgetId && design.budget.budgetId !== base.budget.budgetId
    const on = own ? `on its own budget "${design!.budget!.name ?? design!.budget!.budgetId}"` : `on "${base.name}"'s budget, shared by both arms (not raised)`
    spends.push(`From ${e.start ?? 'when Google has made it'}${e.end ? ` to ${e.end}` : ''} the treatment "${t.name ?? t.armId}" (campaign "${design?.name ?? designId}") serves ${t.trafficSplitPct ?? '?'} % of campaign "${base.name}"'s traffic with the treatment's settings, ${on}.${enabled ? '' : pausedNote(base.name, base.status)}`)
    lines.push([`treatment "${t.name ?? t.armId}"`, `in-design campaign ${designId}`, `${t.trafficSplitPct ?? '?'} % of the traffic`])
  }
  warnings.push(NOT_DONE_YET, 'Google refuses to schedule a treatment whose in-design campaign has no change from the campaign; that refusal can come after the answer (google-ads-experiments shows it).')
  if (e.syncEnabled) warnings.push('Sync is on: changes to the campaign while it runs are copied to the treatment.')
  return draft({
    summary: `Ask Google to schedule the experiment "${e.name}" on campaign "${base.name}": Google turns the treatment's in-design campaign into the experiment campaign over a while (not done when it answers).`,
    operations: [{ scheduleExperiment: { resourceName: `${customer}/experiments/${e.experimentId}` } }],
    spendsMoney: spends,
    warnings,
    stands: {
      experimentId: e.experimentId, status: e.status, start: e.start, end: e.end, arms: e.arms, designs,
      base: { campaignId: base.campaignId, name: base.name, status: base.status, budgetId: base.budget?.budgetId ?? null, budgetShared: base.budget?.shared ?? null, budgetPeriod: base.budget?.period ?? null },
    },
    before: { experimentId: e.experimentId, scheduled: false } satisfies ScheduleRecord,
    after: { experimentId: e.experimentId, scheduled: 'started' } satisfies ScheduleRecord,
  }, lines)
}

// ── end-google-experiment ────────────────────────────────────────────────────────────────────────────────────────

export function endExperimentDraft(customer: string, live: { experimentId: string; experiment: LiveExperimentState | null; campaigns: LiveExperimentCampaign[] }): GoogleChangeDraft | Refusal {
  const e = live.experiment
  if (!e) return { refusal: `Experiment ${live.experimentId} is not in the Google Ads account (google-ads-experiments lists them).` }
  if (e.status === 'SETUP') return { refusal: `Experiment "${e.name}" was never scheduled: nothing of it serves. Remove it with set-google-experiment (remove).` }
  if (ENDED.has(e.status ?? '')) return { refusal: `Experiment "${e.name}" is ${statusOf(e.status)} already.` }
  const { control } = armsOf(e)
  const base = live.campaigns.find((c) => c.campaignId === control?.campaignIds[0])
  const systemManaged = SYSTEM_MANAGED_TYPES.has(e.type ?? '')
  return draft({
    summary: `End the experiment "${e.name}" now${base ? ` (campaign "${base.name}")` : ''}.`,
    operations: [{ endExperiment: { resourceName: `${customer}/experiments/${e.experimentId}` } }],
    warnings: [
      systemManaged
        ? `The treatment campaign stops serving now (Google keeps it and its numbers); ${base ? `"${base.name}"` : 'the campaign'} serves all its traffic as it is.`
        : `${base ? `"${base.name}"` : 'The campaign'} serves all its traffic without the tested feature again.`,
      'An ended experiment cannot start again: a new test is a new experiment (create-google-experiment).',
    ],
    stands: { experimentId: e.experimentId, status: e.status },
    before: { experimentId: e.experimentId, status: e.status },
    after: { experimentId: e.experimentId, status: 'HALTED' },
  }, [['experiment', `${e.name} (${statusOf(e.status)})`, 'ended now']])
}

// ── the settings a promote applies (experiment and campaign draft) ──────────────────────────────────────────────

/**
 * The main settings of the base campaign (`from`) and the treatment / draft campaign (`to`), side by side; what can spend
 * more. Both sides word the SPENDS MONEY lines, so a promote stands on both.
 */
export function promotedSettings(base: Settings, treatment: Settings, currency: string): { lines: Array<[string, unknown, unknown]>; spends: string[]; from: Record<string, unknown>; to: Record<string, unknown> } {
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const pick = (s: Settings) => ({
    bidding: s.bidding, targetCpaCents: s.targetCpaCents, targetRoas: s.targetRoas, maxCpcCeilingCents: s.maxCpcCeilingCents,
    searchPartners: s.networks.searchPartners, display: s.networks.display, aiMax: s.aiMax, keywordMatchType: s.keywordMatchType,
  })
  const from = pick(base)
  const to = pick(treatment)
  const differs = (k: keyof typeof from) => JSON.stringify(from[k]) !== JSON.stringify(to[k])
  if (differs('bidding')) lines.push(['bidding', from.bidding, to.bidding])
  if (differs('targetCpaCents')) {
    lines.push(['target CPA', money(from.targetCpaCents, currency), money(to.targetCpaCents, currency)])
    if ((to.targetCpaCents ?? 0) > (from.targetCpaCents ?? Infinity)) spends.push(`Raises the target CPA from ${money(from.targetCpaCents, currency)} to ${money(to.targetCpaCents, currency)}.`)
  }
  if (differs('targetRoas')) {
    lines.push(['target ROAS', from.targetRoas, to.targetRoas])
    if (to.targetRoas !== null && from.targetRoas !== null && to.targetRoas < from.targetRoas) spends.push(`Lowers the target ROAS from ${from.targetRoas} to ${to.targetRoas}.`)
  }
  if (differs('maxCpcCeilingCents')) {
    lines.push(['max CPC ceiling', money(from.maxCpcCeilingCents, currency), money(to.maxCpcCeilingCents, currency)])
    if (to.maxCpcCeilingCents === null || (from.maxCpcCeilingCents !== null && to.maxCpcCeilingCents > from.maxCpcCeilingCents)) spends.push(`Raises (or lifts) the max CPC ceiling from ${money(from.maxCpcCeilingCents, currency)} to ${money(to.maxCpcCeilingCents, currency)}.`)
  }
  if (differs('searchPartners')) { lines.push(['search partners', from.searchPartners, to.searchPartners]); if (to.searchPartners) spends.push('Turns on the search partners.') }
  if (differs('display')) { lines.push(['display network', from.display, to.display]); if (to.display) spends.push('Turns on the display network.') }
  if (differs('aiMax')) { lines.push(['AI Max', from.aiMax, to.aiMax]); if (to.aiMax) spends.push('Turns on AI Max (wider matching, Google writes text).') }
  if (differs('keywordMatchType')) { lines.push(['keyword match type', from.keywordMatchType, to.keywordMatchType]); if (to.keywordMatchType === 'BROAD') spends.push('Turns the campaign\'s keywords to broad match.') }
  return { lines, spends, from, to }
}

// ── promote-google-experiment ────────────────────────────────────────────────────────────────────────────────────

export interface PromoteExperimentLive {
  experimentId: string
  experiment: LiveExperimentState | null
  base: Settings | null
  treatment: Settings | null
}

export function promoteExperimentDraft(customer: string, currency: string, live: PromoteExperimentLive): GoogleChangeDraft | Refusal {
  const e = live.experiment
  if (!e) return { refusal: `Experiment ${live.experimentId} is not in the Google Ads account (google-ads-experiments lists them).` }
  if (NOT_PROMOTABLE.has(e.type ?? '')) return { refusal: `Google cannot promote a ${typeName(e.type)} experiment (its guide): graduate it (graduate-google-experiment) or end it.` }
  // Promote only a running experiment, checked 2026-10-15: Google's v25 guides name End, Promote and Graduate as the three
  // ways to complete one (docs/experiments/overview "Complete (HALTED, PROMOTED, or GRADUATED)"; system-managed "End: If
  // you want to stop the experiment without applying changes"), PromoteExperimentRequest and the ExperimentError enum
  // (STATUS_TRANSITION_INVALID) say nothing of a promote after an end, and no page allows one — so an ended (HALTED)
  // experiment is not promoted here. Graduate after an end is not documented either; there Google's validate_only check
  // of the exact request decides before anything is queued.
  if (e.status !== 'ENABLED') return { refusal: `Experiment "${e.name}" is ${statusOf(e.status)}: Google promotes an experiment that is running (ENABLED); an ended one was stopped without applying its changes.` }
  if (e.promoteStatus === 'IN_PROGRESS') return { refusal: `Google is promoting "${e.name}" already: google-ads-experiments shows when it is done.` }
  const { control, treatments } = armsOf(e)
  if (treatments.length !== 1) return { refusal: `Experiment "${e.name}" has ${plural(treatments.length, 'treatment')}: a promote applies one treatment to the campaign. Graduate the one you want (graduate-google-experiment) instead.` }
  const base = live.base
  if (!control?.campaignIds.length || !base) return { refusal: `The experiment's campaign is not in the account any more: nothing to promote into.` }
  const intra = !SYSTEM_MANAGED_TYPES.has(e.type ?? '')
  const lines: Array<[string, unknown, unknown]> = [['experiment', `${e.name} (running)`, 'promote started: Google applies the treatment to the campaign over a while']]
  const spends: string[] = []
  let record: Record<string, unknown> = {}
  let treatment: { campaignId: string; settings: Record<string, unknown> } | null = null
  if (intra) {
    if (e.type === 'ADOPT_BROAD_MATCH_KEYWORDS') spends.push(`All of campaign "${base.name}"'s traffic uses broad match from then on: its ads can show on more searches.`)
    else spends.push(`The tested ${typeName(e.type)} feature serves all of campaign "${base.name}"'s traffic from then on.`)
  } else {
    if (!live.treatment) return { refusal: `The treatment's experiment campaign ${treatments[0].campaignIds[0] ?? ''} is not in the account: nothing to promote.` }
    const diff = promotedSettings(base, live.treatment, currency)
    lines.push(...diff.lines)
    spends.push(`Applies every change of the treatment to campaign "${base.name}" for ALL its traffic — settings, bids, keywords and ads (the lines show the main settings; Nexus cannot list every difference).`, ...diff.spends)
    record = diff.from
    treatment = { campaignId: live.treatment.campaignId, settings: diff.to }
  }
  const paused = base.status !== 'ENABLED'
  return draft({
    summary: `Ask Google to promote the experiment "${e.name}": Google applies the treatment to campaign "${base.name}" over a while (not done when it answers).`,
    operations: [{ promoteExperiment: { resourceName: `${customer}/experiments/${e.experimentId}` } }],
    spendsMoney: spends.map((s) => (paused ? `${s}${pausedNote(base.name, base.status)}` : s)),
    warnings: [NOT_DONE_YET, `Google cannot undo a promote: to go back, change "${base.name}" back by hand (the "from" side of the lines is what it has now).`, 'The treatment stops serving once the promote is done.'],
    stands: { experimentId: e.experimentId, status: e.status, promoteStatus: e.promoteStatus, arms: e.arms, base: { campaignId: base.campaignId, name: base.name, status: base.status, settings: record }, treatment },
    before: { experimentId: e.experimentId, campaignId: base.campaignId, settings: record },
    // Started, not done: Google's long-running promote ends when google-ads-experiments reads promote_status COMPLETED.
    after: { experimentId: e.experimentId, promoted: 'started' },
  }, lines)
}

// ── graduate-google-experiment ───────────────────────────────────────────────────────────────────────────────────

/**
 * GraduateExperimentRequest (v25 reference, 2026-10-15): campaign_budget_mappings "Each campaign that appears here will
 * graduate … The maximum size is one" — so ONE treatment campaign per request, with the budget it uses from then on
 * (CampaignBudgetMapping: experiment_campaign, campaign_budget).
 */
export interface GraduateRequest { experimentId: string; budgetId: string; campaignId?: string }
export interface GraduateRecord { experimentId: string; campaignId: string; budgetId: string | null }

export function graduateExperimentDraft(customer: string, currency: string, request: GraduateRequest, live: { experiment: LiveExperimentState | null; campaigns: LiveExperimentCampaign[]; budgets: LiveBudget[] }): GoogleChangeDraft | Refusal {
  const e = live.experiment
  if (!e) return { refusal: `Experiment ${request.experimentId} is not in the Google Ads account (google-ads-experiments lists them).` }
  if (NOT_GRADUATABLE.has(e.type ?? '')) return { refusal: `Google cannot graduate a ${typeName(e.type)} experiment: it has no treatment campaign of its own. Promote it (promote-google-experiment) or end it.` }
  if (e.status !== 'ENABLED' && e.status !== 'HALTED') return { refusal: `Experiment "${e.name}" is ${statusOf(e.status)}: Google graduates an experiment that runs or has ended.` }
  const { control, treatments } = armsOf(e)
  const treatmentIds = [...new Set(treatments.flatMap((t) => t.campaignIds))]
  if (!treatmentIds.length) return { refusal: `Experiment "${e.name}" has no experiment campaign to graduate (it was never scheduled).` }
  let campaignId = request.campaignId
  if (campaignId && !treatmentIds.includes(campaignId)) return { refusal: `Campaign ${campaignId} is not a treatment campaign of "${e.name}" (its treatment campaigns: ${treatmentIds.join(', ')}).` }
  if (!campaignId) {
    if (treatmentIds.length > 1) return { refusal: `Experiment "${e.name}" has ${treatmentIds.length} treatment campaigns (${treatmentIds.join(', ')}) and Google graduates one per request: name it with campaignId.` }
    campaignId = treatmentIds[0]
  }
  const byId = new Map(live.campaigns.map((x) => [x.campaignId, x]))
  const base = byId.get(control?.campaignIds[0] ?? '')
  const c = byId.get(campaignId)
  if (!c || c.status === 'REMOVED') return { refusal: `The treatment campaign ${campaignId} is not in the account any more.` }
  const budgetId = request.budgetId
  const budget = live.budgets.find((b) => b.budgetId === budgetId)
  if (!budget) return { refusal: `Budget ${budgetId} is not an enabled budget of the account (google-ads-live view budgets lists them; set-google-budget makes a shared one).` }
  if (base?.budget?.budgetId === budgetId || c.budget?.budgetId === budgetId) return { refusal: `Budget "${budget.name ?? budgetId}" is campaign "${base?.name ?? c.name}"'s own budget, which the treatment shares today: the graduated campaign needs another (set-google-budget makes a shared one).` }
  if (!budget.shared && budget.usedBy > 0) return { refusal: `Budget "${budget.name ?? budgetId}" is another campaign's own budget: a budget that is not shared serves one campaign. Pick a shared budget, or make one with set-google-budget.` }
  const others = budget.campaigns.filter((x) => x.campaignId !== campaignId)
  const enabled = c.status === 'ENABLED'
  return draft({
    summary: `Graduate the experiment "${e.name}": campaign "${c.name}" becomes a campaign of its own on budget "${budget.name ?? budgetId}".`,
    operations: [{ graduateExperiment: { resourceName: `${customer}/experiments/${e.experimentId}`, campaignBudgetMappings: [{ experimentCampaign: `${customer}/campaigns/${campaignId}`, campaignBudget: `${customer}/campaignBudgets/${budgetId}` }] } }],
    spendsMoney: [
      `Campaign "${c.name}" becomes a campaign of its own and serves outside the experiment (Google's guide: it "continues to serve"), beside "${base?.name ?? 'its campaign'}", on budget "${budget.name ?? budgetId}" (${money(budget.amountCents, currency)} a day${others.length ? `, shared with ${plural(others.length, 'other campaign')}` : ''}). To graduate it paused, pause it first with set-google-status.${enabled ? '' : pausedNote(c.name, c.status)}`,
    ],
    warnings: ['Google cannot undo a graduation: undo pauses the graduated campaign (it stays a campaign of its own).', `Campaign "${base?.name ?? 'the base campaign'}" is not changed.`],
    stands: {
      experimentId: e.experimentId, status: e.status, arms: e.arms,
      campaign: { campaignId, status: c.status, budgetId: c.budget?.budgetId ?? null },
      budget: { budgetId, amountCents: budget.amountCents, shared: budget.shared, usedBy: budget.usedBy },
    },
    before: { experimentId: e.experimentId, campaignId, budgetId: c.budget?.budgetId ?? null } satisfies GraduateRecord,
    after: { experimentId: e.experimentId, campaignId, budgetId } satisfies GraduateRecord,
  }, [[`campaign "${c.name}"`, `treatment of "${e.name}"${c.budget ? ` on "${c.budget.name ?? c.budget.budgetId}"` : ''}`, `a campaign of its own on "${budget.name ?? budgetId}" (${money(budget.amountCents, currency)} a day)`]])
}

// ── set-google-campaign-draft (create, rename, remove) ─────────────────────────────────────────────────────────

export interface CampaignDraftRequest { create?: { campaignId: string; name: string }; draftId?: string; name?: string; remove?: boolean }
export type CampaignDraftRecord =
  | { action: 'create'; draftId: string | null; campaignId?: string; name?: string; status?: string | null }
  | { action: 'rename'; draftId: string; name: string | null }
  | { action: 'remove'; draftId: string; removed: boolean }

/** CampaignDraft.name (v25 reference): "must not contain any null (code point 0x0), NL line feed (0xA) or carriage return (0xD)". */
const BAD_DRAFT_NAME = /[\u0000\n\r]/
const DRAFT_NAME_RULE = 'A campaign draft\'s name is one line: Google refuses a line break or a null character in it.'

const DRAFT_WORKS = 'A draft never serves: Google makes a draft campaign (a copy of the campaign) to change, and promote-google-campaign-draft applies its changes to the campaign.'

export function campaignDraftChange(customer: string, request: CampaignDraftRequest, live: { drafts: LiveCampaignDraft[]; campaign: LiveExperimentCampaign | null }): GoogleChangeDraft | Refusal {
  const asked = [request.create ? 'create' : null, request.draftId && request.name !== undefined ? 'rename' : null, request.draftId && request.remove ? 'remove' : null].filter(Boolean)
  if (asked.length !== 1 || (request.create && request.draftId)) return { refusal: 'Ask for one thing: create (campaignId and name), or draftId with name (rename) or with remove.' }
  if (request.create) {
    const c = live.campaign
    if (!c || c.status === 'REMOVED') return { refusal: `Campaign ${request.create.campaignId} is not in the Google Ads account (google-ads-live view campaigns lists them).` }
    if (c.experimentType && c.experimentType !== 'BASE') return { refusal: `Campaign "${c.name}" is itself a draft or experiment campaign: a draft starts from a campaign of its own.` }
    const name = request.create.name.trim()
    if (!name) return { refusal: 'The draft needs a name.' }
    if (BAD_DRAFT_NAME.test(name)) return { refusal: DRAFT_NAME_RULE }
    const taken = live.drafts.find((d) => d.baseCampaignId === c.campaignId && d.name && sameName(d.name, name))
    if (taken) return { refusal: `Campaign "${c.name}" has a draft named "${taken.name}" already (${taken.draftId}).` }
    return draft({
      summary: `Make the campaign draft "${name}" of campaign "${c.name}".`,
      operations: [{ campaignDraftOperation: { create: { baseCampaign: `${customer}/campaigns/${c.campaignId}`, name } } }],
      warnings: [
        DRAFT_WORKS,
        'Change the draft campaign in Google Ads (Drafts) for now: Nexus\'s set-google-… tools read campaigns without Google\'s drafts, so they do not find a draft campaign. Its id: google-ads-experiments, after this ran.',
      ],
      stands: { campaign: { campaignId: c.campaignId, status: c.status, experimentType: c.experimentType }, nameFree: true },
      before: { action: 'create', draftId: null } satisfies CampaignDraftRecord,
      after: { action: 'create', draftId: 'new', campaignId: c.campaignId, name, status: 'PROPOSED' } satisfies CampaignDraftRecord,
    }, [['campaign draft', null, `${name} (of "${c.name}")`]])
  }
  const d = live.drafts.find((x) => x.draftId === request.draftId)
  if (!d) return { refusal: `Campaign draft ${request.draftId} is not in the Google Ads account (google-ads-experiments lists drafts as campaignId~draftId).` }
  const resourceName = `${customer}/campaignDrafts/${d.draftId}`
  if (request.remove) {
    if (d.status !== 'PROPOSED' && d.status !== 'PROMOTE_FAILED') return { refusal: `Campaign draft "${d.name ?? d.draftId}" is ${d.status ?? 'of unknown status'}: only a draft that is not being or was not promoted is removed.` }
    return draft({
      summary: `Remove the campaign draft "${d.name ?? d.draftId}".`,
      operations: [{ campaignDraftOperation: { remove: resourceName } }],
      warnings: ['Its draft campaign and the changes made in it go with it; the campaign is not changed. A removed draft cannot be brought back.'],
      stands: { draftId: d.draftId, status: d.status },
      before: { action: 'remove', draftId: d.draftId, removed: false } satisfies CampaignDraftRecord,
      after: { action: 'remove', draftId: d.draftId, removed: true } satisfies CampaignDraftRecord,
    }, [['campaign draft', d.name, 'removed']])
  }
  const name = (request.name ?? '').trim()
  if (!name) return { refusal: 'The draft\'s new name cannot be empty.' }
  if (BAD_DRAFT_NAME.test(name)) return { refusal: DRAFT_NAME_RULE }
  if (d.status !== 'PROPOSED') return { refusal: `Campaign draft "${d.name ?? d.draftId}" is ${d.status ?? 'of unknown status'}: only a draft not yet promoted is renamed.` }
  if (d.name === name) return { refusal: `Campaign draft ${d.draftId} is named "${name}" already.` }
  const taken = live.drafts.find((x) => x.draftId !== d.draftId && x.baseCampaignId === d.baseCampaignId && x.name && sameName(x.name, name))
  if (taken) return { refusal: `The campaign has a draft named "${taken.name}" already (${taken.draftId}).` }
  return draft({
    summary: `Rename the campaign draft "${d.name ?? d.draftId}" to "${name}".`,
    operations: [{ campaignDraftOperation: { update: { resourceName, name }, updateMask: 'name' } }],
    stands: { draftId: d.draftId, status: d.status, name: d.name },
    before: { action: 'rename', draftId: d.draftId, name: d.name } satisfies CampaignDraftRecord,
    after: { action: 'rename', draftId: d.draftId, name } satisfies CampaignDraftRecord,
  }, [['name', d.name, name]])
}

// ── promote-google-campaign-draft ───────────────────────────────────────────────────────────────────────────────

export function promoteCampaignDraftDraft(customer: string, currency: string, live: { draftId: string; draft: LiveCampaignDraft | null; base: Settings | null; draftCampaign: Settings | null }): GoogleChangeDraft | Refusal {
  const d = live.draft
  if (!d) return { refusal: `Campaign draft ${live.draftId} is not in the Google Ads account (google-ads-experiments lists drafts as campaignId~draftId).` }
  if (d.status === 'PROMOTING') return { refusal: `Google is promoting "${d.name ?? d.draftId}" already: google-ads-experiments shows when it is done.` }
  if (d.status === 'PROMOTED') return { refusal: `Campaign draft "${d.name ?? d.draftId}" is promoted already.` }
  if (d.status === 'PROMOTE_FAILED') return { refusal: `Google's promote of "${d.name ?? d.draftId}" failed after it was partly applied, and Google says it cannot be promoted again safely (PROMOTE_FAILED): put campaign ${d.baseCampaignId} right by hand.` }
  if (d.status !== 'PROPOSED') return { refusal: `Campaign draft "${d.name ?? d.draftId}" is ${d.status ?? 'of unknown status'}: only a draft in PROPOSED is promoted.` }
  const base = live.base
  if (!base) return { refusal: `The draft's campaign ${d.baseCampaignId} is not in the account any more.` }
  if (!live.draftCampaign) return { refusal: `The draft campaign ${d.draftCampaignId ?? ''} is not in the account: nothing to promote.` }
  const diff = promotedSettings(base, live.draftCampaign, currency)
  const spends = [`Applies every change of the draft to campaign "${base.name}" — settings, bids, keywords and ads (the lines show the main settings; Nexus cannot list every difference).`, ...diff.spends]
  const paused = base.status !== 'ENABLED'
  return draft({
    summary: `Ask Google to promote the campaign draft "${d.name ?? d.draftId}": Google applies its changes to campaign "${base.name}" over a while (not done when it answers).`,
    operations: [{ promoteCampaignDraft: { resourceName: `${customer}/campaignDrafts/${d.draftId}` } }],
    spendsMoney: spends.map((s) => (paused ? `${s}${pausedNote(base.name, base.status)}` : s)),
    warnings: [
      NOT_DONE_YET,
      'Google cannot undo a promote. If it fails part-way, Google marks the draft PROMOTE_FAILED and says it cannot be promoted again safely: the campaign is then put right by hand.',
      ...(d.experimentRunning ? ['An experiment runs on this draft (an older Google Ads trial).'] : []),
    ],
    stands: {
      draftId: d.draftId, status: d.status, base: { campaignId: base.campaignId, name: base.name, status: base.status, settings: diff.from },
      draftCampaign: { campaignId: live.draftCampaign.campaignId, settings: diff.to },
    },
    before: { draftId: d.draftId, campaignId: base.campaignId, settings: diff.from },
    // Started, not done: Google's long-running promote ends when the draft reads PROMOTED (or PROMOTE_FAILED).
    after: { draftId: d.draftId, promoted: 'started' },
  }, [['campaign draft', `${d.name ?? d.draftId} (PROPOSED)`, 'promote started: Google applies it to the campaign over a while'], ...diff.lines])
}
