/**
 * Negative Targeting page, Words view (step 4, 2026-10-25) — the pure part: which words a search term holds,
 * the word's id, its state, the order, the filters and the totals. No database and no clock: words.ts reads the facts.
 *
 *   word      a piece of ONE or TWO words that sit next to each other in a shopper's search term (contiguous, in order:
 *             Amazon's negative-phrase match). The pieces are the brain's own (brain/negatives.ts piecesOf, pieceAllowed:
 *             no stopword at an edge, no number, size or ASIN, a text Amazon takes as a negative phrase). 🔴 Never
 *             ads-ngram.service.ts `terms`: it strips stop words BEFORE pairing, so it pairs words that are not next to
 *             each other and over-counts a 2-word piece (its own 🔴 note).
 *   terms     the distinct search terms (normalised) that hold the word, in places that run inside the scope; a word is
 *             listed from WORD_MIN_TERMS terms (one term is the term's own negative: the brain's NGRAM_MIN_TERMS)
 *   id        `word:<market>|<word>` (the word normalised: lower case, single spaces)
 *   state     BLOCKED (a negative phrase stands over it in every place) · PROTECTED (a protected term holds every other
 *             place) · NOT_WASTING (no product's test is met) · PARTLY_BLOCKED (blocked somewhere; the verb lands in the
 *             open places, or says why none is) · HELD (it wastes, but every place is held, each with why) · WASTING
 *   covered   a 2-word piece whose own word wastes too: blocking the word blocks it, so the Wasting list leaves it out
 */
import { holdsRun, NGRAM_MIN_TERMS, pieceAllowed, piecesOf } from '../brain/negatives.js'
import { termKeyOf, type Ref, type RowNumbers, type RowTest } from './pure.js'

/** A word is one or two words (the Owner's Words view, 2026-10-25). */
export const WORD_MAX_WORDS = 2
/** A word is listed from this many search terms holding it: one term is its own negative's job (brain NGRAM_MIN_TERMS). */
export const WORD_MIN_TERMS = NGRAM_MIN_TERMS

/** Every word (1 or 2 words, next to each other) a search term holds that a negative phrase may be: each once. */
export function wordsOfTerm(text: string): string[] {
  const key = termKeyOf(text)
  if (!key) return []
  return piecesOf(key, WORD_MAX_WORDS).filter(pieceAllowed)
}

/** Does this search term hold the word (its words next to each other, in order)? Amazon's negative-phrase match. */
export const termHoldsWord = (term: string, word: string): boolean => holdsRun(term, word)

export const wordRowId = (market: string, word: string) => `word:${market}|${termKeyOf(word)}`

/** `word:<market>|<word>` back to its parts; null when it is not one. */
export function parseWordId(id: string): { market: string; word: string } | null {
  const s = String(id ?? '').trim()
  if (!s.startsWith('word:')) return null
  const rest = s.slice(5)
  const bar = rest.indexOf('|')
  if (bar <= 0) return null
  let word = rest.slice(bar + 1)
  try { word = decodeURIComponent(word) } catch { /* the plain text */ }
  const key = termKeyOf(word)
  const market = rest.slice(0, bar).trim().toUpperCase()
  if (!market || !key) return null
  return { market, word: key }
}

export type WordState = 'WASTING' | 'PARTLY_BLOCKED' | 'BLOCKED' | 'PROTECTED' | 'HELD' | 'NOT_WASTING'
export const WORD_STATES: readonly WordState[] = ['WASTING', 'PARTLY_BLOCKED', 'HELD', 'PROTECTED', 'BLOCKED', 'NOT_WASTING']

/** One place's state: OPEN (the verb lands there) · BLOCKED · HELD (with why) · NOT_WASTING (its product's test is not met). */
export type WordPlaceState = 'OPEN' | 'BLOCKED' | 'HELD' | 'NOT_WASTING'
export interface Held { label: string; reason: string }

/** The word's state from its places (each place's state and held label) and whether any product's test is met. */
export function wordStateOf(places: ReadonlyArray<{ state: WordPlaceState; held: Held | null }>, met: boolean): WordState {
  if (!places.length) return met ? 'HELD' : 'NOT_WASTING'
  const blocked = places.filter((p) => p.state === 'BLOCKED').length
  if (blocked === places.length) return 'BLOCKED'
  const unblocked = places.filter((p) => p.state !== 'BLOCKED')
  if (unblocked.every((p) => p.state === 'HELD' && p.held?.label === 'Protected')) return 'PROTECTED'
  if (!met) return 'NOT_WASTING'
  if (blocked) return 'PARTLY_BLOCKED'
  return places.some((p) => p.state === 'OPEN') ? 'WASTING' : 'HELD'
}

/** The row's verb when no place is open: why not, in the page's words (the first that applies). */
export function wordHeld(places: ReadonlyArray<{ state: WordPlaceState; held: Held | null }>, test: Pick<RowTest, 'met' | 'sentence'>): Held | null {
  if (places.some((p) => p.state === 'OPEN')) return null
  if (places.length && places.every((p) => p.state === 'BLOCKED')) return { label: 'Blocked', reason: 'A negative phrase already blocks it in every place where its terms spent.' }
  const held = places.find((p) => p.state === 'HELD' && p.held)?.held
  if (test.met && held) return held
  if (!test.met) return { label: 'Not wasting', reason: test.sentence }
  return held ?? { label: 'Nowhere to block', reason: 'Its terms spent in no place that runs here.' }
}

/** A word's numbers: the sums of its terms' numbers (each in its own window); null-safe. */
export function sumNumbers(list: ReadonlyArray<Pick<RowNumbers, 'impressions' | 'clicks' | 'orders' | 'spendCents' | 'salesCents'> | null | undefined>): Omit<RowNumbers, 'xCpa'> {
  let impressions = 0, clicks = 0, orders = 0, spendCents = 0, salesCents = 0
  for (const n of list) {
    if (!n) continue
    impressions += n.impressions; clicks += n.clicks; orders += n.orders; spendCents += n.spendCents; salesCents += n.salesCents
  }
  return {
    impressions, clicks, orders, spendCents, salesCents,
    acosPct: salesCents > 0 ? Math.round((spendCents / salesCents) * 1000) / 10 : null,
    cpcCents: clicks > 0 ? Math.round(spendCents / clicks) : null,
  }
}

// ── The list: filters, order, totals ────────────────────────────────────────────────────────────────────────────

export type WordShow = 'wasting' | 'blocked' | 'all'
export const WORD_SHOWS: readonly WordShow[] = ['wasting', 'blocked', 'all']

/** The row as the list filters, orders and counts it. */
export interface WordListRow {
  id: string
  word: string
  terms: number
  state: WordState
  coveredBy: string | null
  d: Pick<RowNumbers, 'clicks' | 'orders' | 'spendCents'>
  places: { adGroups: number; campaigns: number; blocked: number }
  products: number
  test: Pick<RowTest, 'met'>
}

/** Wasting: a word a product's test calls waste that still runs somewhere (a held or protected one shows its held verb), never one
 *  its own word covers. Blocked: a negative phrase stands over it somewhere (wasting or not). All: every word listed. */
export function wordShowMatches(r: WordListRow, show: WordShow): boolean {
  if (show === 'wasting') return r.test.met && r.state !== 'BLOCKED' && r.state !== 'NOT_WASTING' && !r.coveredBy
  if (show === 'blocked') return r.places.blocked > 0
  return true
}

export interface WordTotals { wasting: number; blocked: number; held: number; protected: number; all: number }

/** The list's counts, from the same rows the list pages (each count is what its own `show` answers). */
export function wordTotalsOf(rows: readonly WordListRow[]): WordTotals {
  return {
    wasting: rows.filter((r) => wordShowMatches(r, 'wasting')).length,
    blocked: rows.filter((r) => wordShowMatches(r, 'blocked')).length,
    held: rows.filter((r) => wordShowMatches(r, 'wasting') && r.state === 'HELD').length,
    protected: rows.filter((r) => wordShowMatches(r, 'wasting') && r.state === 'PROTECTED').length,
    all: rows.length,
  }
}

export const WORD_SORT_KEYS = ['spend', 'clicks', 'orders', 'terms', 'places', 'products', 'word', 'state'] as const
export type WordSortKey = (typeof WORD_SORT_KEYS)[number]
export const WORD_SORT_RE = /^-?(spend|clicks|orders|terms|places|products|word|state)$/

/** The words' order: a key, '-' in front for descending; ties by the word. A money key for a person who may not see ad
 *  spend is turned into terms by the route (the order would give the ranking away). */
export function compareWords(sort: string | null | undefined): (a: WordListRow, b: WordListRow) => number {
  const raw = String(sort ?? '-spend').trim() || '-spend'
  const desc = raw.startsWith('-')
  const key = (desc ? raw.slice(1) : raw) as WordSortKey
  const num = (f: (r: WordListRow) => number) => (a: WordListRow, b: WordListRow) => f(a) - f(b)
  const by: Record<WordSortKey, (a: WordListRow, b: WordListRow) => number> = {
    spend: num((r) => r.d.spendCents ?? -1),
    clicks: num((r) => r.d.clicks),
    orders: num((r) => r.d.orders),
    terms: num((r) => r.terms),
    places: num((r) => r.places.adGroups),
    products: num((r) => r.products),
    word: (a, b) => a.word.localeCompare(b.word),
    state: (a, b) => WORD_STATES.indexOf(a.state) - WORD_STATES.indexOf(b.state),
  }
  const cmp = by[(WORD_SORT_KEYS as readonly string[]).includes(key) ? key : 'spend']
  return (a, b) => (desc ? -cmp(a, b) : cmp(a, b)) || a.word.localeCompare(b.word) || a.id.localeCompare(b.id)
}

/** A money sort key, for a person who may not order by it. */
export const isWordMoneySort = (sort: string | null | undefined) => String(sort ?? '').replace(/^-/, '').toLowerCase() === 'spend'

/**
 * The 2-word pieces a wasting word of their own covers (blocking "cheap" blocks "cheap jacket"): each with that word.
 * `wasting`: the 1-word pieces a product's test calls waste and that still run somewhere.
 */
export function coveredByOf(word: string, wasting: ReadonlySet<string>): string | null {
  const parts = word.split(' ')
  if (parts.length < 2) return null
  return parts.find((p) => wasting.has(p)) ?? null
}

/** The product a row names: the one product of its places, else null (several, or a shared campaign). */
export function oneProduct(products: ReadonlyArray<Ref | null>): Ref | null {
  const ids = new Set(products.map((p) => p?.id ?? '~'))
  return ids.size === 1 && !ids.has('~') ? products[0] : null
}
