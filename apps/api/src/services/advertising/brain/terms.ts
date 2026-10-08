/**
 * ONE BRAIN AB-9 — the term ledger of one product in one market (design 2026-10-08-ads-one-brain/DESIGN.md §1, §2.7,
 * §2.8, §4 step 4, §8 row AB-9). Pure: no database and no clock; brain/terms-shadow.ts loads the facts, brain/arbiter.ts
 * names a lead where sibling products meet on one term, and this module gives each term ONE decision. SHADOW: it decides
 * and logs; nothing here writes to Amazon (AB-10 negatives live, AB-11 harvest live).
 *
 *   term       every customer search term the product's own campaigns saw in the window, and every keyword (or ASIN)
 *              they target or negate — normalised (lower case, single spaces), one row per text. A shared campaign is no
 *              product's (D2): its terms count for the market's pooled rate only.
 *   one state  TARGETED           it has a home: a positive EXACT keyword (an ASIN: a product target) in the product's own
 *                                 campaigns. A home is never negated over (the Owner: a temporary stop is lower bids)
 *              HARVEST_CANDIDATE  it converts and has no home: graduate it to exact (its source negated exact, AB-11)
 *              OWNED_BY_SIBLING   it would be harvested, but the market arbiter gave the term to a sibling product's lead
 *              PROTECTED          a guard forbids a negative and there is nothing to harvest: a protected term
 *                                 (AdKeywordProtection), the product's brand word (playbook terms.brand), or a winner
 *              NEGATED            a negative of the product blocks it, it has no home and no order in the window
 *              NEGATE_CANDIDATE   0 orders after the pooled test and the spend gate: negate it exact (AB-10)
 *              WATCH              everything else: not enough evidence either way
 *              The state is ONE value, so a term can never be harvested and negated at once: the harvest-vs-negate clash
 *              is impossible by construction. Where both tests pass (an Owner's negate group that allows orders), the
 *              converting term is harvested and the clash is named.
 *   order      §4: the arbiter first (brain/arbiter.ts), then per term — home, harvest, protection, standing negative,
 *              negative candidate; caps after (negatives first, then harvest: applyCaps).
 *   evidence   pooled product → category → market (the bid estimator's chain, bid-brain/estimator.ts, reused as it is):
 *              CR̂ of the product for the negative test, CR̂ of the term (borrowing from the product) for the harvest
 *              test and the profit per click, AOV̂ with the listing price at the root.
 *   negative   (§2.7) 0 orders after n clicks is evidence when (1 − CR̂)^n < 5 %: n ≥ ln 0.05 / ln(1 − CR̂) ≈ 3 / CR̂, with
 *              CR̂ the product's pooled rate, AND spend ≥ 1.5 × target CPA (AOV̂ × target ACoS). No target ACoS → no spend
 *              gate → no candidate (fail closed). The Owner's negate group (ads strategy) wins whole where he set one;
 *              a term with an order in the window is then only a candidate that asks first (§2.7 level PROPOSE).
 *              Guards: never a protected term, the brand, a winner, a term with an order (brain test), the text of the
 *              product's own phrase or broad keyword (it would block itself), a term the product leads.
 *   harvest    (§2.8) orders ≥ a threshold that rises with the destination's size (Perpetua [PER-2]: 1 while the exact
 *              ad group holds < 15 keywords, 2 below 900, then more), and the 80 % lower bound of the expected ACoS (CPC
 *              ÷ (upper CR̂ × AOV̂)) at or below the band top. The Owner's harvest group wins whole where he set one.
 *   held       a decision the brain could not act on even once the lever writes: the lever OFF, locked or excluded, the
 *              Owner's lock of the term, or past the day's cap (§5: 20 new negatives, 10 new keywords per product).
 *   words      no money and no ACoS in a `why` (they are ad-spend money: the read tool strips the numbers by key, so the
 *              words never carry one).
 */
import { estimate, type Evidence, type NodeEstimate, type PoolNode } from '../bid-brain/estimator.js'
import { isAsin, normaliseTerm, protectedTermHit, type ProtectedTerm } from '../ads-negation-policy.js'

export const TERM_STATES = ['TARGETED', 'HARVEST_CANDIDATE', 'OWNED_BY_SIBLING', 'PROTECTED', 'NEGATED', 'NEGATE_CANDIDATE', 'WATCH'] as const
export type TermState = (typeof TERM_STATES)[number]
export const isTermState = (v: unknown): v is TermState => typeof v === 'string' && (TERM_STATES as readonly string[]).includes(v)

/** The window the ledger reads by default (§2.7: "a term with any order in 60 days"). Search terms are kept 90 days. */
export const LEDGER_WINDOW_DAYS = 60
/** (1 − CR̂)^n below this is evidence enough that a term does not convert (§2.7). */
export const NEGATE_CONFIDENCE = 0.05
/** The spend gate: spend at least this many target CPAs (§2.7). */
export const SPEND_GATE_CPAS = 1.5
/** One-sided 80 % (the harvest's ACoS bound, §2.8). */
export const Z80 = 0.8416
/** The clicks a waste test never asks more than (a CR̂ near zero would ask for millions). */
export const MAX_NEGATE_CLICKS = 5000

export type MatchKind = 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'

/** A term as stored and compared: lower case, single spaces (the negation policy's own normalisation). */
export const termKey = (s: string): string => normaliseTerm(s)

/** A match type as stored: Amazon's `NEGATIVE_EXACT`, the v1 sync's `_EXACT` and `EXACT` are one (harvest-destination.service.ts). */
export function matchOf(expressionType: string | null | undefined, kind?: string | null): MatchKind | null {
  if (kind === 'PRODUCT') return 'PRODUCT'
  const e = String(expressionType ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '')
  return e === 'EXACT' || e === 'PHRASE' || e === 'BROAD' ? e : null
}

const words = (s: string) => ` ${s} `
/** Does the negative (normalised text, its match) block this term? Exact: the same text; phrase: its words in order inside it; product: the same ASIN. */
export function negativeBlocks(term: string, negative: { text: string; match: MatchKind }): boolean {
  const n = termKey(negative.text)
  if (!n) return false
  if (negative.match === 'PHRASE') return words(term).includes(words(n))
  return n === term
}

/** Clicks, orders, spend and sales of one term (or one node) over a window. */
export interface TermEvidence { impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number }
export const NO_TERM_EVIDENCE: TermEvidence = Object.freeze({ impressions: 0, clicks: 0, orders: 0, spendCents: 0, salesCents: 0 })
export function addEvidence(a: TermEvidence, b: TermEvidence): TermEvidence {
  return { impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, orders: a.orders + b.orders, spendCents: a.spendCents + b.spendCents, salesCents: a.salesCents + b.salesCents }
}
const asPoolEvidence = (e: TermEvidence): Evidence => ({ clicks: e.clicks, orders: e.orders, salesCents: e.salesCents, costCents: e.spendCents })

/** One place a term is targeted or negated in the product's own campaigns. */
export interface TermPlace {
  campaignId: string
  adGroupId: string
  targetId: string
  match: MatchKind
  /** A negative's level (CAMPAIGN | AD_GROUP); null for a positive. */
  level?: string | null
  /** A positive's bid. */
  bidCents?: number | null
  /** The negative's own text when it is not the term (a phrase that blocks it). */
  text?: string
}

/** Where a harvested term would go (EXACT, or a product target for an ASIN). */
export interface HarvestDestination {
  /** stored: AdsHarvestDestination names one of the product's own ad groups · own: the product's one exact ad group ·
   *  ambiguous: several own exact ad groups and nothing stored · elsewhere: the stored one is not the product's own · none */
  source: 'stored' | 'own' | 'ambiguous' | 'elsewhere' | 'none'
  adGroupId: string | null
  /** Its positive keywords now (the size the harvest threshold rises with); null when unknown. */
  keywords: number | null
  /** ambiguous: how many own exact ad groups. */
  candidates?: number
}

/** What one product holds about one term (the loader builds it). */
export interface TermFacts {
  term: string
  /** Over the product's own campaigns, in the brain's window. */
  evidence: TermEvidence
  /** Over the Owner's window when his harvest or negate group names another (absent: the same window). */
  ownerEvidence?: { harvest?: TermEvidence; negate?: TermEvidence }
  targets: TermPlace[]
  negatives: TermPlace[]
  destination: HarvestDestination
}

/** A lever's resolved state for the product (brain/settings.ts effective). */
export type LeverEffective = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO' | 'LOCKED' | 'EXCLUDED' | 'NOT_ENROLLED'

export interface PooledChain {
  /** The product's own node first, then its category's, then the market's (the category left out when unknown). */
  nodes: PoolNode[]
  /** The product's listing price: the order value's root. */
  listPriceCents: number | null
}

export interface ProductContext {
  productId: string
  pool: PooledChain
  /** ACoS target as a fraction, with its source in words. Null: none set anywhere. */
  targetAcos: { value: number; source: string } | null
  /** The band top (the strategy's ACoS band high, else the target), a fraction. */
  bandTop: { value: number; source: string } | null
  /** The Owner's ads-strategy groups for the product (null: the brain's own test). */
  harvestGroup: { minOrders: number; minClicks: number; maxAcosPct: number | null; windowDays: number; source: string } | null
  negateGroup: { minClicks: number; minSpendCents: number; maxOrders: number; windowDays: number; source: string } | null
  protections: readonly ProtectedTerm[]
  /** The product's brand and hero words (playbook terms.brand), normalised. */
  brand: readonly string[]
  /** Margin before ads as a fraction (break-even ACoS), else the target ACoS as its stand-in; null: neither. */
  margin: { value: number; source: 'profit' | 'target' } | null
  levers: { negatives: LeverEffective; harvest: LeverEffective }
  /** Terms the Owner locked on each lever (lock refs "term:<text>", normalised). */
  lockedTerms: { negatives: ReadonlySet<string>; harvest: ReadonlySet<string> }
  caps: { negativesPerDay: number; harvestPerDay: number }
}

// ── Pooling ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The product's pooled conversion rate and order value (product → category → market). */
export function productEstimate(pool: PooledChain): NodeEstimate {
  return estimate(pool.nodes, { listPriceCents: pool.listPriceCents }).node
}

/** The term's own estimate, borrowing from the product's chain: its node and its parent's. */
export function termEstimate(evidence: TermEvidence, pool: PooledChain): { node: NodeEstimate; parent: NodeEstimate } {
  const e = estimate([{ level: 'keyword', evidence: asPoolEvidence(evidence) }, ...pool.nodes], { listPriceCents: pool.listPriceCents })
  return { node: e.node, parent: e.parent ?? e.node }
}

/** The 80 % upper bound of a node's conversion rate (the mirror of bid-brain/estimator.ts crLowerBound80). */
export function crUpperBound80(n: Pick<NodeEstimate, 'cr' | 'k' | 'clicks'>): number {
  const a = n.cr * (n.clicks + n.k)
  const b = (1 - n.cr) * (n.clicks + n.k)
  const sd = Math.sqrt((a * b) / ((a + b) * (a + b) * (a + b + 1)))
  return Math.min(1, n.cr + Z80 * sd)
}

/** Clicks with 0 orders that make "it does not convert" a 95 % call at this rate: ⌈ln 0.05 / ln(1 − CR̂)⌉ ≈ 3 / CR̂. */
export function negateClicksNeeded(cr: number): number {
  if (!(cr > 0)) return MAX_NEGATE_CLICKS
  if (cr >= 1) return 1
  return Math.min(MAX_NEGATE_CLICKS, Math.max(1, Math.ceil(Math.log(NEGATE_CONFIDENCE) / Math.log(1 - cr))))
}

/** Orders a harvest needs, rising with the destination's size (§2.8, Perpetua [PER-2]); unknown size: 2. */
export function harvestOrdersNeeded(destinationKeywords: number | null): number {
  if (destinationKeywords == null) return 2
  if (destinationKeywords < 15) return 1
  if (destinationKeywords < 900) return 2
  return 3 + Math.floor((destinationKeywords - 900) / 1000)
}

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 2 : 1)} %`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── The tests ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HarvestTest {
  pass: boolean
  by: 'owner' | 'brain'
  /** Why it could not be judged (no target, no order value); the test then fails. */
  refused?: string
  ordersNeeded: number
  clicksNeeded: number
  /** brain: the 80 % lower bound of the expected ACoS and the ceiling it is held to (fractions; money: stripped by key). */
  acosLowerBound?: number | null
  acosCeiling?: number | null
  words: string
}

export interface NegateTest {
  pass: boolean
  by: 'owner' | 'brain'
  refused?: string
  /** The Owner's group allows a term with orders: the candidate asks a person first (§2.7 level PROPOSE). */
  askFirst?: boolean
  clicksNeeded: number
  /** The product's pooled conversion rate the brain's test reads. */
  cr: number
  /** brain: the spend gate (1.5 × target CPA) and the target CPA; owner: his minimum spend. Money: stripped by key. */
  spendGateCents: number | null
  targetCpaCents?: number | null
  words: string
}

export interface TermTests {
  harvest: HarvestTest
  negate: NegateTest
  /** Meets the harvest test with its ACoS at or under the target. */
  winner: boolean
  /** Why no negative may ever touch it (first that applies), or null. */
  protection: 'protected-term' | 'brand' | 'winner' | null
  protectionWhy: string | null
  /** The term's pooled conversion rate, its order value and its profit per click (the arbiter's measure; money). */
  cr: number
  aovCents: number | null
  cpcCents: number | null
  profitPerClickCents: number | null
}

/** The brand word of the product inside this term (a whole-word run), or null. */
export function brandWordIn(term: string, brand: readonly string[]): string | null {
  for (const b of brand) {
    const w = termKey(b)
    if (w && words(term).includes(words(w))) return w
  }
  return null
}

/** The harvest test (§2.8), the Owner's group whole where he set one. */
export function harvestTest(f: TermFacts, ctx: ProductContext, termCr: { node: NodeEstimate; parent: NodeEstimate }, aovCents: number | null): HarvestTest {
  if (ctx.harvestGroup) {
    const g = ctx.harvestGroup
    const e = f.ownerEvidence?.harvest ?? f.evidence
    // The same bar as ads-harvest.service.ts meetsHarvest (a test pins the two together).
    const acosOk = g.maxAcosPct == null || e.salesCents <= 0 || (e.spendCents / e.salesCents) * 100 <= g.maxAcosPct
    const pass = e.orders >= g.minOrders && e.clicks >= g.minClicks && acosOk
    return {
      pass, by: 'owner', ordersNeeded: g.minOrders, clicksNeeded: g.minClicks,
      words: `the Owner's harvest group (${g.source}): ${plural(e.orders, 'order')} of ${g.minOrders}, ${plural(e.clicks, 'click')} of ${g.minClicks} in ${g.windowDays} days${g.maxAcosPct != null ? `, ACoS ${acosOk ? 'under' : 'over'} its ceiling` : ''}`,
    }
  }
  const need = harvestOrdersNeeded(f.destination.keywords)
  const e = f.evidence
  const sized = f.destination.keywords == null ? 'the destination\'s size unknown' : `the destination holds ${plural(f.destination.keywords, 'keyword')}`
  if (e.orders < need) return { pass: false, by: 'brain', ordersNeeded: need, clicksNeeded: 0, words: `${plural(e.orders, 'order')}; a harvest needs ${need} (${sized})` }
  if (!ctx.bandTop) return { pass: false, by: 'brain', ordersNeeded: need, clicksNeeded: 0, refused: 'no target ACoS is set for this product anywhere (strategy, account): the expected ACoS cannot be judged', words: `${plural(e.orders, 'order')}, but no target ACoS is set: the harvest test cannot judge the expected ACoS` }
  if (aovCents == null || !(aovCents > 0)) return { pass: false, by: 'brain', ordersNeeded: need, clicksNeeded: 0, refused: 'no order value is known up the chain', words: `${plural(e.orders, 'order')}, but no order value is known: the expected ACoS cannot be judged` }
  const cpc = e.clicks > 0 ? e.spendCents / e.clicks : 0
  const lower = cpc / (crUpperBound80(termCr.node) * aovCents)
  const pass = lower <= ctx.bandTop.value
  return {
    pass, by: 'brain', ordersNeeded: need, clicksNeeded: 0, acosLowerBound: lower, acosCeiling: ctx.bandTop.value,
    words: `${plural(e.orders, 'order')} of ${need} (${sized}); the 80 % lower bound of its expected ACoS is ${pass ? 'at or under' : 'over'} the band top (${ctx.bandTop.source})`,
  }
}

/** The negative test (§2.7), the Owner's group whole where he set one. Guards come after (decideTerm). */
export function negateTest(f: TermFacts, ctx: ProductContext, productCr: NodeEstimate): NegateTest {
  const cr = productCr.cr
  if (ctx.negateGroup) {
    const g = ctx.negateGroup
    const e = f.ownerEvidence?.negate ?? f.evidence
    const pass = e.orders <= g.maxOrders && e.clicks >= g.minClicks && e.spendCents >= g.minSpendCents
    return {
      pass, by: 'owner', askFirst: pass && e.orders > 0, clicksNeeded: g.minClicks, cr, spendGateCents: g.minSpendCents,
      words: `the Owner's negate group (${g.source}): ${plural(e.clicks, 'click')} of ${g.minClicks}, ${plural(e.orders, 'order')} (at most ${g.maxOrders}), spend ${e.spendCents >= g.minSpendCents ? 'at or over' : 'under'} its minimum, in ${g.windowDays} days`,
    }
  }
  const need = negateClicksNeeded(cr)
  const e = f.evidence
  const base = `${plural(e.orders, 'order')} in ${plural(e.clicks, 'click')}; at the product's pooled ${pct(cr)} conversion, 0 orders in ${need} clicks is a 95 % call`
  if (e.orders > 0) return { pass: false, by: 'brain', clicksNeeded: need, cr, spendGateCents: null, words: `${base} — it has orders` }
  if (!ctx.targetAcos) return { pass: false, by: 'brain', clicksNeeded: need, cr, spendGateCents: null, refused: 'no target ACoS is set for this product anywhere: the spend gate cannot be measured', words: `${base}; no target ACoS is set, so the spend gate cannot be measured (never negated without it)` }
  const aov = productCr.aovCents
  if (aov == null || !(aov > 0)) return { pass: false, by: 'brain', clicksNeeded: need, cr, spendGateCents: null, refused: 'no order value is known up the chain: the spend gate cannot be measured', words: `${base}; no order value is known, so the spend gate cannot be measured` }
  const cpa = aov * ctx.targetAcos.value
  const gate = Math.round(SPEND_GATE_CPAS * cpa)
  const clicksOk = e.clicks >= need
  const spendOk = e.spendCents >= gate
  return {
    pass: clicksOk && spendOk, by: 'brain', clicksNeeded: need, cr, spendGateCents: gate, targetCpaCents: Math.round(cpa),
    words: `${base}${clicksOk ? '' : ` — ${need - e.clicks} more clicks needed`}; spend ${spendOk ? 'past' : 'under'} the gate of ${SPEND_GATE_CPAS} target CPAs (${ctx.targetAcos.source})`,
  }
}

/** Every test of one term for one product: harvest, negative, winner, protection, and its profit per click. */
export function termTests(f: TermFacts, ctx: ProductContext): TermTests {
  const productCr = productEstimate(ctx.pool)
  const termCr = termEstimate(f.evidence, ctx.pool)
  const aov = termCr.node.aovCents
  const harvest = harvestTest(f, ctx, termCr, aov)
  const negate = negateTest(f, ctx, productCr)
  const e = f.evidence
  const winner = harvest.pass && !!ctx.targetAcos && e.salesCents > 0 && e.spendCents / e.salesCents <= ctx.targetAcos.value
  const hit = protectedTermHit(f.term, 'NEGATIVE_EXACT', ctx.protections)
  const brand = brandWordIn(f.term, ctx.brand)
  const protection = hit ? 'protected-term' : brand ? 'brand' : winner ? 'winner' : null
  const protectionWhy = hit
    ? `the protected term "${normaliseTerm(hit.protection.term)}"${hit.protection.reason ? ` (${hit.protection.reason})` : ''}`
    : brand ? `the product's brand word "${brand}" (playbook)` : winner ? 'a winner: it meets the harvest test with its ACoS within the target' : null
  const bid = Math.max(0, ...f.targets.map((t) => t.bidCents ?? 0))
  const cpc = e.clicks > 0 ? e.spendCents / e.clicks : bid > 0 ? bid * 0.85 : null
  const profit = cpc != null && aov != null && ctx.margin ? termCr.node.cr * aov * ctx.margin.value - cpc : null
  return { harvest, negate, winner, protection, protectionWhy, cr: termCr.node.cr, aovCents: aov, cpcCents: cpc, profitPerClickCents: profit }
}

// ── One decision per term ───────────────────────────────────────────────────────────────────────────────────────

/** What the market arbiter decided for a term this product meets a sibling on (brain/arbiter.ts). */
export interface LeadVerdict {
  leadProductId: string
  rule: string
  /** The lead's bid on the term and the most a sibling may bid (0.8 × the lead's); null while the lead has no keyword. */
  leadBidCents: number | null
  maxBidCents: number | null
  why: string
}

export type ClashKind = 'self-blocking' | 'protected-negated' | 'harvest-and-negate' | 'sibling'
/** A clash the ledger's one decision removes, and how. */
export interface TermClash { kind: ClashKind; what: string; resolution: string; targetId?: string; negativeId?: string }

export interface TermDecision {
  term: string
  isAsin: boolean
  state: TermState
  protection: TermTests['protection']
  /** The lead, when the term is contested in the market. */
  lead: (LeadVerdict & { isThis: boolean }) | null
  /** Positives of this product above the most a sibling may bid (it leads not): the bids lever lowers them (shadow: named). */
  wouldLower: Array<{ targetId: string; bidCents: number; toBidCents: number }>
  /** Why the brain would not act on it even once the lever writes; null: nothing holds it. */
  heldBy: string | null
  capped: boolean
  /** NEGATE_CANDIDATE from an Owner's group that allows orders: a person decides (§2.7). */
  askFirst: boolean
  why: string
  clashes: TermClash[]
  evidence: TermEvidence
  targets: TermPlace[]
  negatives: TermPlace[]
  destination: HarvestDestination
  tests: TermTests
}

const ACTS: readonly LeverEffective[] = ['OBSERVE', 'PROPOSE', 'AUTO']
function leverHold(lever: 'negatives' | 'harvest', effective: LeverEffective): string | null {
  if (ACTS.includes(effective)) return null
  if (effective === 'OFF') return `the ${lever} lever is OFF for this product: today's engines run it`
  if (effective === 'LOCKED') return `the ${lever} lever is locked at the Owner's own value: the brain only recommends`
  if (effective === 'EXCLUDED') return 'the product is excluded from the brain by the Owner'
  return 'the product is not enrolled in the brain'
}

const placeWords = (p: TermPlace) => `${p.match === 'PRODUCT' ? 'product target' : `${p.match.toLowerCase()} keyword`} in ad group ${p.adGroupId}`
const negativeWords = (n: TermPlace) => `${n.match === 'PRODUCT' ? 'negative product target' : `negative ${n.match.toLowerCase()}`}${n.text ? ` "${n.text}"` : ''} at its ${n.level === 'CAMPAIGN' ? 'campaign' : 'ad group'}`

/** A positive and a negative of the product in one place (the clashes view's harvest-vs-negate gap, read-map.ts selfBlocking). */
export function selfBlockingPairs(f: Pick<TermFacts, 'targets' | 'negatives'>): Array<{ target: TermPlace; negative: TermPlace }> {
  const out: Array<{ target: TermPlace; negative: TermPlace }> = []
  for (const t of f.targets) {
    const n = f.negatives.find((x) => (x.level === 'CAMPAIGN' ? x.campaignId === t.campaignId : x.adGroupId === t.adGroupId)
      && (x.match === 'PHRASE' || (x.match === 'EXACT' && t.match === 'EXACT') || (x.match === 'PRODUCT' && t.match === 'PRODUCT')))
    if (n) out.push({ target: t, negative: n })
  }
  return out
}

/** The one decision for one term of one product (caps come after, over all of them: applyCaps). */
export function decideTerm(f: TermFacts, ctx: ProductContext, tests: TermTests, verdict: LeadVerdict | null): TermDecision {
  const asin = isAsin(f.term)
  const home = f.targets.find((t) => t.match === 'EXACT' || (asin && t.match === 'PRODUCT'))
  const ownKeyword = f.targets.find((t) => t.match === 'PHRASE' || t.match === 'BROAD')
  const leads = verdict?.leadProductId === ctx.productId
  const sibling = verdict && !leads ? verdict : null
  const clashes: TermClash[] = []
  for (const { target, negative } of selfBlockingPairs(f)) {
    clashes.push({
      kind: 'self-blocking', targetId: target.targetId, negativeId: negative.targetId,
      what: `the ${placeWords(target)} is blocked in the same place by a ${negativeWords(negative)}: it never serves there`,
      resolution: 'one decision: the keyword stays (a home is never negated over); the negative that blocks it retires (AB-10)',
    })
  }
  if (verdict) {
    clashes.push({
      kind: 'sibling', what: `sibling products meet on this term in the market (${verdict.rule})`,
      resolution: leads ? 'this product leads it: it keeps it and is never negated on it' : `product ${verdict.leadProductId} leads it: this product never harvests it and bids at most 0.8 × the lead's bid on it`,
    })
  }
  let state: TermState
  let why: string
  let action: 'negate' | 'harvest' | null = null
  if (home) {
    state = 'TARGETED'
    why = `it has a home: the ${placeWords(home)}`
    if (sibling) why += `; product ${sibling.leadProductId} leads it in the market, so this product's bid on it stays at most 0.8 × the lead's${sibling.maxBidCents == null ? ' (once the lead has a keyword on it)' : ''}`
  } else if (tests.harvest.pass) {
    if (sibling) {
      state = 'OWNED_BY_SIBLING'
      why = `it would be harvested (${tests.harvest.words}), but product ${sibling.leadProductId} leads it in the market (${sibling.why}): this product never harvests it`
    } else {
      state = 'HARVEST_CANDIDATE'
      action = 'harvest'
      const dest = f.destination
      why = `graduate it to ${asin ? 'a product target' : 'exact'}: ${tests.harvest.words}; ${dest.source === 'stored' || dest.source === 'own' ? `destination ad group ${dest.adGroupId} (${dest.source === 'stored' ? 'stored' : 'the product\'s exact ad group'}), its source negated exact in the same change set` : dest.source === 'ambiguous' ? `no destination yet: ${dest.candidates} exact ad groups of the product could take it and none is stored (set-harvest-destination)` : dest.source === 'elsewhere' ? 'no destination yet: the stored one is not in this product\'s own campaigns (set-harvest-destination)' : 'no destination yet: the product has no exact ad group (a new one comes from the builders, §2.9)'}`
      if (tests.negate.pass) {
        clashes.push({ kind: 'harvest-and-negate', what: `it passes the harvest test and the Owner's negate group at once (${tests.negate.words})`, resolution: 'one decision: a converting term is harvested, never negated' })
      }
    }
  } else if (tests.protection && tests.protection !== 'winner') {
    state = 'PROTECTED'
    why = `never negated: ${tests.protectionWhy}`
  } else if (f.negatives.length && f.evidence.orders === 0) {
    state = 'NEGATED'
    why = `blocked by the product's ${negativeWords(f.negatives[0])}${f.negatives.length > 1 ? ` and ${plural(f.negatives.length - 1, 'other negative')}` : ''}, and no order in the window`
  } else if (tests.negate.pass && !tests.protection && !ownKeyword && !leads && (tests.negate.by === 'owner' || f.evidence.orders === 0)) {
    state = 'NEGATE_CANDIDATE'
    action = 'negate'
    why = `negate it exact: ${tests.negate.words}${sibling ? `; product ${sibling.leadProductId} leads it in the market and this product has no order on it` : ''}`
  } else {
    state = 'WATCH'
    why = ownKeyword && tests.negate.pass
      ? `it does not convert, but it is the text of the product's own ${ownKeyword.match.toLowerCase()} keyword: a negative would block that keyword — the bids lever lowers it instead`
      : f.evidence.orders > 0 ? `it has orders, not enough to harvest: ${tests.harvest.words}` : `not enough evidence either way: ${tests.negate.words}`
  }
  if (tests.protection && tests.protection !== 'winner' && f.negatives.length) {
    clashes.push({
      kind: 'protected-negated', negativeId: f.negatives[0].targetId,
      what: `${tests.protectionWhy} is blocked by the product's ${negativeWords(f.negatives[0])}`,
      resolution: `one decision: ${state}; the negative on a protected term retires (AB-10)`,
    })
  }
  // The sibling's cap on this product's own keywords on the term (shadow: named; the bids lever owns the bid).
  const wouldLower = sibling?.maxBidCents != null
    ? f.targets.filter((t) => (t.bidCents ?? 0) > sibling.maxBidCents!).map((t) => ({ targetId: t.targetId, bidCents: t.bidCents!, toBidCents: sibling.maxBidCents! }))
    : []
  let heldBy: string | null = null
  if (action === 'negate') heldBy = leverHold('negatives', ctx.levers.negatives) ?? (ctx.lockedTerms.negatives.has(f.term) ? 'the Owner locked this term on the negatives lever: the brain leaves it' : null)
  if (action === 'harvest') heldBy = leverHold('harvest', ctx.levers.harvest) ?? (ctx.lockedTerms.harvest.has(f.term) ? 'the Owner locked this term on the harvest lever: the brain leaves it' : null)
  return {
    term: f.term, isAsin: asin, state, protection: tests.protection,
    lead: verdict ? { ...verdict, isThis: !!leads } : null,
    // §2.7 level: a negative on a term with any order in the window asks a person (the Owner's group may allow one).
    wouldLower, heldBy, capped: false, askFirst: action === 'negate' && (f.evidence.orders > 0 || !!tests.negate.askFirst), why, clashes,
    evidence: f.evidence, targets: f.targets, negatives: f.negatives, destination: f.destination, tests,
  }
}

/**
 * The day's caps (§5): at most `negativesPerDay` new negatives and `harvestPerDay` new keywords per product. Negatives
 * first (§4: they only lower spend), the most spend without an order first; then harvests, the most orders first. A
 * candidate past its cap keeps its state, `capped`, held for a later day. Returns new decisions (the input is not changed).
 */
export function applyCaps(decisions: readonly TermDecision[], caps: ProductContext['caps']): TermDecision[] {
  const out = decisions.map((d) => ({ ...d }))
  const rank = (state: TermState, order: (a: TermDecision, b: TermDecision) => number, cap: number, what: string) => {
    const open = out.filter((d) => d.state === state && !d.heldBy).sort((a, b) => order(a, b) || a.term.localeCompare(b.term))
    for (const d of open.slice(cap)) { d.capped = true; d.heldBy = `past today's cap of ${plural(cap, what)} for this product (§5): held for a later day` }
  }
  rank('NEGATE_CANDIDATE', (a, b) => b.evidence.spendCents - a.evidence.spendCents || b.evidence.clicks - a.evidence.clicks, caps.negativesPerDay, 'new negative')
  rank('HARVEST_CANDIDATE', (a, b) => b.evidence.orders - a.evidence.orders || b.evidence.salesCents - a.evidence.salesCents, caps.harvestPerDay, 'new keyword')
  return out
}

/** Counts per state, every state named (0 included). */
export function stateCounts(decisions: ReadonlyArray<{ state: TermState }>): Record<TermState, number> {
  const out = Object.fromEntries(TERM_STATES.map((s) => [s, 0])) as Record<TermState, number>
  for (const d of decisions) out[d.state]++
  return out
}
