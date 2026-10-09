/**
 * ADS PLAYBOOK PB-6a — "winners stay": the lock the harvest paths and the negative write service ask.
 *
 *   L1  A negative never lands where it blocks a positive of the same ad group (campaign scope: of any ad group of the
 *       campaign): an exact negative blocks a positive EXACT keyword with the same text; a phrase negative blocks any
 *       positive keyword whose words hold the phrase's words, in order; a negative product target blocks the positive
 *       product target of the same ASIN. Enforced for EVERY writer inside ads-negative-kw.service.ts (ownKeywordRefusal):
 *       refused by name, with the keyword it would block, "remove or lower that keyword instead".
 *   L2  A term that already has a home (a positive EXACT keyword with its text, or for an ASIN a positive product
 *       target) among the ad groups of the SAME product in its market is never created again in another of them.
 *
 * The product: what the caller's own ad groups advertise, with its sibling variants of one parent (productFamilyOf),
 * in one market (familyAdGroups). Never account-wide, never another product's: another product's keyword "x" never
 * stops this product from buying "x" (the Owner's rule 3). The thresholds a winner is judged on live with the harvest
 * (ads-harvest.service.ts): this module holds no number.
 *
 * positive  an AdTarget with isNegative false, kind KEYWORD (EXACT, PHRASE, BROAD) or PRODUCT, neither it nor its
 *           campaign archived. live = ENABLED with an Amazon id (a floor-suppressed keyword is live: it is the
 *           "stopped with low bids" state).
 */
import prisma from '../../db.js'
import { normaliseNegTerm } from './ads-protect-converting.js'
import { strategyMarketOf } from './ads-strategy/terms.js'

export type PositiveMatch = 'EXACT' | 'PHRASE' | 'BROAD' | 'PRODUCT'
/** PB-10 — `waiting`: a keyword a playbook sync added at the floor that START has not given its planned bid yet (set by the
 *  playbook's isolation loader, never here): a keyword for the lock, but no home a search can be sent to. */
export interface Positive { adTargetId: string; adGroupId: string; text: string; match: PositiveMatch; live: boolean; waiting?: boolean }
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

/**
 * Pure — would this negative block a search for `term`? An exact negative blocks the same words; a phrase negative
 * every search whose words hold its words, next to each other and in order.
 */
export function negativeBlocksTerm(neg: { text: string; match: 'EXACT' | 'PHRASE' }, term: string): boolean {
  if (neg.match === 'EXACT') return !!normaliseNegTerm(neg.text) && normaliseNegTerm(neg.text) === normaliseNegTerm(term)
  return containsInOrder(words(term), words(neg.text))
}

/**
 * The Owner's match-type funnel (2026-10-09): a negative phrase of two words or more in an ad group buying BROAD keywords
 * holding its words NARROWS them — the searches holding the phrase go to its tighter home, and the broad keywords still
 * serve their words apart or in another order. Only the brain's funnel asks for it (brain/negatives.ts); a one-word phrase
 * still blocks a broad keyword holding that word (every search it could serve holds it), and an exact or phrase keyword
 * holding the phrase is still blocked.
 */
export interface BlockOpts { broadNarrowing?: boolean }

/** A phrase negative the funnel may stand over broad keywords: two words or more. */
export const narrowsBroad = (negText: string): boolean => words(negText).length >= 2

/** Pure — the positive a negative would block in the same ad group (L1), or null. */
export function blockedPositive(neg: { text: string; match: NegativeMatch }, positives: readonly Positive[], opts: BlockOpts = {}): Positive | null {
  if (neg.match === 'PRODUCT') {
    const asin = asinOf(neg.text)
    return positives.find((p) => p.match === 'PRODUCT' && asinOf(p.text) === asin) ?? null
  }
  const text = normaliseNegTerm(neg.text)
  if (!text) return null
  if (neg.match === 'EXACT') return positives.find((p) => p.match === 'EXACT' && normaliseNegTerm(p.text) === text) ?? null
  const phrase = words(neg.text)
  const narrows = opts.broadNarrowing === true && narrowsBroad(neg.text)
  return positives.find((p) => p.match !== 'PRODUCT' && !(narrows && p.match === 'BROAD') && containsInOrder(words(p.text), phrase)) ?? null
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

/** The words a refusal by L1 says, naming the keyword it protects and where. */
export function blockedWords(p: Positive, adGroupName?: string | null): string {
  const what = p.match === 'PRODUCT' ? `product target ${p.text}` : `${p.match.toLowerCase()} keyword "${p.text}"`
  return `it would block your own ${what}${adGroupName ? ` in ad group "${adGroupName}"` : ' in its ad group'}${p.live ? '' : ' (not yet live at Amazon)'}. Remove or lower that keyword instead.`
}

/**
 * L1 at the one negative write service (ads-negative-kw.service.ts): the refusal for a negative that would block a
 * positive where it lands — its ad group, or (campaign scope) any ad group of its campaign. Null: it blocks nothing.
 * Every writer asks it: the rules, the harvest, n-grams, the funnel, Claude's tools, the screens and the bulk sheet.
 */
export async function ownKeywordRefusal(where: { scope: 'AD_GROUP' | 'CAMPAIGN'; adGroupId: string | null; campaignId: string }, text: string, match: NegativeMatch, opts: BlockOpts = {}): Promise<{ deniedAt: string; reason: string } | null> {
  const ids = where.scope === 'AD_GROUP'
    ? (where.adGroupId ? [where.adGroupId] : [])
    : (await prisma.adGroup.findMany({ where: { campaignId: where.campaignId }, select: { id: true } })).map((g) => g.id)
  const own = blockedPositive({ text, match }, [...(await positivesIn(ids)).values()].flat(), opts)
  if (!own) return null
  const group = await prisma.adGroup.findUnique({ where: { id: own.adGroupId }, select: { name: true } })
  const neg = match === 'PRODUCT' ? `A negative product target ${text.trim()}` : `A negative ${match.toLowerCase()} "${text.trim()}"`
  return { deniedAt: 'own_keyword', reason: `${neg} was not added: ${blockedWords(own, group?.name)}` }
}

// ── L2 scope: the product's own ad groups ────────────────────────────────────────────────────────

/** A product family: Product.ids (each product, its parent and the parent's other children) and their ASINs. */
export interface ProductFamily { productIds: string[]; asins: string[] }

const asinForms = (asins: Iterable<string>) => [...new Set([...asins].flatMap((a) => [a.toUpperCase(), a.toLowerCase()]))]

/**
 * The products these ad groups advertise, each with its sibling variants of one parent. A product ad Nexus cannot tie
 * to a product counts by its own ASIN only. Only these ad groups' products: an ad group's own campaigns are the rule's.
 */
export async function productFamilyOf(adGroupIds: readonly string[]): Promise<ProductFamily> {
  const ids = [...new Set(adGroupIds.filter(Boolean))]
  if (!ids.length) return { productIds: [], asins: [] }
  const ads = await prisma.adProductAd.findMany({ where: { adGroupId: { in: ids }, status: { not: 'ARCHIVED' } }, select: { productId: true, asin: true } })
  const seedAsins = new Set(ads.map((a) => a.asin?.trim().toUpperCase()).filter((a): a is string => !!a))
  const seedIds = new Set(ads.map((a) => a.productId).filter((id): id is string => !!id))
  if (seedAsins.size) {
    for (const p of await prisma.product.findMany({ where: { deletedAt: null, amazonAsin: { in: asinForms(seedAsins) } }, select: { id: true } })) seedIds.add(p.id)
  }
  return familyOfProducts(seedIds, seedAsins)
}

/**
 * These products' family: each product, its parent and the parent's other children, with their ASINs (PB-7: the same
 * "same product" as the home's). `asins`: ASINs counted for the family even when no product has them.
 */
export async function familyOfProducts(productIds: Iterable<string>, asins: Iterable<string> = []): Promise<ProductFamily> {
  const seedIds = new Set(productIds)
  const seedAsins = new Set([...asins].map(asinOf))
  if (!seedIds.size) return { productIds: [], asins: [...seedAsins] }
  const seeds = await prisma.product.findMany({ where: { id: { in: [...seedIds] } }, select: { id: true, parentId: true } })
  const roots = [...new Set(seeds.map((p) => p.parentId ?? p.id))]
  const members = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: roots } }, { parentId: { in: roots } }] }, select: { id: true, amazonAsin: true } })
  return {
    productIds: [...new Set([...seedIds, ...members.map((m) => m.id)])],
    asins: [...new Set([...seedAsins, ...members.map((m) => m.amazonAsin?.trim().toUpperCase()).filter((a): a is string => !!a)])],
  }
}

/** The ad groups of one market (campaign not archived) that advertise a product of this family — never another product's. */
export async function familyAdGroups(family: ProductFamily, marketplace: string | null): Promise<string[]> {
  const same = [
    ...(family.productIds.length ? [{ productId: { in: family.productIds } }] : []),
    ...(family.asins.length ? [{ asin: { in: asinForms(family.asins) } }] : []),
  ]
  if (!same.length) return []
  const groups = await prisma.adGroup.findMany({
    where: { campaign: { status: { not: 'ARCHIVED' } }, productAds: { some: { status: { not: 'ARCHIVED' }, OR: same } } },
    select: { id: true, campaign: { select: { marketplace: true } } },
  })
  const market = strategyMarketOf(marketplace)
  return groups.filter((g) => strategyMarketOf(g.campaign?.marketplace) === market).map((g) => g.id)
}

/**
 * L2 for one keyword about to be created in `destAdGroupId` (graduate-keyword): the term's home for the product it
 * converted for — the products of its source ad groups that the destination also advertises (else the destination's),
 * with their sibling variants — in an ad group of the market. A keyword another product holds is never a home (rule 3).
 */
export async function sameProductHome(query: string, args: { destAdGroupId: string; source: { adGroupId?: string | null; campaignId: string }; marketplace: string | null }): Promise<{ campaign: string; adGroup: string } | null> {
  const sourceAdGroupIds = args.source.adGroupId
    ? [args.source.adGroupId]
    : (await prisma.adGroup.findMany({ where: { campaignId: args.source.campaignId }, select: { id: true } })).map((g) => g.id)
  const [dest, source] = await Promise.all([productFamilyOf([args.destAdGroupId]), productFamilyOf(sourceAdGroupIds)])
  const shared: ProductFamily = { productIds: dest.productIds.filter((id) => source.productIds.includes(id)), asins: dest.asins.filter((a) => source.asins.includes(a)) }
  const own = shared.productIds.length || shared.asins.length ? shared : dest
  const scope = (await familyAdGroups(own, args.marketplace)).filter((id) => id !== args.destAdGroupId)
  const home = homeOf(query, [...(await positivesIn(scope)).values()].flat())
  if (!home) return null
  const where = await prisma.adGroup.findUnique({ where: { id: home.adGroupId }, select: { name: true, campaign: { select: { name: true } } } })
  return { campaign: where?.campaign?.name ?? '?', adGroup: where?.name ?? '?' }
}

/**
 * PB-7 (the Owner's rule 3) — the ad groups that advertise ONLY this product family (familyOfProducts: the product with
 * its sibling variants, the "same product" a home is), and the others with the reason. An ad group that also advertises
 * another product is never kept apart: two products may buy the same keyword, and a negative there would stop the other
 * one too. Fails closed: a product ad Nexus cannot place in the family (no product and an ASIN no family member has)
 * counts as another product's; an ad group with no product ad advertises nothing of this product.
 */
export async function familyOnly(adGroupIds: readonly string[], family: ProductFamily): Promise<{ ok: string[]; excluded: Array<{ adGroupId: string; why: string }> }> {
  const ids = [...new Set(adGroupIds.filter(Boolean))]
  if (!ids.length) return { ok: [], excluded: [] }
  const members = new Set(family.productIds)
  const asins = new Set(family.asins.map(asinOf))
  const ads = await prisma.adProductAd.findMany({ where: { adGroupId: { in: ids }, status: { not: 'ARCHIVED' } }, select: { adGroupId: true, productId: true, asin: true, sku: true, product: { select: { sku: true } } } })
  const byGroup = new Map<string, typeof ads>()
  for (const a of ads) byGroup.set(a.adGroupId, [...(byGroup.get(a.adGroupId) ?? []), a])
  const ok: string[] = []
  const excluded: Array<{ adGroupId: string; why: string }> = []
  for (const id of ids) {
    const list = byGroup.get(id) ?? []
    if (!list.length) { excluded.push({ adGroupId: id, why: 'it advertises no product, so nothing of this product runs there' }); continue }
    const foreign = list.find((a) => (a.productId ? !members.has(a.productId) : !(a.asin && asins.has(asinOf(a.asin)))))
    if (foreign) {
      const name = foreign.product?.sku ?? foreign.sku ?? foreign.asin ?? 'a product Nexus cannot name'
      excluded.push({ adGroupId: id, why: `it also advertises ${name}, which is not this product: a campaign that advertises another product is never kept apart (two products may buy the same keyword)` })
    } else ok.push(id)
  }
  return { ok, excluded }
}
