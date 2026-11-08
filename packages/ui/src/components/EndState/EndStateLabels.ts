/**
 * `EndState`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a value in it
 * is a function. The headline, the body, the next steps and the facts are the page's own words.
 */
export interface EndStateLabels {
  /** The heading of the next steps. */
  next: string
  /** The heading of the receipt (the facts). */
  receipt: string
  /** The reference's label when the page gives none. */
  reference: string
  /** The copy button's name: "Copy reference R-2026-0031". */
  copyReference: (value: string) => string
  /** Said after a copy. */
  copied: string
  /** The browser refused the clipboard. */
  copyFailed: string
  /** The download of your copy when the page gives no words: "Download your copy". */
  yourCopy: string
  /** With the file's name: "Download your copy (Q-2026-0042.pdf)". */
  yourCopyNamed: (file: string) => string
  /** The contact block's heading. */
  contact: string
  /** The e-mail link's name: "E-mail Anna Rossi". */
  emailTo: (name: string) => string
  /** The phone link's name: "Call Anna Rossi". */
  callTo: (name: string) => string
  /** A busy action, held: "Working…". */
  busy: string
}

export const END_STATE_LABELS: EndStateLabels = {
  next: 'What happens next',
  receipt: 'Your receipt',
  reference: 'Reference',
  copyReference: (value) => `Copy reference ${value}`,
  copied: 'Copied',
  copyFailed: 'Could not copy: select it and copy it by hand',
  yourCopy: 'Download your copy',
  yourCopyNamed: (file) => `Download your copy (${file})`,
  contact: 'Questions?',
  emailTo: (name) => `E-mail ${name}`,
  callTo: (name) => `Call ${name}`,
  busy: 'Working…',
}
