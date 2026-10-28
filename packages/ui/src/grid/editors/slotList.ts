/**
 * Step 4.3 #3 (A-52; rulings R-55, R-56) — a numbered LIST shown as ONE cell: the pure rules.
 *
 * A channel declares some lists as fixed positions (Amazon `bullet_point`: 10 × 700). The sheet serves them as ten SLOT
 * columns (`bulletPoints_1…10`, write field `bulletPoints[i]`), and those stay the write path, the import/export keys and
 * the formula targets. The one cell is a VIEW over them: its value is the ten positions (holes kept as `''`), and an edit
 * becomes one write per CHANGED position — never a whole-list write, so the per-slot caps and the per-row refusals stay
 * where they are.
 *
 * Shared (master) bullets are one unbounded list column; the same editor opens on it in `list` mode (the items plus one
 * trailing empty position; blanks are dropped on commit, as the server already does).
 *
 * Pure: no React, no AG at runtime, no DOM globals — `suppressSlotListKeys` reads the event target structurally so the
 * rules run in node.
 */

/** The virtual column's key prefix. `slots:bulletPoints` is never a write field and never a server column. */
export const SLOT_LIST_PREFIX = 'slots:'

/** One slot group — the positions of one list, in order. */
export interface SlotGroup {
  /** The list field the slots write (`bulletPoints`). */
  of: string
  /** How many positions the channel declares (Amazon bullets: 10). */
  max: number
  /** The slot column keys, position 1 first (`bulletPoints_1` … or `bulletPoints_1@de` …). */
  keys: readonly string[]
  /** The per-position character cap the channel declares, when it declares one. */
  maxLength?: number | null
  /** The language of a Languages-view group (`de`). */
  locale?: string | null
}

/** `slots:bulletPoints`, or `slots:bulletPoints@de` in the Languages view. */
export function slotListKey(of: string, locale?: string | null): string {
  return `${SLOT_LIST_PREFIX}${of}${locale ? `@${locale}` : ''}`
}

export function isSlotListKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.startsWith(SLOT_LIST_PREFIX)
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** The one cell's value: exactly `max` positions, an empty position as `''` — never compacted, never padded past `max`. */
export function slotListValue(values: ReadonlyArray<unknown> | null | undefined, max: number): string[] {
  const out: string[] = []
  for (let i = 0; i < max; i++) out.push(text(values?.[i]))
  return out
}

/** A changed position: 1-based, and a cleared position is `null` (a slot write of `null` clears that slot only). */
export interface SlotChange { position: number; value: string | null }

/** Which positions an edit changed. Untouched → `[]`; only CHANGED positions appear, an unchanged hole never does. */
export function slotListChanges(before: ReadonlyArray<unknown> | null | undefined, after: ReadonlyArray<unknown> | null | undefined, max: number): SlotChange[] {
  const a = slotListValue(before, max)
  const b = slotListValue(after, max)
  const out: SlotChange[] = []
  for (let i = 0; i < max; i++) if (a[i] !== b[i]) out.push({ position: i + 1, value: b[i] === '' ? null : b[i] })
  return out
}

/** Move one position (0-based `from` → `to`). Only the span between them is rewritten; nothing is lost or duplicated. */
export function moveSlot<T>(values: readonly T[], from: number, to: number): T[] {
  const next = [...values]
  if (from < 0 || to < 0 || from >= next.length || to >= next.length || from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Alt+↑ / Alt+↓ on a position: the new order, the id that keeps the focus, and the sentence to announce — the same words
 * `OrderedList` says for its buttons and drag ("Bullet 3, position 2 of 10"), so the three ways to move read alike.
 */
export function moveByKey(order: readonly string[], position: number, direction: 'up' | 'down', labelOf: (id: string) => string): { order: string[]; focus: string; announcement: string } | null {
  const from = position - 1
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || from >= order.length || to < 0 || to >= order.length) return null
  const id = order[from]
  return { order: moveSlot(order, from, to), focus: id, announcement: `${labelOf(id)}, position ${to + 1} of ${order.length}` }
}

/** List mode (Shared): the stored items as they are, plus ONE trailing empty position while there is room (`max` null = always). */
export function listModeItems(value: unknown, max: number | null | undefined): string[] {
  const items = Array.isArray(value) ? value.map(text) : value === null || value === undefined || value === '' ? [] : [text(value)]
  return withTrailingEmpty(items, max)
}

/** Keep exactly the editing affordance: when the last position has text and there is room, one more empty position. */
export function withTrailingEmpty(positions: readonly string[], max: number | null | undefined): string[] {
  const next = [...positions]
  const room = max === null || max === undefined || next.length < max
  if (room && (next.length === 0 || next[next.length - 1].trim() !== '')) next.push('')
  return next
}

/** List mode's committed value: blank positions dropped (the trailing empty is never a bullet), order kept. */
export function listModeCommit(positions: readonly string[]): string[] {
  return positions.filter((p) => p.trim() !== '')
}

/** The copy / export / filter text of the one cell: the non-empty positions, numbered, one line each. */
export function slotListText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map((v, i) => ({ v: text(v), n: i + 1 })).filter((x) => x.v.trim() !== '').map((x) => `${x.n}. ${x.v}`).join('\n')
}

/**
 * R-55 — what a key does inside the bullets editor, by the focused POSITION (1-based; `count + 1` = the footer).
 *
 *   Tab            → the next position; on the LAST position it is not taken: AG commits and moves right.
 *   Shift+Tab      → the previous position; on the FIRST it is not taken: AG commits and moves left.
 *   Alt+↑ / Alt+↓  → move the focused bullet up / down (`none` at the ends — taken, nothing moves).
 *   Enter          → save (the editor's own commit); Shift+Enter is swallowed — a bullet is one line.
 *   anything else  → `type`: the field's own behaviour; AG is not asked (Esc stays AG's cancel).
 */
export type BulletsKeyAction = 'next' | 'prev' | 'up' | 'down' | 'none' | 'save' | 'swallow' | 'press' | 'ag' | 'type'

export interface KeyLike { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }

export function bulletsEditorKey(event: KeyLike, position: number, count: number, options: { onButton?: boolean } = {}): BulletsKeyAction {
  if (event.isComposing) return 'type'
  if (event.key === 'Tab') {
    if (event.shiftKey) return position > 1 ? 'prev' : 'ag'
    return position >= 1 && position < count ? 'next' : 'ag'
  }
  if (event.key === 'Escape') return 'ag'
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    if (position < 1 || position > count) return 'none'
    if (event.key === 'ArrowUp') return position > 1 ? 'up' : 'none'
    return position < count ? 'down' : 'none'
  }
  /* Enter on a button (move up/down, Cancel, Apply) is that button's press — taken from AG, never turned into a save. */
  if (event.key === 'Enter') return options.onButton ? 'press' : event.shiftKey ? 'swallow' : 'save'
  return 'type'
}

/** The editor's root class — the ONE marker the gate and the key rule read. */
export const SLOT_LIST_EDITOR_CLASS = 'nds-slotlist-editor'

interface ClosestLike { closest?: (selector: string) => unknown; parentElement?: unknown; children?: ArrayLike<unknown>; getAttribute?: (name: string) => string | null }

/**
 * The 1-based position a key event came from: the reorder row it sits in (`OrderedList` marks each row
 * `data-nds-reorder-item`), or `count + 1` for anything else inside the editor (the footer). `0` outside the editor.
 */
export function slotPositionOf(target: unknown): { position: number; count: number; onButton: boolean } {
  const t = target as ClosestLike | null
  const editor = typeof t?.closest === 'function' ? (t.closest(`.${SLOT_LIST_EDITOR_CLASS}`) as ClosestLike | null) : null
  if (!editor) return { position: 0, count: 0, onButton: false }
  const count = Number(editor.getAttribute?.('data-slot-count') ?? 0) || 0
  const item = typeof t?.closest === 'function' ? (t.closest('[data-nds-reorder-item]') as ClosestLike | null) : null
  const siblings = (item?.parentElement as ClosestLike | undefined)?.children
  const index = item && siblings ? Array.prototype.indexOf.call(siblings, item) : -1
  const onButton = typeof t?.closest === 'function' && !!t.closest('button')
  return { position: index >= 0 ? index + 1 : count + 1, count, onButton }
}

/**
 * The ColDef's `suppressKeyboardEvent` for the bullets editor: AG's popup handling runs before React's bubble handlers,
 * so a key the editor acts on (Tab between positions, Alt+↑/↓, Enter, Shift+Enter) must be taken from AG here, and a key
 * the editor leaves to AG (Tab past the last, Shift+Tab before the first, Esc) must not be.
 */
export function suppressSlotListKeys({ event, editing }: { event: KeyboardEvent | KeyLike & { target?: unknown }; editing: boolean }): boolean {
  if (!editing) return false
  const { position, count, onButton } = slotPositionOf((event as { target?: unknown }).target)
  if (!count) return false
  const action = bulletsEditorKey(event as KeyLike, position, count, { onButton })
  return action !== 'ag' && action !== 'type'
}
