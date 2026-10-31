/**
 * `PinSignBlock`'s words (B-W2b-28, D22). English by default; a host passes the words it translates.
 */
export interface PinSignBlockLabels {
  /** The meaning's heading. */
  meaningTitle: string
  /** The signer line: "Signing as Maria Rossi". */
  signingAs: (name: string) => string
  /** Goes back to pick another person. */
  notYou: string
  /** What is recorded with the signature. */
  records: string
  /** The pad's name. */
  pin: string
  /** How many digits are typed: "3 of 6". Never the digits. */
  entered: (entered: number, total: number) => string
  clear: string
  back: string
  /** While the PIN is checked. */
  busy: string
  cancel: string
}

export const PIN_SIGN_BLOCK_LABELS: PinSignBlockLabels = {
  meaningTitle: 'What signing means',
  signingAs: (name) => `Signing as ${name}`,
  notYou: 'Not you?',
  records: 'Your name, the time and this tablet are recorded with what you sign.',
  pin: 'Sign with your PIN',
  entered: (entered, total) => `${entered} of ${total}`,
  clear: 'Clear',
  back: 'Back',
  busy: 'Checking…',
  cancel: 'Cancel',
}
