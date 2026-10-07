/**
 * ADS AUTONOMY W4-5 — what the targeting and negatives tools share (ads-targets.tools.ts: add-ad-targets,
 * harvest-search-term, set-harvest-destination; ads-negatives.tools.ts: add-negative-targets, retire-negatives):
 *
 *   rule 2   the Owner's rule (2026-10-06), winners stay where they win: a negative Claude asks for never blocks a search
 *            term that CONVERTS where it lands — an order there on any day Nexus keeps (WINDOW_DAYS, the 90 days of search
 *            terms it keeps: longer than any settled harvest window PB-6c judges a winner on, 30, 60 or 90, so a PB-6c
 *            winner is always converting here), for the product that ad group advertises — refused, naming the term, the
 *            ad group and its orders. One exception, the harvest's own "proven" handover (PB-6a L4, PB-7, PB-6c): the
 *            term already lives as an exact keyword (an ASIN: a product target) in another ad group of the SAME product in
 *            the market that SERVES — the keyword, its ad group and its campaign enabled, none at a floor (a stopped home
 *            is no home) — and it wins there (homeWinners: the harvest bar where it lives). Closing the old place is then
 *            the handover: the card says so, and a person decides it, never a rule.
 *   rule 3   isolation is per product only (lead decision 2026-10-07: products MAY share keywords, never blocked): a
 *            negative in ANY ad group of another product is listed, and runs only when the person says so
 *            (allowOtherProducts — never by rule), whether that product bought the term yet or not (what it bought there
 *            is said). Whose product it is: the product named, else the one every ad group advertises (with its sibling
 *            variants of one parent); an ad group that also advertises another product is another product's (as PB-7's
 *            familyOnly); an ad group that advertises no product is nobody's.
 *   reach    every campaign a request writes to answers the write gate the same way, or it is refused; the own limits
 *            any of them goes past are kept on the reach (the card's warning, a plan's too).
 *   the code each tool decides in ONE helper of its own whether approving needs the approver's authenticator code (its
 *            preview's stepUp: the Owner's code policy is still open, so it changes in one place); `spendGate` reads that
 *            stepUp in `execute`: a person's approval runs only with the code, a run the business's rule decided only
 *            inside the tool's limits. Every raise is in the preview's `raises`, whatever the code decision.
 *
 * Read only, but for nothing: no number of its own — "converts" is an order, "buys" an impression or a click, "wins"
 * the harvest bar.
 */
import { createHash } from 'node:crypto'
import prisma from '../../../db.js'
import { searchTermTotals, homeWinners, winnerKey, type HarvestCandidate } from '../../advertising/ads-harvest.service.js'
import { familyAdGroups, homeOf, negativeBlocksTerm, positivesIn, productFamilyOf, type Positive } from '../../advertising/ads-winner-lock.js'
import { normaliseNegTerm } from '../../advertising/ads-protect-converting.js'
import { adGroupPlaces } from '../../advertising/ads-targeting-lookup.service.js'
import { checkLiveReach, LOW_BID_UNFLAGGED_CENTS, type AdWriteIntent, type LiveReach } from './ads-tool-guards.js'
import { canonical, type StoredReach } from './ads-change-kit.js'
import { SEARCH_TERM_DAYS_KEPT } from '../../advertising/ads-settled-window.js'
import { stepUpApproval, stepUpOf } from '../step-up-approval.js'
import type { ToolContext } from '../tool-types.js'

/**
 * The window both rules read: every day of search terms Nexus keeps (PB-6c's SEARCH_TERM_DAYS_KEPT), so rule 2 sees every
 * order any harvest window could have judged a winner on (the strategy's are 30, 60 or 90 days, settled).
 */
export const WINDOW_DAYS = SEARCH_TERM_DAYS_KEPT

/** One negative, and the ad groups it blocks in: its ad group, or every ad group of its campaign (campaign scope). */
export interface NegativePlacement {
  key: string
  text: string
  match: 'EXACT' | 'PHRASE' | 'PRODUCT'
  adGroupIds: string[]
}

/** What one negative blocks of what ran where it lands, summed over the window (its record). */
export interface BlockedRecord { terms: number; impressions: number; clicks: number; spendCents: number; orders: number }

export interface ConvertingHit { key: string; term: string; adGroupId: string; place: string; orders: number; clicks: number; spendCents: number }
export interface Handover { key: string; term: string; place: string; home: string }
export interface OtherProductHit { key: string; adGroupId: string; place: string; products: string[]; terms: Array<{ term: string; impressions: number; clicks: number; spendCents: number }> }

export interface TermRules {
  windowDays: number
  /** Each negative's record where it lands. */
  records: Record<string, BlockedRecord>
  /** Rule 2 — converting terms a negative would block (refused). */
  converting: ConvertingHit[]
  /** Rule 2 — converting terms whose live exact home elsewhere wins: the proven handover. */
  handovers: Handover[]
  /** Rule 3 — another product's ad groups a negative lands in (with what of it that product bought there, maybe nothing). */
  otherProducts: OtherProductHit[]
  /** The product the negatives are for, as a person reads it (null: none, or several). */
  productFor: string | null
}

interface GroupRow { id: string; name: string; externalAdGroupId: string | null; campaign: { name: string; marketplace: string | null } }

/** What a person calls an ad group: `ad group "x" (campaign "y")`. */
export const placeWords = (g: Pick<GroupRow, 'name' | 'campaign'>) => `ad group "${g.name}" (campaign "${g.campaign.name}")`

const asinKey = (s: string) => s.trim().toUpperCase()

/** Pure — does this negative block a search for `query`? An ASIN negative blocks that ASIN only. */
export function blocks(neg: Pick<NegativePlacement, 'text' | 'match'>, query: string): boolean {
  if (neg.match === 'PRODUCT') return asinKey(query) === asinKey(neg.text)
  return negativeBlocksTerm({ text: neg.text, match: neg.match }, query)
}

/**
 * The products each ad group advertises, as family roots (a product's parent, else itself; an ASIN no product has:
 * `asin:<ASIN>`), with the names a person reads (the ad's SKU, else its ASIN). An ad group with no product ad has none.
 */
export async function productRootsOf(adGroupIds: readonly string[]): Promise<Map<string, { roots: Set<string>; names: string[] }>> {
  const ids = [...new Set(adGroupIds.filter(Boolean))]
  const out = new Map<string, { roots: Set<string>; names: string[] }>(ids.map((id) => [id, { roots: new Set<string>(), names: [] as string[] }]))
  if (!ids.length) return out
  const ads = await prisma.adProductAd.findMany({ where: { adGroupId: { in: ids }, status: { not: 'ARCHIVED' } }, select: { adGroupId: true, productId: true, asin: true, sku: true } })
  const productIds = [...new Set(ads.map((a) => a.productId).filter((id): id is string => !!id))]
  const asins = [...new Set(ads.filter((a) => !a.productId && a.asin).map((a) => asinKey(a.asin!)))]
  const products = productIds.length || asins.length
    ? await prisma.product.findMany({
      where: { deletedAt: null, OR: [...(productIds.length ? [{ id: { in: productIds } }] : []), ...(asins.length ? [{ amazonAsin: { in: [...asins, ...asins.map((a) => a.toLowerCase())] } }] : [])] },
      select: { id: true, sku: true, parentId: true, amazonAsin: true },
    })
    : []
  const byId = new Map(products.map((p) => [p.id, p]))
  const byAsin = new Map(products.filter((p) => p.amazonAsin).map((p) => [asinKey(p.amazonAsin!), p]))
  for (const ad of ads) {
    const product = (ad.productId ? byId.get(ad.productId) : undefined) ?? (ad.asin ? byAsin.get(asinKey(ad.asin)) : undefined)
    const entry = out.get(ad.adGroupId)!
    entry.roots.add(product ? product.parentId ?? product.id : `asin:${asinKey(ad.asin ?? ad.sku ?? '?')}`)
    const name = ad.sku ?? product?.sku ?? ad.asin ?? 'a product Nexus cannot name'
    if (!entry.names.includes(name)) entry.names.push(name)
  }
  return out
}

/** The family root of one product, named by its SKU or its Nexus id; null when this business has no such product. */
export async function productRootOf(product: string): Promise<{ root: string; label: string } | null> {
  const row = await prisma.product.findFirst({ where: { deletedAt: null, OR: [{ id: product }, { sku: product }] }, select: { id: true, sku: true, parentId: true } })
  return row ? { root: row.parentId ?? row.id, label: row.sku } : null
}

/**
 * Rules 2 and 3 for these negatives (see the header). `product`: the product they are for, named by the caller (its
 * family root); absent, the one product every ad group advertises, if there is one.
 */
export async function termRulesFor(placements: readonly NegativePlacement[], opts: { product?: { root: string; label: string } | null } = {}): Promise<TermRules> {
  const groupIds = [...new Set(placements.flatMap((p) => p.adGroupIds))]
  const groups: Map<string, GroupRow> = await adGroupPlaces(groupIds)
  const externals = [...groups.values()].map((g) => g.externalAdGroupId).filter((id): id is string => !!id)
  const ran = new Map<string, HarvestCandidate[]>()
  for (const t of externals.length ? (await searchTermTotals(WINDOW_DAYS, externals)).values() : []) ran.set(t.externalAdGroupId, [...(ran.get(t.externalAdGroupId) ?? []), t])

  // Rule 3 — whose products each ad group advertises, and whose the negatives are.
  const roots = await productRootsOf(groupIds)
  const every = new Set([...roots.values()].flatMap((r) => [...r.roots]))
  const own = opts.product ? new Set([opts.product.root]) : every.size === 1 ? every : null
  const ownNames = opts.product ? opts.product.label : every.size === 1 ? [...roots.values()].flatMap((r) => r.names).filter((n, i, all) => all.indexOf(n) === i).join(', ') : null
  const foreign = (adGroupId: string) => {
    const mine = roots.get(adGroupId)?.roots ?? new Set<string>()
    if (!mine.size) return false
    return own ? [...mine].some((r) => !own.has(r)) : every.size > 1
  }

  const records: Record<string, BlockedRecord> = {}
  const candidates: ConvertingHit[] = []
  const otherProducts: OtherProductHit[] = []
  for (const p of placements) {
    const record: BlockedRecord = { terms: 0, impressions: 0, clicks: 0, spendCents: 0, orders: 0 }
    for (const adGroupId of p.adGroupIds) {
      const g = groups.get(adGroupId)
      if (!g?.externalAdGroupId) continue
      const blocked = (ran.get(g.externalAdGroupId) ?? []).filter((t) => blocks(p, t.query))
      for (const t of blocked) {
        record.terms++; record.impressions += t.impressions; record.clicks += t.clicks; record.spendCents += t.costCents; record.orders += t.orders
        if (t.orders > 0) candidates.push({ key: p.key, term: t.query, adGroupId, place: placeWords(g), orders: t.orders, clicks: t.clicks, spendCents: t.costCents })
      }
      // Rule 3 — any ad group of another product, whether it bought the term yet or not (lead decision 2026-10-07).
      const bought = blocked.filter((t) => t.impressions > 0 || t.clicks > 0)
      if (foreign(adGroupId)) {
        otherProducts.push({
          key: p.key, adGroupId, place: placeWords(g), products: roots.get(adGroupId)?.names.slice(0, 5) ?? [],
          terms: bought.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 3).map((t) => ({ term: t.query, impressions: t.impressions, clicks: t.clicks, spendCents: t.costCents })),
        })
      }
    }
    records[p.key] = record
  }

  // Rule 2's one exception: an exact home of the same product elsewhere in the market that serves and wins there.
  const homes = new Map<string, Positive>()
  const familyCache = new Map<string, Promise<string[]>>()
  const scopeOf = (adGroupId: string) => {
    let s = familyCache.get(adGroupId)
    if (!s) familyCache.set(adGroupId, (s = productFamilyOf([adGroupId]).then((family) => familyAdGroups(family, groups.get(adGroupId)?.campaign.marketplace ?? null))))
    return s
  }
  for (const c of candidates) {
    const scope = (await scopeOf(c.adGroupId)).filter((id) => id !== c.adGroupId)
    const home = homeOf(c.term, [...(await positivesIn(scope)).values()].flat())
    if (home?.live) homes.set(`${c.key}|${c.adGroupId}|${normaliseNegTerm(c.term)}`, home)
  }
  // A stopped home is no home: a paused or floored keyword, ad group or campaign serves nothing to hand over to.
  const serving = await servingTargets([...new Set([...homes.values()].map((h) => h.adTargetId))])
  for (const [key, home] of [...homes]) if (!serving.has(home.adTargetId)) homes.delete(key)
  const winners = await homeWinners([...homes.values()].map((h) => ({ term: h.text, adGroupId: h.adGroupId })), {})
  const homeGroups = await adGroupPlaces([...homes.values()].map((h) => h.adGroupId))
  const converting: ConvertingHit[] = []
  const handovers: Handover[] = []
  for (const c of candidates) {
    const home = homes.get(`${c.key}|${c.adGroupId}|${normaliseNegTerm(c.term)}`)
    const proven = home && winners.has(winnerKey(home.text, home.adGroupId))
    const where = home ? homeGroups.get(home.adGroupId) : undefined
    if (proven && where) handovers.push({ key: c.key, term: c.term, place: c.place, home: placeWords(where) })
    else converting.push(c)
  }
  return { windowDays: WINDOW_DAYS, records, converting, handovers, otherProducts, productFor: ownNames }
}

/**
 * Of these positive targets, the ones that serve now (PB-6c's "held", winners.ts): the target enabled at Amazon, no
 * no-pause memory and a bid above the floor; its ad group enabled, not gone and not at its own floor; its campaign
 * enabled and not at a floor.
 */
async function servingTargets(ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const rows = await prisma.adTarget.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true, status: true, externalTargetId: true, bidCents: true, suppressedFromBidCents: true,
      adGroup: { select: { status: true, orphanedAt: true, bidsSuppressedAt: true, campaign: { select: { status: true, bidsSuppressedAt: true } } } },
    },
  })
  return new Set(rows.filter((t) => String(t.status) === 'ENABLED' && !!t.externalTargetId && t.suppressedFromBidCents == null && t.bidCents > LOW_BID_UNFLAGGED_CENTS
    && String(t.adGroup.status) === 'ENABLED' && !t.adGroup.orphanedAt && !t.adGroup.bidsSuppressedAt
    && String(t.adGroup.campaign.status) === 'ENABLED' && !t.adGroup.campaign.bidsSuppressedAt).map((t) => t.id))
}

/** Rule 2's refusal, naming each term, where it converts and its orders (at most three, then a count). */
export function convertingWords(hits: readonly ConvertingHit[]): string {
  const shown = hits.slice(0, 3).map((h) => `"${h.term}" in ${h.place}: ${h.orders} order${h.orders === 1 ? '' : 's'}`).join('; ')
  return `${shown}${hits.length > 3 ? `; and ${hits.length - 3} more` : ''}`
}

/** Rule 3's list, naming each ad group, its products and what of the term it bought (at most three, then a count). */
export function otherProductWords(hits: readonly OtherProductHit[]): string {
  const bought = (h: OtherProductHit) => (h.terms.length
    ? ` and bought ${h.terms.map((t) => `"${t.term}" (${t.clicks} click${t.clicks === 1 ? '' : 's'})`).join(', ')} there`
    : ' (it has not bought the term there yet)')
  const shown = hits.slice(0, 3).map((h) => `${h.place}, which advertises ${h.products.join(', ') || 'another product'}${bought(h)}`).join('; ')
  return `${shown}${hits.length > 3 ? `; and ${hits.length - 3} more` : ''}`
}

// ── Shared by the five tools ──────────────────────────────────────────────────────────────────────

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

/** "a, b and 3 more". */
export function named(list: readonly string[], shown = 3): string {
  const head = list.slice(0, shown)
  return list.length > shown ? `${head.join(', ')} and ${list.length - shown} more` : head.join(', ')
}

/** A short fingerprint of a value (keys sorted): the basis an approval freezes. */
export const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)

/**
 * Where a request's writes land: every campaign answers the write gate the same way, or the request is refused (the
 * first refusal, named by its campaign). Some live and some sandbox: live (that is what reaches Amazon), on every
 * profile named. The own limits any write goes past are kept, once each (4A + 3A: the card warns before approval).
 */
export async function reachOver(writes: ReadonlyArray<AdWriteIntent & { label: string }>): Promise<{ reach: StoredReach } | { refused: Extract<LiveReach, { reach: 'refused' }>; label: string }> {
  const profiles = new Set<string>()
  const past = new Map<string, { limit: string; reason: string }>()
  for (const { label, ...intent } of writes) {
    const reach = await checkLiveReach(intent)
    if (reach.reach === 'refused') return { refused: reach, label }
    if (reach.reach !== 'live') continue
    profiles.add(reach.profileId)
    for (const l of reach.pastOwnLimits ?? []) if (!past.has(l.reason)) past.set(l.reason, { limit: l.limit, reason: l.reason })
  }
  if (!profiles.size) return { reach: { reach: 'sandbox' } }
  return { reach: { reach: 'live', profileId: [...profiles].sort().join(','), ...(past.size ? { pastOwnLimits: [...past.values()] } : {}) } }
}

/**
 * The ONE gate of a request whose approval needs the approver's code (PB-5b spendGate, ads-playbook-apply.tools.ts): it
 * reads the stepUp of the fresh preview, which each tool's own code helper decided. A person's approval runs it only
 * with the approver's fresh authenticator code; a run the business's rule decided runs inside the tool's limits
 * (withinLimits judged it). A preview without a stepUp passes.
 */
export async function spendGate(ctx: Pick<ToolContext, 'approvalId' | 'can' | 'decidedVia'>, preview: unknown): Promise<{ byRule: boolean } | { refusal: string }> {
  const stepUp = stepUpOf(preview)
  if (!stepUp) return { byRule: false }
  if (ctx.decidedVia === 'auto') return { byRule: true }
  const what = stepUp.what
  const coded = await stepUpApproval(ctx)
  if (!('refusal' in coded)) return { byRule: false }
  return { refusal: coded.refusal.replace('it raises, and a raise runs', `it ${what}, and that runs`).replace('it raises, and', `it ${what}, and`).replace('which a raise needs', 'which that needs') }
}
