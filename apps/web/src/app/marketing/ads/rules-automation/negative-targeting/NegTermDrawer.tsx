/**
 * NEG.2 — the term drawer. NOT BUILT YET.
 *
 * Opens on `?focus=<term>`: every negation of that term, with its scope, campaign state and the
 * term's own performance over the window. The drawer is where the term grain earns its keep — the
 * grid can group by term, but the decision "stop blocking this, here" needs the N rows in front of
 * you with their per-row state.
 *
 * Renders null. Hidden, not disabled: the section does not exist, so the page shows nothing rather
 * than a control that cannot work. Its props are already the shared contract, so NEG.2 is one file
 * and one import line — nobody restructures the client.
 */
import type { NegSlotProps } from './slot-contract'

export function NegTermDrawer(_props: NegSlotProps) {
  return null
}
