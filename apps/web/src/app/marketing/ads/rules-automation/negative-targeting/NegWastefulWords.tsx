/**
 * NEG.6 — wasteful words. NOT BUILT YET.
 *
 * The n-gram surface folded in from `/marketing/advertising/ngrams`, with the winning grams beside
 * it as the safety rail. Of the top 50 wasteful grams, 3 are covered by our 2,059 negatives.
 *
 * Two cautions it must carry: `5xl`/`6xl`/`7xl` are a catalogue gap, not waste; and a gram is not a
 * term — negating `protezioni` as a phrase blocks `giacca moto con protezioni` too.
 *
 * Renders null. Hidden, not disabled: the section does not exist, so the page shows nothing rather
 * than a control that cannot work. Its props are already the shared contract, so NEG.6 is one file
 * and one import line — nobody restructures the client.
 */
import type { NegSlotProps } from './slot-contract'

export function NegWastefulWords(_props: NegSlotProps) {
  return null
}
