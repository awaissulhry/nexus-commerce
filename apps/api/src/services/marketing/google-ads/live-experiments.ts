/**
 * Google Ads changes, G9 (2026-10-15) — what an experiment, its arms, their campaigns and the account's campaign drafts
 * are NOW, read live from Google: the "from" side of the experiment and draft tools and their read. One GAQL query per
 * part (write-client.ts `liveRows`); a change stands on a read that answered in full (a refused query fails the change).
 *
 * Checked 2026-10-15 against Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/experiment,
 * …/experiment_arm, …/campaign_draft, …/campaign; fetched with curl and parsed): every field below is Selectable on its
 * resource (campaign_budget.* through campaign's attributed resource campaign_budget); every WHERE field is Filterable
 * and is on the FROM resource itself (no segmenting resource is filtered). Not filterable, so only selected:
 * experiment.long_running_operation, campaign_draft.long_running_operation. Enums (v25 protos): experiment.status
 * ENABLED | REMOVED | HALTED | PROMOTED | SETUP | INITIATED | GRADUATED; experiment.promote_status (AsyncActionStatus)
 * NOT_STARTED | IN_PROGRESS | COMPLETED | FAILED | COMPLETED_WITH_WARNING; campaign_draft.status PROPOSED | REMOVED |
 * PROMOTING | PROMOTED | PROMOTE_FAILED; campaign.experiment_type BASE | DRAFT | EXPERIMENT.
 *
 * In-design campaigns (the treatment of an experiment not yet scheduled) and the campaigns of campaign drafts are
 * drafts: Google returns them only with `PARAMETERS include_drafts=true` (Google's guide "System-managed experiments",
 * step 3, 2026-10-15), so every campaign read here says it.
 */
import { liveRows } from './write-client.js'
import { centsOfMicros, gaqlId, idOf, liveCampaignSettingsOf, liveCampaignSettingsQuery, type LiveCampaignDetail } from './live.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>

export const WITH_DRAFTS = ' PARAMETERS include_drafts=true'

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

// ── experiments ──────────────────────────────────────────────────────────────────────────────────────────────────

const EXPERIMENT_FIELDS = [
  'experiment.resource_name', 'experiment.experiment_id', 'experiment.name', 'experiment.description', 'experiment.type',
  'experiment.status', 'experiment.start_date', 'experiment.end_date', 'experiment.suffix', 'experiment.sync_enabled',
  'experiment.promote_status', 'experiment.long_running_operation',
]

export const experimentQuery = (experimentId: string): string =>
  `SELECT ${EXPERIMENT_FIELDS.join(', ')} FROM experiment WHERE experiment.experiment_id = ${gaqlId(experimentId, 'The experiment')}`

/** Every experiment that is not removed (names are unique among them). */
export const EXPERIMENTS_LIST_QUERY = `SELECT ${EXPERIMENT_FIELDS.join(', ')} FROM experiment WHERE experiment.status != 'REMOVED'`

const ARM_FIELDS = 'experiment_arm.resource_name, experiment_arm.experiment, experiment_arm.name, experiment_arm.control, experiment_arm.traffic_split, experiment_arm.campaigns, experiment_arm.in_design_campaigns'

export const experimentArmsQuery = (experimentResource: string): string => {
  if (!/^customers\/\d{1,20}\/experiments\/\d{1,20}$/.test(experimentResource)) throw new Error(`"${experimentResource}" is not an experiment's resource name. Nothing was sent.`)
  return `SELECT ${ARM_FIELDS} FROM experiment_arm WHERE experiment_arm.experiment = '${experimentResource}'${WITH_DRAFTS}`
}

export const ALL_ARMS_QUERY = `SELECT ${ARM_FIELDS} FROM experiment_arm${WITH_DRAFTS}`

export interface LiveExperimentArm {
  armId: string
  name: string | null
  control: boolean
  trafficSplitPct: number | null
  /** The arm's campaigns: the base campaign (control), the experiment campaign of a scheduled treatment, or the base campaign of an intra-campaign experiment. */
  campaignIds: string[]
  /** A treatment's in-design campaign (a draft, before the experiment is scheduled). */
  inDesignCampaignIds: string[]
}

export interface LiveExperimentState {
  experimentId: string
  resourceName: string
  name: string
  description: string | null
  type: string | null
  status: string | null
  start: string | null
  end: string | null
  suffix: string | null
  syncEnabled: boolean
  promoteStatus: string | null
  /** The most recent long-running operation of a schedule or promote (its name), when Google has one. */
  operation: string | null
  arms: LiveExperimentArm[]
}

function experimentOf(row: Json): LiveExperimentState {
  const e = row.experiment ?? {}
  return {
    experimentId: str(e.experimentId) ?? idOf(e.resourceName) ?? '',
    resourceName: str(e.resourceName) ?? '',
    name: str(e.name) ?? '',
    description: str(e.description),
    type: str(e.type),
    status: str(e.status),
    start: str(e.startDate),
    end: str(e.endDate),
    suffix: str(e.suffix),
    syncEnabled: e.syncEnabled === true,
    promoteStatus: str(e.promoteStatus),
    operation: str(e.longRunningOperation),
    arms: [],
  }
}

function armOf(row: Json): { experiment: string | null; arm: LiveExperimentArm } {
  const a = row.experimentArm ?? {}
  return {
    experiment: str(a.experiment),
    arm: {
      armId: idOf(a.resourceName) ?? '',
      name: str(a.name),
      control: a.control === true,
      trafficSplitPct: num(a.trafficSplit),
      campaignIds: list(a.campaigns).map((c) => idOf(c) ?? c),
      inDesignCampaignIds: list(a.inDesignCampaigns).map((c) => idOf(c) ?? c),
    },
  }
}

/** One experiment with its arms (two queries), or null when Google has none of that id (or it is removed). */
export async function liveExperiment(target: GoogleAdsTarget, experimentId: string): Promise<LiveExperimentState | null> {
  const rows = await liveRows<Json>(target, experimentQuery(experimentId), 'ads.search.live.experiment')
  if (!rows[0]) return null
  const experiment = experimentOf(rows[0])
  if (experiment.status === 'REMOVED') return null
  const arms = await liveRows<Json>(target, experimentArmsQuery(experiment.resourceName), 'ads.search.live.experiment-arms')
  experiment.arms = arms.map(armOf).map((a) => a.arm)
  return experiment
}

/** Every experiment that is not removed, with its arms (two queries; the arms only when there is an experiment). */
export async function liveExperimentList(target: GoogleAdsTarget): Promise<LiveExperimentState[]> {
  const experiments = (await liveRows<Json>(target, EXPERIMENTS_LIST_QUERY, 'ads.search.live.experiments')).map(experimentOf)
  if (!experiments.length) return experiments
  const arms = (await liveRows<Json>(target, ALL_ARMS_QUERY, 'ads.search.live.experiment-arms')).map(armOf)
  for (const e of experiments) e.arms = arms.filter((a) => a.experiment === e.resourceName).map((a) => a.arm)
  return experiments
}

// ── campaigns, drafts included ─────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_FIELDS = [
  'campaign.id', 'campaign.name', 'campaign.status', 'campaign.advertising_channel_type', 'campaign.bidding_strategy_type',
  'campaign.experiment_type', 'campaign.base_campaign', 'campaign.start_date_time', 'campaign.end_date_time',
  'campaign_budget.id', 'campaign_budget.name', 'campaign_budget.amount_micros', 'campaign_budget.explicitly_shared',
  'campaign_budget.period', 'campaign_budget.status',
]

export const campaignsByIdQuery = (campaignIds: string[]): string =>
  `SELECT ${CAMPAIGN_FIELDS.join(', ')} FROM campaign WHERE campaign.id IN (${campaignIds.map((id) => gaqlId(id, 'The campaign')).join(', ')})${WITH_DRAFTS}`

/** Every campaign's id and name, drafts and in-design campaigns included (a new in-design campaign's name must be free). */
export const CAMPAIGN_NAMES_QUERY = `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'${WITH_DRAFTS}`

export interface LiveExperimentCampaign {
  campaignId: string
  name: string
  status: string | null
  type: string | null
  bidding: string | null
  /** BASE (a campaign), DRAFT (an in-design or draft campaign: it never serves), EXPERIMENT (an experiment's treatment that serves). */
  experimentType: string | null
  baseCampaignId: string | null
  start: string | null
  end: string | null
  budget: { budgetId: string | null; name: string | null; amountCents: number | null; shared: boolean; period: string | null; status: string | null } | null
}

function experimentCampaignOf(row: Json): LiveExperimentCampaign {
  const c = row.campaign ?? {}
  const b = row.campaignBudget
  return {
    campaignId: str(c.id) ?? '',
    name: str(c.name) ?? '',
    status: str(c.status),
    type: str(c.advertisingChannelType),
    bidding: str(c.biddingStrategyType),
    experimentType: str(c.experimentType),
    baseCampaignId: idOf(c.baseCampaign),
    start: str(c.startDateTime),
    end: str(c.endDateTime),
    budget: b ? { budgetId: str(b.id), name: str(b.name), amountCents: centsOfMicros(b.amountMicros), shared: b.explicitlyShared === true, period: str(b.period), status: str(b.status) } : null,
  }
}

/** These campaigns as they are now, drafts and in-design campaigns included (one query; none asked: none read). */
export async function liveExperimentCampaigns(target: GoogleAdsTarget, campaignIds: string[]): Promise<LiveExperimentCampaign[]> {
  const ids = [...new Set(campaignIds)]
  if (!ids.length) return []
  return (await liveRows<Json>(target, campaignsByIdQuery(ids), 'ads.search.live.experiment-campaigns')).map(experimentCampaignOf)
}

/** Every campaign name in the account (drafts included), for a new in-design campaign's name. */
export async function liveCampaignNames(target: GoogleAdsTarget): Promise<Array<{ campaignId: string; name: string }>> {
  return (await liveRows<Json>(target, CAMPAIGN_NAMES_QUERY, 'ads.search.live.campaign-names')).map((r) => ({ campaignId: str(r.campaign?.id) ?? '', name: str(r.campaign?.name) ?? '' }))
}

/** One campaign's settings (live.ts's settings query), drafts and in-design campaigns included; null when Google has none. */
export async function liveSettingsWithDrafts(target: GoogleAdsTarget, campaignId: string): Promise<LiveCampaignDetail['campaign'] | null> {
  const rows = await liveRows<Json>(target, `${liveCampaignSettingsQuery(campaignId)}${WITH_DRAFTS}`, 'ads.search.live.campaign')
  return rows[0] ? liveCampaignSettingsOf(rows[0]) : null
}

// ── campaign drafts ──────────────────────────────────────────────────────────────────────────────────────────────

export const CAMPAIGN_DRAFTS_QUERY =
  'SELECT campaign_draft.resource_name, campaign_draft.draft_id, campaign_draft.name, campaign_draft.status, ' +
  'campaign_draft.base_campaign, campaign_draft.draft_campaign, campaign_draft.has_experiment_running, ' +
  "campaign_draft.long_running_operation FROM campaign_draft WHERE campaign_draft.status != 'REMOVED'"

export interface LiveCampaignDraft {
  /** `{baseCampaignId}~{draftId}`, as the tools take it (its resource name's last part). */
  draftId: string
  resourceName: string
  name: string | null
  status: string | null
  baseCampaignId: string | null
  draftCampaignId: string | null
  experimentRunning: boolean
  operation: string | null
}

export async function liveCampaignDrafts(target: GoogleAdsTarget): Promise<LiveCampaignDraft[]> {
  return (await liveRows<Json>(target, CAMPAIGN_DRAFTS_QUERY, 'ads.search.live.campaign-drafts')).map((row) => {
    const d = row.campaignDraft ?? {}
    return {
      draftId: idOf(d.resourceName) ?? '',
      resourceName: str(d.resourceName) ?? '',
      name: str(d.name),
      status: str(d.status),
      baseCampaignId: idOf(d.baseCampaign),
      draftCampaignId: idOf(d.draftCampaign),
      experimentRunning: d.hasExperimentRunning === true,
      operation: str(d.longRunningOperation),
    }
  })
}
