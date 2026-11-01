/**
 * `FloorNamePicker`'s words (B-W2b-28). English by default; a host passes the words it translates.
 */
export interface FloorNamePickerLabels {
  /** The recent group's heading. */
  recent: string
  /** The letter strip's name for a screen reader. */
  letters: string
  /** A letter's button name: "Names starting with M". */
  jumpTo: (letter: string) => string
  /** A letter with no names, held: "No names start with Q". */
  noneFor: (letter: string) => string
  /** No one to pick. */
  empty: string
}

export const FLOOR_NAME_PICKER_LABELS: FloorNamePickerLabels = {
  recent: 'Worked here recently',
  letters: 'Jump to a letter',
  jumpTo: (letter) => `Names starting with ${letter}`,
  noneFor: (letter) => `No names start with ${letter}`,
  empty: 'No one is set up here yet. Ask the office.',
}
