/**
 * Google Ads changes, PR 2 (2026-10-15) — campaigns, targeting, status and removal. Every tool here is a Nexus change: a
 * preview Google has checked (validate_only), an approvalId, a person approves it in Nexus, it runs as that person
 * (google-ads-kit.ts). Never by rule.
 *
 *   create-google-campaign   a Standard Shopping or Search campaign, ALWAYS paused, with its budget and targeting
 *   set-google-campaign      name, Shopping priority, bidding, dates, networks, location option, Google's automation
 *                            switches (AI Max, campaign broad match, text customization, final URL expansion), own budget
 *   set-google-targeting     locations, languages, ad schedule, audiences (observation only)
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
import { scheduleNow, targetingDraft, type TargetingRecord, type TargetingRequest } from '../../marketing/google-ads/change-targeting.js'
import { removeDraft, statusDraft, type EnableFacts, type RemoveRequest, type StatusRecord, type StatusRequest } from '../../marketing/google-ads/change-status.js'
import { liveBudgets, liveCampaigns, liveCampaignSettings, liveNegativeLists, liveProductGroups } from '../../marketing/google-ads/live.js'
import { liveCampaignCriteria, liveStatuses } from '../../marketing/google-ads/live-campaigns.js'
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
})).max(42)
const locationArg = z.object({
  id: googleIdArg('the location (a geo target id; google-ads-live view lookup lookup locations finds it)'),
  exclude: z.boolean().optional().describe('true = excluded location'),
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
      args: { ...(after.accountId ? { accountId: after.accountId } : {}), items: [{ kind: 'campaign', id: after.campaignId }], confirmRemove: true, why: 'undo of an earlier campaign create' },
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
      broadMatch: z.boolean().optional().describe('campaign-level broad match (default off)'),
      textCustomization: z.boolean().optional().describe('text customization / automatically created text (default off)'),
      finalUrlExpansion: z.boolean().optional().describe('final URL expansion (default off; turns text customization on)'),
    }).optional().describe('SEARCH: what Google may do on its own (all off by default)'),
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
    + 'priority) or Search (networks, languages, and what Google may do on its own: AI Max, campaign broad match, text '
    + 'customization, final URL expansion — all OFF unless asked), with its budget (a shared budgetId or its own '
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

const SETTINGS_KEYS = ['name', 'priority', 'bidding', 'startDate', 'endDate', 'searchPartners', 'display', 'aiMax', 'broadMatch', 'textCustomization', 'finalUrlExpansion', 'locationOption', 'dailyBudgetCents'] as const
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
    aiMax: z.boolean().optional().describe('SEARCH: AI Max on or off'),
    broadMatch: z.boolean().optional().describe('SEARCH: campaign-level broad match on or off'),
    textCustomization: z.boolean().optional().describe('SEARCH: text customization on or off'),
    finalUrlExpansion: z.boolean().optional().describe('SEARCH: final URL expansion on or off'),
    locationOption: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('the location option'),
    dailyBudgetCents: googleCentsArg('a new amount of the campaign\'s OWN budget (a shared budget: set-google-budget)').optional(),
    why: googleWhyArg,
  }),
  description:
    'Change one Google Ads campaign\'s settings (Search or Standard Shopping): name, Shopping priority, bidding (strategy, '
    + 'max CPC ceiling, target CPA or ROAS, a portfolio), start and end, search partners, Display Network, the location '
    + 'option, what Google does on its own (AI Max, campaign broad match, text customization, final URL expansion), and '
    + 'the amount of its own budget. Only what is named changes; the preview shows each from → to. Turning on anything '
    + 'that reaches more people, Google taking over bids, a higher ceiling or budget, and running longer are marked '
    + 'SPENDS MONEY. Status: set-google-status. Undo puts the old settings back.' + GOOGLE_CHANGE_RULES,
  undo: settingsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildSettings(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildSettings(args), (draft) => ({ data: { campaignId: args.campaignId }, before: draft.before, after: draft.after })),
}

// ── set-google-targeting ────────────────────────────────────────────────────────────────────────────────────────

const TARGETING_KEYS = ['addLocations', 'removeLocations', 'addLanguages', 'removeLanguages', 'schedule', 'clearSchedule', 'addAudiences', 'removeAudiences'] as const
const targetingRequest = (a: Record<string, unknown>): TargetingRequest =>
  Object.fromEntries(TARGETING_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) as TargetingRequest

const buildTargeting = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const campaignId = String(args.campaignId)
  const campaign = await liveCampaignSettings(account.target, campaignId)
  const criteria = campaign ? await liveCampaignCriteria(account.target, campaignId) : []
  return targetingDraft(customerResource(account.target), campaignId, targetingRequest(args), { campaign, criteria })
}

const geo = (s: string | null | undefined) => (s ?? '').split('/').pop() ?? ''

const targetingUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TargetingRecord & { accountId?: string; customerId?: string; schedule?: string[] | null }
    const account = await recordAccount(after)
    if (!account) return null
    const criteria = await liveCampaignCriteria(account.target, after.campaignId)
    const has = (type: string, id: string, negative = false) => criteria.some((k) => k.type === type && k.negative === negative && geo(type === 'LOCATION' ? k.location : type === 'LANGUAGE' ? k.language : k.audience) === id)
    const u = after.undo ?? {}
    // What the change wrote still stands when what it added is there and what it removed is not.
    const holds = (u.removeLocations ?? []).every((l) => has('LOCATION', l.id, !!l.exclude))
      && (u.addLocations ?? []).every((l) => !has('LOCATION', l.id, !!l.exclude))
      && (u.removeLanguages ?? []).every((id) => has('LANGUAGE', id))
      && (u.addLanguages ?? []).every((id) => !has('LANGUAGE', id))
      && (u.removeAudiences ?? []).every((id) => has('USER_INTEREST', id))
      && (u.addAudiences ?? []).every((id) => !has('USER_INTEREST', id))
      && (after.schedule === undefined || JSON.stringify(scheduleKeys(scheduleNow(criteria))) === JSON.stringify(after.schedule))
    return holds ? after : { ...after, moved: true }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as TargetingRecord & { accountId?: string }
    if (!after.campaignId || !after.undo || !Object.keys(after.undo).length) return { refusal: 'This change does not record what it replaced.' }
    return { tool: 'set-google-targeting', args: { ...(after.accountId ? { accountId: after.accountId } : {}), campaignId: after.campaignId, ...after.undo, why: 'undo of an earlier targeting change' } }
  },
}

/** A schedule as sorted day@from-to keys (what a targeting change's record keeps of the schedule it set). */
function scheduleKeys(slots: Array<{ days: string[]; from: string; to: string }>): string[] {
  return slots.flatMap((s) => (s.days.includes('ALL') ? [...DAYS] : s.days).map((d) => `${d}@${s.from}-${s.to}`)).sort()
}

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
    addLanguages: languageIdsArg.optional().describe('SEARCH: languages to add'),
    removeLanguages: languageIdsArg.optional().describe('SEARCH: languages to remove'),
    schedule: scheduleArg.optional().describe('the whole week\'s ad schedule from now (replaces what is there)'),
    clearSchedule: z.boolean().optional().describe('true = all day, every day (removes the schedule)'),
    addAudiences: audienceIdsArg.optional().describe('audience segments to add in OBSERVATION'),
    removeAudiences: audienceIdsArg.optional().describe('audience segments to remove'),
    why: googleWhyArg,
  }),
  description:
    'Change one Google Ads campaign\'s targeting (Search or Standard Shopping): targeted and excluded locations, languages '
    + '(Search), the ad schedule (the whole week, replaced; or cleared = all day) and audience segments, added in '
    + 'OBSERVATION only (they set bids, they never narrow who sees the ads). Ids come from google-ads-live view lookup. '
    + 'What lets the ads reach more people is marked SPENDS MONEY — above all removing the last location or language. The '
    + 'location option is set-google-campaign. Undo puts the targeting back.' + GOOGLE_CHANGE_RULES,
  undo: targetingUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildTargeting(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildTargeting(args), (draft) => {
    const after = draft.after as TargetingRecord
    const asked = targetingRequest(args)
    const schedule = asked.clearSchedule ? [] : asked.schedule ? scheduleKeys(asked.schedule) : undefined
    return { data: { campaignId: args.campaignId }, before: null, after: { ...after, ...(schedule !== undefined ? { schedule } : {}) } }
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
    if (!criteria.some((k) => k.type === 'LOCATION' && !k.negative)) facts.noLocation.push(c.campaignId)
    if (c.type === 'SHOPPING') {
      const open = (await liveProductGroups(account.target, c.campaignId)).filter((g) => g.kind === 'UNIT' && g.everythingElse && !g.excluded).length
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
