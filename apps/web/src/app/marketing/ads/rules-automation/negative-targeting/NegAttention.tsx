/**
 * NEG.4 — conflicts, suppressed earners and split-brain. NOT BUILT YET.
 *
 * Three lists, each a count that can reach zero: live conflicts, suppressed earners, and the
 * negations Amazon has never confirmed.
 *
 * 🔴 The three-numbers law. `negated in` / `runs in` / `overlap` are three separate columns and are
 * never collapsed into one conflict figure. A term-grain alert is wrong 92% of the time on this
 * account: of twelve converting-but-negated terms, ONE has a live ad-group overlap.
 *
 * Renders null. Hidden, not disabled: the section does not exist, so the page shows nothing rather
 * than a control that cannot work. Its props are already the shared contract, so NEG.4 is one file
 * and one import line — nobody restructures the client.
 */
import type { NegSlotProps } from './slot-contract'

export function NegAttention(_props: NegSlotProps) {
  return null
}
