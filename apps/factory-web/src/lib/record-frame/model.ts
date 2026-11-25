import type { DockWidth } from '../record-thread/head/model'

/**
 * pp-k1 k1.2 — the record frame's CORE, shared by the office frame (areas/_shared/record-frame/RecordFrame.tsx) and the portal's
 * (portal/shell/record/PortalRecordFrame.tsx): where the thread sits at a width and how wide it is, and the frame's catalogue. Cut
 * as it was from the office frame's model (B-TH-213; the portal frame kept its own copy of these numbers, O2-B3). Pure: no React,
 * no call, no area, no portal file (record-frame-core.vitest.test.ts).
 *
 * - From 1280 px the thread is DOCKED on the right: a 3 : 2 grid of the page (gap 16), so 40 % at every width; one third on a
 *   wide grid tab under 1600 px; ⌘J hides and shows it.
 * - Below 1280 px it opens as a full-width view behind the band's button; below 720 px the page is the phone's (PL4).
 */

/** The record frame's catalogue (messages/<locale>/record-frame.json): the band's keys, the Thread button, the one notice. */
export const FRAME_NS = 'record-frame'

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

// ---- F-SA-263 (sales page plan N6, P11; 10-order-page §5): each tab its own default width (replaces the `wide` boolean).
/**
 * A tab's dock width when the person chose none: one width, or `grid` — a wide grid tab (the lines, a BOM, sizes, cost, cutting):
 * one third under 1600 px, 40 % from 1600 (the picture's rule R-18: no sideways scroll on Lines at 1440 with the thread open).
 */
export type DockDefault = DockWidth | 'grid'

/** A tab's default at a viewport: `grid` is one third under 1600 px and 40 % from 1600; any other default is itself. */
export function defaultWidthAt(value: DockDefault, viewport: number): DockWidth {
  if (value === 'grid') return viewport < THIRD_BELOW ? 'third' : 'forty'
  return value
}
// ---- end F-SA-263

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

/** ⌘J (Ctrl J on other systems): show or hide the docked thread, open or close the full-width one. Never with Alt or Shift. */
export function isThreadKey(event: { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j'
}
