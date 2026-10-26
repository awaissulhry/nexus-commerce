/**
 * Negative Targeting page, Words view (step 4, 2026-10-25) — the view's words and rules, pure and tested in Node
 * (`wordsModel.vitest.test.ts`). The components only draw what these say.
 *
 *   address   ?view=words · ?show=wasting|blocked|all · ?q= · ?sort= · ?page= · ?pageSize= · ?word=<word id>&tab=
 *             overview|terms|where|history; the page's filter bar `?portfolio=&campaign=&adGroup=&product=` (read as `lists`)
 *   verb      Block word = a negative phrase in each place its terms spent in (the ad group, or the whole campaign); a
 *             place that is blocked, held or does not waste is left out by the server, each with why
 *   bulk      a verb counts the ticked words it fits; the rest are left out, each with why (never silently)
 */
import { addApiParams, type ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import { money } from '../../bid/_shared/format'
import { moneyOr, plural, type BulkPlan, type CountPart, type Picked, type StateChipView } from '../waste/wasteModel'
import type { BannerView, MetricView, RecordTone, StatePillView } from '../waste/recordModel'
import type { WasteItem, Where } from '../waste/wasteTypes'
import type { WordPlace, WordPlaceState, WordProduct, WordRow, WordState, WordTerm, WordTotals } from './wordsTypes'

// ── the address ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const WORD_SHOWS = ['wasting', 'blocked', 'all'] as const
export type WordShow = (typeof WORD_SHOWS)[number]
export const wordShowOf = (v: string | null | undefined): WordShow => ((WORD_SHOWS as readonly string[]).includes(v ?? '') ? v as WordShow : 'wasting')

export const WORD_TABS = ['overview', 'terms', 'where', 'history'] as const
export type WordTab = (typeof WORD_TABS)[number]
export const wordTabOf = (v: string | null | undefined): WordTab => ((WORD_TABS as readonly string[]).includes(v ?? '') ? v as WordTab : 'overview')

/** The grid's columns the server orders by, and the key it takes. */
export const WORD_SORT_KEY: Readonly<Record<string, string>> = {
  word: 'word', terms: 'terms', spend: 'spend', clicks: 'clicks', orders: 'orders', places: 'places', products: 'products', state: 'state',
}
export function wordSortOf(v: string | null | undefined): { colId: string; dir: 'asc' | 'desc' } | null {
  const s = (v ?? '').trim()
  if (!s) return null
  const desc = s.startsWith('-')
  const key = desc ? s.slice(1) : s
  const colId = Object.keys(WORD_SORT_KEY).find((c) => WORD_SORT_KEY[c] === key)
  return colId ? { colId, dir: desc ? 'desc' : 'asc' } : null
}
export const wordSortParam = (s: { colId: string; dir: 'asc' | 'desc' } | null): string | null =>
  s && WORD_SORT_KEY[s.colId] ? `${s.dir === 'desc' ? '-' : ''}${WORD_SORT_KEY[s.colId]}` : null

export interface WordsQuery {
  market: string | null
  lists?: ScopeApi | null
  show: WordShow
  q: string
  sort?: string | null
  page?: number
  pageSize?: number
}

/** The query string of a words read. Empty values are left out; 'all' markets = no market. */
export function wordsSearch(q: WordsQuery): string {
  const p = new URLSearchParams()
  const m = (q.market ?? '').trim()
  if (m && m.toLowerCase() !== 'all') p.set('market', m.toUpperCase())
  addApiParams(p, q.lists)
  if (q.show !== 'wasting') p.set('show', q.show)
  if (q.q.trim()) p.set('q', q.q.trim())
  if (q.sort) p.set('sort', q.sort)
  if (q.page && q.page > 1) p.set('page', String(q.page))
  if (q.pageSize) p.set('pageSize', String(q.pageSize))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** One word's read takes the list's filter-bar lists only (its market is in its id). */
export function wordSearch(lists: ScopeApi | null | undefined): string {
  const s = addApiParams(new URLSearchParams(), lists).toString()
  return s ? `?${s}` : ''
}

/** A word id's word (`word:<market>|<word>`), for a ticked word that is not loaded. */
export function wordOfId(id: string): string {
  const bar = id.indexOf('|')
  return id.startsWith('word:') && bar > 0 ? id.slice(bar + 1) : id
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const STATE: Readonly<Record<WordState, string>> = {
  WASTING: 'Wasting',
  PARTLY_BLOCKED: 'Partly blocked',
  BLOCKED: 'Blocked',
  PROTECTED: 'Protected',
  HELD: 'Held',
  NOT_WASTING: 'Not wasting',
}
export const wordStateWord = (s: WordState) => STATE[s] ?? s

/** The state mark's full name (its tooltip and its accessible name): the server's one sentence, the same the record and
 *  Claude's ad-waste read show (which product's part wastes, what blocks or holds it, or why it does not waste). */
export const wordStateSentence = (r: Pick<WordRow, 'stateWhy'>): string => r.stateWhy

const PLACE: Readonly<Record<WordPlaceState, string>> = { OPEN: 'Runs', BLOCKED: 'Blocked', HELD: 'Held', NOT_WASTING: 'Not wasting' }
export const placeStateWord = (s: WordPlaceState) => PLACE[s] ?? s

/** One place's line of why: blocked by which negative, held with why, or not wasting for its product. */
export function placeWhy(p: Pick<WordPlace, 'state' | 'held' | 'blockedBy'>): string | null {
  if (p.state === 'BLOCKED') return p.blockedBy ? `The negative phrase "${p.blockedBy.text}" blocks it${p.blockedBy.level === 'CAMPAIGN' ? ' in the whole campaign' : ''}` : 'Blocked'
  if (p.state === 'OPEN') return null
  return p.held?.reason ?? null
}

/** "4 ad groups · 3 campaigns" / "TST-COAT" or "2 products". */
export const placesWords = (r: Pick<WordRow, 'places'>) => `${plural(r.places.adGroups, 'ad group')}${r.places.campaigns > 1 ? ` · ${plural(r.places.campaigns, 'campaign')}` : ''}`
export const productsWords = (r: Pick<WordRow, 'product' | 'products'>) => (r.product ? r.product.name : r.products > 1 ? plural(r.products, 'product') : '—')

// ── the verb ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WordVerbView {
  label: string
  short: string
  sentence: string
  /** Why it may not be sent (the server's own reason), or null. */
  held: string | null
  /** The blue fill only for a word that wastes (its test is met) and lands somewhere. */
  primary: boolean
}

const CAMPAIGN_HELD: ReadonlySet<WordState> = new Set(['BLOCKED', 'PROTECTED', 'HELD', 'NOT_WASTING'])

/** Block word: a negative phrase in each open place (held with the server's reason when none is open). */
export function wordVerb(r: Pick<WordRow, 'verb' | 'test' | 'state'>, where: Where = 'adGroup'): WordVerbView {
  // The whole campaign is the server's to judge per campaign: a word partly blocked in its ad groups may still land in a
  // campaign; one blocked everywhere, protected, held everywhere or not wasting does not.
  const held = where === 'adGroup' || CAMPAIGN_HELD.has(r.state) ? r.verb.held?.reason ?? null : null
  const n = r.verb.places
  return {
    label: where === 'campaign' ? 'Block word · whole campaign' : 'Block word',
    short: 'Block word',
    sentence: where === 'campaign'
      ? 'Block the word: a negative phrase in each whole campaign where its terms spent'
      : `Block the word: a negative phrase in ${n ? plural(n, 'ad group') : 'each ad group'} where its terms spent`,
    held,
    primary: r.test.met && !held,
  }
}

/** What Block word sends for the ticked words, and every word it leaves out with why. `lists`: the filter bar's (the
 *  places the person saw). Pure. */
export function wordsBulkPlan(picked: ReadonlyArray<Picked<WordRow>>, where: Where, lists: ScopeApi | null | undefined): BulkPlan {
  const items: WasteItem[] = []
  const left: BulkPlan['left'] = []
  const scope = lists && Object.values(lists).some(Boolean) ? { scope: lists } : {}
  for (const p of picked) {
    if ('word' in p) {
      const why = wordVerb(p, where).held
      if (why) { left.push({ id: p.id, text: p.word, why }); continue }
    }
    items.push({ rowId: p.id, action: 'NEGATE_PHRASE', where, ...scope })
  }
  return { items, left }
}

export const wordsBulkCounts = (picked: ReadonlyArray<Picked<WordRow>>): Record<Where, number> => ({
  adGroup: wordsBulkPlan(picked, 'adGroup', null).items.length,
  campaign: wordsBulkPlan(picked, 'campaign', null).items.length,
})

// ── the list ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Show filter's choices and counts (the same read). */
export function wordShowChips(t: WordTotals | null): Array<{ id: WordShow; label: string; count: number | null; title: string }> {
  return [
    { id: 'wasting', label: 'Wasting', count: t?.wasting ?? null, title: 'Words that waste across search terms' },
    { id: 'blocked', label: 'Blocked', count: t?.blocked ?? null, title: 'A negative phrase blocks it somewhere' },
    { id: 'all', label: 'All', count: t?.all ?? null, title: 'Every word held by 2 search terms or more' },
  ]
}

/** D4 — the Show field of the page's filter bar: each choice with this read's count (none while it is not read). */
export function wordShowOptions(t: WordTotals | null): Array<{ value: WordShow; label: string; count?: number }> {
  return wordShowChips(t).map((c) => ({ value: c.id, label: c.label, ...(c.count != null ? { count: c.count } : {}) }))
}

/** D5 — the toolbar's count: "5 words". */
export const wordsCount = (total: number): CountPart[] => [{ n: String(total), words: total === 1 ? ' word' : ' words' }]

const CHIP: Readonly<Record<WordState, Omit<StateChipView, 'title'>>> = {
  WASTING: { word: 'Wasting', tone: 'danger', mark: 'play' },
  PARTLY_BLOCKED: { word: 'Partly blocked', tone: 'warning', mark: 'ban' },
  BLOCKED: { word: 'Blocked', tone: 'info', mark: 'ban' },
  PROTECTED: { word: 'Protected', tone: 'success', mark: 'shield' },
  HELD: { word: 'Held', tone: 'neutral', mark: 'clock' },
  NOT_WASTING: { word: 'Not wasting', tone: 'neutral', mark: 'play' },
}
/** D6 — a word's state as ONE chip in the list: its word in a tone and its mark; the server's sentence on hover. */
export function wordStateChip(r: Pick<WordRow, 'state' | 'stateWhy'>): StateChipView {
  return { ...(CHIP[r.state] ?? { word: wordStateWord(r.state), tone: 'neutral' as const, mark: 'play' as const }), title: wordStateSentence(r) }
}

/** The line under the chip: a 2-word piece one of whose words wastes too (blocking that word blocks it). */
export function wordStateSub(r: Pick<WordRow, 'coveredBy'>): { word: string; title: string } | null {
  return r.coveredBy ? { word: `Covered by "${r.coveredBy}"`, title: `Covered by "${r.coveredBy}": blocking that word blocks this one` } : null
}

/** The empty table's words: nothing at all vs. nothing under the filters. */
export function wordsEmpty(show: WordShow, filtered: boolean): { title: string; clear: boolean } {
  if (filtered) return { title: 'Nothing matches these filters', clear: true }
  if (show === 'blocked') return { title: 'No word is blocked', clear: true }
  if (show === 'all') return { title: 'No word in 2 search terms or more', clear: false }
  return { title: 'No word wastes across search terms', clear: false }
}

/** One search term of a word (the Terms tab): its places (each the page's term row there), its numbers summed, sold
 *  anywhere, its product (one, else how many). The tab lists as many as the row's "terms" counts. */
export interface TermGroup { key: string; text: string; places: WordTerm[]; d: { spendCents?: number; clicks: number; orders: number }; sold: boolean; product: WordTerm['product']; products: number }
export function groupTerms(terms: readonly WordTerm[]): TermGroup[] {
  const by = new Map<string, WordTerm[]>()
  for (const t of terms) {
    const key = t.text.toLowerCase().replace(/\s+/g, ' ').trim()
    by.set(key, [...(by.get(key) ?? []), t])
  }
  const out: TermGroup[] = []
  for (const [key, places] of by) {
    const spend = places.map((p) => p.d?.spendCents)
    const ids = new Set(places.map((p) => p.product?.id ?? '~'))
    out.push({
      key, text: places[0].text, places,
      d: {
        ...(spend.every((x) => typeof x === 'number') ? { spendCents: (spend as number[]).reduce((a, b) => a + b, 0) } : {}),
        clicks: places.reduce((a, p) => a + (p.d?.clicks ?? 0), 0), orders: places.reduce((a, p) => a + (p.d?.orders ?? 0), 0),
      },
      sold: places.some((p) => p.sold),
      product: ids.size === 1 ? places[0].product : null,
      products: ids.size,
    })
  }
  return out.sort((a, b) => (b.d.spendCents ?? 0) - (a.d.spendCents ?? 0) || b.d.clicks - a.d.clicks || a.text.localeCompare(b.text))
}

export const WORD_CSV_HEADERS = ['Word', 'Terms', 'Sold', 'Spend', 'Clicks', 'Orders', 'Ad groups', 'Campaigns', 'Products', 'State', 'Block word'] as const
export function wordCsvRow(r: WordRow): string[] {
  const v = wordVerb(r)
  return [
    r.word, String(r.terms), String(r.sold), moneyOr(r.d.spendCents, r.currency), String(r.d.clicks), String(r.d.orders),
    String(r.places.adGroups), String(r.places.campaigns), productsWords(r), wordStateWord(r.state),
    `${v.label}${v.held ? ' (held)' : ''}`,
  ]
}

// ── the record (2026-10-26, RECORD-SPEC R1–R15) ─────────────────────────────────────────────────────────────────────

const hasMoney = (c: number | null | undefined): c is number => typeof c === 'number' && Number.isFinite(c)
const xNum = (x: number) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1))

/** The record's subtitle: "Word in 13 search terms · 7 ad groups · 5 campaigns". */
export const wordSubtitle = (r: Pick<WordRow, 'terms' | 'places'>) =>
  `Word in ${plural(r.terms, 'search term')} · ${plural(r.places.adGroups, 'ad group')}${r.places.campaigns > 1 ? ` · ${plural(r.places.campaigns, 'campaign')}` : ''}`

const WORD_TONE: Readonly<Record<WordState, RecordTone>> = {
  WASTING: 'danger', PARTLY_BLOCKED: 'warning', BLOCKED: 'info', PROTECTED: 'info', HELD: 'neutral', NOT_WASTING: 'neutral',
}
/** The record's state pill: the state word in its tone, the server's sentence for a screen reader and on hover. */
export function wordPill(r: Pick<WordRow, 'state' | 'stateWhy'>): StatePillView {
  const glyph = r.state === 'WASTING' || r.state === 'NOT_WASTING' ? 'play' : r.state === 'PROTECTED' ? 'shield' : r.state === 'HELD' ? 'none' : 'ban'
  return { word: wordStateWord(r.state), tone: WORD_TONE[r.state] ?? 'neutral', sentence: r.stateWhy.replace(/\.$/, ''), glyph }
}

/** The banner: for which product the word wastes, with its spend; else the state's own sentence. */
export function wordBanner(r: WordRow, products: readonly WordProduct[] | null): BannerView {
  const tone: RecordTone = r.state === 'WASTING' ? 'danger' : r.state === 'PARTLY_BLOCKED' ? 'warning' : r.state === 'BLOCKED' ? 'success' : 'info'
  const v = wordVerb(r)
  const held = v.held ? ` Block word is held: ${v.held.replace(/\.$/, '')}.` : ''
  const blocked = r.places.blocked ? ` A negative phrase blocks it already in ${plural(r.places.blocked, 'ad group')}.` : ''
  const wf = r.wastesFor
  if ((r.state === 'WASTING' || r.state === 'PARTLY_BLOCKED') && wf) {
    const name = wf.product?.name ?? 'the shared campaigns'
    const mine = wf.product ? products?.find((p) => p.product?.id === wf.product!.id) ?? null : null
    const sold = wf.orders === 0 ? 'sold nothing' : `sold only ${plural(wf.orders, 'order')}`
    const title = mine && hasMoney(mine.d.spendCents)
      ? `For ${name} it spent ${money(mine.d.spendCents, r.currency)} in ${plural(wf.terms, 'search term')} and ${sold}`
      : `For ${name} it wastes in ${plural(wf.terms, 'search term')} and ${sold}`
    const others = products ? products.filter((p) => !p.test.met) : []
    const othersOrders = others.reduce((n, p) => n + p.d.orders, 0)
    const lead = r.products > 1 && wf.products === 1
      ? `That is 1 of its ${r.products} products.${products ? ` The other ${plural(r.products - 1, 'product')} ${r.products - 1 === 1 ? 'does' : 'do'} not waste (${plural(othersOrders, 'order')}), so Block word stops it only for ${name}.` : ''}`
      : r.products > 1 ? `It wastes for ${wf.products} of its ${r.products} products; ${name} spent most. Block word stops it where it wastes.`
        : r.verb.places ? `Block word adds a negative phrase "${r.word}" in ${plural(r.verb.places, 'ad group')}.` : ''
    return { tone, title, desc: `${lead}${blocked}${held}`.trim() || null }
  }
  return { tone, title: r.stateWhy.replace(/\.$/, ''), desc: `${blocked}${held}`.trim() || null }
}

/** The four tiles: Spend · Clicks · Orders · Search terms. */
export function wordMetrics(r: WordRow): MetricView[] {
  const d = r.d
  const stock = r.stockOutDays ? `, ${plural(r.stockOutDays, 'day')} out of stock left out` : ''
  return [
    { id: 'spend', label: 'Spend', value: moneyOr(d.spendCents, r.currency), hint: hasMoney(d.spendCents) ? `last ${r.test.windowDays} days${stock}` : 'You cannot see ad spend' },
    { id: 'clicks', label: 'Clicks', value: d.clicks.toLocaleString('en-IE'), hint: hasMoney(d.cpcCents) ? `${money(d.cpcCents, r.currency)} a click` : undefined },
    { id: 'orders', label: 'Orders', value: d.orders.toLocaleString('en-IE'), hint: 'up to today' },
    { id: 'terms', label: 'Search terms', value: String(r.terms), hint: r.sold ? `${r.sold} sold` : 'none sold' },
  ]
}

/** "Each product on its own": every product judged by its own limit. */
export function productChecks(r: Pick<WordRow, 'currency' | 'test'>, products: readonly WordProduct[]): {
  desc: string
  rows: Array<{ id: string; product: WordProduct['product']; products: number; spend: string; terms: number; adGroups: number; limit: string; result: { tone: RecordTone; word: string } }>
} {
  const wasting = products.filter((p) => p.test.met).length
  return {
    desc: `${wasting} of ${products.length} ${wasting === 1 ? 'wastes' : 'waste'} in the last ${r.test.windowDays} days, each judged by its own limit`,
    rows: products.map((p, i) => ({
      id: `${i}:${p.product?.id ?? 'shared'}`,
      product: p.product,
      products: p.productCount,
      spend: moneyOr(p.d.spendCents, r.currency),
      terms: p.terms,
      adGroups: p.places,
      limit: [plural(p.test.clicksNeeded, 'click'), hasMoney(p.test.spendBarCents) ? money(p.test.spendBarCents, r.currency) : null].filter(Boolean).join(' · '),
      result: p.test.met ? { tone: 'danger', word: 'Wastes' } : { tone: 'neutral', word: 'Not wasting' },
    })),
  }
}

/** The About card's Test: who set the limits, and how each product is judged. */
export function wordTestWords(t: WordRow['test']): { value: string; hint: string } {
  const value = t.by ? (t.by.id === 'strategy' ? t.by.name.charAt(0).toUpperCase() + t.by.name.slice(1) : `The rule "${t.by.name}"`) : 'This page\'s default'
  return { value, hint: `Each product by its own limit.${t.xCpaBar ? ` Spend: ${xNum(t.xCpaBar)} × its target cost per order.` : ''}` }
}

/** "What Block word does": each place it lands in (what it blocks there), and each it leaves out with why. */
export function blockPlanView(r: Pick<WordRow, 'word' | 'currency' | 'verb' | 'test' | 'state'>, places: readonly WordPlace[]): {
  desc: string
  rows: Array<{ id: string; place: WordPlace; lands: boolean; block: string; why: string }>
} {
  const open = places.filter((p) => p.state === 'OPEN')
  const left = places.filter((p) => p.state !== 'OPEN')
  const spend = open.map((p) => p.d.spendCents)
  const together = [
    `Together it blocks ${plural(open.reduce((n, p) => n + p.terms, 0), 'search term')}`,
    spend.length && spend.every(hasMoney) ? money((spend as number[]).reduce((a, b) => a + b, 0), r.currency) : null,
    plural(open.reduce((n, p) => n + p.d.orders, 0), 'order'),
  ].filter(Boolean).join(' · ')
  const held = wordVerb(r).held
  return {
    desc: open.length
      ? `It adds a negative phrase "${r.word}" in ${plural(open.length, 'ad group')}, one change each. ${together}.`
      : held ? `It lands nowhere: ${held.replace(/\.$/, '')}.` : 'It lands nowhere.',
    rows: [
      ...open.map((p) => ({
        id: `${p.campaignId}|${p.adGroupId ?? ''}`, place: p, lands: true, block: 'Negative phrase',
        why: [`Blocks ${plural(p.terms, 'term')}`, hasMoney(p.d.spendCents) ? money(p.d.spendCents, r.currency) : null, plural(p.d.orders, 'order')].filter(Boolean).join(' · '),
      })),
      ...left.map((p) => ({ id: `${p.campaignId}|${p.adGroupId ?? ''}`, place: p, lands: false, block: 'Left out', why: placeWhy(p) ?? placeStateWord(p.state) })),
    ],
  }
}

/** The footer's primary: "Block “cheap” in 3 ad groups" (the code's "Block word" when it lands nowhere or is held). */
export function blockWordWords(r: Pick<WordRow, 'word' | 'verb' | 'test' | 'state'>): { label: string; sentence: string } {
  const v = wordVerb(r)
  return { label: !v.held && r.verb.places > 0 ? `Block \u201c${r.word}\u201d in ${plural(r.verb.places, 'ad group')}` : v.label, sentence: v.sentence }
}

/** The Search terms card's line: "1 sold · together €295.90 · 668 clicks · 7 orders". */
export const termsCardWords = (r: Pick<WordRow, 'sold' | 'd' | 'currency'>) =>
  `${r.sold} sold · together ${moneyOr(r.d.spendCents, r.currency)} · ${plural(r.d.clicks, 'click')} · ${plural(r.d.orders, 'order')}`

/** A place's state pill on the Where it runs tab: Wasting · Blocked · Held · Not wasting. */
export function wordPlacePill(s: WordPlaceState): { word: string; tone: RecordTone } {
  return s === 'OPEN' ? { word: 'Wasting', tone: 'danger' } : s === 'BLOCKED' ? { word: 'Blocked', tone: 'info' } : { word: placeStateWord(s), tone: 'neutral' }
}

/** Where it runs: the intro and each list's line. */
export function wordWhereWords(r: Pick<WordRow, 'word' | 'places' | 'test'>): { intro: string; spends: string; blocked: string; terms: string } {
  return {
    intro: `Where its search terms spend, and where a negative already blocks the word. Last ${r.test.windowDays} days. Block word lands only where it wastes.`,
    spends: `${plural(r.places.adGroups, 'ad group')}${r.places.campaigns > 1 ? ` in ${plural(r.places.campaigns, 'campaign')}` : ''} · it wastes in ${r.places.open} of them`,
    blocked: `A negative phrase "${r.word}" stops these search terms here`,
    terms: `Every shopper's search term with "${r.word}", highest spend first. Last ${r.test.windowDays} days. A term opens its own record.`,
  }
}
