import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'

/**
 * F-OC-101 (order CHANGES tab, 10-design §1–§2; 18-lead-settles L6) — the tab's layout, without a screen.
 *
 * Room, not screen: the tab root is the Production kit's size container (`fw-pt`, view/production/production.css, reused IN PLACE —
 * L6) and every section chooses by the ROOM the tab has (S < 720 · M 720–1279 · L ≥ 1280: production/layout.ts holds the numbers,
 * changes.css the same), so opening or closing the thread dock re-lays the tab at once. Four sections, top to bottom (O1, O2 = A):
 *
 *   Waiting (#waiting)                    what waits for an answer or a step: on us · on {customer} · still to do
 *   Can it still change? (#freeze)        one verdict, the door to the Lines tab, each part
 *   Customer's agreement (#confirmation)  their yes and our confirmation (owb-of6 step 2, design § 5l: BEFORE What changed)
 *   What changed (#history)               the ONE order log (owb-of6), one row per change
 *
 * The older addresses `#still-to-do` and `#work-order-changes` (the two cards that went into Waiting) land on Waiting.
 */

export const CHANGES_SECTIONS = ['waiting', 'freeze', 'confirmation', 'history'] as const
export type ChangesSectionId = (typeof CHANGES_SECTIONS)[number]

/** The addresses of the cards that went into Waiting: each is still an element inside it (the band's "Open" lands on #still-to-do). */
export const WAITING_ALIASES = ['still-to-do', 'work-order-changes'] as const

/**
 * Every time with a day (10-design §2): the day and the time in the site's zone; a time of the same day as `now` (the read's own time)
 * is "today 10:42". `now` absent or not a time: the day is always said.
 */
export function dayTimeOf(at: string, now: string | number | null | undefined, locale: Locale): { readonly today: boolean; readonly date: string; readonly time: string } {
  const date = formatDate(at, { locale })
  const time = formatTime(at, { locale })
  const read = typeof now === 'number' ? now : now ? Date.parse(now) : NaN
  return { today: Number.isFinite(read) && formatDate(read, { locale }) === date, date, time }
}
