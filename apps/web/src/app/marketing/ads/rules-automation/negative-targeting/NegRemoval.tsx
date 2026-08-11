/**
 * NEG.3 — the retirement path. NOT BUILT YET.
 *
 * Remove one, and bulk-remove by term, with per-row outcomes.
 *
 * 🔴 Blocked on one fix that must land FIRST: `updateTarget` routes an AD_TARGET write by `kind`
 * alone, so archiving a negative keyword would `PUT /sp/keywords` with an id that lives under
 * `/sp/negativeKeywords`, Amazon would answer `entityNotFoundError`, the worker would set
 * `orphanedAt`, and the row would be live at Amazon, dead here, and permanently unwritable.
 * Route by `(kind, isNegative, negativeLevel)` before shipping any removal.
 *
 * And archive is terminal: "remove" is archive-at-Amazon plus a retirement record, never a toggle.
 *
 * Renders null. Hidden, not disabled: the section does not exist, so the page shows nothing rather
 * than a control that cannot work. Its props are already the shared contract, so NEG.3 is one file
 * and one import line — nobody restructures the client.
 */
import type { NegSlotProps } from './slot-contract'

export function NegRemoval(_props: NegSlotProps) {
  return null
}
