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
import { moneyOr, plural, type BulkPlan, type Picked } from '../waste/wasteModel'
import type { WasteItem, Where } from '../waste/wasteTypes'
import type { WordPlace, WordPlaceState, WordRow, WordState, WordTerm, WordTotals } from './wordsTypes'

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

/** "6 terms" / "4 ad groups · 3 campaigns" / "TST-COAT" or "2 products". */
export const termsWords = (n: number) => plural(n, 'term')
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
