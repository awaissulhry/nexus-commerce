/**
 * DS floor kit — the icon reason grid's rules (gap D20; design part FloorReasonGrid, SCR-091 and every floor step that
 * asks "why": scrap, rework, pause, defect, symptom, grade, call type). Icons and example photos first, words second
 * (MES-125, QHS-007); one tap, no long press.
 *
 * - Pages of at most `pageSize` tiles (9: 3 × 3 on a tablet); "More reasons" / "Back" turn the page. The order is the
 *   app's (set per station in the office; no learning per person).
 * - `pick` mode: one reason or none, as a radio group — one Tab stop (the picked reason, else the first that can be
 *   picked), arrows move and pick inside the page (wrapping), Home / End. A held reason is reached and says why, never
 *   picked.
 * - `count` mode: each tap adds one (scrap, defects), the count shows on the tile, a − on the tile takes one off, never
 *   under 0 nor over `max` when the app sets one. A held reason adds nothing.
 */
import type { ReactNode } from 'react'

export type ReasonTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
export type ReasonMode = 'pick' | 'count'

export interface ReasonTile {
  id: string
  /** The word, in the worker's language ("Foro", "Hole"). */
  label: string
  /** A short second line ("in the leather"). */
  hint?: string
  /** The app's icon for the reason (an svg), drawn big in a coloured bubble. */
  icon?: ReactNode
  /** An example photo of the reason (its address); drawn instead of the icon. The word names the tile, so it is decorative. */
  photo?: string
  /** The tile's colour role; the word and the icon carry the meaning, the colour only repeats it. */
  tone?: ReasonTone
  /** This reason needs a photo before it is sent ("Other": no typing on the floor). Drawn as a camera mark + words. */
  photoNeeded?: boolean
  /** Why this reason cannot be chosen here now. Set: held (focusable, announced, inert). */
  heldReason?: string | null
}

export interface ReasonGridWords {
  more: string
  back: string
  page: string
  tileCount: string
  addOne: string
  removeOne: string
  counted: string
  total: string
  photoNeeded: string
  picked: string
  empty: string
  atMax: string
}

/** English defaults; every word comes in through the `words` prop (the factory passes its catalogue). */
export const REASON_GRID_WORDS: ReasonGridWords = {
  more: 'More reasons',
  back: 'Back',
  page: 'Page {page} of {pages}',
  tileCount: '{reason}, {count}',
  addOne: 'Tap to add one',
  removeOne: 'Take one off {reason}',
  counted: '{reason}: {count}',
  total: 'Counted in all: {count}',
  photoNeeded: 'Needs a photo',
  picked: '{reason} chosen',
  empty: 'No reasons set up here.',
  atMax: 'No more than {max}',
}

/** `{name}` → its value; a placeholder with no value stays as written, so a missing one shows. */
export function fillWords(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

export const REASON_PAGE_SIZE = 9

export const reasonCanPick = (reason: ReasonTile): boolean => !reason.heldReason

/** How many pages `count` reasons take (at least one, so an empty grid still has page 1). */
export function pageCount(count: number, pageSize: number = REASON_PAGE_SIZE): number {
  const size = Math.max(1, Math.floor(pageSize))
  return Math.max(1, Math.ceil(Math.max(0, count) / size))
}

/** The reasons of one page (0-based), the page clamped into range. */
export function pageOf<T>(reasons: readonly T[], page: number, pageSize: number = REASON_PAGE_SIZE): { items: readonly T[]; page: number; pages: number } {
  const size = Math.max(1, Math.floor(pageSize))
  const pages = pageCount(reasons.length, size)
  const at = Math.min(Math.max(0, Math.floor(page)), pages - 1)
  return { items: reasons.slice(at * size, at * size + size), page: at, pages }
}

/** The page a reason is on (0 when it is not there): a picked reason on page 2 opens page 2. */
export function pageOfReason(reasons: readonly ReasonTile[], id: string | null, pageSize: number = REASON_PAGE_SIZE): number {
  if (id == null) return 0
  const at = reasons.findIndex((reason) => reason.id === id)
  return at < 0 ? 0 : Math.floor(at / Math.max(1, Math.floor(pageSize)))
}

/** A press in pick mode: the reason picked, or the current one kept when the pressed reason is held. */
export function reasonPress(reasons: readonly ReasonTile[], current: string | null, id: string): string | null {
  const reason = reasons.find((item) => item.id === id)
  return reason && reasonCanPick(reason) ? id : current
}

/** The one Tab stop of a page in pick mode: the picked reason if it is on the page, else the first that can be picked. */
export function reasonTabStop(items: readonly ReasonTile[], value: string | null): string | null {
  if (value != null && items.some((item) => item.id === value)) return value
  return (items.find(reasonCanPick) ?? items[0])?.id ?? null
}

export type ReasonNavKey = 'ArrowRight' | 'ArrowDown' | 'ArrowLeft' | 'ArrowUp' | 'Home' | 'End'

export const isReasonNavKey = (key: string): key is ReasonNavKey =>
  key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home' || key === 'End'

/**
 * Where an arrow, Home or End moves the focus inside a page of `columns` tiles a row: ← → one tile (wrapping), ↑ ↓ one
 * row (wrapping to the same column), Home / End the first and last. `dir` mirrors ← → right to left.
 */
export function reasonKeyTarget(items: readonly ReasonTile[], from: string | null, key: ReasonNavKey, columns: number, dir: 'ltr' | 'rtl' = 'ltr'): string | null {
  const n = items.length
  if (!n) return null
  if (key === 'Home') return items[0]!.id
  if (key === 'End') return items[n - 1]!.id
  const at = Math.max(0, items.findIndex((item) => item.id === from))
  const cols = Math.max(1, Math.min(Math.floor(columns) || 1, n))
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const forward = (key === 'ArrowRight') === (dir === 'ltr')
    return items[(at + (forward ? 1 : -1) + n) % n]!.id
  }
  const rows = Math.ceil(n / cols)
  const col = at % cols
  let row = Math.floor(at / cols) + (key === 'ArrowDown' ? 1 : -1)
  row = (row + rows) % rows
  let next = row * cols + col
  // The last row may be short: a column it lacks lands on its last tile.
  if (next >= n) next = n - 1
  return items[next]!.id
}

export type CountChange = { counts: Record<string, number>; id: string; delta: 1 | -1; refused: null } | { counts: Record<string, number>; id: string; delta: 0; refused: 'held' | 'zero' | 'max' }

/**
 * One tap in count mode: +1 on the tile, −1 on its minus. Never under 0; never over `max` (per reason) when set; a held
 * reason does not count. The counts not touched are kept as they are; a count back at 0 is taken out.
 */
export function countPress(reasons: readonly ReasonTile[], counts: Readonly<Record<string, number>>, id: string, delta: 1 | -1, max?: number | null): CountChange {
  const reason = reasons.find((item) => item.id === id)
  const now = Math.max(0, Math.floor(counts[id] ?? 0))
  const same = { ...counts }
  if (!reason || !reasonCanPick(reason)) return { counts: same, id, delta: 0, refused: 'held' }
  if (delta < 0 && now <= 0) return { counts: same, id, delta: 0, refused: 'zero' }
  if (delta > 0 && typeof max === 'number' && Number.isFinite(max) && now >= max) return { counts: same, id, delta: 0, refused: 'max' }
  const next = now + delta
  const out = { ...counts }
  if (next <= 0) delete out[id]
  else out[id] = next
  return { counts: out, id, delta, refused: null }
}

/** Every count added up (the total line). */
export function countTotal(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0), 0)
}
