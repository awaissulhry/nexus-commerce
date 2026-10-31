import { ago, when } from '../grid/renderers/format'

/**
 * `AsOf`'s words (B-W2b-04). English by default. `ago` and `when` write the time once the page is in the browser: the
 * host passes its own for another language ("2 minuti fa", "21 ott 2026, 14:22").
 */
export interface AsOfLabels {
  /** A check that never ran, or a source that is not known. */
  notChecked: string
  /** An event that never happened (`kind="event"`). */
  never: string
  /** "2 minutes ago", from the read's clock when the host passes one. */
  ago: (iso: string, now?: number) => string
  /** The full moment, in the hover title: "21 Oct 2026, 14:22". */
  when: (iso: string) => string
}

export const AS_OF_LABELS: AsOfLabels = {
  notChecked: 'not checked',
  never: 'never',
  ago: (iso, now) => ago(iso, now),
  when: (iso) => when(iso),
}
