/** `ColorSwatchPicker`'s words (B-W2b-04). English by default; `ariaLabel` still wins over `group`. */
export interface ColorSwatchPickerLabels {
  /** The radio group's name (when no `ariaLabel` is passed). */
  group: string
  /** A swatch's name by its English name (`SWATCHES`: Blue, Green, Emerald…); one not named here keeps it. */
  names: Readonly<Record<string, string>>
}

export const COLOR_SWATCH_PICKER_LABELS: ColorSwatchPickerLabels = { group: 'Colour', names: {} }
