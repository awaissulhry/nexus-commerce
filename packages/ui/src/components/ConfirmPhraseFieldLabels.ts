import { createElement, Fragment, type ReactNode } from 'react'
import type { PhraseMatchState } from './ConfirmPhraseField'

/** `ConfirmPhraseField`'s words (B-W2b-04). English by default; the `label` prop still wins over `typeToConfirm`. */
export interface ConfirmPhraseFieldLabels {
  /** The label around the phrase (passed in already bold): "Type **SKU-1** exactly to confirm". */
  typeToConfirm: (phrase: ReactNode) => ReactNode
  /** The line under the field, by where the typing stands. */
  states: Readonly<Record<PhraseMatchState, string>>
}

export const CONFIRM_PHRASE_FIELD_LABELS: ConfirmPhraseFieldLabels = {
  typeToConfirm: (phrase) => createElement(Fragment, null, 'Type ', phrase, ' exactly to confirm'),
  states: {
    empty: 'Capital letters and spaces count.',
    partial: 'Keep typing.',
    mismatch: 'Does not match. Capital letters and spaces count.',
    match: 'Matches.',
  },
}
