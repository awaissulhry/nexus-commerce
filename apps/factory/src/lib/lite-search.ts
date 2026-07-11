/**
 * FS3 — shared q+cursor grammar for the -lite picker endpoints
 * (/api/users-lite, /api/parties-lite). A request is "paged" the moment it
 * carries `q` or `cursor`; bare requests keep the historical whole-list
 * behavior until every consumer is swapped. `pageSlice` implements the
 * fetch-take-plus-one → nextCursor idiom.
 */

export const LITE_TAKE = 30;

export interface LiteParams {
  /** trimmed search text; null when absent/blank */
  q: string | null;
  /** opaque id cursor; null when absent/blank */
  cursor: string | null;
  /** true ⇒ serve the paged/searchable shape (q or cursor present) */
  paged: boolean;
}

export function parseLiteParams(searchParams: URLSearchParams): LiteParams {
  const rawQ = searchParams.get("q");
  const rawCursor = searchParams.get("cursor");
  const q = rawQ != null && rawQ.trim() !== "" ? rawQ.trim() : null;
  const cursor = rawCursor != null && rawCursor.trim() !== "" ? rawCursor.trim() : null;
  // an explicit-but-blank q ("?q=") still opts into paging: it is the picker browsing page 1
  const paged = rawQ != null || rawCursor != null;
  return { q, cursor, paged };
}

/**
 * Rows were fetched with `take + 1`: the surplus row only signals another
 * page. Returns the page plus the id to pass back as `cursor`.
 */
export function pageSlice<T>(rows: T[], take: number, idOf: (row: T) => string): { items: T[]; nextCursor: string | null } {
  if (rows.length <= take) return { items: rows, nextCursor: null };
  const items = rows.slice(0, take);
  return { items, nextCursor: idOf(items[items.length - 1]) };
}
