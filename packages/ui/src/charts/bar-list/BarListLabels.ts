/**
 * `BarList`'s words (B-W2b-09). English by default; a host passes the words it translates. Values come in already
 * written by the list's `format` (or each bar's `valueText`).
 */
export interface BarListLabels {
  /** The name column's header (read by a screen reader). */
  name: string
  /** The value column's header. */
  value: string
  /** A value not known. */
  unknown: string
  /** The parts of a stacked bar, after its value: "0–30 days: €8,000; 31–60 days: €4,400". */
  parts: (parts: ReadonlyArray<{ label: string; value: string }>) => string
  /** A drill-down button's name: "Show Rossi Moto: 18.2 %". */
  pick: (label: string, value: string) => string
  /** No bars. */
  empty: string
}

export const BAR_LIST_LABELS: BarListLabels = {
  name: 'Name',
  value: 'Value',
  unknown: '—',
  parts: (parts) => parts.map((part) => `${part.label}: ${part.value}`).join('; '),
  pick: (label, value) => `Show ${label}: ${value}`,
  empty: 'Nothing to show',
}
