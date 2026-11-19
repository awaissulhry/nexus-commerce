/**
 * F-OP-206 (order page plan N4; 11-dock §3.3; D7) — the keys of All of <Customer>, pure. The list is ONE tab stop (a roving focus on
 * its lines); on a line (not on a control inside it, not with ⌘ / Ctrl / Alt):
 *
 *   J or ↓      the next line (the last stays the last)
 *   K or ↑      the line before (the first stays the first)
 *   Enter       the line's door: Answer in its thread (or open its record's page)
 *   Space       show the whole message in place, or fold it again
 *
 * Tab goes into the focused line (its chip, its files, its doors). Seeing a line marks nothing read.
 */

export type FeedKeyAct = { readonly kind: 'move'; readonly to: number } | { readonly kind: 'answer' } | { readonly kind: 'expand' }

/** What a key does on line `index` of `count` lines; null: nothing (the browser keeps it). */
export function feedKeyOf(event: { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean }, index: number, count: number): FeedKeyAct | null {
  if (event.metaKey || event.ctrlKey || event.altKey || count <= 0) return null
  const last = count - 1
  const at = Math.min(Math.max(index, 0), last)
  switch (event.key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      return { kind: 'move', to: Math.min(at + 1, last) }
    case 'k':
    case 'K':
    case 'ArrowUp':
      return { kind: 'move', to: Math.max(at - 1, 0) }
    case 'Enter':
      return { kind: 'answer' }
    case ' ':
    case 'Spacebar':
      return { kind: 'expand' }
    default:
      return null
  }
}

/** The line that holds the list's one tab stop: the one last focused, kept inside the list as it grows or shrinks. */
export const rovingIndexOf = (active: number, count: number): number => (count <= 0 ? -1 : Math.min(Math.max(active, 0), count - 1))

/** A line's place for a screen reader: its position (from 1) and the list's size (-1 while older lines may still come). */
export const linePlaceOf = (index: number, count: number, more: boolean): { readonly posinset: number; readonly setsize: number } => ({ posinset: index + 1, setsize: more ? -1 : count })
