/** `IconPicker`'s words (B-W2b-04). English by default; `ariaLabel` still wins over `group`. */
export interface IconPickerLabels {
  /** The radio group's name (when no `ariaLabel` is passed). */
  group: string
  /** The first option: the plain dot. */
  none: string
  /** An icon's name by its id (`TAG_ICONS`: star, heart, flag…); an id not named here keeps its English name. */
  names: Readonly<Record<string, string>>
}

export const ICON_PICKER_LABELS: IconPickerLabels = { group: 'Icon', none: 'No icon', names: {} }
