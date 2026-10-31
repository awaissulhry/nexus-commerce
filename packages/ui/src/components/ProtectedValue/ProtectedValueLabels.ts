/**
 * `ProtectedValue`'s words (B-W2b-28). English by default; a host passes the words it translates.
 */
export interface ProtectedValueLabels {
  /** What a person without the role sees. */
  restricted: string
  /** Reads the value. */
  show: string
  /** Under Show: the open is recorded. */
  showNote: string
  /** While it reads. */
  opening: string
  /** The mark beside an open value, with the time of this view: "View recorded · 10:42". */
  recordedAt: (time: string) => string
  /** The mark without a time. */
  recorded: string
  /** Forgets the value again. */
  hide: string
  /** The read failed. */
  failed: string
  retry: string
}

export const PROTECTED_VALUE_LABELS: ProtectedValueLabels = {
  restricted: 'Restricted',
  show: 'Show',
  showNote: 'Opening it is recorded',
  opening: 'Opening…',
  recordedAt: (time) => `View recorded · ${time}`,
  recorded: 'View recorded',
  hide: 'Hide',
  failed: 'It could not be opened',
  retry: 'Try again',
}
