/**
 * `DateField`'s words (B-W2b-04). English by default; the props `placeholder`, `clearLabel` and `ariaLabel` still win
 * over these. The month heading and each day's name follow the `locale` prop.
 */
export interface DateFieldLabels {
  /** The seven weekday letters over the month, Sunday first (the grid starts on Sunday). */
  weekdays: readonly string[]
  previousMonth: string
  nextMonth: string
  /** The calendar's name when the field has no `ariaLabel`. */
  pickDate: string
  /** Shown while no date is set (when no `placeholder` is passed). */
  notSet: string
  /** The clear row's words (when no `clearLabel` is passed). */
  clear: string
}

export const DATE_FIELD_LABELS: DateFieldLabels = {
  weekdays: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  pickDate: 'Pick a date',
  notSet: 'not set',
  clear: 'clear',
}
