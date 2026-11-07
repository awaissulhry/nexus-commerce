import type { Issue } from '../../core/errors'
import { fitsDecimal, QUANTITY } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { W1_SCAN_REASONS } from '../../production/scans/reasons'
import { decimalOf } from '../../product/units/units'
import type { KitLineStatus, SubcontractOrderStatus } from '../subcontracting/rules'

/**
 * Subcontractor jobs (B-W2b-176; SCM-154 job list, SCM-155 kit received, SCM-156 progress, SCM-157 return announced; PLN-163
 * accept a job; design portal.supplier.jobs, links.job, purchasing.subcontracting › Kit "received by the workshop"), pure.
 * A JOB is a subcontract order as its workshop (the terzista) sees it: the operations it does with their pieces per size, the
 * dates, the kit we sent; never a fee or an amount (Owner answer C2). The workshop answers on it, through the portal, its
 * JOB_ACCEPT link, or the office for a workshop without e-mail (Owner answer C3); factory-db holds the answers
 * (subcontract.prisma, portal-supply.prisma; the …_portal_supply_w2b_guards triggers):
 *
 *   answer     accept (as asked, or with another due-back date and why), or decline with a reason; once, while the job is
 *              out (accept also once some came back; decline only before). The office answers a proposed date once:
 *              ACCEPTED makes it the expected-back date.
 *   kit        per SENT kit line, once: how much came (0 or more, at most what we sent); a shortfall says why in words (a
 *              photo is a file of the line). "All received as listed" = every SENT line still unchecked at its quantity.
 *   progress   finished pieces since the last report, per operation and size cell or bundle (or the operation as a whole);
 *              append-only; the running total never passes the operation's pieces, a cell's pieces or a bundle's garments
 *              (the partner role cannot read the operation: the API checks it here); "will finish by".
 *   send back  finished and scrapped pieces per operation (and bundle or cell; a reason code of the SCRAP list for scrap),
 *              unused material per kit line, parcels, the day, who collects, the workshop's DDT (DPR 472/1996). At most what
 *              is at the workshop and not announced yet. It prefills the office's receive back and puts nothing in stock.
 *
 * Words are Italian and English (the partner's locale); office screens have their own catalogues.
 */

export type Locale = 'it' | 'en'
export interface Words {
  readonly it: string
  readonly en: string
}
const w = (it: string, en: string): Words => Object.freeze({ it, en })

const OUT: readonly SubcontractOrderStatus[] = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED']
const AT_WORKSHOP: readonly SubcontractOrderStatus[] = ['AT_WORKSHOP', 'PARTLY_RECEIVED']
const ENDED: readonly SubcontractOrderStatus[] = ['RECEIVED', 'CLOSED', 'CANCELLED']

export const MAX_TEXT = 2000
export const MAX_NAME = 200
export const MAX_ENTRIES = 200
export const MAX_PIECES = 100_000
export const MAX_PARCELS = 9999
export const MAX_DDT_NUMBER = 40

// ---- the job as the workshop sees it ------------------------------------------------------------------------------------

/** The chips of the job list (design portal.supplier.jobs "Which jobs"). */
export const JOB_CHIPS = ['NEW', 'KIT', 'WORK', 'BACK', 'DONE'] as const
export type JobChip = (typeof JOB_CHIPS)[number]
export const JOB_CHIP_WORDS: Readonly<Record<JobChip, Words>> = Object.freeze({
  NEW: w('Da accettare', 'New (to accept)'),
  KIT: w('Kit da confermare', 'Kit to confirm'),
  WORK: w('In lavorazione', 'In progress'),
  BACK: w('Pronti da rendere', 'Ready to send back'),
  DONE: w('Conclusi', 'Done'),
})

/** Where the job stands, in the workshop's words. */
export const JOB_STATES = ['TO_ANSWER', 'DECLINED', 'WAITING_KIT', 'IN_WORK', 'PARTLY_BACK', 'BACK', 'CLOSED', 'CANCELLED'] as const
export type JobState = (typeof JOB_STATES)[number]
export const JOB_STATE_WORDS: Readonly<Record<JobState, Words>> = Object.freeze({
  TO_ANSWER: w('Aspetta la tua risposta', 'Waiting for your answer'),
  DECLINED: w('Rifiutata', 'Declined'),
  WAITING_KIT: w('Il kit è in arrivo', 'Kit on its way'),
  IN_WORK: w('Nel tuo laboratorio', 'In your workshop'),
  PARTLY_BACK: w('In parte rientrata', 'Partly back'),
  BACK: w('Tutto rientrato', 'All back'),
  CLOSED: w('Chiusa', 'Closed'),
  CANCELLED: w('Annullata', 'Cancelled'),
})

/** The one next step of a job card (design: "the one next-step button"); NONE and WAIT_KIT draw no button. */
export const NEXT_STEPS = ['ACCEPT', 'CONFIRM_KIT', 'REPORT', 'SEND_BACK', 'WAIT_KIT', 'NONE'] as const
export type NextStep = (typeof NEXT_STEPS)[number]
export const NEXT_STEP_WORDS: Readonly<Record<NextStep, Words>> = Object.freeze({
  ACCEPT: w('Accetta o rifiuta', 'Accept or decline'),
  CONFIRM_KIT: w('Conferma il kit', 'Confirm the kit'),
  REPORT: w('Comunica i pezzi finiti', 'Report finished pieces'),
  SEND_BACK: w('Annuncia il reso', 'Announce the send-back'),
  WAIT_KIT: w('Aspetta il nostro kit', 'Wait for our kit'),
  NONE: w('Niente da fare', 'Nothing to do'),
})

export interface JobOperationCounts {
  readonly pieces: number
  readonly piecesSent: number
  readonly piecesBackGood: number
  readonly piecesBackDefective: number
  readonly piecesScrapped: number
  /** Finished pieces reported so far (every report). */
  readonly finished: number
  /** Finished and scrapped pieces of return notices still ANNOUNCED (not received, not cancelled). */
  readonly announced: number
}

export interface JobFacts {
  readonly status: SubcontractOrderStatus
  readonly accepted: boolean
  readonly declined: boolean
  readonly kitLines: readonly { readonly status: KitLineStatus; readonly checked: boolean }[]
  readonly operations: readonly JobOperationCounts[]
}

const backOf = (operation: JobOperationCounts): number => operation.piecesBackGood + operation.piecesBackDefective + operation.piecesScrapped
/** At the workshop now: sent less back. */
export const atWorkshopOf = (operation: JobOperationCounts): number => Math.max(0, operation.piecesSent - backOf(operation))
/** At the workshop and not announced yet: what a send-back may still announce. */
export const announceableOf = (operation: JobOperationCounts): number => Math.max(0, atWorkshopOf(operation) - operation.announced)
/** Finished at the workshop and not on its way back yet. */
export const readyOf = (operation: JobOperationCounts): number => Math.max(0, Math.min(operation.finished, operation.piecesSent) - backOf(operation) - operation.announced)

export const kitToConfirm = (facts: Pick<JobFacts, 'kitLines'>): number => facts.kitLines.filter((line) => line.status === 'SENT' && !line.checked).length

export function jobStateOf(facts: Pick<JobFacts, 'status' | 'accepted' | 'declined'>): JobState {
  if (facts.status === 'CANCELLED') return 'CANCELLED'
  if (facts.status === 'CLOSED') return 'CLOSED'
  if (facts.declined) return 'DECLINED'
  if (facts.status === 'RECEIVED') return 'BACK'
  if (!facts.accepted) return 'TO_ANSWER'
  if (facts.status === 'ISSUED') return 'WAITING_KIT'
  return facts.status === 'PARTLY_RECEIVED' ? 'PARTLY_BACK' : 'IN_WORK'
}

/** The chip a job sits under now (each job under exactly one). */
export function jobChipOf(facts: JobFacts): JobChip {
  if (ENDED.includes(facts.status) || facts.declined || !OUT.includes(facts.status)) return 'DONE'
  if (!facts.accepted) return 'NEW'
  if (kitToConfirm(facts) > 0) return 'KIT'
  if (AT_WORKSHOP.includes(facts.status) && facts.operations.some((operation) => readyOf(operation) > 0)) return 'BACK'
  return 'WORK'
}

export function nextStepOf(facts: JobFacts): NextStep {
  const chip = jobChipOf(facts)
  if (chip === 'NEW') return 'ACCEPT'
  if (chip === 'KIT') return 'CONFIRM_KIT'
  if (chip === 'BACK') return 'SEND_BACK'
  if (chip === 'DONE') return 'NONE'
  return facts.status === 'ISSUED' ? 'WAIT_KIT' : 'REPORT'
}

/** What the workshop may do now (null) or why not, in its words. */
export interface JobActs {
  readonly accept: Words | null
  readonly decline: Words | null
  readonly kit: Words | null
  readonly progress: Words | null
  readonly sendBack: Words | null
}

export function jobActsOf(facts: JobFacts): JobActs {
  const ended = ENDED.includes(facts.status) ? w('Questa lavorazione è conclusa.', 'This job has ended.') : null
  const declined = facts.declined ? w('Hai rifiutato questa lavorazione.', 'You declined this job.') : null
  const answered = facts.accepted ? w('Hai già accettato questa lavorazione.', 'You accepted this job already.') : declined
  const notAccepted = facts.accepted ? null : (declined ?? w('Prima accetta la lavorazione.', 'Accept the job first.'))
  const accept = ended ?? answered ?? (OUT.includes(facts.status) ? null : w('Questa lavorazione non ti è ancora stata inviata.', 'This job was not sent to you yet.'))
  const decline =
    ended ??
    answered ??
    (facts.status === 'PARTLY_RECEIVED' ? w('Parte del lavoro è già rientrata: scrivici nei messaggi.', 'Some of the work came back already: write to us in the messages.') : null) ??
    (OUT.includes(facts.status) ? null : w('Questa lavorazione non ti è ancora stata inviata.', 'This job was not sent to you yet.'))
  const kit = ended ?? notAccepted ?? (kitToConfirm(facts) > 0 ? null : w('Nessun kit da confermare.', 'No kit to confirm.'))
  const progress = ended ?? notAccepted
  const sendBack =
    ended ??
    notAccepted ??
    (AT_WORKSHOP.includes(facts.status) ? null : w('Il kit non è ancora partito: niente da rendere.', 'The kit has not left yet: nothing to send back.')) ??
    (facts.operations.some((operation) => announceableOf(operation) > 0) ? null : w('Tutto quello che hai è già annunciato o rientrato.', 'Everything you hold is announced or back already.'))
  return { accept, decline, kit, progress, sendBack }
}

// ---- the answer ---------------------------------------------------------------------------------------------------------

export const DECLINE_REASONS = ['NO_CAPACITY', 'DATES', 'OTHER'] as const
export type DeclineReason = (typeof DECLINE_REASONS)[number]
export const DECLINE_REASON_WORDS: Readonly<Record<DeclineReason, Words>> = Object.freeze({
  NO_CAPACITY: w('Nessuna capacità', 'No capacity'),
  DATES: w('Le date non vanno bene', 'The dates do not work'),
  OTHER: w('Altro', 'Other'),
})

const trimmed = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const tooLong = (value: string | null, max: number): boolean => value !== null && value.length > max

export interface AcceptInput {
  readonly proposedDate?: BusinessDate | null | undefined
  readonly reason?: string | null | undefined
  readonly name?: string | null | undefined
}

export interface AcceptPlan {
  readonly proposedDate: BusinessDate | null
  readonly reason: string | null
  readonly name: string | null
}

/** The problems of an acceptance (paths proposedDate, reason, name); empty when it may be written. */
export function acceptProblems(job: { readonly orderDate: BusinessDate; readonly expectedBackDate: BusinessDate | null }, input: AcceptInput, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  const date = input.proposedDate ?? null
  const reason = trimmed(input.reason)
  if (date !== null) {
    if (date < job.orderDate || date < today) problems.push({ path: 'proposedDate', message: 'Propose a day from today on.' })
    else if (date === job.expectedBackDate) problems.push({ path: 'proposedDate', message: 'That is the day we asked for: accept as asked.' })
    if (reason === null) problems.push({ path: 'reason', message: 'Say why you need another day.' })
  } else if (reason !== null) {
    problems.push({ path: 'proposedDate', message: 'Give the day you propose, or accept as asked without a reason.' })
  }
  if (tooLong(reason, MAX_TEXT)) problems.push({ path: 'reason', message: `At most ${MAX_TEXT} characters.` })
  if (tooLong(trimmed(input.name), MAX_NAME)) problems.push({ path: 'name', message: `At most ${MAX_NAME} characters.` })
  return problems
}

export const acceptPlanOf = (input: AcceptInput): AcceptPlan => ({ proposedDate: input.proposedDate ?? null, reason: input.proposedDate ? trimmed(input.reason) : null, name: trimmed(input.name) })

export interface DeclineInput {
  readonly reason: DeclineReason
  readonly note?: string | null | undefined
  readonly name?: string | null | undefined
}

export function declineProblems(input: DeclineInput): Issue[] {
  const problems: Issue[] = []
  const note = trimmed(input.note)
  if (!(DECLINE_REASONS as readonly string[]).includes(input.reason)) problems.push({ path: 'reason', message: 'Pick a reason.' })
  if (input.reason === 'OTHER' && note === null) problems.push({ path: 'note', message: 'Say why in a few words.' })
  if (tooLong(note, MAX_TEXT - 60)) problems.push({ path: 'note', message: `At most ${MAX_TEXT - 60} characters.` })
  if (tooLong(trimmed(input.name), MAX_NAME)) problems.push({ path: 'name', message: `At most ${MAX_NAME} characters.` })
  return problems
}

/** The decline as stored (SubcontractOrder.declineReason): the reason in English (the office's record) and the note. */
export function declineText(input: DeclineInput): string {
  const note = trimmed(input.note)
  const label = DECLINE_REASON_WORDS[input.reason].en
  return input.reason === 'OTHER' ? note! : note ? `${label}: ${note}` : label
}

export const DATE_DECISIONS = ['ACCEPTED', 'REFUSED'] as const
export type DateDecision = (typeof DATE_DECISIONS)[number]

/** Why the office cannot answer the workshop's proposed date now (null: it may). */
export function dateDecisionProblem(job: { readonly status: SubcontractOrderStatus; readonly proposedDate: BusinessDate | null; readonly decided: boolean }): string | null {
  if (job.proposedDate === null) return 'The workshop proposed no other date.'
  if (job.decided) return 'The proposed date was answered already.'
  if (job.status === 'DRAFT' || job.status === 'CLOSED' || job.status === 'CANCELLED') return `The order is ${job.status.toLowerCase()}: its dates no longer change.`
  return null
}

// ---- the kit ------------------------------------------------------------------------------------------------------------

export interface KitLineFacts {
  readonly id: string
  readonly seq: number
  readonly status: KitLineStatus
  /** What we sent, in the line's unit (a plain decimal). */
  readonly quantity: string
  readonly checked: boolean
}

export interface KitCheckInput {
  /** "All received as listed": every SENT line still unchecked, at its quantity. */
  readonly all?: boolean | undefined
  readonly lines?: readonly { readonly kitLineId: string; readonly quantity: string; readonly note?: string | null | undefined }[] | undefined
}

export interface KitCheck {
  readonly kitLineId: string
  readonly seq: number
  readonly quantity: string
  readonly note: string | null
  /** Less came than we sent. */
  readonly short: boolean
}

export interface KitPlan {
  readonly lines: readonly KitCheck[]
  readonly problems: readonly Issue[]
}

const isQuantity = (value: string): boolean => fitsDecimal(value, QUANTITY.precision, QUANTITY.scale) && !decimalOf(value).isNegative()

/** The checks to write (paths lines/<i>/…); a line already checked is never checked again. */
export function kitCheckPlan(lines: readonly KitLineFacts[], input: KitCheckInput): KitPlan {
  const open = lines.filter((line) => line.status === 'SENT' && !line.checked)
  if (input.all === true) {
    if ((input.lines ?? []).length > 0) return { lines: [], problems: [{ path: 'lines', message: 'Either all as listed, or line by line.' }] }
    if (open.length === 0) return { lines: [], problems: [{ path: 'all', message: 'No kit line waits for your check.' }] }
    return { lines: open.map((line) => ({ kitLineId: line.id, seq: line.seq, quantity: decimalOf(line.quantity).toFixed(4), note: null, short: false })), problems: [] }
  }
  const given = input.lines ?? []
  if (given.length === 0) return { lines: [], problems: [{ path: 'lines', message: 'Check at least one kit line, or confirm all as listed.' }] }
  if (given.length > MAX_ENTRIES) return { lines: [], problems: [{ path: 'lines', message: `At most ${MAX_ENTRIES} lines at a time.` }] }
  const problems: Issue[] = []
  const checks: KitCheck[] = []
  const seen = new Set<string>()
  for (const [index, entry] of given.entries()) {
    const at = `lines/${index}`
    const line = lines.find((row) => row.id === entry.kitLineId)
    if (!line || line.status !== 'SENT') {
      problems.push({ path: `${at}/kitLineId`, message: line ? 'This line has not left us yet.' : 'Not a line of this kit.' })
      continue
    }
    if (line.checked) {
      problems.push({ path: `${at}/kitLineId`, message: 'You confirmed this line already.' })
      continue
    }
    if (seen.has(line.id)) {
      problems.push({ path: `${at}/kitLineId`, message: 'This line is listed twice.' })
      continue
    }
    seen.add(line.id)
    if (!isQuantity(entry.quantity)) {
      problems.push({ path: `${at}/quantity`, message: 'Count what came: 0 or more, up to 4 decimals.' })
      continue
    }
    const counted = decimalOf(entry.quantity)
    const sent = decimalOf(line.quantity)
    const note = trimmed(entry.note)
    if (counted.greaterThan(sent)) problems.push({ path: `${at}/quantity`, message: `We sent ${sent.toString()}: count again, or write to us in the messages.` })
    const short = counted.lessThan(sent)
    if (short && note === null) problems.push({ path: `${at}/note`, message: 'Say what is missing or damaged.' })
    if (tooLong(note, MAX_TEXT)) problems.push({ path: `${at}/note`, message: `At most ${MAX_TEXT} characters.` })
    checks.push({ kitLineId: line.id, seq: line.seq, quantity: counted.toFixed(4), note, short })
  }
  return { lines: problems.length > 0 ? [] : checks, problems }
}

// ---- progress -----------------------------------------------------------------------------------------------------------

export interface ProgressOperation {
  readonly id: string
  readonly seq: number
  readonly pieces: number
  /** The pieces per cell (empty: not split by size). */
  readonly sizes: readonly { readonly workOrderSizeId: string; readonly pieces: number }[]
}

export interface ProgressBundle {
  readonly id: string
  readonly code: string
  readonly workOrderSizeId: string | null
  readonly quantity: number
}

export interface ReportedSoFar {
  readonly subcontractOperationId: string
  readonly workOrderSizeId: string | null
  readonly bundleId: string | null
  readonly finishedQuantity: number
}

export interface ProgressInput {
  readonly entries: readonly { readonly operationId: string; readonly workOrderSizeId?: string | null | undefined; readonly bundleId?: string | null | undefined; readonly finished: number }[]
  readonly finishBy?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
  readonly name?: string | null | undefined
}

export interface ProgressRow {
  readonly subcontractOperationId: string
  readonly workOrderSizeId: string | null
  readonly bundleId: string | null
  readonly finishedQuantity: number
}

export interface ProgressPlan {
  readonly rows: readonly ProgressRow[]
  readonly finishBy: BusinessDate | null
  readonly note: string | null
  readonly name: string | null
  readonly problems: readonly Issue[]
  readonly finished: number
}

const sumBy = <T>(rows: readonly T[], test: (row: T) => boolean, value: (row: T) => number): number => rows.reduce((sum, row) => (test(row) ? sum + value(row) : sum), 0)

/**
 * The rows of one report (paths entries/<i>/…): each an operation of the job, finished whole pieces from 1; a cell of the
 * operation when it is split by size; a bundle that went out with the job (its cell when it has one); the running totals
 * never above the operation's pieces, the cell's pieces or the bundle's garments. One row per entry.
 */
export function progressPlan(job: { readonly orderDate: BusinessDate; readonly operations: readonly ProgressOperation[]; readonly bundles: readonly ProgressBundle[]; readonly reported: readonly ReportedSoFar[] }, input: ProgressInput): ProgressPlan {
  const problems: Issue[] = []
  const finishBy = input.finishBy ?? null
  const note = trimmed(input.note)
  const name = trimmed(input.name)
  if (input.entries.length === 0) problems.push({ path: 'entries', message: 'Report at least one finished piece.' })
  if (input.entries.length > MAX_ENTRIES) problems.push({ path: 'entries', message: `At most ${MAX_ENTRIES} rows at a time.` })
  if (finishBy !== null && finishBy < job.orderDate) problems.push({ path: 'finishBy', message: 'The finish day is after the job was ordered.' })
  if (tooLong(note, MAX_TEXT)) problems.push({ path: 'note', message: `At most ${MAX_TEXT} characters.` })
  if (tooLong(name, MAX_NAME)) problems.push({ path: 'name', message: `At most ${MAX_NAME} characters.` })
  const rows: ProgressRow[] = []
  const running: ReportedSoFar[] = [...job.reported]
  for (const [index, entry] of input.entries.entries()) {
    const at = `entries/${index}`
    const operation = job.operations.find((row) => row.id === entry.operationId)
    if (!operation) {
      problems.push({ path: `${at}/operationId`, message: 'Not an operation of this job.' })
      continue
    }
    if (!Number.isInteger(entry.finished) || entry.finished < 1 || entry.finished > MAX_PIECES) {
      problems.push({ path: `${at}/finished`, message: 'Expected whole finished pieces, at least 1.' })
      continue
    }
    let cellId = entry.workOrderSizeId ?? null
    const bundleId = entry.bundleId ?? null
    if (bundleId !== null) {
      const bundle = job.bundles.find((row) => row.id === bundleId)
      if (!bundle) {
        problems.push({ path: `${at}/bundleId`, message: 'Not a bundle we sent you for this job.' })
        continue
      }
      if (cellId !== null && bundle.workOrderSizeId !== null && cellId !== bundle.workOrderSizeId) {
        problems.push({ path: `${at}/workOrderSizeId`, message: `Bundle ${bundle.code} is of another size.` })
        continue
      }
      cellId = cellId ?? bundle.workOrderSizeId
      const soFar = sumBy(running, (row) => row.subcontractOperationId === operation.id && row.bundleId === bundle.id, (row) => row.finishedQuantity)
      if (soFar + entry.finished > bundle.quantity) {
        problems.push({ path: `${at}/finished`, message: `Bundle ${bundle.code} holds ${bundle.quantity}; ${soFar} reported already.` })
        continue
      }
    }
    if (cellId !== null && operation.sizes.length > 0) {
      const cell = operation.sizes.find((size) => size.workOrderSizeId === cellId)
      if (!cell) {
        problems.push({ path: `${at}/workOrderSizeId`, message: 'This size is not part of the operation.' })
        continue
      }
      const soFar = sumBy(running, (row) => row.subcontractOperationId === operation.id && row.workOrderSizeId === cellId, (row) => row.finishedQuantity)
      if (soFar + entry.finished > cell.pieces) {
        problems.push({ path: `${at}/finished`, message: `This size has ${cell.pieces} piece(s); ${soFar} reported already.` })
        continue
      }
    } else if (cellId !== null && operation.sizes.length === 0 && bundleId === null) {
      // An operation not split by size takes its pieces as a whole (a bundle still names its own size).
      cellId = null
    }
    const total = sumBy(running, (row) => row.subcontractOperationId === operation.id, (row) => row.finishedQuantity)
    if (total + entry.finished > operation.pieces) {
      problems.push({ path: `${at}/finished`, message: `Operation ${operation.seq} has ${operation.pieces} piece(s); ${total} reported already.` })
      continue
    }
    const row: ProgressRow = { subcontractOperationId: operation.id, workOrderSizeId: cellId, bundleId, finishedQuantity: entry.finished }
    running.push(row)
    rows.push(row)
  }
  const finished = rows.reduce((sum, row) => sum + row.finishedQuantity, 0)
  return { rows: problems.length > 0 ? [] : rows, finishBy, note, name, problems, finished: problems.length > 0 ? 0 : finished }
}

// ---- send back ----------------------------------------------------------------------------------------------------------

/** The scrap reasons a workshop may give (the SCRAP list's standard codes, as the floor scraps; the receive back keeps the code). */
export const SCRAP_REASONS: readonly { readonly code: string; readonly words: Words }[] = Object.freeze(
  W1_SCAN_REASONS.filter((reason) => reason.kind === 'SCRAP').map((reason) => Object.freeze({ code: reason.code, words: w(reason.label.it, reason.label.en) })),
)

export interface ReturnOperation extends JobOperationCounts {
  readonly id: string
  readonly seq: number
  readonly sizes: readonly { readonly workOrderSizeId: string; readonly pieces: number }[]
}

export interface AnnouncedSoFar {
  readonly subcontractOperationId: string
  readonly bundleId: string | null
  readonly finished: number
  readonly scrapped: number
}

export interface ReturnInput {
  readonly quantities: readonly {
    readonly operationId: string
    readonly bundleId?: string | null | undefined
    readonly workOrderSizeId?: string | null | undefined
    readonly finished: number
    readonly scrapped?: number | undefined
    readonly reasonCode?: string | null | undefined
  }[]
  readonly materialBack?: readonly { readonly kitLineId: string; readonly quantity: string }[] | undefined
  readonly parcels: number
  readonly expectedDate: BusinessDate
  readonly weCollect?: boolean | undefined
  readonly ddt?: { readonly number: string; readonly date?: BusinessDate | null | undefined } | null | undefined
  readonly note?: string | null | undefined
  readonly name?: string | null | undefined
}

/** One entry of SubcontractReturnNotice.quantities, as stored. */
export interface ReturnQuantity {
  readonly subcontractOperationId: string
  readonly bundleId: string | null
  readonly workOrderSizeId: string | null
  readonly finished: number
  readonly scrapped: number
  readonly reasonCode?: string
}

export interface ReturnPlan {
  readonly quantities: readonly ReturnQuantity[]
  readonly materialBack: readonly { readonly kitLineId: string; readonly quantity: string }[]
  readonly parcels: number
  readonly expectedDate: BusinessDate
  readonly weCollect: boolean
  readonly ddt: { readonly number: string; readonly date: BusinessDate | null } | null
  readonly note: string | null
  readonly name: string | null
  readonly pieces: number
  readonly problems: readonly Issue[]
}

/**
 * The notice to write (paths quantities/<i>/…, materialBack/<i>/…, parcels, expectedDate, ddt/…): at least one piece in all;
 * per operation at most what is at the workshop and not announced yet; a bundle one we sent, never more than its garments
 * announced in all; scrapped pieces with a reason code of SCRAP_REASONS; unused material per SENT kit line, once, above 0 and
 * at most what we sent; 1 to 9999 parcels; the day from today on; the DDT's date only with its number, not after the day.
 */
export function returnPlan(
  job: { readonly operations: readonly ReturnOperation[]; readonly bundles: readonly ProgressBundle[]; readonly announced: readonly AnnouncedSoFar[]; readonly kitLines: readonly KitLineFacts[] },
  input: ReturnInput,
  today: BusinessDate,
): ReturnPlan {
  const problems: Issue[] = []
  const quantities: ReturnQuantity[] = []
  const used = new Map<string, number>()
  if (input.quantities.length === 0) problems.push({ path: 'quantities', message: 'Say what comes back.' })
  if (input.quantities.length > MAX_ENTRIES) problems.push({ path: 'quantities', message: `At most ${MAX_ENTRIES} rows at a time.` })
  const codes = new Set(SCRAP_REASONS.map((reason) => reason.code))
  for (const [index, entry] of input.quantities.entries()) {
    const at = `quantities/${index}`
    const operation = job.operations.find((row) => row.id === entry.operationId)
    if (!operation) {
      problems.push({ path: `${at}/operationId`, message: 'Not an operation of this job.' })
      continue
    }
    const scrapped = entry.scrapped ?? 0
    if (![entry.finished, scrapped].every((value) => Number.isInteger(value) && value >= 0 && value <= MAX_PIECES)) {
      problems.push({ path: `${at}/finished`, message: 'Expected whole pieces, 0 or more.' })
      continue
    }
    if (entry.finished + scrapped < 1) {
      problems.push({ path: `${at}/finished`, message: 'Each row sends back at least one piece.' })
      continue
    }
    const reasonCode = trimmed(entry.reasonCode)
    if (scrapped > 0 && (reasonCode === null || !codes.has(reasonCode))) {
      problems.push({ path: `${at}/reasonCode`, message: 'Say why the pieces were scrapped.' })
      continue
    }
    let cellId = entry.workOrderSizeId ?? null
    const bundleId = entry.bundleId ?? null
    if (bundleId !== null) {
      const bundle = job.bundles.find((row) => row.id === bundleId)
      if (!bundle) {
        problems.push({ path: `${at}/bundleId`, message: 'Not a bundle we sent you for this job.' })
        continue
      }
      cellId = bundle.workOrderSizeId ?? cellId
      const before = sumBy(job.announced, (row) => row.subcontractOperationId === operation.id && row.bundleId === bundle.id, (row) => row.finished + row.scrapped)
      const now = (used.get(`${operation.id}|${bundle.id}`) ?? 0) + entry.finished + scrapped
      if (before + now > bundle.quantity) {
        problems.push({ path: `${at}/finished`, message: `Bundle ${bundle.code} holds ${bundle.quantity}; ${before} announced already.` })
        continue
      }
      used.set(`${operation.id}|${bundle.id}`, now)
    }
    if (cellId !== null && operation.sizes.length > 0 && !operation.sizes.some((size) => size.workOrderSizeId === cellId)) {
      problems.push({ path: `${at}/workOrderSizeId`, message: 'This size is not part of the operation.' })
      continue
    }
    const total = (used.get(operation.id) ?? 0) + entry.finished + scrapped
    const left = announceableOf(operation)
    if (total > left) {
      problems.push({ path: `${at}/finished`, message: left === 0 ? `Nothing of operation ${operation.seq} is left to announce.` : `Operation ${operation.seq}: ${left} piece(s) are with you and not announced yet.` })
      continue
    }
    used.set(operation.id, total)
    quantities.push({ subcontractOperationId: operation.id, bundleId, workOrderSizeId: cellId, finished: entry.finished, scrapped, ...(scrapped > 0 ? { reasonCode: reasonCode! } : {}) })
  }
  const materialBack: { kitLineId: string; quantity: string }[] = []
  for (const [index, entry] of (input.materialBack ?? []).entries()) {
    const at = `materialBack/${index}`
    const line = job.kitLines.find((row) => row.id === entry.kitLineId)
    if (!line || line.status !== 'SENT') {
      problems.push({ path: `${at}/kitLineId`, message: 'Not a kit line we sent you.' })
      continue
    }
    if (materialBack.some((row) => row.kitLineId === line.id)) {
      problems.push({ path: `${at}/kitLineId`, message: 'This kit line is listed twice.' })
      continue
    }
    if (!isQuantity(entry.quantity) || decimalOf(entry.quantity).isZero()) {
      problems.push({ path: `${at}/quantity`, message: 'Expected a quantity above 0, up to 4 decimals.' })
      continue
    }
    if (decimalOf(entry.quantity).greaterThan(decimalOf(line.quantity))) {
      problems.push({ path: `${at}/quantity`, message: `We sent ${decimalOf(line.quantity).toString()} of it.` })
      continue
    }
    materialBack.push({ kitLineId: line.id, quantity: decimalOf(entry.quantity).toFixed(4) })
  }
  if (!Number.isInteger(input.parcels) || input.parcels < 1 || input.parcels > MAX_PARCELS) problems.push({ path: 'parcels', message: `From 1 to ${MAX_PARCELS} parcels.` })
  if (input.expectedDate < today) problems.push({ path: 'expectedDate', message: 'The goods arrive today or later.' })
  const number = trimmed(input.ddt?.number)
  const ddtDate = input.ddt?.date ?? null
  if (input.ddt && number === null) problems.push({ path: 'ddt/number', message: 'Give your DDT number, or leave the DDT out.' })
  if (tooLong(number, MAX_DDT_NUMBER)) problems.push({ path: 'ddt/number', message: `At most ${MAX_DDT_NUMBER} characters.` })
  if (ddtDate !== null && ddtDate > input.expectedDate) problems.push({ path: 'ddt/date', message: 'The DDT is dated on or before the day the goods arrive.' })
  const note = trimmed(input.note)
  const name = trimmed(input.name)
  if (tooLong(note, MAX_TEXT)) problems.push({ path: 'note', message: `At most ${MAX_TEXT} characters.` })
  if (tooLong(name, MAX_NAME)) problems.push({ path: 'name', message: `At most ${MAX_NAME} characters.` })
  const pieces = quantities.reduce((sum, row) => sum + row.finished + row.scrapped, 0)
  return {
    quantities: problems.length > 0 ? [] : quantities,
    materialBack: problems.length > 0 ? [] : materialBack,
    parcels: input.parcels,
    expectedDate: input.expectedDate,
    weCollect: input.weCollect === true,
    ddt: number === null ? null : { number, date: ddtDate },
    note,
    name,
    pieces: problems.length > 0 ? 0 : pieces,
    problems,
  }
}

/** A stored notice's quantities read back (the JSON column); entries that are not of the shape are skipped. */
export function returnQuantitiesOf(value: unknown): ReturnQuantity[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = entry as Record<string, unknown> | null
    if (!row || typeof row.subcontractOperationId !== 'string' || typeof row.finished !== 'number') return []
    const scrapped = typeof row.scrapped === 'number' ? row.scrapped : 0
    return [
      {
        subcontractOperationId: row.subcontractOperationId,
        bundleId: typeof row.bundleId === 'string' ? row.bundleId : null,
        workOrderSizeId: typeof row.workOrderSizeId === 'string' ? row.workOrderSizeId : null,
        finished: row.finished,
        scrapped,
        ...(typeof row.reasonCode === 'string' ? { reasonCode: row.reasonCode } : {}),
      },
    ]
  })
}

export function materialBackOf(value: unknown): { kitLineId: string; quantity: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = entry as Record<string, unknown> | null
    return row && typeof row.kitLineId === 'string' && typeof row.quantity === 'string' ? [{ kitLineId: row.kitLineId, quantity: row.quantity }] : []
  })
}

/**
 * The office's receive back prefilled from a notice (design: "it prefills the receive back"): per operation and bundle the
 * finished pieces as good, the scrapped with their reason code, the workshop's DDT. The office checks and changes what
 * really came; nothing moves until it posts.
 */
export function receivePrefillOf(notice: { readonly quantities: readonly ReturnQuantity[]; readonly workshopDdtNumber: string | null; readonly workshopDdtDate: BusinessDate | null }) {
  return {
    lines: notice.quantities.map((row) => ({ operationId: row.subcontractOperationId, bundleId: row.bundleId, good: row.finished, defective: 0, scrapped: row.scrapped, reason: row.reasonCode ?? null })),
    supplierDdt: notice.workshopDdtNumber === null ? null : { number: notice.workshopDdtNumber, date: notice.workshopDdtDate },
  }
}

// ---- the end states, in the workshop's words ----------------------------------------------------------------------------

const MONTHS: Readonly<Record<Locale, readonly string[]>> = {
  it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
}
/** "18 Nov" / "18 nov". */
export function shortDay(day: BusinessDate, locale: Locale): string {
  const [, month, date] = day.split('-')
  return `${Number(date)} ${MONTHS[locale][Number(month) - 1] ?? ''}`
}

export function acceptedWords(plan: AcceptPlan, kitDay: BusinessDate | null, locale: Locale): string {
  if (plan.proposedDate) {
    return locale === 'it'
      ? `Accettata — hai proposto il ${shortDay(plan.proposedDate, 'it')}: ti diciamo se va bene.`
      : `Accepted — you proposed ${shortDay(plan.proposedDate, 'en')}: we will tell you if it works.`
  }
  if (kitDay) return locale === 'it' ? `Accettata — il kit parte il ${shortDay(kitDay, 'it')} con il nostro DDT.` : `Accepted — we send the kit on ${shortDay(kitDay, 'en')} with our DDT.`
  return locale === 'it' ? 'Accettata — ti avvisiamo quando parte il kit.' : 'Accepted — we tell you when the kit leaves.'
}

export const declinedWords = (locale: Locale): string => (locale === 'it' ? 'Rifiutata — grazie di averci avvisato.' : 'Declined — thank you for telling us.')

export function kitCheckedWords(lines: readonly KitCheck[], locale: Locale): string {
  const short = lines.filter((line) => line.short).length
  if (locale === 'it') return short === 0 ? `Kit confermato: ${lines.length} righe ricevute come elencato.` : `Kit confermato: ${short} righe con differenze, le guardiamo noi.`
  return short === 0 ? `Kit confirmed: ${lines.length} line(s) received as listed.` : `Kit confirmed: ${short} line(s) with differences; we will look into them.`
}

export const progressWords = (finished: number, locale: Locale): string =>
  locale === 'it' ? `Inviato: ${finished} pezzi finiti. Il nostro ordine di lavoro li vede subito.` : `Sent: ${finished} finished piece(s). Our work order sees them at once.`

export const returnWords = (pieces: number, day: BusinessDate, locale: Locale): string =>
  locale === 'it' ? `Aspettiamo ${pieces} pezzi il ${shortDay(day, 'it')}.` : `We expect ${pieces} piece(s) on ${shortDay(day, 'en')}.`
