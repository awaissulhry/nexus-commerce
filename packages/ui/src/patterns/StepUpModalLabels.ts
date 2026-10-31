/** `StepUpModal`'s words (B-W2b-04). English by default; `confirmLabel` still wins over `confirm`. */
export interface StepUpModalLabels {
  cancel: string
  /** The confirm button (when no `confirmLabel` is passed). */
  confirm: string
  /** The confirm button while the code is checked. */
  checking: string
  /** The code field's label. */
  code: string
  /** The line under the code field. */
  codeHint: string
  /** The dialog's close button. */
  close: string
}

export const STEP_UP_MODAL_LABELS: StepUpModalLabels = {
  cancel: 'Cancel',
  confirm: 'Confirm',
  checking: 'Checking…',
  code: 'Two-factor code',
  codeHint: 'The 6-digit code from your authenticator app.',
  close: 'Close',
}
