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
export declare function normalizeForSearch(s: string): string;
/** Query split into normalised tokens. Empty query → no tokens → everything matches. */
export declare function searchTokens(query: string): string[];
/**
 * Score one label against pre-tokenised query terms.
 * Returns null when any token is missing (the candidate is out), otherwise a higher-is-better score.
 */
export declare function matchScore(label: string, tokens: string[]): number | null;
/**
 * Filter + rank `items` by `query`. Stable and deterministic: equal scores fall back to the shorter
 * label (more specific), then alphabetical, so the list never reshuffles between renders.
 * An empty query returns the input order untouched.
 */
export declare function searchOptions<T>(query: string, items: readonly T[], getLabel: (item: T) => string): T[];
