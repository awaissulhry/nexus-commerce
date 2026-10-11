/**
 * NAF.C — the fleet's ads tools (plan C-D1), shared with Claude (MCP full control d1 = A). `handler` is a
 * deterministic dry-run built from the same checks the write path enforces (protected terms, authority pins,
 * isNegative-only existing-negative reads); hard denials return ok:false so the approval gate never queues them.
 *
 * MCP full control A5 — `create-negative-keyword` (ad-group negatives only, through the one negative write service, which
 * binds the campaign's allowlist) executes too, with the same rules; a negative is undone by undo-ad-change retiring it.
 * Keyword Harvest page rebuild (lane HMCP, 2026-10-11) — `graduate-keyword` is a door onto the ONE harvest engine
 * (ads-harvest-alias.ts): the same change set, approval, run and undo as apply-harvest (the keyword, the negative exact in
 * every source of the product, the funnel blocks; undo lifts the blocks, then pauses the keyword); always a person.
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
 * AA-W2-7 — `create-negative-keyword` too: a negative runs by rule only for a term whose record over the strategy's
 * window meets its "Negate a search term when" group where it lands (exact negatives only, unless the business allows
 * phrase). Protected terms and protected products' ASINs are never negated by rule.
 *
 * ADS AUTONOMY W3-1 — all three take an optional `source` (ads-change-source.ts): the engine recommendation the change
 * carries out (apply-ad-recommendations sets it). It must name this change's own recommendation; it is kept in the
 * preview and on the ads audit row, and once the write ran the recommendation is settled (not offered again until the
 * data shows what the change did).
 *
 * ADS AUTONOMY W4-4 — `set-target-bid`: a person's approval sends the bid asked for, past the largest change per action
 * after the card's warning (as a budget past the daily move, #401); a run by rule writes the stepped bid, as before
 * (ads-change-kit.ts bidStepOf). `afterwards: 'auto-bid'` hands the bid back to auto-bid instead of holding it 60 days.
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
import { adsProfileFor } from '../../advertising/ads-profile-resolver.js'
import { adGroupCampaigns, adGroupsByExternalId, adGroupsOfCampaign } from '../../advertising/ads-entity-lookup.service.js'
import { targetingAdGroups } from '../../advertising/ads-targeting-lookup.service.js'
import { clampBidsByCeiling } from '../../advertising/ads-cpc-ceiling.js'
import { amountLabel, campaignCurrency, checkLiveReach, suppressionOf } from './ads-tool-guards.js'
import { afterwardsArg, afterwardsNote, afterwardsOf, alsoChangedBy, approvedRun, bidStepOf, handBackEvidence, handBackRefusal, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, adWriteRefusalOf, bidWriteOf, stepClampWords, storedReach, withStepPast, type BidAfterwards, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, LIMIT_FACTS_MONEY, limitFactsOf, STEP_PCT_LIMITS, type LimitFacts, type ScopeFacts } from './ads-autonomy-kit.js'
import { bidLimitsFor } from '../../advertising/ads-strategy/bids.js'
import { HARVEST_MONEY } from '../../advertising/harvest/constants.js'
import { DEFAULT_MIN_ORDERS, DEFAULT_WINDOW_DAYS, meetsHarvest } from '../../advertising/ads-harvest.service.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { notOfferedRefusal, recommendationIdFor, settleSources, sourceArg, sourceOf, sourcePreview, sourceRefusal, sourcesRecord, unsettleChange, withSource } from './ads-change-source.js'
import { ALIAS, aliasExecute, aliasPreview, aliasUndo, candidateInCampaign, type EngineItem } from './ads-harvest-alias.js'
import type { AgentTool, FieldPermission, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'

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
  /** Batch 2 review fix — where the Owner's harvest destination may be stored (the portfolio grain). */
  portfolioId: string | null
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
      portfolioId: true,
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

// ── graduate-keyword (Keyword Harvest page rebuild, lane HMCP: a door onto the harvest engine) ─────────────────

const GRADUATE_INPUT = z.object({
  query: z.string().trim().min(1).describe('the search term to harvest (query in ad-search-terms)'),
  sourceExternalCampaignId: z.string().min(1).describe('Amazon campaign id it converted in: it names the product whose own campaigns the term goes into (every ad group of that product where it ran is a source)'),
  sourceExternalAdGroupId: z.string().optional().describe('Amazon ad group id it converted in (checked to be in that campaign; needed with source)'),
  destExternalCampaignId: z.string().min(1).optional().describe('campaign to add it to (Amazon id): its one serving ad group, unless destExternalAdGroupId names one (default: the suggested place)'),
  destExternalAdGroupId: z.string().optional().describe('ad group to add it to (Amazon id; one of the product\'s own: harvest-destinations) (default: the suggested place)'),
  bidCents: z.coerce.number().int().min(2).max(10_000).optional().describe('start bid in minor units of the market\'s currency (default: the bid brain\'s goal bid, else the term\'s cost per click inside the strategy\'s bid limits)'),
  negateSource: z.boolean().optional().describe('false leaves the sources running; true blocks them even where the Owner\'s saved harvest place says not to (default: the negative exact in every source, unless his saved place says not to)'),
  funnel: z.boolean().optional().describe('false leaves the funnel blocks out (default: negative exact in the product\'s phrase, broad and auto ad groups)'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
  source: sourceArg,
})
type GraduateArgs = z.infer<typeof GRADUATE_INPUT>

/** The engine's change set a graduation is: the candidate its source campaign names, and the place it names. */
async function graduationEngineArgs(a: GraduateArgs): Promise<{ args: { op: 'harvest'; items: EngineItem[]; why?: string }; source: CampaignRow; destGroupWhy: string | null } | { refusal: string }> {
  const query = a.query.trim()
  const changeSource = sourceOf(a.source)
  const sourceGroupId = a.sourceExternalAdGroupId?.trim() ?? ''
  // W3-1 — a source names this term's own graduation recommendation (the ad group it converted in), or it is refused.
  const wrongSource = sourceRefusal(changeSource, recommendationIdFor.graduate(sourceGroupId, query))
  if (wrongSource) return { refusal: wrongSource }
  const source = await campaignByExternalId(a.sourceExternalCampaignId)
  if (!source) return { refusal: `campaign ${a.sourceExternalCampaignId} not found` }
  if (sourceGroupId && !(await adGroupInCampaign(sourceGroupId, source.id))) return { refusal: `the source's ad group ${sourceGroupId} is not in campaign ${source.name}, where the term converted` }
  if (changeSource) {
    if (!sourceGroupId) return { refusal: 'a graduation that carries a recommendation names the ad group the term converted in (sourceExternalAdGroupId)' }
    const notOffered = await notOfferedRefusal(changeSource)
    if (notOffered) return { refusal: notOffered }
  }
  const cand = await candidateInCampaign(source.id, query)
  if ('refusal' in cand) return cand
  // The place named, by Amazon's ids: an ad group, or a campaign's one serving ad group.
  let to: { adGroupId: string } | undefined
  let destGroupWhy: string | null = null
  const destGroupExt = a.destExternalAdGroupId?.trim() ?? ''
  const destCampaignExt = a.destExternalCampaignId?.trim() ?? ''
  if (destGroupExt) {
    const g = (await adGroupsByExternalId([destGroupExt])).get(destGroupExt)
    if (!g) return { refusal: `ad group ${destGroupExt} not found` }
    if (destCampaignExt) {
      const dest = await campaignByExternalId(destCampaignExt)
      if (!dest || (await adGroupCampaigns([g.id])).get(g.id)?.id !== dest.id) return { refusal: `ad group ${destGroupExt} is not in campaign ${destCampaignExt}` }
    }
    to = { adGroupId: g.id }
    destGroupWhy = 'named in the request'
  } else if (destCampaignExt && destCampaignExt !== a.sourceExternalCampaignId) {
    const dest = await campaignByExternalId(destCampaignExt)
    if (!dest) return { refusal: `campaign ${destCampaignExt} not found` }
    const groups = (await targetingAdGroups((await adGroupsOfCampaign(dest.id)).map((g) => g.id))).filter((g) => String(g.status) !== 'ARCHIVED')
    const serving = groups.filter((g) => String(g.status) === 'ENABLED')
    const one = serving.length === 1 ? serving[0] : groups.length === 1 ? groups[0] : null
    if (!one) return { refusal: `campaign ${dest.name} has ${groups.length} ad groups: name the one (destExternalAdGroupId), or leave the place to the engine` }
    to = { adGroupId: one.id }
    destGroupWhy = `the one ad group of the campaign named`
  }
  const item: EngineItem = {
    candidateId: cand.candidateId, match: 'EXACT',
    ...(to ? { to } : {}),
    ...(a.bidCents != null ? { bidCents: a.bidCents } : {}),
    ...(a.negateSource != null ? { negateSource: a.negateSource } : {}),
    ...(a.funnel != null ? { funnel: a.funnel } : {}),
  }
  return { args: { op: 'harvest', items: [item], ...(a.why ? { why: a.why } : {}) }, source, destGroupWhy }
}

/** What an approver of a graduation reads on its card (and the fleet re-checks): the keyword, its place, its bid. */
function graduationCard(query: string, destGroupWhy: string | null) {
  return (preview: Record<string, unknown>) => {
    const item = (Array.isArray(preview.items) ? preview.items[0] : null) as { market?: string; bidCents?: number | null; destination?: { kind: string; adGroup?: { id: string; name: string }; campaign?: { id: string; name: string }; key?: string; name?: string; how?: string } | null } | null
    const d = item?.destination
    return {
      query,
      suggestedBidCents: item?.bidCents ?? null,
      destination: d?.kind === 'existing' ? { id: d.campaign?.id ?? null, name: d.campaign?.name ?? null, marketplace: item?.market ?? null } : { id: d?.key ? `new:${d.key}` : null, name: d?.name ?? null, marketplace: item?.market ?? null },
      destinationAdGroup: d?.kind === 'existing' ? { id: d.adGroup?.id ?? null, name: d.adGroup?.name ?? null, why: destGroupWhy ?? d.how ?? null } : null,
      alreadyExact: false,
    }
  }
}

/** What an older graduation (before the engine) holds now, in the shape of its `after` (its undo guard). */
async function legacyGraduationNow(change: ToolChange): Promise<unknown> {
  const targetId = String((change.after as { targetId?: unknown } | null)?.targetId ?? '')
  const t = await prisma.adTarget.findFirst({ where: { id: targetId }, select: { bidCents: true } })
  return { targetId, bidCents: t?.bidCents ?? null }
}

/**
 * C2 — undo of a graduation: the engine's (apply-harvest op undo: its blocks lifted, then its keyword paused); one made
 * before the engine, the same way through harvest-search-term op undo. The recommendation it settled is offered again.
 */
export const GRADUATE_UNDO: ToolUndo = aliasUndo(legacyGraduationNow, unsettleChange)

const parseGraduate = (raw: Record<string, unknown>): GraduateArgs | { error: string } => {
  const parsed = GRADUATE_INPUT.safeParse(raw)
  return parsed.success ? parsed.data : { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
}

const graduateKeyword: AgentTool = {
  name: ALIAS.graduate,
  title: 'Add an exact keyword',
  input: GRADUATE_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: { ...(HARVEST_MONEY as Readonly<Record<string, FieldPermission>>), suggestedBidCents: FIELDS.financialsAdspendView },
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A5 — an approved keyword is created at Amazon at once (no cancel window).
  openWorld: true,
  reversibility: 'partial',
  // The harvest engine's ceiling (apply-harvest): always a person.
  maxClaudeTrust: 'ask',
  undo: GRADUATE_UNDO,
  description:
    'Harvest a converting Amazon Sponsored Products search term as an EXACT keyword, named by Amazon\'s ids of the campaign '
    + '(and ad group) it converted in — the same change set as apply-harvest, from the same harvest engine as the Keyword '
    + 'Harvest page (the engines\' graduation recommendations and the agent fleet ask with this name): the keyword in the ad '
    + 'group named (destExternalAdGroupId, or a campaign\'s one ad group) or its suggested place, at the start bid named or '
    + 'the bid brain\'s goal bid; AND the negative exact in EVERY ad group of the product where the term ran (negateSource '
    + 'false leaves them running; the Owner\'s saved negateAtSource=false wins unless the request says true); AND the funnel '
    + 'blocks (negative exact in the product\'s phrase, broad and auto ad groups; funnel false leaves them out) — one '
    + 'approval. Nothing changes until a person approves it in Nexus; it never runs by rule, and Claude cannot approve it. '
    + 'Refused, and not queued, when the term has no product of its own there, is a keyword of the product already, is '
    + 'harvested or waiting already, or Amazon\'s write gate would refuse it. Undo (undo-change) lifts the blocks it added, '
    + 'then pauses its keyword (never archived). For several terms, a phrase keyword, a new campaign or a new portfolio: '
    + 'apply-harvest.',
  async handler(args, ctx) {
    const a = parseGraduate(args)
    if ('error' in a) return { ok: false, error: a.error }
    const e = await graduationEngineArgs(a)
    if ('refusal' in e) return { ok: false, error: `Not queued: ${e.refusal}.` }
    const changeSource = sourceOf(a.source)
    return aliasPreview(ALIAS.graduate, e.args, ctx, { query: a.query, sourceExternalCampaignId: a.sourceExternalCampaignId, candidateId: e.args.items[0].candidateId }, (p) => ({
      ...graduationCard(a.query.trim(), e.destGroupWhy)(p),
      currency: campaignCurrency(e.source),
      ...sourcePreview(changeSource),
    }))
  },
  async execute(args, ctx) {
    const a = parseGraduate(args)
    if ('error' in a) return notRun(`Not run: ${a.error}.`)
    const e = await graduationEngineArgs(a)
    if ('refusal' in e) return notRun(`Not run: ${e.refusal}.`)
    const out = await aliasExecute(e.args, ctx)
    if (!out.ok || !out.change) return out
    const changeSource = sourceOf(a.source)
    await settleSources([changeSource], ctx.approvalId)
    return { ...out, change: { ...out.change, before: { ...(out.change.before as Record<string, unknown>), ...sourcesRecord([changeSource]) } } }
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
      kind: true, // W4-11 — which Sponsored Brands / Display bids Nexus sends
      adGroupId: true,
      adGroup: {
        select: {
          campaign: {
            select: {
              id: true,
              name: true,
              type: true,
              adProduct: true,
              costType: true, // W4-11 — SB/SD bids only in a campaign that pays per click
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
  // W4-11 — a Sponsored Brands keyword or product target, or a Sponsored Display target, takes a bid too (their endpoints).
  const bidWrite = bidWriteOf(target.kind)
  const notSp = adWriteRefusalOf(campaign, bidWrite)
  if (notSp) return { ok: false, error: notSp }
  // 4A (Owner decided 2026-10-06) — a pin does not stop it: it runs only once a person approves it, as his own click.
  const currentBidCents = target.bidCents ?? 0
  const currency = campaignCurrency(campaign)
  // The bid that lands: the CPC ceiling first (as the bid routes apply it), then the largest change per action.
  // W1-5 — the largest change is the lower of the campaign's and the ads strategy's for the target's ad group, the same
  // step the write takes (stepClamp); the write gate below judges the band of the ad group's products.
  // W4-4 — the step is his own limit: a person's approval sends the bid asked for (the card warns him past the step);
  // a run by rule writes the stepped bid, as before (bidStepOf).
  const { entries, clamps } = await clampBidsByCeiling([{ adTargetId: target.id, bidCents: proposedBidCents }])
  const strategy = await bidLimitsFor({ marketplace: campaign.marketplace, adGroupId: target.adGroupId, campaignId: campaign.id })
  const step = bidStepOf({ currentCents: currentBidCents, wantedCents: entries[0].bidCents, dynamicBidding: campaign.dynamicBidding, strategy, label: `"${target.expressionValue}"`, currency })
  const effectiveBidCents = step.personCents
  const byRuleBidCents = step.ruleCents
  const afterwards = afterwardsOf(args.afterwards)
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
    write: bidWrite,
  })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  // W4-4 — past the largest change the card warns him, where it warns about his other own limits (#401).
  const stored = withStepPast(storedReach(reach), [step.past])
  const bound = await alsoChangedBy(campaign.id)
  const stepped = byRuleBidCents !== effectiveBidCents ? stepClampWords(step.step, strategy) : null
  // AA-W2-6 — the bid a run by rule writes (W4-4: the stepped one), against the ads strategy of the target's ad group
  // and Claude's limits, and the write gate as it judges a run by rule. W4-4 — the gate is asked about the bid asked for
  // too: a rule never decides a request whose card warns about another of his own limits; a person does.
  const rule = opts.rule
    ? await ruleFactsFor({
      tool: 'set-target-bid',
      limits: TARGET_BID_LIMITS,
      items: [{ entity: { kind: 'target', id: target.id }, change: { field: 'bid', fromCents: currentBidCents, toCents: byRuleBidCents } }],
      writes: [...new Set([byRuleBidCents, effectiveBidCents])].map((valueCents) => ({
        label: `campaign "${campaign.name}"`, campaignId: campaign.id, adGroupId: target.adGroupId, marketplace: campaign.marketplace, changes: [{ field: 'bid', valueCents }], write: bidWrite,
      })),
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
      // W4-4 — always the bid a person's approval sends (a request stepped before W4-4 then reads "from €0.54 to €0.90").
      effectiveBidCents,
      ...(effectiveBidCents !== proposedBidCents ? { clampedBy: 'the campaign\'s CPC ceiling' } : {}),
      deltaCents: effectiveBidCents - currentBidCents,
      // W4-4 — what a run by the business's rule writes instead: the bid stepped to the largest change (as before).
      byRuleBidCents,
      ...(stepped ? { byRuleSteppedBy: stepped } : {}),
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...(rule ?? {}),
      ...sourcePreview(changeSource),
      afterwards,
      afterwardsNote: afterwardsNote(afterwards),
      effect: `Moves "${target.expressionValue}" from ${amountLabel(currentBidCents, currency)} to ${amountLabel(effectiveBidCents, currency)} in ${campaign.name}`
        + (stepped ? `; run by the business's rule instead, only to ${amountLabel(byRuleBidCents, currency)} (${stepped}).` : '.'),
    },
  }
}

/**
 * A4 — the starting values an approved bid change must still find (MATERIAL_PREVIEW_FIELDS holds the same list). W4-4 —
 * and the bid a run by rule writes, and what auto-bid does with the bid afterwards.
 */
const TARGET_BID_MATERIAL = ['currentBidCents', 'effectiveBidCents', 'byRuleBidCents', 'afterwards', 'reach'] as const

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
    afterwards: afterwardsArg, // W4-4
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
  // W4-4 — a hand-back to auto-bid never runs by rule.
  withinLimits: (preview, limits) => handBackRefusal(preview) ?? ruleRefusal(preview, limits),
  undo: SET_TARGET_BID_UNDO,
  description:
    'Change one keyword or target bid on an Amazon Sponsored Products campaign, or a Sponsored Brands keyword or product '
    + 'target or a Sponsored Display target in a campaign that pays per click. Nothing changes until a person approves '
    + 'it: in Nexus, or the person who asked confirms it in Claude with their authenticator code when the business set it '
    + 'so — unless the business lets it run by its rule, inside its limits and the ads strategy where it lands (by '
    + 'default only a cut; a raise waits for a person). The preview shows the current and new bid in the campaign\'s '
    + 'currency (after the campaign\'s CPC ceiling), whether it lands live at Amazon or in '
    + 'sandbox, the rules that may move it again, and each limit with where it comes from. A bid that moves more than '
    + 'the largest bid change per action (the campaign\'s max-change guardrail or the ads strategy\'s, the lower one) is '
    + 'warned on the approval card, and a person\'s approval sends it as asked; run by rule it moves only as far as the '
    + 'largest change allows (byRuleBidCents). afterwards: "hold" (default) — auto-bid then leaves the bid alone for 60 '
    + 'days, as a person\'s; "auto-bid" — handed back, auto-bid may move it from its next run. Refused, and not queued, when '
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
    const p = fresh.preview as {
      target: { id: string; expression: string }; currentBidCents: number; proposedBidCents: number; effectiveBidCents?: number; byRuleBidCents: number
      afterwards: BidAfterwards; reach: unknown; effect: string; currency: string
    }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    // W4-4 — a person's approval (his manual mark, from the approval door) sends the bid asked for: the card warned him
    // past the largest change. A run by rule writes the stepped bid, as before; the mutation layer steps any bid without
    // his mark anyway, whatever is sent.
    const newBidCents = run.manual ? (p.effectiveBidCents ?? p.proposedBidCents) : p.byRuleBidCents
    const changeSource = sourceOf(args.source)
    const evidence = handBackEvidence(changeSource ? withSource(null, changeSource) : null, p.afterwards) // W3-1, W4-4
    const out = await updateAdTargetWithSync({
      adTargetId: p.target.id,
      patch: { bidCents: newBidCents },
      actor: run.actor,
      reason: run.reason,
      changeSetId: run.changeSetId,
      manual: run.manual, // 4A
      confirmOwnLimits: run.confirmOwnLimits, // 4A
      allowSbSd: true, // W4-11 — an SB/SD keyword's or target's bid goes to its own endpoint
      ...(evidence ? { evidence } : {}),
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
        afterwards: p.afterwards,
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
