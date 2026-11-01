import type { LegalGateWords, LegalItemState } from './legalGateModel'

/**
 * `LegalGate`'s words (B-W2b-28). English by default; a host passes the words it translates. A word with a number in it
 * is a function: the host writes its own plural forms.
 */
export interface LegalGateLabels extends LegalGateWords {
  /** Each condition's state, said in words beside its icon. */
  states: Record<LegalItemState, string>
  /** "Recorded by Demo Person · 3 Nov 2026". */
  recordedBy: (who: string, when?: string) => string
  /** A condition nobody recorded yet. */
  notRecorded: string
  /** The default words of a condition's link. */
  record: string
  /** "3 of 5 conditions met". */
  summary: (met: number, total: number) => string
  /** The folded line: "On since 1 Dec 2026 · every condition met". */
  onFolded: (since?: string) => string
  /** On, while a condition is not met any more. */
  onButOpen: (count: number) => string
  /** Unfold the conditions. */
  show: string
  /** Fold them again. */
  hide: string
  /** The list's name for a screen reader. */
  list: string
}

export const LEGAL_GATE_LABELS: LegalGateLabels = {
  states: { met: 'Met', missing: 'Missing', expired: 'Expired', unknown: 'Not checked' },
  recordedBy: (who, when) => (when ? `Recorded by ${who} · ${when}` : `Recorded by ${who}`),
  notRecorded: 'Not recorded yet',
  record: 'Record it',
  summary: (met, total) => `${met} of ${total} conditions met`,
  onFolded: (since) => (since ? `On since ${since} · every condition met` : 'On · every condition met'),
  onButOpen: (count) => (count === 1 ? 'On, but 1 condition is no longer met' : `On, but ${count} conditions are no longer met`),
  show: 'Show conditions',
  hide: 'Hide conditions',
  list: 'Conditions',
  held: (count, names) => `${count === 1 ? '1 condition missing' : `${count} conditions missing`}: ${names.join(', ')}`,
  none: 'No conditions are listed for this switch',
}
