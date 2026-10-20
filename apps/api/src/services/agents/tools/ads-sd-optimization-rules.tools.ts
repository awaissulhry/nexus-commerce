/**
 * Sponsored Display extras (P3c) — Amazon's optimization rules for Sponsored Display ("cost control": a target cost per
 * order, per click or per 1,000 viewable impressions on an ad group; Amazon then sets the bids), read and changed live at
 * Amazon through advertising/sd/sd-rules.client.ts (the channel gateway). Nexus keeps no copy: Amazon's rules are the record.
 *
 *   sd-optimization-rules       read: a market's rules, one rule, or the rule on one ad group; optionally which of the
 *                               market's ad groups each rule is on (one Amazon read per ad group).
 *   set-sd-optimization-rule    create   a rule (name, metric, limit), optionally put on one ad group in the same request;
 *                               update   its name, metric or limit (Amazon's update replaces the rule's one condition);
 *                               attach   a rule on an ad group (Amazon takes ONE rule per ad group);
 *                               detach   the rule off an ad group (its targets bid their own bids again).
 *
 * Amazon's own limits, checked before anything is queued: a limit of at least 5 (cost per order), 0.5 (cost per click) or
 * 1 (per 1,000 viewable impressions) in the market's currency; the campaign's daily budget at least 5×, 20× or 10× the
 * limit; an ad group with product ads; one rule per ad group. Amazon has no delete and no pause for a rule (its only state
 * is enabled): a rule on no ad group does nothing.
 *
 * Like every ad change tool: a request a person approves (alwaysAsk, ask at most — never by rule; the business's "Claude's
 * changes need no approval" switch applies through the same door), the preview says every value from → to and where it
 * lands (live on which profile; in sandbox mode it is not queued), `execute` reads Amazon again and refuses when what was
 * approved moved, Amazon's refusal reaches the person in its own words, and the change (before → after) is recorded so
 * undo asks for the opposite change. A rule on an ad group overrides its targets' manual bids and may add targets: it is
 * listed in `raises` (ADDS SPEND).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import {
  adGroupSdOptimizationRules, attachSdOptimizationRule, createSdOptimizationRule, detachSdOptimizationRule, getSdOptimizationRule,
  listSdOptimizationRules, SD_RULE_BUDGET_MULTIPLE, SD_RULE_MIN_THRESHOLD, updateSdOptimizationRule,
  type SdOptimizationRule, type SdRuleMetric,
} from '../../advertising/sd/sd-rules.client.js'
import { sdAdGroupOf, sdAdGroupsIn, type SdAdGroup, type SdCampaign } from '../../advertising/sd/sd-entities.js'
import { ADDS_NO_SPEND, addsSpendWords, DAY_TO_DAY_NO_CODE } from './ads-code-rule.js'
import { approvedRun, canonical, notRun, recheck, type StoredReach } from './ads-change-kit.js'
import {
  amountOf, basisOf, centsOf, money, NOTHING_CHANGED, NOTHING_QUEUED, plural, quote, sandboxRead, sdAnswered, sdIdArg, sdMarketArg,
  sdMarketOf, sdReach, sdReachNote, sdWhyArg, type SdMarket,
} from './ads-sd-kit.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'set-sd-optimization-rule'
const ADSPEND = FIELDS.financialsAdspendView
/** The ad groups whose rule is read, one Amazon call each, to say where a rule is used. */
const AD_GROUPS_READ = 25

/** The metric as Claude's tools name it, and Amazon's. */
const METRICS = ['cost-per-order', 'cost-per-click', 'cost-per-1000-viewable-impressions'] as const
type Metric = (typeof METRICS)[number]
const AMAZON_METRIC: Record<Metric, SdRuleMetric> = {
  'cost-per-order': 'COST_PER_ORDER', 'cost-per-click': 'COST_PER_CLICK', 'cost-per-1000-viewable-impressions': 'COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS',
}
const METRIC_OF = Object.fromEntries(Object.entries(AMAZON_METRIC).map(([ours, theirs]) => [theirs, ours])) as Record<string, Metric>
const METRIC_WORDS: Record<Metric, string> = { 'cost-per-order': 'cost per order', 'cost-per-click': 'cost per click', 'cost-per-1000-viewable-impressions': 'cost per 1,000 viewable impressions' }
const metricArg = z.enum(METRICS)

/** A rule's values as these tools hold them: its name, metric and limit (minor units of the market's currency). */
export interface RuleValues { name: string | null; metric: Metric | null; thresholdCents: number | null }
const valuesOf = (r: SdOptimizationRule): RuleValues => ({ name: r.name, metric: r.metric ? METRIC_OF[r.metric] ?? null : null, thresholdCents: centsOf(r.threshold) })
const ruleWords = (v: RuleValues | null, currency: string | null) =>
  v ? `${v.metric ? METRIC_WORDS[v.metric] : 'a metric Nexus does not know'} at most ${money(v.thresholdCents, currency)}` : 'none'
const ruleLabel = (ruleId: string | null, name: string | null | undefined) => (name ? `${quote(name)} (${ruleId ?? 'new'})` : ruleId ?? 'a new rule')

/** A rule as a read shows it. */
const shown = (r: SdOptimizationRule, currency: string | null) => {
  const v = valuesOf(r)
  return { ruleId: r.ruleId, name: r.name, state: r.state, metric: v.metric ?? r.metric, thresholdCents: v.thresholdCents, currency, says: ruleWords(v, currency) }
}

/** Which of these ad groups each rule is on: one Amazon read per ad group. */
async function rulesOnGroups(m: SdMarket, groups: Awaited<ReturnType<typeof sdAdGroupsIn>>['groups']) {
  const out: Array<{ group: (typeof groups)[number]; rules: SdOptimizationRule[] }> = []
  for (const group of groups) out.push({ group, rules: await adGroupSdOptimizationRules(m.ctx, group.externalAdGroupId) })
  return out
}

// ── sd-optimization-rules (read) ──────────────────────────────────────────────────────────────────────────────────

const readInput = z.object({
  market: sdMarketArg.optional().describe('the Amazon market as business-overview lists it (IT, DE, FR, ES, UK, …): its rules. Not needed with adGroupId'),
  ruleId: sdIdArg.optional().describe("only this rule: Amazon's optimization rule id"),
  adGroupId: sdIdArg.optional().describe("only the rule on this Sponsored Display ad group (Nexus's id, from ad-groups)"),
  withAdGroups: z.boolean().default(false)
    .describe(`also say which of the market's Sponsored Display ad groups each rule is on (one Amazon read per ad group, the first ${AD_GROUPS_READ})`),
  startIndex: z.coerce.number().int().min(0).max(100_000).default(0).describe("the market's rules from this position (Amazon's paging, 100 a page)"),
})

const sdOptimizationRules: AgentTool = {
  name: 'sd-optimization-rules',
  title: 'Sponsored Display cost controls',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: { thresholdCents: ADSPEND },
  input: readInput,
  description:
    "Amazon's optimization rules for Sponsored Display (cost control: Amazon bids an ad group to keep its cost per order, "
    + 'per click or per 1,000 viewable impressions at or below a limit), read live from Amazon. A market\'s rules (paged), '
    + 'one rule (ruleId), or the rule on one ad group (adGroupId, Nexus\'s id); withAdGroups also names the market\'s ad '
    + `groups each rule is on (one Amazon read per ad group, the first ${AD_GROUPS_READ}). Per rule: ruleId (what `
    + 'set-sd-optimization-rule takes), name, state (Amazon\'s only state is enabled), metric and limit (minor units of the '
    + "market's currency). Nothing is asked in sandbox mode. Change them with set-sd-optimization-rule.",
  async handler(args) {
    const a = args as z.infer<typeof readInput>
    let group: SdAdGroup | null = null
    let market = a.market ?? null
    if (a.adGroupId) {
      const g = await sdAdGroupOf(a.adGroupId)
      if ('refusal' in g) return { ok: false, error: g.refusal }
      group = g
      market = g.campaign.market
    }
    if (!market) return { ok: false, error: 'Name the market (market) or an ad group (adGroupId).' }
    const m = await sdMarketOf(market)
    if ('refusal' in m) return { ok: false, error: m.refusal }
    const sandbox = sandboxRead()
    if (sandbox) return sandbox
    return sdAnswered('', async () => {
      if (group) {
        const rules = await adGroupSdOptimizationRules(m.ctx, group.externalAdGroupId)
        return {
          ok: true,
          data: {
            market: m.market, adGroup: { adGroupId: group.adGroupId, name: group.name, campaign: group.campaign.name, productAds: group.productAds },
            rules: rules.map((r) => shown(r, m.currency)),
            ...(rules.length ? {} : { empty: `Ad group ${quote(group.name)} has no optimization rule: its targets bid their own bids.` }),
          },
        }
      }
      if (a.ruleId) {
        const rule = await getSdOptimizationRule(m.ctx, a.ruleId)
        return { ok: true, data: { market: m.market, rules: rule ? [shown(rule, m.currency)] : [], ...(rule ? {} : { empty: `Amazon holds no optimization rule ${a.ruleId} on this market's profile.` }) } }
      }
      const rules = await listSdOptimizationRules(m.ctx, { startIndex: a.startIndex, count: 100 })
      let onGroups: Map<string, string[]> | null = null
      let note: string | null = null
      if (a.withAdGroups) {
        const { groups, more } = await sdAdGroupsIn(m.market, AD_GROUPS_READ)
        onGroups = new Map()
        for (const { group: g, rules: on } of await rulesOnGroups(m, groups)) {
          for (const r of on) onGroups.set(r.ruleId, [...(onGroups.get(r.ruleId) ?? []), `${quote(g.name)} (${g.adGroupId}) in ${quote(g.campaign.name)}`])
        }
        note = more ? `Nexus read the rule of the first ${AD_GROUPS_READ} Sponsored Display ad groups of ${m.market}: a rule may be on others too.` : null
      }
      return {
        ok: true,
        data: {
          market: m.market, startIndex: a.startIndex,
          rules: rules.map((r) => ({ ...shown(r, m.currency), ...(onGroups ? { onAdGroups: onGroups.get(r.ruleId) ?? [] } : {}) })),
          ...(rules.length === 100 ? { more: `There may be more: ask again with startIndex ${a.startIndex + 100}.` } : {}),
          ...(note ? { note } : {}),
          ...(rules.length ? {} : { empty: `No Sponsored Display optimization rule on ${m.market}'s profile${a.startIndex ? ' from that position' : ''}.` }),
        },
      }
    })
  },
}

// ── set-sd-optimization-rule (change) ─────────────────────────────────────────────────────────────────────────────

const OPS = ['create', 'update', 'attach', 'detach'] as const
type Op = (typeof OPS)[number]

const input = z.object({
  op: z.enum(OPS).describe('create: a new rule (market, name, metric, thresholdCents; adGroupId puts it on that ad group at once); update: its name, metric or limit (market, ruleId); attach: a rule on an ad group (adGroupId, ruleId); detach: the rule off an ad group (adGroupId)'),
  market: sdMarketArg.optional().describe('create, update: the Amazon market (IT, DE, …) whose profile holds the rule; attach and detach take the ad group\'s'),
  ruleId: sdIdArg.optional().describe("update, attach: Amazon's optimization rule id (sd-optimization-rules); detach: optional, the rule the ad group holds"),
  adGroupId: sdIdArg.optional().describe("attach, detach (and create, to put the new rule on it): the Sponsored Display ad group, Nexus's id (ad-groups)"),
  name: z.string().trim().min(1).max(255).optional().describe('create: the rule\'s name (Nexus refuses a name the market\'s profile already uses); update: a new name'),
  metric: metricArg.optional().describe('create (update: a new one): what Amazon keeps at or below the limit — cost-per-order, cost-per-click or cost-per-1000-viewable-impressions'),
  thresholdCents: z.coerce.number().int().min(1).max(10_000_000).optional()
    .describe("create (update: a new one): the limit, in minor units of the market's currency. Amazon's lowest: 500 (cost per order), 50 (cost per click), 100 (per 1,000 viewable impressions)"),
  why: sdWhyArg,
})
type Args = z.infer<typeof input>

/** What one request decided: its preview, and what `execute` sends. */
interface Plan {
  op: Op
  market: SdMarket
  ruleId: string | null
  from: RuleValues | null
  to: RuleValues | null
  adGroup: SdAdGroup | null
  /** attach / detach: the rule the ad group holds now (detach: the one taken off). */
  onGroup: SdOptimizationRule | null
}

const refuse = (error: string): { result: ToolResult; plan: null } => ({ result: { ok: false, error }, plan: null })

/** Amazon's lowest limit for the metric, in minor units. */
function belowMinimum(v: RuleValues, currency: string | null): string | null {
  if (!v.metric || v.thresholdCents == null) return null
  const min = Math.round(SD_RULE_MIN_THRESHOLD[AMAZON_METRIC[v.metric]] * 100)
  return v.thresholdCents < min ? `Not queued: Amazon's lowest ${METRIC_WORDS[v.metric]} limit is ${money(min, currency)}; ${money(v.thresholdCents, currency)} is below it. ${NOTHING_QUEUED}` : null
}

/** Amazon takes a rule only on a campaign whose daily budget is at least 5× / 20× / 10× its limit. */
function budgetTooSmall(campaign: SdCampaign, v: RuleValues): string | null {
  if (!v.metric || v.thresholdCents == null) return null
  const times = SD_RULE_BUDGET_MULTIPLE[AMAZON_METRIC[v.metric]]
  if (campaign.dailyBudgetCents >= times * v.thresholdCents) return null
  return `Not queued: Amazon takes a ${METRIC_WORDS[v.metric]} limit of ${money(v.thresholdCents, campaign.currency)} only on a campaign whose daily budget `
    + `is at least ${times}× it (${money(times * v.thresholdCents, campaign.currency)}); campaign ${quote(campaign.name)} has ${money(campaign.dailyBudgetCents, campaign.currency)} in Nexus. `
    + `Raise its budget first (set-campaign-budget) or ask for a lower limit. ${NOTHING_QUEUED}`
}

const sameValues = (a: RuleValues | null, b: RuleValues | null) => canonical(a) === canonical(b)

/** The request decided: its preview and plan (the dry run, and again in `execute`). */
async function decide(raw: Record<string, unknown>): Promise<{ result: ToolResult; plan: Plan | null }> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a = parsed.data
  const needsGroup = a.op === 'attach' || a.op === 'detach'
  if (needsGroup && !a.adGroupId) return refuse(`Not queued: op ${a.op} needs adGroupId (Nexus's id, from ad-groups). ${NOTHING_QUEUED}`)
  if (a.op === 'attach' && !a.ruleId) return refuse(`Not queued: op attach needs ruleId (sd-optimization-rules). ${NOTHING_QUEUED}`)
  if (a.op === 'update' && !a.ruleId) return refuse(`Not queued: op update needs ruleId (sd-optimization-rules). ${NOTHING_QUEUED}`)
  if (a.op === 'create' && a.ruleId) return refuse(`Not queued: op create makes a new rule and names no ruleId (op update changes one). ${NOTHING_QUEUED}`)
  if (needsGroup && (a.name || a.metric || a.thresholdCents != null)) return refuse(`Not queued: op ${a.op} takes no name, metric or limit. ${NOTHING_QUEUED}`)
  if (a.op === 'update' && a.adGroupId) return refuse(`Not queued: op update changes the rule wherever it is used and takes no adGroupId. ${NOTHING_QUEUED}`)
  if (a.op === 'create' && (!a.name || !a.metric || a.thresholdCents == null)) return refuse(`Not queued: op create needs name, metric and thresholdCents. ${NOTHING_QUEUED}`)
  if (a.op === 'update' && !a.name && !a.metric && a.thresholdCents == null) return refuse(`Nothing to change: give a new name, metric or thresholdCents. ${NOTHING_QUEUED}`)

  // Where: the ad group (its market), or the market named. Found first: another business's is "not found".
  let adGroup: SdAdGroup | null = null
  if (a.adGroupId) {
    const g = await sdAdGroupOf(a.adGroupId)
    if ('refusal' in g) return refuse(`Not queued: ${g.refusal} ${NOTHING_QUEUED}`)
    adGroup = g
    if (a.market && a.market !== g.campaign.market) return refuse(`Not queued: ad group ${quote(g.name)} is in ${g.campaign.market}, not ${a.market}. ${NOTHING_QUEUED}`)
    if (g.status === 'ARCHIVED') return refuse(`Not queued: ad group ${quote(g.name)} is archived. ${NOTHING_QUEUED}`)
  }
  const marketCode = adGroup?.campaign.market ?? a.market
  if (!marketCode) return refuse(`Not queued: op ${a.op} needs market (IT, DE, …). ${NOTHING_QUEUED}`)
  const m = await sdMarketOf(marketCode)
  if ('refusal' in m) return refuse(`Not queued: ${m.refusal} ${NOTHING_QUEUED}`)
  const wanted: RuleValues | null = a.op === 'create' ? { name: a.name!, metric: a.metric!, thresholdCents: a.thresholdCents! } : null
  const landed = await sdReach(m.market, a.thresholdCents ?? 0)
  if ('refusal' in landed) return refuse(landed.refusal.startsWith('Not queued') ? landed.refusal : `Not queued: ${landed.refusal}`)

  let plan: Plan
  let attachedTo: Array<{ adGroupId: string; name: string; campaign: SdCampaign }> = []
  let readMore = false
  if (a.op === 'create') {
    const low = belowMinimum(wanted!, m.currency)
    if (low) return refuse(low)
    const taken = await listSdOptimizationRules(m.ctx, { name: wanted!.name! })
    if (taken.length) return refuse(`Not queued: ${m.market}'s profile already has an optimization rule named ${quote(taken[0].name)} (ruleId ${taken[0].ruleId}): give the new one another name, or use that one. ${NOTHING_QUEUED}`)
    plan = { op: 'create', market: m, ruleId: null, from: null, to: wanted, adGroup, onGroup: null }
  } else if (a.op === 'update') {
    const rule = await getSdOptimizationRule(m.ctx, a.ruleId!)
    if (!rule) return refuse(`Not queued: optimization rule ${a.ruleId} not found on ${m.market}'s Amazon Ads profile. ${NOTHING_QUEUED}`)
    const from = valuesOf(rule)
    const to: RuleValues = { name: a.name ?? from.name, metric: a.metric ?? from.metric, thresholdCents: a.thresholdCents ?? from.thresholdCents }
    if (!to.metric || to.thresholdCents == null) return refuse(`Not queued: rule ${a.ruleId} holds a condition Nexus cannot read (${rule.metric ?? 'no metric'}): name its metric and thresholdCents. ${NOTHING_QUEUED}`)
    if (sameValues(from, to)) return refuse(`Nothing would change: rule ${ruleLabel(rule.ruleId, rule.name)} is already ${ruleWords(from, m.currency)}. ${NOTHING_QUEUED}`)
    const low = belowMinimum(to, m.currency)
    if (low) return refuse(low)
    const { groups, more } = await sdAdGroupsIn(m.market, AD_GROUPS_READ)
    attachedTo = (await rulesOnGroups(m, groups)).filter((x) => x.rules.some((r) => r.ruleId === rule.ruleId)).map((x) => x.group)
    readMore = more
    for (const g of attachedTo) {
      const small = budgetTooSmall(g.campaign, to)
      if (small) return refuse(small)
    }
    plan = { op: 'update', market: m, ruleId: rule.ruleId, from, to, adGroup: null, onGroup: null }
  } else {
    const onGroup = await adGroupSdOptimizationRules(m.ctx, adGroup!.externalAdGroupId)
    if (a.op === 'attach') {
      const rule = await getSdOptimizationRule(m.ctx, a.ruleId!)
      if (!rule) return refuse(`Not queued: optimization rule ${a.ruleId} not found on ${m.market}'s Amazon Ads profile. ${NOTHING_QUEUED}`)
      if (onGroup.some((r) => r.ruleId === rule.ruleId)) return refuse(`Nothing would change: ad group ${quote(adGroup!.name)} already holds rule ${ruleLabel(rule.ruleId, rule.name)}. ${NOTHING_QUEUED}`)
      if (onGroup.length) {
        return refuse(`Not queued: Amazon takes one optimization rule per ad group, and ad group ${quote(adGroup!.name)} holds ${ruleLabel(onGroup[0].ruleId, onGroup[0].name)}: detach it first (op detach), then attach this one. ${NOTHING_QUEUED}`)
      }
      plan = { op: 'attach', market: m, ruleId: rule.ruleId, from: valuesOf(rule), to: valuesOf(rule), adGroup, onGroup: null }
    } else {
      const held = a.ruleId ? onGroup.find((r) => r.ruleId === a.ruleId) : onGroup[0]
      if (!onGroup.length) return refuse(`Nothing would change: ad group ${quote(adGroup!.name)} holds no optimization rule. ${NOTHING_QUEUED}`)
      if (!held) return refuse(`Not queued: ad group ${quote(adGroup!.name)} does not hold rule ${a.ruleId}; it holds ${onGroup.map((r) => ruleLabel(r.ruleId, r.name)).join(', ')}. ${NOTHING_QUEUED}`)
      plan = { op: 'detach', market: m, ruleId: held.ruleId, from: valuesOf(held), to: valuesOf(held), adGroup, onGroup: held }
    }
  }
  if (plan.adGroup && plan.op !== 'detach') {
    if (!plan.adGroup.productAds) return refuse(`Not queued: Amazon puts an optimization rule only on an ad group with product ads (a SKU or ASIN), and ad group ${quote(plan.adGroup.name)} has none in Nexus. ${NOTHING_QUEUED}`)
    const onIt = plan.op === 'create' ? await adGroupSdOptimizationRules(m.ctx, plan.adGroup.externalAdGroupId) : []
    if (onIt.length) return refuse(`Not queued: Amazon takes one optimization rule per ad group, and ad group ${quote(plan.adGroup.name)} holds ${ruleLabel(onIt[0].ruleId, onIt[0].name)}: detach it first (op detach). ${NOTHING_QUEUED}`)
    const small = budgetTooSmall(plan.adGroup.campaign, plan.to!)
    if (small) return refuse(small)
  }
  return { plan, result: previewOf(plan, landed.reach, attachedTo, readMore) }
}

/** The preview a person approves: every value from → to, where it lands, and what can add spend. */
function previewOf(plan: Plan, reach: StoredReach, attachedTo: Array<{ adGroupId: string; name: string; campaign: SdCampaign }>, readMore: boolean): ToolResult {
  const { market: m } = plan
  const cur = m.currency
  const group = plan.adGroup
  const groupLabel = group ? `ad group ${quote(group.name)} in campaign ${quote(group.campaign.name)}` : null
  const rule = ruleLabel(plan.ruleId, plan.to?.name ?? plan.from?.name)
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const raises: string[] = []
  const warnings: string[] = []
  let summary: string
  if (plan.op === 'create') {
    changes['optimization rule'] = { from: null, to: `${quote(plan.to!.name)}: ${ruleWords(plan.to, cur)}` }
    if (group) {
      changes[`rule on ${groupLabel}`] = { from: 'none', to: quote(plan.to!.name) }
      raises.push(`Amazon then bids ${groupLabel} itself to keep its ${METRIC_WORDS[plan.to!.metric!]} at or below ${money(plan.to!.thresholdCents, cur)}: it overrides its targets' manual bids and may add targets`)
    }
    summary = `Creates the Sponsored Display optimization rule ${quote(plan.to!.name)} in ${m.market} (${ruleWords(plan.to, cur)})${group ? ` and puts it on ${groupLabel}` : '; it is on no ad group yet, so it changes no bid until it is attached'}.`
  } else if (plan.op === 'update') {
    if (plan.from!.name !== plan.to!.name) changes['rule name'] = { from: plan.from!.name, to: plan.to!.name }
    if (plan.from!.metric !== plan.to!.metric || plan.from!.thresholdCents !== plan.to!.thresholdCents) changes['cost control'] = { from: ruleWords(plan.from, cur), to: ruleWords(plan.to, cur) }
    const looser = plan.from!.metric !== plan.to!.metric || (plan.to!.thresholdCents ?? 0) > (plan.from!.thresholdCents ?? 0)
    if (looser && (attachedTo.length || readMore)) {
      raises.push(`${plan.from!.metric !== plan.to!.metric ? 'another metric' : 'a higher limit'} lets Amazon bid higher on ${attachedTo.length ? plural(attachedTo.length, 'ad group') : 'the ad groups'} it is on`)
    }
    if (attachedTo.length) warnings.push(`It is on ${attachedTo.map((g) => `${quote(g.name)} (${g.campaign.name})`).join(', ')}: the change applies to each.`)
    else if (!readMore) warnings.push('Nexus found it on none of this market\'s Sponsored Display ad groups: it changes no bid now.')
    if (readMore) warnings.push(`Nexus read the rule of the first ${AD_GROUPS_READ} Sponsored Display ad groups of ${m.market}: it may be on others too, and the change applies there as well.`)
    summary = `Changes the Sponsored Display optimization rule ${rule} in ${m.market}: ${Object.entries(changes).map(([k, v]) => `${k} ${v.from} → ${v.to}`).join('; ')}.`
  } else if (plan.op === 'attach') {
    changes[`rule on ${groupLabel}`] = { from: 'none', to: `${rule}: ${ruleWords(plan.to, cur)}` }
    raises.push(`Amazon bids ${groupLabel} itself to keep its ${plan.to!.metric ? METRIC_WORDS[plan.to!.metric] : 'cost'} at or below ${money(plan.to!.thresholdCents, cur)}: it overrides its targets' manual bids and may add targets`)
    summary = `Puts the optimization rule ${rule} (${ruleWords(plan.to, cur)}) on ${groupLabel} in ${m.market}.`
  } else {
    changes[`rule on ${groupLabel}`] = { from: `${rule}: ${ruleWords(plan.from, cur)}`, to: 'none' }
    raises.push(`the targets of ${groupLabel} bid their own manual bids again, which may be higher than what the cost control paid`)
    summary = `Takes the optimization rule ${rule} off ${groupLabel} in ${m.market}: its targets bid their own manual bids again.`
  }
  if (group && plan.op !== 'detach') warnings.push(`While a rule is on ${groupLabel}, Amazon sets its bids: Nexus's bid tools, rules and engines change its targets' manual bids, which the rule overrides.`)
  const effect = `${summary}${addsSpendWords(raises, false)}`
  return {
    ok: true,
    preview: {
      action: TOOL,
      op: plan.op,
      market: m.market,
      currency: cur,
      rule: plan.ruleId || plan.from ? { ruleId: plan.ruleId, ...(plan.from ?? {}) } : null,
      ...(group ? { adGroup: { adGroupId: group.adGroupId, name: group.name, campaignId: group.campaign.campaignId, campaign: group.campaign.name, dailyBudgetCents: group.campaign.dailyBudgetCents } } : {}),
      ...(plan.op === 'update' ? { onAdGroups: attachedTo.map((g) => ({ adGroupId: g.adGroupId, name: g.name, campaign: g.campaign.name })) } : {}),
      summary,
      changes,
      raises,
      noCode: raises.length ? DAY_TO_DAY_NO_CODE : ADDS_NO_SPEND,
      ...(warnings.length ? { warnings } : {}),
      // Every value it starts from at Amazon and in Nexus: a move of any of them after approval is caught (recheck).
      basis: basisOf({ op: plan.op, ruleId: plan.ruleId, from: plan.from, to: plan.to, group: group ? { id: group.adGroupId, budget: group.campaign.dailyBudgetCents, productAds: group.productAds } : null, onGroup: plan.onGroup?.ruleId ?? null, attachedTo: attachedTo.map((g) => [g.adGroupId, g.campaign.dailyBudgetCents]) }),
      reach,
      reachNote: sdReachNote(reach),
      effect,
      undoNote: plan.op === 'create'
        ? group ? 'Undo takes the rule off the ad group (op detach). Amazon has no way to delete a rule: on no ad group it does nothing.' : 'It cannot be undone at Amazon (Amazon has no delete for a rule), but on no ad group it changes nothing.'
        : plan.op === 'update' ? 'Undo puts the rule\'s old name, metric and limit back (op update).'
          : plan.op === 'attach' ? 'Undo takes it off the ad group again (op detach).' : 'Undo puts it back on the ad group (op attach).',
    },
  }
}

/** What a change of this tool records: the market, the rule and its values, the ad group and whether the rule is on it. */
interface RuleRecord { op: Op; market: string; ruleId: string | null; rule: RuleValues | null; adGroupId: string | null; attached: boolean | null }

/** C2 — undo: a new rule on an ad group comes off it; an update is put back; an attach is detached, a detach attached. */
export const SET_SD_OPTIMIZATION_RULE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as RuleRecord
    if (!after.market || !after.ruleId) return change.after
    try {
      const m = await sdMarketOf(after.market)
      if ('refusal' in m) return { ...after, unreadable: m.refusal }
      const now: RuleRecord = { ...after }
      if (after.rule) {
        const rule = await getSdOptimizationRule(m.ctx, after.ruleId)
        now.rule = rule ? valuesOf(rule) : null
      }
      if (after.attached != null && after.adGroupId) {
        const g = await sdAdGroupOf(after.adGroupId)
        if ('refusal' in g) return { ...after, unreadable: g.refusal }
        now.attached = (await adGroupSdOptimizationRules(m.ctx, g.externalAdGroupId)).some((r) => r.ruleId === after.ruleId)
      }
      return now
    } catch (error) {
      return { ...after, unreadable: error instanceof Error ? error.message : String(error) }
    }
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<RuleRecord>
    const after = (change.after ?? {}) as Partial<RuleRecord>
    if (!after.ruleId || !after.market) return { refusal: 'This change does not name the optimization rule it made or changed.' }
    const why = `undo of an earlier Sponsored Display optimization rule change (${after.op ?? '?'})`
    if (after.op === 'create') {
      if (after.attached === true && after.adGroupId) return { tool: TOOL, args: { op: 'detach', adGroupId: after.adGroupId, ruleId: after.ruleId, why } }
      return { refusal: 'Amazon has no way to delete an optimization rule. This one is on no ad group, so it changes no bid: leave it, or change it with set-sd-optimization-rule op update.' }
    }
    if (after.op === 'update') {
      const was = before.rule
      if (!was?.name || !was.metric || was.thresholdCents == null) return { refusal: 'This change does not record the rule as it was before.' }
      return { tool: TOOL, args: { op: 'update', market: after.market, ruleId: after.ruleId, name: was.name, metric: was.metric, thresholdCents: was.thresholdCents, why } }
    }
    if (!after.adGroupId) return { refusal: 'This change does not name the ad group.' }
    return { tool: TOOL, args: { op: after.op === 'attach' ? 'detach' : 'attach', adGroupId: after.adGroupId, ruleId: after.ruleId, why } }
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
  const base = { market, ruleId: plan.ruleId, adGroupId: plan.adGroup?.adGroupId ?? null }
  const done = (data: Record<string, unknown>, before: RuleRecord, after: RuleRecord): ToolResult =>
    ({ ok: true, data: { op: plan.op, market, reach: p.reach, changeSetId: approved.changeSetId, ...data }, change: { before, after } })
  const amazonRule = (v: RuleValues) => ({ name: v.name!, metric: AMAZON_METRIC[v.metric!], threshold: amountOf(v.thresholdCents!) })

  if (plan.op === 'create') {
    const made = await createSdOptimizationRule(client, amazonRule(plan.to!))
    if (!made.ok) return notRun(`Not run: ${made.error} ${NOTHING_CHANGED}`)
    const ruleId = made.id!
    let attached: boolean | null = null
    let note: string | null = null
    if (plan.adGroup) {
      try {
        const on = await attachSdOptimizationRule(client, plan.adGroup.externalAdGroupId, ruleId)
        attached = on.ok
        if (!on.ok) note = `The rule was made (ruleId ${ruleId}) but not put on ad group ${quote(plan.adGroup.name)}: ${on.error} Ask for op attach again.`
      } catch (error) {
        attached = false
        note = `The rule was made (ruleId ${ruleId}) but not put on ad group ${quote(plan.adGroup.name)}: ${error instanceof Error ? error.message : String(error)} Ask for op attach again.`
      }
    }
    return done(
      { ruleId, name: plan.to!.name, ...(plan.adGroup ? { adGroupId: plan.adGroup.adGroupId, attached } : {}), ...(note ? { note } : {}) },
      { op: 'create', ...base, ruleId: null, rule: null, attached: plan.adGroup ? false : null },
      { op: 'create', ...base, ruleId, rule: plan.to, attached },
    )
  }
  if (plan.op === 'update') {
    const out = await updateSdOptimizationRule(client, plan.ruleId!, amazonRule(plan.to!))
    if (!out.ok) return notRun(`Not run: ${out.error} ${NOTHING_CHANGED}`)
    return done({ ruleId: plan.ruleId, rule: plan.to }, { op: 'update', ...base, rule: plan.from, attached: null }, { op: 'update', ...base, rule: plan.to, attached: null })
  }
  const group = plan.adGroup!
  const out = plan.op === 'attach'
    ? await attachSdOptimizationRule(client, group.externalAdGroupId, plan.ruleId!)
    : await detachSdOptimizationRule(client, group.externalAdGroupId, plan.ruleId!)
  if (!out.ok) return notRun(`Not run: ${out.error} ${NOTHING_CHANGED}`)
  const attachedNow = plan.op === 'attach'
  return done({ ruleId: plan.ruleId, adGroupId: group.adGroupId, attached: attachedNow }, { op: plan.op, ...base, rule: null, attached: !attachedNow }, { op: plan.op, ...base, rule: null, attached: attachedNow })
}

const setSdOptimizationRule: AgentTool = {
  name: TOOL,
  title: 'Change a Sponsored Display cost control',
  input,
  requires: [F.adsCampaignsManage, F.adsBidsEdit, ADSPEND],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A rule cannot be deleted at Amazon: a create is undone only where it was put on an ad group (it comes off).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: SET_SD_OPTIMIZATION_RULE_UNDO,
  description:
    "Create, change, attach or detach an Amazon Sponsored Display optimization rule (cost control: Amazon bids an ad "
    + 'group to keep its cost per order, per click or per 1,000 viewable impressions at or below a limit), live at Amazon. '
    + 'op create: a new rule in a market (name, metric, thresholdCents; adGroupId also puts it on that ad group); op '
    + 'update: its name, metric or limit (it applies wherever the rule is used); op attach: a rule on an ad group; op '
    + 'detach: the rule off an ad group. Amazon takes ONE rule per ad group, only on an ad group with product ads, only '
    + "when the campaign's daily budget is at least 5× (cost per order), 20× (cost per click) or 10× (per 1,000 viewable "
    + 'impressions) the limit, and a limit of at least 5 / 0.5 / 1 in the market\'s currency: Nexus refuses before asking '
    + 'otherwise. A rule on an ad group overrides its targets\' manual bids and may add targets: listed in raises (ADDS '
    + 'SPEND), as is a detach (the manual bids come back). Amazon has no delete and no pause for a rule. A person approves '
    + 'it in Nexus; the preview shows each value from → to and where it lands (live at Amazon on which profile; in sandbox '
    + "mode it is not queued), and it is sent to Amazon at once when approved. Amazon's refusal is passed on in its own "
    + 'words. Undo: an update is put back, an attach detached, a detach attached, and a new rule taken off the ad group it was put on.',
  async handler(args) {
    return sdAnswered(NOTHING_QUEUED, async () => (await decide(args)).result)
  },
  async execute(args, ctx) {
    return sdAnswered(NOTHING_CHANGED, () => run(args, ctx))
  },
}

export const ADS_SD_OPTIMIZATION_RULE_TOOLS: AgentTool[] = [sdOptimizationRules, setSdOptimizationRule]
