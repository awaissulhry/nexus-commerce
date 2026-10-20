/**
 * Sponsored Display extras (P3c) — Amazon's own budget rules for Sponsored Display campaigns, and Amazon's budget
 * recommendations and usage for them, read and changed live at Amazon through advertising/sd/sd-rules.client.ts (the
 * channel gateway). Nexus keeps no copy: Amazon's rules are the record.
 *
 *   sd-budget-rules       read: a market's budget rules (paged), one rule with the campaigns it is on, or a campaign's rules.
 *   set-sd-budget-rule    create   a rule (schedule or performance: +N % from a start date, optionally on days of the week
 *                                  and hours of the day, or while ACOS / CTR / CVR / ROAS passes a threshold), optionally put
 *                                  on one campaign in the same request;
 *                         update   its name, raise, dates, days, hours, condition, or its state (active / paused);
 *                         attach   a rule on a campaign;  detach  a rule off a campaign.
 *   sd-budget-insights    read: Amazon's recommended daily budget, the share of the last 7 days in budget and what it
 *                         missed, and how much of today's budget each campaign has used.
 *
 * Amazon's budget rules only RAISE a budget (a percent on top of the daily budget Amazon holds while the rule applies).
 * The shape is the Sponsored Products read Nexus already has (ads-api-client.ts AmazonBudgetRule, parseCampaignBudgetRules),
 * and Nexus's own budget tools (set-campaign-budget, set-budget-schedule, set-budget-pool, budget pacing) write that same
 * daily budget: the two stack. Every preview that puts a rule to work says so, and names the Nexus schedules, pools and
 * rules that also move each campaign's budget. A rule tied to an Amazon event needs an event id from a budget-rule
 * recommendation, which the Sponsored Display API does not offer: Nexus makes date-range rules only (it reads and keeps
 * an event rule's event on an update). There is no delete: a rule is paused, or taken off its campaigns.
 *
 * Like every ad change tool: a request a person approves (alwaysAsk, ask at most), every value from → to and where it
 * lands in the preview (in sandbox mode it is not queued), Amazon read again in `execute` (what was approved must not have
 * moved), Amazon's refusal in its own words, the change recorded so undo asks for the opposite change. What can raise a
 * budget is listed in `raises` (ADDS SPEND).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import {
  attachSdBudgetRule, createSdBudgetRule, detachSdBudgetRule, getSdBudgetRule, listSdBudgetRules, sdBudgetRecommendations, sdBudgetRuleCampaigns,
  sdBudgetUsage, sdCampaignBudgetRules, updateSdBudgetRule, type SdBudgetRule,
} from '../../advertising/sd/sd-rules.client.js'
import { nexusCampaignsByAmazonId, sdCampaignOf, sdCampaignsIn, type SdCampaign } from '../../advertising/sd/sd-entities.js'
import { ADDS_NO_SPEND, addsSpendWords, DAY_TO_DAY_NO_CODE } from './ads-code-rule.js'
import { approvedRun, canonical, notRun, recheck, type StoredReach } from './ads-change-kit.js'
import { boundAutomationsFor } from './ads-tool-guards.js'
import { budgetEnginesOf } from './ads-budget-kit.js'
import {
  amazonDay, basisOf, centsOf, isoDay, isoDateArg, NOTHING_CHANGED, NOTHING_QUEUED, plural, quote, realDay, sandboxRead, sdAnswered,
  sdIdArg, sdMarketArg, sdMarketOf, sdReach, sdReachNote, sdWhyArg, todayIso, type SdMarket,
} from './ads-sd-kit.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'set-sd-budget-rule'
const ADSPEND = FIELDS.financialsAdspendView
/** Pages of a rule's campaigns read (Amazon's pages hold 30). */
const CAMPAIGN_PAGES = 3
/** Amazon's most budget rules on one campaign. */
const MAX_RULES_PER_CAMPAIGN = 250

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
const METRICS = ['acos', 'ctr', 'cvr', 'roas'] as const
const COMPARISONS = ['greater-than', 'greater-or-equal', 'less-than', 'less-or-equal'] as const
const AMAZON_COMPARISON: Record<(typeof COMPARISONS)[number], string> = {
  'greater-than': 'GREATER_THAN', 'greater-or-equal': 'GREATER_THAN_OR_EQUAL_TO', 'less-than': 'LESS_THAN', 'less-or-equal': 'LESS_THAN_OR_EQUAL_TO',
}
const COMPARISON_OF = Object.fromEntries(Object.entries(AMAZON_COMPARISON).map(([ours, theirs]) => [theirs, ours])) as Record<string, (typeof COMPARISONS)[number]>
const SIGN: Record<(typeof COMPARISONS)[number], string> = { 'greater-than': '>', 'greater-or-equal': '≥', 'less-than': '<', 'less-or-equal': '≤' }
const HHMM = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time is HH:MM (24 hours)')

/** A budget rule as these tools hold it: what a person reads and what undo puts back. Dates YYYY-MM-DD. */
export interface BudgetValues {
  name: string | null
  type: 'schedule' | 'performance' | null
  state: 'active' | 'paused' | null
  increasePct: number | null
  startDate: string | null
  endDate: string | null
  /** An Amazon event the rule follows instead of dates (read only: Nexus makes date-range rules). */
  event: string | null
  recurrence: 'daily' | 'weekly' | null
  daysOfWeek: string[]
  hours: { from: string; to: string } | null
  condition: { metric: string; comparison: string; threshold: number } | null
}

const lower = (v: string | null | undefined) => (v ? v.toLowerCase() : null)
const hhmm = (t: string) => t.slice(0, 5)

function valuesOf(r: SdBudgetRule): BudgetValues {
  const type = lower(r.ruleType)
  const state = lower(r.ruleState)
  const recurrence = lower(r.recurrence)
  return {
    name: r.name,
    type: type === 'schedule' || type === 'performance' ? type : null,
    state: state === 'active' || state === 'paused' ? state : null,
    increasePct: r.increasePct,
    startDate: r.eventName ? null : isoDay(r.startDate),
    endDate: r.eventName ? null : isoDay(r.endDate),
    event: r.eventName,
    recurrence: recurrence === 'daily' || recurrence === 'weekly' ? recurrence : null,
    daysOfWeek: r.daysOfWeek.map((d) => d.toLowerCase()),
    hours: r.window ? { from: hhmm(r.window.startTime), to: hhmm(r.window.endTime) } : null,
    condition: r.metric && r.comparison && r.threshold != null
      ? { metric: r.metric.toLowerCase(), comparison: COMPARISON_OF[r.comparison] ?? r.comparison, threshold: r.threshold }
      : null,
  }
}

/** A rule in one line: "+20 % from 2026-11-01 to 2026-11-30, weekly on saturday, sunday, 18:00–23:00". */
function ruleWords(v: BudgetValues | null): string {
  if (!v) return 'none'
  const when = v.event ? `during the Amazon event ${v.event}` : `from ${v.startDate ?? '?'}${v.endDate ? ` to ${v.endDate}` : ' (no end)'}`
  const repeat = v.recurrence === 'weekly' ? `, weekly on ${v.daysOfWeek.join(', ') || '?'}` : v.recurrence === 'daily' ? ', every day' : ''
  const hours = v.hours ? `, ${v.hours.from}–${v.hours.to}` : ''
  const condition = v.condition ? `, while ${v.condition.metric.toUpperCase()} ${SIGN[v.condition.comparison as keyof typeof SIGN] ?? v.condition.comparison} ${v.condition.threshold}` : ''
  return `+${v.increasePct ?? '?'} % ${when}${repeat}${hours}${condition}${v.state === 'paused' ? ' (paused)' : ''}`
}

/** The rule as a read shows it. */
const shown = (r: SdBudgetRule) => ({ ruleId: r.ruleId, ...valuesOf(r), amazonStatus: r.ruleStatus, says: ruleWords(valuesOf(r)) })

/** The campaigns a rule is on (Amazon's pages, at most CAMPAIGN_PAGES), named as Nexus knows them. */
async function campaignsOfRule(m: SdMarket, ruleId: string) {
  const found: Array<{ externalCampaignId: string; name: string | null; ruleStatus: string | null }> = []
  let token: string | null = null
  let pages = 0
  do {
    const page = await sdBudgetRuleCampaigns(m.ctx, ruleId, token)
    found.push(...page.campaigns.map((c) => ({ externalCampaignId: c.campaignId, name: c.name, ruleStatus: c.ruleStatus })))
    token = page.nextToken
    pages++
  } while (token && pages < CAMPAIGN_PAGES)
  const nexus = await nexusCampaignsByAmazonId(m.market, found.map((c) => c.externalCampaignId))
  return {
    campaigns: found.map((c) => ({ ...c, campaignId: nexus.get(c.externalCampaignId)?.campaignId ?? null, name: nexus.get(c.externalCampaignId)?.name ?? c.name })),
    more: !!token,
  }
}

// ── sd-budget-rules (read) ────────────────────────────────────────────────────────────────────────────────────────

const readInput = z.object({
  market: sdMarketArg.optional().describe('the Amazon market as business-overview lists it (IT, DE, FR, ES, UK, …): its budget rules. Not needed with campaignId'),
  ruleId: sdIdArg.optional().describe("only this rule (Amazon's budget rule id), with the campaigns it is on"),
  campaignId: sdIdArg.optional().describe("only the rules on this Sponsored Display campaign (Nexus's id, from ad-campaigns)"),
  nextToken: z.string().trim().min(1).max(2000).optional().describe("the market's next page: the nextToken of the previous answer"),
})

const sdBudgetRules: AgentTool = {
  name: 'sd-budget-rules',
  title: 'Sponsored Display budget rules',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: readInput,
  description:
    "Amazon's own budget rules for Sponsored Display campaigns, read live from Amazon: a market's rules (30 a page, "
    + 'nextToken for more), one rule with the campaigns it is on (ruleId), or the rules on one campaign (campaignId, '
    + "Nexus's id). Per rule: ruleId (what set-sd-budget-rule takes), name, type (schedule or performance), state (active / "
    + "paused), Amazon's status, the raise (+N % on top of the daily budget Amazon holds), its dates or Amazon event, days "
    + 'of the week, hours of the day and performance condition, in one line (says). A budget rule only raises a budget, and '
    + "it stacks with Nexus's own budget tools (set-campaign-budget, budget schedules, pools). Nothing is asked in sandbox mode.",
  async handler(args) {
    const a = args as z.infer<typeof readInput>
    let campaign: SdCampaign | null = null
    if (a.campaignId) {
      const c = await sdCampaignOf(a.campaignId)
      if ('refusal' in c) return { ok: false, error: c.refusal }
      campaign = c
    }
    const market = campaign?.market ?? a.market
    if (!market) return { ok: false, error: 'Name the market (market) or a campaign (campaignId).' }
    const m = await sdMarketOf(market)
    if ('refusal' in m) return { ok: false, error: m.refusal }
    const sandbox = sandboxRead()
    if (sandbox) return sandbox
    return sdAnswered('', async () => {
      if (campaign) {
        const rules = await sdCampaignBudgetRules(m.ctx, campaign.externalCampaignId)
        return {
          ok: true,
          data: {
            market: m.market, campaign: { campaignId: campaign.campaignId, name: campaign.name, dailyBudgetCents: campaign.dailyBudgetCents, currency: campaign.currency },
            rules: rules.map(shown),
            ...(rules.length ? {} : { empty: `Campaign ${quote(campaign.name)} has no Amazon budget rule.` }),
          },
        }
      }
      if (a.ruleId) {
        const rule = await getSdBudgetRule(m.ctx, a.ruleId)
        if (!rule) return { ok: true, data: { market: m.market, rules: [], empty: `Amazon holds no budget rule ${a.ruleId} on this market's profile.` } }
        const on = await campaignsOfRule(m, a.ruleId)
        return { ok: true, data: { market: m.market, rules: [{ ...shown(rule), campaigns: on.campaigns, ...(on.more ? { more: `It is on more than ${on.campaigns.length} campaigns: the first are listed.` } : {}) }] } }
      }
      const page = await listSdBudgetRules(m.ctx, a.nextToken ?? null)
      return {
        ok: true,
        data: {
          market: m.market, rules: page.rules.map(shown),
          ...(page.nextToken ? { nextToken: page.nextToken, more: 'There are more: ask again with this nextToken.' } : {}),
          ...(page.rules.length ? {} : { empty: `No Sponsored Display budget rule on ${m.market}'s profile.` }),
        },
      }
    })
  },
}

// ── sd-budget-insights (read) ─────────────────────────────────────────────────────────────────────────────────────

const MAX_INSIGHT_CAMPAIGNS = 100
const insightInput = z.object({
  market: sdMarketArg.optional().describe('the Amazon market (IT, DE, …): its Sponsored Display campaigns Nexus holds (not archived), the first 100 by name. Not needed with campaignIds'),
  campaignIds: z.array(sdIdArg).min(1).max(MAX_INSIGHT_CAMPAIGNS).optional().describe("only these Sponsored Display campaigns (Nexus's ids, from ad-campaigns), all in one market"),
})

const sdBudgetInsights: AgentTool = {
  name: 'sd-budget-insights',
  title: 'Sponsored Display budget insights',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: { suggestedBudgetCents: ADSPEND, missedSalesLowCents: ADSPEND, missedSalesHighCents: ADSPEND, amazonBudgetCents: ADSPEND, dailyBudgetCents: ADSPEND },
  input: insightInput,
  description:
    "Amazon's budget recommendation and today's budget usage for Sponsored Display campaigns, read live from Amazon (two "
    + 'reads that change nothing). Per campaign: its daily budget in Nexus; Amazon\'s recommended daily budget (to stay in '
    + 'budget all day), the share of the last 7 days it was in budget and the impressions, viewable impressions, clicks and '
    + 'sales it missed (low – high estimates); and the % of today\'s budget used, with Amazon\'s budget and the time of its '
    + "reading (current: false when Amazon has not measured since today's 00:00 UTC reset). Amounts are minor units of "
    + 'the campaign\'s currency. Amazon\'s refusal for a campaign is said in its words. Nothing is asked in sandbox mode. '
    + 'Change a budget with set-campaign-budget, or add an Amazon budget rule with set-sd-budget-rule.',
  async handler(args) {
    const a = args as z.infer<typeof insightInput>
    let campaigns: SdCampaign[]
    if (a.campaignIds?.length) {
      campaigns = []
      for (const id of [...new Set(a.campaignIds)]) {
        const c = await sdCampaignOf(id)
        if ('refusal' in c) return { ok: false, error: c.refusal }
        campaigns.push(c)
      }
      const markets = [...new Set(campaigns.map((c) => c.market))]
      if (markets.length > 1) return { ok: false, error: `These campaigns are in ${markets.join(', ')}: ask for one market at a time.` }
      if (a.market && a.market !== markets[0]) return { ok: false, error: `These campaigns are in ${markets[0]}, not ${a.market}.` }
    } else {
      if (!a.market) return { ok: false, error: 'Name the market (market) or the campaigns (campaignIds).' }
      campaigns = []
    }
    const market = campaigns[0]?.market ?? a.market!
    const m = await sdMarketOf(market)
    if ('refusal' in m) return { ok: false, error: m.refusal }
    if (!a.campaignIds?.length) campaigns = await sdCampaignsIn(m.market, MAX_INSIGHT_CAMPAIGNS)
    if (!campaigns.length) return { ok: true, data: { market: m.market, campaigns: [], empty: `Nexus holds no Sponsored Display campaign with an Amazon id in ${m.market}.` } }
    const sandbox = sandboxRead()
    if (sandbox) return sandbox
    return sdAnswered('', async () => {
      const ids = campaigns.map((c) => c.externalCampaignId)
      const [recs, use] = await Promise.all([sdBudgetRecommendations(m.ctx, ids), sdBudgetUsage(m.ctx, ids)])
      const recOf = new Map(recs.recommendations.map((r) => [r.campaignId, r]))
      const useOf = new Map(use.usage.map((u) => [u.campaignId, u]))
      const recError = new Map(recs.errors.map((e) => [e.campaignId, e.error]))
      const useError = new Map(use.errors.map((e) => [e.campaignId, e.error]))
      const dayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
      return {
        ok: true,
        data: {
          market: m.market,
          campaigns: campaigns.map((c) => {
            const r = recOf.get(c.externalCampaignId)
            const u = useOf.get(c.externalCampaignId)
            return {
              campaignId: c.campaignId, name: c.name, status: c.status, currency: c.currency, dailyBudgetCents: c.dailyBudgetCents,
              recommendation: r
                ? {
                  suggestedBudgetCents: centsOf(r.suggestedBudget), percentTimeInBudget: r.percentTimeInBudget, from: r.window.from, to: r.window.to,
                  missedImpressions: r.missed.impressions, missedViewableImpressions: r.missed.viewableImpressions, missedClicks: r.missed.clicks,
                  missedSalesLowCents: centsOf(r.missed.sales.low), missedSalesHighCents: centsOf(r.missed.sales.high),
                }
                : { error: recError.get(c.externalCampaignId) ?? 'Amazon gave no recommendation for it.' },
              usage: u
                ? { usedPct: u.usedPercent, amazonBudgetCents: centsOf(u.budget), asOf: u.asOf, current: u.asOf ? Date.parse(u.asOf) >= dayStart : false }
                : { error: useError.get(c.externalCampaignId) ?? 'Amazon gave no usage for it.' },
            }
          }),
        },
      }
    })
  },
}

// ── set-sd-budget-rule (change) ───────────────────────────────────────────────────────────────────────────────────

const OPS = ['create', 'update', 'attach', 'detach'] as const
type Op = (typeof OPS)[number]

const input = z.object({
  op: z.enum(OPS).describe('create: a new rule (market, name, type, increasePct, startDate …; campaignId puts it on that campaign at once); update: its values or state (market, ruleId); attach: a rule on a campaign (campaignId, ruleId); detach: a rule off a campaign (campaignId, ruleId)'),
  market: sdMarketArg.optional().describe("create, update: the Amazon market (IT, DE, …) whose profile holds the rule; attach and detach take the campaign's"),
  ruleId: sdIdArg.optional().describe("update, attach, detach: Amazon's budget rule id (sd-budget-rules)"),
  campaignId: sdIdArg.optional().describe("attach, detach (and create, to put the new rule on it): the Sponsored Display campaign, Nexus's id (ad-campaigns)"),
  name: z.string().trim().min(1).max(355).optional().describe('create: the rule\'s name (unique on each campaign it is on); update: a new name'),
  type: z.enum(['schedule', 'performance']).optional().describe('create: schedule (raises on its dates, days and hours) or performance (raises while its condition holds)'),
  increasePct: z.coerce.number().positive().max(1000).optional().describe('create (update: a new one): the raise, in % on top of the daily budget Amazon holds while the rule applies (Amazon refuses what it does not take)'),
  startDate: isoDateArg.optional().describe('create (update: a new one): the first day, YYYY-MM-DD, today or later'),
  endDate: isoDateArg.optional().describe('create (update: a new one): the last day, YYYY-MM-DD (none: no end)'),
  recurrence: z.enum(['daily', 'weekly']).optional().describe('create (update: a new one): every day, or weekly on daysOfWeek'),
  daysOfWeek: z.array(z.enum(DAYS)).min(1).max(7).optional().describe('weekly: the days it raises the budget'),
  hours: z.object({
    from: HHMM.describe('the start, HH:MM (24 hours, the market\'s time as Amazon applies it)'),
    to: HHMM.describe('the end, HH:MM, after from'),
  }).optional().describe('create (update: new ones): the hours of the day it raises the budget (one window)'),
  condition: z.object({
    metric: z.enum(METRICS).describe('acos, ctr, cvr or roas: measured by Amazon over the last 7 days (sellers)'),
    comparison: z.enum(COMPARISONS).describe('greater-than, greater-or-equal, less-than or less-or-equal'),
    threshold: z.coerce.number().min(0).max(100_000).describe('the threshold: a percent for acos, ctr and cvr (e.g. 25), a ratio for roas (e.g. 4)'),
  }).optional().describe('performance (create; update: a new one): when the rule raises the budget'),
  state: z.enum(['active', 'paused']).optional().describe('update: switch the rule on or off (paused raises nothing)'),
  why: sdWhyArg,
})
type Args = z.infer<typeof input>

interface Plan {
  op: Op
  market: SdMarket
  ruleId: string | null
  from: BudgetValues | null
  to: BudgetValues | null
  /** The rule's details as Amazon holds them (update: the base the change is laid on; sent back whole). */
  details: Record<string, unknown> | null
  campaign: SdCampaign | null
}

const refuse = (error: string): { result: ToolResult; plan: null } => ({ result: { ok: false, error }, plan: null })

/** The values asked, laid on the rule's own (an update), checked as Amazon checks them; or why not. */
function valuesAsked(a: Args, base: BudgetValues | null): BudgetValues | { refusal: string } {
  const recurrence = a.recurrence ?? base?.recurrence ?? null
  const v: BudgetValues = {
    name: a.name ?? base?.name ?? null,
    type: a.type ?? base?.type ?? null,
    state: a.state ?? (base ? base.state : 'active'),
    increasePct: a.increasePct ?? base?.increasePct ?? null,
    startDate: a.startDate ?? base?.startDate ?? null,
    endDate: a.endDate ?? base?.endDate ?? null,
    event: base?.event ?? null,
    recurrence,
    daysOfWeek: recurrence === 'weekly' ? [...(a.daysOfWeek ?? base?.daysOfWeek ?? [])] : [],
    hours: a.hours ?? base?.hours ?? null,
    condition: a.condition ? { metric: a.condition.metric, comparison: a.condition.comparison, threshold: a.condition.threshold } : base?.condition ?? null,
  }
  const no = (why: string) => ({ refusal: `Not queued: ${why} ${NOTHING_QUEUED}` })
  if (!v.name || !v.type || v.increasePct == null) return no('a budget rule needs a name, a type and increasePct.')
  if (!v.event && !v.startDate) return no('a budget rule needs startDate (YYYY-MM-DD).')
  for (const d of [v.startDate, v.endDate]) if (d && !realDay(d)) return no(`${d} is not a real date.`)
  if (a.startDate && a.startDate < todayIso()) return no(`Amazon starts a rule today or later, not on ${a.startDate}.`)
  if (v.startDate && v.endDate && v.endDate < v.startDate) return no(`its endDate ${v.endDate} is before its startDate ${v.startDate}.`)
  if (a.endDate && a.endDate < todayIso()) return no(`its endDate ${a.endDate} is in the past.`)
  if (a.daysOfWeek && recurrence !== 'weekly') return no('daysOfWeek is for a weekly rule (recurrence weekly).')
  if (recurrence === 'weekly' && !v.daysOfWeek.length) return no('a weekly rule needs daysOfWeek.')
  if (v.hours && v.hours.to <= v.hours.from) return no(`its hours end (${v.hours.to}) must be after their start (${v.hours.from}).`)
  if (v.type === 'performance' && !v.condition) return no('a performance rule needs condition (metric, comparison, threshold).')
  if (v.type === 'schedule' && v.condition) return no('a schedule rule takes no condition (that is a performance rule).')
  return v
}

/** SDBudgetRuleDetails for these values, laid on the rule's own details (an update keeps what Nexus does not set). */
function detailsOf(v: BudgetValues, base: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) }
  out.name = v.name
  out.ruleType = v.type!.toUpperCase()
  out.budgetIncreaseBy = { type: 'PERCENT', value: v.increasePct }
  if (!v.event) out.duration = { dateRangeTypeRuleDuration: { startDate: amazonDay(v.startDate!), ...(v.endDate ? { endDate: amazonDay(v.endDate) } : {}) } }
  if (v.recurrence) {
    out.recurrence = {
      type: v.recurrence.toUpperCase(),
      ...(v.recurrence === 'weekly' ? { daysOfWeek: v.daysOfWeek.map((d) => d.toUpperCase()) } : {}),
      ...(v.hours ? { intraDaySchedule: [{ startTime: `${v.hours.from}:00`, endTime: `${v.hours.to}:00` }] } : {}),
    }
  } else delete out.recurrence
  if (v.condition) {
    out.performanceMeasureCondition = { metricName: v.condition.metric.toUpperCase(), comparisonOperator: AMAZON_COMPARISON[v.condition.comparison as keyof typeof AMAZON_COMPARISON] ?? v.condition.comparison, threshold: v.condition.threshold }
  } else delete out.performanceMeasureCondition
  return out
}

/** Whether moving a rule from → to can let it raise more (fail closed: any change of when it applies counts). */
function loosens(from: BudgetValues, to: BudgetValues): string | null {
  if (from.state === 'paused' && to.state === 'active') return 'it is switched on again'
  if (to.state === 'paused') return null
  if ((to.increasePct ?? 0) > (from.increasePct ?? 0)) return `its raise goes up from +${from.increasePct} % to +${to.increasePct} %`
  if ((to.startDate ?? '') < (from.startDate ?? '') || (from.endDate && (!to.endDate || to.endDate > from.endDate))) return 'its dates widen'
  if (canonical([from.recurrence, from.daysOfWeek, from.hours, from.condition]) !== canonical([to.recurrence, to.daysOfWeek, to.hours, to.condition])) {
    return 'when it applies changes (days, hours or condition): it may raise more often'
  }
  return null
}

/** The general clash between Amazon's rule and Nexus's own budget writers. */
const CLASH = "Amazon's budget rule raises the daily budget Amazon holds while it applies, on top of whatever Nexus writes there "
  + '(set-campaign-budget, a budget schedule, a budget pool, budget pacing): the two stack — a Nexus window that raises the '
  + 'budget is raised again by the rule, and a Nexus give-back or rebalance moves the base the rule raises. Nexus never '
  + "writes the rule's raise, so its own brakes (spend ceilings, the day's budget move limit) do not count it."

/** What else moves these campaigns' budgets in Nexus, one sentence each (at most 10 campaigns). */
async function nexusBudgetWriters(campaigns: ReadonlyArray<{ campaignId: string | null; name: string | null }>): Promise<string[]> {
  const known = campaigns.filter((c): c is { campaignId: string; name: string | null } => !!c.campaignId).slice(0, 10)
  if (!known.length) return []
  const engines = await budgetEnginesOf(known.map((c) => c.campaignId))
  const lines: string[] = []
  for (const c of known) {
    const e = engines.get(c.campaignId)
    const bound = await boundAutomationsFor(c.campaignId)
    const by = [
      ...(e?.schedules ?? []).map((s) => `budget schedule ${quote(s.name)}`),
      ...(e?.pool ? [`budget pool ${quote(e.pool.name)}`] : []),
      ...bound.map((b) => `${b.kind === 'rule' ? 'rule' : 'schedule'} ${quote(b.name)}`),
    ]
    if (by.length) lines.push(`Campaign ${quote(c.name)}: Nexus's ${by.join(', ')} also change${by.length === 1 ? 's' : ''} it — they stack with Amazon's rule.`)
  }
  return lines
}

async function decide(raw: Record<string, unknown>): Promise<{ result: ToolResult; plan: Plan | null }> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a = parsed.data
  const ruleFields = ['name', 'type', 'increasePct', 'startDate', 'endDate', 'recurrence', 'daysOfWeek', 'hours', 'condition', 'state'] as const
  const asked = ruleFields.filter((k) => a[k] !== undefined)
  if ((a.op === 'attach' || a.op === 'detach') && (!a.campaignId || !a.ruleId)) return refuse(`Not queued: op ${a.op} needs campaignId (Nexus's id) and ruleId. ${NOTHING_QUEUED}`)
  if ((a.op === 'attach' || a.op === 'detach') && asked.length) return refuse(`Not queued: op ${a.op} takes no rule values (${asked.join(', ')}). ${NOTHING_QUEUED}`)
  if (a.op === 'update' && !a.ruleId) return refuse(`Not queued: op update needs ruleId (sd-budget-rules). ${NOTHING_QUEUED}`)
  if (a.op === 'update' && a.campaignId) return refuse(`Not queued: op update changes the rule on every campaign it is on and takes no campaignId. ${NOTHING_QUEUED}`)
  if (a.op === 'update' && !asked.length) return refuse(`Nothing to change: give the values to change, or state. ${NOTHING_QUEUED}`)
  if (a.op === 'create' && a.ruleId) return refuse(`Not queued: op create makes a new rule and names no ruleId (op update changes one). ${NOTHING_QUEUED}`)
  if (a.op === 'create' && a.state) return refuse(`Not queued: a new rule is made active; pause it with op update. ${NOTHING_QUEUED}`)
  if (a.op === 'update' && a.type) return refuse(`Not queued: a rule's type stays as it was made; make a new rule for the other type. ${NOTHING_QUEUED}`)

  // Where: the campaign (its market), or the market named. Found first: another business's is "not found".
  let campaign: SdCampaign | null = null
  if (a.campaignId) {
    const c = await sdCampaignOf(a.campaignId)
    if ('refusal' in c) return refuse(`Not queued: ${c.refusal} ${NOTHING_QUEUED}`)
    campaign = c
    if (a.market && a.market !== c.market) return refuse(`Not queued: campaign ${quote(c.name)} is in ${c.market}, not ${a.market}. ${NOTHING_QUEUED}`)
    if (c.status === 'ARCHIVED') return refuse(`Not queued: campaign ${quote(c.name)} is archived. ${NOTHING_QUEUED}`)
  }
  const marketCode = campaign?.market ?? a.market
  if (!marketCode) return refuse(`Not queued: op ${a.op} needs market (IT, DE, …). ${NOTHING_QUEUED}`)
  const m = await sdMarketOf(marketCode)
  if ('refusal' in m) return refuse(`Not queued: ${m.refusal} ${NOTHING_QUEUED}`)
  const landed = await sdReach(m.market)
  if ('refusal' in landed) return refuse(landed.refusal.startsWith('Not queued') ? landed.refusal : `Not queued: ${landed.refusal}`)

  let plan: Plan
  let onCampaigns: Array<{ campaignId: string | null; name: string | null; externalCampaignId: string }> = []
  let moreCampaigns = false
  if (a.op === 'create') {
    const to = valuesAsked(a, null)
    if ('refusal' in to) return refuse(to.refusal)
    plan = { op: 'create', market: m, ruleId: null, from: null, to, details: null, campaign }
  } else {
    const rule = await getSdBudgetRule(m.ctx, a.ruleId!)
    if (!rule) return refuse(`Not queued: budget rule ${a.ruleId} not found on ${m.market}'s Amazon Ads profile. ${NOTHING_QUEUED}`)
    const from = valuesOf(rule)
    if (a.op === 'update') {
      const to = valuesAsked(a, from)
      if ('refusal' in to) return refuse(to.refusal)
      if (canonical(to) === canonical(from)) return refuse(`Nothing would change: rule ${quote(rule.name)} is already ${ruleWords(from)}. ${NOTHING_QUEUED}`)
      const on = await campaignsOfRule(m, rule.ruleId!)
      onCampaigns = on.campaigns
      moreCampaigns = on.more
      plan = { op: 'update', market: m, ruleId: rule.ruleId, from, to, details: rule.details, campaign: null }
    } else {
      plan = { op: a.op, market: m, ruleId: rule.ruleId, from, to: from, details: null, campaign }
    }
  }
  if (plan.campaign) {
    const held = await sdCampaignBudgetRules(m.ctx, plan.campaign.externalCampaignId)
    const label = `campaign ${quote(plan.campaign.name)}`
    if (plan.op === 'detach') {
      if (!held.some((r) => r.ruleId === plan.ruleId)) return refuse(`Nothing would change: rule ${plan.ruleId} is not on ${label}. ${NOTHING_QUEUED}`)
    } else {
      if (plan.ruleId && held.some((r) => r.ruleId === plan.ruleId)) return refuse(`Nothing would change: rule ${quote(plan.from?.name)} is already on ${label}. ${NOTHING_QUEUED}`)
      const same = held.find((r) => (r.name ?? '').trim().toLowerCase() === (plan.to?.name ?? '').trim().toLowerCase())
      if (same) return refuse(`Not queued: ${label} already holds a budget rule named ${quote(same.name)} (ruleId ${same.ruleId}), and Amazon takes one name once per campaign. ${NOTHING_QUEUED}`)
      if (held.length >= MAX_RULES_PER_CAMPAIGN) return refuse(`Not queued: ${label} holds ${held.length} budget rules, Amazon's most. ${NOTHING_QUEUED}`)
    }
    onCampaigns = [{ campaignId: plan.campaign.campaignId, name: plan.campaign.name, externalCampaignId: plan.campaign.externalCampaignId }]
  }
  const writers = plan.op === 'detach' ? [] : await nexusBudgetWriters(onCampaigns)
  return { plan, result: previewOf(plan, landed.reach, onCampaigns, moreCampaigns, writers) }
}

function previewOf(plan: Plan, reach: StoredReach, onCampaigns: ReadonlyArray<{ campaignId: string | null; name: string | null }>, moreCampaigns: boolean, writers: string[]): ToolResult {
  const m = plan.market
  const rule = plan.ruleId ? `${quote(plan.to?.name ?? plan.from?.name)} (${plan.ruleId})` : quote(plan.to?.name)
  const label = plan.campaign ? `campaign ${quote(plan.campaign.name)}` : null
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const raises: string[] = []
  const warnings: string[] = []
  let summary: string
  if (plan.op === 'create') {
    changes['budget rule'] = { from: null, to: `${quote(plan.to!.name)}: ${ruleWords(plan.to)}` }
    if (label) {
      changes[`budget rules on ${label}`] = { from: '(without it)', to: `+ ${quote(plan.to!.name)}` }
      raises.push(`${label}'s daily budget rises by ${plan.to!.increasePct} % ${plan.to!.type === 'performance' ? 'while its condition holds' : 'on the rule\'s dates, days and hours'}`)
    }
    summary = `Creates the Sponsored Display budget rule ${quote(plan.to!.name)} in ${m.market}: ${ruleWords(plan.to)}${label ? `, and puts it on ${label}` : '. It is on no campaign yet, so it raises no budget until it is attached'}.`
  } else if (plan.op === 'update') {
    const f = plan.from!, t = plan.to!
    if (f.name !== t.name) changes['rule name'] = { from: f.name, to: t.name }
    if (f.state !== t.state) changes['rule state'] = { from: f.state, to: t.state }
    const { name: _fn, state: _fs, ...fRest } = f
    const { name: _tn, state: _ts, ...tRest } = t
    if (canonical(fRest) !== canonical(tRest)) changes['budget rule'] = { from: ruleWords({ ...f, state: null }), to: ruleWords({ ...t, state: null }) }
    const looser = loosens(f, t)
    if (looser && (onCampaigns.length || moreCampaigns)) raises.push(`${looser}: it raises the daily budget of ${onCampaigns.length ? plural(onCampaigns.length, 'campaign') : 'the campaigns it is on'} more`)
    if (onCampaigns.length) warnings.push(`It is on ${onCampaigns.map((c) => quote(c.name)).join(', ')}${moreCampaigns ? ' and more' : ''}: the change applies to each.`)
    else warnings.push('It is on no campaign: it raises no budget now.')
    summary = `Changes the Sponsored Display budget rule ${rule} in ${m.market}: ${Object.entries(changes).map(([k, v]) => `${k} ${v.from} → ${v.to}`).join('; ')}.`
  } else if (plan.op === 'attach') {
    changes[`budget rules on ${label}`] = { from: '(without it)', to: `+ ${rule}: ${ruleWords(plan.to)}` }
    if (plan.to!.state === 'paused') warnings.push(`The rule is paused: it raises nothing on ${label} until it is switched on (op update, state active).`)
    else raises.push(`${label}'s daily budget rises by ${plan.to!.increasePct} % ${plan.to!.type === 'performance' ? 'while the condition holds' : 'on the rule\'s dates, days and hours'}`)
    summary = `Puts the budget rule ${rule} (${ruleWords(plan.to)}) on ${label} in ${m.market}.`
  } else {
    changes[`budget rules on ${label}`] = { from: `with ${rule}`, to: '(without it)' }
    summary = `Takes the budget rule ${rule} off ${label} in ${m.market}: Amazon no longer raises its budget by it.`
  }
  if (plan.op !== 'detach' && (onCampaigns.length || plan.op === 'create')) warnings.push(CLASH, ...writers)
  const effect = `${summary}${addsSpendWords(raises, false)}`
  return {
    ok: true,
    preview: {
      action: TOOL,
      op: plan.op,
      market: m.market,
      rule: plan.from ? { ruleId: plan.ruleId, ...plan.from } : null,
      ...(plan.campaign ? { campaign: { campaignId: plan.campaign.campaignId, name: plan.campaign.name, dailyBudgetCents: plan.campaign.dailyBudgetCents, currency: plan.campaign.currency } } : {}),
      ...(plan.op === 'update' ? { onCampaigns } : {}),
      summary,
      changes,
      raises,
      noCode: raises.length ? DAY_TO_DAY_NO_CODE : ADDS_NO_SPEND,
      ...(warnings.length ? { warnings } : {}),
      basis: basisOf({ op: plan.op, ruleId: plan.ruleId, from: plan.from, to: plan.to, details: plan.details, campaign: plan.campaign?.campaignId ?? null, on: onCampaigns.map((c) => c.campaignId) }),
      reach,
      reachNote: sdReachNote(reach),
      effect,
      undoNote: plan.op === 'create'
        ? plan.campaign ? 'Undo takes the rule off the campaign (op detach). Amazon has no way to delete a rule.' : 'Undo pauses the rule (Amazon has no way to delete one).'
        : plan.op === 'update' ? 'Undo puts the rule\'s old values and state back (op update).'
          : plan.op === 'attach' ? 'Undo takes it off the campaign again (op detach).' : 'Undo puts it back on the campaign (op attach).',
    },
  }
}

/** What a change of this tool records: the market, the rule and its values, the campaign and whether the rule is on it. */
interface BudgetRecord { op: Op; market: string; ruleId: string | null; rule: BudgetValues | null; campaignId: string | null; attached: boolean | null }

/** C2 — undo: a new rule comes off the campaign it was put on (or is paused); an update is put back; attach ⇄ detach. */
export const SET_SD_BUDGET_RULE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as BudgetRecord
    if (!after.market || !after.ruleId) return change.after
    try {
      const m = await sdMarketOf(after.market)
      if ('refusal' in m) return { ...after, unreadable: m.refusal }
      const now: BudgetRecord = { ...after }
      if (after.rule) {
        const rule = await getSdBudgetRule(m.ctx, after.ruleId)
        now.rule = rule ? valuesOf(rule) : null
      }
      if (after.attached != null && after.campaignId) {
        const c = await sdCampaignOf(after.campaignId)
        if ('refusal' in c) return { ...after, unreadable: c.refusal }
        now.attached = (await sdCampaignBudgetRules(m.ctx, c.externalCampaignId)).some((r) => r.ruleId === after.ruleId)
      }
      return now
    } catch (error) {
      return { ...after, unreadable: error instanceof Error ? error.message : String(error) }
    }
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<BudgetRecord>
    const after = (change.after ?? {}) as Partial<BudgetRecord>
    if (!after.ruleId || !after.market) return { refusal: 'This change does not name the budget rule it made or changed.' }
    const why = `undo of an earlier Sponsored Display budget rule change (${after.op ?? '?'})`
    if (after.op === 'create') {
      if (after.attached === true && after.campaignId) return { tool: TOOL, args: { op: 'detach', campaignId: after.campaignId, ruleId: after.ruleId, why } }
      return { tool: TOOL, args: { op: 'update', market: after.market, ruleId: after.ruleId, state: 'paused', why } }
    }
    if (after.op === 'update') {
      const was = before.rule
      const is = after.rule
      if (!was || !is) return { refusal: 'This change does not record the rule as it was before.' }
      const args: Record<string, unknown> = { op: 'update', market: after.market, ruleId: after.ruleId, why }
      if (was.name !== is.name && was.name) args.name = was.name
      if (was.state !== is.state && was.state) args.state = was.state
      if (was.increasePct !== is.increasePct && was.increasePct != null) args.increasePct = was.increasePct
      if (was.startDate !== is.startDate && was.startDate) args.startDate = was.startDate
      if (was.endDate !== is.endDate && was.endDate) args.endDate = was.endDate
      if (was.recurrence !== is.recurrence && was.recurrence) args.recurrence = was.recurrence
      if (canonical(was.daysOfWeek) !== canonical(is.daysOfWeek) && was.daysOfWeek.length) args.daysOfWeek = was.daysOfWeek
      if (canonical(was.hours) !== canonical(is.hours) && was.hours) args.hours = was.hours
      if (canonical(was.condition) !== canonical(is.condition) && was.condition) args.condition = was.condition
      if (Object.keys(args).length === 4) return { refusal: 'What this change replaced cannot be set back here (it removed an end date, days, hours or a condition): change the rule with set-sd-budget-rule op update.' }
      return { tool: TOOL, args }
    }
    if (!after.campaignId) return { refusal: 'This change does not name the campaign.' }
    return { tool: TOOL, args: { op: after.op === 'attach' ? 'detach' : 'attach', campaignId: after.campaignId, ruleId: after.ruleId, why } }
  },
}

async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { result: fresh, plan } = await decide(args)
  const refusal = recheck(ctx, fresh, ['basis'])
  if (refusal || !plan) return notRun(refusal ?? `Not run: it is no longer a valid change. ${NOTHING_CHANGED}`)
  const p = fresh.preview as { effect: string; reach: StoredReach }
  const approved = approvedRun(ctx, String((args as Args).why ?? '') || p.effect)
  if ('refusal' in approved) return notRun(`Not run: ${approved.refusal}. ${NOTHING_CHANGED}`)
  const { ctx: client, market } = plan.market
  const base = { market, ruleId: plan.ruleId, campaignId: plan.campaign?.campaignId ?? null }
  const done = (data: Record<string, unknown>, before: BudgetRecord, after: BudgetRecord): ToolResult =>
    ({ ok: true, data: { op: plan.op, market, reach: p.reach, changeSetId: approved.changeSetId, ...data }, change: { before, after } })

  if (plan.op === 'create') {
    const made = await createSdBudgetRule(client, detailsOf(plan.to!, null))
    if (!made.ok) return notRun(`Not run: ${made.error} ${NOTHING_CHANGED}`)
    const ruleId = made.id!
    let attached: boolean | null = null
    let note: string | null = null
    if (plan.campaign) {
      try {
        const on = await attachSdBudgetRule(client, plan.campaign.externalCampaignId, ruleId)
        attached = on.ok
        if (!on.ok) note = `The rule was made (ruleId ${ruleId}) but not put on campaign ${quote(plan.campaign.name)}: ${on.error} Ask for op attach again.`
      } catch (error) {
        attached = false
        note = `The rule was made (ruleId ${ruleId}) but not put on campaign ${quote(plan.campaign.name)}: ${error instanceof Error ? error.message : String(error)} Ask for op attach again.`
      }
    }
    return done(
      { ruleId, name: plan.to!.name, ...(plan.campaign ? { campaignId: plan.campaign.campaignId, attached } : {}), ...(note ? { note } : {}) },
      { op: 'create', ...base, ruleId: null, rule: null, attached: plan.campaign ? false : null },
      { op: 'create', ...base, ruleId, rule: plan.to, attached },
    )
  }
  if (plan.op === 'update') {
    const out = await updateSdBudgetRule(client, plan.ruleId!, plan.to!.state === 'paused' ? 'PAUSED' : 'ACTIVE', detailsOf(plan.to!, plan.details))
    if (!out.ok) return notRun(`Not run: ${out.error} ${NOTHING_CHANGED}`)
    return done({ ruleId: plan.ruleId, rule: plan.to }, { op: 'update', ...base, rule: plan.from, attached: null }, { op: 'update', ...base, rule: plan.to, attached: null })
  }
  const campaign = plan.campaign!
  const out = plan.op === 'attach'
    ? await attachSdBudgetRule(client, campaign.externalCampaignId, plan.ruleId!)
    : await detachSdBudgetRule(client, campaign.externalCampaignId, plan.ruleId!)
  if (!out.ok) return notRun(`Not run: ${out.error} ${NOTHING_CHANGED}`)
  const attachedNow = plan.op === 'attach'
  return done({ ruleId: plan.ruleId, campaignId: campaign.campaignId, attached: attachedNow }, { op: plan.op, ...base, rule: null, attached: !attachedNow }, { op: plan.op, ...base, rule: null, attached: attachedNow })
}

const setSdBudgetRule: AgentTool = {
  name: TOOL,
  title: 'Change a Sponsored Display budget rule',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A rule cannot be deleted at Amazon: a new one is undone by taking it off its campaign, or by pausing it.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: SET_SD_BUDGET_RULE_UNDO,
  description:
    'Create, change, attach or detach an Amazon budget rule on Sponsored Display campaigns, live at Amazon. A budget rule '
    + 'raises a campaign\'s daily budget by a percent while it applies: a schedule rule from its start date (to an end '
    + 'date), every day or on days of the week, optionally in one window of hours; a performance rule while ACOS, CTR, CVR '
    + 'or ROAS passes a threshold. op create: a new rule in a market (campaignId also puts it on that campaign); op update: '
    + 'its name, raise, dates, days, hours, condition or state (active / paused) — it applies on every campaign it is on; op '
    + 'attach / detach: a rule on or off a campaign. Amazon has no delete (pause it, or take it off). Rules tied to an '
    + 'Amazon event are not made here (the Sponsored Display API gives no event ids). Every raise is listed in raises (ADDS '
    + "SPEND), and the preview says how the rule stacks with Nexus's own budget tools (set-campaign-budget, budget schedules, "
    + 'pools, pacing) and names those on each campaign. A person approves it in Nexus; the preview shows each value from → '
    + 'to and where it lands (live at Amazon on which profile; in sandbox mode it is not queued), and it is sent to Amazon '
    + "at once when approved. Amazon's refusal is passed on in its own words. Undo: an update is put back, attach ⇄ detach, "
    + 'and a new rule taken off its campaign (or paused).',
  async handler(args) {
    return sdAnswered(NOTHING_QUEUED, async () => (await decide(args)).result)
  },
  async execute(args, ctx) {
    return sdAnswered(NOTHING_CHANGED, () => run(args, ctx))
  },
}

export const ADS_SD_BUDGET_RULE_TOOLS: AgentTool[] = [sdBudgetRules, sdBudgetInsights, setSdBudgetRule]
