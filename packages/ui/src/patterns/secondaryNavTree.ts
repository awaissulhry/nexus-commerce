/**
 * WorkspaceSubheader rows with rows under them (Owner-approved board "Sidebar · channel rows with markets", 2026-10-27).
 *
 * A row with `children` keeps its own link and gets a chevron button that shows or hides the rows under it. Open state:
 * - a parent that holds the current page (one of its children is `active`) opens when the person arrives on that page;
 * - every other parent follows the person's own choice, remembered per navigation in localStorage, and starts closed;
 * - a closed parent that holds the current page is marked (bold label, a dot, words for a screen reader).
 *
 * Framework-free: the component keeps the state, these functions decide it (Node tests).
 */

/** The minimum a row needs here (structural, so the component's `WorkspaceNavItem` fits). */
export interface NavTreeItem {
  id: string
  label: string
  active?: boolean
  children?: readonly NavTreeItem[]
  childrenLabel?: string
}

/** The noun for the rows under a row when the feature names none: "Show Amazon items". */
export const DEFAULT_CHILDREN_LABEL = 'items'

/** A row is a parent when it has at least one row under it. An empty `children` draws a plain row (no chevron). */
export function isNavParent(item: NavTreeItem): boolean {
  return (item.children?.length ?? 0) > 0
}

/** One of the rows under `item` is the current page. */
export function holdsCurrentPage(item: NavTreeItem): boolean {
  return item.children?.some(child => child.active) ?? false
}

/** Every row, parents first and their children after them (one level, as drawn). */
export function flattenNavItems<T extends NavTreeItem>(items: readonly T[]): T[] {
  return items.flatMap(item => [item, ...((item.children ?? []) as readonly T[])])
}

/** The localStorage key of one parent's open/closed choice: per navigation (its label) and per row. */
export function navOpenStorageKey(navigationLabel: string, itemId: string): string {
  return `nds-secondary-nav:${navigationLabel}:${itemId}`
}

type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem'>

/** The browser's localStorage, or null where it is missing or blocked (server, private window, sandbox). */
export function navStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** The remembered choice for each parent that has one. Nothing stored, or storage unavailable → no entry. */
export function readNavOpenChoices(
  storage: ReadStorage | null,
  navigationLabel: string,
  parentIds: readonly string[],
): Record<string, boolean> {
  const choices: Record<string, boolean> = {}
  if (!storage) return choices
  for (const id of parentIds) {
    try {
      const raw = storage.getItem(navOpenStorageKey(navigationLabel, id))
      if (raw === 'open') choices[id] = true
      else if (raw === 'closed') choices[id] = false
    } catch {
      // Blocked storage: the row keeps its default; the page works without it.
    }
  }
  return choices
}

/** Remember the person's choice. A failed write (quota, private mode) keeps the choice for this visit only. */
export function writeNavOpenChoice(storage: WriteStorage | null, navigationLabel: string, itemId: string, open: boolean): void {
  if (!storage) return
  try {
    storage.setItem(navOpenStorageKey(navigationLabel, itemId), open ? 'open' : 'closed')
  } catch {
    // In-session only.
  }
}

/** Is the parent open? The choice made (or the arrival on one of its pages), else open only while it holds the page. */
export function isNavParentOpen(item: NavTreeItem, choices: Readonly<Record<string, boolean>>): boolean {
  return choices[item.id] ?? holdsCurrentPage(item)
}

/**
 * The child row that is the current page and its parent, if a child is. The component opens that parent each time
 * this child changes (the first render included): arriving on a market page opens its channel, while staying on the
 * page keeps the person's own choice, so a parent closed on its page stays closed (and shows the dot) until they move.
 */
export function currentPageInChildren(items: readonly NavTreeItem[]): { parentId: string; childId: string } | undefined {
  for (const item of items) {
    const child = item.children?.find(c => c.active)
    if (child) return { parentId: item.id, childId: child.id }
  }
  return undefined
}

/** `choices` with the parent of the page just arrived on opened (the same object when it already is). */
export function openOnArrival(
  choices: Readonly<Record<string, boolean>>,
  arrival: { parentId: string } | undefined,
): Readonly<Record<string, boolean>> {
  if (!arrival || choices[arrival.parentId] === true) return choices
  return { ...choices, [arrival.parentId]: true }
}

/** Remembered choices merged under the ones made in this visit (a later read never undoes a click). */
export function mergeRemembered(
  choices: Readonly<Record<string, boolean>>,
  remembered: Readonly<Record<string, boolean>>,
): Readonly<Record<string, boolean>> {
  const merged = { ...remembered, ...choices }
  const same = Object.keys(merged).length === Object.keys(choices).length
  return same ? choices : merged
}

/** The rows' noun ("markets"); the feature's own or the default. */
export function childrenNoun(item: NavTreeItem): string {
  return item.childrenLabel?.trim() || DEFAULT_CHILDREN_LABEL
}

/** The chevron's name: "Show Amazon markets" / "Hide Amazon markets". */
export function navToggleLabel(item: NavTreeItem, open: boolean): string {
  return `${open ? 'Hide' : 'Show'} ${item.label} ${childrenNoun(item)}`
}

/** The name of the list under a row: "Amazon markets". */
export function navChildrenGroupLabel(item: NavTreeItem): string {
  return `${item.label} ${childrenNoun(item)}`
}

/** Words for a screen reader on a closed parent that holds the page (beside the dot). */
export function navCurrentInsideText(item: NavTreeItem): string {
  return `(the current page is in ${item.label})`
}
