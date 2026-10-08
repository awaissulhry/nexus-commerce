/**
 * ONE BRAIN AB-9 — the market arbiter: keyword ownership between sibling products (design 2026-10-08-ads-one-brain/
 * DESIGN.md §1 "The market arbiter", §2.7 guards, §2.8 "one owner per term", IND §2.6 / G2: no tool documents it). Pure:
 * no database, no clock. SHADOW: it names leads and logs them; nothing here writes to Amazon.
 *
 * Products may share keywords (the Owner's rule, 10-06): the arbiter never forbids a sibling a term, it orders them.
 *
 *   contender  a product family that targets the term (a positive keyword or product target with its text in its own
 *              campaigns) or wants it (the term passes its harvest test there). Seeing a term is no claim. A term is
 *              contested when two families or more claim it in one market.
 *   lead       the first that applies:
 *                pinned   the Owner pinned a lead (and it is a contender)
 *                brand    the term holds the brand or hero word of exactly one contender (playbook terms.brand, §1.4)
 *                profit   the highest expected profit per click, CR̂ × AOV̂ × margin − CPC, all pooled (§1.2); a contender
 *                         whose profit cannot be measured (no margin and no target, no order value) is not compared.
 *                         Profit decides only when one contender's measured profit is 0 or more, or when no unmeasured
 *                         contender has orders: a measured LOSS (profit < 0) never outranks a contender that sells on the
 *                         term but whose profit cannot be measured — then the orders decide, among them all
 *                orders   the most orders on the term (§1.2 "ties go to the product with more orders on the term")
 *                clicks   the most clicks on the term
 *                id       the lowest product id — deterministic, and said so
 *   others     never harvest it; bid at most 0.8 × the lead's bid on it (SIBLING_BID_RATIO); a negative exact only after
 *              0 orders in the pooled test (§2.7 — brain/terms.ts decides it); a product never loses a term it wins on
 *              (an order is a guard against every negative).
 *   bids       the lead's bid on the term: its highest EXACT (else any) positive bid; null while the lead has no keyword on
 *              it (a term it only wants). `wouldLower` names each sibling keyword above 0.8 × that bid: the bids lever
 *              lowers it (shadow: named, nothing written).
 */

export const SIBLING_BID_RATIO = 0.8

export type LeadRule = 'pinned' | 'brand' | 'profit' | 'orders' | 'clicks' | 'id'

/** One product's claim on one term in one market. */
export interface Claim {
  productId: string
  term: string
  /** Its positives with the term's text (own campaigns). */
  targets: ReadonlyArray<{ targetId: string; campaignId: string; adGroupId: string; match: string; bidCents: number | null }>
  /** The term passes its harvest test. */
  wants: boolean
  orders: number
  clicks: number
  /** CR̂ × AOV̂ × margin − CPC, pooled; null when it cannot be measured. Money. */
  profitPerClickCents: number | null
  /** The term holds one of its brand or hero words. */
  brandWord: string | null
}

export interface Contender {
  productId: string
  lead: boolean
  targets: number
  wants: boolean
  orders: number
  clicks: number
  profitPerClickCents: number | null
  /** Its highest bid on the term (EXACT first); null: no keyword on it. Money. */
  bidCents: number | null
  brandWord: string | null
}

export interface LeadDecision {
  term: string
  leadProductId: string
  rule: LeadRule
  leadBidCents: number | null
  maxBidCents: number | null
  contenders: Contender[]
  wouldLower: Array<{ productId: string; targetId: string; campaignId: string; adGroupId: string; bidCents: number; toBidCents: number }>
  why: string
}

const claims = (c: Claim) => c.targets.length > 0 || c.wants

/** A product's highest bid on the term: its EXACT (or product-target) keywords first, else any. */
export function bidOn(targets: Claim['targets']): number | null {
  const bids = (list: Claim['targets']) => list.map((t) => t.bidCents).filter((b): b is number => typeof b === 'number' && b > 0)
  const exact = bids(targets.filter((t) => t.match === 'EXACT' || t.match === 'PRODUCT'))
  const any = exact.length ? exact : bids(targets)
  return any.length ? Math.max(...any) : null
}

/** One product's claims merged (a product appears once per term). */
function merge(list: readonly Claim[]): Claim[] {
  const by = new Map<string, Claim>()
  for (const c of list) {
    const was = by.get(c.productId)
    by.set(c.productId, was
      ? { ...was, targets: [...was.targets, ...c.targets], wants: was.wants || c.wants, orders: was.orders + c.orders, clicks: was.clicks + c.clicks, profitPerClickCents: was.profitPerClickCents ?? c.profitPerClickCents, brandWord: was.brandWord ?? c.brandWord }
      : c)
  }
  return [...by.values()]
}

/** Keep the best by one measure; null when the measure decides nothing (all equal, or none measured). */
function best<T>(list: readonly T[], measure: (x: T) => number | null): T[] | null {
  const measured = list.filter((x) => measure(x) != null)
  if (!measured.length) return null
  const top = Math.max(...measured.map((x) => measure(x)!))
  const winners = measured.filter((x) => measure(x) === top)
  return winners.length === list.length && list.length > 1 ? null : winners
}

/** The lead among the contenders of one term, with the rule that decided it. Contenders: at least two, merged. */
export function pickLead(contenders: readonly Claim[], pinned?: string | null): { lead: Claim; rule: LeadRule; why: string } {
  const sorted = [...contenders].sort((a, b) => a.productId.localeCompare(b.productId))
  const pin = pinned ? sorted.find((c) => c.productId === pinned) : undefined
  if (pin) return { lead: pin, rule: 'pinned', why: 'the Owner pinned this product as the lead' }
  const brands = sorted.filter((c) => c.brandWord)
  if (brands.length === 1) return { lead: brands[0], rule: 'brand', why: `the term holds its brand word "${brands[0].brandWord}" and no sibling's` }
  let pool: Claim[] = sorted
  const unmeasured = sorted.filter((c) => c.profitPerClickCents == null)
  // A measured loss must not outrank a seller whose profit is unknown: with no measured profit ≥ 0 and an unmeasured
  // contender that has orders, profit decides nothing and the orders decide among them all.
  const anyGain = sorted.some((c) => c.profitPerClickCents != null && c.profitPerClickCents >= 0)
  const unmeasuredSellers = unmeasured.filter((c) => c.orders > 0)
  const profitDecides = anyGain || !unmeasuredSellers.length
  const byProfit = profitDecides ? best(pool, (c) => c.profitPerClickCents) : null
  if (byProfit && byProfit.length === 1) {
    return { lead: byProfit[0], rule: 'profit', why: `the highest expected profit per click (pooled CR̂ × AOV̂ × margin − CPC)${unmeasured.length ? `; not measured for ${unmeasured.map((c) => c.productId).join(', ')} (no margin, target or order value)` : ''}` }
  }
  if (byProfit) pool = byProfit
  const lossWords = profitDecides ? '' : `no measured profit per click is 0 or more, and ${unmeasuredSellers.map((c) => c.productId).join(', ')} sell${unmeasuredSellers.length === 1 ? 's' : ''} on the term with profit not measured: a measured loss does not outrank ${unmeasuredSellers.length === 1 ? 'it' : 'them'}; `
  const byOrders = best(pool, (c) => c.orders)
  if (byOrders && byOrders.length === 1) return { lead: byOrders[0], rule: 'orders', why: `${byProfit ? 'equal profit per click; ' : lossWords}the most orders on the term (${byOrders[0].orders})` }
  if (byOrders) pool = byOrders
  const byClicks = best(pool, (c) => c.clicks)
  if (byClicks && byClicks.length === 1) return { lead: byClicks[0], rule: 'clicks', why: `${lossWords}equal on profit and orders; the most clicks on the term (${byClicks[0].clicks})` }
  if (byClicks) pool = byClicks
  return { lead: pool[0], rule: 'id', why: `${lossWords}equal on profit, orders and clicks: the lowest product id leads (deterministic)` }
}

/**
 * The leads of every contested term among these claims (any number per term and product; they are merged). `pinned`:
 * the Owner's pinned lead per term. Uncontested terms are left out.
 */
export function arbitrate(all: readonly Claim[], opts: { pinned?: ReadonlyMap<string, string> } = {}): Map<string, LeadDecision> {
  const byTerm = new Map<string, Claim[]>()
  for (const c of all) byTerm.set(c.term, [...(byTerm.get(c.term) ?? []), c])
  const out = new Map<string, LeadDecision>()
  for (const [term, list] of [...byTerm].sort(([a], [b]) => a.localeCompare(b))) {
    const contenders = merge(list).filter(claims)
    if (contenders.length < 2) continue
    const { lead, rule, why } = pickLead(contenders, opts.pinned?.get(term) ?? null)
    const leadBid = bidOn(lead.targets)
    const maxBid = leadBid != null ? Math.floor(leadBid * SIBLING_BID_RATIO) : null
    const wouldLower = maxBid == null ? [] : contenders.filter((c) => c.productId !== lead.productId).flatMap((c) => c.targets
      .filter((t) => typeof t.bidCents === 'number' && t.bidCents > maxBid)
      .map((t) => ({ productId: c.productId, targetId: t.targetId, campaignId: t.campaignId, adGroupId: t.adGroupId, bidCents: t.bidCents!, toBidCents: maxBid })))
    out.set(term, {
      term, leadProductId: lead.productId, rule, leadBidCents: leadBid, maxBidCents: maxBid,
      contenders: contenders.sort((a, b) => a.productId.localeCompare(b.productId)).map((c) => ({
        productId: c.productId, lead: c.productId === lead.productId, targets: c.targets.length, wants: c.wants, orders: c.orders, clicks: c.clicks,
        profitPerClickCents: c.profitPerClickCents, bidCents: bidOn(c.targets), brandWord: c.brandWord,
      })),
      wouldLower,
      why: `${contenders.length} products claim it; product ${lead.productId} leads: ${why}`,
    })
  }
  return out
}
