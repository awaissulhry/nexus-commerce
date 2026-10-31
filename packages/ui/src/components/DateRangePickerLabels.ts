/**
 * `DateRangePicker`'s words (B-W2b-04). English by default. `locale` writes the button's dates and the month headings;
 * `presets` renames the preset rail by each preset's own label ("Today" → "Oggi"), for the default rail or the host's.
 */
export interface DateRangePickerLabels {
  /** BCP-47 locale for the button's dates and the month headings. */
  locale: string
  /** The seven weekday letters over each month, Sunday first (the grid starts on Sunday). */
  weekdays: readonly string[]
  previousMonth: string
  nextMonth: string
  /** A preset's shown words, by its `label`; a preset not named here shows its own label. */
  presets: Readonly<Record<string, string>>
}

export const DATE_RANGE_PICKER_LABELS: DateRangePickerLabels = {
  locale: 'en-GB',
  weekdays: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  presets: {},
}
