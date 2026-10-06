/**
 * ADS PLAYBOOK PB-4 — compile one product's playbook into the campaigns a build would create (design report 9 §5.2),
 * pure. The output is the blueprint engine's own plan shape (ads-core/ads-blueprint-apply.ts PlannedCampaign), so the
 * SAME gate decides whether it may run (`evaluatePlan`: terms the product's own campaigns already run, name collisions,
 * a market that cannot receive writes, empty campaigns, Amazon's negative limits) and, later, the same executor creates
 * it.
 *
 *   names        the template's pattern: {product} = the product's name token, {market}, {parts} = the slot's words
 *   budgets      the product's daily budget × the slot's weight ÷ the weights of the slots built, at least the least
 *                budget per slot
 *   bids         the product's base bid × the slot's ladder factor, clamped to the strategy's bid band at this product
 *                (and never under Amazon's 2¢); Auto groups at the slot bid × their factor
 *   terms        each slot's feeds: brand, category (or only the ones exact at start), competitor keywords at the slot's
 *                match type; competitor ASINs as product targets. Category and competitor keywords are gated (the
 *                product's own other campaigns may already buy them: the template says skip or accept; another
 *                product's campaigns buying them is allowed and only listed — Owner rule 3)
 *   negatives    the product's own negatives in every keyword and Auto slot, and the build-time isolation: the planned
 *                exact keywords negated (exact) in the Auto, Broad and Phrase slots; brand terms negated (phrase) in the
 *                category and competitor slots; phrase keywords negated (phrase) in Broad and Auto — as the template says
 *   placements   the slot's top-of-search, product-page and rest-of-search percentages
 *
 * Slots the product already holds (linked) are left out: a build creates only what is missing. Nothing here reads a
 * database or calls Amazon.
 */
import { campaignNameProblem } from '@nexus/shared/ads-campaign-name'
import type { BlueprintDoc } from '../../ads-core/ads-blueprint.js'
import type { PlannedCampaign, PlannedTarget } from '../../ads-core/ads-blueprint-apply.js'
import type { ProductTerms, Slot, TemplateDoc } from './doc.js'

/** Amazon's least daily budget for a Sponsored Products campaign, and its least bid. */
const MIN_BUDGET_CENTS = 100
const FLOOR_BID_CENTS = 2
/** Amazon's word limit on a negative phrase. */
const NEGATIVE_PHRASE_WORDS = 4

export interface CompileInput {
  market: string
  /** The product's resolved doc (resolve.ts: sections whole, skipped slots left out). */
  doc: TemplateDoc
  product: {
    nameToken: string | null
    dailyBudgetCents: number | null
    baseBidCents: number | null
    terms: ProductTerms | null
  }
  /** The ASINs the slots advertise (the product's children listed in the market). */
  asins: readonly string[]
  /** The strategy's bid band in force at this product (null: no bound on that side). */
  band: { minBidCents: number | null; maxBidCents: number | null }
  /** Slot keys the product already holds at Amazon (linked): left out of the build. */
  linkedSlots?: ReadonlySet<string>
}

export interface CompiledSlot {
  key: string
  /** The plan's campaign id (`c0`, …); null when the slot is linked and not built. */
  campaignId: string | null
  name: string
  linked: boolean
  dailyBudgetCents: number
  startBidCents: number
  /** The ladder's bid before the strategy's band clamped it; absent when it was inside. */
  ladderBidCents?: number
  keywords: number
  productTargets: number
  autoGroups: number
  negatives: number
}

export interface CompiledPlaybook {
  campaigns: PlannedCampaign[]
  slots: CompiledSlot[]
  /** What the slots built would commit per day at full spend. */
  dailyBudgetCents: number
  /** Why nothing can be compiled (no name token, no daily budget, no base bid). */
  problems: string[]
  warnings: string[]
}

const norm = (s: string) => s.trim().toLowerCase()

const isResearch = (s: Slot) => s.targeting === 'AUTO' || (s.targeting === 'KEYWORD' && s.match !== 'EXACT')

/** The positive keywords one slot's feeds give it, once each. */
function keywordsOf(slot: Slot, terms: ProductTerms): string[] {
  if (slot.targeting !== 'KEYWORD') return []
  const out = new Map<string, string>()
  const add = (list: readonly string[]) => { for (const t of list) if (t.trim()) out.set(norm(t), t.trim()) }
  for (const feed of slot.feeds) {
    if (feed === 'brand') add(terms.brand)
    if (feed === 'competitor') add(terms.competitor)
    if (feed === 'category') add(terms.category.map((c) => c.text))
    if (feed === 'categoryExactAtStart') add(terms.category.filter((c) => c.exactAtStart).map((c) => c.text))
  }
  return [...out.values()]
}

export function compilePlaybook(input: CompileInput): CompiledPlaybook {
  const { doc, product, market } = input
  const problems: string[] = []
  const warnings: string[] = []
  if (!product.nameToken) problems.push('The product row names no name token: the campaign names need it')
  if (!product.dailyBudgetCents) problems.push('The product row sets no daily budget: the slots\' budgets are shares of it')
  if (!product.baseBidCents) problems.push('The product row sets no base bid: the start-bid ladder multiplies it')
  if (problems.length) return { campaigns: [], slots: [], dailyBudgetCents: 0, problems, warnings }
  const terms: ProductTerms = product.terms ?? { brand: [], category: [], competitor: [], competitorAsins: [], negatives: [] }
  const linked = input.linkedSlots ?? new Set<string>()
  const slots = doc.structure.slots
  const nameOf = (s: Slot) => doc.structure.naming.pattern
    .split('{product}').join(product.nameToken!)
    .split('{market}').join(market)
    .split('{parts}').join(s.nameParts.join(doc.structure.naming.partSeparator))
    .trim()

  // Budgets: shares of the product's daily budget across every slot of the playbook (linked ones keep theirs).
  const weightSum = slots.reduce((n, s) => n + (doc.budget.weights[s.key] ?? 0), 0)
  const least = Math.max(MIN_BUDGET_CENTS, doc.budget.minPerSlotCents)
  const budgetOf = (s: Slot) => Math.max(least, weightSum > 0 ? Math.round((product.dailyBudgetCents! * (doc.budget.weights[s.key] ?? 0)) / weightSum) : least)
  if (!weightSum) warnings.push('No slot has a budget weight: each slot gets the least budget per slot')

  // Bids: the ladder, clamped to the strategy's band at this product.
  const bidOf = (s: Slot) => {
    const ladder = Math.max(FLOOR_BID_CENTS, Math.round(product.baseBidCents! * (doc.bids.ladder[s.key] ?? 1)))
    let bid = ladder
    if (input.band.maxBidCents != null) bid = Math.min(bid, input.band.maxBidCents)
    if (input.band.minBidCents != null) bid = Math.max(bid, input.band.minBidCents)
    return { bid: Math.max(FLOOR_BID_CENTS, bid), ladder }
  }

  // The planned exact keywords (isolation negates them where research slots would buy them too).
  const exactTerms = new Map<string, string>()
  for (const s of slots) if (s.targeting === 'KEYWORD' && s.match === 'EXACT') for (const k of keywordsOf(s, terms)) exactTerms.set(norm(k), k)
  const phraseTerms = new Map<string, string>()
  for (const s of slots) if (s.targeting === 'KEYWORD' && s.match === 'PHRASE') for (const k of keywordsOf(s, terms)) phraseTerms.set(norm(k), k)

  const campaigns: PlannedCampaign[] = []
  const compiled: CompiledSlot[] = []
  let dailyBudgetCents = 0
  let skippedLong = 0
  for (const slot of slots) {
    const name = nameOf(slot)
    const nameProblem = campaignNameProblem(name)
    if (nameProblem) warnings.push(`${slot.key}: ${nameProblem}`)
    const budget = budgetOf(slot)
    const { bid, ladder } = bidOf(slot)
    if (linked.has(slot.key)) {
      compiled.push({ key: slot.key, campaignId: null, name, linked: true, dailyBudgetCents: budget, startBidCents: bid, ...(ladder !== bid ? { ladderBidCents: ladder } : {}), keywords: 0, productTargets: 0, autoGroups: 0, negatives: 0 })
      continue
    }
    const ci = campaigns.length
    const gid = `c${ci}.g0`
    const targets: PlannedTarget[] = []
    const push = (t: Omit<PlannedTarget, 'id'>) => targets.push({ ...t, id: `${gid}.t${targets.length}` })

    // Positives.
    if (slot.targeting === 'AUTO') {
      for (const [clause, group] of Object.entries(slot.autoGroups ?? {})) {
        if (!group?.on) continue
        push({ expression: '', expressionType: clause, kind: 'AUTO', autoClause: clause as PlannedTarget['autoClause'], bidCents: Math.max(FLOOR_BID_CENTS, Math.round(bid * group.factor)), isNegative: false, negativeLevel: null })
      }
    } else if (slot.targeting === 'PRODUCT') {
      if (slot.feeds.includes('competitorAsins')) {
        for (const asin of terms.competitorAsins) push({ expression: asin.toUpperCase(), expressionType: 'ASIN_SAME_AS', kind: 'PRODUCT', bidCents: bid, isNegative: false, negativeLevel: null })
      }
    } else {
      for (const k of keywordsOf(slot, terms)) {
        // Category and competitor terms are not about this one product: the gate checks them against live campaigns.
        const gated = slot.intent === 'CATEGORY' || slot.intent === 'COMPETITOR'
        push({ expression: k, expressionType: slot.match!, kind: 'KEYWORD', bidCents: bid, isNegative: false, negativeLevel: null, ...(gated ? { gated: true } : {}) })
      }
    }
    const positives = targets.length

    // Negatives first in the executor's order; here they sit beside the positives. Keyword negatives only where keywords
    // or Auto run (a product-targeting ad group takes none).
    if (slot.targeting !== 'PRODUCT') {
      const negatives = new Map<string, { text: string; match: 'EXACT' | 'PHRASE' }>()
      const negate = (text: string, match: 'EXACT' | 'PHRASE') => {
        if (match === 'PHRASE' && text.trim().split(/\s+/).length > NEGATIVE_PHRASE_WORDS) { skippedLong++; return }
        negatives.set(`${match}|${norm(text)}`, { text, match })
      }
      for (const n of terms.negatives) negate(n.text, n.match)
      if (doc.isolation.exactIntoResearch && isResearch(slot)) for (const k of exactTerms.values()) negate(k, 'EXACT')
      if (doc.isolation.brandPhraseIntoCategoryAndCompetitor && (slot.intent === 'CATEGORY' || slot.intent === 'COMPETITOR')) for (const b of terms.brand) negate(b, 'PHRASE')
      if (doc.isolation.phraseIntoBroadAndAuto && (slot.targeting === 'AUTO' || slot.match === 'BROAD')) for (const k of phraseTerms.values()) negate(k, 'PHRASE')
      // A negative never blocks a keyword the same slot buys: an exact negative its exact keyword, a phrase negative the
      // same words at any match. (A broad or phrase keyword negated exact is the cross-match isolation itself.)
      const own = targets.filter((t) => t.kind === 'KEYWORD' && !t.isNegative)
      const blocks = (n: { text: string; match: 'EXACT' | 'PHRASE' }) =>
        own.some((t) => norm(t.expression) === norm(n.text) && (n.match === 'PHRASE' || t.expressionType === 'EXACT'))
      for (const n of negatives.values()) {
        if (blocks(n)) continue
        push({ expression: n.text, expressionType: n.match, kind: 'KEYWORD', bidCents: null, isNegative: true, negativeLevel: 'AD_GROUP' })
      }
    }

    const p = doc.placements[slot.key]
    const placementBidding = p
      ? ([['PLACEMENT_TOP', p.top], ['PLACEMENT_PRODUCT_PAGE', p.productPage], ['PLACEMENT_REST_OF_SEARCH', p.restOfSearch]] as const)
        .filter(([, pct]) => pct > 0).map(([placement, percentage]) => ({ placement, percentage }))
      : []
    campaigns.push({
      id: `c${ci}`,
      role: slot.key,
      name,
      dailyBudget: budget / 100,
      biddingStrategy: slot.biddingStrategy,
      targetingType: slot.targeting === 'AUTO' ? 'AUTO' : 'MANUAL',
      placementBidding,
      adGroups: [{ id: gid, name, defaultBidCents: bid, targets, asins: [...input.asins] }],
    })
    dailyBudgetCents += budget
    compiled.push({
      key: slot.key, campaignId: `c${ci}`, name, linked: false, dailyBudgetCents: budget, startBidCents: bid,
      ...(ladder !== bid ? { ladderBidCents: ladder } : {}),
      keywords: targets.filter((t) => !t.isNegative && t.kind === 'KEYWORD').length,
      productTargets: targets.filter((t) => !t.isNegative && t.kind === 'PRODUCT').length,
      autoGroups: targets.filter((t) => t.kind === 'AUTO').length,
      negatives: targets.length - positives,
    })
    if (!positives && slot.targeting !== 'AUTO') warnings.push(`${slot.key}: none of the product's terms feeds it, so it would buy nothing`)
  }
  if (skippedLong) warnings.push(`${skippedLong} negative phrase(s) are over Amazon's ${NEGATIVE_PHRASE_WORDS}-word limit and are left out`)
  const clamped = compiled.filter((s) => s.ladderBidCents != null).map((s) => s.key)
  if (clamped.length) warnings.push(`The strategy's bid band clamps the start bid of ${clamped.join(', ')}`)
  return { campaigns, slots: compiled, dailyBudgetCents, problems, warnings }
}

/**
 * The blueprint the gate's messages count campaigns from (`evaluatePlan` reads its campaign list): the compiled
 * campaigns in the blueprint's shape, with the gated terms as its shared targets.
 */
export function blueprintOf(campaigns: readonly PlannedCampaign[], productToken: string, doc: TemplateDoc): BlueprintDoc {
  const intent = new Map(doc.structure.slots.map((s) => [s.key, s.intent]))
  const shared = new Map<string, 'CATEGORY' | 'COMPETITOR'>()
  for (const c of campaigns) {
    for (const g of c.adGroups) for (const t of g.targets) if (t.gated) shared.set(norm(t.expression), intent.get(c.role) === 'COMPETITOR' ? 'COMPETITOR' : 'CATEGORY')
  }
  const targets = campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets))
  return {
    version: 1,
    productToken,
    campaigns: campaigns.map((c) => ({
      role: c.role, namePattern: c.name, dailyBudget: c.dailyBudget, biddingStrategy: c.biddingStrategy, placementBidding: c.placementBidding,
      targetingType: c.targetingType, adGroups: [],
    })),
    stats: {
      campaigns: campaigns.length, adGroups: campaigns.reduce((n, c) => n + c.adGroups.length, 0),
      positives: targets.filter((t) => !t.isNegative).length, negatives: targets.filter((t) => t.isNegative).length,
      productAds: campaigns.reduce((n, c) => n + c.adGroups.reduce((m, g) => m + g.asins.length, 0), 0),
      byClass: { BRAND: 0, CATEGORY: 0, COMPETITOR: 0, ASIN: 0, AUTO: 0, UNKNOWN: 0 }, orphanedInSource: 0,
    },
    sharedTargets: [...shared.entries()].map(([expression, targetClass]) => ({ expression, targetClass })),
  }
}
