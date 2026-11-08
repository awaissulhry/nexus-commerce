import type { LimitVerdict, ToleranceVerdict } from './limitMeterModel'

/**
 * `LimitMeter`'s and `ToleranceCell`'s words (B-W2b-78). English by default; a host passes the words it translates. A
 * word with a value in it is a function: the values come written (number and unit) in the page's language.
 */
export interface LimitMeterLabels {
  /** Each verdict in one word, beside its icon. */
  verdicts: Record<LimitVerdict, string>
  /** The tolerance verdicts ("over" and "under" are the cell's word when no deviation is written). */
  tolerance: Record<ToleranceVerdict, string>
  /** "limit 3" (a maximum). */
  limit: (limit: string) => string
  /** "minimum 40" (`atLeast` / `above`). */
  minimum: (limit: string) => string
  /** "< 0.5 mg/kg": a value below the limit of quantification. */
  belowLoq: (loq: string) => string
  /** The LOQ mark's words: "limit of quantification 0.5". */
  loq: (loq: string) => string
  /** "52 ± 0.5" / "52 −0.3 / +0.5". */
  nominal: (nominal: string, minus: string, plus: string, symmetric: boolean) => string
  /** "over by 1.3 cm". */
  overBy: (by: string) => string
  /** "under by 0.6 cm". */
  underBy: (by: string) => string
  /** "1.2 / 3 mg/kg": the cell form of a value against a limit. */
  cellOf: (value: string, limit: string) => string
}

export const LIMIT_METER_LABELS: LimitMeterLabels = {
  verdicts: {
    pass: 'Pass',
    fail: 'Fail',
    belowDetection: 'Below detection',
    inconclusive: 'Not conclusive',
    notMeasured: 'Not measured',
    noLimit: 'No limit set',
  },
  tolerance: { pass: 'In tolerance', over: 'Over', under: 'Under', notMeasured: 'Not measured' },
  limit: (limit) => `limit ${limit}`,
  minimum: (limit) => `minimum ${limit}`,
  belowLoq: (loq) => `< ${loq}`,
  loq: (loq) => `limit of quantification ${loq}`,
  nominal: (nominal, minus, plus, symmetric) => (symmetric ? `${nominal} ± ${plus}` : `${nominal} −${minus} / +${plus}`),
  overBy: (by) => `over by ${by}`,
  underBy: (by) => `under by ${by}`,
  cellOf: (value, limit) => `${value} / ${limit}`,
}
