/**
 * F-PT-101 (order PRODUCTION tab, 10-design §1–§2, 18-lead-settles L2, L10) — the tab's kit, without a screen.
 *
 * Room, not screen: the tab root is a CSS size container (`container: pt / inline-size`, production.css) and every section chooses by
 * the ROOM the tab has, never by the viewport — opening or closing the thread dock re-lays the tab at once, no reload:
 *
 *   S  < 720 px        375 → 343 (a phone)                       every section stacked; rows become row cards
 *   M  720 … 1279 px   1440 dock open 865 · 1920 dock open 1067  Production now 2 columns + people · Work orders 5 columns
 *   L  ≥ 1280 px       1440 dock closed 1314 · 1920 closed 1794  Production now 3 columns · Work orders 7 columns
 *
 * Two short sections share a row from 900 px (Problems & holds | What we make it to); Materials, Production now, Work orders and Dates &
 * plan always take the full row (L10). The CSS holds the same numbers (a test pins them equal); this file is what the tests read.
 */

export const ROOMS = ['S', 'M', 'L'] as const
export type Room = (typeof ROOMS)[number]

/** The room's lower edges (px): M from 720, L from 1280. */
export const ROOM_M = 720
export const ROOM_L = 1280
/** Two short sections side by side from this room (L10). */
export const PAIR_FROM = 900

/** The room a tab width is (S < 720 · M 720–1279 · L ≥ 1280). */
export function roomOf(width: number): Room {
  if (width >= ROOM_L) return 'L'
  if (width >= ROOM_M) return 'M'
  return 'S'
}

/** Whether two short sections share a row at this tab width (L10: from 900 px; Materials never pairs). */
export const pairsAt = (width: number): boolean => width >= PAIR_FROM

/** The tab's sections, top to bottom, each with its address (`#now` …) — the order the layout draws them in. */
export const SECTIONS = ['now', 'work-orders', 'dates', 'holds', 'specs', 'materials'] as const
export type SectionId = (typeof SECTIONS)[number]

/** Full-row sections (L10); the others are short and pair from PAIR_FROM. */
export const FULL_ROW: readonly SectionId[] = Object.freeze(['now', 'work-orders', 'dates', 'materials'])

/** L2: "Counts as of hh:mm" only on these sections (the minute the piece counts were taken: the read's `asOf`). */
export const COUNTS_AS_OF: readonly SectionId[] = Object.freeze(['now', 'work-orders'])

/** A section's head: at most three visible buttons; the rest go into its ⋯. */
export const HEAD_BUTTONS_MAX = 3

/** The buttons a head shows and the ones it moves into its ⋯ (in their order). */
export function headButtonsOf<T>(buttons: readonly T[]): { readonly shown: readonly T[]; readonly more: readonly T[] } {
  return { shown: buttons.slice(0, HEAD_BUTTONS_MAX), more: buttons.slice(HEAD_BUTTONS_MAX) }
}

/** A part of a section as the kit draws it: reading (skeleton rows), failed (PartState + Try again), withheld (one line), empty, shown. */
export type PartFace = 'reading' | 'failed' | 'withheld' | 'empty' | 'shown'

/**
 * The face of one part: a failed read says so (with its own Try again) and the rest of the tab still draws; a part the reader may not
 * read is one line of words, never an empty list that looks like "none"; read and empty is one quiet line.
 */
export function partFaceOf(input: { readonly loading: boolean; readonly problem: string | null; readonly withheld: boolean; readonly count: number | null }): PartFace {
  if (input.problem) return 'failed'
  if (input.withheld) return 'withheld'
  if (input.loading || input.count === null) return 'reading'
  return input.count === 0 ? 'empty' : 'shown'
}
