/**
 * The load of one lane in one time bucket, in standard minutes: what is booked against what is available (gap D18,
 * LoadBar). Pure, so the board, its list fallback and the tests read one rule.
 *
 * - available `undefined`  → not known: "—", never 0 (the honesty rule: unknown is not zero).
 * - available `null`       → no working time set (no calendar for the lane).
 * - available `0`          → no working time in the bucket (closed); anything booked there is all over.
 * - booked > available     → over: the minutes over are SAID ("+640 min over"), never shown by colour only.
 *
 * The percent is a whole number and never lies at the edges: under capacity it stays ≤ 99 (99.6 % is not "full"), over
 * it is ≥ 101, and exactly at capacity it is 100.
 */

export type LoadState = 'ok' | 'full' | 'over' | 'none' | 'closed' | 'unknown'

export interface LoadInput {
  /** Standard minutes booked (standard minutes × pieces). */
  booked: number
  /** Standard minutes available (people × working minutes × efficiency); null = no working time set; undefined = not known. */
  available: number | null | undefined
}

export interface LoadFigures {
  state: LoadState
  /** Whole percent of the capacity, null when there is no capacity to divide by. */
  pct: number | null
  /** Minutes over the capacity (0 when not over). */
  over: number
  /** Where the capacity ends on the bar, 0–100 (100 unless over). */
  capacityAt: number
  /** Where the booked minutes end on the bar, 0–100. */
  bookedAt: number
}

export interface LoadBarWords {
  /** `{booked}` and `{available}` are formatted minutes. */
  minutes: string
  percent: string
  over: string
  /** No working time set for the lane (no calendar). */
  none: string
  /** No working time in this bucket (a closed day). */
  closed: string
  /** The capacity is not known yet. */
  unknown: string
  /** Minutes booked where there is no capacity to compare with. */
  booked: string
  /** Said with a preview: the load after the move being made. */
  after: string
  /** The whole sentence a screen reader hears. `{label}` is whose load it is. */
  sentence: string
  sentenceOver: string
  sentenceNone: string
  sentenceClosed: string
  sentenceUnknown: string
  /** The preview sentence: the load after the move, then the load now. */
  sentenceAfter: string
}

export const LOAD_BAR_WORDS: LoadBarWords = {
  minutes: '{booked} / {available} min',
  percent: '{pct}%',
  over: '+{over} min over',
  none: 'No working time set',
  closed: 'No working time',
  unknown: 'Load not known',
  booked: '{booked} min booked',
  after: 'after the move',
  sentence: '{label}: {booked} of {available} min booked, {pct}%.',
  sentenceOver: '{label}: {booked} of {available} min booked, {pct}%, {over} min over capacity.',
  sentenceNone: '{label}: no working time set, {booked} min booked.',
  sentenceClosed: '{label}: no working time, {booked} min booked.',
  sentenceUnknown: '{label}: load not known.',
  sentenceAfter: 'After the move, {after} Now {now}',
}

/** `{name}` placeholders filled from `vars`; an unknown name stays as written. */
export function fillWords(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

export function loadFigures({ booked, available }: LoadInput): LoadFigures {
  const used = Number.isFinite(booked) && booked > 0 ? booked : 0
  if (available === undefined || (available !== null && !Number.isFinite(available))) {
    return { state: 'unknown', pct: null, over: 0, capacityAt: 100, bookedAt: 0 }
  }
  if (available === null) return { state: 'none', pct: null, over: 0, capacityAt: 100, bookedAt: 0 }
  if (available <= 0) {
    return used > 0 ? { state: 'over', pct: null, over: used, capacityAt: 0, bookedAt: 100 } : { state: 'closed', pct: null, over: 0, capacityAt: 100, bookedAt: 0 }
  }
  const raw = (used / available) * 100
  if (used > available) {
    return { state: 'over', pct: Math.max(101, Math.round(raw)), over: used - available, capacityAt: (available / used) * 100, bookedAt: 100 }
  }
  if (used === available) return { state: 'full', pct: 100, over: 0, capacityAt: 100, bookedAt: 100 }
  const pct = used === 0 ? 0 : Math.min(99, Math.max(1, Math.round(raw)))
  return { state: 'ok', pct, over: 0, capacityAt: 100, bookedAt: raw }
}

export interface LoadView extends LoadFigures {
  /** The big figure: "81%", "122%", or "—" when there is no percent. */
  value: string
  /** The minutes line: "2,340 / 2,880 min", or the words for no capacity. */
  minutes: string
  /** "+640 min over", or null when not over. */
  overText: string | null
  /** The sentence a screen reader hears (starts with the label when there is one). */
  sentence: string
}

/** The number format the load uses: whole minutes, one decimal at most, in the page's language. */
export function minutesFormatter(locale = 'en-GB'): (minutes: number) => string {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  return (minutes) => format.format(minutes)
}

export function loadView(input: LoadInput, words: LoadBarWords = LOAD_BAR_WORDS, format: (minutes: number) => string = minutesFormatter(), label = ''): LoadView {
  const figures = loadFigures(input)
  const booked = format(Number.isFinite(input.booked) && input.booked > 0 ? input.booked : 0)
  const available = typeof input.available === 'number' && Number.isFinite(input.available) ? format(Math.max(0, input.available)) : ''
  const vars = { label, booked, available, pct: figures.pct ?? '', over: format(figures.over) }
  // Without a label the sentence starts at its first fact: "{label}: no working time set" → "No working time set".
  const tidy = (text: string) => (label ? text : text.replace(/^\{label\}:\s*/, ''))
  const sentenceOf = (template: string) => {
    const text = fillWords(tidy(template), vars)
    return label ? text : text.charAt(0).toUpperCase() + text.slice(1)
  }
  switch (figures.state) {
    case 'unknown':
      return { ...figures, value: '—', minutes: words.unknown, overText: null, sentence: sentenceOf(words.sentenceUnknown) }
    case 'none':
      return { ...figures, value: '—', minutes: input.booked > 0 ? `${words.none} · ${fillWords(words.booked, vars)}` : words.none, overText: null, sentence: sentenceOf(words.sentenceNone) }
    case 'closed':
      return { ...figures, value: '—', minutes: words.closed, overText: null, sentence: sentenceOf(words.sentenceClosed) }
    case 'over':
      if (figures.pct === null) {
        // Booked on a bucket with no working time: all of it is over.
        return { ...figures, value: '—', minutes: `${words.closed} · ${fillWords(words.booked, vars)}`, overText: fillWords(words.over, vars), sentence: sentenceOf(words.sentenceClosed) }
      }
      return { ...figures, value: fillWords(words.percent, vars), minutes: fillWords(words.minutes, vars), overText: fillWords(words.over, vars), sentence: sentenceOf(words.sentenceOver) }
    default:
      return { ...figures, value: fillWords(words.percent, vars), minutes: fillWords(words.minutes, vars), overText: null, sentence: sentenceOf(words.sentence) }
  }
}

/** The preview sentence: the load after the move, then the load now ("After the move, … Now …"). */
export function loadAfterSentence(now: LoadView, after: LoadView, words: LoadBarWords = LOAD_BAR_WORDS): string {
  return fillWords(words.sentenceAfter, { after: after.sentence, now: now.sentence })
}
