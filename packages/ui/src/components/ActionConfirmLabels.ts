import { REVERSAL_WORDS, type ActionSubject, type ReversalWords } from '../grid/actions/registry'
import type { AsOfLabels } from './AsOfLabels'
import type { ConfirmPhraseFieldLabels } from './ConfirmPhraseFieldLabels'

/**
 * `ActionConfirm`'s words (B-W2b-04): its own headings and buttons. English by default. The impact's words (title,
 * consequences, findings, the confirm label) are the host's already; `impact.confirmLabel` still wins over `confirm`.
 */
export interface ActionConfirmLabels {
  /** The subject's kind before its value ("sku: SKU-1"): the kind's code by default. */
  subject: (kind: ActionSubject['kind']) => string
  cancel: string
  /** The confirm button (when the impact names no `confirmLabel`). */
  confirm: string
  /** Before the check's time: "Checked 2 minutes ago". */
  checked: string
  whatChanges: string
  whatFound: string
  /** Before a finding that could not be checked. */
  notChecked: string
  alsoHappens: string
  continueElsewhere: string
  /** The review table's columns. */
  item: string
  before: string
  after: string
  /** The reversal sentence, by fidelity. */
  reversal: ReversalWords
  /** The dialog's close button. */
  close: string
  /** The words of the check's times, passed to `AsOf`. */
  asOf: Partial<AsOfLabels>
  /** The typed confirmation's words, passed to `ConfirmPhraseField`. */
  confirmPhrase: Partial<ConfirmPhraseFieldLabels>
}

export const ACTION_CONFIRM_LABELS: ActionConfirmLabels = {
  subject: (kind) => kind,
  cancel: 'Cancel',
  confirm: 'Confirm',
  checked: 'Checked',
  whatChanges: 'What this changes',
  whatFound: 'What the check found',
  notChecked: 'Not checked: ',
  alsoHappens: 'This also happens',
  continueElsewhere: 'Continue elsewhere',
  item: 'Item',
  before: 'Before',
  after: 'After',
  reversal: REVERSAL_WORDS,
  close: 'Close',
  asOf: {},
  confirmPhrase: {},
}
