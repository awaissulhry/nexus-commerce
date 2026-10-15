/**
 * Google Ads changes, PR 2 (2026-10-15) — campaigns, targeting, status and removal. Every tool here is a Nexus change: a
 * preview Google has checked (validate_only), an approvalId, a person approves it in Nexus, it runs as that person
 * (google-ads-kit.ts). Never by rule.
 *
 *   create-google-campaign   a Standard Shopping or Search campaign, ALWAYS paused, with its budget and targeting
 *   set-google-campaign      name, Shopping priority, bidding, dates, networks, location option, Google's automation
 *                            switches (AI Max, campaign broad match, text customization, final URL expansion), own budget
 *   set-google-targeting     locations (with bid adjustments), radius, languages, ad schedule, devices (campaign and
 *                            ad group), audiences (observation only; every kind and mode: set-google-audiences)
 *   set-google-status        pause (safe) or enable (SPENDS MONEY) campaigns, ad groups, keywords, ads
 *   remove-google-ads-items  delete — only when the person asked for that removal; never undone
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import {
  campaignCreateDraft, campaignCreateRecordAfterRun, campaignSettingsDraft, campaignSettingsNow, DAYS,
  type CampaignCreateRecord, type CampaignCreateRequest, type CampaignSettingsRecord, type CampaignSettingsRequest,
} from '../../marketing/google-ads/change-campaigns.js'
import { scheduleNow, targetingDraft, targetingRecordAfterRun, type TargetingLive, type TargetingRecord, type TargetingRequest } from '../../marketing/google-ads/change-targeting.js'
import { removeDraft, statusDraft, type EnableFacts, type RemoveRequest, type StatusRecord, type StatusRequest } from '../../marketing/google-ads/change-status.js'
import { liveBudgets, liveCampaigns, liveCampaignSettings, liveNegativeLists, liveProductGroups } from '../../marketing/google-ads/live.js'
import { liveCampaignCriteria, liveStatuses } from '../../marketing/google-ads/live-campaigns.js'
import { DEVICES, liveAdGroupDevices, liveAdGroupTargetingState, liveSegmentNames, liveTargetingAdGroups, liveTargetingCriteria, type TargetingCriterion } from '../../marketing/google-ads/live-targeting.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of the campaign tools' previews and answers (their sentences and tables quote budgets and bids). */
const CAMPAIGN_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, dailyBudgetCents: ADSPEND, maxCpcCents: ADSPEND, targetCpaCents: ADSPEND, targetRoas: ADSPEND } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

// ── shared arguments ────────────────────────────────────────────────────────────────────────────────────────────

const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`${what} (YYYY-MM-DD, the account's time zone)`)
const biddingArg = z.object({
  strategy: z.enum(['MANUAL_CPC', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'PORTFOLIO'])
    .describe('MANUAL_CPC (you set every bid), MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, or PORTFOLIO (a portfolio bid strategy of the account)'),
  maxCpcCents: googleCentsArg('MAXIMIZE_CLICKS: the max CPC ceiling').optional(),
  targetCpaCents: googleCentsArg('MAXIMIZE_CONVERSIONS: the target cost per conversion').optional(),
  targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('MAXIMIZE_CONVERSION_VALUE: the target ROAS as a ratio (3 = 300 %)'),
  portfolioId: googleIdArg('PORTFOLIO: the portfolio bid strategy').optional(),
}).describe('how bids are set')
const scheduleArg = z.array(z.object({
  days: z.array(z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum([...DAYS, 'ALL']))).min(1).max(7).describe('MONDAY … SUNDAY, or ALL'),
  from: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('start, HH:MM (minutes 00, 15, 30 or 45)'),
  to: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('end, HH:MM (24:00 = midnight)'),
  bidModifier: z.coerce.number().min(0.1).max(10).optional().describe('the slot\'s bid adjustment as a factor (1.2 = +20 %, 0.5 = −50 %); none = no adjustment'),
})).max(42)
const locationArg = z.object({
  id: googleIdArg('the location (a geo target id; google-ads-live view lookup lookup locations finds it)'),
  exclude: z.boolean().optional().describe('true = excluded location'),
  bidModifier: z.coerce.number().min(0.1).max(10).optional().describe('a targeted location\'s bid adjustment as a factor (1.2 = +20 %)'),
})
const languageIdsArg = z.array(googleIdArg('a language (google-ads-live view lookup lookup languages finds it)')).max(50)
const audienceIdsArg = z.array(googleIdArg('an audience segment (in-market or affinity; google-ads-live view lookup lookup audiences finds it)')).max(50)

// ── create-google-campaign ──────────────────────────────────────────────────────────────────────────────────────

const createRequest = (a: Record<string, unknown>): CampaignCreateRequest => ({
  type: a.type as 'SHOPPING' | 'SEARCH',
  name: String(a.name ?? ''),
  budgetId: a.budgetId as string | undefined,
  dailyBudgetCents: a.dailyBudgetCents as number | undefined,
  bidding: (a.bidding as CampaignCreateRequest['bidding']) ?? { strategy: 'MANUAL_CPC' },
  startDate: a.startDate as string | undefined,
  endDate: a.endDate as string | undefined,
  searchPartners: a.searchPartners as boolean | undefined,
  display: a.display as boolean | undefined,
  shopping: a.shopping as CampaignCreateRequest['shopping'],
  search: a.search as CampaignCreateRequest['search'],
  locations: a.locations as CampaignCreateRequest['locations'],
  locationOption: a.locationOption as CampaignCreateRequest['locationOption'],
  languages: a.languages as string[] | undefined,
  schedule: a.schedule as CampaignCreateRequest['schedule'],
  audiences: a.audiences as string[] | undefined,
  euPoliticalAds: a.euPoliticalAds as boolean | undefined,
})

const buildCreate = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const campaigns = await liveCampaigns(account.target)
  const budgets = await liveBudgets(account.target, campaigns)
  return campaignCreateDraft(customerResource(account.target), account.currency, createRequest(args), { campaigns, budgets })
}

const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CampaignCreateRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const c = (await liveCampaigns(account.target)).find((x) => x.campaignId === after.campaignId)
    return c ? { ...after, name: c.name } : null
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as CampaignCreateRecord & { accountId?: string }
    if (!after.campaignId) return { refusal: 'This change does not record the campaign it made.' }
    return {
      tool: 'remove-google-ads-items',
      args: {
        ...(after.accountId ? { accountId: after.accountId } : {}),
        // The campaign, and the budget of its own the create made (Nexus removes campaigns before budgets).
        items: [{ kind: 'campaign', id: after.campaignId }, ...(after.ownBudgetId ? [{ kind: 'budget', id: after.ownBudgetId }] : [])],
        confirmRemove: true,
        why: 'undo of an earlier campaign create',
      },
    }
  },
}

const createGoogleCampaign: AgentTool = {
  ...common,
  name: 'create-google-campaign',
  title: 'Make a Google Ads campaign (paused)',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: CAMPAIGN_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    type: z.enum(['SHOPPING', 'SEARCH']).describe('SHOPPING (Standard Shopping) or SEARCH'),
    name: z.string().trim().min(1).max(255).describe('the campaign name (unique in the account)'),
    budgetId: googleIdArg('an existing SHARED budget (set-google-budget makes one)').optional(),
    dailyBudgetCents: googleCentsArg('a new daily budget of its own').optional(),
    bidding: biddingArg.optional(),
    startDate: dayArg('first day').optional(),
    endDate: dayArg('last day').optional(),
    searchPartners: z.boolean().optional().describe('Google search partners too (default off)'),
    display: z.boolean().optional().describe('SEARCH only: the Display Network too (default off)'),
    shopping: z.object({
      merchantId: googleIdArg('the Merchant Center account'),
      feedLabel: z.string().trim().min(1).max(20).optional().describe('the feed label of the products (e.g. a country code)'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Shopping priority (default LOW)'),
      localInventory: z.boolean().optional().describe('local products too (default off)'),
    }).optional().describe('SHOPPING: the Merchant Center feed and priority'),
    search: z.object({
      aiMax: z.boolean().optional().describe('AI Max (default off)'),
      textCustomization: z.boolean().optional().describe('text customization / automatically created text (default off; an AI Max feature)'),
      finalUrlExpansion: z.boolean().optional().describe('final URL expansion (default off; turns text customization on)'),
    }).optional().describe('SEARCH: what Google may do on its own (all off by default). Campaign-level broad match cannot be set in Google Ads API v25.'),
    locations: z.array(locationArg).max(100).optional().describe('targeted and excluded locations'),
    locationOption: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('PRESENCE (default: people in or regularly in the locations) or PRESENCE_OR_INTEREST'),
    languages: languageIdsArg.optional().describe('SEARCH: languages (none = all)'),
    schedule: scheduleArg.optional().describe('ad schedule slots (none = all day, every day)'),
    audiences: audienceIdsArg.optional().describe('audience segments in OBSERVATION (they never narrow who sees the ads)'),
    euPoliticalAds: z.boolean().optional().describe('true only if the campaign holds EU political advertising (default false: it does not)'),
    why: googleWhyArg,
  }),
  description:
    'Make a Google Ads campaign in the business\'s chosen account: Standard Shopping (Merchant Center id, feed label, '
    + 'priority) or Search (networks, languages, and what Google may do on its own: AI Max, text customization, final URL '
    + 'expansion — all OFF unless asked), with its budget (a shared budgetId or its own '
    + 'dailyBudgetCents), bidding (Manual CPC by default, or a named strategy), dates, locations with the location option '
    + '(presence only by default), ad schedule and audiences in observation — in one request. It is ALWAYS made PAUSED: '
    + 'enabling it is set-google-status, the person\'s decision (SPENDS MONEY). Ad groups, keywords, product groups and '
    + 'ads come with their own tools. Undo removes the campaign.' + GOOGLE_CHANGE_RULES,
  undo: createUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildCreate(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildCreate(args), (draft, responses) => {
    const after = campaignCreateRecordAfterRun(draft.after as CampaignCreateRecord, responses)
    return { data: { campaignId: after.campaignId, status: 'PAUSED', ...('ownBudgetId' in after ? { budgetId: after.ownBudgetId } : {}) }, before: { campaignId: null }, after }
  }),
}

// ── set-google-campaign ─────────────────────────────────────────────────────────────────────────────────────────

const SETTINGS_KEYS = ['name', 'priority', 'bidding', 'startDate', 'endDate', 'searchPartners', 'display', 'aiMax', 'textCustomization', 'finalUrlExpansion', 'locationOption', 'dailyBudgetCents'] as const
const settingsRequest = (a: Record<string, unknown>): CampaignSettingsRequest =>
  Object.fromEntries(SETTINGS_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) as CampaignSettingsRequest

async function campaignLive(account: Parameters<GoogleDraftBuilder>[0], campaignId: string) {
  const campaign = await liveCampaignSettings(account.target, campaignId)
  const campaigns = await liveCampaigns(account.target)
  const budget = campaign?.budget?.budgetId ? (await liveBudgets(account.target, campaigns)).find((b) => b.budgetId === campaign.budget!.budgetId) ?? null : null
  return { campaign, campaigns, budget }
}

const buildSettings = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const live = await campaignLive(account, String(args.campaignId))
  return campaignSettingsDraft(customerResource(account.target), account.currency, String(args.campaignId), settingsRequest(args), live)
}

const settingsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CampaignSettingsRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const live = await campaignLive(account, after.campaignId)
    if (!live.campaign) return null
    const now = campaignSettingsNow(live.campaign, live.budget)
    const settings = Object.fromEntries(Object.keys(after.settings ?? {}).map((k) => [k, now[k as keyof CampaignSettingsRequest]]))
    return { ...after, settings }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as CampaignSettingsRecord & { accountId?: string }
    if (!before.campaignId || !before.settings || !Object.keys(before.settings).length) return { refusal: 'This change does not record the settings it replaced.' }
    return { tool: 'set-google-campaign', args: { ...(before.accountId ? { accountId: before.accountId } : {}), campaignId: before.campaignId, ...before.settings, why: 'undo of an earlier campaign settings change' } }
  },
}

const setGoogleCampaign: AgentTool = {
  ...common,
  name: 'set-google-campaign',
  title: 'Change a Google Ads campaign\'s settings',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: CAMPAIGN_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign'),
    name: z.string().trim().min(1).max(255).optional().describe('a new name (unique in the account)'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('SHOPPING: the Shopping priority'),
    bidding: biddingArg.optional(),
    startDate: dayArg('first day').optional(),
    endDate: z.string().trim().regex(/^(\d{4}-\d{2}-\d{2}|none)$/).optional().describe('last day (YYYY-MM-DD), or none (runs on)'),
    searchPartners: z.boolean().optional().describe('Google search partners on or off'),
    display: z.boolean().optional().describe('SEARCH: the Display Network on or off'),
    aiMax: z.boolean().optional().describe('AI Max on or off (Search and Shopping; off also turns text customization and final URL expansion off)'),
    textCustomization: z.boolean().optional().describe('SEARCH: text customization on or off'),
    finalUrlExpansion: z.boolean().optional().describe('SEARCH: final URL expansion on or off'),
    locationOption: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('the location option'),
    dailyBudgetCents: googleCentsArg('a new amount of the campaign\'s OWN budget (a shared budget: set-google-budget)').optional(),
    why: googleWhyArg,
  }),
  description:
    'Change one Google Ads campaign\'s settings (Search or Standard Shopping): name, Shopping priority, bidding (strategy, '
    + 'max CPC ceiling, target CPA or ROAS, a portfolio), start and end, search partners, Display Network, the location '
    + 'option, what Google does on its own (AI Max, text customization, final URL expansion), and '
    + 'the amount of its own budget. Only what is named changes; the preview shows each from → to. Turning on anything '
    + 'that reaches more people, Google taking over bids, a higher ceiling or budget, and running longer are marked '
    + 'SPENDS MONEY. Status: set-google-status. Undo puts the old settings back.' + GOOGLE_CHANGE_RULES,
  undo: settingsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildSettings(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildSettings(args), (draft) => ({ data: { campaignId: args.campaignId }, before: draft.before, after: draft.after })),
}

// ── set-google-targeting ────────────────────────────────────────────────────────────────────────────────────────

const TARGETING_KEYS = ['addLocations', 'removeLocations', 'addLanguages', 'removeLanguages', 'schedule', 'clearSchedule', 'addAudiences', 'removeAudiences', 'devices', 'locationBids', 'addRadius', 'removeRadius', 'clearAudienceSetting'] as const
const targetingRequest = (a: Record<string, unknown>): TargetingRequest =>
  Object.fromEntries(TARGETING_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) as TargetingRequest

/**
 * The campaign and its targeting criteria; its ad groups with their device adjustments when an ad group's device is
 * asked; its ad groups with their audience criteria when interests change; the names of the interests added.
 */
async function targetingLive(account: Parameters<GoogleDraftBuilder>[0], campaignId: string, request: TargetingRequest): Promise<TargetingLive> {
  const campaign = await liveCampaignSettings(account.target, campaignId)
  const criteria = campaign ? await liveTargetingCriteria(account.target, campaignId) : []
  const live: TargetingLive = { campaign, criteria }
  if (!campaign) return live
  if (request.devices?.some((d) => d.adGroupId)) {
    live.adGroups = await liveTargetingAdGroups(account.target, campaignId)
    live.adGroupDevices = await liveAdGroupDevices(account.target, campaignId)
  }
  if (request.addAudiences?.length || request.removeAudiences?.length || request.clearAudienceSetting) {
    const state = await liveAdGroupTargetingState(account.target, campaignId)
    live.adGroups = state.adGroups
    live.adGroupCriteria = state.adGroupCriteria
  }
  if (request.addAudiences?.length) live.segmentNames = await liveSegmentNames(account.target, request.addAudiences.map((id) => ({ kind: 'USER_INTEREST' as const, id })))
  return live
}

const buildTargeting = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const campaignId = String(args.campaignId)
  const request = targetingRequest(args)
  return targetingDraft(customerResource(account.target), campaignId, request, await targetingLive(account, campaignId, request))
}

const geo = (s: string | null | undefined) => (s ?? '').split('/').pop() ?? ''

const targetingUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TargetingRecord & { accountId?: string; customerId?: string; schedule?: string[] | null }
    const account = await recordAccount(after)
    if (!account) return null
    const u = after.undo ?? {}
    // Only what tells whether it still stands: the campaign, its criteria, ad group devices when it set one.
    const live = await targetingLive(account, after.campaignId, { devices: u.devices })
    const criteria = live.criteria as TargetingCriterion[]
    const has = (type: string, id: string, negative = false) => criteria.some((k) => k.type === type && k.negative === negative && geo(type === 'LOCATION' ? k.location : type === 'LANGUAGE' ? k.language : k.audience) === id)
    const micro = (deg: number) => Math.round(deg * 1_000_000)
    const radius = (id: string) => criteria.find((k) => k.type === 'PROXIMITY' && k.criterionId === id)
    const factor = (bid: { id?: string; radiusId?: string }) => (bid.radiusId ? radius(bid.radiusId) : criteria.find((k) => k.type === 'LOCATION' && !k.negative && geo(k.location) === bid.id))?.bidModifier ?? 1
    const deviceNow = (d: { device: string; adGroupId?: string }) => (d.adGroupId
      ? live.adGroupDevices?.find((m) => m.adGroupId === d.adGroupId && m.device === d.device)?.bidModifier ?? null
      : criteria.find((k) => k.type === 'DEVICE' && k.device === d.device)?.bidModifier ?? 1)
    // What the change wrote still stands when what it added is there, what it removed is not, and what it set in place
    // (bid adjustments, devices) still has the value it set.
    const holds = (u.removeLocations ?? []).every((l) => has('LOCATION', l.id, !!l.exclude))
      && (u.addLocations ?? []).every((l) => !has('LOCATION', l.id, !!l.exclude))
      && (u.removeLanguages ?? []).every((id) => has('LANGUAGE', id))
      && (u.addLanguages ?? []).every((id) => !has('LANGUAGE', id))
      && (u.removeAudiences ?? []).every((id) => has('USER_INTEREST', id))
      && (u.addAudiences ?? []).every((id) => !has('USER_INTEREST', id))
      && (u.removeRadius ?? []).every((id) => !!radius(id))
      && (u.addRadius ?? []).every((r) => !criteria.some((k) => k.type === 'PROXIMITY' && k.proximity?.latitudeMicro === micro(r.latitude ?? NaN) && k.proximity?.longitudeMicro === micro(r.longitude ?? NaN) && k.proximity?.radius === r.radius))
      && (after.set?.locationBids ?? []).every((b) => factor(b) === b.bidModifier)
      && (after.set?.devices ?? []).every((d) => (deviceNow(d) ?? null) === (d.bidModifier ?? (d.adGroupId ? null : 1)))
      && (after.schedule === undefined || JSON.stringify(scheduleKeys(scheduleNow(criteria))) === JSON.stringify(after.schedule))
      && (after.set?.audienceSetting === undefined || audienceSettingNow(live.campaign) === after.set.audienceSetting)
    return holds ? after : { ...after, moved: true }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as TargetingRecord & { accountId?: string }
    if (!after.campaignId || !after.undo || !Object.keys(after.undo).length) return { refusal: 'This change does not record what it replaced.' }
    return { tool: 'set-google-targeting', args: { ...(after.accountId ? { accountId: after.accountId } : {}), campaignId: after.campaignId, ...after.undo, why: 'undo of an earlier targeting change' } }
  },
}

/** The campaign's audience setting as a targeting change records it. */
function audienceSettingNow(campaign: TargetingLive['campaign']): 'OBSERVATION' | 'TARGETING' | 'NONE' {
  const t = campaign?.audienceMode.find((r) => r.dimension === 'AUDIENCE')
  return !t ? 'NONE' : t.observationOnly ? 'OBSERVATION' : 'TARGETING'
}

/** A schedule as sorted day@from-to keys (what a targeting change's record keeps of the schedule it set). */
function scheduleKeys(slots: Array<{ days: string[]; from: string; to: string; bidModifier?: number }>): string[] {
  // Times as Google reads them back (08:00, not 8:00), and each slot's bid adjustment.
  const hhmm = (t: string) => { const [h, m] = t.trim().split(':'); return `${h.padStart(2, '0')}:${m}` }
  return slots.flatMap((s) => (s.days.map((d) => d.toUpperCase()).includes('ALL') ? [...DAYS] : s.days.map((d) => d.toUpperCase()))
    .map((d) => `${d}@${hhmm(s.from)}-${hhmm(s.to)}x${s.bidModifier ?? 1}`)).sort()
}

/** A bid factor, rounded to 4 decimals as Google's adjustments are read back (live-targeting factorOf): undo compares them. */
const round4 = (v: number) => Math.round(v * 10_000) / 10_000
const factorArg = z.coerce.number().min(0.1).max(10).transform(round4)
const deviceTargetArg = z.object({
  device: z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum(DEVICES)).describe('MOBILE, DESKTOP, TABLET or CONNECTED_TV'),
  bidModifier: z.union([z.null(), z.coerce.number().min(0).max(10).refine((v) => v === 0 || v >= 0.1, '0 (never on this device) or 0.1–10').transform(round4)])
    .describe('a factor: 1.2 = +20 %, 0.5 = −50 %, 0 = never on this device (−100 %); null = no adjustment (an ad group: its own removed, the campaign\'s applies)'),
  adGroupId: googleIdArg('an ad group of this campaign, for its own device adjustment (it replaces the campaign\'s for that device)').optional(),
})
const radiusArg = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional().describe('the centre\'s latitude in degrees (with longitude), or give address'),
  longitude: z.coerce.number().min(-180).max(180).optional().describe('the centre\'s longitude in degrees'),
  address: z.object({
    street: z.string().trim().min(1).max(200).optional().describe('street and number'),
    city: z.string().trim().min(1).max(100).optional().describe('city'),
    postalCode: z.string().trim().min(1).max(20).optional().describe('postal code'),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).describe('two-letter country code'),
  }).optional().describe('an address Google turns into the centre (instead of latitude / longitude)'),
  radius: z.coerce.number().min(0.1).max(800).describe('the radius'),
  units: z.enum(['KILOMETERS', 'MILES']).optional().describe('KILOMETERS (default) or MILES'),
  bidModifier: factorArg.optional().describe('its bid adjustment as a factor (1.2 = +20 %)'),
})

const setGoogleTargeting: AgentTool = {
  ...common,
  name: 'set-google-targeting',
  title: 'Change a Google Ads campaign\'s targeting',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign'),
    addLocations: z.array(locationArg).max(100).optional().describe('locations to target or exclude'),
    removeLocations: z.array(locationArg).max(100).optional().describe('locations to stop targeting (or excluding)'),
    locationBids: z.array(z.object({
      id: googleIdArg('a targeted location (geo target id)').optional(),
      radiusId: googleIdArg('a targeted radius (its criterion id; google-ads-live view settings shows it)').optional(),
      bidModifier: z.union([z.null(), factorArg]).describe('its bid adjustment as a factor (1.2 = +20 %, 0.8 = −20 %); null = none'),
    })).max(100).optional().describe('change the bid adjustment of locations or radii the campaign already targets (id or radiusId, one of them)'),
    addRadius: z.array(radiusArg).max(50).optional().describe('target a radius around a point or an address (Google cannot exclude a radius)'),
    removeRadius: z.array(googleIdArg('a targeted radius (its criterion id)')).max(50).optional().describe('radii to stop targeting'),
    addLanguages: languageIdsArg.optional().describe('SEARCH: languages to add'),
    removeLanguages: languageIdsArg.optional().describe('SEARCH: languages to remove'),
    schedule: scheduleArg.optional().describe('the whole week\'s ad schedule from now (replaces what is there)'),
    clearSchedule: z.boolean().optional().describe('true = all day, every day (removes the schedule)'),
    devices: z.array(deviceTargetArg).max(50).optional().describe('device bid adjustments of the campaign, or of one of its ad groups (adGroupId)'),
    addAudiences: audienceIdsArg.optional().describe('interest segments to add in OBSERVATION (google-ads-live view lookup, lookup audiences)'),
    removeAudiences: audienceIdsArg.optional().describe('observed interest segments to remove (exclusions and segments that narrow: set-google-audiences)'),
    clearAudienceSetting: z.boolean().optional().describe('what undo uses: take off the audience setting (observation) that adding the first interest put on the campaign'),
    why: googleWhyArg,
  }),
  description:
    'Change one Google Ads campaign\'s targeting (Search or Standard Shopping): targeted and excluded locations, the bid '
    + 'adjustment of a location or radius it already targets, radius targeting around a point or address, languages '
    + '(Search), the ad schedule (the whole week, replaced; or cleared = all day), device bid adjustments (0 = never on '
    + 'that device; at the campaign, or an ad group\'s own) and interest segments the campaign OBSERVES, added or removed '
    + '(every kind of segment, exclusions, bid adjustments, ad groups and the targeting/observation mode: '
    + 'set-google-audiences; demographics: set-google-demographics). Ids come from google-ads-live view lookup (lookup '
    + 'locations / languages / audiences). What lets the ads reach more people or bid '
    + 'more is marked SPENDS MONEY — above all removing the last location or language, a device shown again and a '
    + 'raised bid adjustment. The location option is set-google-campaign. Undo puts the targeting back.' + GOOGLE_CHANGE_RULES,
  undo: targetingUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildTargeting(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildTargeting(args), (draft, responses) => {
    const after = targetingRecordAfterRun(draft.after as TargetingRecord, responses)
    const asked = targetingRequest(args)
    const schedule = asked.clearSchedule ? [] : asked.schedule ? scheduleKeys(asked.schedule) : undefined
    // `before` names what undo puts back (a change record needs one); `after` adds the schedule it set, as keys.
    return { data: { campaignId: args.campaignId, ...(after.undo.removeRadius?.length ? { radiusIds: after.undo.removeRadius } : {}) }, before: { campaignId: after.campaignId, undo: after.undo }, after: { ...after, ...(schedule !== undefined ? { schedule } : {}) } }
  }),
}

// ── set-google-status ───────────────────────────────────────────────────────────────────────────────────────────

const itemArg = z.object({
  kind: z.enum(['campaign', 'ad-group', 'keyword', 'ad']).describe('campaign, ad-group, keyword or ad'),
  id: z.string().trim().regex(/^\d{1,20}(~\d{1,20})?$/).describe('campaign / ad group: its id; keyword: adGroupId~criterionId; ad: adGroupId~adId'),
  status: z.enum(['PAUSED', 'ENABLED']).optional().describe('its status from now (default: the request\'s status)'),
})

async function statusLive(account: Parameters<GoogleDraftBuilder>[0], request: StatusRequest) {
  const campaigns = await liveCampaigns(account.target)
  const ids = (kind: string) => request.items.filter((i) => i.kind === kind).map((i) => i.id)
  const items = await liveStatuses(account.target, { adGroups: ids('ad-group'), keywords: ids('keyword'), ads: ids('ad') })
  // Enabling a campaign: the two things that make it spend where nobody meant it to.
  const facts: EnableFacts = { openEverythingElse: {}, noLocation: [] }
  for (const i of request.items) {
    if (i.kind !== 'campaign' || (i.status ?? request.status) !== 'ENABLED') continue
    const c = campaigns.find((x) => x.campaignId === i.id)
    if (!c || c.status === 'ENABLED') continue
    const criteria = await liveCampaignCriteria(account.target, c.campaignId)
    if (!criteria.some((k) => (k.type === 'LOCATION' || k.type === 'PROXIMITY') && !k.negative)) facts.noLocation.push(c.campaignId)
    if (c.type === 'SHOPPING') {
      // "Everything else" left open, or "All products" alone as one advertised unit: both reach every other product.
      const open = (await liveProductGroups(account.target, c.campaignId)).filter((g) => g.kind === 'UNIT' && !g.excluded && (g.everythingElse || g.parentId === null)).length
      if (open) facts.openEverythingElse[c.campaignId] = open
    }
  }
  return { campaigns, items, facts }
}

const statusRequest = (a: Record<string, unknown>): StatusRequest => ({ items: (a.items as StatusRequest['items']) ?? [], status: a.status as StatusRequest['status'] })
const buildStatus = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = statusRequest(args)
  return statusDraft(customerResource(account.target), request, await statusLive(account, request))
}

const statusUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as StatusRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const live = await statusLive(account, { items: after.items.map((i) => ({ kind: i.kind, id: i.id, status: 'PAUSED' })) })
    const now = (kind: string, id: string) => (kind === 'campaign' ? live.campaigns.find((c) => c.campaignId === id)?.status : live.items.find((x) => x.kind === kind && x.id === id)?.status) ?? null
    return { ...after, items: after.items.map((i) => ({ kind: i.kind, id: i.id, status: now(i.kind, i.id) })) }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as StatusRecord & { accountId?: string }
    const items = (before.items ?? []).filter((i) => i.status === 'PAUSED' || i.status === 'ENABLED')
    if (!items.length || items.length !== (before.items ?? []).length) return { refusal: 'This change does not record every status it replaced.' }
    return { tool: 'set-google-status', args: { ...(before.accountId ? { accountId: before.accountId } : {}), items: items.map((i) => ({ kind: i.kind, id: i.id, status: i.status })), why: 'undo of an earlier status change' } }
  },
}

const setGoogleStatus: AgentTool = {
  ...common,
  name: 'set-google-status',
  title: 'Pause or enable Google Ads items',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    items: z.array(itemArg).min(1).max(100).describe('what to pause or enable'),
    status: z.enum(['PAUSED', 'ENABLED']).optional().describe('the status for every item that names none'),
    why: googleWhyArg,
  }),
  description:
    'Pause or enable Google Ads campaigns, ad groups, keywords and ads of the business\'s chosen account, in one request '
    + '(ids from google-ads-live: keyword adGroupId~criterionId, ad adGroupId~adId). Pausing is a safe step. ENABLING is '
    + 'the person\'s decision and always marked SPENDS MONEY; enabling a Shopping campaign whose product groups leave '
    + '"everything else" open, or a campaign with no targeted location, says so. Undo puts the old statuses back.'
    + GOOGLE_CHANGE_RULES,
  undo: statusUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildStatus(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildStatus(args), (draft) => ({ data: { items: (draft.after as StatusRecord).items }, before: draft.before, after: draft.after })),
}

// ── remove-google-ads-items ─────────────────────────────────────────────────────────────────────────────────────

const removeRequest = (a: Record<string, unknown>): RemoveRequest => ({ items: (a.items as RemoveRequest['items']) ?? [] })
const buildRemove = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = removeRequest(args)
  const campaigns = await liveCampaigns(account.target)
  const ids = (kind: string) => request.items.filter((i) => i.kind === kind).map((i) => i.id)
  const items = await liveStatuses(account.target, { adGroups: ids('ad-group'), keywords: ids('keyword'), ads: ids('ad') })
  const budgets = ids('budget').length ? await liveBudgets(account.target, campaigns) : []
  const lists = ids('negative-list').length ? await liveNegativeLists(account.target) : []
  return removeDraft(customerResource(account.target), request, { campaigns, items, budgets, lists })
}

const removeGoogleAdsItems: AgentTool = {
  ...common,
  name: 'remove-google-ads-items',
  title: 'Remove Google Ads items (for good)',
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    items: z.array(z.object({
      kind: z.enum(['campaign', 'ad-group', 'keyword', 'ad', 'budget', 'negative-list']).describe('what kind of item'),
      id: z.string().trim().regex(/^\d{1,20}(~\d{1,20})?$/).describe('its id (keyword adGroupId~criterionId; ad adGroupId~adId)'),
    })).min(1).max(50).describe('what to remove'),
    confirmRemove: z.literal(true).describe('true: the person asked for exactly this removal'),
    why: googleWhyArg,
  }),
  description:
    'REMOVE (delete) Google Ads campaigns, ad groups, keywords, ads, budgets or negative keyword lists of the business\'s '
    + 'chosen account. Use it ONLY when the person asked for that removal (confirmRemove true); to stop something for a '
    + 'while, pause it with set-google-status. A removal cannot be undone (Google keeps a removed item only as history). A '
    + 'budget or list still in use is refused.' + GOOGLE_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildRemove(args), (draft) => ({ data: { removed: (draft.after as { removed: unknown[] }).removed }, before: draft.before, after: draft.after })),
}

export const GOOGLE_ADS_CAMPAIGN_TOOLS: AgentTool[] = [createGoogleCampaign, setGoogleCampaign, setGoogleTargeting, setGoogleStatus, removeGoogleAdsItems]
