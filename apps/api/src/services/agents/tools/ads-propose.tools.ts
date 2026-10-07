/**
 * NAF.C — the fleet's ads tools (plan C-D1), shared with Claude (MCP full control d1 = A). `handler` is a
 * deterministic dry-run built from the same checks the write path enforces (protected terms, authority pins,
 * isNegative-only existing-negative reads); hard denials return ok:false so the approval gate never queues them.
 *
 * MCP full control A5 — `create-negative-keyword` (ad-group negatives only, through the one negative write service, which
 * binds the campaign's allowlist) and `graduate-keyword` (into the named or resolved harvest destination) execute too, with the same rules;
 * a negative is undone by undo-ad-change retiring it, a graduation by lowering the keyword to the floor (d3: never
 * paused or archived).
 *
 * MCP full control A4 — `set-target-bid` executes once a person approves it: the A3 guards in its dry run and again in
 * `execute` (ads-change-kit.ts): live reach (a refusal is not queued; a changed answer is not run), the suppression
 * guard, the CPC-ceiling and max-change clamps shown before approval, the campaign's own currency, actor
 * `user:<approverId>`, reason `Claude request <approvalId>: <why>`, and changeSetId = the approval id. Requests made
 * before the switch carry no stored reach: they never run and the approval sweep expires them.
 *
 * ADS AUTONOMY AA-W2-6 — `set-target-bid` is strategy-bound: its dry run carries the limit facts of the bid that lands
 * (the ads strategy of the target's ad group, Claude's limits, today's runs by rule) and the write gate's answer as a
 * run by rule, so the business may let it run by its rule inside them (ads-change-kit.ts `ruleFactsFor`, `ruleRefusal`).
 * AA-W2-7 — `create-negative-keyword` and `graduate-keyword` too: a negative runs by rule only for a term whose record
 * over the strategy's window meets its "Negate a search term when" group where it lands (exact negatives only, unless
 * the business allows phrase); a graduation only for a term that meets the "Harvest a search term when" group where it
 * converted, at a starting bid inside the destination's bid band and Claude's limit. Protected terms and protected
 * products' ASINs are never negated by rule.
 *
 * ADS AUTONOMY W3-1 — all three take an optional `source` (ads-change-source.ts): the engine recommendation the change
 * carries out (apply-ad-recommendations sets it). It must name this change's own recommendation; it is kept in the
 * preview and on the ads audit row, and once the write ran the recommendation is settled (not offered again until the
 * data shows what the change did).
 *
 * The protected-terms check is the write gate's own matcher (ads-negation-policy.ts, 5a): EXACT / PREFIX / CONTAINS, and
 * a phrase negative that a protected term contains; it is not re-invented. Amazon's text limits are checked there too.
 */
import prisma from '../../../db.js'
import { negativeKeywordTextProblem, protectedNegativeRefusal } from '../../advertising/ads-negation-policy.js'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { updateAdTargetWithSync } from '../../advertising/ads-mutation.service.js'
import { writeNegativeKeyword } from '../../advertising/ads-negative-kw.service.js'
import { createKeywordLocal } from '../../advertising/ads-create.service.js'
import { adsProfileFor } from '../../advertising/ads-profile-resolver.js'
import { adGroupCampaigns, adGroupExternalIds, adGroupsByExternalId } from '../../advertising/ads-entity-lookup.service.js'
import { loadDestinationGraph, resolveDestination, resolveStoredDestinations } from '../../advertising/harvest-destination.service.js'
import { clampBidsByCeiling } from '../../advertising/ads-cpc-ceiling.js'
import { amountLabel, campaignCurrency, checkLiveReach, suppressionOf } from './ads-tool-guards.js'
import { alsoChangedBy, approvedRun, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, stepClampWords, storedReach, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, LIMIT_FACTS_MONEY, limitFactsOf, STEP_PCT_LIMITS, type LimitFacts, type ScopeFacts } from './ads-autonomy-kit.js'
import { bidLimitsFor, stepClamp } from '../../advertising/ads-strategy/bids.js'
import { harvestForScope } from '../../advertising/ads-strategy/terms.js'
import { DEFAULT_MIN_ORDERS, DEFAULT_WINDOW_DAYS, meetsHarvest } from '../../advertising/ads-harvest.service.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { sameProductHome } from '../../advertising/ads-winner-lock.js'
import { notOfferedRefusal, recommendationIdFor, settleSources, sourceArg, sourceOf, sourcePreview, sourceRefusal, sourcesRecord, unsettleChange, withSource } from './ads-change-source.js'
import type { AgentTool, FieldPermission, ToolResult, ToolUndo } from '../tool-types.js'

const BID_FLOOR_CENTS = 5
const METRIC_WINDOW_DAYS = 60

interface CampaignRow {
  id: string
  externalCampaignId: string | null
  name: string
  marketplace: string | null
  type: string
  adProduct: string | null
  dailyBudgetCurrency: string
  pinPlacement: boolean
  pinBids: boolean
  pinBudget: boolean
  pinNote: string | null
}

async function campaignByExternalId(externalCampaignId: string): Promise<CampaignRow | null> {
  return prisma.campaign.findFirst({
    where: { externalCampaignId },
    select: {
      id: true,
      externalCampaignId: true,
      name: true,
      marketplace: true,
      type: true,
      adProduct: true,
      dailyBudgetCurrency: true,
      pinPlacement: true,
      pinBids: true,
      pinBudget: true,
      pinNote: true,
    },
  }) as Promise<CampaignRow | null>
}

async function termMetrics(query: string, externalCampaignId: string) {
  const since = new Date(Date.now() - METRIC_WINDOW_DAYS * 24 * 3600_000)
  const agg = await prisma.amazonAdsSearchTerm.aggregate({
    where: { query, campaignId: externalCampaignId, date: { gte: since } },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true },
  })
  const costCents = Number(agg._sum.costMicros ?? 0n) / 10000
  return {
    windowDays: METRIC_WINDOW_DAYS,
    impressions: agg._sum.impressions ?? 0,
    clicks: agg._sum.clicks ?? 0,
    costCents: Math.round(costCents),
    orders: agg._sum.orders7d ?? 0,
  }
}

/**
 * AA-W2-7 — a search term's record over a window where it ran (its campaign, and its ad group when named), summed as
 * the harvest engine sums it (ads-harvest.service.ts termTotals): what a negative or a graduation run by rule is judged on.
 */
interface TermRecord { windowDays: number; clicks: number; spendCents: number; orders: number; salesCents: number }

async function termRecord(query: string, where: { externalCampaignId: string; externalAdGroupId?: string | null }, windowDays: number): Promise<TermRecord> {
  const since = new Date(Date.now() - windowDays * 24 * 3600_000)
  const agg = await prisma.amazonAdsSearchTerm.aggregate({
    where: { query, campaignId: where.externalCampaignId, ...(where.externalAdGroupId ? { adGroupId: where.externalAdGroupId } : {}), date: { gte: since } },
    _sum: { clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  return {
    windowDays,
    clicks: agg._sum.clicks ?? 0,
    spendCents: Math.round(Number(agg._sum.costMicros ?? 0n) / 10000),
    orders: agg._sum.orders7d ?? 0,
    salesCents: agg._sum.sales7dCents ?? 0,
  }
}

/**
 * AA-W2-7 — the strategy's harvest group where a term converted (a graduation) or where a negative lands (harvest first),
 * as a preview stores it (money under its strategy key).
 */
interface RuleHarvest {
  harvestMinOrders: number
  harvestMinClicks: number
  harvestMaxAcosPct: number | null
  harvestWindowDays: number
  /** Where it was read (an ad group, or a campaign) and the row that gave it. */
  at: string
  from: string
}

/** AA-W2-7 — does this record meet the harvest group (the harvest engine's own bar, ads-harvest.service.ts meetsHarvest)? */
const meetsGroup = (r: TermRecord, h: RuleHarvest) =>
  meetsHarvest({ orders: r.orders, clicks: r.clicks, costCents: r.spendCents, salesCents: r.salesCents }, { minOrders: h.harvestMinOrders, minClicks: h.harvestMinClicks, maxAcosPct: h.harvestMaxAcosPct })

/** AA-W2-7 — the one strategy scope a single-item change lands on, and its market's currency. */
function onlyScope(facts: LimitFacts): { scope: ScopeFacts; currency: string } | null {
  const scope = Object.values(facts.scopes)[0]
  return scope ? { scope, currency: facts.markets[scope.market]?.currency ?? 'EUR' } : null
}

const recordWords = (r: TermRecord, currency: string) =>
  `${r.clicks} click${r.clicks === 1 ? '' : 's'}, ${amountLabel(r.spendCents, currency)} spent, ${r.orders} order${r.orders === 1 ? '' : 's'} over the last ${r.windowDays} days`

/** 5a — the write gate's protected-term refusal (ads-negation-policy.ts), as a sentence, or null. Only meaningful for negations. */
async function protectedTermDenial(
  keywordText: string,
  matchType: string,
  marketplace: string | null,
  campaignId: string | null,
): Promise<string | null> {
  return (await protectedNegativeRefusal({ text: keywordText, matchType, marketplace, campaignId }))?.reason ?? null
}

/** An ad group of this campaign, by Amazon's id: its Nexus id and name, or null when the campaign has no such group. */
async function adGroupInCampaign(externalAdGroupId: string, campaignId: string): Promise<{ id: string; name: string; externalAdGroupId: string } | null> {
  const group = (await adGroupsByExternalId([externalAdGroupId])).get(externalAdGroupId)
  if (!group) return null
  const campaign = (await adGroupCampaigns([group.id])).get(group.id)
  return campaign?.id === campaignId ? { ...group, externalAdGroupId } : null
}

const CAMPAIGN_SCOPE_REFUSAL =
  'Campaign-level negatives are not offered: none of those asked for through the harvest path landed at Amazon. '
  + 'Ask for an ad-group negative instead (externalAdGroupId; ad-search-terms gives it).'

/**
 * AA-W2-7 — create-negative-keyword's Claude limits: the kit's, and whether a phrase negative may run by rule (it blocks
 * every search that contains the term, not only the term whose record was judged): off by default.
 */
const NEGATIVE_LIMITS = adKitLimits({ maxItems: 1 }, {
  allowPhrase: z.boolean().default(false)
    .describe('let a phrase negative run by rule (it blocks every search that contains the term); off: only exact negatives run without a person'),
})

/**
 * A5 — the negative a create-negative-keyword request would add, and what the approver must see — or why not. `rule`
 * (the dry run, not `execute`): AA-W2-7 — also the facts its limits are judged on when it may run by rule.
 */
async function negativePreview(args: Record<string, unknown>, opts: { rule?: { approvalId?: string | null } } = {}): Promise<ToolResult> {
  const externalCampaignId = String(args.externalCampaignId ?? '')
  const keywordText = String(args.keywordText ?? '').trim()
  const matchType = String(args.matchType ?? 'NEGATIVE_EXACT')
  const scope = String(args.scope ?? 'AD_GROUP')
  if (!externalCampaignId || !keywordText) {
    return { ok: false, error: 'externalCampaignId and keywordText are required' }
  }
  const campaign = await campaignByExternalId(externalCampaignId)
  if (!campaign) return { ok: false, error: `campaign ${externalCampaignId} not found` }
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }
  if (scope !== 'AD_GROUP') return { ok: false, error: CAMPAIGN_SCOPE_REFUSAL }
  const externalAdGroupId = typeof args.externalAdGroupId === 'string' ? args.externalAdGroupId.trim() : ''
  if (!externalAdGroupId) return { ok: false, error: 'Name the ad group to add the negative to: externalAdGroupId (ad-search-terms gives it).' }
  // W3-1 — a source names this negative's own recommendation (its ad group and term), or the request is refused.
  const changeSource = sourceOf(args.source)
  const wrongSource = sourceRefusal(changeSource, recommendationIdFor.negative(externalAdGroupId, keywordText))
  if (wrongSource) return { ok: false, error: `Not queued: ${wrongSource}.` }
  const adGroup = await adGroupInCampaign(externalAdGroupId, campaign.id)
  if (!adGroup) return { ok: false, error: `ad group ${externalAdGroupId} not found in ${campaign.name}` }

  // Existing negatives via the isNegative boolean ONLY — 1,068 prod
  // negatives carry expressionType='EXACT' (the known trap). 5b — an archived (retired) one is not in the way.
  const existing = await prisma.adTarget.findMany({
    where: {
      isNegative: true,
      status: { not: 'ARCHIVED' },
      expressionValue: { equals: keywordText, mode: 'insensitive' },
      adGroup: { campaign: { externalCampaignId } },
    },
    select: { expressionValue: true, negativeLevel: true },
    take: 5,
  })
  if (existing.length > 0) {
    return {
      ok: false,
      error: `"${keywordText}" is already negated in this campaign (${existing[0]!.negativeLevel ?? 'unknown level'})`,
    }
  }

  const denial = await protectedTermDenial(keywordText, matchType, campaign.marketplace, campaign.id)
  if (denial) return { ok: false, error: denial }
  const textProblem = negativeKeywordTextProblem(keywordText, matchType)
  if (textProblem) return { ok: false, error: textProblem }

  const reach = await checkLiveReach({
    campaignId: campaign.id,
    marketplace: campaign.marketplace,
    changes: [{ field: 'negativeKeyword', valueCents: null }],
    isNegation: true,
    keywordText,
  })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const currency = campaignCurrency(campaign)
  const metrics = await termMetrics(keywordText, externalCampaignId)
  const bound = await alsoChangedBy(campaign.id)
  const rule = opts.rule ? await negativeRuleFacts({ keywordText, matchType, externalCampaignId, campaign, adGroup, approvalId: opts.rule.approvalId }) : null
  return {
    ok: true,
    preview: {
      action: 'create-negative-keyword',
      term: keywordText,
      matchType,
      scope,
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      adGroup: { id: adGroup.id, name: adGroup.name, externalAdGroupId: adGroup.externalAdGroupId },
      externalAdGroupId: adGroup.externalAdGroupId,
      currency,
      metrics,
      alreadyNegated: false,
      protectedDenial: null,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...(rule ?? {}),
      ...sourcePreview(changeSource),
      effect: `Stops "${keywordText}" from matching in ${campaign.name} › ${adGroup.name}; spend on it (last ${metrics.windowDays}d) was ${amountLabel(metrics.costCents, currency)} with ${metrics.orders} orders.`,
    },
  }
}

/**
 * AA-W2-7 — what a negative's dry run adds when it may run by rule: the kit's facts of the term in its ad group (the
 * strategy there, protection, today), the write gate's answer as a run by rule, and the term's record over the window
 * of the strategy's "Negate a search term when" group where it lands (none: no group set there).
 */
async function negativeRuleFacts(input: {
  keywordText: string; matchType: string; externalCampaignId: string
  campaign: { id: string; name: string; marketplace: string | null }; adGroup: { externalAdGroupId: string }
  approvalId?: string | null
}) {
  const facts = await ruleFactsFor({
    tool: 'create-negative-keyword',
    limits: NEGATIVE_LIMITS,
    items: [{
      entity: { kind: 'searchTerm', query: input.keywordText, externalCampaignId: input.externalCampaignId, externalAdGroupId: input.adGroup.externalAdGroupId },
      change: { field: 'negative', term: input.keywordText, matchType: input.matchType },
    }],
    writes: [{
      label: `campaign "${input.campaign.name}"`, campaignId: input.campaign.id, marketplace: input.campaign.marketplace,
      changes: [{ field: 'negativeKeyword', valueCents: null }], isNegation: true, keywordText: input.keywordText,
    }],
    approvalId: input.approvalId,
  })
  const at = onlyScope(facts.limitFacts)
  const days = at?.scope.limits.negateWindowDays
  const where = { externalCampaignId: input.externalCampaignId, externalAdGroupId: input.adGroup.externalAdGroupId }
  const ruleRecord = days ? await termRecord(input.keywordText, where, days) : null
  // Harvest first (ads-harvest.service.ts previewHarvest): a term that meets the harvest group where it lands — the
  // strategy's, else the harvest engine's defaults — is graduated, never negated, by the engines; so not by rule either.
  const l = at?.scope.limits
  const ruleHarvest: RuleHarvest | null = at
    ? at.scope.sources.harvest && l?.harvestMinOrders != null && l.harvestMinClicks != null && l.harvestWindowDays
      ? { harvestMinOrders: l.harvestMinOrders, harvestMinClicks: l.harvestMinClicks, harvestMaxAcosPct: l.harvestMaxAcosPct ?? null, harvestWindowDays: l.harvestWindowDays, at: at.scope.label, from: strategyWords(at.scope.sources.harvest) }
      : { harvestMinOrders: DEFAULT_MIN_ORDERS, harvestMinClicks: 0, harvestMaxAcosPct: null, harvestWindowDays: DEFAULT_WINDOW_DAYS, at: at.scope.label, from: 'the harvest engine\'s defaults: the ads strategy sets no harvest group here' }
    : null
  const ruleHarvestRecord = ruleHarvest
    ? ruleRecord && ruleRecord.windowDays === ruleHarvest.harvestWindowDays ? ruleRecord : await termRecord(input.keywordText, where, ruleHarvest.harvestWindowDays)
    : null
  const limitsNote = [...facts.limitsNote]
  if (at && ruleRecord && at.scope.sources.negate) {
    const l = at.scope.limits
    limitsNote.push(`Negate a search term when: at least ${l.negateMinClicks} clicks and ${amountLabel(l.negateMinSpendCents ?? 0, at.currency)} spent, at most ${l.negateMaxOrders} orders, over ${days} days (${strategyWords(at.scope.sources.negate)}); this term in its ad group: ${recordWords(ruleRecord, at.currency)}.`)
  }
  if (ruleHarvest && ruleHarvestRecord && at) {
    limitsNote.push(`Harvest first — a term that meets "Harvest a search term when" is graduated, never negated: at least ${ruleHarvest.harvestMinOrders} orders and ${ruleHarvest.harvestMinClicks} clicks${ruleHarvest.harvestMaxAcosPct != null ? `, ACoS at most ${ruleHarvest.harvestMaxAcosPct} %` : ''}, over ${ruleHarvest.harvestWindowDays} days (${ruleHarvest.from}); this term: ${recordWords(ruleHarvestRecord, at.currency)}.`)
  }
  return { ...facts, limitsNote, ruleRecord, ruleHarvest, ruleHarvestRecord }
}

/**
 * AA-W2-7 — create-negative-keyword's own check, after the common ones (pure): exact unless the limits allow phrase, and
 * the term's record over the strategy's window meets its negate group where it lands. No group there: a person decides.
 */
function negativeRuleRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { term?: string; matchType?: string; ruleRecord?: TermRecord | null; ruleHarvest?: RuleHarvest | null; ruleHarvestRecord?: TermRecord | null }
  if (p.matchType === 'NEGATIVE_PHRASE' && limits.allowPhrase !== true) {
    return 'a phrase negative blocks every search that contains the term; this tool\'s limits let only exact negatives run by rule (allowPhrase is off); a person decides'
  }
  const at = onlyScope(limitFactsOf(preview)!)
  const l = at?.scope.limits
  const source = at?.scope.sources.negate
  if (!at || !l || !source || l.negateMinClicks == null || l.negateMinSpendCents == null || l.negateMaxOrders == null || !l.negateWindowDays) {
    return `the ads strategy sets no "Negate a search term when" group at ${at?.scope.label ?? 'the ad group it lands in'}: a negative runs by rule only for a term that meets one; a person decides`
  }
  const r = p.ruleRecord
  if (!r || r.windowDays !== l.negateWindowDays) return `the term's record over the strategy's ${l.negateWindowDays} days was not read for this preview; a person decides`
  const short = [
    r.clicks < l.negateMinClicks ? `fewer than ${l.negateMinClicks} clicks` : null,
    r.spendCents < l.negateMinSpendCents ? `less than ${amountLabel(l.negateMinSpendCents, at.currency)} spent` : null,
    r.orders > l.negateMaxOrders ? `more than ${l.negateMaxOrders} orders` : null,
  ].filter((x): x is string => !!x)
  if (short.length) return `"${p.term}" has ${recordWords(r, at.currency)} in its ad group: ${short.join(', ')}, so it does not meet "Negate a search term when" at ${at.scope.label} (${strategyWords(source)}); a person decides`
  // Harvest first, whatever the negate group's most orders allows.
  const h = p.ruleHarvest
  const hr = p.ruleHarvestRecord
  if (!h || !hr || hr.windowDays !== h.harvestWindowDays) return `the term's record over the harvest window was not read for this preview; a person decides`
  if (meetsGroup(hr, h)) return `"${p.term}" has ${recordWords(hr, at.currency)} in its ad group, which meets "Harvest a search term when" (${h.from}): the engines graduate such a term rather than negate it, so a negative of it waits for a person`
  return null
}

/**
 * C2 — undo of a negative: undo-ad-change retires what the request created (its change set is the approval). W3-1 — named
 * by its recorded change, so only THIS negative is retired (in a change plan every step shares the plan's set).
 */
export const CREATE_NEGATIVE_UNDO: ToolUndo = {
  async current(change) {
    const listed = ((change.after as { negatives?: Array<{ targetId?: unknown }> } | null)?.negatives ?? []).map((n) => String(n.targetId ?? ''))
    // 5f — status decides, as in retireNegatives: a stale `retiredAt` from a failed retire blocks nothing.
    const standing = listed.length
      ? await prisma.adTarget.findMany({ where: { id: { in: listed }, isNegative: true, status: { not: 'ARCHIVED' } }, select: { id: true } })
      : []
    const ids = new Set(standing.map((t) => t.id))
    return { negatives: listed.filter((id) => ids.has(id)).map((targetId) => ({ targetId })) }
  },
  request(change) {
    const changeSetId = (change.before as { changeSetId?: unknown } | null)?.changeSetId
    if (typeof changeSetId !== 'string' || !changeSetId) return { refusal: 'This change does not name the request that made it.' }
    return { tool: 'undo-ad-change', args: { changeSetId, ...(change.id ? { changeId: change.id } : {}), why: 'undo of a negative keyword' } }
  },
  undone: unsettleChange,
}

const createNegativeKeyword: AgentTool = {
  name: 'create-negative-keyword',
  title: 'Add a negative keyword',
  input: z.object({
    externalCampaignId: z.string().min(1).describe('Amazon campaign id (externalCampaignId in ad-search-terms)'),
    keywordText: z.string().trim().min(1).describe('the search term to block'),
    matchType: z.enum(['NEGATIVE_EXACT', 'NEGATIVE_PHRASE']).optional().describe('default NEGATIVE_EXACT'),
    scope: z.enum(['AD_GROUP', 'CAMPAIGN']).optional().describe('AD_GROUP (the default and the only one offered: campaign-level negatives are refused)'),
    externalAdGroupId: z.string().optional().describe('Amazon ad group id to add it to (externalAdGroupId in ad-search-terms); required'),
    marketplace: z.string().optional().describe('ignored: the campaign\'s own market is used'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
    source: sourceArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A5 — an approved negative is created at Amazon at once (no cancel window): the approval is the brake.
  openWorld: true,
  reversibility: 'full',
  // AA-W2-7 — the business may let it run by its rule, only for a term that meets the ads strategy's negate group.
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: NEGATIVE_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? negativeRuleRefusal(preview, limits),
  undo: CREATE_NEGATIVE_UNDO,
  description:
    'Add a negative keyword to one ad group of an Amazon Sponsored Products campaign, so a search term stops '
    + 'triggering its ads. Nothing changes until a person approves it: in Nexus, or the person who asked confirms it in '
    + 'Claude with their authenticator code when the business set it so — unless the business lets it run by its rule: '
    + 'only an exact negative of a term whose record meets the ads strategy\'s "Negate a search term when" group where '
    + 'it lands, inside its limits. The preview shows the term\'s recent '
    + 'spend and orders, the ad group, whether it lands live at Amazon or in sandbox, and each limit with where it comes '
    + 'from. Refused, and not queued, '
    + 'for a protected term, a term already negated in the campaign, a campaign-level negative, or when Amazon\'s '
    + 'write gate would refuse it. A protected product\'s ASIN is never negated by rule. Once approved it is created at '
    + 'once as the approver; undo-change retires it again. The list form — many negatives into many ad groups, campaign '
    + 'negatives, negative ASINs — is add-negative-targets; retire-negatives retires any negative.',
  async handler(args, ctx) {
    return negativePreview(args, { rule: { approvalId: ctx.approvalId } })
  },
  async execute(args, ctx) {
    const fresh = await negativePreview(args)
    const refusal = recheck(ctx, fresh, NEGATIVE_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { term: string; matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'; campaign: { id: string; marketplace: string | null }; adGroup: { id: string; externalAdGroupId: string }; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const profileId = p.reach.reach === 'live' ? p.reach.profileId : (await adsProfileFor(p.campaign.marketplace))?.profileId ?? 'sandbox'
    // 5b — the one negative write service: it pushes (gated, with the campaign's allowlist), reads back a missing id,
    // and records the row and its audit row only for a negative that stands.
    const made = await writeNegativeKeyword({
      scope: 'AD_GROUP',
      adGroupId: p.adGroup.id,
      keywordText: p.term,
      matchType: p.matchType,
      profileId,
      userId: run.actor,
      // AA-W2-7 — the ads audit names the request, and whether a person or the business's rule decided it. W3-1 — and
      // the recommendation it carries out.
      evidence: withSource({ metric: 'claudeRequest', note: run.reason }, sourceOf(args.source)),
      manual: run.manual, // 4A — a person approved it: his own click
      // PB-10 — its audit row carries the approval's change set, so an undo of this request (or of its step in a plan)
      // finds exactly the negative it made.
      changeSetId: run.changeSetId,
    })
    if (made.refusal) return notRun(`Not run: Amazon's write gate refused it — ${made.refusal.reason}. Nothing changed.`)
    if (made.outcome === 'failed') return notRun(`Not run: the negative keyword did not reach Amazon — ${made.error}. Nothing changed.`)
    if (made.outcome === 'already_existed' || !made.adTargetId) return notRun(`Not run: "${p.term}" is already negated in that ad group. Nothing changed.`)
    await settleSources([sourceOf(args.source)], run.changeSetId)
    return {
      ok: true,
      data: {
        targetId: made.adTargetId,
        created: true,
        reach: p.reach,
        reachedAmazon: made.reachedAmazon,
        changeSetId: run.changeSetId,
        note: made.mode === 'live' ? 'Created at Amazon.' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
      },
      change: {
        before: { changeSetId: run.changeSetId, negatives: [], ...sourcesRecord([sourceOf(args.source)]) },
        after: { negatives: [{ targetId: made.adTargetId }] },
      },
    }
  },
}

/** A5 — the starting facts an approved negative must still find. */
const NEGATIVE_MATERIAL = ['matchType', 'scope', 'alreadyNegated', 'adGroup', 'reach'] as const

/** A5 — where a graduated keyword goes: the ad group named, else the harvest destination the account resolves. */
async function destinationAdGroup(args: Record<string, unknown>, query: string, source: CampaignRow, dest: CampaignRow, destNamed: boolean): Promise<{ id: string; name: string; externalAdGroupId: string | null; campaignId: string; why: string } | { refusal: string }> {
  const named = typeof args.destExternalAdGroupId === 'string' ? args.destExternalAdGroupId.trim() : ''
  if (named) {
    const group = await adGroupInCampaign(named, dest.id)
    return group ? { ...group, campaignId: dest.id, why: 'named in the request' } : { refusal: `ad group ${named} not found in ${dest.name}` }
  }
  const sourceGroupExt = typeof args.sourceExternalAdGroupId === 'string' ? args.sourceExternalAdGroupId.trim() : ''
  if (!sourceGroupExt) return { refusal: 'Name the ad group to add the keyword to (destExternalAdGroupId), or the ad group it converted in (sourceExternalAdGroupId) so the harvest destination can be resolved.' }
  const sourceGroup = await adGroupInCampaign(sourceGroupExt, source.id)
  if (!sourceGroup) return { refusal: `ad group ${sourceGroupExt} not found in ${source.name}` }
  const [graph, stored] = await Promise.all([
    loadDestinationGraph(),
    resolveStoredDestinations({ market: source.marketplace ?? 'all', campaign: source.id, adGroup: sourceGroup.id }),
  ])
  const resolved = resolveDestination({ graph, stored, sourceAdGroupId: sourceGroup.id, sourceAdGroupName: sourceGroup.name, term: query, kind: 'keyword', createType: 'EXACT' })
  if (!resolved.chosen) {
    return { refusal: `No destination ad group is decided for this term (${resolved.source === 'resolved-ambiguous' ? `${resolved.shortlist.length} could take it` : 'none fits'}). Name one: destExternalAdGroupId.` }
  }
  if (destNamed && resolved.chosen.campaignId !== dest.id) {
    return { refusal: `The harvest destination for this term is in ${resolved.chosen.campaignName}, not ${dest.name}: name the ad group (destExternalAdGroupId).` }
  }
  const ext = (await adGroupExternalIds([resolved.chosen.adGroupId])).get(resolved.chosen.adGroupId) ?? null
  return { id: resolved.chosen.adGroupId, name: resolved.chosen.adGroupName, externalAdGroupId: ext, campaignId: resolved.chosen.campaignId, why: resolved.source === 'stored' ? 'the harvest destination stored for this scope' : 'the only ad group the harvest resolver offers' }
}

/**
 * AA-W2-7 — graduate-keyword's Claude limits: the kit's, and the highest starting bid a new keyword may get by rule. A
 * new keyword adds spend, so by default (0) every graduation waits for a person.
 */
const GRADUATE_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxStartBidCents: z.number().int().min(0).max(100_000).default(0)
    .describe('the highest starting bid, in minor units of the campaign\'s currency, a new keyword may get without a person; 0 = every new keyword waits for a person'),
})

/**
 * A5 — the keyword a graduate-keyword request would create, and what the approver must see — or why not. `rule` (the
 * dry run, not `execute`): AA-W2-7 — also the facts its limits are judged on when it may run by rule.
 */
async function graduationPreview(args: Record<string, unknown>, opts: { rule?: { approvalId?: string | null } } = {}): Promise<ToolResult> {
  const query = String(args.query ?? '').trim()
  const sourceExternalCampaignId = String(args.sourceExternalCampaignId ?? '')
  if (!query || !sourceExternalCampaignId) {
    return { ok: false, error: 'query and sourceExternalCampaignId are required' }
  }
  // W3-1 — a source names this term's own graduation recommendation (the ad group it converted in), or it is refused.
  const changeSource = sourceOf(args.source)
  const sourceGroupId = typeof args.sourceExternalAdGroupId === 'string' ? args.sourceExternalAdGroupId.trim() : ''
  const wrongSource = sourceRefusal(changeSource, recommendationIdFor.graduate(sourceGroupId, query))
  if (wrongSource) return { ok: false, error: `Not queued: ${wrongSource}.` }
  const destNamed = typeof args.destExternalCampaignId === 'string' && args.destExternalCampaignId.trim() !== ''
  const source = await campaignByExternalId(sourceExternalCampaignId)
  if (!source) return { ok: false, error: `campaign ${sourceExternalCampaignId} not found` }
  // W3-1 — a graduation that carries a recommendation names the ad group it converted in, of that campaign, and the
  // feed offers that recommendation now: the source cannot ride on a term it did not judge.
  if (changeSource) {
    if (!sourceGroupId) return { ok: false, error: 'Not queued: a graduation that carries a recommendation names the ad group the term converted in (sourceExternalAdGroupId).' }
    if (!(await adGroupInCampaign(sourceGroupId, source.id))) return { ok: false, error: `Not queued: the source's ad group ${sourceGroupId} is not in campaign ${source.name}, where the term converted.` }
    const notOffered = await notOfferedRefusal(changeSource)
    if (notOffered) return { ok: false, error: `Not queued: ${notOffered}.` }
  }
  const destExternalCampaignId = String(args.destExternalCampaignId ?? sourceExternalCampaignId)
  let campaign = destNamed ? await campaignByExternalId(destExternalCampaignId) : source
  if (!campaign) return { ok: false, error: `campaign ${destExternalCampaignId} not found` }

  // 4A (Owner decided 2026-10-06) — a pin does not stop it: it runs only once a person approves it, as his own click.

  const existingIn = async (externalCampaignId: string) => prisma.adTarget.findMany({
    where: {
      isNegative: false,
      kind: 'KEYWORD',
      expressionType: 'EXACT',
      expressionValue: { equals: query, mode: 'insensitive' },
      adGroup: { campaign: { externalCampaignId } },
    },
    select: { expressionValue: true },
    take: 1,
  })
  if ((await existingIn(destExternalCampaignId)).length > 0) {
    return { ok: false, error: `an EXACT keyword for "${query}" already exists in the destination campaign` }
  }

  const group = await destinationAdGroup(args, query, source, campaign, destNamed)
  if ('refusal' in group) return { ok: false, error: group.refusal }
  if (group.campaignId !== campaign.id) {
    // The resolver chose an ad group of another campaign (the request named none): that campaign is the destination.
    const resolvedCampaign = await prisma.campaign.findFirst({ where: { id: group.campaignId }, select: { externalCampaignId: true } })
    campaign = resolvedCampaign?.externalCampaignId ? await campaignByExternalId(resolvedCampaign.externalCampaignId) : null
    if (!campaign) return { ok: false, error: 'the resolved destination campaign was not found' }
    if ((await existingIn(resolvedCampaign!.externalCampaignId!)).length > 0) {
      return { ok: false, error: `an EXACT keyword for "${query}" already exists in the destination campaign` }
    }
  }
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }
  // PB-6a (L2) — winners stay: a term already at home for its product (the products of the ad group it converted in that
  // the destination advertises, with their sibling variants) is never created again elsewhere.
  const sourceGroupExt = typeof args.sourceExternalAdGroupId === 'string' ? args.sourceExternalAdGroupId.trim() : ''
  const sourceGroup = sourceGroupExt ? await adGroupInCampaign(sourceGroupExt, source.id) : null
  const home = await sameProductHome(query, { destAdGroupId: group.id, source: { adGroupId: sourceGroup?.id ?? null, campaignId: source.id }, marketplace: campaign.marketplace })
  if (home) {
    return { ok: false, error: `"${query}" already lives as an exact keyword in ${home.campaign} › ${home.adGroup}, which advertises the same product, so it is not created again: a winner stays where it is.` }
  }

  const metrics = await termMetrics(query, sourceExternalCampaignId)
  // The applyHarvest bid formula: observed CPC, floored (cents).
  const suggestedBidCents =
    args.bidCents != null && Number.isFinite(Number(args.bidCents))
      ? Math.max(BID_FLOOR_CENTS, Math.round(Number(args.bidCents)))
      : metrics.clicks > 0
        ? Math.max(BID_FLOOR_CENTS, Math.round(metrics.costCents / metrics.clicks))
        : 50
  const reach = await checkLiveReach({
    campaignId: campaign.id,
    marketplace: campaign.marketplace,
    changes: [{ field: 'bid', valueCents: suggestedBidCents }],
  })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const currency = campaignCurrency(campaign)
  const bound = await alsoChangedBy(campaign.id)
  const rule = opts.rule
    ? await graduationRuleFacts({ query, source, sourceExternalCampaignId, sourceExternalAdGroupId: typeof args.sourceExternalAdGroupId === 'string' ? args.sourceExternalAdGroupId.trim() : '', destination: campaign, group, suggestedBidCents, approvalId: opts.rule.approvalId })
    : null
  return {
    ok: true,
    preview: {
      action: 'graduate-keyword',
      query,
      destination: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      destinationAdGroup: { id: group.id, name: group.name, externalAdGroupId: group.externalAdGroupId, why: group.why },
      currency,
      suggestedBidCents,
      metrics,
      alreadyExact: false,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...(rule ?? {}),
      ...sourcePreview(changeSource),
      effect: `Creates an EXACT keyword "${query}" at ${amountLabel(suggestedBidCents, currency)} in ${campaign.name} › ${group.name}; the term produced ${metrics.orders} orders on ${amountLabel(metrics.costCents, currency)} spend (last ${metrics.windowDays}d). The source ad group is not negated here.`,
    },
  }
}

/**
 * AA-W2-7 — what a graduation's dry run adds when it may run by rule: the kit's facts of the new keyword where it lands
 * (the destination ad group's strategy and bid band, today; a new keyword counts as a raise), the write gate's answer as
 * a run by rule, and the term's record where it converted against the strategy's "Harvest a search term when" group
 * there (its ad group when named, else its campaign: the stricter group across the campaign's ad groups).
 */
async function graduationRuleFacts(input: {
  query: string; source: CampaignRow; sourceExternalCampaignId: string; sourceExternalAdGroupId: string
  destination: CampaignRow; group: { id: string; externalAdGroupId: string | null }; suggestedBidCents: number
  approvalId?: string | null
}) {
  const facts = await ruleFactsFor({
    tool: 'graduate-keyword',
    limits: GRADUATE_LIMITS,
    // The new keyword is the term where it lands: its ad group's strategy and band, and one entity per term (C6).
    items: [{
      entity: { kind: 'searchTerm', query: input.query, externalCampaignId: input.destination.externalCampaignId ?? '', externalAdGroupId: input.group.externalAdGroupId },
      change: { field: 'bid', fromCents: null, toCents: input.suggestedBidCents },
    }],
    writes: [{ label: `campaign "${input.destination.name}"`, campaignId: input.destination.id, adGroupId: input.group.id, marketplace: input.destination.marketplace, changes: [{ field: 'bid', valueCents: input.suggestedBidCents }] }],
    approvalId: input.approvalId,
  })
  const sourceGroup = input.sourceExternalAdGroupId ? await adGroupInCampaign(input.sourceExternalAdGroupId, input.source.id) : null
  const harvest = input.source.marketplace
    ? await harvestForScope(input.source.marketplace, sourceGroup ? { adGroupId: sourceGroup.id } : { campaignIds: [input.source.id] })
    : null
  const where = sourceGroup ? `ad group "${sourceGroup.name}"` : `campaign "${input.source.name}"`
  const ruleHarvest: RuleHarvest | null = harvest
    ? { harvestMinOrders: harvest.group.minOrders, harvestMinClicks: harvest.group.minClicks, harvestMaxAcosPct: harvest.group.maxAcosPct, harvestWindowDays: harvest.group.windowDays, at: where, from: strategyWords(harvest.source) }
    : null
  const ruleRecord = harvest
    ? await termRecord(input.query, { externalCampaignId: input.sourceExternalCampaignId, externalAdGroupId: sourceGroup ? input.sourceExternalAdGroupId : null }, harvest.group.windowDays)
    : null
  const limitsNote = [...facts.limitsNote]
  if (ruleHarvest && ruleRecord) {
    const currency = campaignCurrency(input.source)
    limitsNote.push(`Harvest a search term when: at least ${ruleHarvest.harvestMinOrders} orders and ${ruleHarvest.harvestMinClicks} clicks${ruleHarvest.harvestMaxAcosPct != null ? `, ACoS at most ${ruleHarvest.harvestMaxAcosPct} %` : ''}, over ${ruleHarvest.harvestWindowDays} days (${ruleHarvest.from}); this term in its ${where}: ${recordWords(ruleRecord, currency)}.`)
  }
  return { ...facts, limitsNote, ruleHarvest, ruleRecord }
}

/**
 * AA-W2-7 — graduate-keyword's own check, after the common ones (pure): the starting bid within Claude's limit, and the
 * term's record where it converted meets the strategy's harvest group there (the harvest engine's bar, meetsHarvest: no
 * sales is no ACoS). No group there: a person decides.
 */
function graduationRuleRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { query?: string; suggestedBidCents?: number; currency?: string; ruleHarvest?: RuleHarvest | null; ruleRecord?: TermRecord | null }
  const currency = p.currency ?? 'EUR'
  const max = typeof limits.maxStartBidCents === 'number' ? limits.maxStartBidCents : 0
  const bid = Number(p.suggestedBidCents)
  if (!(bid <= max)) {
    return `its starting bid ${amountLabel(bid, currency)} is above the ${amountLabel(max, currency)} this tool's limits let a new keyword start at without a person${max === 0 ? ' (0: every new keyword waits for a person)' : ''}; a person decides`
  }
  const h = p.ruleHarvest
  if (!h) return `the ads strategy sets no "Harvest a search term when" group where "${p.query}" converted: a keyword is added by rule only for a term that meets one; a person decides`
  const r = p.ruleRecord
  if (!r || r.windowDays !== h.harvestWindowDays) return `the term's record over the strategy's ${h.harvestWindowDays} days was not read for this preview; a person decides`
  const acos = r.salesCents > 0 ? Math.round((r.spendCents / r.salesCents) * 10_000) / 100 : null
  const short = [
    r.orders < h.harvestMinOrders ? `fewer than ${h.harvestMinOrders} orders` : null,
    r.clicks < h.harvestMinClicks ? `fewer than ${h.harvestMinClicks} clicks` : null,
    h.harvestMaxAcosPct != null && acos != null && acos > h.harvestMaxAcosPct ? `an ACoS of ${acos} %, above ${h.harvestMaxAcosPct} %` : null,
  ].filter((x): x is string => !!x)
  if (!short.length) return null
  return `"${p.query}" has ${recordWords(r, currency)} in its ${h.at}: ${short.join(', ')}, so it does not meet "Harvest a search term when" (${h.from}); a person decides`
}

/** A5 — the starting facts an approved graduation must still find. */
const GRADUATION_MATERIAL = ['suggestedBidCents', 'destination', 'destinationAdGroup', 'alreadyExact', 'reach'] as const

/**
 * C2 — undo of a graduation: the keyword stays at Amazon (Nexus never pauses or archives an ad, d3); its bid goes down
 * to the 5¢ floor through set-target-bid, which stops it winning auctions. Partly reversible: it was live meanwhile.
 */
export const GRADUATE_UNDO: ToolUndo = {
  async current(change) {
    const targetId = String((change.after as { targetId?: unknown } | null)?.targetId ?? '')
    const t = await prisma.adTarget.findFirst({ where: { id: targetId }, select: { bidCents: true } })
    return { targetId, bidCents: t?.bidCents ?? null }
  },
  request(change) {
    const targetId = (change.after as { targetId?: unknown } | null)?.targetId
    if (typeof targetId !== 'string' || !targetId) return { refusal: 'This change does not name the keyword it created.' }
    return { tool: 'set-target-bid', args: { targetId, proposedBidCents: BID_FLOOR_CENTS, why: 'undo of a graduation: the keyword stays (Nexus never pauses or archives), its bid goes to the floor' } }
  },
  undone: unsettleChange,
}

const graduateKeyword: AgentTool = {
  name: 'graduate-keyword',
  title: 'Add an exact keyword',
  input: z.object({
    query: z.string().trim().min(1).describe('the search term to promote'),
    sourceExternalCampaignId: z.string().min(1).describe('Amazon campaign id it converted in'),
    sourceExternalAdGroupId: z.string().optional().describe('Amazon ad group id it converted in (resolves the destination when none is named)'),
    destExternalCampaignId: z.string().min(1).optional().describe('campaign to add it to (default: the source, or the resolved destination\'s)'),
    destExternalAdGroupId: z.string().optional().describe('ad group to add it to (default: the harvest destination the account resolves)'),
    bidCents: z.coerce.number().positive().optional().describe('starting bid in minor units of the campaign\'s currency (default: its cost per click)'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
    source: sourceArg,
  }),
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A5 — an approved keyword is created at Amazon at once (no cancel window).
  openWorld: true,
  reversibility: 'partial',
  // AA-W2-7 — the business may let it run by its rule, only for a term that meets the ads strategy's harvest group.
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: GRADUATE_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? graduationRuleRefusal(preview, limits),
  undo: GRADUATE_UNDO,
  description:
    'Promote a converting search term to an EXACT keyword in an Amazon Sponsored Products ad group (the one named, or '
    + 'the harvest destination the account resolves). Nothing changes until a person approves it: in Nexus, or the '
    + 'person who asked confirms it in Claude with their authenticator code when the business set it so — unless the '
    + 'business lets it run by its rule: only for a term whose record meets the ads strategy\'s "Harvest a search term '
    + 'when" group where it converted, at a starting bid inside its limits and the destination\'s bid band (by default '
    + 'every new keyword waits for a person). The preview '
    + 'shows the starting bid in the campaign\'s currency (default: the term\'s cost per click), the term\'s record, '
    + 'whether it lands live at Amazon or in sandbox, and each limit with where it comes from. Refused, and not queued, '
    + 'when the exact keyword exists, or when Amazon\'s write gate would refuse it. The source ad group is not negated. '
    + 'Undo lowers the keyword to the 5-cent floor (it is never paused or archived). harvest-search-term does this and the '
    + 'source negative in one step; add-ad-targets adds many keywords and product or category targets to one ad group.',
  async handler(args, ctx) {
    return graduationPreview(args, { rule: { approvalId: ctx.approvalId } })
  },
  async execute(args, ctx) {
    const fresh = await graduationPreview(args)
    const refusal = recheck(ctx, fresh, GRADUATION_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { query: string; suggestedBidCents: number; destinationAdGroup: { id: string }; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const made = await createKeywordLocal({
      adGroupId: p.destinationAdGroup.id,
      keywordText: p.query,
      matchType: 'EXACT',
      bidEur: p.suggestedBidCents / 100,
      userId: run.actor,
      evidence: withSource({ metric: 'claudeRequest', note: run.reason }, sourceOf(args.source)),
      manual: run.manual, // 4A
      confirmOwnLimits: run.confirmOwnLimits, // 4A
    })
    if (made.existed) return notRun(`Not run: an EXACT keyword for "${p.query}" appeared in that ad group meanwhile. Nothing changed.`)
    await settleSources([sourceOf(args.source)], run.changeSetId)
    const live = p.reach.reach === 'live'
    const reachedAmazon = live && made.externalTargetId != null && !made.denied && !made.pushError
    return {
      ok: true,
      data: {
        targetId: made.id,
        bidCents: p.suggestedBidCents,
        reach: p.reach,
        reachedAmazon,
        changeSetId: run.changeSetId,
        note: !live
          ? 'Sandbox: recorded in Nexus only; nothing reached Amazon.'
          : reachedAmazon
            ? 'Created at Amazon.'
            : `Created in Nexus only: ${made.denied ? `Amazon's write gate refused it (${made.denied.reason})` : made.pushError ? `Amazon's answer was an error (${made.pushError})` : 'Amazon returned no id for it'}.`,
      },
      change: {
        before: { changeSetId: run.changeSetId, keyword: null, ...sourcesRecord([sourceOf(args.source)]) },
        after: { targetId: made.id, bidCents: p.suggestedBidCents },
      },
    }
  },
}

/**
 * AA-W2-6 — set-target-bid's Claude limits (Settings › AI › Claude): the kit's, with a raise and a cut step. By
 * default no raise runs alone (0 %); a cut runs alone inside the ads strategy's bid band and largest change.
 */
const TARGET_BID_LIMITS = adKitLimits({ maxItems: 1 }, STEP_PCT_LIMITS)

/**
 * The bid a set-target-bid request would write, and everything the approver must see — or why it is refused.
 * `rule` (the dry run, not `execute`): AA-W2-6 — also the facts its limits are judged on when it may run by rule.
 */
async function targetBidPreview(args: Record<string, unknown>, opts: { rule?: { approvalId?: string | null } } = {}): Promise<ToolResult> {
  const targetId = String(args.targetId ?? '')
  const proposedBidCents = Math.round(Number(args.proposedBidCents))
  if (!targetId || !Number.isFinite(proposedBidCents)) {
    return { ok: false, error: 'targetId and numeric proposedBidCents are required' }
  }
  if (proposedBidCents < BID_FLOOR_CENTS) {
    return { ok: false, error: `proposed bid ${proposedBidCents}c is below the ${BID_FLOOR_CENTS}c floor` }
  }
  // W3-1 — a source names this target's own bid recommendation, or the request is refused.
  const changeSource = sourceOf(args.source)
  const wrongSource = sourceRefusal(changeSource, recommendationIdFor.bid(targetId))
  if (wrongSource) return { ok: false, error: `Not queued: ${wrongSource}.` }
  const target = await prisma.adTarget.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      expressionValue: true,
      expressionType: true,
      bidCents: true,
      suppressedFromBidCents: true,
      isNegative: true,
      adGroupId: true,
      adGroup: {
        select: {
          campaign: {
            select: {
              id: true,
              name: true,
              type: true,
              adProduct: true,
              marketplace: true,
              dailyBudgetCurrency: true,
              dynamicBidding: true,
              pinPlacement: true,
              pinBids: true,
              pinBudget: true,
              pinNote: true,
            },
          },
        },
      },
    },
  })
  if (!target || target.isNegative) {
    return { ok: false, error: `target ${targetId} not found (or is a negative)` }
  }
  const campaign = target.adGroup.campaign
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }
  // 4A (Owner decided 2026-10-06) — a pin does not stop it: it runs only once a person approves it, as his own click.
  const currentBidCents = target.bidCents ?? 0
  // The bid that lands: the CPC ceiling first (as the bid routes apply it), then the campaign's max-change guardrail.
  // W1-5 — the largest change is the lower of the campaign's and the ads strategy's for the target's ad group, the same
  // step the write takes (stepClamp); the write gate below judges the band of the ad group's products.
  const { entries, clamps } = await clampBidsByCeiling([{ adTargetId: target.id, bidCents: proposedBidCents }])
  const strategy = await bidLimitsFor({ marketplace: campaign.marketplace, adGroupId: target.adGroupId, campaignId: campaign.id })
  const step = stepClamp(currentBidCents, entries[0].bidCents, campaign.dynamicBidding, strategy)
  const effectiveBidCents = step.cents
  // No-pause: a suppressed bid is never raised here; only restore-campaign lifts a suppression.
  const verdict = suppressionOf({ id: target.id, bidCents: currentBidCents, suppressedFromBidCents: target.suppressedFromBidCents }, effectiveBidCents)
  if (verdict === 'suppressed') {
    return { ok: false, error: `"${target.expressionValue}" is suppressed (no-pause floor, its bid before was ${target.suppressedFromBidCents}c): it is not raised here. Restoring the campaign lifts it.` }
  }
  if (verdict === 'low-unflagged') {
    return { ok: false, error: `"${target.expressionValue}" sits at ${currentBidCents}c, the floor another path lowered it to: it is not raised here.` }
  }
  const reach = await checkLiveReach({
    campaignId: campaign.id,
    adGroupId: target.adGroupId,
    marketplace: campaign.marketplace,
    changes: [{ field: 'bid', valueCents: effectiveBidCents }],
  })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const currency = campaignCurrency(campaign)
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(campaign.id)
  // AA-W2-6 — the bid that lands, against the ads strategy of the target's ad group and Claude's limits, and the write
  // gate as it judges a run by rule.
  const rule = opts.rule
    ? await ruleFactsFor({
      tool: 'set-target-bid',
      limits: TARGET_BID_LIMITS,
      items: [{ entity: { kind: 'target', id: target.id }, change: { field: 'bid', fromCents: currentBidCents, toCents: effectiveBidCents } }],
      writes: [{ label: `campaign "${campaign.name}"`, campaignId: campaign.id, adGroupId: target.adGroupId, marketplace: campaign.marketplace, changes: [{ field: 'bid', valueCents: effectiveBidCents }] }],
      approvalId: opts.rule.approvalId,
    })
    : null
  return {
    ok: true,
    preview: {
      action: 'set-target-bid',
      target: { id: target.id, expression: target.expressionValue, matchType: target.expressionType },
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      currency,
      currentBidCents,
      proposedBidCents,
      ...(effectiveBidCents !== proposedBidCents ? { effectiveBidCents, clampedBy: clamps.length ? 'the campaign\'s CPC ceiling' : stepClampWords(step, strategy) } : {}),
      deltaCents: effectiveBidCents - currentBidCents,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...(rule ?? {}),
      ...sourcePreview(changeSource),
      effect: `Moves "${target.expressionValue}" from ${amountLabel(currentBidCents, currency)} to ${amountLabel(effectiveBidCents, currency)} in ${campaign.name}.`,
    },
  }
}

/** A4 — the starting values an approved bid change must still find (MATERIAL_PREVIEW_FIELDS holds the same list). */
const TARGET_BID_MATERIAL = ['currentBidCents', 'effectiveBidCents', 'reach'] as const

/**
 * C2 — undo of a bid change: set the bid it replaced, through set-target-bid itself (the same guards, preview,
 * approval). Refused while the bid is no longer the one it wrote. The change set it wrote stays in the ads audit.
 */
export const SET_TARGET_BID_UNDO: ToolUndo = {
  async current(change) {
    const targetId = String((change.after as { targetId?: unknown } | null)?.targetId ?? '')
    const t = await prisma.adTarget.findFirst({ where: { id: targetId }, select: { bidCents: true } })
    return { targetId, bidCents: t?.bidCents ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { targetId?: string; bidCents?: number | null }
    if (!before.targetId) return { refusal: 'This change does not name its target.' }
    if (before.bidCents == null || before.bidCents < BID_FLOOR_CENTS) {
      return { refusal: `The bid before this change (${before.bidCents ?? 'none'}c) is below the ${BID_FLOOR_CENTS}c floor a bid change may set.` }
    }
    return { tool: 'set-target-bid', args: { targetId: before.targetId, proposedBidCents: before.bidCents, why: 'undo of an earlier bid change' } }
  },
  undone: unsettleChange,
}

const setTargetBid: AgentTool = {
  name: 'set-target-bid',
  title: 'Change a target\'s bid',
  input: z.object({
    targetId: z.string().min(1).describe('Nexus ad target id (targetId in ad-targets)'),
    proposedBidCents: z.coerce.number().describe('new bid in minor units (cents) of the campaign\'s currency, at least 5'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
    source: sourceArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  restrictedFields: LIMIT_FACTS_MONEY as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A4 — an approved bid change is sent to Amazon (live) after the 5-minute cancel window.
  openWorld: true,
  reversibility: 'full',
  // AA-W2-6 — the business may let it run by its rule, only inside its limits and the ads strategy where it lands.
  maxClaudeTrust: 'auto',
  strategyBound: 'amazon-ads',
  limits: TARGET_BID_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits),
  undo: SET_TARGET_BID_UNDO,
  description:
    'Change one keyword or target bid on an Amazon Sponsored Products campaign. Nothing changes until a person approves '
    + 'it: in Nexus, or the person who asked confirms it in Claude with their authenticator code when the business set it '
    + 'so — unless the business lets it run by its rule, inside its limits and the ads strategy where it lands (by '
    + 'default only a cut; a raise waits for a person). The preview shows the current and new bid in the campaign\'s '
    + 'currency (after the campaign\'s CPC ceiling and max-change guardrail), whether it lands live at Amazon or in '
    + 'sandbox, the rules that may move it again, and each limit with where it comes from. Refused, and not queued, when '
    + 'Amazon\'s write gate would refuse it, or when it would raise a suppressed (no-pause) bid. Run by rule, it is also '
    + 'held by the live-write allowlist, pins and the campaign\'s own bid bounds. Once approved it runs as the approver; '
    + 'undo-change puts the old bid back.',
  async handler(args, ctx) {
    return targetBidPreview(args, { rule: { approvalId: ctx.approvalId } })
  },
  async execute(args, ctx) {
    const fresh = await targetBidPreview(args)
    const refusal = recheck(ctx, fresh, TARGET_BID_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { target: { id: string; expression: string }; currentBidCents: number; proposedBidCents: number; effectiveBidCents?: number; reach: unknown; effect: string; currency: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const newBidCents = p.effectiveBidCents ?? p.proposedBidCents
    const changeSource = sourceOf(args.source)
    const out = await updateAdTargetWithSync({
      adTargetId: p.target.id,
      patch: { bidCents: newBidCents },
      actor: run.actor,
      reason: run.reason,
      changeSetId: run.changeSetId,
      manual: run.manual, // 4A
      confirmOwnLimits: run.confirmOwnLimits, // 4A
      ...(changeSource ? { evidence: withSource(null, changeSource) } : {}), // W3-1
    })
    if (!out.ok) return notRun(`Not run: the bid write was refused (${out.error ?? 'unknown'}). Nothing changed.`)
    await settleSources([changeSource], run.changeSetId)
    const written = await prisma.adTarget.findFirst({ where: { id: p.target.id }, select: { bidCents: true } })
    const after = written?.bidCents ?? newBidCents
    return {
      ok: true,
      data: {
        changed: out.error !== 'no_changes',
        targetId: p.target.id,
        bidCents: after,
        currency: p.currency,
        reach: p.reach,
        changeSetId: run.changeSetId,
        outboundQueueId: out.outboundQueueId,
        actionLogId: out.actionLogId,
        note: out.outboundQueueId ? 'Queued for Amazon: it is sent after the 5-minute cancel window. approval-status follows it.' : 'The bid was already this value: nothing was queued.',
      },
      ...(out.error === 'no_changes'
        ? {}
        : {
            change: {
              before: { targetId: p.target.id, bidCents: p.currentBidCents, changeSetId: run.changeSetId, ...sourcesRecord([changeSource]) },
              after: { targetId: p.target.id, bidCents: after },
            },
          }),
    }
  },
}

export const ADS_PROPOSE_TOOLS: AgentTool[] = [
  createNegativeKeyword,
  graduateKeyword,
  setTargetBid,
]
