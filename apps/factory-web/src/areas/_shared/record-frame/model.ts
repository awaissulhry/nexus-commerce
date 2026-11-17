import type { DockWidth } from '../../../lib/record-thread/head/model'

/**
 * B-TH-213 — RecordFrame, one place for the thread on a record page (threads plan PL1, PL4; design kit §2; lead pick P2). The pure
 * part: where the thread sits at a width and how wide it is.
 *
 * - From 1280 px the thread is DOCKED on the right, open by default, sticky while the body scrolls, its own scroll, the box at its
 *   foot: a 3 : 2 grid of the page (gap 16), so 40 % at every width (1440 → 519 px, 1920 → 711 px). One third on a wide grid tab
 *   (the lines, a BOM, sizes, cost, cutting) under 1600 px, unless the person chose a width; 50 % or full from the Head's width
 *   menu (Esc from full goes back); ⌘J hides and shows it; the width is remembered per person and record type on this device.
 * - Below 1280 px the band's "Thread" button opens the thread as a full-width view; Back returns to the same tab and scroll.
 * - Below 720 px (the phone, PL4) the same full page, with the band's details behind its "i".
 * - ONE thread per page; banners stay in the body column, never above the thread.
 */

/** From this width the thread docks beside the body. */
export const DOCK_FROM = 1280
/** Below this width a wide grid tab gives the thread one third (the grid needs the room). */
export const THIRD_BELOW = 1600
/** Below this width the page is the phone's (PL4). */
export const PHONE_BELOW = 720

/** How the page shows the thread at a width: docked beside the body, or behind the band's button (a full-width view). */
export type FrameMode = 'docked' | 'stacked'

export function frameMode(viewport: number): FrameMode {
  return viewport >= DOCK_FROM ? 'docked' : 'stacked'
}

/**
 * The dock's width now: the person's choice when they made one; else 40 %, or one third on a wide grid tab under 1600 px (the
 * picture's rule R-18: no sideways scroll on Lines at 1440 with the thread open).
 */
export function dockWidth(input: { readonly chosen: DockWidth; readonly remembered: boolean; readonly wideTab: boolean; readonly viewport: number }): DockWidth {
  if (input.remembered) return input.chosen
  return input.wideTab && input.viewport < THIRD_BELOW ? 'third' : input.chosen
}

/** The body : thread columns of each width (the gap is the grid's). Full leaves the body out. */
export const DOCK_COLUMNS: Readonly<Record<DockWidth, string>> = {
  third: 'minmax(0, 2fr) minmax(0, 1fr)',
  forty: 'minmax(0, 3fr) minmax(0, 2fr)',
  half: 'minmax(0, 1fr) minmax(0, 1fr)',
  full: 'minmax(0, 1fr)',
}

/** The thread's share of the page at a width (for the design numbers: 40 % of 1794 px is the picture's 711 px with the gap). */
export function threadPixels(content: number, width: DockWidth, gap = 16): number {
  if (width === 'full') return content
  const [body, thread] = width === 'third' ? [2, 1] : width === 'forty' ? [3, 2] : [1, 1]
  return Math.round(((content - gap) * thread) / (body + thread))
}

/**
 * What an address asks of the frame on arrival (R-8: every old address keeps working): `?tab=activity` opens the thread (its tools
 * moved to the thread's "⋯"); `panel=approvals` also opens "Ask a partner to approve". Anything else: nothing.
 */
export function arrivalOf(search: string | { get(name: string): string | null } | null | undefined): { readonly openThread: boolean; readonly door: 'approve' | null } {
  if (!search) return { openThread: false, door: null }
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search : `?${search}`) : search
  const activity = params.get('tab') === 'activity'
  const approvals = params.get('panel') === 'approvals'
  return { openThread: activity || approvals, door: approvals ? 'approve' : null }
}

/** ⌘J (Ctrl J on other systems): show or hide the docked thread, open or close the full-width one. Never with Alt or Shift. */
export function isThreadKey(event: { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j'
}

/** The keys a record page lists in its band menu's "Keyboard" line (PR-14: never a "?" overlay in the thread). */
export const FRAME_KEYS: readonly { readonly keys: readonly string[]; readonly words: string }[] = [
  { keys: ['⌘', 'J'], words: 'keys.thread' },
  { keys: ['⌘', '↵'], words: 'keys.step' },
  { keys: ['J', 'K'], words: 'keys.walk' },
  { keys: ['R'], words: 'keys.reply' },
  { keys: ['N'], words: 'keys.note' },
  { keys: ['Esc'], words: 'keys.esc' },
]
