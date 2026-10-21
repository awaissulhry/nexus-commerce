/**
 * Meta ads, step 6 (2026-10-21) — Claude's DETAILED reads of the chosen Meta ad account's campaigns, ad sets, ads,
 * creatives, labels and value rule sets, live from Meta (marketing/meta-ads/live-objects.ts). Read only: nothing here
 * changes Meta, and the gateway lets only GET through.
 *
 *   meta-campaigns    every field of a campaign, delivery issues, Advantage+ state, legacy shopping campaigns, Meta's
 *                     recommendations for it, copies, studies, rules that govern it, budget schedules (campaign or ad set)
 *                     — master CMP-001…009, CMP-014, CMP-015, CMP-030, AS-026, RC-006 (campaign)
 *   meta-ad-sets      every field of an ad set, learning, relaxed targeting, real placements, review of dynamic creative,
 *                     recommendations, legacy bid multipliers, copies, studies, rules, drafts, async requests, delivery
 *                     stats and Meta's bid recommendation, targeting insights, actionable insights, the ad sets that use an
 *                     audience, the account's maximum bid — AS-001…005, AS-009…013, AS-015, AS-021, AS-029, AS-099,
 *                     CMP-005, TG-089, IN-088, RC-030, RC-031, CR-439
 *   meta-ad-details   ads and creatives: every field, review per platform, delivery checks, issues, recommendations,
 *                     drafts, rules, every delivery problem of the account in one answer, auction / fatigue / diversity
 *                     diagnostics, results per asset, async creative jobs, creative insights, Meta's suggested ads, the
 *                     ad's feedback ids, locale keys, catalog categories — AD-001…009, AD-014, AD-015, AD-020…022,
 *                     CR-001…008 (CR-008 by label: meta-labels), CR-034, CR-219, CR-220, CR-248, CR-269, CR-270, CR-306,
 *                     CR-336, CR-402, CR-424, CR-429, CR-431, CR-437, CR-438, CR-442, CR-447, CR-459, IN-085, RC-006,
 *                     RC-029, RC-032…037
 *   meta-labels       the account's labels and what carries them — CMP-013, CMP-081, CMP-085, CMP-086, AS-024, AD-012, CR-008
 *   meta-value-rules  value rule sets and their rules — AS-091, AS-092
 * Not here, by design: an ad's leads and callback requests (CR-252: people's names and phone numbers — the leads tool,
 * with its own checks), the comments under an ad (AD-020 answers the feedback ids only), the numbers in general
 * (meta-ads-live, meta-ads-overview, the numbers tool), previews (public links: the preview tool).
 * Money is in minor units (cents) of the account currency; amounts Meta does not document the unit of are Meta's numbers
 * as sent, under their own money keys.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { addDays, dayCount } from '../../marketing/meta-ads/dates.js'
import {
  accountMaxBid, adDetail, adFeedback, adLocales, adsList, adSetActionableInsights, adSetAsyncRequests, adSetDeliveryStats, adSetDetail, adSetsList,
  adSetTargetingInsights, ASSET_BREAKDOWNS, assetResults, ASYNC_REQUEST_STATUSES, audienceAdSets, budgetSchedule, budgetSchedules, campaignDetail,
  campaignsList, catalogCategories, CATEGORY_CRITERIA, creativeDetail, creativeInsights, creativeJobs, creativesList, deliveryProblems, LABEL_OBJECT_KINDS,
  labelDetail, labelObjects, labelsList, objectCopies, objectDiagnostics, objectDrafts, objectRules, objectStudies, smartSuggestedAds, SUGGESTED_USE_CASES,
  suggestedAds, VALUE_RULE_PRODUCT_TYPES, VALUE_RULE_STATUSES, valueRuleSet, valueRuleSets,
} from '../../marketing/meta-ads/live-objects.js'
import { META_MONEY } from './meta-ads-read.tools.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' answers: META_MONEY and the amounts step 6 reads. */
export const META_OBJECTS_MONEY = {
  ...META_MONEY,
  dailyMinSpendTargetCents: ADSPEND, dailySpendCapCents: ADSPEND, lifetimeMinSpendTargetCents: ADSPEND, lifetimeSpendCapCents: ADSPEND, bidInfoCents: ADSPEND,
  // A high-demand period's increase, the account's maximum bid, Meta's auction amounts, its bid recommendation and its
  // average cost, targeting insights' spend / revenue / cost: Meta's numbers as sent (unit undocumented) — money all the same.
  budgetValue: ADSPEND, maxBid: ADSPEND, auctionBid: ADSPEND, auctionMaxCompetitorBid: ADSPEND, wishBid: ADSPEND,
  bidRecommendation: ADSPEND, currentAverageCost: ADSPEND, spendMeta: ADSPEND, revenueMeta: ADSPEND, conversionCostMeta: ADSPEND,
  // An answer Meta does not document (recommendation data, ad proposals, creative insights, smart suggestions): it may hold amounts.
  metaRaw: ADSPEND,
} as const

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${what} (YYYY-MM-DD, the ad account's time zone)`)
const metaIdArg = (what: string) => z.string().trim().regex(/^\d{1,25}$/).optional().describe(what)
const connectionArg = z.string().trim().min(1).max(64).optional().describe('the Meta connection (from meta-connection); default: this business\'s one')
const maxRowsArg = z.number().int().min(1).max(500).optional().describe('at most this many rows (default 100; at most 500)')
const statusesArg = (what: string) => z.array(z.string().trim().min(1).max(30)).min(1).max(12).optional()
  .describe(`${what}: only these effective statuses (e.g. ACTIVE, PAUSED, ARCHIVED, WITH_ISSUES); default every one but DELETED — Meta refuses a DELETED filter, read a deleted one by its id`)
const completedArg = z.boolean().optional().describe('only finished (true) or not finished (false) ones (Meta\'s is_completed)')
const changedSinceArg = dayArg('only those changed since this day (Meta\'s updated_since; the whole account\'s list only)')
const passEvaluationArg = z.boolean().optional().describe('rules: only the rules this object passes now (true) or fails now (false); default: every rule that names it')

const META_RULES_LINE = 'Read only: Meta is never changed here (a change is a set-meta-… or create-meta-… tool, which a person approves). Only the business\'s chosen ad account and its own objects are read; a Page or Instagram account another business in Nexus uses is its id and a flag only.'

async function guarded(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return { ok: false, error: err.message }
    throw err
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const conn = (args: Record<string, unknown>) => str(args.connectionId)
const rows = (args: Record<string, unknown>) => (typeof args.maxRows === 'number' ? args.maxRows : undefined)
const boolOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null)
/** A day (YYYY-MM-DD) → Unix seconds at 00:00 UTC (Meta's updated_since and budget-schedule windows take a timestamp). */
const unixOf = (day: unknown): number | null => (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Math.floor(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 1000) : null)
const need = (v: unknown, sentence: string): string => { const s = str(v); if (!s) throw new MetaLiveRefusal(sentence); return s }

/** The days of a diagnostics or per-asset read: from and to, at most 92 days, from before to (to alone: the 7 days ending then). */
function windowOf(args: Record<string, unknown>): { from: string; to: string } {
  const to = str(args.to)
  const from = str(args.from) ?? (to ? addDays(to, -6) : null)
  if (!from || !to) throw new MetaLiveRefusal('Name the days (from and to, YYYY-MM-DD, the ad account\'s time zone; today is allowed).')
  if (to < from || dayCount({ from, to }) > 92) throw new MetaLiveRefusal('Read at most 92 days at once, from before to.')
  return { from, to }
}

/** The one object a view is about: the ad, else the ad set, else the campaign a caller named. */
function objectOf(args: Record<string, unknown>, kinds: Array<'campaign' | 'adset' | 'ad'>): { kind: 'campaign' | 'adset' | 'ad'; id: string } | null {
  if (kinds.includes('ad') && str(args.adId)) return { kind: 'ad', id: str(args.adId)! }
  if (kinds.includes('adset') && str(args.adSetId)) return { kind: 'adset', id: str(args.adSetId)! }
  if (kinds.includes('campaign') && str(args.campaignId)) return { kind: 'campaign', id: str(args.campaignId)! }
  return null
}

// ── meta-campaigns ──────────────────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_VIEWS = ['list', 'campaign', 'copies', 'studies', 'rules', 'budget-schedules', 'budget-schedule'] as const
type CampaignView = typeof CAMPAIGN_VIEWS[number]

const metaCampaigns: AgentTool = {
  name: 'meta-campaigns',
  title: 'Meta campaigns, in detail',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_OBJECTS_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(CAMPAIGN_VIEWS)).default('list').describe('list | campaign | copies | studies | rules | budget-schedules | budget-schedule'),
    campaignId: metaIdArg('campaign, copies, studies, rules, budget-schedules, budget-schedule: the Meta campaign id'),
    adSetId: metaIdArg('budget-schedules, budget-schedule: an ad set\'s budget schedules instead of a campaign\'s'),
    periodId: metaIdArg('budget-schedule: the high-demand period id (from view budget-schedules)'),
    statuses: statusesArg('list, copies'),
    completed: completedArg,
    passEvaluation: passEvaluationArg,
    from: dayArg('budget-schedules: only periods that end after this day'),
    to: dayArg('budget-schedules: only periods that start on or before this day'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The chosen Meta ad account\'s campaigns read LIVE from Meta, in detail (meta-ads-live lists them with numbers inline; '
    + 'this tool reads every field). view list (default): every campaign with every field and Meta\'s total count, filtered by '
    + 'statuses or completed. campaign (campaignId): every field (objective, buying type, status in words, campaign budget '
    + 'or ad-set budgets, spend cap, bid strategy, promoted object, special ad categories, budget sharing and scheduling, '
    + 'labels, attribution, copy source), why it does not deliver (issues), its Advantage+ state (Advantage+ sales / app / '
    + 'leads or off, and budget, audience and placement each on or off — read only), whether it is a legacy Advantage+ '
    + 'shopping campaign (Meta refuses every edit of those since v25), and Meta\'s recommendations for it. copies: the '
    + 'campaigns copied from it. studies: the A/B tests and lift studies it is in. rules: Meta\'s automated rules that govern '
    + 'it. budget-schedules (campaignId or adSetId): its scheduled budget increases (high-demand periods); budget-schedule: '
    + 'one of them. Meta cannot: filter a list by DELETED (read a deleted campaign by its id); move a campaign\'s start or '
    + 'stop time (they come from its ad sets); show a budget edit in updatedTime. A campaign\'s ad sets: meta-ad-sets; its '
    + 'ads: meta-ad-details. ' + META_RULES_LINE + ' Money in minor units (cents) of the account currency.',
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'list') as CampaignView
    const connectionId = conn(args)
    return guarded(async () => {
      const campaignId = () => need(args.campaignId, 'Name the campaign (campaignId).')
      const owner = (): { kind: 'campaign' | 'adset'; id: string } => {
        if (str(args.adSetId)) return { kind: 'adset', id: str(args.adSetId)! }
        return { kind: 'campaign', id: need(args.campaignId, 'Name the campaign (campaignId) or the ad set (adSetId).') }
      }
      switch (view) {
        case 'list': return campaignsList({ connectionId, statuses: strings(args.statuses), completed: boolOf(args.completed), maxRows: rows(args) })
        case 'campaign': return campaignDetail({ connectionId, campaignId: campaignId() })
        case 'copies': return objectCopies({ connectionId, kind: 'campaign', id: campaignId(), statuses: strings(args.statuses), completed: boolOf(args.completed), maxRows: rows(args) })
        case 'studies': return objectStudies({ connectionId, kind: 'campaign', id: campaignId(), maxRows: rows(args) })
        case 'rules': return objectRules({ connectionId, kind: 'campaign', id: campaignId(), passEvaluation: boolOf(args.passEvaluation), maxRows: rows(args) })
        case 'budget-schedules': {
          const o = owner()
          const from = unixOf(args.from)
          const to = unixOf(args.to)
          return budgetSchedules({ connectionId, ...o, from: from === null ? null : String(from), to: to === null ? null : String(to + 86_400), maxRows: rows(args) })
        }
        case 'budget-schedule': return budgetSchedule({ connectionId, ...owner(), periodId: need(args.periodId, 'Name the period (periodId from view budget-schedules).') })
      }
    })
  },
}

// ── meta-ad-sets ────────────────────────────────────────────────────────────────────────────────────────────────────

const ADSET_VIEWS = ['list', 'adset', 'copies', 'studies', 'rules', 'drafts', 'async-requests', 'delivery-stats', 'targeting-insights', 'actionable-insights', 'by-audience', 'max-bid'] as const
type AdSetView = typeof ADSET_VIEWS[number]

const metaAdSets: AgentTool = {
  name: 'meta-ad-sets',
  title: 'Meta ad sets, in detail',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_OBJECTS_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(ADSET_VIEWS)).default('list')
      .describe('list | adset | copies | studies | rules | drafts | async-requests | delivery-stats | targeting-insights | actionable-insights | by-audience | max-bid'),
    adSetId: metaIdArg('every view but list, by-audience and max-bid: the Meta ad set id'),
    campaignId: metaIdArg('list: only this campaign\'s ad sets'),
    audienceId: metaIdArg('by-audience: the custom audience id (the chosen account\'s own)'),
    statuses: statusesArg('list, copies, by-audience'),
    completed: completedArg,
    changedSince: changedSinceArg,
    passEvaluation: passEvaluationArg,
    bidRecommendation: z.boolean().optional().describe('delivery-stats: also ask Meta\'s bid recommendation (switch lowest cost → cost cap)'),
    requestStatuses: z.array(z.preprocess(upper, z.enum(ASYNC_REQUEST_STATUSES))).min(1).max(13).optional().describe('async-requests: only these request statuses'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The chosen Meta ad account\'s ad sets read LIVE from Meta, in detail (meta-ads-live lists them with numbers inline). '
    + 'view list (default): every ad set of the account or of one campaign, with Meta\'s total count, by statuses, completed '
    + 'or changedSince. adset (adSetId): every field — goal, billing, bid strategy and bid (per 1,000 impressions when it '
    + 'bills on impressions), budgets, spend targets and caps, schedule, frequency caps, attribution, promoted object, '
    + 'targeting, DSA payer and beneficiary, dynamic creative, value rule set, labels, copy source — plus whether it is still '
    + 'learning, which targeting Meta relaxed, where it will really run (placements), why it does not deliver (issues), the '
    + 'review of each dynamic-creative asset, Meta\'s recommendations and the old bid multipliers. copies, studies, rules '
    + '(Meta\'s automated rules), drafts (unpublished Ads Manager edits), async-requests, delivery-stats (learning stage, '
    + 'unsupported features, Meta\'s bid recommendation), targeting-insights, actionable-insights (Meta\'s ad proposals), '
    + 'by-audience (the ad sets and ads that use a custom audience), max-bid (the account\'s maximum bid). Meta cannot: list '
    + 'an audience\'s ad sets directly (Nexus groups its ads), let an API make or publish drafts, or say what targeting '
    + 'insights and ad proposals hold (Meta\'s answer is shown as it is). Budget schedules: meta-campaigns; value rules: '
    + 'meta-value-rules; ads and creatives: meta-ad-details. ' + META_RULES_LINE + ' Money in minor units (cents).',
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'list') as AdSetView
    const connectionId = conn(args)
    return guarded(async () => {
      const adSetId = () => need(args.adSetId, 'Name the ad set (adSetId).')
      switch (view) {
        case 'list': return adSetsList({ connectionId, campaignId: str(args.campaignId), statuses: strings(args.statuses), completed: boolOf(args.completed), changedSince: unixOf(args.changedSince), maxRows: rows(args) })
        case 'adset': return adSetDetail({ connectionId, adSetId: adSetId() })
        case 'copies': return objectCopies({ connectionId, kind: 'adset', id: adSetId(), statuses: strings(args.statuses), completed: boolOf(args.completed), maxRows: rows(args) })
        case 'studies': return objectStudies({ connectionId, kind: 'adset', id: adSetId(), maxRows: rows(args) })
        case 'rules': return objectRules({ connectionId, kind: 'adset', id: adSetId(), passEvaluation: boolOf(args.passEvaluation), maxRows: rows(args) })
        case 'drafts': return objectDrafts({ connectionId, kind: 'adset', id: adSetId(), maxRows: rows(args) })
        case 'async-requests': return adSetAsyncRequests({ connectionId, adSetId: adSetId(), statuses: strings(args.requestStatuses), maxRows: rows(args) })
        case 'delivery-stats': return adSetDeliveryStats({ connectionId, adSetId: adSetId(), bidRecommendation: args.bidRecommendation === true })
        case 'targeting-insights': return adSetTargetingInsights({ connectionId, adSetId: adSetId(), maxRows: rows(args) })
        case 'actionable-insights': return adSetActionableInsights({ connectionId, adSetId: adSetId() })
        case 'by-audience': return audienceAdSets({ connectionId, audienceId: need(args.audienceId, 'Name the custom audience (audienceId).'), statuses: strings(args.statuses), maxRows: rows(args) })
        case 'max-bid': return accountMaxBid({ connectionId })
      }
    })
  },
}

// ── meta-ad-details ─────────────────────────────────────────────────────────────────────────────────────────────────

const AD_VIEWS = [
  'ads', 'ad', 'creatives', 'creative', 'drafts', 'rules', 'problems', 'diagnostics', 'asset-results', 'creative-jobs', 'creative-insights',
  'suggested', 'smart-suggested', 'feedback', 'locales', 'catalog-categories',
] as const
type AdView = typeof AD_VIEWS[number]
const enumWord = (what: string) => z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,59}$/).optional().describe(what)

const metaAdDetails: AgentTool = {
  name: 'meta-ad-details',
  title: 'Meta ads and creatives, in detail',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_OBJECTS_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(AD_VIEWS)).default('ads')
      .describe('ads | ad | creatives | creative | drafts | rules | problems | diagnostics | asset-results | creative-jobs | creative-insights | suggested | smart-suggested | feedback | locales | catalog-categories'),
    adId: metaIdArg('ad, feedback; creatives, drafts, rules, diagnostics, asset-results: this ad'),
    adSetId: metaIdArg('ads, creatives: only this ad set\'s; drafts, rules, diagnostics, asset-results: this ad set; catalog-categories: the ad set whose catalog'),
    campaignId: metaIdArg('ads, creatives: only this campaign\'s; drafts, rules, diagnostics: this campaign'),
    creativeId: metaIdArg('creative, creative-insights: the creative; ads: only the ads that use it'),
    jobId: metaIdArg('creative-jobs: one async creative job and its requests'),
    statuses: statusesArg('ads'),
    changedSince: changedSinceArg,
    completed: completedArg,
    passEvaluation: passEvaluationArg,
    includePausedByParent: z.boolean().optional().describe('problems: also list ads that do not run because their campaign or ad set is paused'),
    breakdown: z.preprocess(lower, z.enum(ASSET_BREAKDOWNS)).optional().describe('asset-results: body_asset | title_asset | description_asset | image_asset | video_asset | call_to_action_asset | link_url_asset | ad_format_asset'),
    from: dayArg('diagnostics, asset-results: first day'),
    to: dayArg('diagnostics, asset-results: last day (today allowed)'),
    thumbnailWidth: z.number().int().min(1).max(2000).optional().describe('creative: the thumbnail\'s width in pixels (Meta\'s default 64)'),
    thumbnailHeight: z.number().int().min(1).max(2000).optional().describe('creative: the thumbnail\'s height in pixels (Meta\'s default 64)'),
    useCase: z.preprocess(upper, z.enum(SUGGESTED_USE_CASES)).optional().describe('suggested: Meta\'s use case (default AUTOMATED_SHOPPING_ADS)'),
    objective: enumWord('suggested, smart-suggested: the campaign objective (e.g. OUTCOME_SALES)'),
    optimizationGoal: enumWord('suggested, smart-suggested: the optimisation goal (e.g. OFFSITE_CONVERSIONS)'),
    optimizationEvent: enumWord('suggested: the conversion event (e.g. PURCHASE)'),
    customEventType: enumWord('smart-suggested: the conversion event (e.g. PURCHASE)'),
    destinationType: enumWord('smart-suggested: the destination (e.g. WEBSITE)'),
    countries: z.array(z.string().trim().regex(/^[A-Z]{2}$/)).min(1).max(50).optional().describe('suggested: country codes (ISO 3166-1 alpha-2)'),
    rankBy: z.string().trim().regex(/^[a-z_]{1,40}$/).optional().describe('suggested: Meta\'s ranking (default ads_revenue)'),
    forChosenPage: z.boolean().optional().describe('suggested: only suggestions for the business\'s chosen Facebook Page'),
    search: z.string().trim().min(1).max(60).optional().describe('locales: a language name to look up (e.g. Italian)'),
    criteria: z.preprocess(upper, z.enum(CATEGORY_CRITERIA)).optional().describe('catalog-categories: BRAND | CATEGORY | PRODUCT_TYPE'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The chosen Meta ad account\'s ads and creatives read LIVE from Meta, in detail. view ads (default): the account\'s, a '
    + 'campaign\'s or an ad set\'s ads with every list field, status in words (paused by its campaign or ad set, in review, '
    + 'rejected, waiting for a payment method), issues, labels and the Instagram post of placement-customised ads; with '
    + 'creativeId, the ads that use that creative. ad (adId): every field, Meta\'s review per platform, its delivery checks '
    + '(reading runs them), issues with Meta\'s message id, recommendations, multi-media and flexible-format set-up, whether '
    + 'it is a website-to-message ad. creatives / creative (creativeId): every field — texts, Page and Instagram identity, '
    + 'story spec, asset feed, the Advantage+ features Meta really applied, format automation, branded and partnership '
    + 'settings, WhatsApp number and identity, Messenger message, landing-page optimisation, thumbnail at a size. drafts: '
    + 'unpublished Ads Manager edits (account, campaign, ad set or ad). rules: Meta\'s automated rules that govern it. '
    + 'problems: every problem that stops delivery in the account, in one answer (account state, issues, rejections, '
    + 'payment, review, Page ad limits). diagnostics (from, to): auction overlap between the account\'s own ad sets, auction '
    + 'competition, creative fatigue and diversity (Meta\'s v26 has no relevance rankings: shown only if Meta answers them). '
    + 'asset-results: results per text, image, video, link or format of a dynamic-creative ad. creative-jobs, '
    + 'creative-insights, suggested and smart-suggested (Meta\'s suggested ads), feedback (the ad\'s feedback ids only), '
    + 'locales (language keys), catalog-categories (of the catalog an ad set promotes). Meta cannot: list a creative\'s ads '
    + 'directly (Nexus looks through the ads), give results per finished dynamic-creative combination (Ads Manager only), '
    + 'or let an API publish drafts. Not here: leads and callback requests, and the comments under an ad (people\'s data: '
    + 'their own tools); ad previews (public links: the preview tool); industry benchmarks (Meta\'s own MCP only). By label: '
    + 'meta-labels. ' + META_RULES_LINE + ' Money in minor units (cents).',
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'ads') as AdView
    const connectionId = conn(args)
    return guarded(async () => {
      switch (view) {
        case 'ads': return adsList({ connectionId, campaignId: str(args.campaignId), adSetId: str(args.adSetId), creativeId: str(args.creativeId), statuses: strings(args.statuses), changedSince: unixOf(args.changedSince), maxRows: rows(args) })
        case 'ad': return adDetail({ connectionId, adId: need(args.adId, 'Name the ad (adId).') })
        case 'creatives': return creativesList({ connectionId, campaignId: str(args.campaignId), adSetId: str(args.adSetId), adId: str(args.adId), maxRows: rows(args) })
        case 'creative': return creativeDetail({ connectionId, creativeId: need(args.creativeId, 'Name the creative (creativeId).'), thumbnailWidth: typeof args.thumbnailWidth === 'number' ? args.thumbnailWidth : null, thumbnailHeight: typeof args.thumbnailHeight === 'number' ? args.thumbnailHeight : null })
        case 'drafts': {
          const o = objectOf(args, ['ad', 'adset', 'campaign'])
          return objectDrafts({ connectionId, kind: o?.kind ?? 'account', id: o?.id ?? null, maxRows: rows(args) })
        }
        case 'rules': {
          const o = objectOf(args, ['ad', 'adset', 'campaign'])
          if (!o) throw new MetaLiveRefusal('Name the ad, ad set or campaign (adId, adSetId or campaignId).')
          return objectRules({ connectionId, ...o, passEvaluation: boolOf(args.passEvaluation), maxRows: rows(args) })
        }
        case 'problems': return deliveryProblems({ connectionId, includePausedByParent: args.includePausedByParent === true, maxRows: rows(args) })
        case 'diagnostics': {
          const o = objectOf(args, ['ad', 'adset', 'campaign'])
          if (!o) throw new MetaLiveRefusal('Name the ad, ad set or campaign (adId, adSetId or campaignId).')
          return objectDiagnostics({ connectionId, ...o, ...windowOf(args) })
        }
        case 'asset-results': {
          const o = objectOf(args, ['ad', 'adset'])
          if (!o) throw new MetaLiveRefusal('Name the ad or ad set (adId or adSetId).')
          if (!args.breakdown) throw new MetaLiveRefusal('Name the asset breakdown (breakdown: body_asset, title_asset, image_asset, video_asset, …).')
          return assetResults({ connectionId, kind: o.kind as 'adset' | 'ad', id: o.id, breakdown: args.breakdown as typeof ASSET_BREAKDOWNS[number], ...windowOf(args), maxRows: rows(args) })
        }
        case 'creative-jobs': return creativeJobs({ connectionId, jobId: str(args.jobId), completed: boolOf(args.completed), maxRows: rows(args) })
        case 'creative-insights': return creativeInsights({ connectionId, creativeId: need(args.creativeId, 'Name the creative (creativeId).') })
        case 'suggested': return suggestedAds({
          connectionId, useCase: str(args.useCase), objective: str(args.objective), optimizationGoal: str(args.optimizationGoal), optimizationEvent: str(args.optimizationEvent),
          countries: strings(args.countries), rankBy: str(args.rankBy), forChosenPage: args.forChosenPage === true, maxRows: rows(args),
        })
        case 'smart-suggested': return smartSuggestedAds({ connectionId, objective: str(args.objective), optimizationGoal: str(args.optimizationGoal), customEventType: str(args.customEventType), destinationType: str(args.destinationType) })
        case 'feedback': return adFeedback({ connectionId, adId: need(args.adId, 'Name the ad (adId).') })
        case 'locales': return adLocales({ connectionId, search: need(args.search, 'Name the language to look up (search).'), maxRows: rows(args) })
        case 'catalog-categories': {
          if (!args.criteria) throw new MetaLiveRefusal('Name how the catalog\'s products are grouped (criteria: BRAND, CATEGORY or PRODUCT_TYPE).')
          return catalogCategories({ connectionId, adSetId: need(args.adSetId, 'Name the ad set whose catalog it is (adSetId).'), criteria: args.criteria as typeof CATEGORY_CRITERIA[number], maxRows: rows(args) })
        }
      }
    })
  },
}

// ── meta-labels ─────────────────────────────────────────────────────────────────────────────────────────────────────

const LABEL_VIEWS = ['labels', 'label', 'objects'] as const
type LabelView = typeof LABEL_VIEWS[number]

const metaLabels: AgentTool = {
  name: 'meta-labels',
  title: 'Meta ad labels',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(LABEL_VIEWS)).default('labels').describe('labels | label | objects'),
    labelId: metaIdArg('label: the label id'),
    labelIds: z.array(z.string().trim().regex(/^\d{1,25}$/)).min(1).max(50).optional().describe('objects: the label ids (one: through the label itself; several: with operator)'),
    operator: z.preprocess(upper, z.enum(['ALL', 'ANY'])).optional().describe('objects with several labels: ALL (carry every label) or ANY (carry one of them; the default)'),
    kind: z.preprocess(lower, z.enum(LABEL_OBJECT_KINDS)).optional().describe('objects: campaigns | adsets | ads | creatives'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The chosen Meta ad account\'s ad labels, read LIVE from Meta. view labels (default): every label with Meta\'s total '
    + 'count. label (labelId): one label. objects (labelIds, kind): the campaigns, ad sets, ads or creatives that carry a '
    + 'label — one label through the label itself, several with ALL or ANY. Labels are matched by id only: Meta has no '
    + 'partial name match. A label of another ad account is refused. ' + META_RULES_LINE,
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'labels') as LabelView
    const connectionId = conn(args)
    return guarded(async () => {
      switch (view) {
        case 'labels': return labelsList({ connectionId, maxRows: rows(args) })
        case 'label': return labelDetail({ connectionId, labelId: need(args.labelId, 'Name the label (labelId).') })
        case 'objects': {
          const ids = strings(args.labelIds) ?? (str(args.labelId) ? [str(args.labelId)!] : [])
          if (!ids.length) throw new MetaLiveRefusal('Name the labels (labelIds).')
          if (!args.kind) throw new MetaLiveRefusal('Name what to list (kind: campaigns, adsets, ads or creatives).')
          return labelObjects({ connectionId, labelIds: ids, operator: (args.operator as 'ALL' | 'ANY' | undefined) ?? null, kind: args.kind as typeof LABEL_OBJECT_KINDS[number], maxRows: rows(args) })
        }
      }
    })
  },
}

// ── meta-value-rules ────────────────────────────────────────────────────────────────────────────────────────────────

const metaValueRules: AgentTool = {
  name: 'meta-value-rules',
  title: 'Meta value rules',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(['sets', 'set'])).default('sets').describe('sets | set'),
    ruleSetId: metaIdArg('set: the value rule set id'),
    productType: z.preprocess(upper, z.enum(VALUE_RULE_PRODUCT_TYPES)).optional().describe('sets: only AUDIENCE, LEADGEN_ADS or OMNI_CHANNEL rule sets'),
    status: z.preprocess(upper, z.enum(VALUE_RULE_STATUSES)).optional().describe('sets: only ACTIVE, DRAFT or DELETED rule sets'),
    connectionId: connectionArg,
  }),
  description:
    'The chosen Meta ad account\'s value rule sets, read LIVE from Meta: rules that raise (up to +1,000 %) or lower (up to '
    + '−90 %) the bid for people who match their criteria (age, gender, location, OS, device, placement, audience label). '
    + 'view sets (default): every rule set with its rules and criteria; set (ruleSetId): one of them. An ad set uses one '
    + 'through its valueRuleSetId (meta-ad-sets view adset). ' + META_RULES_LINE,
  async handler(args): Promise<ToolResult> {
    const connectionId = conn(args)
    return guarded(async () => (args.view === 'set'
      ? valueRuleSet({ connectionId, ruleSetId: need(args.ruleSetId, 'Name the value rule set (ruleSetId).') })
      : valueRuleSets({ connectionId, productType: str(args.productType), status: str(args.status) })))
  },
}

export const META_ADS_OBJECTS_TOOLS: AgentTool[] = [metaCampaigns, metaAdSets, metaAdDetails, metaLabels, metaValueRules]
