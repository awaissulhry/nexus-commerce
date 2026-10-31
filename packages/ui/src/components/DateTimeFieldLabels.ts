import type { DateFieldLabels } from './DateFieldLabels'

/**
 * `DateTimeField`'s words (B-W2b-04). English by default; `ariaLabel` still names the moment. The date part's own words
 * (weekday letters, month buttons) go in `date`.
 */
export interface DateTimeFieldLabels {
  /** The moment's name when no `ariaLabel` is passed. */
  dateAndTime: string
  /** Said after the name for the date control: "Ends: date, Monday 21 September 2026". */
  date: string
  /** Said after the name for the time list: "Ends: time, 09:00 (Europe/Rome)". */
  time: string
  /** Said while no date or time is chosen. */
  notChosen: string
  /** The date control's empty text. */
  chooseDate: string
  /** The time list's empty text. */
  timePlaceholder: string
  /** The date part's own words, passed to `DateField`. */
  dateField: Partial<DateFieldLabels>
}

export const DATE_TIME_FIELD_LABELS: DateTimeFieldLabels = {
  dateAndTime: 'Date and time',
  date: 'date',
  time: 'time',
  notChosen: 'not chosen',
  chooseDate: 'Choose a date',
  timePlaceholder: 'Time',
  dateField: {},
}
