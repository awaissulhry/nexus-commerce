import { Decimal } from 'decimal.js'
import { ValidationError, type Issue } from '../../core/errors'
import { fitsDecimal, QUANTITY } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { addDays } from '../../planning/buy'
import { QUANTITY_SCALE } from '../../product/units/units'
import { uomText } from '../document'
import { MAX_TEXT, STATUS_WORDS, type PurchaseOrderStatus } from '../orders'

/**
 * The supplier's answer to a purchase order through its PO_CONFIRM link (B-W1-31; SCM-085, SCM-086; PLAN §4.7 stage
 * 08-buy "supplier confirms by link (no prices on the link)"; design links.po "Confirm a PO", plan-buy-pay "Supplier's
 * answer"; Owner question P2, answer A: the BUYER decides on a supplier's changes), pure:
 *
 *   confirm all as asked   one tap: every line at its quantity and need date → CONFIRMED (channel LINK)
 *   line by line           every line answered once, only exceptions need words:
 *                            AS_ASKED         the asked quantity by the need date
 *                            OTHER            another quantity and/or another date (in the line's purchase unit)
 *                            SPLIT            two deliveries, each a quantity and a date
 *                            CANNOT_DELIVER   nothing of the line
 *                          each exception (OTHER, SPLIT, CANNOT_DELIVER) gives its reason. Every line as asked →
 *                          CONFIRMED; every line CANNOT_DELIVER → DECLINED (with the reasons); anything else is a
 *                          PROPOSAL: it waits for the buyer (accept → CONFIRMED with the proposal as the confirmation;
 *                          refuse → SENT again), so a late leather date never becomes the plan on its own.
 *   decline                a reason (no capacity, material not available, other: then a note) → DECLINED
 *   evidence               the typed name is optional (links/purposes PO_CONFIRM); the server time, the hashed client
 *                          address and the user agent are the link platform's (links/evidence, platform/links useLink).
 *
 * Dates are calendar days from the supplier's today to two years ahead; quantities are decimal strings of at most four
 * places in the line's own unit (ft² or m² for leather, metres, pieces …), never a float.
 */

export const LINE_ANSWERS = ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER'] as const
export type LineAnswerKind = (typeof LINE_ANSWERS)[number]

export const ANSWER_MODES = ['ALL_AS_ASKED', 'BY_LINE'] as const
export type AnswerMode = (typeof ANSWER_MODES)[number]

export const DECLINE_REASONS = ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'OTHER'] as const
export type DeclineReason = (typeof DECLINE_REASONS)[number]

/** What the supplier's answer comes to. */
export const ANSWER_OUTCOMES = ['CONFIRMED', 'PROPOSED', 'DECLINED'] as const
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number]

/** A split is two deliveries (the delivery schedule with more, W2b, is its own tab). */
export const SPLIT_DELIVERIES = 2
/** The latest date an answer may give, in days from the supplier's today. */
export const MAX_DAYS_AHEAD = 730

export const DECLINE_WORDS: Readonly<Record<DeclineReason, string>> = Object.freeze({
  NO_CAPACITY: 'No capacity for this order',
  MATERIAL_NOT_AVAILABLE: 'The material is not available',
  OTHER: 'Another reason',
})

export interface DeliveryInput {
  readonly quantity: string
  readonly date: string
}

export interface LineAnswerInput {
  readonly lineId: string
  readonly answer: LineAnswerKind
  readonly quantity?: string | null | undefined
  readonly date?: string | null | undefined
  readonly deliveries?: readonly DeliveryInput[] | null | undefined
  readonly reason?: string | null | undefined
}

export interface ConfirmInput {
  readonly mode: AnswerMode
  readonly lines?: readonly LineAnswerInput[] | null | undefined
  readonly supplierRef?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A line as the order asks it (what the supplier saw on its link). */
export interface AskedLine {
  readonly id: string
  readonly seq: number
  readonly quantity: string
  readonly uom: string
  readonly needDate: BusinessDate
}

export interface Delivery {
  readonly quantity: string
  /** Null only for a line the supplier cannot deliver. */
  readonly date: BusinessDate | null
}

/** How an answered line differs from what was asked. */
export const LINE_CHANGES = ['LATER', 'EARLIER', 'LESS', 'MORE', 'SPLIT', 'CANNOT_DELIVER'] as const
export type LineChange = (typeof LINE_CHANGES)[number]

export interface AnsweredLine {
  readonly lineId: string
  readonly seq: number
  readonly kind: LineAnswerKind
  readonly asked: { readonly quantity: string; readonly uom: string; readonly needDate: BusinessDate }
  /** What the supplier will deliver: one delivery (as asked, other), two (split), none (cannot deliver). */
  readonly deliveries: readonly Delivery[]
  /** The whole quantity it will deliver, four places ("0.0000" when it cannot). */
  readonly quantity: string
  /** When the line is complete: its (last) delivery's date; null when it cannot deliver. */
  readonly date: BusinessDate | null
  readonly reason: string | null
  readonly changes: readonly LineChange[]
}

export interface AnswerCounts {
  readonly lines: number
  readonly asAsked: number
  readonly laterDate: number
  readonly earlierDate: number
  readonly otherQuantity: number
  readonly split: number
  readonly cannotDeliver: number
}

export interface AnswerPlan {
  readonly outcome: AnswerOutcome
  readonly lines: readonly AnsweredLine[]
  readonly counts: AnswerCounts
  /** "3 lines as asked · 1 later date · 1 split" (the page's review before sending, and the buyer's note). */
  readonly summary: string
  readonly supplierRef: string | null
  readonly note: string | null
  /** The decline's words, when every line is one the supplier cannot deliver. */
  readonly declineReason: string | null
}

const q4 = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const clean = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Why the order cannot be answered now, or null (only a SENT order waits for its supplier's answer). */
export function answerProblem(status: PurchaseOrderStatus | string): string | null {
  switch (status) {
    case 'SENT':
      return null
    case 'CONFIRMED':
      return 'This order is confirmed already: there is nothing more to answer.'
    case 'CHANGES_PROPOSED':
      return 'Your changes are with the buyer: you will hear back by e-mail.'
    case 'DECLINED':
      return 'You declined this order: the buyer changes it or cancels it.'
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
      return 'Goods of this order were received already: it needs no confirmation any more.'
    case 'DRAFT':
      return 'The buyer is changing this order: the changed order comes with a new link.'
    default:
      return `This order is ${STATUS_WORDS[status as PurchaseOrderStatus] ?? String(status).toLowerCase()}: it needs no answer.`
  }
}

/** A quantity the supplier gives: above 0, at most four places (Decimal(18,4)). */
function quantityOf(value: unknown, path: string, issues: Issue[]): Decimal | null {
  if (typeof value !== 'string' || !fitsDecimal(value.trim(), QUANTITY.precision, QUANTITY.scale)) {
    issues.push({ path, message: 'Give the quantity as a number with at most four decimals.' })
    return null
  }
  const quantity = new Decimal(value.trim())
  if (quantity.lte(0)) {
    issues.push({ path, message: 'Give a quantity above 0 (or answer that you cannot deliver the line).' })
    return null
  }
  return quantity
}

/** A date the supplier gives: from its today, at most two years ahead. */
function dateOf(value: unknown, today: BusinessDate, path: string, issues: Issue[]): BusinessDate | null {
  if (!isBusinessDate(value)) {
    issues.push({ path, message: 'Give the date as YYYY-MM-DD.' })
    return null
  }
  if (value < today) {
    issues.push({ path, message: 'Give a date from today on.' })
    return null
  }
  if (value > addDays(today, MAX_DAYS_AHEAD)) {
    issues.push({ path, message: 'Give a date within two years.' })
    return null
  }
  return value
}

function reasonOf(value: string | null | undefined, path: string, issues: Issue[]): string | null {
  const reason = clean(value)
  if (reason === null) issues.push({ path, message: 'Say why (a few words for the buyer).' })
  else if (reason.length > MAX_TEXT.reason) issues.push({ path, message: `At most ${MAX_TEXT.reason} characters.` })
  return reason
}

function changesOf(kind: LineAnswerKind, asked: AskedLine, quantity: Decimal, date: BusinessDate | null): LineChange[] {
  if (kind === 'CANNOT_DELIVER') return ['CANNOT_DELIVER']
  const changes: LineChange[] = []
  if (kind === 'SPLIT') changes.push('SPLIT')
  if (date !== null && date > asked.needDate) changes.push('LATER')
  if (date !== null && date < asked.needDate) changes.push('EARLIER')
  const ordered = new Decimal(asked.quantity)
  if (quantity.lt(ordered)) changes.push('LESS')
  if (quantity.gt(ordered)) changes.push('MORE')
  return changes
}

/** One line's answer, checked; issues are pushed with paths under `path`. */
function answerLine(asked: AskedLine, input: LineAnswerInput, today: BusinessDate, path: string, issues: Issue[]): AnsweredLine | null {
  const before = issues.length
  const askedView = { quantity: q4(new Decimal(asked.quantity)), uom: asked.uom, needDate: asked.needDate }
  const extra = (fields: readonly ('quantity' | 'date' | 'deliveries' | 'reason')[]): void => {
    for (const field of fields) {
      const value = input[field]
      if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) issues.push({ path: `${path}/${field}`, message: `Not part of an answer ${input.answer}.` })
    }
  }
  let deliveries: Delivery[] = []
  let reason: string | null = null
  switch (input.answer) {
    case 'AS_ASKED':
      extra(['quantity', 'date', 'deliveries', 'reason'])
      deliveries = [{ quantity: askedView.quantity, date: asked.needDate }]
      break
    case 'OTHER': {
      extra(['deliveries'])
      const givenQuantity = clean(input.quantity)
      const givenDate = clean(input.date)
      if (givenQuantity === null && givenDate === null) {
        issues.push({ path, message: 'Give the other quantity, the other date, or both.' })
        break
      }
      const quantity = givenQuantity === null ? new Decimal(asked.quantity) : quantityOf(givenQuantity, `${path}/quantity`, issues)
      const date = givenDate === null ? asked.needDate : dateOf(givenDate, today, `${path}/date`, issues)
      reason = reasonOf(input.reason, `${path}/reason`, issues)
      if (quantity && date) {
        if (quantity.eq(new Decimal(asked.quantity)) && date === asked.needDate) issues.push({ path, message: 'That is the quantity and date asked: answer "as asked".' })
        deliveries = [{ quantity: q4(quantity), date }]
      }
      break
    }
    case 'SPLIT': {
      extra(['quantity', 'date'])
      const parts = input.deliveries ?? []
      if (parts.length !== SPLIT_DELIVERIES) {
        issues.push({ path: `${path}/deliveries`, message: `A split is ${SPLIT_DELIVERIES} deliveries, each with its quantity and date.` })
      } else {
        const checked = parts.map((part, index) => ({ quantity: quantityOf(part?.quantity, `${path}/deliveries/${index}/quantity`, issues), date: dateOf(part?.date, today, `${path}/deliveries/${index}/date`, issues) }))
        if (checked.every((part) => part.quantity && part.date)) {
          if (checked[0]!.date === checked[1]!.date) issues.push({ path: `${path}/deliveries/1/date`, message: 'The two deliveries are on two different days.' })
          deliveries = checked.map((part) => ({ quantity: q4(part.quantity!), date: part.date! })).sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0))
        }
      }
      reason = reasonOf(input.reason, `${path}/reason`, issues)
      break
    }
    case 'CANNOT_DELIVER':
      extra(['quantity', 'date', 'deliveries'])
      reason = reasonOf(input.reason, `${path}/reason`, issues)
      break
    default:
      issues.push({ path: `${path}/answer`, message: `Expected one of ${LINE_ANSWERS.join(', ')}.` })
  }
  if (issues.length > before) return null
  const total = deliveries.reduce((sum, part) => sum.plus(part.quantity), new Decimal(0))
  const date = deliveries.length === 0 ? null : deliveries[deliveries.length - 1]!.date
  return { lineId: asked.id, seq: asked.seq, kind: input.answer, asked: askedView, deliveries, quantity: q4(total), date, reason, changes: changesOf(input.answer, asked, total, date) }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** "3 lines as asked · 1 later date · 1 split": what the answer holds, for the review and the buyer's note. */
export function answerSummary(counts: AnswerCounts): string {
  const parts: string[] = []
  if (counts.asAsked > 0) parts.push(counts.asAsked === counts.lines ? (counts.lines === 1 ? 'the line as asked' : `all ${counts.lines} lines as asked`) : `${plural(counts.asAsked, 'line', 'lines')} as asked`)
  if (counts.laterDate > 0) parts.push(plural(counts.laterDate, 'later date', 'later dates'))
  if (counts.earlierDate > 0) parts.push(plural(counts.earlierDate, 'earlier date', 'earlier dates'))
  if (counts.otherQuantity > 0) parts.push(plural(counts.otherQuantity, 'other quantity', 'other quantities'))
  if (counts.split > 0) parts.push(plural(counts.split, 'split', 'splits'))
  if (counts.cannotDeliver > 0) parts.push(`${plural(counts.cannotDeliver, 'line', 'lines')} it cannot deliver`)
  return parts.join(' · ')
}

function countsOf(lines: readonly AnsweredLine[]): AnswerCounts {
  const has = (line: AnsweredLine, change: LineChange): boolean => line.changes.includes(change)
  return {
    lines: lines.length,
    asAsked: lines.filter((line) => line.kind === 'AS_ASKED').length,
    laterDate: lines.filter((line) => line.kind !== 'CANNOT_DELIVER' && has(line, 'LATER')).length,
    earlierDate: lines.filter((line) => line.kind !== 'CANNOT_DELIVER' && has(line, 'EARLIER')).length,
    otherQuantity: lines.filter((line) => has(line, 'LESS') || has(line, 'MORE')).length,
    split: lines.filter((line) => line.kind === 'SPLIT').length,
    cannotDeliver: lines.filter((line) => line.kind === 'CANNOT_DELIVER').length,
  }
}

/** One line of the answer in words (the buyer's note, the decline's reasons). */
export function lineAnswerText(line: AnsweredLine): string {
  const unit = uomText(line.asked.uom)
  const asked = `${plain(line.asked.quantity)} ${unit} by ${line.asked.needDate}`
  const head = `Line ${line.seq}`
  const why = line.reason ? ` Reason: ${line.reason}` : ''
  switch (line.kind) {
    case 'AS_ASKED':
      return `${head}: as asked (${asked}).`
    case 'CANNOT_DELIVER':
      return `${head}: cannot deliver (asked ${asked}).${why}`
    case 'SPLIT':
      return `${head}: in two deliveries, ${line.deliveries.map((part) => `${plain(part.quantity)} ${unit} by ${part.date}`).join(' and ')} (asked ${asked}).${why}`
    case 'OTHER':
      return `${head}: ${plain(line.quantity)} ${unit} by ${line.date} (asked ${asked}).${why}`
  }
}

/** A quantity as people write it: "1200", "12.5". */
const plain = (value: string): string => new Decimal(value).toDecimalPlaces(QUANTITY_SCALE).toString()

/**
 * The supplier's answer, checked against the lines it saw, and what it comes to (see the module comment). A
 * ValidationError names every problem at once (paths `body/lines/<i>/…`, `body/supplierRef`, `body/note`).
 */
export function planAnswer(lines: readonly AskedLine[], input: ConfirmInput, today: BusinessDate): AnswerPlan {
  const issues: Issue[] = []
  const supplierRef = clean(input.supplierRef)
  if (supplierRef !== null && supplierRef.length > MAX_TEXT.code) issues.push({ path: 'body/supplierRef', message: `At most ${MAX_TEXT.code} characters.` })
  const note = clean(input.note)
  if (note !== null && note.length > MAX_TEXT.note) issues.push({ path: 'body/note', message: `At most ${MAX_TEXT.note} characters.` })
  if (lines.length === 0) issues.push({ path: 'body', message: 'The order has no line to answer.' })

  let answered: AnsweredLine[] = []
  if (input.mode === 'ALL_AS_ASKED') {
    if (input.lines && input.lines.length > 0) issues.push({ path: 'body/lines', message: '"Confirm all as asked" takes no lines: answer line by line instead.' })
    answered = lines.map((line) => answerLine(line, { lineId: line.id, answer: 'AS_ASKED' }, today, 'body', issues)!)
  } else if (input.mode === 'BY_LINE') {
    const given = input.lines ?? []
    const byId = new Map(lines.map((line) => [line.id, line]))
    const seen = new Set<string>()
    given.forEach((entry, index) => {
      const path = `body/lines/${index}`
      const asked = byId.get(entry?.lineId)
      if (!asked) issues.push({ path: `${path}/lineId`, message: 'Not a line of this order.' })
      else if (seen.has(asked.id)) issues.push({ path: `${path}/lineId`, message: `Line ${asked.seq} is answered twice.` })
      else {
        seen.add(asked.id)
        const line = answerLine(asked, entry, today, path, issues)
        if (line) answered.push(line)
      }
    })
    for (const line of lines) if (!seen.has(line.id)) issues.push({ path: 'body/lines', message: `Answer line ${line.seq} too.` })
  } else {
    issues.push({ path: 'body/mode', message: `Expected one of ${ANSWER_MODES.join(', ')}.` })
  }
  if (issues.length > 0) throw new ValidationError('The answer is not complete.', issues)

  answered = [...answered].sort((a, b) => a.seq - b.seq)
  const counts = countsOf(answered)
  const outcome = outcomeOf(answered)
  const declineReason = outcome === 'DECLINED' ? [`Cannot deliver any line of the order.`, ...answered.map(lineAnswerText), ...(note ? [`Note: ${note}`] : [])].join('\n') : null
  return { outcome, lines: answered, counts, summary: answerSummary(counts), supplierRef, note, declineReason }
}

/**
 * THE rule of what an answer comes to (P2 answer A, the buyer decides): every line as asked is a confirmation; every
 * line one the supplier cannot deliver is a decline; any other mix is a proposal that waits for the buyer.
 */
export function outcomeOf(lines: readonly Pick<AnsweredLine, 'kind'>[]): AnswerOutcome {
  if (lines.length > 0 && lines.every((line) => line.kind === 'AS_ASKED')) return 'CONFIRMED'
  if (lines.length > 0 && lines.every((line) => line.kind === 'CANNOT_DELIVER')) return 'DECLINED'
  return 'PROPOSED'
}

export interface DeclineInput {
  readonly reason: DeclineReason
  readonly note?: string | null | undefined
}

/** The decline's words as the order keeps them (declineReason): the reason, then the supplier's note. */
export function declineText(input: DeclineInput): string {
  const issues: Issue[] = []
  if (!(DECLINE_REASONS as readonly string[]).includes(input.reason)) issues.push({ path: 'body/reason', message: `Expected one of ${DECLINE_REASONS.join(', ')}.` })
  const note = clean(input.note)
  if (input.reason === 'OTHER' && note === null) issues.push({ path: 'body/note', message: 'Say why you decline the order.' })
  if (note !== null && note.length > MAX_TEXT.note) issues.push({ path: 'body/note', message: `At most ${MAX_TEXT.note} characters.` })
  if (issues.length > 0) throw new ValidationError('The answer is not complete.', issues)
  const words = DECLINE_WORDS[input.reason]
  return note === null ? `${words}.` : `${words}: ${note}`
}
