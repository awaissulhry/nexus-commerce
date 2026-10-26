/**
 * The view rules of `DetailModal` (bid page polish round 2, 2026-10-10) — pure, tested in Node.
 *
 * Prev / Next walk the rows of the table as the person sees it now (filtered, sorted): the host passes their ids in
 * that order. No wrap-around: at the first row Previous is held and says so, at the last row Next. A row that is no
 * longer in the list (a filter now hides it) holds both and says why, rather than jumping somewhere unasked.
 *
 * Keys: J = next row, K = previous row (Gmail's and GitHub's pair). They never fire with Ctrl, Alt or ⌘ held, nor while
 * the focus is in a text field, a select or anything editable, in a grid (AG's own keys, and typing starts an edit
 * there), or in a list, menu or slider (type-ahead) — so they never take a letter from someone typing. Esc stays the
 * Modal's: it closes the top dialog only.
 */

export interface DetailPosition {
  /** 0-based place of the current row in `ids`; -1 when it is not in the list. */
  index: number
  /** Rows in the whole list: `ids.length`, or the `place.total` of a paged list. */
  total: number
  prevId: string | null
  nextId: string | null
  /** "3 of 12" (on page 2 of 25 rows each: "28 of 56"); null when the row is not in the list. */
  words: string | null
}

/**
 * Where `ids` sit in a longer list, when they are one page of it: `offset` rows come before them (the earlier pages) and
 * the whole list has `total` rows. Prev / Next still walk `ids` only; the counter and the reasons at a page's ends say
 * where the row is in the whole list.
 */
export interface DetailPlace {
  offset?: number
  total?: number | null
}

function placeOf(ids: readonly string[], place: DetailPlace = {}): { offset: number; total: number } {
  const offset = Math.max(0, Math.floor(place.offset ?? 0))
  return { offset, total: Math.max(place.total ?? 0, offset + ids.length) }
}

export function detailPosition(ids: readonly string[], current: string | null | undefined, place?: DetailPlace): DetailPosition {
  const { offset, total } = placeOf(ids, place)
  const index = current == null ? -1 : ids.indexOf(current)
  if (index < 0) return { index: -1, total, prevId: null, nextId: null, words: null }
  return {
    index,
    total,
    prevId: index > 0 ? ids[index - 1] : null,
    nextId: index < ids.length - 1 ? ids[index + 1] : null,
    words: `${offset + index + 1} of ${total}`,
  }
}

export type DetailDirection = 'prev' | 'next'

/** The button's name: "Previous rule", "Next keyword". */
export const detailNavLabel = (dir: DetailDirection, noun = 'row'): string => `${dir === 'prev' ? 'Previous' : 'Next'} ${noun}`

/** Why Previous / Next is held, or null when it can go. At a page's end with more rows beyond: "… on this page". */
export function detailNavHeld(pos: DetailPosition, noun = 'row', place?: DetailPlace): Record<DetailDirection, string | null> {
  if (pos.index < 0) {
    const why = `This ${noun} is not in the table now`
    return { prev: why, next: why }
  }
  const offset = Math.max(0, Math.floor(place?.offset ?? 0))
  const moreBefore = offset > 0
  const moreAfter = offset + pos.index + 1 < pos.total
  return {
    prev: pos.prevId == null ? `This is the first ${noun}${moreBefore ? ' on this page' : ''}` : null,
    next: pos.nextId == null ? `This is the last ${noun}${moreAfter ? ' on this page' : ''}` : null,
  }
}

/** The keys, as `aria-keyshortcuts` and the tooltips name them (either case works). */
export const DETAIL_NAV_KEYS: Readonly<Record<DetailDirection, string>> = { prev: 'K', next: 'J' }

/** Where the focus is when a key arrives: only `other` lets J / K move. */
export type KeyTargetKind = 'text' | 'grid' | 'list' | 'other'

/** CSS selectors for each kind, tried in this order (the component classifies `event.target` with them). */
export const KEY_TARGET_SELECTORS: ReadonlyArray<readonly [Exclude<KeyTargetKind, 'other'>, string]> = [
  ['text', 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]'],
  ['grid', '[role="grid"], [role="treegrid"], .ag-root-wrapper'],
  ['list', '[role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="slider"]'],
]

export interface NavKeyEvent { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }

/** Which way a key moves, or null when it is not ours. */
export function detailNavKey(event: NavKeyEvent, target: KeyTargetKind): DetailDirection | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || target !== 'other') return null
  const key = event.key.toUpperCase()
  if (key === DETAIL_NAV_KEYS.next) return 'next'
  if (key === DETAIL_NAV_KEYS.prev) return 'prev'
  return null
}

/** What the body shows: a read that failed wins, then a read in progress, then the content. */
export function detailBodyState(args: { loading?: boolean; error?: unknown }): 'error' | 'loading' | 'ready' {
  if (args.error != null && args.error !== false && args.error !== '') return 'error'
  return args.loading ? 'loading' : 'ready'
}

/**
 * The body's floor while the detail is open (run 3): the tallest content seen so far, but never more than the room the
 * body has at the dialog's max height — so a shorter tab or the next row does not shrink the dialog (no jump), and a
 * short tab never scrolls over empty space. `room` is Infinity while the body does not scroll.
 */
export function nextTallest(prev: number, content: number, room: number): number {
  return Math.max(prev, Math.min(content, room))
}

/** The slice of an element `onlyEmptyState` reads, so it is tested in Node. */
export interface EmptyCheckNode {
  classList: { contains(name: string): boolean }
  children: ArrayLike<EmptyCheckNode>
  textContent: string | null
}
export const EMPTY_STATE_CLASS = 'nds-empty'

/**
 * Is the body's content ONE DS EmptyState and nothing else — possibly inside wrappers that hold nothing else (a tab's
 * panel, a stack)? Then `DetailModal` centres it in the kept-tall body (audit M12, 2026-10-11: "No effect yet" sat 32 px
 * under the tabs with 187–240 px empty below). Normal content is never moved.
 */
export function onlyEmptyState(root: EmptyCheckNode | null | undefined): boolean {
  let node = root
  while (node) {
    if (node.children.length !== 1) return false
    const only = node.children[0]
    if (only.classList.contains(EMPTY_STATE_CLASS)) return (root!.textContent ?? '').trim() === (only.textContent ?? '').trim()
    node = only
  }
  return false
}
