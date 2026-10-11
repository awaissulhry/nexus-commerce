/**
 * The words of `EntityLinks` (bid page DS lane, 2026-10-10) — pure, tested in Node.
 *
 * A list of things a row works on (portfolios, campaigns, ad groups): none → a muted dash that says "No campaigns";
 * one → its name as a direct link; several → a count ("3 campaigns") that opens a small list of links.
 */

/** A thing to link to. `href` absent → its name is shown without a link (it has no page). */
export interface EntityRef { id: string; name: string; href?: string | null }
/** "campaign" / "campaigns". */
export interface EntityNoun { one: string; many: string }

export const entityCountWords = (n: number, noun: EntityNoun): string => `${n} ${n === 1 ? noun.one : noun.many}`

export type EntityLinksView =
  | { kind: 'none'; label: string }
  | { kind: 'one'; item: EntityRef; label: string }
  /** `more`: how many the count holds beyond the listed ones (a capped list, `total`); 0 when all are listed. */
  | { kind: 'many'; items: readonly EntityRef[]; words: string; label: string; more: number }

/** The "53 more not listed" line under a capped list. */
export const entityMoreWords = (more: number): string => `${more} more not listed`

/**
 * What to draw, and the whole sentence a screen reader hears for it. Duplicate ids are listed once. `total` (polish
 * round 2, 2026-10-10): the true count when the list is capped — "153 campaigns" over 100 links and "53 more not
 * listed"; a total below the listed number is ignored (the list itself is the floor).
 */
export function entityLinksView(items: ReadonlyArray<EntityRef> | null | undefined, noun: EntityNoun, total?: number | null): EntityLinksView {
  const seen = new Set<string>()
  const list = (items ?? []).filter((i) => i && typeof i.name === 'string' && !seen.has(i.id) && (seen.add(i.id), true))
  const count = typeof total === 'number' && Number.isFinite(total) ? Math.max(Math.floor(total), list.length) : list.length
  if (!count) return { kind: 'none', label: `No ${noun.many}` }
  if (count === 1 && list.length === 1) return { kind: 'one', item: list[0], label: `${noun.one.charAt(0).toUpperCase()}${noun.one.slice(1)}: ${list[0].name}` }
  const words = entityCountWords(count, noun)
  const more = count - list.length
  const names = list.map((i) => i.name).join(', ')
  const label = more ? `${words}: ${names ? `${names}, and ` : ''}${more} more not listed` : `${words}: ${names}`
  return { kind: 'many', items: list, words, label, more }
}

/** Names for the CSV, the clipboard and the quick filter: "A, B, C"; empty when there are none. */
export const entityLinksText = (items: ReadonlyArray<EntityRef> | null | undefined): string =>
  (items ?? []).map((i) => i?.name).filter(Boolean).join(', ')

/** Sort by how many (the true `total` when a list is capped), then by the first name. */
export function compareEntityLinks(
  a: ReadonlyArray<EntityRef> | null | undefined,
  b: ReadonlyArray<EntityRef> | null | undefined,
  totalA?: number | null,
  totalB?: number | null,
): number {
  const la = Math.max(a?.length ?? 0, totalA ?? 0), lb = Math.max(b?.length ?? 0, totalB ?? 0)
  if (la !== lb) return la - lb
  return (a?.[0]?.name ?? '').localeCompare(b?.[0]?.name ?? '')
}
