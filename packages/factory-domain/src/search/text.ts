/**
 * Global search (B-W2a-32; PLT-153; design shell.search "Palette" › Records and "All results"): how a record's search
 * text is built and how a query is read. Pure: the API's indexers build an entry's text with `searchTextOf`, the search
 * route reads the query with `queryWords`, and the web marks the matched words with `matchedParts` (./highlight).
 *
 * The text is folded the same way on both sides — lower case, accents removed (`Società` → `societa`), punctuation other
 * than the joiners of numbers and codes (`-` `/` `.`) read as a space — so a person finds `ORD-2026-00042` by typing
 * `ord-2026-00042`, `00042` or `ord 42`, and `Società Pista` by typing `societa pista` or `pista`.
 *
 * What an entry may hold (SearchEntry, search.prisma): its number, its name, one line under it and the indexer's extra
 * words (a customer's code, a VAT number, a supplier's lot reference). NEVER money (no amount, price or cost: a result is
 * seen by people without the grain) and NEVER a worker's name (Statuto dei Lavoratori art. 4: a person is found only
 * through their own record). `searchTextOf` refuses words that look like an amount with its currency as a last guard;
 * the indexers simply never pass one.
 */

export const SEARCH_LIMITS = Object.freeze({
  /** Fewer folded characters than this find nothing (one letter would match half the factory). */
  minQuery: 2,
  /** The longest query read (longer is cut). */
  maxQuery: 120,
  /** The words of a query that count (the rest are ignored). */
  maxWords: 6,
  /** A word shorter than this is matched as typed (inside the text), never by similarity: trigrams need 3 letters. */
  fuzzyWordLength: 3,
  /** The palette's Records group. */
  palette: 8,
  /** A page of the results page. */
  page: 50,
  /** The most a page may ask. */
  maxPage: 100,
  /** The longest search text an entry keeps. */
  maxText: 2000,
  /** How alike a typed word and a word of the text must be (pg_trgm word_similarity, 0 to 1) to count as a typo. */
  wordSimilarity: 0.45,
})

/** Lower case, accents removed, every run of other punctuation and spaces one space; `-` `/` `.` kept inside codes. */
export function foldSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\-/.]+/gu, ' ')
    .replace(/(^|\s)[-/.]+|[-/.]+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** An amount with its currency (`€ 1.200,00`, `1200.50 EUR`): never search text. */
const MONEY_WORD = /(^|\s)(€|eur|usd|gbp|chf)\s?\d|\d\s?(€|eur|usd|gbp|chf)(\s|$)/i

export class SearchTextError extends Error {
  override name = 'SearchTextError'
}

export interface SearchDocumentText {
  readonly number?: string | null
  readonly title: string
  readonly subtitle?: string | null
  /** More words people may type: codes, references, a VAT number. Never money, never a worker's name. */
  readonly words?: readonly (string | null | undefined)[]
}

/**
 * The entry's search text: number, title, subtitle and the extra words, folded, each word once, in that order, at most
 * `maxText` characters (cut at a word). A word that looks like an amount with its currency is refused.
 */
export function searchTextOf(document: SearchDocumentText): string {
  const parts = [document.number, document.title, document.subtitle, ...(document.words ?? [])].filter((part): part is string => typeof part === 'string' && part.trim() !== '')
  for (const part of parts) if (MONEY_WORD.test(part)) throw new SearchTextError(`Search text may not hold an amount (${JSON.stringify(part)}).`)
  const seen = new Set<string>()
  const words: string[] = []
  for (const part of parts) {
    for (const word of foldSearchText(part).split(' ')) {
      if (word === '' || seen.has(word)) continue
      seen.add(word)
      words.push(word)
    }
  }
  let text = ''
  for (const word of words) {
    const next = text === '' ? word : `${text} ${word}`
    if (next.length > SEARCH_LIMITS.maxText) break
    text = next
  }
  return text
}

/** A query as the search reads it. */
export interface SearchQuery {
  /** The folded query (empty: nothing to search). */
  readonly text: string
  /** Its words, each once, at most `maxWords`. */
  readonly words: readonly string[]
  /** Too short to search (`minQuery`). */
  readonly tooShort: boolean
  /** The query as typed, trimmed: a number is also matched whole against the entries' numbers, case aside. */
  readonly whole: string
}

export function queryWords(raw: string): SearchQuery {
  const whole = raw.trim().slice(0, SEARCH_LIMITS.maxQuery)
  const text = foldSearchText(whole)
  const words = [...new Set(text.split(' ').filter(Boolean))].slice(0, SEARCH_LIMITS.maxWords)
  const tooShort = text.replace(/\s/g, '').length < SEARCH_LIMITS.minQuery
  return { text: tooShort ? '' : words.join(' '), words: tooShort ? [] : words, tooShort, whole }
}

/** Whether a query is shaped like a document number or code (it has a digit): the palette's "Exact number" group. */
export function looksLikeNumber(raw: string): boolean {
  return /\d/.test(raw)
}
