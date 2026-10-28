/**
 * Ranked option matching for pickers and filter dropdowns.
 *
 * Why this exists: every search box in the ads console used `label.toLowerCase().includes(query)`.
 * Ad entity names here are separator-heavy — "GALE | IT | Broad | Brand", "IT-AIREON-SP-Category-Broad",
 * "DE_Exact_3_Keywords" — so a raw substring test fails almost every realistic query. Measured against
 * live campaign names, ALL of these returned zero matches: "gale broad", "aireon broad", "cat exact",
 * "de exact", and even "gale it" (whose label literally contains "GALE | IT").
 *
 * The fix is to compare against a normalised form and to require every query token independently:
 *   1. NFD-normalise and drop combining marks, so "Protezione" matches "protezione" and an accented
 *      query still finds an unaccented label (Italian listing names make this real).
 *   2. Collapse every non-alphanumeric run to a single space, so `|`, `-`, `_`, `/`, `.` stop hiding
 *      word boundaries.
 *   3. Split the query on whitespace and require ALL tokens to appear (AND, order-independent) —
 *      so "gale broad" finds "GALE | IT | Broad | Brand" but not "GALE | IT | Auto".
 *
 * Matching is deliberately precise, not fuzzy: a token must actually be present as a substring.
 * Nothing is invented, so an operator can trust that an empty result means "you don't have one".
 * Ranking then puts the most literal interpretation first.
 */

/** Lowercased, accent-free, separator-collapsed form used for all comparisons. */
export function normalizeForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining marks left behind by NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Query split into normalised tokens. Empty query → no tokens → everything matches. */
export function searchTokens(query: string): string[] {
  const n = normalizeForSearch(query)
  return n ? n.split(' ') : []
}

// Per-token scores, highest interpretation wins. Sizeable gaps so a strong match on one token is
// never outweighed by several weak ones.
const S_EXACT_LABEL = 1000 // the whole normalised label IS this token
const S_LABEL_PREFIX = 400 // label starts with the token
const S_WORD_START = 200 // token starts a word inside the label
const S_SUBSTRING = 50 // token appears mid-word ("mesh" in "airmesh")

function tokenScore(haystack: string, token: string): number {
  const i = haystack.indexOf(token)
  if (i < 0) return -1 // absent → the whole candidate is rejected
  if (haystack === token) return S_EXACT_LABEL
  if (i === 0) return S_LABEL_PREFIX
  if (haystack[i - 1] === ' ') return S_WORD_START
  return S_SUBSTRING
}

/**
 * Score one label against pre-tokenised query terms.
 * Returns null when any token is missing (the candidate is out), otherwise a higher-is-better score.
 */
export function matchScore(label: string, tokens: string[]): number | null {
  if (!tokens.length) return 0
  const hay = normalizeForSearch(label)
  if (!hay) return null
  let total = 0
  for (const t of tokens) {
    const s = tokenScore(hay, t)
    if (s < 0) return null
    total += s
  }
  // Whole-query phrase hit ranks above the same tokens found scattered — typing "gale it" should
  // prefer the label where those words are adjacent.
  const phrase = tokens.join(' ')
  if (tokens.length > 1 && hay.includes(phrase)) total += S_WORD_START
  return total
}

/**
 * Filter + rank `items` by `query`. Stable and deterministic: equal scores fall back to the shorter
 * label (more specific), then alphabetical, so the list never reshuffles between renders.
 * An empty query returns the input order untouched.
 */
export function searchOptions<T>(query: string, items: readonly T[], getLabel: (item: T) => string): T[] {
  const tokens = searchTokens(query)
  if (!tokens.length) return items.slice()
  const scored: Array<{ item: T; score: number; label: string }> = []
  for (const item of items) {
    const label = getLabel(item)
    const score = matchScore(label, tokens)
    if (score != null) scored.push({ item, score, label })
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    a.label.length - b.label.length ||
    a.label.localeCompare(b.label))
  return scored.map((s) => s.item)
}
