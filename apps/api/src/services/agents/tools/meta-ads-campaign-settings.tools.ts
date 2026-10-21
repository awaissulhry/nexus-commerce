/**
 * Meta ads changes, step 18 — the settings of campaigns and ad sets, their budgets and bids, and scheduled budget
 * increases, on the business's chosen Meta ad account:
 *   set-meta-campaign         name, budget (amount, daily ⇄ lifetime, campaign budget on / off), ad set budget sharing
 *                             (off), bid strategy (+ each ad set's cap), spend cap, special ad category, promoted object,
 *                             objective (empty campaigns), pacing, reels trending ads  — CMP-034, 036–039, 041–046,
 *                             062–064, 067, 068, 071–073, 075
 *   set-meta-ad-set           name, goal, billing, budget, minimum spend / spend cap / budget share under a campaign
 *                             budget, bid strategy, bid, ROAS goal, start, end, restart, ad scheduling, pacing, frequency
 *                             caps, attribution, promoted object, EU payer and beneficiary, regional identities, customer
 *                             goal, ad sequence and rotation, comments, contextual bundles, two SDK-only switches —
 *                             AS-040–062, 064, 065, 068–072, 074–079, 101
 *   set-meta-budget-schedule  schedule, change or delete a budget increase; budget scheduling on / off — CMP-057,
 *                             059–061, AS-088, AS-090
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person
 * approves it, it runs as that person, and undo puts back what it replaced (or says what has no way back on Meta).
 * Meta's own MCP tool for these (ads_update_entity) changes a field without a preview, an approval, a spending sentence or
 * an undo; these do all four.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { liveAccountCapabilities, liveAccountPixels, liveAdSet, liveAdSetAds, liveBudgetSchedules, liveCampaign, liveCampaignAdSets, liveFieldValues, type MetaSettingsTarget } from '../../marketing/meta-ads/live-settings.js'
import { metaCatalogProblem } from '../../marketing/meta-ads/catalog-rule.js'
import { CAMPAIGN_NOT_SENT, campaignReadsNeeded, campaignSettingsDraft, type CampaignSettingsRequest } from '../../marketing/meta-ads/change-campaign-settings.js'
import { AD_SET_NOT_SENT, ATTRIBUTION_PRESETS, adSetReadsNeeded, adSetSettingsDraft, type AdSetSettingsRequest } from '../../marketing/meta-ads/change-ad-set-settings.js'
import { budgetScheduleDraft, livePeriodFields, type BudgetScheduleRequest, type ScheduleObject } from '../../marketing/meta-ads/change-budget-schedule.js'
import { settingsView, viewedFields, type SettingsRecord } from '../../marketing/meta-ads/change-settings-common.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'
import {
  BID_STRATEGIES, BILLING_EVENTS, CUSTOM_EVENT_TYPES, META_NAME_TEXT, META_STRICT_TEXT, CUSTOMER_LABELS, ENGAGED_LABELS, FREQUENCY_EVENTS, OPTIMIZATION_GOALS, OPTIMIZATION_SUB_EVENTS,
  OUTCOME_OBJECTIVES, REGIONAL_CATEGORIES, REGIONAL_IDENTITY_KEYS, SPECIAL_AD_CATEGORIES,
} from '../../gateway/meta-settings-rules.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' previews and answers: their sentences quote budgets, bids and caps, so they are money too. */
const META_SETTINGS_MONEY = {
  changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, skipped: ADSPEND, steps: ADSPEND, fields: ADSPEND, values: ADSPEND,
} as const

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const centsArg = (what: string) => z.number().int().positive().max(100_000_000_000).describe(`${what}, in minor units of the ad account's currency (cents for EUR)`)
const idList = (what: string, max: number) => z.array(z.string().trim().regex(/^\d{1,20}$/, 'a Meta id is digits only')).max(max).describe(what)
/**
 * Review A8 — text a person types: any script, no control or format character (no U+202E) — the gateway's own patterns
 * (meta-settings-rules.ts): a name may join two emoji with U+200D; the EU payer and beneficiary never take one.
 */
const typedText = (max: number, pattern: RegExp) => z.string().trim().min(1).max(max).regex(pattern, 'no control or format characters')
const isoArg = (what: string) => z.string().trim().min(10).max(40).describe(`${what} (ISO 8601 with its offset, e.g. 2026-11-01T08:00:00Z)`)
const promotedArg = z.object({
  pixelId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('the pixel (one of the ad account\'s own)'),
  pixelRule: z.string().trim().max(2000).optional().describe('AD SET only: a pixel rule (Meta\'s JSON rule as a string: {"and"|"or": [rules]} or {"<url | event | custom-data key>": {"<operator>": value}}, ≤ 3 levels, ≤ 10 conditions)'),
  customEventType: z.enum(CUSTOM_EVENT_TYPES).optional().describe('the conversion event (PURCHASE, ADD_TO_CART, …)'),
  customEventStr: z.string().trim().min(1).max(100).optional().describe('with OTHER: the event\'s own name'),
  productCatalogId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('a catalog of the chosen ad account\'s business portfolio (owned or a client catalog; never a portfolio another Nexus business uses)'),
  productSetId: z.string().trim().regex(/^\d{1,20}$/).optional().describe('the ad sets\' product set (Meta uses it at the ad set level; an ad set keeps its own as it is): a product set of such a catalog'),
  valueSemanticType: z.enum(['VALUE', 'MARGIN', 'LIFETIME_VALUE']).optional().describe('campaign only: what the event value means'),
}).describe('the promoted object: only the keys named change (Meta replaces the whole object, so Nexus sends it with the rest as it is)')

// ── shared: live reads → draft, undo ────────────────────────────────────────────────────────────────────────────

/** A builder that turns a refusal of the live reads (another account, not that kind) into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

/** The run's record: what the change replaced (its draft's before) and what Meta read back for what it wrote. */
function settingsFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeDraft['requests'][number]; result: { node: Record<string, unknown> | null } }>) {
  const before = draft.before as SettingsRecord
  const planned = draft.after as SettingsRecord
  const first = done.find((d) => d.request.step === 1)
  const fields = Object.keys(planned.fields)
  const viewed = first ? viewedFields(fields, first.result.node, first.request.params) : { fields: planned.fields, unread: fields }
  const unread = [...new Set([...(planned.unread ?? []), ...viewed.unread])]
  const after: SettingsRecord = { ...planned, fields: viewed.fields, ...(unread.length ? { unread } : {}) }
  return { data: { id: before.id, fields: after.fields, ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}) }, before, after }
}

/** Undo of set-meta-campaign / set-meta-ad-set: what the change replaced goes back through the same tool, read live first. */
function settingsUndo(tool: 'set-meta-campaign' | 'set-meta-ad-set', idArg: 'campaignId' | 'adSetId'): ToolUndo {
  return {
    async current(change: ToolChange) {
      const after = (change.after ?? {}) as SettingsRecord & { accountId?: string; adAccountId?: string }
      const account = await recordAccount(after)
      if (!account) return null
      const unread = new Set(after.unread ?? [])
      const readable = Object.keys(after.fields ?? {}).filter((f) => !unread.has(f))
      const live = await liveFieldValues(account.target, after.id, readable)
      if (!live) return null
      const fields = { ...after.fields }
      for (const f of readable) if (live[f] !== undefined) fields[f] = settingsView(f, live[f])
      return { ...after, fields }
    },
    request(change: ToolChange) {
      const before = (change.before ?? {}) as SettingsRecord & { accountId?: string }
      if (!before.undo || !before.id) {
        return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier values.'}` }
      }
      return {
        tool,
        args: {
          ...(before.accountId ? { connectionId: before.accountId } : {}),
          [idArg]: before.id,
          ...before.undo,
          why: `undo of an earlier Meta change${before.noUndo?.length ? ` (stays as it is: ${before.noUndo.join(' ')})` : ''}`.slice(0, 300),
        },
      }
    },
  }
}

const targetOf = (account: { target: MetaSettingsTarget }) => account.target

// ── set-meta-campaign ───────────────────────────────────────────────────────────────────────────────────────────

const campaignRequest = (args: Record<string, unknown>): CampaignSettingsRequest => {
  const { connectionId: _c, why: _w, ...rest } = args
  return rest as unknown as CampaignSettingsRequest
}

const buildCampaign = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = campaignRequest(args)
  const target = targetOf(account)
  const campaign = await liveCampaign(target, request.campaignId)
  const needs = campaignReadsNeeded(request, campaign)
  const children = needs.adSets ? await liveCampaignAdSets(target, campaign.id) : null
  const pixels = needs.pixels ? await liveAccountPixels(target) : null
  const catalogProblem = needs.catalog ? await metaCatalogProblem(target, needs.catalog) : undefined
  return campaignSettingsDraft(request, { campaign, currency: account.currency, adSets: children?.adSets ?? null, adSetsMore: children?.more ?? false, pixels, catalogProblem })
})

const setMetaCampaign: AgentTool = {
  name: 'set-meta-campaign',
  title: 'Change a Meta campaign\'s settings',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Most parts are put back by undo; budget sharing off and a ROAS goal under a campaign budget have no way back (Meta).
  reversibility: 'partial',
  consequencesFor: (args) => {
    // Review A9 — only parts with no way back on Meta: budget sharing off, and a ROAS goal strategy (a campaign bid
    // strategy exists only under a campaign budget, where Meta never switches a ROAS goal away).
    const keys = Object.keys(args).filter((k) => !['connectionId', 'campaignId', 'why'].includes(k) && args[k] !== undefined)
    const forGood = (k: string) => k === 'budgetSharing' || (k === 'bidStrategy' && args.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS')
    return keys.length > 0 && keys.every(forGood) ? { reversibility: 'none' } : null
  },
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_SETTINGS_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    campaignId: metaIdArg('the campaign'),
    name: typedText(400, META_NAME_TEXT).optional().describe('its new name (emoji allowed)'),
    dailyBudgetCents: centsArg('a campaign daily budget: changes it, switches a lifetime one to daily, or turns campaign budget on').optional(),
    lifetimeBudgetCents: centsArg('a campaign lifetime budget (every ad set needs an end time)').optional(),
    adSetBudgets: z.array(z.object({
      adSetId: metaIdArg('an ad set of this campaign'),
      dailyBudgetCents: centsArg('its daily budget').optional(),
      lifetimeBudgetCents: centsArg('its lifetime budget').optional(),
    })).min(1).max(70).optional().describe('turn campaign budget OFF: EVERY ad set that is not deleted, each with its own budget (all daily or all lifetime); not for more than 70 ad sets'),
    budgetSharing: z.literal(false).optional().describe('false turns ad set budget sharing off — for good (Meta cannot switch it on again for a running campaign)'),
    bidStrategy: z.enum(BID_STRATEGIES).optional().describe('the campaign\'s bid strategy (campaign budget only): LOWEST_COST_WITHOUT_CAP (highest volume), LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS (no way back under a campaign budget)'),
    adSetBidAmounts: z.array(z.object({ adSetId: metaIdArg('an ad set of this campaign'), bidAmountCents: centsArg('its cap') })).min(1).max(70).optional()
      .describe('with a move from automatic bidding to BID_CAP or COST_CAP: every ad set\'s cap (Meta needs them all)'),
    spendCapCents: z.number().int().positive().max(100_000_000_000).nullable().optional().describe('the campaign spend cap in minor units (Meta asks about USD 100 at least); null removes it'),
    specialAdCategory: z.enum(SPECIAL_AD_CATEGORIES).optional().describe('the special ad category (never political or social-issue ads)'),
    specialAdCategoryCountries: z.array(z.string().trim().regex(/^[A-Z]{2}$/)).min(1).max(250).optional().describe('the countries the category applies to (two letters; needed with any category but NONE)'),
    promotedObject: promotedArg.optional(),
    objective: z.enum(OUTCOME_OBJECTIVES).optional().describe('a new objective — only for a campaign that has no ad set yet'),
    pacing: z.enum(['standard', 'no_pacing', 'day_parting']).optional().describe('the campaign\'s pacing (campaign budget only): standard, no_pacing (accelerated — spends faster) or day_parting (lifetime budget; hours on each ad set)'),
    reelsTrendingAds: z.boolean().optional().describe('Meta\'s "reels trending ads" flag (undocumented by Meta beyond its name)'),
    why: metaWhyArg,
  }),
  description:
    'Change ONE campaign of the business\'s chosen Meta ad account by its Meta id (meta-campaigns shows it): its name; its '
    + 'budget — a new amount, daily ⇄ lifetime, turn campaign budget ON (Meta documents only "off": its answer decides) or '
    + 'OFF (adSetBudgets: every ad set with its own budget; it turns an Advantage+ campaign\'s Advantage+ off); ad set '
    + 'budget sharing OFF (for good); the bid strategy (campaign budget only; a ROAS goal there can never be switched '
    + 'away; moving to a cap names every ad set\'s cap); the spend cap (null removes it); the special ad category (never '
    + 'political); the promoted object (the account\'s own pixel, its business portfolio\'s catalog); the objective (only '
    + 'with no ad set); the pacing (campaign budget only); reels trending ads. Amounts are in minor units of the account '
    + 'currency. ONE request; a raise, removing a cap or a spend cap, accelerated pacing or campaign budget on are SPENDS '
    + 'MONEY (the line says when the campaign is off, so nothing spends yet). Budget and bid changes restart Meta\'s '
    + `learning. Not here: ${CAMPAIGN_NOT_SENT.join(' ')} Undo puts back what it replaced (what Meta has no way back for is said). `
    + 'Meta\'s check (validate_only) is documented for campaign changes; Nexus uses it once a live probe proves Meta honours it.'
    + META_CHANGE_RULES,
  undo: settingsUndo('set-meta-campaign', 'campaignId'),
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCampaign(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCampaign(args), settingsFinish),
}

// ── set-meta-ad-set ─────────────────────────────────────────────────────────────────────────────────────────────

const adSetRequest = (args: Record<string, unknown>): AdSetSettingsRequest => {
  const { connectionId: _c, why: _w, ...rest } = args
  return rest as unknown as AdSetSettingsRequest
}

const buildAdSet = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = adSetRequest(args)
  const target = targetOf(account)
  const { adSet, campaign } = await liveAdSet(target, request.adSetId)
  const needs = adSetReadsNeeded(request, adSet)
  const ads = needs.ads ? (await liveAdSetAds(target, adSet.id)).ads.map((a) => a.id) : null
  const pixels = needs.pixels ? await liveAccountPixels(target) : null
  const catalogProblem = needs.catalog ? await metaCatalogProblem(target, needs.catalog) : undefined
  return adSetSettingsDraft(request, { adSet, campaign, currency: account.currency, ads, pixels, catalogProblem })
})

const daypartBlock = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).describe('0 = Sunday … 6 = Saturday'),
  startHour: z.number().int().min(0).max(23).describe('from this whole hour'),
  endHour: z.number().int().min(1).max(24).describe('to this whole hour (at least one hour later)'),
  timezone: z.enum(['USER', 'ADVERTISER']).optional().describe('USER: the viewer\'s time zone (default); ADVERTISER: the ad account\'s'),
})

const setMetaAdSet: AgentTool = {
  name: 'set-meta-ad-set',
  title: 'Change a Meta ad set\'s settings',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Most parts are put back by undo; a catalog added, a restart's switch-on and fields Meta never read back are said.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_SETTINGS_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    adSetId: metaIdArg('the ad set'),
    name: typedText(400, META_NAME_TEXT).optional().describe('its new name'),
    optimizationGoal: z.enum(OPTIMIZATION_GOALS).optional().describe('the performance goal (sends its ads back to review; restarts learning)'),
    optimizationSubEvent: z.enum(OPTIMIZATION_SUB_EVENTS).optional().describe('the optimisation sub-event (video sound on, travel; NONE)'),
    billingEvent: z.enum(BILLING_EVENTS).optional().describe('what is paid for (sends its ads back to review)'),
    dailyBudgetCents: centsArg('its daily budget (no campaign budget; 4 budget changes an hour)').optional(),
    lifetimeBudgetCents: centsArg('its lifetime budget (needs an end time)').optional(),
    minSpendTargetCents: z.number().int().min(0).max(100_000_000_000).optional().describe('under a campaign budget: the minimum it should spend (daily or lifetime, as the campaign\'s budget), in minor units; 0 removes it'),
    spendCapCents: z.number().int().positive().max(100_000_000_000).nullable().optional().describe('under a campaign budget: the most it may spend, in minor units; null removes it'),
    budgetSharePercent: z.object({
      min: z.number().int().min(0).max(100).optional().describe('min_budget_spend_percentage'),
      max: z.number().int().min(0).max(100).optional().describe('max_budget_spend_percentage'),
    }).optional().describe('Meta\'s min / max budget share percentages (named only on Meta\'s page; its answer decides)'),
    bidStrategy: z.enum(BID_STRATEGIES).optional().describe('its bid strategy (no campaign budget): COST_CAP needs impressions billing and standard pacing; LOWEST_COST_WITH_MIN_ROAS needs the VALUE goal and roasGoal'),
    bidAmountCents: centsArg('its bid cap or cost cap (per 1,000 impressions when billed on impressions)').optional(),
    roasGoal: z.number().min(0.01).max(1000).optional().describe('its minimum ROAS (2.5 = 2.5× the spend back; Meta writes it × 10,000)'),
    removeRoasGoal: z.literal(true).optional().describe('remove its ROAS goal (back to highest volume) — never under a campaign budget (Meta)'),
    startTime: isoArg('when it starts').optional(),
    endTime: isoArg('when it ends').nullable().optional().describe('when it ends (ISO 8601); null: no end (daily budgets only)'),
    restart: z.literal(true).optional().describe('an ad set past its end: endTime moves it, then it is switched on (two requests)'),
    dayparting: z.object({
      off: z.literal(true).optional().describe('ad scheduling off (all day)'),
      pacing: z.enum(['standard', 'no_pacing']).optional().describe('with off: the pacing it goes back to (standard unless named; no_pacing spends faster)'),
      blocks: z.array(daypartBlock).min(1).max(168).optional().describe('the hours it delivers (lifetime budget only)'),
    }).optional().describe('ad scheduling: off, or the blocks of hours'),
    pacing: z.enum(['standard', 'no_pacing']).optional().describe('standard or no_pacing (accelerated — spends faster); no campaign budget'),
    frequencyCaps: z.array(z.object({
      event: z.enum(FREQUENCY_EVENTS).optional().describe('IMPRESSIONS (Meta: "only IMPRESSIONS currently")'),
      intervalDays: z.number().int().min(1).max(90).describe('over this many days'),
      maxFrequency: z.number().int().min(1).max(90).describe('at most this many times'),
    })).max(4).optional().describe('frequency caps (REACH or THRUPLAY goal only); [] removes them'),
    attribution: z.enum(ATTRIBUTION_PRESETS).optional().describe('the attribution Meta optimises on: 1d_click, 7d_click, 1d_click_1d_view, 7d_click_1d_view (sales with conversions only; else 1d_click)'),
    incrementalAttribution: z.boolean().optional().describe('incremental attribution optimisation (Meta\'s SDK only; its answer decides)'),
    promotedObject: promotedArg.optional(),
    dsa: z.object({
      payor: typedText(512, META_STRICT_TEXT).describe('who pays for the ads (shown to people in the EU)'),
      beneficiary: typedText(512, META_STRICT_TEXT).describe('who benefits from the ads (shown to people in the EU)'),
    }).optional().describe('the EU payer and beneficiary: both, always (Meta fills a missing one from the account default, not from the other)'),
    regional: z.object({
      categories: z.array(z.enum(REGIONAL_CATEGORIES)).max(9).describe('the regional regulated categories'),
      identities: z.partialRecord(z.enum(REGIONAL_IDENTITY_KEYS), z.string().trim().regex(/^\d{1,20}$/)).describe('Meta-verified identity ids per key (only the keys its categories need)'),
    }).optional().describe('regional regulated categories (Taiwan, Australia, India, Singapore, Thailand, Malaysia, Brazil — not the EU); Nexus does not check whose the identity ids are (Meta verifies them)'),
    customerGoal: z.object({
      type: z.enum(['broad', 'exclude-existing', 'exclude-existing-and-engaged']).describe('who it reaches'),
      existingCustomerAudienceIds: idList('custom audiences of existing customers (the account\'s own)', 100).optional(),
      engagedAudienceIds: idList('custom audiences of engaged people (exclude-existing-and-engaged)', 100).optional(),
      existingCustomerLabels: z.array(z.enum(CUSTOMER_LABELS)).max(5).optional().describe('customer labels instead of audiences'),
      engagedLabels: z.array(z.enum(ENGAGED_LABELS)).max(5).optional().describe('engaged labels instead of audiences'),
    }).optional().describe('the customer lifecycle goal (Sales campaigns only; broad in a special-category campaign)'),
    creativeSequence: z.object({
      adIds: idList('its ads, in order', 50),
      repetition: z.enum(['FULL_SEQUENCE', 'LAST_AD']).optional().describe('after the last ad: the whole sequence again, or the last ad'),
    }).optional().describe('show its ads in this order ([] clears it)'),
    adRotation: z.object({
      blocks: z.array(z.object({ startTime: isoArg('this range\'s start'), adIds: idList('its ads shown in this range', 50) })).min(2).max(50).describe('the date ranges, in order: the first at the ad set\'s start, the last at least 1 h before its end'),
    }).optional().describe('rotate its ads by date range'),
    comments: z.enum(['on', 'off']).optional().describe('comments on its ads (Meta offers the switch to some accounts only; off hides earlier comments)'),
    contextualBundling: z.enum(['OPT_IN', 'OPT_OUT']).optional().describe('contextual bundles on Facebook surfaces (OPT_IN: more placements)'),
    fullFunnelExploration: z.enum(['NONE_EXPLORATION', 'LIMITED_EXPLORATION', 'EXTENDED_EXPLORATION']).optional().describe('Meta\'s full-funnel exploration (SDK only; its answer decides)'),
    setupState: z.enum(['UNSET', 'AUTOMATIC', 'MANUAL']).optional().describe('Meta\'s automatic_manual_state (named only; its answer decides)'),
    why: metaWhyArg,
  }),
  description:
    'Change ONE ad set of the business\'s chosen Meta ad account by its Meta id (meta-ad-sets shows it): name, '
    + 'performance goal, sub-event and billing (these send its ads back to review), its budget (no campaign budget; Meta '
    + 'allows 4 budget changes an hour, the undo counts), under a campaign budget its minimum spend, spend cap and budget '
    + 'share, its bid strategy and bid (per 1,000 impressions when billed on impressions), its ROAS goal (× 10,000 for '
    + 'Meta; removing it is impossible under a campaign budget), start and end (null: no end), a restart of an ended ad '
    + 'set (end time, then switched on), ad scheduling (lifetime budgets), pacing, frequency caps (REACH / THRUPLAY goals '
    + 'only), the attribution it optimises on, its promoted object (only a new pixel or event of a conversions ad set, or '
    + 'a first catalog), the EU payer and beneficiary (both), regional identities, the customer lifecycle goal (Sales only), '
    + 'an ad sequence or a rotation by date, comments, contextual bundles and two SDK-only switches. Amounts in minor '
    + 'units of the account currency. ONE request (two for a restart). Raises, removed caps, a lower ROAS goal, a longer '
    + 'run, a broad goal, accelerated pacing, opting in to more placements and switching on are SPENDS MONEY (the line '
    + `says when it or its campaign is off, so nothing spends yet). Meta has no check for an ad set change. Not here: ${AD_SET_NOT_SENT.join(' ')} `
    + 'Undo puts back what it replaced (what Meta has no way back for is said).'
    + META_CHANGE_RULES,
  undo: settingsUndo('set-meta-ad-set', 'adSetId'),
  handler: (args, ctx) => metaChangePreview(args, ctx, buildAdSet(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildAdSet(args), settingsFinish),
}

// ── set-meta-budget-schedule ────────────────────────────────────────────────────────────────────────────────────

const scheduleRequest = (args: Record<string, unknown>): BudgetScheduleRequest => {
  const { connectionId: _c, why: _w, ...rest } = args
  return rest as unknown as BudgetScheduleRequest
}

const buildSchedule = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = scheduleRequest(args)
  const target = targetOf(account)
  let object: ScheduleObject
  if (request.level === 'campaign') {
    const c = await liveCampaign(target, request.objectId)
    object = { kind: 'campaign' as const, id: c.id, name: c.name, status: c.status, campaignStatus: c.status, dailyBudget: c.dailyBudget, lifetimeBudget: c.lifetimeBudget, underCampaignBudget: false, budgetScheduling: c.budgetScheduling, objective: c.objective, smartPromotionType: c.smartPromotionType }
  } else {
    const { adSet, campaign } = await liveAdSet(target, request.objectId)
    object = {
      kind: 'adset' as const, id: adSet.id, name: adSet.name, status: adSet.status, campaignStatus: campaign.status, dailyBudget: adSet.dailyBudget, lifetimeBudget: adSet.lifetimeBudget,
      underCampaignBudget: !!(campaign.dailyBudget || campaign.lifetimeBudget), budgetScheduling: adSet.budgetScheduling, objective: campaign.objective, smartPromotionType: campaign.smartPromotionType,
    }
  }
  const periods = await liveBudgetSchedules(target, object.id)
  const capabilities = await liveAccountCapabilities(target)
  return budgetScheduleDraft(request, { object, periods, capabilities, currency: account.currency })
})

function scheduleFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeDraft['requests'][number]; result: { node: Record<string, unknown> | null } }>) {
  const before = draft.before as SettingsRecord
  const planned = draft.after as SettingsRecord
  const r = done[0]
  if (planned.kind !== 'highdemandperiod') return settingsFinish(draft, done)
  const node = r?.result.node ?? null
  // A new period: its id is Meta's answer (read-after-write); a change or delete keeps the period's id.
  const id = planned.id || (node && (typeof node.id === 'string' || typeof node.id === 'number') ? String(node.id) : '')
  const fields: Record<string, string | null> = { ...planned.fields }
  if (node && r.request.method !== 'DELETE') for (const f of ['budget_value', 'budget_value_type', 'time_start', 'time_end']) if (f in node) fields[f] = settingsView(f, node[f])
  const after: SettingsRecord = { ...planned, id }
  after.fields = fields
  return { data: { periodId: id || null, fields, ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}) }, before, after }
}

const scheduleUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as SettingsRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    if (after.kind !== 'highdemandperiod') {
      const live = await liveFieldValues(account.target, after.id, Object.keys(after.fields))
      if (!live) return null
      const fields = { ...after.fields }
      for (const f of Object.keys(after.fields)) if (live[f] !== undefined) fields[f] = settingsView(f, live[f])
      return { ...after, fields }
    }
    if (!after.parent) return null
    const periods = await liveBudgetSchedules(account.target, after.parent.id).catch(() => null)
    if (!periods) return null
    const period = periods.find((p) => p.id === after.id)
    const fields: Record<string, string | null> = period ? { ...livePeriodFields(period), exists: 'yes' } : { exists: 'no' }
    return { ...after, fields: Object.fromEntries(Object.keys(after.fields).map((k) => [k, fields[k] ?? null])) }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as SettingsRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier values.'}` }
    return {
      tool: 'set-meta-budget-schedule',
      args: { ...(before.accountId ? { connectionId: before.accountId } : {}), ...before.undo, why: 'undo of an earlier Meta budget schedule change' },
    }
  },
}

const setMetaBudgetSchedule: AgentTool = {
  name: 'set-meta-budget-schedule',
  title: 'Schedule Meta budget increases',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A new scheduled increase has no way back (Meta documents no change or delete); a change, a delete and the switch do.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'create' ? { reversibility: 'none' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_SETTINGS_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['create', 'change', 'delete', 'switch']).describe('create a scheduled increase, change or delete one (Meta\'s SDK only: its answer decides), or switch budget scheduling on / off'),
    level: z.enum(['campaign', 'adset']).describe('campaign (with a campaign daily budget) or adset (with its own daily budget)'),
    objectId: metaIdArg('the campaign or ad set'),
    periodId: metaIdArg('change, delete: the scheduled increase (meta-campaigns view budget-schedules lists them)').optional(),
    startTime: isoArg('create, change: when the increase starts (in the future)').optional(),
    endTime: isoArg('create, change: when it ends (at least 3 hours later)').optional(),
    increaseCents: z.number().int().positive().max(100_000_000_000).optional().describe('create, change: an increase by an AMOUNT on the daily budget, in minor units — whole currency units only (Meta does not document a smaller unit for it); at most 7 daily budgets'),
    increasePercent: z.number().int().min(1).max(700).optional().describe('create, change: an increase by a PERCENTAGE of the daily budget (1–700)'),
    enabled: z.boolean().optional().describe('switch: budget scheduling on (true) or off (false) — Meta\'s SDK only: its answer decides'),
    why: metaWhyArg,
  }),
  description:
    'Schedule a budget increase (a high-demand period) on ONE campaign (with a campaign daily budget) or ad set (with its '
    + 'own daily budget) of the business\'s chosen Meta ad account: an amount or a percentage on the daily budget, from '
    + 'a start to an end at least 3 hours later (Meta: at most 50 per object, the total at most 8 daily budgets, daily '
    + 'budgets only, not Advantage+ App campaigns; the account needs Meta\'s budget-scheduling capability). It is SPENDS '
    + 'MONEY (the line says when the campaign or ad set is off). A new one has NO undo: Meta documents no way to change '
    + 'or remove one — Meta\'s SDK has both, so action change and action delete send them and Meta\'s answer decides. Also '
    + 'switches budget scheduling on (SPENDS MONEY) or off (SDK only). The unit of an increase by an amount is not '
    + 'documented: Nexus sends whole currency units (read as cents it would be 100 times smaller, never larger). Meta has '
    + 'no check for these changes. Undo puts back a change, schedules a deleted increase again while it has not started, '
    + 'and switches back.'
    + META_CHANGE_RULES,
  undo: scheduleUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSchedule(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSchedule(args), scheduleFinish),
}

export const META_ADS_CAMPAIGN_SETTINGS_TOOLS: AgentTool[] = [setMetaCampaign, setMetaAdSet, setMetaBudgetSchedule]
