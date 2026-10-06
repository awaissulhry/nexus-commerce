/**
 * ADS AUTONOMY W2 (AA-W2-10) — decide-automation-suggestions may run by the business's rule: inside the ads strategy
 * where each applied suggestion lands (ads-autonomy-kit.ts, C1–C7) AND the tool's own limits per family of suggestion.
 * Design: agent-results/5 §3a (its row), §2.6.
 *
 *   facts      `suggestionLimitFacts` (the dry run): each apply as the kit's item — the bid, budget or placement it
 *              would set, measured as the rule's own handler computes it (automation-action-handlers.ts: the same
 *              defaults, the budget's baseline anchor, the rule's own min and max), a negative, or a new keyword with
 *              the starting bid it would get — plus each family's largest move (`suggestions`). The rule that proposed
 *              a change is not counted as an engine that also moves its campaign (C4).
 *   unjudged   an apply Nexus cannot measure before it runs — a sweep across a market or the account, a bid the rule
 *              computes from measured performance, a keyword whose starting bid follows the term's cost per click, a
 *              family outside bids, budgets, placements, negatives and new keywords — is never inside: a person decides.
 *   limits     the kit's (items per request, changes of one entity a day, engine-owned) and a raise and a cut per family;
 *              each raise defaults to 0, and so does a new keyword's starting bid: until a person types a number, only
 *              cuts, negatives, dismissals and restores run alone.
 *   eBay       the ads strategy covers Amazon: an eBay proposal always waits for a person.
 *
 * A dismissal or a restore changes a suggestion row in Nexus only: it is counted in the request's size, never as an ad
 * change.
 */
import { z } from 'zod'
import prisma from '../../../db.js'
import type { DecisionItem } from '../../advertising/ads-suggestion-decide.service.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitsNote, measure, type KitChange, type KitItem, type LimitFacts } from './ads-autonomy-kit.js'
import { amountLabel } from './ads-tool-guards.js'

const A_PERSON = 'a person decides'

/** The limits of decide-automation-suggestions (`AgentTool.limits`), named by the `limitsTighten` convention. */
export const SUGGESTION_LIMITS = adKitLimits({ maxItems: 25 }, {
  maxBidRaisePct: z.number().min(0).max(100).default(0)
    .describe('the largest bid raise, in percent, an applied suggestion may make without a person; 0 = every bid raise waits for a person'),
  maxBidCutPct: z.number().min(0).max(100).default(100)
    .describe('the largest bid cut, in percent, an applied suggestion may make without a person (the ads strategy also bounds it)'),
  maxBudgetRaisePct: z.number().min(0).max(1000).default(0)
    .describe('the largest daily budget raise, in percent, an applied suggestion may make without a person; 0 = every budget raise waits for a person'),
  maxBudgetCutPct: z.number().min(0).max(100).default(100)
    .describe('the largest daily budget cut, in percent, an applied suggestion may make without a person'),
  maxPlacementRaisePoints: z.number().min(0).max(900).default(0)
    .describe('the largest placement raise, in percentage points, an applied suggestion may make without a person; 0 = every placement raise waits for a person'),
  maxPlacementCutPoints: z.number().min(0).max(900).default(100)
    .describe('the largest placement cut, in percentage points, an applied suggestion may make without a person'),
  maxStartBidCents: z.number().int().min(0).max(100_000).default(0)
    .describe('the highest starting bid (cents of the campaign\'s currency) of a new keyword or product target an applied suggestion may create without a person; 0 = every new keyword waits for a person'),
})

/** Each family's largest move in one request, and what Nexus could not measure. Stored in the preview (`suggestions`). */
export interface SuggestionRuleFacts {
  /** Every decision of the request: applies, dismissals and restores. */
  decisions: number
  applies: number
  /** Applies Nexus cannot measure before they run: never inside. */
  unjudged: number
  firstUnjudged: string | null
  bids: { raises: number; largestRaisePct: number; largestCutPct: number }
  budgets: { raises: number; largestRaisePct: number; largestCutPct: number }
  placements: { raises: number; largestRaisePoints: number; largestCutPoints: number }
  newKeywords: { count: number; highestStartBid: { cents: number; currency: string } | null }
}

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {})
const num = (value: unknown): number | null => (value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null)
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const round2 = (n: number) => Math.round(n * 100) / 100
const clampRange = (x: number, min: number, max: number | null) => Math.min(max ?? Infinity, Math.max(min, x))

/** The builder's arithmetic (automation-action-handlers.ts applyBuilderOp); null for an op it does not know. */
function builderOp(op: unknown, current: number, value: number): number | null {
  switch (op) {
    case 'set': case 'setValue': return value
    case 'incPct': return current * (1 + value / 100)
    case 'decPct': return current * (1 - value / 100)
    case 'incAbs': return current + value
    case 'decAbs': return current - value
    default: return null
  }
}

/**
 * The bid a bids-family action would set on a target, in cents, as its handler computes it before the write path's own
 * clamps (the strategy's band, the campaign's step and CPC ceiling only lower or hold it); null when the rule computes
 * it from measured performance (or does not say). Pure.
 */
export function appliedBidCents(action: Obj, currentCents: number): number | null {
  const type = String(action.type ?? '')
  const pct = (fallback: number) => Math.abs(num(action.percent) ?? fallback)
  if (type === 'bid_down') return Math.max(5, Math.round(currentCents * (1 - pct(20) / 100)))
  if (type === 'bid_up') return Math.max(5, Math.round(currentCents * (1 + pct(15) / 100)))
  if (type === 'lower_bid_to_floor') return Math.max(5, num(action.floorCents) ?? 5)
  if (type !== 'bid_apply') return null
  const raw = builderOp(action.op, currentCents / 100, num(action.value) ?? 0)
  if (raw == null) return null
  const floorEur = Math.max(0.05, num(action.minEur) ?? 0.05)
  return Math.round(round2(clampRange(raw, floorEur, num(action.maxEur))) * 100)
}

/**
 * The daily budget a budget-family action would set, in minor units, as its handler computes it — a relative change
 * anchored to the campaign's baseline when one is captured (BUD.2), the €1 floor, the rule's own min and max. Pure.
 */
export function appliedBudgetCents(action: Obj, campaign: { dailyBudgetCents: number; baselineCents: number | null }): number | null {
  const type = String(action.type ?? '')
  const current = campaign.dailyBudgetCents / 100
  const anchor = campaign.baselineCents != null ? campaign.baselineCents / 100 : current
  if (type === 'set_daily_budget') {
    const eur = num(action.budgetEur)
    return eur != null && eur >= 1 ? Math.round(eur * 100) : null
  }
  if (type === 'adjust_ad_budget') {
    const set = num(action.newDailyBudget)
    const next = set != null ? set : num(action.percent) != null ? anchor * (1 + num(action.percent)! / 100) : null
    return next == null ? null : Math.round(Math.max(1, round2(next)) * 100)
  }
  if (type !== 'budget_apply') return null
  const raw = builderOp(action.op, anchor, num(action.value) ?? 0)
  if (raw == null) return null
  const minEur = Math.max(1, num(action.minEur) ?? 1)
  return Math.round(round2(clampRange(raw, minEur, num(action.maxEur))) * 100)
}

/** The placement a placement-family action would set, in whole percent (0–900), as its handler computes it. Pure. */
export function appliedPlacementPct(action: Obj, currentPct: number): number | null {
  const type = String(action.type ?? '')
  if (type === 'set_placement_multiplier') return Math.max(0, Math.min(900, Math.round(num(action.percentage) ?? 0)))
  if (type !== 'placement_apply') return null
  const raw = builderOp(action.op, currentPct, num(action.value) ?? 0)
  if (raw == null) return null
  return Math.round(clampRange(raw, Math.max(0, num(action.minPct) ?? 0), Math.min(900, num(action.maxPct) ?? 900)))
}

/**
 * The starting bid a promote_to_exact action gives the keyword it creates, in cents — only when it is a fixed amount
 * (an engine-native action's `bidEur`, or a builder rule whose bid mode is fixed); null when it follows the term's cost
 * per click or the ad group's default, which Nexus cannot know before it runs. Pure.
 */
export function startBidCents(action: Obj): number | null {
  const wire = action.harvest != null
  const bid = obj(action.bid)
  const eur = wire ? (bid.mode === 'fixed' ? num(bid.value) : null) : (num(action.bidEur) ?? 0.5)
  return eur != null && eur > 0 ? Math.round(Math.max(0.02, round2(eur)) * 100) : null
}

/** SEARCH_TERM entity ids are `${externalCampaignId}:${query}` (the query may itself contain ':'). */
function termOf(entityId: string): { ext: string; query: string } {
  const at = entityId.indexOf(':')
  return at >= 0 ? { ext: entityId.slice(0, at), query: entityId.slice(at + 1) } : { ext: entityId, query: '' }
}

function placementOf(dynamicBidding: unknown, placement: string): number {
  const lanes = obj(dynamicBidding).placementBidding
  const lane = Array.isArray(lanes) ? lanes.find((l) => obj(l).placement === placement) : null
  return num(obj(lane).percentage) ?? 0
}

const NEGATIVE_ACTIONS: Record<string, 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'> = { add_negative_exact: 'NEGATIVE_EXACT', add_negative_phrase: 'NEGATIVE_PHRASE' }

/**
 * The facts a decide-automation-suggestions preview stores for its rule: the kit's `limitFacts` of every apply, the
 * families' largest moves (`suggestions`) and the note a person and Claude read. `approvalId`: the request a dry run
 * re-checks (not counted in today's ledger).
 */
export async function suggestionLimitFacts(items: readonly DecisionItem[], approvalId?: string | null): Promise<{ limitFacts: LimitFacts; suggestions: SuggestionRuleFacts; limitsNote: string[] }> {
  const applies = items.filter((i) => i.decide === 'apply')
  const facts: SuggestionRuleFacts = {
    decisions: items.length, applies: applies.length, unjudged: 0, firstUnjudged: null,
    bids: { raises: 0, largestRaisePct: 0, largestCutPct: 0 },
    budgets: { raises: 0, largestRaisePct: 0, largestCutPct: 0 },
    placements: { raises: 0, largestRaisePoints: 0, largestCutPoints: 0 },
    newKeywords: { count: 0, highestStartBid: null },
  }
  const { suggestionSubjects } = await import('../../advertising/ads-suggestion-decide.service.js')
  const rows = await suggestionSubjects(applies.map((i) => i.suggestionId))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))]
  const termCampaigns = [...new Set(rows.filter((r) => r.entityType === 'SEARCH_TERM').map((r) => termOf(r.entityId).ext))]
  const [targets, campaigns, sources] = await Promise.all([
    prisma.adTarget.findMany({ where: { id: { in: ids('AD_TARGET') } }, select: { id: true, bidCents: true } }),
    prisma.campaign.findMany({ where: { id: { in: ids('CAMPAIGN') } }, select: { id: true, dailyBudget: true, budgetBaselineCents: true, dynamicBidding: true } }),
    prisma.campaign.findMany({ where: { externalCampaignId: { in: termCampaigns } }, select: { externalCampaignId: true, dailyBudgetCurrency: true }, orderBy: { id: 'asc' } }),
  ])
  const targetOf = new Map(targets.map((t) => [t.id, t]))
  const campaignOf = new Map(campaigns.map((c) => [c.id, c]))

  const kit: KitItem[] = []
  const unjudged = (item: DecisionItem, why: string) => {
    facts.unjudged++
    facts.firstUnjudged ??= `${item.rule ?? 'a rule'} on ${item.entity}: ${why}`
  }
  const { familyOf } = await import('../../advertising/ads-suggestions.service.js')
  /** Counts a bid's or a budget's move; false for a raise from nothing (it has no percent to hold to a limit). */
  const tally = (bucket: { raises: number; largestRaisePct: number; largestCutPct: number }, change: KitChange): boolean => {
    const m = measure(change)
    if (m.direction === 'raise' && m.pct == null) return false
    if (m.direction === 'raise') { bucket.raises++; bucket.largestRaisePct = Math.max(bucket.largestRaisePct, m.pct ?? 0) }
    if (m.direction === 'cut') bucket.largestCutPct = Math.max(bucket.largestCutPct, m.pct ?? 0)
    return true
  }
  const FROM_NOTHING = 'it raises from nothing, so its raise has no percent to hold to a limit'

  for (const item of applies) {
    const row = byId.get(item.suggestionId)
    if (!row) { unjudged(item, 'it was not found'); continue }
    const action = obj(row.proposedAction)
    const type = String(action.type ?? row.proposedKey.split(':')[0])
    const family = familyOf(type)
    if (family === 'bids') {
      const target = row.entityType === 'AD_TARGET' ? targetOf.get(row.entityId) : undefined
      const to = target ? appliedBidCents(action, target.bidCents) : null
      if (!target || to == null) { unjudged(item, 'Nexus cannot tell the bid it would set before it runs (it acts on more than one target, or computes the bid from measured performance)'); continue }
      const change: KitChange = { field: 'bid', fromCents: target.bidCents, toCents: to }
      if (!tally(facts.bids, change)) { unjudged(item, FROM_NOTHING); continue }
      kit.push({ entity: { kind: 'target', id: target.id }, change })
    } else if (family === 'budget') {
      const c = row.entityType === 'CAMPAIGN' ? campaignOf.get(row.entityId) : undefined
      const from = c ? Math.round(Number(c.dailyBudget) * 100) : null
      const to = c && from != null ? appliedBudgetCents(action, { dailyBudgetCents: from, baselineCents: c.budgetBaselineCents }) : null
      if (!c || from == null || to == null) { unjudged(item, 'Nexus cannot tell the budget it would set before it runs'); continue }
      const change: KitChange = { field: 'dailyBudget', fromCents: from, toCents: to }
      if (!tally(facts.budgets, change)) { unjudged(item, FROM_NOTHING); continue }
      kit.push({ entity: { kind: 'campaign', id: c.id }, change })
    } else if (family === 'placement') {
      const c = row.entityType === 'CAMPAIGN' ? campaignOf.get(row.entityId) : undefined
      const placement = str(action.placement) ?? 'PLACEMENT_TOP'
      const from = c ? placementOf(c.dynamicBidding, placement) : null
      const to = from != null ? appliedPlacementPct(action, from) : null
      if (!c || from == null || to == null) { unjudged(item, 'Nexus cannot tell the placement it would set before it runs'); continue }
      const change: KitChange = { field: 'placementPct', fromPct: from, toPct: to }
      kit.push({ entity: { kind: 'campaign', id: c.id }, change })
      const m = measure(change)
      if (m.direction === 'raise') { facts.placements.raises++; facts.placements.largestRaisePoints = Math.max(facts.placements.largestRaisePoints, m.points ?? 0) }
      if (m.direction === 'cut') facts.placements.largestCutPoints = Math.max(facts.placements.largestCutPoints, m.points ?? 0)
    } else if (family === 'negatives' && row.entityType === 'SEARCH_TERM' && NEGATIVE_ACTIONS[type]) {
      const { ext, query } = termOf(row.entityId)
      const term = str(action.keyword) ?? str(action.query) ?? query
      if (!term) { unjudged(item, 'it names no search term'); continue }
      kit.push({ entity: { kind: 'searchTerm', query: term, externalCampaignId: ext, externalAdGroupId: str(action.externalAdGroupId) }, change: { field: 'negative', term, matchType: NEGATIVE_ACTIONS[type] } })
    } else if (family === 'negatives' && type === 'isolate_product_terms') {
      // PB-7 — a card of one product's isolation negatives: each of its items is one negative into one of that product's
      // own ad groups, judged like any negative (a protected term waits for a person).
      const negatives = (Array.isArray(action.items) ? action.items : []).map(obj)
        .map((i) => ({ term: str(i.text), adGroupId: str(i.adGroupId), matchType: i.match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' }))
        .filter((i): i is { term: string; adGroupId: string; matchType: string } => !!i.term && !!i.adGroupId)
      if (!negatives.length) { unjudged(item, 'it lists no negative'); continue }
      for (const n of negatives) kit.push({ entity: { kind: 'adGroup', id: n.adGroupId }, change: { field: 'negative', term: n.term, matchType: n.matchType } })
    } else if (family === 'new-keywords' && row.entityType === 'SEARCH_TERM' && type === 'promote_to_exact') {
      const { ext, query } = termOf(row.entityId)
      const cents = startBidCents(action)
      if (cents == null) { unjudged(item, 'its starting bid follows the term\'s cost per click or the ad group\'s default bid, which Nexus cannot know before it runs'); continue }
      kit.push({ entity: { kind: 'searchTerm', query: str(action.query) ?? query, externalCampaignId: ext, externalAdGroupId: str(action.adGroupId) }, change: { field: 'bid', fromCents: null, toCents: cents } })
      facts.newKeywords.count++
      if (cents > (facts.newKeywords.highestStartBid?.cents ?? -1)) {
        facts.newKeywords.highestStartBid = { cents, currency: sources.find((s) => s.externalCampaignId === ext)?.dailyBudgetCurrency?.trim() || 'EUR' }
      }
    } else {
      unjudged(item, family === 'negatives' || family === 'new-keywords'
        ? 'it acts across a market or the account, not on one search term'
        : `a ${type} suggestion is not one the business's rule may apply (bids, budgets, placements, negatives and new keywords only)`)
    }
  }
  const limitFacts = await buildLimitFacts({
    tool: 'decide-automation-suggestions', items: kit, approvalId, projectMonth: true,
    exceptIds: [...new Set(rows.map((r) => r.ruleId))],
  })
  return { limitFacts, suggestions: facts, limitsNote: [...limitsNote(limitFacts), ...suggestionNote(facts)] }
}

/** The families' lines of the note. */
function suggestionNote(f: SuggestionRuleFacts): string[] {
  const lines = [`Suggestions: ${f.decisions} decided, ${f.applies} applied; ${f.unjudged} Nexus cannot measure before they run${f.firstUnjudged ? ` — first: ${f.firstUnjudged}` : ''}.`]
  if (f.bids.raises || f.bids.largestCutPct) lines.push(`Bids: largest raise ${f.bids.largestRaisePct} %, largest cut ${f.bids.largestCutPct} %.`)
  if (f.budgets.raises || f.budgets.largestCutPct) lines.push(`Daily budgets: largest raise ${f.budgets.largestRaisePct} %, largest cut ${f.budgets.largestCutPct} %.`)
  if (f.placements.raises || f.placements.largestCutPoints) lines.push(`Placements: largest raise ${f.placements.largestRaisePoints} points, largest cut ${f.placements.largestCutPoints} points.`)
  if (f.newKeywords.count) lines.push(`New keywords: ${f.newKeywords.count}${f.newKeywords.highestStartBid ? `, highest starting bid ${amountLabel(f.newKeywords.highestStartBid.cents, f.newKeywords.highestStartBid.currency)}` : ''}.`)
  return lines
}

type Limits = Record<string, unknown>
const limitOf = (limits: Limits, key: string, fallback: number) => (typeof limits[key] === 'number' ? (limits[key] as number) : fallback)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Is this decide-automation-suggestions preview inside the business's rule? The kit's checks C1–C7 first, then the
 * request's size, what Nexus could not measure, and each family's limit. Pure: null when inside, else the sentence.
 */
export function suggestionRefusal(preview: unknown, limits: Limits): string | null {
  const p = preview as { kind?: unknown; suggestions?: SuggestionRuleFacts } | null
  if (p?.kind === 'ebay-ads') return `an eBay proposal is not decided by rule: the ads strategy covers Amazon, so ${A_PERSON}`
  const common = commonRefusal(preview, limits)
  if (common) return common
  const f = p?.suggestions
  if (!f || typeof f !== 'object' || !f.bids || !f.budgets || !f.placements || !f.newKeywords) return `there are no suggestion facts in this preview; ${A_PERSON}`
  const items = limitOf(limits, 'maxItems', 0)
  if (f.decisions > items) return `it decides ${plural(f.decisions, 'suggestion')}, more than the ${items} this tool's limits allow in one request run by rule; ${A_PERSON}`
  if (f.unjudged) return `${f.firstUnjudged ?? 'an apply Nexus cannot measure'}${f.unjudged > 1 ? ` (and ${plural(f.unjudged - 1, 'more')})` : ''}; ${A_PERSON}`
  const over = (moved: number, key: string, unit: string, what: string) => {
    const max = limitOf(limits, key, 0)
    return moved > max ? `its largest ${what} is ${moved}${unit}, more than the ${max}${unit} this tool's limits let run without a person${max === 0 ? ` (0: every ${what} waits for a person)` : ''}; ${A_PERSON}` : null
  }
  const start = f.newKeywords.highestStartBid
  const maxStart = limitOf(limits, 'maxStartBidCents', 0)
  return over(f.bids.largestRaisePct, 'maxBidRaisePct', ' %', 'bid raise')
    ?? over(f.bids.largestCutPct, 'maxBidCutPct', ' %', 'bid cut')
    ?? over(f.budgets.largestRaisePct, 'maxBudgetRaisePct', ' %', 'budget raise')
    ?? over(f.budgets.largestCutPct, 'maxBudgetCutPct', ' %', 'budget cut')
    ?? over(f.placements.largestRaisePoints, 'maxPlacementRaisePoints', ' points', 'placement raise')
    ?? over(f.placements.largestCutPoints, 'maxPlacementCutPoints', ' points', 'placement cut')
    ?? (f.newKeywords.count && (!start || start.cents > maxStart)
      ? `it creates ${plural(f.newKeywords.count, 'new keyword')}${start ? ` starting at up to ${amountLabel(start.cents, start.currency)}` : ''}, above the ${amountLabel(maxStart, start?.currency ?? 'EUR')} this tool's limits allow without a person${maxStart === 0 ? ' (0: every new keyword waits for a person)' : ''}; ${A_PERSON}`
      : null)
}
