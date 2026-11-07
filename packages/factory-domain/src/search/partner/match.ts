import { foldSearchText, SEARCH_LIMITS, type SearchQuery } from '../text'

/**
 * How a partner's query matches one of its records (B-W2b-168; SAL-084; design portal.frame › top-bar: "their numbers, our
 * numbers"; "better": "The partner's own numbers come first and are searchable (their PO, their article code)"). Pure.
 *
 * The API finds candidates in the search index (B-W2a-32, B-W2b-23) and by the record's own reference columns, reads each
 * through the partner's wall, and keeps it only when the query matches the fields the record's partner view names
 * (`PartnerFields`): never a word only the office sees. Matching follows the office search (../text): every query word
 * found inside the folded text as typed, or, for a word of 3 letters or more WITHOUT a digit (a name), a word alike (trigram
 * similarity, the office's threshold); a word with a digit is a number or a code and matches only as typed, so a mistyped
 * number never finds another record (`SEED-SH-0002` is not `SEEDTRACK0002`). The query typed whole equal to their
 * reference or to our number is an exact hit.
 *
 * Order (their reference first, as RefPair shows it): their reference typed whole, our number typed whole, every word
 * found as typed, words alike; then how alike.
 */

export interface PartnerFields {
  /** Their own reference for the record (their PO number, their order reference), or null. */
  readonly theirRef: string | null
  /** Our number (an order's, a document's), or null. */
  readonly ourRef: string | null
  /** Other words the partner sees and may type (a related order's number, tracking numbers, their article codes). */
  readonly words?: readonly (string | null | undefined)[]
}

export const PARTNER_MATCHES = ['theirs', 'ours', 'words', 'similar'] as const
export type PartnerMatch = (typeof PARTNER_MATCHES)[number]

export interface PartnerHit {
  readonly match: PartnerMatch
  /** 0 their reference whole, 1 our number whole, 2 every word as typed, 3 a word alike: lower first. */
  readonly rank: number
  /** How alike (higher first): one per word found as typed, the similarity of a word alike. */
  readonly score: number
}

const RANK: Readonly<Record<PartnerMatch, number>> = Object.freeze({ theirs: 0, ours: 1, words: 2, similar: 3 })

/** The trigrams of one word as pg_trgm makes them: the word padded with two spaces before and one after. */
export function trigramsOf(word: string): Set<string> {
  const padded = `  ${word} `
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3))
  return grams
}

/** Letters and digits only: pg_trgm reads a code `ord-2026-00042` as the words `ord`, `2026`, `00042`. */
const trigramWords = (text: string): string[] => text.split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean)

/**
 * How alike a typed word is to the best word of a text (0 to 1): the share of the typed word's trigrams that one word of
 * the text has (pg_trgm's word_similarity read word by word). Both folded.
 */
export function wordSimilarity(word: string, text: string): number {
  const typed = trigramWords(word)
  if (typed.length === 0) return 0
  const wanted = trigramsOf(typed.join(' '))
  let best = 0
  for (const candidate of trigramWords(text)) {
    const grams = trigramsOf(candidate)
    let shared = 0
    for (const gram of wanted) if (grams.has(gram)) shared++
    best = Math.max(best, shared / wanted.size)
    if (best === 1) break
  }
  return best
}

/** A number or a code: matched only as typed. */
const HAS_DIGIT = /\p{Number}/u

const sameRef = (typed: string, ref: string | null): boolean => ref !== null && typed !== '' && foldSearchText(ref) === typed

/** The partner fields as one folded text (our number, their reference, the other words), as the index folds its text. */
export function partnerTextOf(fields: PartnerFields): string {
  const parts = [fields.ourRef, fields.theirRef, ...(fields.words ?? [])].filter((part): part is string => typeof part === 'string' && part.trim() !== '')
  return foldSearchText(parts.join(' '))
}

/** How the query matches the record's partner fields, or null when it does not. */
export function partnerMatchOf(query: SearchQuery, fields: PartnerFields): PartnerHit | null {
  if (query.tooShort || query.words.length === 0) return null
  const whole = foldSearchText(query.whole)
  if (sameRef(whole, fields.theirRef)) return { match: 'theirs', rank: RANK.theirs, score: query.words.length }
  if (sameRef(whole, fields.ourRef)) return { match: 'ours', rank: RANK.ours, score: query.words.length }
  const text = partnerTextOf(fields)
  let score = 0
  let similar = false
  for (const word of query.words) {
    if (text.includes(word)) {
      score += 1
      continue
    }
    if (word.length < SEARCH_LIMITS.fuzzyWordLength || HAS_DIGIT.test(word)) return null
    const alike = wordSimilarity(word, text)
    if (alike < SEARCH_LIMITS.wordSimilarity) return null
    score += alike
    similar = true
  }
  const match: PartnerMatch = similar ? 'similar' : 'words'
  return { match, rank: RANK[match], score }
}

/** Orders two hits: their reference whole first, then our number, words as typed, words alike; then how alike. */
export function compareHits(a: PartnerHit, b: PartnerHit): number {
  return a.rank - b.rank || b.score - a.score
}

/**
 * The one result Enter opens directly (design portal.customer.home › search-hero): the only result (unless it was found by a
 * word alike only: a guess is never opened for the person), or else the only one whose reference (theirs or ours) was typed
 * whole; null when the person has to choose.
 */
export function singleOf<Result extends { readonly match: PartnerMatch }>(results: readonly Result[]): Result | null {
  if (results.length === 1) return results[0]!.match === 'similar' ? null : results[0]!
  const whole = results.filter((result) => result.match === 'theirs' || result.match === 'ours')
  return whole.length === 1 ? whole[0]! : null
}
