import { Decimal } from 'decimal.js'
import { ValidationError, type Issue } from '../../core/errors'
import { isUuid } from '../../core/ids'
import { fitsDecimal, QUANTITY } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { addDays } from '../../planning/buy'
import { QUANTITY_SCALE } from '../../product/units/units'
import {
  answerSummary,
  DECLINE_WORDS,
  lineAnswerText,
  MAX_DAYS_AHEAD,
  planAnswer,
  type AnsweredLine,
  type AnswerOutcome,
  type AskedLine,
  type Delivery,
  type DeliveryInput,
  type LineChange,
} from '../confirm/answer'
import { proposalColumnsOf } from '../confirm/proposal'
import { uomText } from '../document'
import { MAX_TEXT } from '../orders'

/**
 * The supplier's answer to a purchase order in the portal (B-W2b-174; SCM-085 confirm, SCM-086 "Supplier proposes a
 * change"; design portal.supplier.orders › Confirm or propose "Your answer", pop-up "Answer line 20"; Owner answer P2: the
 * BUYER decides on every change), pure. It builds on W1's link answer (purchasing/confirm/answer: the same four line
 * answers, checked the same way, line by line) and adds the two W2b ones:
 *
 *   AS_ASKED         the asked quantity by the need date
 *   OTHER            another quantity and/or another date (W1)
 *   SPLIT            two deliveries (W1)
 *   CANNOT_DELIVER   nothing of the line, with the reason (W1)
 *   SUBSTITUTE       another article instead: one of ours the API offers (`substituteItemId`, from `choices`) and/or the
 *                    supplier's own in its words (`substituteNote`); optionally another quantity and date; a reason optional
 *   CHANGE           another change in words that needs the buyer's yes ("two dye batches", "packed in rolls"): the words
 *                    are the reason; the quantity and date stay as asked
 *
 * What it comes to (design "Lines answered 'as asked' are confirmed at once; changes wait for the buyer: status 'Change
 * proposed'"): every answered line as asked → CONFIRMED; every line one the supplier cannot deliver (and none confirmed
 * before) → DECLINED; any other mix → PROPOSED: the lines as asked are confirmed at once (`confirmNow`), every other line
 * waits for the buyer's yes (`needsBuyer`). Lines confirmed by an earlier answer (`confirmed`) are locked ("after
 * confirmation the lines are locked") and are not answered again.
 *
 * Quantities are decimal strings of at most four places in the line's own unit, dates calendar days from the supplier's
 * today to two years ahead, as W1's. Every problem is named at once (paths `body/lines/<i>/…`).
 */

export const PORTAL_LINE_ANSWERS = ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER', 'SUBSTITUTE', 'CHANGE'] as const
export type PortalLineAnswerKind = (typeof PORTAL_LINE_ANSWERS)[number]
const LINK_KINDS = new Set<string>(['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER'])

export const PORTAL_ANSWER_MODES = ['ALL_AS_ASKED', 'BY_LINE'] as const
export type PortalAnswerMode = (typeof PORTAL_ANSWER_MODES)[number]

/** The design's decline reasons ("no capacity, material not available, price, other"); price talk itself is the thread's. */
export const PORTAL_DECLINE_REASONS = ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'PRICE', 'OTHER'] as const
export type PortalDeclineReason = (typeof PORTAL_DECLINE_REASONS)[number]
export const PORTAL_DECLINE_WORDS: Readonly<Record<PortalDeclineReason, string>> = Object.freeze({ ...DECLINE_WORDS, PRICE: 'The price does not work for us' })

/** The database's limit on the supplier's words for a substitute. */
export const MAX_SUBSTITUTE_NOTE = 2000

export interface PortalLineAnswerInput {
  readonly lineId: string
  readonly answer: PortalLineAnswerKind
  readonly quantity?: string | null | undefined
  readonly date?: string | null | undefined
  readonly deliveries?: readonly DeliveryInput[] | null | undefined
  readonly reason?: string | null | undefined
  readonly substituteItemId?: string | null | undefined
  readonly substituteNote?: string | null | undefined
}

export interface PortalAnswerInput {
  readonly mode: PortalAnswerMode
  readonly lines?: readonly PortalLineAnswerInput[] | null | undefined
  readonly supplierRef?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A line as the order asks it, and whether an earlier answer confirmed it already (then it is locked). */
export interface PortalAskedLine extends AskedLine {
  readonly confirmed: boolean
}

export interface Substitute {
  /** One of our items (from the choices the API offered), or null when only the supplier's words name it. */
  readonly itemId: string | null
  readonly note: string | null
}

export interface PortalAnsweredLine {
  readonly lineId: string
  readonly seq: number
  readonly kind: PortalLineAnswerKind
  readonly asked: AnsweredLine['asked']
  readonly deliveries: readonly Delivery[]
  readonly quantity: string
  readonly date: BusinessDate | null
  readonly reason: string | null
  readonly changes: readonly LineChange[]
  readonly substitute: Substitute | null
  /** Waits for the buyer's yes (everything but "as asked"). */
  readonly needsBuyer: boolean
}

export interface PortalAnswerCounts {
  readonly lines: number
  readonly asAsked: number
  readonly laterDate: number
  readonly earlierDate: number
  readonly otherQuantity: number
  readonly split: number
  readonly cannotDeliver: number
  readonly substitute: number
  readonly change: number
}

export interface PortalAnswerPlan {
  readonly outcome: AnswerOutcome
  /** The lines answered now (a locked line is not among them), by seq. */
  readonly lines: readonly PortalAnsweredLine[]
  /** The lines confirmed by this answer: every line of a confirmation; the lines as asked of a proposal. */
  readonly confirmNow: readonly string[]
  readonly counts: PortalAnswerCounts
  /** "2 lines as asked · 1 later date · 1 substitute" (the review before sending, the buyer's note). */
  readonly summary: string
  readonly supplierRef: string | null
  readonly note: string | null
  /** The decline's words, when every line is one the supplier cannot deliver. */
  readonly declineReason: string | null
}

const q4 = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const plain = (value: string): string => new Decimal(value).toDecimalPlaces(QUANTITY_SCALE).toString()
const clean = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function quantityOf(value: string, path: string, issues: Issue[]): Decimal | null {
  if (!fitsDecimal(value, QUANTITY.precision, QUANTITY.scale)) {
    issues.push({ path, message: 'Give the quantity as a number with at most four decimals.' })
    return null
  }
  const quantity = new Decimal(value)
  if (quantity.lte(0)) {
    issues.push({ path, message: 'Give a quantity above 0.' })
    return null
  }
  return quantity
}

function dateOf(value: string, today: BusinessDate, path: string, issues: Issue[]): BusinessDate | null {
  if (!isBusinessDate(value)) issues.push({ path, message: 'Give the date as YYYY-MM-DD.' })
  else if (value < today) issues.push({ path, message: 'Give a date from today on.' })
  else if (value > addDays(today, MAX_DAYS_AHEAD)) issues.push({ path, message: 'Give a date within two years.' })
  else return value
  return null
}

function changesOf(asked: PortalAskedLine, quantity: Decimal, date: BusinessDate | null): LineChange[] {
  const changes: LineChange[] = []
  if (date !== null && date > asked.needDate) changes.push('LATER')
  if (date !== null && date < asked.needDate) changes.push('EARLIER')
  if (quantity.lt(asked.quantity)) changes.push('LESS')
  if (quantity.gt(asked.quantity)) changes.push('MORE')
  return changes
}

const askedView = (asked: PortalAskedLine): AnsweredLine['asked'] => ({ quantity: q4(new Decimal(asked.quantity)), uom: asked.uom, needDate: asked.needDate })

/** A W1 answer of one line, checked by W1's own rules (one line at a time: its issues keep this answer's paths). */
function linkLine(asked: PortalAskedLine, entry: PortalLineAnswerInput, today: BusinessDate, path: string, issues: Issue[]): PortalAnsweredLine | null {
  for (const field of ['substituteItemId', 'substituteNote'] as const) {
    if (clean(entry[field]) !== null) issues.push({ path: `${path}/${field}`, message: `Not part of an answer ${entry.answer}.` })
  }
  try {
    const plan = planAnswer([asked], { mode: 'BY_LINE', lines: [{ lineId: entry.lineId, answer: entry.answer as AnsweredLine['kind'], quantity: entry.quantity, date: entry.date, deliveries: entry.deliveries, reason: entry.reason }] }, today)
    const line = plan.lines[0]!
    return { ...line, deliveries: line.deliveries.map((part) => ({ ...part })), changes: [...line.changes], substitute: null, needsBuyer: line.kind !== 'AS_ASKED' }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error
    for (const issue of error.issues ?? []) issues.push({ path: issue.path.replace(/^body\/lines\/0/, path).replace(/^body$/, path), message: issue.message })
    return null
  }
}

function reasonOf(value: string | null | undefined, path: string, issues: Issue[], required: string | null): string | null {
  const reason = clean(value)
  if (reason === null && required !== null) issues.push({ path, message: required })
  else if (reason !== null && reason.length > MAX_TEXT.reason) issues.push({ path, message: `At most ${MAX_TEXT.reason} characters.` })
  return reason
}

/** SUBSTITUTE: our article from the choices and/or the supplier's own in words; optionally another quantity and date. */
function substituteLine(asked: PortalAskedLine, entry: PortalLineAnswerInput, choices: ReadonlySet<string>, today: BusinessDate, path: string, issues: Issue[]): PortalAnsweredLine | null {
  const before = issues.length
  if (entry.deliveries !== undefined && entry.deliveries !== null && entry.deliveries.length > 0) issues.push({ path: `${path}/deliveries`, message: 'A substitute is one delivery: give its quantity and date.' })
  const itemId = clean(entry.substituteItemId)
  const words = clean(entry.substituteNote)
  if (itemId === null && words === null) issues.push({ path: `${path}/substituteItemId`, message: 'Choose the article you offer instead, or describe your own.' })
  if (itemId !== null && (!isUuid(itemId) || !choices.has(itemId))) issues.push({ path: `${path}/substituteItemId`, message: 'Choose one of the articles offered for this line.' })
  if (words !== null && words.length > MAX_SUBSTITUTE_NOTE) issues.push({ path: `${path}/substituteNote`, message: `At most ${MAX_SUBSTITUTE_NOTE} characters.` })
  const givenQuantity = clean(entry.quantity)
  const givenDate = clean(entry.date)
  const quantity = givenQuantity === null ? new Decimal(asked.quantity) : quantityOf(givenQuantity, `${path}/quantity`, issues)
  const date = givenDate === null ? asked.needDate : dateOf(givenDate, today, `${path}/date`, issues)
  const reason = reasonOf(entry.reason, `${path}/reason`, issues, null)
  if (issues.length > before || quantity === null || date === null) return null
  return {
    lineId: asked.id,
    seq: asked.seq,
    kind: 'SUBSTITUTE',
    asked: askedView(asked),
    deliveries: [{ quantity: q4(quantity), date }],
    quantity: q4(quantity),
    date,
    reason,
    changes: changesOf(asked, quantity, date),
    substitute: { itemId, note: words },
    needsBuyer: true,
  }
}

/** CHANGE: another change in words; the quantity and date stay as asked. */
function changeLine(asked: PortalAskedLine, entry: PortalLineAnswerInput, path: string, issues: Issue[]): PortalAnsweredLine | null {
  const before = issues.length
  for (const field of ['quantity', 'date', 'substituteItemId', 'substituteNote'] as const) {
    if (clean(entry[field]) !== null) issues.push({ path: `${path}/${field}`, message: 'Not part of an answer CHANGE: say the change in words (another date or quantity is an answer OTHER).' })
  }
  if (entry.deliveries !== undefined && entry.deliveries !== null && entry.deliveries.length > 0) issues.push({ path: `${path}/deliveries`, message: 'Not part of an answer CHANGE.' })
  const reason = reasonOf(entry.reason, `${path}/reason`, issues, 'Say what you would change (a few words for the buyer).')
  if (issues.length > before) return null
  const view = askedView(asked)
  return { lineId: asked.id, seq: asked.seq, kind: 'CHANGE', asked: view, deliveries: [{ quantity: view.quantity, date: asked.needDate }], quantity: view.quantity, date: asked.needDate, reason, changes: [], substitute: null, needsBuyer: true }
}

export function portalCountsOf(lines: readonly Pick<PortalAnsweredLine, 'kind' | 'changes'>[]): PortalAnswerCounts {
  const has = (line: Pick<PortalAnsweredLine, 'changes'>, change: LineChange): boolean => line.changes.includes(change)
  return {
    lines: lines.length,
    asAsked: lines.filter((line) => line.kind === 'AS_ASKED').length,
    laterDate: lines.filter((line) => line.kind !== 'CANNOT_DELIVER' && has(line, 'LATER')).length,
    earlierDate: lines.filter((line) => line.kind !== 'CANNOT_DELIVER' && has(line, 'EARLIER')).length,
    otherQuantity: lines.filter((line) => has(line, 'LESS') || has(line, 'MORE')).length,
    split: lines.filter((line) => line.kind === 'SPLIT').length,
    cannotDeliver: lines.filter((line) => line.kind === 'CANNOT_DELIVER').length,
    substitute: lines.filter((line) => line.kind === 'SUBSTITUTE').length,
    change: lines.filter((line) => line.kind === 'CHANGE').length,
  }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** W1's words ("2 lines as asked · 1 later date") and the W2b ones ("1 substitute · 1 change to agree"). */
export function portalAnswerSummary(counts: PortalAnswerCounts): string {
  const parts = [answerSummary(counts)].filter((part) => part !== '')
  if (counts.substitute > 0) parts.push(plural(counts.substitute, 'substitute', 'substitutes'))
  if (counts.change > 0) parts.push(plural(counts.change, 'change to agree', 'changes to agree'))
  return parts.join(' · ')
}

/**
 * One answered line in words (the buyer's note on the order's thread, the review): W1's words for its four answers; a
 * substitute names the article offered (`substituteLabel`: our item's code and name, read by the caller) or the supplier's
 * words; a change gives the supplier's words.
 */
export function portalLineText(line: PortalAnsweredLine, substituteLabel: string | null = null): string {
  if (LINK_KINDS.has(line.kind)) return lineAnswerText(line as unknown as AnsweredLine)
  const unit = uomText(line.asked.uom)
  const asked = `${plain(line.asked.quantity)} ${unit} by ${line.asked.needDate}`
  const why = line.reason ? ` Reason: ${line.reason}` : ''
  if (line.kind === 'CHANGE') return `Line ${line.seq}: a change to agree (asked ${asked}): ${line.reason ?? ''}`.trim()
  const offered = [substituteLabel, line.substitute?.note].filter((part): part is string => typeof part === 'string' && part !== '')
  const what = offered.length === 0 ? 'another article' : offered.join(' — ')
  return `Line ${line.seq}: a substitute instead, ${what}: ${plain(line.quantity)} ${unit} by ${line.date} (asked ${asked}).${why}`
}

/**
 * The supplier's answer in the portal, checked against the order's open lines (`asked`), and what it comes to (see the module
 * comment). `choices`: the ids of our items the API offers as substitutes (any line). A ValidationError names every problem.
 */
export function planPortalAnswer(asked: readonly PortalAskedLine[], input: PortalAnswerInput, choices: ReadonlySet<string>, today: BusinessDate): PortalAnswerPlan {
  const issues: Issue[] = []
  const supplierRef = clean(input.supplierRef)
  if (supplierRef !== null && supplierRef.length > MAX_TEXT.code) issues.push({ path: 'body/supplierRef', message: `At most ${MAX_TEXT.code} characters.` })
  const note = clean(input.note)
  if (note !== null && note.length > MAX_TEXT.note) issues.push({ path: 'body/note', message: `At most ${MAX_TEXT.note} characters.` })
  if (asked.length === 0) issues.push({ path: 'body', message: 'The order has no line to answer.' })
  const open = asked.filter((line) => !line.confirmed)
  const locked = asked.length - open.length

  let answered: PortalAnsweredLine[] = []
  if (input.mode === 'ALL_AS_ASKED') {
    if (input.lines && input.lines.length > 0) issues.push({ path: 'body/lines', message: '"Confirm all as asked" takes no lines: answer line by line instead.' })
    answered = open.flatMap((line) => {
      const view = askedView(line)
      return [{ lineId: line.id, seq: line.seq, kind: 'AS_ASKED' as const, asked: view, deliveries: [{ quantity: view.quantity, date: line.needDate }], quantity: view.quantity, date: line.needDate, reason: null, changes: [], substitute: null, needsBuyer: false }]
    })
  } else if (input.mode === 'BY_LINE') {
    const byId = new Map(asked.map((line) => [line.id, line]))
    const seen = new Set<string>()
    ;(input.lines ?? []).forEach((entry, index) => {
      const path = `body/lines/${index}`
      const line = byId.get(entry?.lineId)
      if (!line) return void issues.push({ path: `${path}/lineId`, message: 'Not a line of this order.' })
      if (line.confirmed) return void issues.push({ path: `${path}/lineId`, message: `Line ${line.seq} is confirmed already: it is not answered again.` })
      if (seen.has(line.id)) return void issues.push({ path: `${path}/lineId`, message: `Line ${line.seq} is answered twice.` })
      seen.add(line.id)
      const answer =
        entry.answer === 'SUBSTITUTE'
          ? substituteLine(line, entry, choices, today, path, issues)
          : entry.answer === 'CHANGE'
            ? changeLine(line, entry, path, issues)
            : LINK_KINDS.has(entry.answer)
              ? linkLine(line, entry, today, path, issues)
              : (issues.push({ path: `${path}/answer`, message: `Expected one of ${PORTAL_LINE_ANSWERS.join(', ')}.` }), null)
      if (answer) answered.push(answer)
    })
    for (const line of open) if (!seen.has(line.id)) issues.push({ path: 'body/lines', message: `Answer line ${line.seq} too.` })
  } else {
    issues.push({ path: 'body/mode', message: `Expected one of ${PORTAL_ANSWER_MODES.join(', ')}.` })
  }
  if (issues.length > 0) throw new ValidationError('The answer is not complete.', issues)

  answered = [...answered].sort((a, b) => a.seq - b.seq)
  const counts = portalCountsOf(answered)
  const outcome: AnswerOutcome = answered.every((line) => line.kind === 'AS_ASKED')
    ? 'CONFIRMED'
    : locked === 0 && answered.length > 0 && answered.every((line) => line.kind === 'CANNOT_DELIVER')
      ? 'DECLINED'
      : 'PROPOSED'
  const confirmNow = outcome === 'DECLINED' ? [] : answered.filter((line) => line.kind === 'AS_ASKED').map((line) => line.lineId)
  const declineReason = outcome === 'DECLINED' ? ['Cannot deliver any line of the order.', ...answered.map((line) => portalLineText(line)), ...(note ? [`Note: ${note}`] : [])].join('\n') : null
  return { outcome, lines: answered, confirmNow, counts, summary: portalAnswerSummary(counts), supplierRef, note, declineReason }
}

/** The proposal columns of one answered line (W1's five and the three of B-W2b-158). */
export interface PortalProposalColumns {
  readonly proposedQuantity: string
  readonly proposedDate: BusinessDate | null
  readonly proposedSplitQuantity: string | null
  readonly proposedSplitDate: BusinessDate | null
  readonly proposalReason: string | null
  readonly proposedSubstituteItemId: string | null
  readonly proposedSubstituteNote: string | null
  readonly proposalNeedsBuyer: boolean
}

export function portalProposalColumnsOf(line: PortalAnsweredLine): PortalProposalColumns {
  return {
    ...proposalColumnsOf(line),
    proposedSubstituteItemId: line.substitute?.itemId ?? null,
    proposedSubstituteNote: line.substitute?.note ?? null,
    proposalNeedsBuyer: line.needsBuyer,
  }
}

export interface PortalDeclineInput {
  readonly reason: PortalDeclineReason
  readonly note?: string | null | undefined
}

/** The decline's words as the order keeps them (declineReason): the reason, then the supplier's note. */
export function portalDeclineText(input: PortalDeclineInput): string {
  const issues: Issue[] = []
  if (!(PORTAL_DECLINE_REASONS as readonly string[]).includes(input.reason)) issues.push({ path: 'body/reason', message: `Expected one of ${PORTAL_DECLINE_REASONS.join(', ')}.` })
  const note = clean(input.note)
  if (input.reason === 'OTHER' && note === null) issues.push({ path: 'body/note', message: 'Say why you decline the order.' })
  if (note !== null && note.length > MAX_TEXT.note) issues.push({ path: 'body/note', message: `At most ${MAX_TEXT.note} characters.` })
  if (issues.length > 0) throw new ValidationError('The answer is not complete.', issues)
  const words = PORTAL_DECLINE_WORDS[input.reason]
  return note === null ? `${words}.` : `${words}: ${note}`
}

/**
 * A stored proposal line read back with its substitute (the buyer's note, the office's panel, the portal's "Answers so far"):
 * the W1 reading (purchasing/confirm/proposal proposedLineOf) tells the deliveries; a substitute or a change in words is
 * told by the three W2b columns.
 */
export function storedKindOf(read: Pick<AnsweredLine, 'kind'>, stored: { readonly proposedSubstituteItemId: string | null; readonly proposedSubstituteNote: string | null; readonly proposalNeedsBuyer: boolean }): PortalLineAnswerKind {
  if (stored.proposedSubstituteItemId !== null || stored.proposedSubstituteNote !== null) return 'SUBSTITUTE'
  if (read.kind === 'AS_ASKED' && stored.proposalNeedsBuyer) return 'CHANGE'
  return read.kind
}

/** A W1 reading of a stored proposal line, with the W2b kind, substitute and the buyer's yes. */
export function portalLineOfStored(read: AnsweredLine, stored: { readonly proposedSubstituteItemId: string | null; readonly proposedSubstituteNote: string | null; readonly proposalNeedsBuyer: boolean }): PortalAnsweredLine {
  const kind = storedKindOf(read, stored)
  const substitute = kind === 'SUBSTITUTE' ? { itemId: stored.proposedSubstituteItemId, note: stored.proposedSubstituteNote } : null
  return { ...read, kind, deliveries: read.deliveries.map((part) => ({ ...part })), changes: [...read.changes], substitute, needsBuyer: kind !== 'AS_ASKED' || stored.proposalNeedsBuyer }
}

/** What the portal says right after the answer (design links.po / portal "Confirmed — thank you. Paolo sees it now."). */
export function portalDoneMessage(outcome: AnswerOutcome, buyerName: string | null, confirmedNow = 0): string {
  const who = buyerName ?? 'The buyer'
  switch (outcome) {
    case 'CONFIRMED':
      return `Confirmed — thank you. ${who} sees it now. Need to change something later? Write in the order's messages.`
    case 'PROPOSED': {
      const confirmed = confirmedNow === 0 ? '' : `${confirmedNow === 1 ? 'the line' : `the ${confirmedNow} lines`} as asked ${confirmedNow === 1 ? 'is' : 'are'} confirmed, and `
      return `Thank you: ${confirmed}your changes are with ${buyerName ?? 'the buyer'}, who accepts or refuses them. You will see the answer here.`
    }
    case 'DECLINED':
      return `Declined — ${who} sees it now and will get back to you.`
  }
}

/**
 * Why the buyer cannot accept a proposal as it is, or null: a substitute changes the article, and the line's article changes
 * only in a new version of the order (B-W2b-158: "an accepted substitute makes a new revision"). The buyer takes it by a
 * counter-proposal (a new version as a draft: put the article on the line, send it; the supplier confirms it), or refuses.
 */
export function substituteAcceptProblem(seqs: readonly number[]): string | null {
  if (seqs.length === 0) return null
  const lines = seqs.length === 1 ? `Line ${seqs[0]} offers` : `Lines ${seqs.join(', ')} offer`
  return `${lines} another article instead: accepting would confirm the article you asked for. To take the substitute, counter-propose (a new version of the order), put the article on the line and send it: the supplier confirms the new version. Or refuse the proposal.`
}
