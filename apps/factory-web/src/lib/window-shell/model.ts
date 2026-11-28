/**
 * owb-b5 (w5.3; design plan § 5zd "windows with every option", § 5s alignment, § 5y "the page follows its room"; word table: Cancel ·
 * Close) — the ONE window frame's rules, without a screen. Pure. Owner after the base: S2.
 *
 * - A window is a centred DS dialog: its name, a body that scrolls, and its foot FIXED at the bottom (the DS Modal's footer stays
 *   outside the scrolling body). On a phone (under 720 px of screen) it is a bottom sheet (the DS Modal's `sheet`).
 * - The foot: other doors at its left · the way out · the window's ONE act last. A window that acts says **Cancel**; a window that
 *   only shows (or whose act is done) says **Close** (the design's word table).
 * - Keys: ⌘ Enter (Ctrl Enter) does the act when nothing holds it; Escape is the way out (Cancel or Close: the DS Modal's own Escape
 *   calls the same `onClose`).
 * - The room (room.css): a narrow-screen rule has its narrow-ROOM twin at the same number; a table keeps its smallest width and
 *   scrolls inside its card; one button height in a title bar. A part that must know its room in code measures it with
 *   `useRoomWidth(roomOf, …)` (lib/order-cells/use-room-width.ts) — no second hook.
 */

/** Under this screen width a window is a bottom sheet (the DS Modal's `sheet`: the BottomBar's breakpoint). */
export const WINDOW_SHEET_BELOW = 720

/** The way out of a window: Cancel when it acts, Close when it only shows. */
export type WindowLeave = 'cancel' | 'close'

/** A part of the foot, left to right: the host's other doors, the gap, the way out, the act. */
export type FootPart = 'more' | 'grow' | 'leave' | 'act'

export interface WindowFoot {
  readonly leave: WindowLeave
  /** The parts in their order (the act last: the primary sits at the right, and on a phone sheet at the thumb). */
  readonly parts: readonly FootPart[]
}

/** The foot of a window from what it has: an act or not, other doors or not. */
export function windowFootOf(input: { readonly acts: boolean; readonly more: boolean }): WindowFoot {
  const leave: WindowLeave = input.acts ? 'cancel' : 'close'
  const parts: FootPart[] = []
  if (input.more) parts.push('more')
  parts.push('grow', 'leave')
  if (input.acts) parts.push('act')
  return { leave, parts }
}

/** What a key does in a window: the act, the way out, or nothing. */
export type WindowKey = 'act' | 'leave' | null

export interface WindowKeyEvent {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  /** A key that ends a composition (an IME) is not a command. */
  readonly isComposing?: boolean
}

/**
 * ⌘ Enter or Ctrl Enter → the act, only while the window acts and nothing holds or runs it; Escape → the way out (Cancel / Close).
 * Alt is never part of it; any other key does nothing here (Enter alone stays the focused control's own).
 */
export function windowKeyOf(event: WindowKeyEvent, state: { readonly acts: boolean; readonly held?: string | null; readonly busy?: boolean }): WindowKey {
  if (event.isComposing) return null
  if (event.key === 'Escape') return 'leave'
  if (event.key !== 'Enter' || event.altKey || !(event.metaKey || event.ctrlKey)) return null
  return state.acts && !state.held && !state.busy ? 'act' : null
}

/** Why the act cannot run now: the host's reason first; while it runs, the shell's own words ("Working on it…"). Null: it runs. */
export function actHeldOf(input: { readonly held?: string | null; readonly busy?: boolean }, busyWords: string): string | null {
  if (input.held) return input.held
  return input.busy ? busyWords : null
}

// ── the room (room.css holds the same numbers; a test pins them equal) ─────────────────────────────────────────────────────────────

/** A room under this width is narrow: the screen's rule (@media) and its room's twin (@container fwroom) share this number. */
export const ROOM_NARROW_BELOW = 720

export type Room = 'narrow' | 'wide'

/** The room a part has, from its own width (never the window's): use it with `useRoomWidth(roomOf, 'wide')`. */
export function roomOf(width: number): Room {
  return width < ROOM_NARROW_BELOW ? 'narrow' : 'wide'
}

/** The smallest width a table keeps per column before it scrolls inside its card (§ 5y rule 3: 8 columns ≈ 960 px). */
export const TABLE_COLUMN_MIN = 120

/** A table's smallest width (px) by its number of columns: set as `--fw-room-min` on its `.fw-room-scroll` box. */
export function tableMinWidth(columns: number): number {
  return Math.max(1, Math.floor(columns)) * TABLE_COLUMN_MIN
}
