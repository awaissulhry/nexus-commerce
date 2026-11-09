/**
 * `sizeColumns` and `SizeFill` words (B-W2b-207). English by default; a host passes the words it translates. A word with a
 * size or a number in it is a function; numbers come written in the page's language.
 */
export interface SizeColumnsLabels {
  /** A missing value in a cell (never 0). */
  missing: string
  /** A value not needed for this row (a line that does not depend on size). */
  notNeeded: string
  /** The base size's header: "M · base". */
  baseHeader: (size: string) => string
  /** A header's tooltip: "Size M · cm · base size". */
  headerTooltip: (size: string, unit: string | null, base: boolean) => string
  /** A cell's tooltip: "M: 62.5 cm", "M: missing", "M: 62.5 cm · typed by hand". */
  cellTooltip: (size: string, value: string | null, unit: string | null, typed: boolean) => string
  /** The column group's name: "Per size (cm)". */
  group: (unit: string | null) => string
  /** A text that is not a number (the value was kept). */
  notNumber: (size: string, text: string) => string
  /** SizeFill: its heading. */
  fillTitle: string
  /** SizeFill: the base and its value: "Base M: 62.5 cm". */
  fillBase: (size: string, value: string) => string
  /** SizeFill: the increment field. */
  fillIncrement: string
  /** SizeFill: the increment's hint. */
  fillIncrementHint: string
  /** SizeFill: keep the values typed by hand ("Keep 2 values typed by hand"). */
  fillKeep: (count: number) => string
  /** SizeFill: the preview's name and its count ("3 values change"). */
  fillChanges: (count: number) => string
  /** SizeFill: one change, for a screen reader and the chip: "S: 60.5 → 61.5", "S: missing → 61.5". */
  fillChange: (size: string, from: string | null, to: string) => string
  /** SizeFill: Apply. */
  fillApply: string
  /** SizeFill: Cancel. */
  fillCancel: string
  /** SizeFill held: no base size is set. */
  fillNoBase: string
  /** SizeFill held: the base size has no value. */
  fillBaseMissing: (size: string) => string
  /** SizeFill held: the increment is not a number. */
  fillNotNumber: string
  /** SizeFill held: no increment typed yet. */
  fillNoIncrement: string
  /** SizeFill held: a size would be 0 or below. */
  fillBelowZero: (size: string) => string
  /** SizeFill held: nothing would change. */
  fillNothing: string
}

export const SIZE_COLUMNS_LABELS: SizeColumnsLabels = {
  missing: '— missing',
  notNeeded: '—',
  baseHeader: (size) => `${size} · base`,
  headerTooltip: (size, unit, base) => [`Size ${size}`, unit, base ? 'base size' : null].filter(Boolean).join(' · '),
  cellTooltip: (size, value, unit, typed) => `${size}: ${value === null ? 'missing' : [value, unit].filter(Boolean).join(' ')}${typed ? ' · typed by hand' : ''}`,
  group: (unit) => (unit ? `Per size (${unit})` : 'Per size'),
  notNumber: (size, text) => `${size}: “${text}” is not a number — the value was kept.`,
  fillTitle: 'Fill from the base size',
  fillBase: (size, value) => `Base ${size}: ${value}`,
  fillIncrement: 'Increment per size step',
  fillIncrementHint: 'Smaller sizes go down by it, bigger sizes up. A negative increment turns it round.',
  fillKeep: (count) => (count === 1 ? 'Keep the value typed by hand' : `Keep the ${count} values typed by hand`),
  fillChanges: (count) => (count === 1 ? '1 value changes' : `${count} values change`),
  fillChange: (size, from, to) => `${size}: ${from ?? 'missing'} → ${to}`,
  fillApply: 'Fill',
  fillCancel: 'Cancel',
  fillNoBase: 'Set a base size first.',
  fillBaseMissing: (size) => `Enter the value of the base size ${size} first.`,
  fillNotNumber: 'The increment is not a number.',
  fillNoIncrement: 'Type the increment first.',
  fillBelowZero: (size) => `Size ${size} would be 0 or less: use a smaller increment.`,
  fillNothing: 'Nothing would change.',
}
