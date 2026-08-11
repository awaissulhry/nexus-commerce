/**
 * NEG.5 — protected terms and the whitelist audit. NOT BUILT YET.
 *
 * The existing panel, plus the 132 negations that already contradict one of the ten protections,
 * grouped by protected term, each with a marking action so the count converges. An audit that shows
 * 132 forever is one an operator learns to ignore.
 *
 * Until NEG.5 lands, NEG.1 renders the panel exactly as it is today — see the client.
 *
 * Renders null. Hidden, not disabled: the section does not exist, so the page shows nothing rather
 * than a control that cannot work. Its props are already the shared contract, so NEG.5 is one file
 * and one import line — nobody restructures the client.
 */
import type { NegSlotProps } from './slot-contract'

export function NegProtectedTerms(_props: NegSlotProps) {
  return null
}
