/**
 * `ChangeValue`'s words (B-W2b-F41): what it draws beside the values and the sentence a screen reader hears.
 * English by default. `head` is the line's label as said before its values — "Price: " — or "" when it has none.
 */
export interface ChangeValueLabels {
  /** Drawn where the new value would be when the change removes it: "€49.90 → removed". */
  removed: string
  /** Drawn after a value an edit left as it was: "5 unchanged". */
  unchanged: string
  /** A line with no value before or after. */
  noValue: string
  /** After the lines drawn: "+2 more". */
  more: (count: number) => string
  /** When no line is drawn, only a count: "3 changes". */
  changes: (count: number) => string
  /** One line, for a screen reader: "Price: from €49.90 to €44.90". */
  saidChanged: (head: string, from: string, to: string) => string
  /** "Sale price: new value €39.90" */
  saidAdded: (head: string, to: string) => string
  /** "Handling fee: €3.00 removed" */
  saidRemoved: (head: string, from: string) => string
  /** "Stock: unchanged, 5" */
  saidUnchanged: (head: string, to: string) => string
  /** "Note: no value" */
  saidEmpty: (head: string) => string
  /** The lines this surface does not have: "2 more changes". */
  saidMore: (count: number) => string
  /** The lines said, then the ones it does not have: "Price: from €49.90 to €44.90; and 2 more changes". */
  saidAndMore: (lines: string, more: string) => string
  /** Nothing to say. */
  saidNone: string
  /** Between two lines said. */
  saidJoin: string
}

const changeWord = (count: number) => `change${count === 1 ? '' : 's'}`

export const CHANGE_VALUE_LABELS: ChangeValueLabels = {
  removed: 'removed',
  unchanged: 'unchanged',
  noValue: 'no value',
  more: (count) => `+${count} more`,
  changes: (count) => `${count} ${changeWord(count)}`,
  saidChanged: (head, from, to) => `${head}from ${from} to ${to}`,
  saidAdded: (head, to) => `${head}new value ${to}`,
  saidRemoved: (head, from) => `${head}${from} removed`,
  saidUnchanged: (head, to) => `${head}unchanged, ${to}`,
  saidEmpty: (head) => `${head}no value`,
  saidMore: (count) => `${count} more ${changeWord(count)}`,
  saidAndMore: (lines, more) => `${lines}; and ${more}`,
  saidNone: 'No change',
  saidJoin: '; ',
}
