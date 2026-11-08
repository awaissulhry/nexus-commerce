/**
 * LineResponseList's rules (B-W2b-155, design part LineResponseList): a partner answers a request LINE BY LINE — a
 * purchase order on its link (links.po) and in the supplier portal (portal.supplier.orders) answer with the same part and
 * the same rules. Lifted from W1's PO link (factory-web links/po-confirm/model.ts) and made domain-free: quantities are
 * text the host parses (`parseQuantity`, its own language), dates are ISO days, every word is the host's (labels).
 *
 *   AS_ASKED     the asked quantity by the asked date (a line with no answer is as asked)
 *   OTHER        another quantity and/or another date, one delivery, with a reason
 *   SPLIT        two deliveries, each a quantity and a date (two different days), with a reason
 *   CANNOT       nothing of the line, with a reason
 *   SUBSTITUTE   another article instead — one the request offers (`substituteId`) and/or their own in words
 *                (`substitute`); optionally another quantity and date; a reason optional
 *   CHANGE       another change in words that needs the requester's yes ("two dye batches"): the words are the reason
 *
 * What the answer comes to (as the domain's): every line as asked → CONFIRMED; every line one they cannot deliver →
 * DECLINED; any other mix → PROPOSED (the requester decides on the changes). Quantities are compared exactly (scaled
 * integers, at most four decimals), never as floats.
 */

export const LINE_ANSWER_KINDS = ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT', 'SUBSTITUTE', 'CHANGE'] as const
export type LineAnswerKind = (typeof LINE_ANSWER_KINDS)[number]

/** The kinds a request allows unless it says otherwise (the PO link's four). */
export const DEFAULT_LINE_KINDS: readonly LineAnswerKind[] = ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT']

/** How an answered line differs from what was asked (the tags beside an answer, the summary's counts). */
export const LINE_CHANGES = ['LATER', 'EARLIER', 'LESS', 'MORE', 'SPLIT', 'CANNOT', 'SUBSTITUTE', 'CHANGE'] as const
export type LineChange = (typeof LINE_CHANGES)[number]

export type LineResponseOutcome = 'CONFIRMED' | 'PROPOSED' | 'DECLINED'

export interface LineDelivery {
  /** As typed, in the host's language. */
  quantity: string
  /** ISO day (`YYYY-MM-DD`), or '' when not given yet. */
  date: string
}

/** One line's answer as the person gives it (quantities as typed; dates ISO). */
export interface LineDraft {
  kind: LineAnswerKind
  /** OTHER, SUBSTITUTE: the other quantity ('' = the asked one). */
  quantity?: string
  /** OTHER, SUBSTITUTE: the other date ('' = the asked one). */
  date?: string
  /** SPLIT: the two deliveries. */
  deliveries?: readonly [LineDelivery, LineDelivery]
  /** SUBSTITUTE: their own article, in their words. */
  substitute?: string
  /** SUBSTITUTE: one of the articles the request offers for the line (`LineRequest.substitutes`). */
  substituteId?: string
  /** Why (OTHER, SPLIT, CANNOT: needed; SUBSTITUTE: optional; CHANGE: the change itself, needed). */
  reason: string
}

/** A line as the request asks it. Every word is written by the host. */
export interface LineRequest {
  id: string
  /** The line's number ("Line 20"); default its place in the list. */
  seq?: number | string
  /** Code · name, as the partner knows it. */
  title: string
  /** Fact lines under the title (colour, grade, thickness, "one dye batch"…). */
  details?: readonly string[]
  /** A note of the requester's on the line. */
  note?: string
  asked: {
    /** The quantity as written ("1.200,5"). */
    quantity: string
    /** The same quantity as a plain decimal ("1200.5") when the host has it; else `quantity` is parsed. */
    plain?: string
    /** The unit, written ("m²", "pieces"). */
    unit: string
    /** The asked day, ISO. */
    date: string
    /** The asked day, written ("3 Dec 2026"). */
    dateText: string
  }
  /** Chips beside the title ("Cr VI report"). */
  tags?: readonly { label: string; tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }[]
  /** SUBSTITUTE: the articles the requester offers instead, if any. */
  substitutes?: readonly { id: string; label: string }[]
  /** The line takes no answer any more (confirmed before): true, or the words to show. */
  locked?: boolean | string
}

export interface LineRules {
  /** The partner's today (ISO): no date before it. */
  today: string
  /** The host's parse of a typed quantity → a plain decimal ("1200.5"), or null when it is no number. */
  parseQuantity?: (text: string) => string | null
  /** The latest date, in days from today. Default 730 (two years, as the PO rules). */
  maxDaysAhead?: number
  /** The most characters of a reason. Default 500. */
  maxReason?: number
  /** The most characters of a substitute's words. Default 2000. */
  maxSubstitute?: number
}

export const LINE_RULE_DEFAULTS = { maxDaysAhead: 730, maxReason: 500, maxSubstitute: 2000 } as const
/** Four decimals at most (Decimal(18,4)): fourteen digits before the point. */
const SCALE = 4
const MAX_INT_DIGITS = 14

// ---- quantities and days --------------------------------------------------------------------------------------------------

/**
 * The default parse: digits with at most one `.` or `,` as the decimal mark, spaces ignored ("1200,5" → "1200.5").
 * A grouped number ("1.200,5") is the host's to parse in its own language: pass `parseQuantity`.
 */
export function plainQuantityDefault(text: string): string | null {
  const t = text.replace(/[\s  ]/g, '')
  if (!/^\d+(?:[.,]\d+)?$/.test(t)) return null
  const [int, frac = ''] = t.replace(',', '.').split('.')
  const i = int.replace(/^0+(?=\d)/, '')
  const f = frac.replace(/0+$/, '')
  return f ? `${i}.${f}` : i
}

/** A plain decimal → integer units at four places; null past four places or fourteen digits. */
export function quantityUnits(plain: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(plain.trim())
  if (!m) return null
  const int = m[1].replace(/^0+(?=\d)/, '')
  const frac = (m[2] ?? '').replace(/0+$/, '')
  if (frac.length > SCALE || int.length > MAX_INT_DIGITS) return null
  return BigInt(int) * 10n ** BigInt(SCALE) + BigInt((frac || '0').padEnd(SCALE, '0'))
}

const parseWith = (rules: Pick<LineRules, 'parseQuantity'>) => rules.parseQuantity ?? plainQuantityDefault

/** The asked quantity in units (its plain form, or the written one parsed); null when the host gave neither readably. */
export function askedUnits(line: LineRequest, rules: Pick<LineRules, 'parseQuantity'> = {}): bigint | null {
  const plain = line.asked.plain ?? parseWith(rules)(line.asked.quantity)
  return plain === null ? null : quantityUnits(plain)
}

/** `day` + days, ISO. */
export function addDaysIso(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const given = (value: string | undefined): boolean => typeof value === 'string' && value.trim() !== ''

// ---- one line's answer ------------------------------------------------------------------------------------------------------

/** A fresh draft of a line for a kind; the fields of `previous` are kept (switching kind loses nothing typed). */
export function lineDraftFor(line: LineRequest, kind: LineAnswerKind, previous?: LineDraft): LineDraft {
  if (previous && previous.kind === kind) return previous
  return {
    kind,
    quantity: previous?.quantity ?? (kind === 'OTHER' ? line.asked.quantity : ''),
    date: previous?.date ?? (kind === 'OTHER' ? line.asked.date : ''),
    deliveries: previous?.deliveries ?? [
      { quantity: '', date: line.asked.date },
      { quantity: '', date: '' },
    ],
    substitute: previous?.substitute ?? '',
    substituteId: previous?.substituteId ?? '',
    reason: previous?.reason ?? '',
  }
}

export type QuantityProblem = 'number' | 'positive'
export type DateProblem = 'missing' | 'past' | 'far'
export type ReasonProblem = 'missing' | 'long'
export type SubstituteProblem = 'missing' | 'long'
export type DeliveryProblems = { quantity?: QuantityProblem; date?: DateProblem }

/** Every problem of a line's answer, by field (empty: it can be saved). */
export interface LineDraftProblems {
  quantity?: QuantityProblem
  date?: DateProblem
  reason?: ReasonProblem
  substitute?: SubstituteProblem
  deliveries?: readonly [DeliveryProblems, DeliveryProblems]
  /** The answer as a whole: OTHER gives neither; OTHER gives what was asked; a SPLIT on one day. */
  whole?: 'nothing' | 'same' | 'sameDay'
}

function quantityProblem(typed: string, rules: LineRules): QuantityProblem | undefined {
  const plain = parseWith(rules)(typed)
  const units = plain === null ? null : quantityUnits(plain)
  if (units === null) return 'number'
  if (units <= 0n) return 'positive'
  return undefined
}

function dateProblem(value: string, rules: LineRules): DateProblem | undefined {
  if (!ISO_DAY.test(value)) return 'missing'
  if (value < rules.today) return 'past'
  if (value > addDaysIso(rules.today, rules.maxDaysAhead ?? LINE_RULE_DEFAULTS.maxDaysAhead)) return 'far'
  return undefined
}

function reasonProblem(value: string, rules: LineRules, required: boolean): ReasonProblem | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return required ? 'missing' : undefined
  if (trimmed.length > (rules.maxReason ?? LINE_RULE_DEFAULTS.maxReason)) return 'long'
  return undefined
}

/** The problems of a draft (the host's Send is held with the same rule: `lineDraftProblems` for every answered line). */
export function lineDraftProblems(line: LineRequest, draft: LineDraft, rules: LineRules): LineDraftProblems {
  const out: LineDraftProblems = {}
  const reason = (required: boolean) => {
    const problem = reasonProblem(draft.reason ?? '', rules, required)
    if (problem) out.reason = problem
  }
  switch (draft.kind) {
    case 'AS_ASKED':
      return out
    case 'CANNOT':
    case 'CHANGE':
      reason(true)
      return out
    case 'OTHER': {
      const quantityGiven = given(draft.quantity)
      const dateGiven = given(draft.date)
      if (!quantityGiven && !dateGiven) out.whole = 'nothing'
      const quantity = quantityGiven ? quantityProblem(draft.quantity!, rules) : undefined
      const date = dateGiven ? dateProblem(draft.date!.trim(), rules) : undefined
      if (quantity) out.quantity = quantity
      if (date) out.date = date
      reason(true)
      if (!out.whole && !quantity && !date) {
        const asked = askedUnits(line, rules)
        const typed = quantityGiven ? quantityUnits(parseWith(rules)(draft.quantity!) ?? '') : asked
        const sameQuantity = typed === asked
        const sameDate = !dateGiven || draft.date!.trim() === line.asked.date
        if (sameQuantity && sameDate) out.whole = 'same'
      }
      return out
    }
    case 'SPLIT': {
      const parts = (draft.deliveries ?? [{ quantity: '', date: '' }, { quantity: '', date: '' }]).map((part) => {
        const problems: DeliveryProblems = {}
        const quantity = quantityProblem(part.quantity, rules)
        const date = dateProblem(part.date.trim(), rules)
        if (quantity) problems.quantity = quantity
        if (date) problems.date = date
        return problems
      }) as unknown as [DeliveryProblems, DeliveryProblems]
      if (parts.some((part) => part.quantity || part.date)) out.deliveries = parts
      else if (draft.deliveries![0].date.trim() === draft.deliveries![1].date.trim()) out.whole = 'sameDay'
      reason(true)
      return out
    }
    case 'SUBSTITUTE': {
      const words = (draft.substitute ?? '').trim()
      if (words === '' && !given(draft.substituteId)) out.substitute = 'missing'
      else if (words.length > (rules.maxSubstitute ?? LINE_RULE_DEFAULTS.maxSubstitute)) out.substitute = 'long'
      if (given(draft.quantity)) {
        const quantity = quantityProblem(draft.quantity!, rules)
        if (quantity) out.quantity = quantity
      }
      if (given(draft.date)) {
        const date = dateProblem(draft.date!.trim(), rules)
        if (date) out.date = date
      }
      reason(false)
      return out
    }
  }
}

export const lineDraftHasProblems = (problems: LineDraftProblems): boolean =>
  Boolean(problems.quantity || problems.date || problems.reason || problems.substitute || problems.whole || problems.deliveries?.some((part) => part.quantity || part.date))

/** The first problem, as the field and its problem (the Save button is held with its words). */
export type LineProblemKey =
  | `whole.${NonNullable<LineDraftProblems['whole']>}`
  | `quantity.${QuantityProblem}`
  | `date.${DateProblem}`
  | `substitute.${SubstituteProblem}`
  | `reason.${ReasonProblem}`

export function firstLineProblem(problems: LineDraftProblems): LineProblemKey | null {
  if (problems.whole) return `whole.${problems.whole}`
  if (problems.substitute) return `substitute.${problems.substitute}`
  if (problems.quantity) return `quantity.${problems.quantity}`
  if (problems.date) return `date.${problems.date}`
  const part = problems.deliveries?.find((entry) => entry.quantity || entry.date)
  if (part?.quantity) return `quantity.${part.quantity}`
  if (part?.date) return `date.${part.date}`
  if (problems.reason) return `reason.${problems.reason}`
  return null
}

/** A saved draft without the fields its kind does not use (what `onAnswer` hands the host); null for as asked. */
export function lineDraftSaved(draft: LineDraft): LineDraft | null {
  const reason = (draft.reason ?? '').trim()
  switch (draft.kind) {
    case 'AS_ASKED':
      return null
    case 'CANNOT':
    case 'CHANGE':
      return { kind: draft.kind, reason }
    case 'OTHER':
      return { kind: 'OTHER', quantity: (draft.quantity ?? '').trim(), date: (draft.date ?? '').trim(), reason }
    case 'SPLIT': {
      const [a, b] = draft.deliveries ?? [{ quantity: '', date: '' }, { quantity: '', date: '' }]
      return { kind: 'SPLIT', deliveries: [{ quantity: a.quantity.trim(), date: a.date.trim() }, { quantity: b.quantity.trim(), date: b.date.trim() }], reason }
    }
    case 'SUBSTITUTE':
      return {
        kind: 'SUBSTITUTE',
        quantity: (draft.quantity ?? '').trim(),
        date: (draft.date ?? '').trim(),
        substitute: (draft.substitute ?? '').trim(),
        substituteId: (draft.substituteId ?? '').trim(),
        reason,
      }
  }
}

// ---- what an answer changes, and the whole answer -----------------------------------------------------------------------

const answered = (draft: LineDraft | undefined): draft is LineDraft => !!draft && draft.kind !== 'AS_ASKED'
const isLocked = (line: LineRequest): boolean => line.locked !== undefined && line.locked !== false

/** How a line's answer differs from what was asked, in the domain's order (empty for as asked). */
export function lineAnswerChanges(line: LineRequest, draft: LineDraft | undefined, rules: Pick<LineRules, 'parseQuantity'> = {}): LineChange[] {
  if (!answered(draft)) return []
  if (draft.kind === 'CANNOT') return ['CANNOT']
  if (draft.kind === 'CHANGE') return ['CHANGE']
  const parse = parseWith(rules)
  const asked = askedUnits(line, rules)
  let units: bigint | null = asked
  let day: string = line.asked.date
  const changes: LineChange[] = []
  if (draft.kind === 'SPLIT') {
    changes.push('SPLIT')
    const parts = draft.deliveries ?? []
    const each = parts.map((part) => quantityUnits(parse(part.quantity) ?? ''))
    units = each.every((n): n is bigint => n !== null) ? each.reduce((sum, n) => sum + n, 0n) : null
    const days = parts.map((part) => part.date.trim()).filter((d) => ISO_DAY.test(d)).sort()
    day = days.length ? days[days.length - 1] : line.asked.date
  } else {
    if (draft.kind === 'SUBSTITUTE') changes.push('SUBSTITUTE')
    if (given(draft.quantity)) units = quantityUnits(parse(draft.quantity!) ?? '')
    if (given(draft.date) && ISO_DAY.test(draft.date!.trim())) day = draft.date!.trim()
  }
  if (day > line.asked.date) changes.push('LATER')
  if (day < line.asked.date) changes.push('EARLIER')
  if (units !== null && asked !== null && units < asked) changes.push('LESS')
  if (units !== null && asked !== null && units > asked) changes.push('MORE')
  return changes
}

/** The whole answer counted: what the review line says before sending. Locked lines are not counted. */
export interface LineResponseCounts {
  lines: number
  asAsked: number
  later: number
  earlier: number
  quantity: number
  split: number
  cannot: number
  substitute: number
  change: number
}

export function lineResponseSummary(
  lines: readonly LineRequest[],
  answers: Readonly<Record<string, LineDraft | undefined>>,
  rules: Pick<LineRules, 'parseQuantity'> = {},
): LineResponseCounts {
  const open = lines.filter((line) => !isLocked(line))
  const counts: LineResponseCounts = { lines: open.length, asAsked: 0, later: 0, earlier: 0, quantity: 0, split: 0, cannot: 0, substitute: 0, change: 0 }
  for (const line of open) {
    const draft = answers[line.id]
    if (!answered(draft)) {
      counts.asAsked++
      continue
    }
    const changes = lineAnswerChanges(line, draft, rules)
    if (draft.kind === 'CANNOT') counts.cannot++
    if (draft.kind === 'SPLIT') counts.split++
    if (draft.kind === 'SUBSTITUTE') counts.substitute++
    if (draft.kind === 'CHANGE') counts.change++
    if (draft.kind !== 'CANNOT' && changes.includes('LATER')) counts.later++
    if (draft.kind !== 'CANNOT' && changes.includes('EARLIER')) counts.earlier++
    if (changes.includes('LESS') || changes.includes('MORE')) counts.quantity++
  }
  return counts
}

/** The review line's parts, each a key of the labels' `summary` with its count, in a fixed order. */
export type LineSummaryKey = 'allAsAsked' | 'asAsked' | 'later' | 'earlier' | 'quantity' | 'split' | 'cannot' | 'substitute' | 'change'

export function lineResponseSummaryParts(counts: LineResponseCounts): { key: LineSummaryKey; count: number }[] {
  const parts: { key: LineSummaryKey; count: number }[] = []
  if (counts.asAsked > 0) parts.push({ key: counts.asAsked === counts.lines ? 'allAsAsked' : 'asAsked', count: counts.asAsked })
  const rest: readonly LineSummaryKey[] = ['later', 'earlier', 'quantity', 'split', 'cannot', 'substitute', 'change']
  for (const key of rest) {
    const count = counts[key as keyof LineResponseCounts]
    if (count > 0) parts.push({ key, count })
  }
  return parts
}

/** What the answer comes to: every open line as asked → CONFIRMED; every one they cannot deliver → DECLINED; else PROPOSED. */
export function lineResponseOutcome(lines: readonly LineRequest[], answers: Readonly<Record<string, LineDraft | undefined>>): LineResponseOutcome {
  const open = lines.filter((line) => !isLocked(line))
  if (open.every((line) => !answered(answers[line.id]))) return 'CONFIRMED'
  if (open.every((line) => answers[line.id]?.kind === 'CANNOT')) return 'DECLINED'
  return 'PROPOSED'
}

/** True when some open line is answered other than as asked ("All as asked" has something to undo). */
export function lineResponseChanged(lines: readonly LineRequest[], answers: Readonly<Record<string, LineDraft | undefined>>): boolean {
  return lines.some((line) => !isLocked(line) && answered(answers[line.id]))
}

/** The line's number for the words: its own `seq`, else its place from 1. */
export const lineSeq = (line: LineRequest, index: number): string => String(line.seq ?? index + 1)
