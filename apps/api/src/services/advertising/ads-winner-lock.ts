/**
 * ADS PLAYBOOK PB-6a — "winners stay": the lock the harvest paths ask before they create or negate a search term.
 *
 *   L1  A negative never lands where it blocks a positive of the same ad group: an exact negative blocks a positive
 *       EXACT keyword with the same text; a phrase negative blocks any positive keyword whose words hold the phrase's
 *       words, in order; a negative product target blocks the positive product target of the same ASIN.
 *   L2  A term that already has a home (a positive EXACT keyword with its text, or for an ASIN a positive product
 *       target) in the product's scope is never created again in another ad group of that scope.
 *
 * The scope is always named by the caller: a rule's own sources and destinations, a playbook's linked slots, the ad
 * groups advertising a product. Never account-wide: another product's keyword "x" never stops this product from
 * buying "x" (the Owner's rule 3). The thresholds a winner is judged on live with the harvest (ads-harvest.service.ts):
 * this module holds no number.
 *
 * positive  an AdTarget with isNegative false, kind KEYWORD (EXACT, PHRASE, BROAD) or PRODUCT, neither it nor its
 *           campaign archived. live = ENABLED with an Amazon id (a floor-suppressed keyword is live: it is the
 *           "stopped with low bids" state).
 */
import prisma from '../../db.js'
import { normaliseNegTerm } from './ads-protect-converting.js'
import { strategyMarketOf } from './ads-strategy/terms.js'

export type PositiveMatch = 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'
export interface Positive { adTargetId: string; adGroupId: string; text: string; match: PositiveMatch; live: boolean }
export type NegativeMatch = 'EXACT' | 'PHRASE' | 'PRODUCT'

const KEYWORD_MATCHES = new Set(['EXACT', 'PHRASE', 'BROAD'])
const words = (s: string): string[] => normaliseNegTerm(s).split(' ').filter(Boolean)
const asinOf = (s: string): string => s.trim().toUpperCase()

/** Positives (not archived) in these ad groups, by AdGroup.id. One read. */
export async function positivesIn(adGroupIds: readonly string[]): Promise<Map<string, Positive[]>> {
  const ids = [...new Set(adGroupIds.filter(Boolean))]
  const out = new Map<string, Positive[]>()
  if (!ids.length) return out
  const rows = await prisma.adTarget.findMany({
    where: {
      adGroupId: { in: ids }, isNegative: false, kind: { in: ['KEYWORD', 'PRODUCT'] }, status: { not: 'ARCHIVED' },
      adGroup: { campaign: { status: { not: 'ARCHIVED' } } },
    },
    select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, status: true, externalTargetId: true },
  })
  for (const r of rows) {
    const match: PositiveMatch | null = r.kind === 'PRODUCT' ? 'PRODUCT' : KEYWORD_MATCHES.has(r.expressionType) ? (r.expressionType as PositiveMatch) : null
    if (!match) continue
    const list = out.get(r.adGroupId) ?? []
    list.push({ adTargetId: r.id, adGroupId: r.adGroupId, text: r.expressionValue, match, live: r.status === 'ENABLED' && r.externalTargetId != null })
    out.set(r.adGroupId, list)
  }
  return out
}

/** The key a standing negative is found by: ad group, match type, normalised text (an ASIN upper-cased). */
export const negativeKey = (adGroupId: string, match: NegativeMatch, text: string): string =>
  `${adGroupId}|${match}|${match === 'PRODUCT' ? asinOf(text) : normaliseNegTerm(text)}`

/**
 * The negatives (not archived) that already stand in these ad groups, as `negativeKey`s. One read. A harvest that
 * finds its negative standing proposes it no more (it used to come back every run, and its write answered "already
 * there" as if it had been added).
 */
export async function standingNegativesIn(adGroupIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(adGroupIds.filter(Boolean))]
  if (!ids.length) return new Set()
  const rows = await prisma.adTarget.findMany({
    where: { adGroupId: { in: ids }, isNegative: true, kind: { in: ['KEYWORD', 'PRODUCT'] }, status: { not: 'ARCHIVED' } },
    select: { adGroupId: true, kind: true, expressionType: true, expressionValue: true },
  })
  const out = new Set<string>()
  for (const r of rows) {
    const match: NegativeMatch | null = r.kind === 'PRODUCT' ? 'PRODUCT' : /PHRASE/.test(r.expressionType) ? 'PHRASE' : /EXACT/.test(r.expressionType) ? 'EXACT' : null
    if (match) out.add(negativeKey(r.adGroupId, match, r.expressionValue))
  }
  return out
}

/** True when `inner`'s words appear in `outer`'s, next to each other and in the same order (phrase match). */
function containsInOrder(outer: readonly string[], inner: readonly string[]): boolean {
  if (!inner.length || inner.length > outer.length) return false
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true
  }
  return false
}

/** Pure — the positive a negative would block in the same ad group (L1), or null. */
export function blockedPositive(neg: { text: string; match: NegativeMatch }, positives: readonly Positive[]): Positive | null {
  if (neg.match === 'PRODUCT') {
    const asin = asinOf(neg.text)
    return positives.find((p) => p.match === 'PRODUCT' && asinOf(p.text) === asin) ?? null
  }
  const text = normaliseNegTerm(neg.text)
  if (!text) return null
  if (neg.match === 'EXACT') return positives.find((p) => p.match === 'EXACT' && normaliseNegTerm(p.text) === text) ?? null
  const phrase = words(neg.text)
  return positives.find((p) => p.match !== 'PRODUCT' && containsInOrder(words(p.text), phrase)) ?? null
}

/**
 * Pure — T's home among positives (L2): the positive EXACT keyword with the same normalised text, or for an ASIN the
 * positive product target. `match` asks for another keyword match type's home instead (a PHRASE graduation's).
 * A live one is preferred when several hold it.
 */
export function homeOf(term: string, positives: Iterable<Positive>, match?: Exclude<PositiveMatch, 'PRODUCT'>): Positive | null {
  const asin = /^b0[a-z0-9]{8}$/i.test(term.trim())
  const want: PositiveMatch = asin ? 'PRODUCT' : match ?? 'EXACT'
  const key = asin ? asinOf(term) : normaliseNegTerm(term)
  let found: Positive | null = null
  for (const p of positives) {
    if (p.match !== want || (asin ? asinOf(p.text) : normaliseNegTerm(p.text)) !== key) continue
    if (p.live) return p
    found ??= p
  }
  return found
}

/** The words a refusal by L1 says, naming the keyword it protects. */
export function blockedWords(p: Positive): string {
  const what = p.match === 'PRODUCT' ? `product target ${p.text}` : `${p.match.toLowerCase()} keyword "${p.text}"`
  return `it would block your own ${what} in this ad group, which is${p.live ? '' : ' not yet'} live there. A winner is never negated where it is a keyword; to stop it, lower its bid.`
}

/**
 * L2 for one keyword about to be created in `destAdGroupId` (graduate-keyword): the term's home for the products that ad
 * group advertises, in its market — a positive EXACT keyword in another ad group advertising one of them (the same
 * product id, or the same ASIN). A keyword another product holds is never a home here (rule 3).
 */
export async function sameProductHome(query: string, destAdGroupId: string, marketplace: string | null): Promise<{ campaign: string; adGroup: string } | null> {
  const ads = await prisma.adProductAd.findMany({ where: { adGroupId: destAdGroupId, status: { not: 'ARCHIVED' } }, select: { productId: true, asin: true } })
  const productIds = [...new Set(ads.map((a) => a.productId).filter((id): id is string => !!id))]
  const asins = [...new Set(ads.map((a) => a.asin?.trim()).filter((a): a is string => !!a))]
  if (!productIds.length && !asins.length) return null
  const same = [...(productIds.length ? [{ productId: { in: productIds } }] : []), ...(asins.length ? [{ asin: { in: asins } }] : [])]
  const groups = await prisma.adGroup.findMany({
    where: { id: { not: destAdGroupId }, productAds: { some: { status: { not: 'ARCHIVED' }, OR: same } } },
    select: { id: true, name: true, campaign: { select: { name: true, marketplace: true } } },
  })
  const market = strategyMarketOf(marketplace)
  const inMarket = groups.filter((g) => strategyMarketOf(g.campaign?.marketplace) === market)
  const home = homeOf(query, [...(await positivesIn(inMarket.map((g) => g.id))).values()].flat())
  const where = home ? inMarket.find((g) => g.id === home.adGroupId) : null
  return where ? { campaign: where.campaign?.name ?? '?', adGroup: where.name } : null
}
