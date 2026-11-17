/**
 * SplitPane (B-TH-212, threads plan §1 "Where the code goes"; PL2 the reading pane; built in the factory web first, a DS move later
 * on the Owner's word, B-TH-296): a list and the record it opened side by side. Wide screens show both — the list about 35 %, the
 * pane about 65 % (09-design-kit §2: 1440 → ~460 + ~838, 1920 → ~628 + ~1150) — and a narrow one shows one at a time: the list,
 * or the pane with a way back. The docked thread (40 %) comes with B-TH-300. Pure.
 */

/** Below this width the list and the pane take turns (the phone, a narrow tablet). */
export const SPLIT_FROM = 1024

/** The shares of the width, list : pane. */
export const LIST_SHARE = 35
export const PANE_SHARE = 65

export type SplitLayout = 'list' | 'split' | 'pane'

/** What shows at a width: the list alone, both side by side, or the pane alone (narrow, with a way back). */
export function splitLayout(width: number, paneOpen: boolean): SplitLayout {
  if (!paneOpen) return 'list'
  return width >= SPLIT_FROM ? 'split' : 'pane'
}

/** The pane's width at a window width (both sides of the 16 px gap), for the reading pane's own rules (the details column from 1100). */
export function paneWidth(width: number, gap = 16): number {
  if (width < SPLIT_FROM) return width
  return Math.round(((width - gap) * PANE_SHARE) / 100)
}

/** Esc closes the pane from inside it, never while typing or inside a dialog or menu. */
export function escCloses(target: { tagName: string; isContentEditable?: boolean; inDialog: boolean }): boolean {
  if (target.inDialog || target.isContentEditable) return false
  return !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}
