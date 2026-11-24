/**
 * F-CO-K1 (customer overview lane: the shared overview kit) — what the kit's parts share that is not a look: the name of its own
 * catalogue and the caps of its lists. Pure: no React, no import of any area. A page hands a part data and doors (./Overview.tsx);
 * a cap is the same on every page.
 */

/** The kit's own catalogue: `messages/<locale>/record-overview.json`. */
export const OVERVIEW_NS = 'record-overview'

/** The strips a lead card shows before "Show {n} more". */
export const STRIPS_SHOWN = 4

/** The rows a group shows before its "n more" door. */
export const GROUP_ROWS_SHOWN = 3

/** A strip's tone: the colour of its left rule (the DS tone tokens, light and dark). */
export type StripTone = 'warning' | 'danger' | 'info'
