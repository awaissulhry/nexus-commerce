/**
 * `CodeInput`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a number in it
 * is a function: the host writes its own plural forms.
 */
export interface CodeInputLabels {
  /** The field's label when the page gives none. */
  label: string
  /** Under the field: "6 digits. You can paste the whole code." */
  hint: (length: number) => string
  /** "2 tries left" / "1 try left". */
  triesLeft: (count: number) => string
  /** While the code is checked. */
  checking: string
  /** A new code can be asked for in a while: "You can ask for a new code in 45 s" (`left` is the time left, "45 s"). */
  resendIn: (left: string) => string
  /** The resend button. */
  resend: string
  /** While the new code is being sent. */
  resending: string
  /** After a new code was sent. */
  resent: string
}

export const CODE_INPUT_LABELS: CodeInputLabels = {
  label: 'Code',
  hint: (length) => `${length} digits. You can paste the whole code.`,
  triesLeft: (count) => (count === 1 ? '1 try left' : `${count} tries left`),
  checking: 'Checking the code…',
  resendIn: (left) => `You can ask for a new code in ${left}`,
  resend: 'Send a new code',
  resending: 'Sending a new code…',
  resent: 'A new code is on its way.',
}
