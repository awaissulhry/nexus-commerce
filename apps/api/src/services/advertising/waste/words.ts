/**
 * Negative Targeting page, Words view (step 4, 2026-10-25) — GET /api/advertising/waste/words (and /words/ids,
 * /word/:id), the MCP tool `ad-waste` view words / word, and the places a "Block word" lands in (write.ts). Read only.
 *
 * One row per word (1 or 2 words next to each other, words-pure.ts) that shoppers' search terms hold, in one market:
 *
 *   terms     the page's own search-term rows (read.ts buildWasteRows: places that run inside the scope, the same window,
 *             the days out of stock left out, a late order can only save a term) that hold the word, each counted once;
 *             a term with no click and no order in its window is not counted. ASINs hold no word.
 *   numbers   the sums of those terms' numbers (each in its own window)
 *   test      the page's search-term bar (test.ts barFor / wasteTest — the ads strategy's negate group where it is set,
 *             else 0 orders, max(20, 3 ÷ CR̂) clicks, 1.5 × the target cost per order), applied PER PRODUCT to the word's
 *             totals in that product's places (each product its own pooled conversion rate and target, as the brain's
 *             n-grams: brain/negatives.ts), and only across 2 terms or more there. The row's test is met when one
 *             product's is; its sentence is the product that spent most (a met one first).
 *   places    every ad group where its terms spent: BLOCKED (a negative phrase over the word stands there, or in its
 *             campaign) · HELD (verb.ts's never-list on the word — a protected term, our own keyword that HOLDS the word
 *             there (ads-winner-lock.ts blockedPositive, the write service's L1), a term holding it harvested in the
 *             last 30 days, a place under 14 days, a shared campaign — then a term holding it that sold there in the
 *             window, then the same negative already waiting for approval) · NOT_WASTING (its product's test is not
 *             met) · OPEN (the verb lands there). The whole campaign (where=campaign) reads the same per campaign: the
 *             lock over every ad group of the campaign, a sale in any of them.
 *   verb      "Block word" = a negative phrase in each OPEN place (one change each, one change set, Undo) — the request
 *             add-negative-targets takes: Claude asks for the same with that tool and the places' ids.
 * The rows are built once per facts and scope (the facts are reused a short while: read.ts marketWasteFacts).
 */
import { blockedPositive, type Positive, type PositiveMatch } from '../ads-winner-lock.js'
import { historyItems, type HistoryItem } from './history.js'
import {
  DAY_MS, dayIndex, isAsinText, MAX_IDS, negativeBlocksTerm, negativeMatch, negRowId, pageOf, termKeyOf, textMatches,
  WASTE_WINDOW_DAYS, type Ref, type RowNumbers, type RowState, type RowTest, type WasteCriteria, type WasteRow,
} from './pure.js'
import {
  blockersOf, buildWasteRows, criteriaOf, protectedBy, scopedFacts, windowOf, type ResolvedScope, type TargetFact,
  type WasteFacts, type WasteFreshness, type WasteScope,
} from './read.js'
import { barFor, wasteTest, xCpaOf, type OwnerBar, type ProductFacts } from './test.js'
import { verbFor } from './verb.js'
import {
  compareWords, coveredByOf, oneProduct, parseWordId, sumNumbers, termHoldsWord, WORD_MIN_TERMS, wordHeld, wordRowId,
  wordShowMatches, wordsOfTerm, wordStateOf, wordTotalsOf, type Held, type WordPlaceState, type WordShow, type WordState,
  type WordTotals,
} from './words-pure.js'

// ── The shapes ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A search term that holds the word: the page's term row (its id opens it on the Wasting view). */
export interface WordTerm {
  rowId: string
  text: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  product: Ref | null
  productCount: number
  d: RowNumbers | null
  /** It sold in its window (orders to today). */
  sold: boolean
  state: RowState
}

/** One place the word's terms spent in (an ad group; the whole campaign for a campaign negative). */
export interface WordPlace {
  level: 'AD_GROUP' | 'CAMPAIGN'
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref | null
  product: Ref | null
  productCount: number
  /** Nexus ids: where add-negative-targets puts the negative phrase (adGroupId, or campaignId for the whole campaign). */
  campaignId: string
  adGroupId: string | null
  terms: number
  d: Omit<RowNumbers, 'xCpa'>
  state: WordPlaceState
  held: Held | null
  /** BLOCKED: the negative phrase that stands over the word there. */
  blockedBy: null | { rowId: string; text: string; level: 'AD_GROUP' | 'CAMPAIGN' }
}

/** The word's part in one product (its own bar). `product` null: a shared campaign, or none Nexus can tie. */
export interface WordProduct {
  product: Ref | null
  productCount: number
  terms: number
  places: number
  d: RowNumbers
  test: RowTest
}

export interface WordRow {
  id: string
  word: string
  words: 1 | 2
  market: string
  currency: string
  /** Distinct search terms that hold it (contiguous, in order). */
  terms: number
  /** Of those, the ones that sold in their window. */
  sold: number
  d: RowNumbers
  places: { adGroups: number; campaigns: number; open: number; blocked: number }
  /** Product families its places advertise; `product` when that is one. */
  products: number
  product: Ref | null
  state: WordState
  /**
   * The state in one sentence, true for the whole row: which product's part wastes (the test is per product, the numbers
   * are every product's), what blocks or holds it, or why it does not waste. No money in it.
   */
  stateWhy: string
  /** The product whose part wastes (the one that spent most when several do); null when none does. */
  wastesFor: null | { product: Ref | null; terms: number; adGroups: number; orders: number; products: number }
  verb: { action: 'NEGATE_PHRASE'; where: 'adGroup'; held: Held | null; places: number }
  test: RowTest
  /** A 2-word piece one of whose words wastes too: blocking that word blocks this one (left out of the Wasting list). */
  coveredBy: string | null
  stockOutDays: number
}

export interface WordDetail { row: WordRow; terms: WordTerm[]; places: WordPlace[]; products: WordProduct[]; history: HistoryItem[] }

export interface WordsQuery extends WasteScope {
  show?: WordShow
  q?: string | null
  sort?: string | null
  page?: number | null
  pageSize?: number | null
}

type Failure = { ok: false; status: 400 | 404; error: string }
export type WordsAnswer = { ok: true; rows: WordRow[]; total: number; page: number; pageSize: number; totals: WordTotals; criteria: WasteCriteria; freshness: WasteFreshness } | Failure
export type WordIdsAnswer = { ok: true; ids: string[]; total: number; truncated: boolean } | Failure
export type WordDetailAnswer = ({ ok: true } & WordDetail) | Failure

// ── Small facts per place ───────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const KEYWORD_MATCHES = new Set(['EXACT', 'PHRASE', 'BROAD'])

/** Our keyword or product target as the lock reads it (ads-winner-lock.ts positivesIn: kind and match as stored). */
function positiveOf(t: TargetFact): Positive | null {
  if (t.isNegative || t.status === 'ARCHIVED') return null
  const match: PositiveMatch | null = t.kind === 'PRODUCT' ? 'PRODUCT' : t.kind === 'KEYWORD' && KEYWORD_MATCHES.has(t.expressionType) ? t.expressionType as PositiveMatch : null
  return match ? { adTargetId: t.id, adGroupId: t.adGroupId, text: t.expressionValue, match, live: t.status === 'ENABLED' && !!t.externalTargetId } : null
}

/** The product a campaign's places are judged for (buildWasteRows' own lookup): its family root, facts and negate bar. */
function productOf(f: WasteFacts, campaignId: string): { key: string; facts: ProductFacts; negate: OwnerBar | null; shared: boolean } {
  const c = f.campaigns.get(campaignId)!
  const own = f.ownership.get(c.id)
  const root = own?.owner.kind === 'product' ? own.owner.productId : null
  const k = root ? `${c.market}|${root}` : null
  return {
    key: root ?? '',
    facts: (k && f.productFacts.get(k)) || f.marketFacts.get(c.market) || { cr: null, targetCpaCents: null, targetSource: null },
    negate: (k && f.negateBar.get(k)) || f.marketNegateBar.get(c.market) || null,
    shared: own?.owner.kind !== 'product',
  }
}

const harvestMemo = new WeakMap<WasteFacts, Map<string, { text: string; at: number }>>()
/** The newest harvest of a term holding each word (Harvest made it a keyword): word → that term and when. */
function harvestedWords(f: WasteFacts): Map<string, { text: string; at: number }> {
  let m = harvestMemo.get(f)
  if (m) return m
  m = new Map()
  for (const [term, at] of f.harvestedAt) for (const w of wordsOfTerm(term)) if ((m.get(w)?.at ?? -1) < at) m.set(w, { text: term, at })
  harvestMemo.set(f, m)
  return m
}

/** The search terms holding the word that sold in these ad groups over the window (any term Amazon reported there). */
function soldIn(f: WasteFacts, word: string, adGroupIds: readonly string[], windowDays: number): string[] {
  const out = new Set<string>()
  for (const id of adGroupIds) for (const p of f.placesByGroup.get(id) ?? []) {
    if (p.win[windowOf(windowDays)].orders > 0 && termHoldsWord(p.key, word)) out.add(p.text)
  }
  return [...out]
}

/**
 * Why a negative phrase of the word may not land in this place (an ad group, or the whole campaign), or null: verb.ts's
 * never-list, then a term holding it that sold there, then the same negative already waiting for a person.
 */
function heldAt(f: WasteFacts, word: string, at: { campaignId: string; adGroupId: string | null }, spentIn: readonly string[], windowDays: number): Held | null {
  const groupsOfCampaign = [...f.adGroups.values()].filter((g) => g.campaignId === at.campaignId).map((g) => g.id)
  // A campaign negative blocks in every ad group of its campaign: the lock and a sale read all of them.
  const lockGroups = at.adGroupId ? [at.adGroupId] : groupsOfCampaign
  const positives = lockGroups.flatMap((id) => (f.positivesByGroup.get(id) ?? []).map(positiveOf).filter((p): p is Positive => !!p))
  const own = blockedPositive({ text: word, match: 'PHRASE' }, positives)
  const harvest = harvestedWords(f).get(word) ?? null
  const today = dayIndex(f.now)
  const ages = spentIn.map((id) => f.adGroups.get(id)?.firstDay).filter((d): d is number => d != null).map((d) => today - d)
  const verb = verbFor({
    kind: 'TERM', match: 'PHRASE', text: word,
    protectedBy: protectedBy(f, at.campaignId, word, true, true),
    ownKeywordHere: !!own, ownKeywordText: own?.text ?? null,
    harvestedDaysAgo: harvest ? (f.now.getTime() - harvest.at) / DAY_MS : null, harvestedText: harvest?.text ?? null,
    placeAgeDays: ages.length ? Math.min(...ages) : null,
    sharedCampaign: productOf(f, at.campaignId).shared,
  })
  if (verb.held) return verb.held
  const sold = soldIn(f, word, lockGroups, windowDays)
  if (sold.length) {
    return { label: 'Sold here', reason: `"${sold[0]}"${sold.length > 1 ? ` and ${plural(sold.length - 1, 'more term')}` : ''} sold here: a negative phrase would block ${sold.length > 1 ? 'them' : 'it'}.` }
  }
  const wait = f.waitItems.find((w) => w.action === 'NEGATE_PHRASE' && !!w.text && termKeyOf(w.text) === word
    && (at.adGroupId ? w.adGroupId === at.adGroupId || w.campaignId === at.campaignId : w.campaignId === at.campaignId && !w.adGroupId))
  if (wait) return { label: 'Waiting', reason: `A negative phrase "${word}" here waits for approval (${wait.fact.by.name}).` }
  return null
}

/** The standing negative phrase over the word in this ad group (or its campaign), or the campaign's own for a campaign. */
function blockerAt(f: WasteFacts, word: string, at: { campaignId: string; adGroupId: string | null }): WordPlace['blockedBy'] {
  const phrase = (n: TargetFact) => negativeMatch(n.kind, n.expressionType) === 'PHRASE'
  const n = at.adGroupId
    ? blockersOf(f, at.adGroupId, word).find(phrase)
    : (f.negByCampaign.get(at.campaignId) ?? []).find((x) => phrase(x) && negativeBlocksTerm(word, { text: x.expressionValue, match: 'PHRASE' }))
  return n ? { rowId: negRowId(n.id), text: n.expressionValue, level: n.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP' } : null
}

// ── Building the words ──────────────────────────────────────────────────────────────────────────────────────────

/** One word, built: its row and everything its detail and its verb read. */
interface WordBuild {
  row: WordRow
  termRows: WasteRow[]
  places: WordPlace[]
  products: WordProduct[]
  /** Per product key: its test is met, its window. */
  met: Map<string, { met: boolean; windowDays: number; sentence: string }>
}

/** The term rows a word reads: shoppers' search terms (not ASINs, not a row listed only for an ask) with a click or an order in its window. */
const termRowsOf = (f: WasteFacts, s: ResolvedScope) => buildWasteRows(f, s)
  .filter((r) => r.kind === 'TERM' && !r.askOnly && !isAsinText(r.text) && !!r.d && (r.d.clicks > 0 || r.d.orders > 0))

const buildMemo = new WeakMap<WasteFacts, Map<string, WordBuild[]>>()

/** Every word the scope's search terms hold in 2 terms or more, built (memoised per facts and scope). */
export function buildWords(f: WasteFacts, s: ResolvedScope): WordBuild[] {
  const key = JSON.stringify([s.portfolioId, s.portfolioIds, s.campaignId, s.campaignIds, s.adGroupId, s.adGroupIds, s.roots])
  let memo = buildMemo.get(f)
  if (!memo) { memo = new Map(); buildMemo.set(f, memo) }
  const hit = memo.get(key)
  if (hit) return hit

  const byWord = new Map<string, WasteRow[]>()
  for (const r of termRowsOf(f, s)) for (const w of wordsOfTerm(r.text)) {
    const list = byWord.get(w)
    if (list) list.push(r); else byWord.set(w, [r])
  }
  const out: WordBuild[] = []
  for (const [word, rows] of byWord) {
    if (new Set(rows.map((r) => termKeyOf(r.text))).size < WORD_MIN_TERMS) continue
    out.push(buildWord(f, word, rows))
  }
  // A 2-word piece one of whose words wastes too is covered by it (blocking the word blocks the piece).
  const wasting = new Set(out.filter((b) => b.row.words === 1 && b.row.test.met && b.row.state !== 'BLOCKED' && b.row.state !== 'NOT_WASTING').map((b) => b.row.word))
  for (const b of out) b.row.coveredBy = coveredByOf(b.row.word, wasting)
  memo.set(key, out)
  return out
}

function buildWord(f: WasteFacts, word: string, rows: WasteRow[]): WordBuild {
  const market = rows[0].market
  // Per product (its own bar): the terms, the window, the totals, the test — over 2 terms or more.
  const groups = new Map<string, { rows: WasteRow[]; campaignId: string }>()
  for (const r of rows) {
    const k = productOf(f, r.campaign.id).key
    const g = groups.get(k)
    if (g) g.rows.push(r); else groups.set(k, { rows: [r], campaignId: r.campaign.id })
  }
  const met = new Map<string, { met: boolean; windowDays: number; sentence: string }>()
  const products: WordProduct[] = []
  for (const [k, g] of groups) {
    const p = productOf(f, g.campaignId)
    const bar = barFor('TERM', p.facts, p.negate?.windowDays ?? WASTE_WINDOW_DAYS, p.negate)
    const n = sumNumbers(g.rows.map((r) => r.d))
    const termCount = new Set(g.rows.map((r) => termKeyOf(r.text))).size
    const t = wasteTest('TERM', n, bar, { stockOutDays: Math.max(0, ...g.rows.map((r) => r.stockOutDays)) })
    const test: RowTest = termCount < WORD_MIN_TERMS
      ? { ...t, met: false, sentence: `Not wasting as a word: only 1 search term holds "${word}" for this product — negate that term itself.` }
      : t
    const first = g.rows[0]
    // A place's reason is a short one (the whole test is the product's, in the record): "Not wasting for X: it sold (7 orders)."
    const name = first.product?.name ?? 'shared campaigns'
    const short = termCount < WORD_MIN_TERMS ? `Not wasting for ${name}: 1 search term holds it.`
      : n.orders > bar.maxOrders ? `Not wasting for ${name}: it sold (${plural(n.orders, 'order')}).`
        : n.clicks < bar.clicksNeeded ? `Not wasting for ${name}: ${n.clicks} of ${bar.clicksNeeded} clicks.`
          : `Not wasting for ${name}: spend under the bar.`
    met.set(k, { met: test.met, windowDays: bar.windowDays, sentence: short })
    products.push({
      product: first.product, productCount: first.productCount, terms: termCount, places: new Set(g.rows.map((r) => r.adGroup.id)).size,
      d: { ...n, xCpa: xCpaOf(n.spendCents, p.facts.targetCpaCents) }, test,
    })
  }
  products.sort((a, b) => Number(b.test.met) - Number(a.test.met) || (b.d.spendCents - a.d.spendCents))

  // The ad groups its terms spent in, each judged as a place.
  const byGroup = new Map<string, WasteRow[]>()
  for (const r of rows) byGroup.set(r.adGroup.id, [...(byGroup.get(r.adGroup.id) ?? []), r])
  const places: WordPlace[] = []
  for (const [adGroupId, list] of byGroup) {
    const n = sumNumbers(list.map((r) => r.d))
    if (!(n.spendCents > 0 || n.clicks > 0)) continue
    const r = list[0]
    const g = met.get(productOf(f, r.campaign.id).key)!
    places.push(placeOf(f, word, { campaignId: r.campaign.id, adGroupId }, [adGroupId], list, g))
  }
  places.sort((a, b) => b.d.spendCents - a.d.spendCents || a.campaign.name.localeCompare(b.campaign.name))

  const anyMet = products.some((p) => p.test.met)
  const main = products[0]
  const test: RowTest = { ...main.test, met: anyMet, sentence: products.length > 1 ? `${main.product?.name ?? 'Shared campaigns'}: ${main.test.sentence} (${plural(products.length, 'product')}, each by its own bar.)` : main.test.sentence }
  const total = sumNumbers(rows.map((r) => r.d))
  const keys = new Set(rows.map((r) => termKeyOf(r.text)))
  const soldKeys = new Set(rows.filter((r) => (r.d?.orders ?? 0) > 0).map((r) => termKeyOf(r.text)))
  const roots = new Set<string>()
  let unknown = 0
  for (const c of new Set(rows.map((r) => r.campaign.id))) {
    const own = f.ownership.get(c)
    for (const id of own?.productIds ?? []) roots.add(id)
    unknown = Math.max(unknown, own?.unresolved.length ?? 0)
  }
  const state = wordStateOf(places, anyMet)
  const open = places.filter((p) => p.state === 'OPEN').length
  const held = wordHeld(places, test)
  const wastes = products.filter((p) => p.test.met)
  const lead = wastes[0] ?? null
  const wastesFor: WordRow['wastesFor'] = lead ? { product: lead.product, terms: lead.terms, adGroups: lead.places, orders: lead.d.orders, products: wastes.length } : null
  const blocked = places.filter((p) => p.state === 'BLOCKED').length
  const row: WordRow = {
    id: wordRowId(market, word), word, words: word.includes(' ') ? 2 : 1, market, currency: rows[0].currency,
    terms: keys.size, sold: soldKeys.size,
    d: { ...total, xCpa: products.length === 1 ? main.d.xCpa : null },
    places: { adGroups: places.length, campaigns: new Set(places.map((p) => p.campaignId)).size, open, blocked: places.filter((p) => p.state === 'BLOCKED').length },
    products: roots.size + unknown, product: oneProduct(rows.map((r) => r.product)),
    state,
    stateWhy: stateWhyOf({ state, wastesFor, products, places: places.length, blocked, held, orders: total.orders }),
    wastesFor,
    verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held, places: open },
    test,
    coveredBy: null,
    stockOutDays: Math.max(0, ...rows.map((r) => r.stockOutDays)),
  }
  return { row, termRows: rows, places, products, met }
}

/**
 * The row's state in one sentence, true for the whole row: the test is per product while the numbers are every
 * product's, so a wasting word names the product whose part wastes and what the others did. No money in it.
 */
function stateWhyOf(a: { state: WordState; wastesFor: WordRow['wastesFor']; products: readonly WordProduct[]; places: number; blocked: number; held: Held | null; orders: number }): string {
  const w = a.wastesFor
  if (a.state === 'BLOCKED') return 'Blocked: a negative phrase stands over it in every ad group where its terms spent.'
  if (a.state === 'PROTECTED') return a.held?.reason ?? 'Protected: never blocked.'
  if (!w) {
    // The product that spent most says why (the record lists each).
    const why = notWastingWords(a.products[0])
    return a.products.length > 1 ? `${why} None of its ${a.products.length} products wastes.` : why
  }
  const name = w.product?.name ?? 'shared campaigns'
  const others = a.products.length - w.products
  const otherOrders = a.orders - a.products.filter((p) => p.test.met).reduce((n, p) => n + p.d.orders, 0)
  const head = `Wastes for ${name}${w.products > 1 ? ` and ${plural(w.products - 1, 'more product')}` : ''}: ${plural(w.terms, 'term')} in ${plural(w.adGroups, 'ad group')}, ${plural(w.orders, 'order')}`
  const rest = others > 0 ? `; ${others === 1 ? 'its other product does' : `its ${others} other products do`} not waste (${plural(otherOrders, 'order')})` : ''
  if (a.state === 'PARTLY_BLOCKED') return `${head}${rest}; a negative phrase blocks it in ${a.blocked} of ${plural(a.places, 'ad group')}.`
  if (a.state === 'HELD') return `${head}${rest}; no ad group may take the block: ${a.held?.reason ?? 'each is held'}`
  return `${head}${rest}.`
}

/** A product's part that does not waste, in short (its whole test is in the record). */
function notWastingWords(p: WordProduct): string {
  const name = p.product?.name ?? 'shared campaigns'
  if (p.terms < WORD_MIN_TERMS) return `Not wasting for ${name}: 1 search term holds it.`
  if (p.d.orders > 0) return `Not wasting for ${name}: it sold (${plural(p.d.orders, 'order')}).`
  if (p.d.clicks < p.test.clicksNeeded) return `Not wasting for ${name}: ${p.d.clicks} of ${p.test.clicksNeeded} clicks.`
  return `Not wasting for ${name}: spend under the bar.`
}

/** One place of the word: its numbers, and whether a negative phrase lands there (or why not). */
function placeOf(f: WasteFacts, word: string, at: { campaignId: string; adGroupId: string | null }, spentIn: readonly string[], rows: readonly WasteRow[], g: { met: boolean; windowDays: number; sentence: string }): WordPlace {
  const r = rows[0]
  const blockedBy = blockerAt(f, word, at)
  const held = blockedBy ? null : heldAt(f, word, at, spentIn, g.windowDays)
  const state: WordPlaceState = blockedBy ? 'BLOCKED' : held ? 'HELD' : g.met ? 'OPEN' : 'NOT_WASTING'
  return {
    level: at.adGroupId ? 'AD_GROUP' : 'CAMPAIGN',
    portfolio: r.portfolio, campaign: r.campaign, adGroup: at.adGroupId ? r.adGroup : null, product: r.product, productCount: r.productCount,
    campaignId: at.campaignId, adGroupId: at.adGroupId,
    terms: new Set(rows.map((x) => termKeyOf(x.text))).size,
    d: sumNumbers(rows.map((x) => x.d)),
    state,
    held: state === 'NOT_WASTING' ? { label: 'Not wasting', reason: g.sentence } : held,
    blockedBy,
  }
}

/** The word's places as whole campaigns (a campaign negative): one per campaign its terms spent in. */
function campaignPlaces(f: WasteFacts, b: WordBuild): WordPlace[] {
  const byCampaign = new Map<string, WordPlace[]>()
  for (const p of b.places) byCampaign.set(p.campaignId, [...(byCampaign.get(p.campaignId) ?? []), p])
  const out: WordPlace[] = []
  for (const [campaignId, list] of byCampaign) {
    const ids = new Set(list.map((p) => p.adGroupId!))
    const rows = b.termRows.filter((r) => ids.has(r.adGroup.id))
    const g = b.met.get(productOf(f, campaignId).key)!
    out.push(placeOf(f, b.row.word, { campaignId, adGroupId: null }, [...ids], rows, g))
  }
  return out.sort((a, c) => c.d.spendCents - a.d.spendCents || a.campaign.name.localeCompare(c.campaign.name))
}

const termOf = (r: WasteRow): WordTerm => ({
  rowId: r.id, text: r.text, portfolio: r.portfolio, campaign: r.campaign, adGroup: r.adGroup, product: r.product, productCount: r.productCount,
  d: r.d, sold: (r.d?.orders ?? 0) > 0, state: r.state,
})

// ── The answers ─────────────────────────────────────────────────────────────────────────────────────────────────

const WORD_RULE = 'A word is 1 or 2 words next to each other in shoppers\' search terms (Amazon\'s phrase match), in 2 terms or more; its numbers are its terms\' sums, judged per product by the search-term bar.'

function freshnessOf(facts: readonly WasteFacts[]): WasteFreshness {
  const newest = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null
  return {
    searchTermsThrough: newest(facts.map((f) => f.freshness.searchTermsThrough)),
    keywordsThrough: newest(facts.map((f) => f.freshness.keywordsThrough)),
    readAt: facts.map((f) => f.freshness.readAt).sort()[0] ?? new Date().toISOString(),
  }
}

/** Every word of the scope (each market's), before the show, text and order. */
async function scopedWords(q: WasteScope, now: Date): Promise<{ ok: true; facts: WasteFacts[]; builds: WordBuild[]; market: string | null; scope: ResolvedScope } | Failure> {
  const out = await scopedFacts(q, now)
  if ('error' in out) return out
  const scope: ResolvedScope = { ...q, roots: out.roots }
  return { ok: true, facts: out.facts, builds: out.facts.flatMap((f) => buildWords(f, scope)), market: out.market, scope }
}

/** Free text over the word and its terms (their campaign, ad group, portfolio and product): the word's numbers stay whole. */
const wordTextMatches = (b: WordBuild, q: string | null | undefined) => {
  const s = String(q ?? '').trim().toLowerCase()
  return !s || b.row.word.includes(s) || b.termRows.some((r) => textMatches(r, s))
}

/** GET /advertising/waste/words. */
export async function readWords(q: WordsQuery, now: Date = new Date()): Promise<WordsAnswer> {
  const out = await scopedWords(q, now)
  if ('error' in out) return out
  const show = q.show ?? 'wasting'
  const rows = out.builds.filter((b) => wordTextMatches(b, q.q)).map((b) => b.row)
  const matching = rows.filter((r) => wordShowMatches(r, show)).sort(compareWords(q.sort))
  const page = pageOf(matching, q.page, q.pageSize)
  const base = criteriaOf(out.facts[0] ?? ({ now, markets: [], marketNegateBar: new Map() } as unknown as WasteFacts), out.market ?? out.facts[0]?.markets[0] ?? null)
  return {
    ok: true, rows: page.rows, total: matching.length, page: page.page, pageSize: page.pageSize, totals: wordTotalsOf(rows),
    criteria: { ...base, sentence: `${WORD_RULE} ${base.sentence}` }, freshness: freshnessOf(out.facts),
  }
}

/** GET /advertising/waste/words/ids — every id the same filters match (select all N). */
export async function readWordIds(q: WordsQuery, now: Date = new Date()): Promise<WordIdsAnswer> {
  const out = await scopedWords(q, now)
  if ('error' in out) return out
  const matching = out.builds.filter((b) => wordTextMatches(b, q.q)).map((b) => b.row).filter((r) => wordShowMatches(r, q.show ?? 'wasting')).sort(compareWords(q.sort))
  return { ok: true, ids: matching.slice(0, MAX_IDS).map((r) => r.id), total: matching.length, truncated: matching.length > MAX_IDS }
}

/** One word of the scope, built, or why not (the id names its market). */
async function findWord(id: string, scope: WasteScope, now: Date): Promise<{ ok: true; f: WasteFacts; b: WordBuild; scope: ResolvedScope } | Failure> {
  const parsed = parseWordId(id)
  if (!parsed) return { ok: false, status: 400, error: `${id} is not a word id (word:<market>|<word>).` }
  const out = await scopedFacts({ ...scope, market: parsed.market }, now)
  if ('error' in out) return out
  const f = out.facts[0]
  const resolved: ResolvedScope = { ...scope, market: parsed.market, roots: out.roots }
  const b = f ? buildWords(f, resolved).find((x) => x.row.word === parsed.word) : undefined
  if (!f || !b) return { ok: false, status: 404, error: `No word "${parsed.word}" in 2 search terms or more in Amazon ${parsed.market} under these filters.` }
  return { ok: true, f, b, scope: resolved }
}

/** GET /advertising/waste/word/:id — the word with every term that holds it, its places, its products and its history. */
export async function readWordDetail(id: string, scope: WasteScope = {}, now: Date = new Date()): Promise<WordDetailAnswer> {
  const found = await findWord(id, scope, now)
  if ('error' in found) return found
  const { f, b } = found
  // The negatives made of the word in the scope (its phrase, and an exact of the same words), 90 days.
  const history = await historyItems(f, found.scope, 90, 'term', { termKey: b.row.word })
  const terms = b.termRows.map(termOf).sort((x, y) => (y.d?.spendCents ?? 0) - (x.d?.spendCents ?? 0) || x.text.localeCompare(y.text))
  return { ok: true, row: b.row, terms, places: b.places, products: b.products, history: history.rows }
}

/**
 * The places a "Block word" lands in (write.ts): every place its terms spent in, each OPEN or why not — ad groups, or
 * whole campaigns (`where` campaign). The same build as the row the person saw (same scope, same facts).
 */
export async function wordPlaces(id: string, where: 'adGroup' | 'campaign', scope: WasteScope = {}, now: Date = new Date()): Promise<{ ok: true; word: string; market: string; places: WordPlace[] } | Failure> {
  const found = await findWord(id, scope, now)
  if ('error' in found) return found
  return { ok: true, word: found.b.row.word, market: found.b.row.market, places: where === 'campaign' ? campaignPlaces(found.f, found.b) : found.b.places }
}
