/**
 * NEG.7 — the seven rules. NOT BUILT YET.
 *
 * `RuleListTab liveType="negative-targeting"`, each row showing its graduation ceiling and whether
 * `protectConverting` is on — which, since NEG.0, is a property with a reader.
 *
 * Until NEG.7 lands, NEG.1 renders the rule list exactly as the tab did — see the client.
 *
 * Renders null. Hidden, not disabled: the section does not exist, so the page shows nothing rather
 * than a control that cannot work. Its props are already the shared contract, so NEG.7 is one file
 * and one import line — nobody restructures the client.
 */
import type { NegSlotProps } from './slot-contract'

export function NegRules(_props: NegSlotProps) {
  return null
}
