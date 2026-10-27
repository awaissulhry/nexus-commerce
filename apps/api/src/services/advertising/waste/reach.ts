/**
 * Negative Targeting page, step 4 (2026-10-25) — the reach check of a negative: what it would block, before
 * a person sends it. The Owner's words: "Blocks 14 terms · €32 in 60 days · 0 orders", and a red warning when a term that
 * sold would be blocked.
 *
 *   what      exact: that search term in its place; phrase: every search term of the place holding the words, whole and
 *             in order (pure.ts negativeBlocksTerm, the rule every read of this page blocks by); product: that ASIN. Its
 *             place is one ad group, or every ad group of a campaign (a campaign negative). A term a standing negative
 *             blocks there now is not counted: this negative changes nothing for it (one switched off, or that Amazon
 *             never took, blocks nothing: it is counted).
 *   numbers   the page's own numbers over the page's window (read.ts criteriaOf: 60 days, or the ads strategy's): clicks
 *             and spend to 3 days ago with the days out of stock left out, orders and sales to today — the same sums the
 *             rows show, from the market's facts the page just read (read.ts marketWasteFacts, reused a short while)
 *   sold      at most MAX_SOLD terms with an order in the window that it would block: a warning, never a refusal (the
 *             tools keep their own holds: add-negative-targets refuses a term that converts where it lands)
 *   money     cents of the place's currency under the WASTE_MONEY keys (spendCents, salesCents): stripped for a person
 *             without financials.adspend.view, who still reads the counts
 *
 * One function for the page and for Claude: write.ts previewWaste adds `reach` to every NEGATE_* step after the items
 * are expanded into steps (withReach), and the Nexus tools that add negatives (add-negative-targets,
 * create-negative-keyword) put the same answer in their previews as `pageReach` (negativeReach): their own `reach` is
 * where a write lands (live or sandbox).
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { isAsinText, negativeBlocksTerm } from './pure.js'
import { blockersNow, criteriaOf, marketCode, marketWasteFacts, placeRefs, windowOf, type WasteFacts } from './read.js'

/** The most terms that sold one reach names. */
export const MAX_SOLD = 10

export type ReachMatch = 'EXACT' | 'PHRASE' | 'ASIN'

/** One negative as the reach check reads it: its words, its match and its place (an ad group, or a whole campaign). */
export interface ReachNegative {
  campaignId: string
  /** Its ad group (AD_GROUP); null for a campaign negative. */
  adGroupId: string | null
  level: 'AD_GROUP' | 'CAMPAIGN'
  text: string
  match: ReachMatch
}

/** One search term in one ad group over the window, as the rows count it. `blocked`: a standing negative blocks it there. */
export interface ReachTerm {
  adGroupId: string
  key: string
  text: string
  impressions: number
  clicks: number
  spendCents: number
  orders: number
  salesCents: number
  blocked: boolean
}

/** What one negative would block (the step's `reach`). */
export interface Reach {
  windowDays: number
  currency: string
  terms: number
  spendCents: number
  clicks: number
  orders: number
  salesCents: number
  /** Terms with an order in the window that it would block, the most orders first (at most MAX_SOLD). */
  sold: Array<{ text: string; orders: number }>
}

/** Several negatives together: every term counted once (two negatives over one term in one place block it once). */
export interface ReachTotal {
  /** The window, when every step reads the same one; null across markets whose windows differ. */
  windowDays: number | null
  /** One currency: the money below; null across several (then `currencies`, never one sum). */
  currency: string | null
  terms: number
  spendCents: number | null
  clicks: number
  orders: number
  salesCents: number | null
  currencies: Array<{ currency: string; spendCents: number; salesCents: number }>
}

/** One negative's reach and the terms behind it (the total adds the terms, not the numbers). */
export interface ReachOf { reach: Reach; blocked: ReachTerm[] }

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Does this negative block this search term? A product negative blocks only its ASIN; a keyword negative by its words. */
export function reachBlocks(n: Pick<ReachNegative, 'text' | 'match'>, key: string): boolean {
  if (n.match === 'ASIN' && !isAsinText(key)) return false
  return negativeBlocksTerm(key, { text: n.text, match: n.match })
}

/** The terms of its place this negative would block: served in the window, not blocked there already. */
export function blockedBy(terms: readonly ReachTerm[], n: Pick<ReachNegative, 'text' | 'match'>): ReachTerm[] {
  return terms.filter((t) => !t.blocked && (t.impressions > 0 || t.clicks > 0 || t.orders > 0) && reachBlocks(n, t.key))
}

/** The numbers of the terms a negative would block. */
export function reachOf(blocked: readonly ReachTerm[], windowDays: number, currency: string): Reach {
  let spendCents = 0, clicks = 0, orders = 0, salesCents = 0
  for (const t of blocked) { spendCents += t.spendCents; clicks += t.clicks; orders += t.orders; salesCents += t.salesCents }
  const sold = blocked.filter((t) => t.orders > 0)
    .sort((a, b) => b.orders - a.orders || b.salesCents - a.salesCents || a.text.localeCompare(b.text))
    .slice(0, MAX_SOLD)
    .map((t) => ({ text: t.text, orders: t.orders }))
  return { windowDays, currency, terms: blocked.length, spendCents, clicks, orders, salesCents, sold }
}

/** Several negatives' reach together: each term in each place once, money per currency (never added across them). */
export function reachTotal(list: ReadonlyArray<ReachOf | null>): ReachTotal | null {
  const each = list.filter((x): x is ReachOf => !!x)
  if (!each.length) return null
  const seen = new Map<string, { term: ReachTerm; currency: string }>()
  for (const x of each) for (const t of x.blocked) seen.set(`${t.adGroupId}|${t.key}`, { term: t, currency: x.reach.currency })
  const money = new Map<string, { spendCents: number; salesCents: number }>()
  let clicks = 0, orders = 0
  for (const { term, currency } of seen.values()) {
    clicks += term.clicks
    orders += term.orders
    const m = money.get(currency) ?? { spendCents: 0, salesCents: 0 }
    m.spendCents += term.spendCents
    m.salesCents += term.salesCents
    money.set(currency, m)
  }
  // A currency with no term yet is still the steps' currency (nothing blocked reads 0 in it).
  for (const x of each) if (!money.has(x.reach.currency)) money.set(x.reach.currency, { spendCents: 0, salesCents: 0 })
  const currencies = [...money].sort(([a], [b]) => a.localeCompare(b)).map(([currency, m]) => ({ currency, ...m }))
  const one = currencies.length === 1 ? currencies[0] : null
  const windows = new Set(each.map((x) => x.reach.windowDays))
  return {
    windowDays: windows.size === 1 ? [...windows][0] : null,
    currency: one?.currency ?? null,
    terms: seen.size, spendCents: one ? one.spendCents : null, clicks, orders, salesCents: one ? one.salesCents : null,
    currencies,
  }
}

/** The negative a preview step adds (NEGATE_EXACT / PHRASE / ASIN with its words and place), or null for any other step. */
export function stepNegative(s: { action: string; text: string | null; level?: 'AD_GROUP' | 'CAMPAIGN' | null; place: { campaign: { id: string } | null; adGroup: { id: string } | null } }): ReachNegative | null {
  if (!s.action.startsWith('NEGATE_') || !s.text?.trim() || !s.place.campaign) return null
  const match: ReachMatch = s.action === 'NEGATE_ASIN' ? 'ASIN' : s.action === 'NEGATE_PHRASE' ? 'PHRASE' : 'EXACT'
  const level = s.level === 'CAMPAIGN' || !s.place.adGroup ? 'CAMPAIGN' : 'AD_GROUP'
  if (match === 'ASIN' && level === 'CAMPAIGN') return null
  return { campaignId: s.place.campaign.id, adGroupId: level === 'AD_GROUP' ? s.place.adGroup!.id : null, level, text: s.text.trim(), match }
}

// ── Facts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A place's search terms over the window, from the market's facts: the sums the page's rows show. */
export function placeTerms(f: WasteFacts, n: ReachNegative, windowDays: number): ReachTerm[] {
  const list = n.level === 'CAMPAIGN' ? f.placesByCampaign.get(n.campaignId) : f.placesByGroup.get(n.adGroupId ?? '')
  const w = windowOf(windowDays)
  return (list ?? []).map((p) => {
    const s = p.win[w]
    return {
      adGroupId: p.adGroupId, key: p.key, text: isAsinText(p.key) ? p.key.toUpperCase() : p.text,
      impressions: s.impressions, clicks: s.clicks, spendCents: s.spendCents, orders: s.orders, salesCents: s.salesCents,
      // HONEST 6 — blocked there now (a negative switched off, or one Amazon never took, blocks nothing).
      blocked: blockersNow(f, p.adGroupId, p.key).length > 0,
    }
  })
}

/** One negative's reach in its market's facts; null when the place is not one the page reads (archived, not Sponsored Products). */
export function reachIn(f: WasteFacts, n: ReachNegative): ReachOf | null {
  const c = f.campaigns.get(n.campaignId)
  if (!c) return null
  const g = n.adGroupId ? f.adGroups.get(n.adGroupId) : [...f.adGroups.values()].find((x) => x.campaignId === c.id)
  if (!g || g.campaignId !== c.id) return null
  const windowDays = criteriaOf(f, c.market).windowDays
  const blocked = blockedBy(placeTerms(f, n, windowDays), n)
  return { reach: reachOf(blocked, windowDays, placeRefs(f, g.id).currency), blocked }
}

/** Each negative's reach (null where it cannot be read), each market's facts read once. */
export async function negativeReach(list: readonly ReachNegative[]): Promise<Array<ReachOf | null>> {
  if (!list.length) return []
  const ids = [...new Set(list.map((n) => n.campaignId))]
  const rows = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, marketplace: true } })
  const marketOf = new Map(rows.map((c) => [c.id, marketCode(c.marketplace)]))
  const markets = [...new Set([...marketOf.values()].filter((m): m is string => !!m))]
  const facts = new Map(await Promise.all(markets.map(async (m) => [m, await marketWasteFacts(m)] as const)))
  return list.map((n) => {
    const m = marketOf.get(n.campaignId)
    const f = m ? facts.get(m) : undefined
    return f ? reachIn(f, n) : null
  })
}

/**
 * Every NEGATE_* step with its `reach` (null where its place cannot be read), and the total of the steps that are sent
 * (not refused). Never in the way: a read that fails leaves the steps as they are (reach null), said in the log.
 */
export async function withReach<S extends Parameters<typeof stepNegative>[0] & { refusal: unknown }>(steps: readonly S[]): Promise<{ steps: Array<S & { reach?: Reach | null }>; total: ReachTotal | null }> {
  const negatives = steps.map(stepNegative)
  const asked = negatives.filter((n): n is ReachNegative => !!n)
  if (!asked.length) return { steps: [...steps], total: null }
  let read: Array<ReachOf | null>
  try {
    read = await negativeReach(asked)
  } catch (error) {
    logger.warn('[waste] the reach check could not be read; the review shows the steps without it', { error: error instanceof Error ? error.message : String(error) })
    read = asked.map(() => null)
  }
  let at = 0
  const each = negatives.map((n) => (n ? read[at++] : null))
  return {
    steps: steps.map((s, i) => (s.action.startsWith('NEGATE_') ? { ...s, reach: each[i]?.reach ?? null } : s)),
    total: reachTotal(steps.map((s, i) => (s.refusal ? null : each[i]))),
  }
}
