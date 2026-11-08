import type { LineAnswerKind, LineChange, LineSummaryKey } from './lineResponseListModel'

/**
 * `LineResponseList`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a number
 * or a value in it is a function: the host writes its own plural forms and its own order of the values. Quantities, units
 * and dates reach these functions already written in the page's language.
 */
export interface LineResponseListLabels {
  /** The list's name for a screen reader. */
  list: string
  /** "Line 20". */
  line: (seq: string) => string
  /** The asked value's label. */
  asked: string
  /** The answer's label. */
  yourAnswer: string
  /** "120 m² by 3 Dec 2026". */
  askedValue: (quantity: string, unit: string, date: string) => string
  /** One delivery of a split: "60 m² by 3 Dec 2026". */
  delivery: (quantity: string, unit: string, date: string) => string
  answerAsAsked: string
  /** OTHER: "100 m² by 10 Dec 2026". */
  answerOther: (quantity: string, unit: string, date: string) => string
  /** SPLIT: "Two deliveries: 60 m² by 3 Dec and 60 m² by 17 Dec". */
  answerSplit: (first: string, second: string) => string
  answerCannot: string
  /** SUBSTITUTE: "Instead: Nappa 1.2 mm — 120 m² by 3 Dec 2026". */
  answerSubstitute: (what: string, delivery: string) => string
  answerChange: string
  /** The reason under an answer. */
  reason: (reason: string) => string
  /** A CHANGE's words under it. */
  changeSaid: (words: string) => string
  /** The tags beside an answer, by what it changes. */
  changes: Record<LineChange, string>
  /** A line that takes no answer any more (confirmed before), unless the line gives its own words. */
  locked: string
  change: string
  changeAria: (seq: string) => string
  asAskedAgain: string
  asAskedAgainAria: (seq: string) => string
  /** One tap: every line back to as asked. */
  allAsAsked: string
  /** Why "All as asked" is held. */
  allAsAskedHeld: string
  /** The review line: "Your answer: 3 lines as asked · 1 later date." */
  review: (summary: string) => string
  /** The review line's parts. */
  summary: Record<LineSummaryKey, (count: number) => string>
  /** Between the parts. */
  summaryJoin: string
  // ---- the line's editor (a dialog; a bottom sheet on a phone) ----
  sheetTitle: (seq: string) => string
  /** The kinds' group name. */
  kind: string
  /** Each kind's title. */
  kinds: Record<LineAnswerKind, string>
  /** Each kind's line under its title (as asked shows the asked value). */
  kindHints: Record<Exclude<LineAnswerKind, 'AS_ASKED'>, string>
  /** "Quantity (m²)". */
  quantity: (unit: string) => string
  date: string
  /** A substitute's quantity and date may be left empty. */
  substituteKeep: string
  first: string
  second: string
  /** SUBSTITUTE: one of the articles offered. */
  substituteChoice: string
  /** The choice's empty option. */
  substituteChoiceNone: string
  /** SUBSTITUTE: their own article in words. */
  substitute: string
  substituteHint: string
  reasonField: string
  reasonOptional: string
  /** CHANGE: the change in words. */
  changeField: string
  reasonHint: string
  save: string
  cancel: string
  /** A line's problems, said under its field and on the held Save. */
  problems: {
    nothing: string
    same: string
    sameDay: string
    quantityNumber: string
    quantityPositive: string
    dateMissing: string
    datePast: string
    dateFar: string
    reasonMissing: string
    changeMissing: string
    reasonLong: (max: number) => string
    substituteMissing: string
    substituteLong: (max: number) => string
  }
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const LINE_RESPONSE_LIST_LABELS: LineResponseListLabels = {
  list: 'Lines',
  line: (seq) => `Line ${seq}`,
  asked: 'Asked',
  yourAnswer: 'Your answer',
  askedValue: (quantity, unit, date) => `${quantity} ${unit} by ${date}`,
  delivery: (quantity, unit, date) => `${quantity} ${unit} by ${date}`,
  answerAsAsked: 'As asked',
  answerOther: (quantity, unit, date) => `${quantity} ${unit} by ${date}`,
  answerSplit: (first, second) => `Two deliveries: ${first} and ${second}`,
  answerCannot: 'You cannot deliver it',
  answerSubstitute: (what, delivery) => `Instead: ${what} — ${delivery}`,
  answerChange: 'A change to agree',
  reason: (reason) => `Your reason: ${reason}`,
  changeSaid: (words) => `Your change: ${words}`,
  changes: {
    LATER: 'Later date',
    EARLIER: 'Earlier date',
    LESS: 'Less',
    MORE: 'More',
    SPLIT: 'Two deliveries',
    CANNOT: 'Cannot deliver',
    SUBSTITUTE: 'Substitute',
    CHANGE: 'Change to agree',
  },
  locked: 'Confirmed before: this line takes no new answer',
  change: 'Change',
  changeAria: (seq) => `Change your answer to line ${seq}`,
  asAskedAgain: 'As asked',
  asAskedAgainAria: (seq) => `Line ${seq} as asked again`,
  allAsAsked: 'All as asked',
  allAsAskedHeld: 'Every line is as asked already',
  review: (summary) => `Your answer: ${summary}.`,
  summary: {
    allAsAsked: (count) => (count === 1 ? 'the line as asked' : `all ${count} lines as asked`),
    asAsked: (count) => `${n(count, 'line', 'lines')} as asked`,
    later: (count) => n(count, 'later date', 'later dates'),
    earlier: (count) => n(count, 'earlier date', 'earlier dates'),
    quantity: (count) => n(count, 'other quantity', 'other quantities'),
    split: (count) => `${n(count, 'line', 'lines')} in two deliveries`,
    cannot: (count) => `${n(count, 'line', 'lines')} you cannot deliver`,
    substitute: (count) => n(count, 'substitute', 'substitutes'),
    change: (count) => n(count, 'change to agree', 'changes to agree'),
  },
  summaryJoin: ' · ',
  sheetTitle: (seq) => `Line ${seq} — your answer`,
  kind: 'What can you do?',
  kinds: {
    AS_ASKED: 'As asked',
    OTHER: 'Another date or quantity',
    SPLIT: 'In two deliveries',
    CANNOT: 'I cannot deliver this line',
    SUBSTITUTE: 'Another article instead',
    CHANGE: 'Another change',
  },
  kindHints: {
    OTHER: 'One delivery, at another date, of another quantity, or both.',
    SPLIT: 'Part now, the rest later: each with its quantity and date.',
    CANNOT: 'Nothing of this line. The other lines keep your answer.',
    SUBSTITUTE: 'An article you offer in place of this one.',
    CHANGE: 'Something else to agree, in your words. Quantity and date stay as asked.',
  },
  quantity: (unit) => `Quantity (${unit})`,
  date: 'By',
  substituteKeep: 'Leave the quantity or the date empty to keep the one asked.',
  first: 'First delivery',
  second: 'Second delivery',
  substituteChoice: 'One of the articles offered',
  substituteChoiceNone: 'None of these: I describe my own',
  substitute: 'Your article, in your words',
  substituteHint: 'Code, name and what differs.',
  reasonField: 'Why',
  reasonOptional: 'Why (optional)',
  changeField: 'What would you change?',
  reasonHint: 'A few words for the buyer.',
  save: 'Save',
  cancel: 'Cancel',
  problems: {
    nothing: 'Give another quantity, another date, or both.',
    same: 'That is what was asked: choose “As asked”.',
    sameDay: 'The two deliveries are on two different days.',
    quantityNumber: 'Give the quantity as a number, with at most four decimals.',
    quantityPositive: 'Give a quantity above 0, or choose “I cannot deliver this line”.',
    dateMissing: 'Give the date.',
    datePast: 'Give a date from today on.',
    dateFar: 'Give a date within two years.',
    reasonMissing: 'Say why, in a few words.',
    changeMissing: 'Say what you would change, in a few words.',
    reasonLong: (max) => `At most ${max} characters.`,
    substituteMissing: 'Choose the article you offer instead, or describe your own.',
    substituteLong: (max) => `At most ${max} characters.`,
  },
}
