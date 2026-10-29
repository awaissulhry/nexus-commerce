/**
 * The list frame's rules (Owner rule 2026-10-29, design 00 "tables: key hints and selection"), pure: what the header
 * checkbox shows, how a selection grows and shrinks (one row, a shift range, every loaded row), how the keys move the
 * focus, and which keys the footer's information icon lists. Every Office list with actions over many rows uses the
 * same frame (`ListFrame.tsx`), so these rules are the same on every list.
 */

/** The header checkbox: none, some (mixed) or every loaded row selected. */
export type SelectAllState = 'none' | 'some' | 'all'

export function selectAllState(loaded: readonly string[], selected: readonly string[]): SelectAllState {
  if (loaded.length === 0) return 'none'
  const held = new Set(selected)
  const count = loaded.filter((id) => held.has(id)).length
  return count === 0 ? 'none' : count === loaded.length ? 'all' : 'some'
}

/** The same ids, in any order. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/** One row in or out of the selection (x on the focused row, a click on its box). */
export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((held) => held !== id) : [...selected, id]
}

/**
 * Shift-click: every row between the last one ticked (`anchor`) and this one, in the list's order, takes this row's new
 * state; rows outside the range keep theirs. Without an anchor in the list, only this row changes.
 */
export function rangeIds(order: readonly string[], selected: readonly string[], anchor: string | null, target: string, on: boolean): string[] {
  const from = anchor === null ? -1 : order.indexOf(anchor)
  const to = order.indexOf(target)
  if (to < 0) return [...selected]
  const [start, end] = from < 0 ? [to, to] : from < to ? [from, to] : [to, from]
  const range = new Set(order.slice(start, end + 1))
  const kept = selected.filter((id) => !range.has(id))
  return on ? [...kept, ...order.slice(start, end + 1)] : kept
}

/** Header checkbox pressed: every loaded row in, or (when all are in) every loaded row out; rows not loaded keep theirs. */
export function toggleAll(loaded: readonly string[], selected: readonly string[]): string[] {
  const loadedSet = new Set(loaded)
  const others = selected.filter((id) => !loadedSet.has(id))
  return selectAllState(loaded, selected) === 'all' ? others : [...others, ...loaded]
}

/** The row j / k (↓ / ↑) moves to: the next or previous one, held at the ends; from no row, the first. */
export function nextRowIndex(current: number | null, delta: 1 | -1, count: number): number | null {
  if (count === 0) return null
  if (current === null || current < 0) return 0
  return Math.min(count - 1, Math.max(0, current + delta))
}

/** One key of a list: what to press (each part a key cap) and what it does (a message key, or words). */
export interface ListKey {
  keys: readonly string[]
  /** A message key of `lists` (`keys.open`), or the list's own words. */
  does: string
}

/** The keys every frame has; a list adds its own (`c` new …) in front. */
export const FRAME_KEYS: readonly ListKey[] = Object.freeze([
  { keys: ['/'], does: 'keys.search' },
  { keys: ['j', 'k'], does: 'keys.rows' },
  { keys: ['↑', '↓'], does: 'keys.cells' },
  { keys: ['↵'], does: 'keys.open' },
  { keys: ['x'], does: 'keys.select' },
  { keys: ['⇧', 'click'], does: 'keys.range' },
  { keys: ['?'], does: 'keys.help' },
])

/** The list's own keys first, then the frame's (one entry per key). */
export function listKeys(own: readonly ListKey[] = [], withSelection = true): ListKey[] {
  const frame = FRAME_KEYS.filter((entry) => withSelection || (entry.does !== 'keys.select' && entry.does !== 'keys.range'))
  const seen = new Set(own.map((entry) => entry.keys.join('+')))
  return [...own, ...frame.filter((entry) => !seen.has(entry.keys.join('+')))]
}

/** A keydown the list may act on: no modifier, and not typed into a field, a menu or a dialog. */
export function isListKey(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  target: { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null,
): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (!target) return true
  if (target.isContentEditable) return false
  const tag = (target.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
  return !(target.closest?.('[role="dialog"], [role="menu"], [role="listbox"]') ?? null)
}

/**
 * Several frames on one page (a record's tabs, two lists side by side): the list keys belong to ONE of them — the frame
 * that holds the focus, else the page's first frame. `own` is this frame's place among the page's frames, `holding`
 * the place of the frame the focus is in (null: none).
 */
export function ownsKeys(own: number, holding: number | null): boolean {
  return holding === null ? own === 0 : own === holding
}

