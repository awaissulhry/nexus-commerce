import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Customer complaints (B-W2a-65; SAL-416, QHS-113, QHS-115; design quality.complaints and its record "Complaint"): the
 * pure rules the API's modules/quality/complaints and the screens share. A complaint is LOGGED as the customer made it
 * (numbered from the company's COMPLAINT series), TRIAGED by quality (category, severity, owner, answer due), looked
 * into, answered and CLOSED with a reason (from any state; final). The …_sales_w2a_guards triggers hold the same rules
 * for every login; these give the screens and the API's refusals their words first.
 *
 *   NEW → TRIAGED → INVESTIGATING → ANSWERED → CLOSED
 *   TRIAGED → ANSWERED (answered at once)      ANSWERED → INVESTIGATING (the customer came back: the answer time cleared)
 *   any → CLOSED (with a reason; NEW too: a duplicate or a complaint logged by mistake)
 *
 * The safety escalation (QHS-115; Reg. (EU) 2016/425 art. 8(4)): a complaint triaged SAFETY raises its alert at once
 * (safetyRaisedAt, set once and kept if the category changes later), tells the owner and quality, and opens its PPE
 * register entry (kind COMPLAINT, source the complaint, risk being assessed) in the same step. The alert shows as a
 * banner until the owner acknowledges it (never timed out); a safety complaint closes only once it is acknowledged and in
 * the register. Nothing reaches the customer or an authority from here: the answer letter is W2b, the notice to the
 * authority is the register entry's own duty (compliance.register).
 */

export const COMPLAINT_STATUSES = ['NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED', 'CLOSED'] as const
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number]
export const COMPLAINT_CHANNELS = ['PHONE', 'EMAIL', 'PORTAL', 'LINK', 'RETURN', 'VISIT'] as const
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number]
/** The channels the office logs by hand (the portal and the claim link log their own, W2b). */
export const OFFICE_CHANNELS = ['PHONE', 'EMAIL', 'RETURN', 'VISIT'] as const satisfies readonly ComplaintChannel[]
export const COMPLAINT_CATEGORIES = ['SAFETY', 'FUNCTION', 'COSMETIC', 'FIT'] as const
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number]
export const COMPLAINT_SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number]

export const COMPLAINT_NUMBER_KIND = 'COMPLAINT' as const
/** The record type of its thread, its files and its PPE register entry's source. */
export const COMPLAINT_RECORD = 'Complaint' as const

export const COMPLAINT_LIMITS = Object.freeze({
  description: 4000,
  customerRef: 80,
  size: 40,
  serial: 120,
  batchNumber: 120,
  internalNote: 4000,
  note: 2000,
  closeReason: 1000,
  list: 200,
  /** Safety alerts the banner lists at most (the count says how many more). */
  banner: 20,
})

/** The answer is due this many working days (the company's calendar) after the complaint came in, unless triage says. */
export const ANSWER_WORKING_DAYS = 10
/** "Answer due in 3 days": calendar days from today, overdue ones included. */
export const ANSWER_DUE_SOON_DAYS = 3

export const FINAL_STATUSES: readonly ComplaintStatus[] = Object.freeze(['CLOSED'])
export const OPEN_STATUSES: readonly ComplaintStatus[] = Object.freeze(['NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED'])
/** Triaged and still waiting for the answer to the customer. */
export const AWAITING_ANSWER: readonly ComplaintStatus[] = Object.freeze(['TRIAGED', 'INVESTIGATING'])
/** Where triage may be given or changed (a re-triage keeps the status). */
export const TRIAGE_FROM: readonly ComplaintStatus[] = Object.freeze(['NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED'])

/** The moves a person makes with POST …/status (triage and close have their own steps). */
export const STATUS_MOVES = ['INVESTIGATING', 'ANSWERED'] as const
export type StatusMove = (typeof STATUS_MOVES)[number]
const MOVES: Readonly<Record<ComplaintStatus, readonly StatusMove[]>> = Object.freeze({
  NEW: [],
  TRIAGED: ['INVESTIGATING', 'ANSWERED'],
  INVESTIGATING: ['ANSWERED'],
  ANSWERED: ['INVESTIGATING'],
  CLOSED: [],
})
export const canMove = (from: ComplaintStatus, to: StatusMove): boolean => MOVES[from].includes(to)
export const isFinal = (status: ComplaintStatus): boolean => FINAL_STATUSES.includes(status)

const STATUS_WORDS: Readonly<Record<ComplaintStatus, string>> = Object.freeze({ NEW: 'new', TRIAGED: 'triaged', INVESTIGATING: 'being investigated', ANSWERED: 'answered', CLOSED: 'closed' })
export const statusWords = (status: ComplaintStatus): string => STATUS_WORDS[status]

// ---- the safety escalation ------------------------------------------------------------------------------------------

export const SAFETY_STATES = ['NONE', 'RAISED', 'ACKNOWLEDGED'] as const
export type SafetyState = (typeof SAFETY_STATES)[number]
export interface SafetyFacts {
  readonly safetyRaisedAt: Date | string | null
  readonly safetyAcknowledgedAt: Date | string | null
}
export const safetyStateOf = (facts: SafetyFacts): SafetyState => (facts.safetyAcknowledgedAt ? 'ACKNOWLEDGED' : facts.safetyRaisedAt ? 'RAISED' : 'NONE')
/** The banner's complaints: raised, not acknowledged, not closed (a closed one was acknowledged: close needs it). */
export const showsOnBanner = (facts: SafetyFacts & { readonly status: ComplaintStatus }): boolean => safetyStateOf(facts) === 'RAISED' && facts.status !== 'CLOSED'

// ---- the steps a person takes, held with a code the screens put in words -------------------------------------------

export const COMPLAINT_ACTIONS = ['edit', 'triage', 'startInvestigation', 'markAnswered', 'reopenInvestigation', 'close', 'acknowledge', 'register', 'createNcr', 'makeRepair'] as const
export type ComplaintAction = (typeof COMPLAINT_ACTIONS)[number]

/**
 * Why a step is held (the web's words: complaints.json `held.<CODE>`):
 *   NO_PERMISSION        the person's roles do not give it here (which permission: the screen names it)
 *   CLOSED               the complaint is closed (final)
 *   NOT_TRIAGED          it is new: triage it first
 *   ALREADY_INVESTIGATING / NOT_ANSWERED / ALREADY_ANSWERED   the status already says so, or the move does not exist
 *   NO_SAFETY_ALERT      it raised no safety alert (nothing to acknowledge)
 *   ACKNOWLEDGED         the owner acknowledged it already
 *   SAFETY_NOT_ACKNOWLEDGED  a safety complaint closes only after the owner's acknowledgement
 *   NOT_IN_REGISTER      a safety complaint closes only once its PPE register entry exists
 *   IN_REGISTER          it is in the PPE register already
 *   NO_STYLE             the PPE register keeps an entry per style: name the garment's style first
 */
export const HELD_CODES = [
  'NO_PERMISSION',
  'CLOSED',
  'NOT_TRIAGED',
  'ALREADY_INVESTIGATING',
  'NOT_ANSWERED',
  'ALREADY_ANSWERED',
  'NO_SAFETY_ALERT',
  'ACKNOWLEDGED',
  'SAFETY_NOT_ACKNOWLEDGED',
  'NOT_IN_REGISTER',
  'IN_REGISTER',
  'NO_STYLE',
] as const
export type HeldCode = (typeof HELD_CODES)[number]

export interface ActionFacts extends SafetyFacts {
  readonly status: ComplaintStatus
  readonly styleId: string | null
  readonly inRegister: boolean
  /** The step's permission, per action (the API answers can() over the complaint's company and customer). */
  readonly may: Readonly<Record<ComplaintAction, boolean>>
}

export interface ActionState {
  readonly action: ComplaintAction
  readonly allowed: boolean
  readonly held: HeldCode | null
}

/** Why closing is held now (null: it may close), in the order a person meets them. */
export function closeHeld(facts: Omit<ActionFacts, 'may' | 'styleId'>): HeldCode | null {
  if (facts.status === 'CLOSED') return 'CLOSED'
  if (safetyStateOf(facts) === 'RAISED') return 'SAFETY_NOT_ACKNOWLEDGED'
  if (facts.safetyRaisedAt && !facts.inRegister) return 'NOT_IN_REGISTER'
  return null
}

export function moveHeld(status: ComplaintStatus, to: StatusMove): HeldCode | null {
  if (status === 'CLOSED') return 'CLOSED'
  if (status === 'NEW') return 'NOT_TRIAGED'
  if (canMove(status, to)) return null
  if (to === 'INVESTIGATING') return 'ALREADY_INVESTIGATING'
  return status === 'ANSWERED' ? 'ALREADY_ANSWERED' : 'NOT_ANSWERED'
}

export function acknowledgeHeld(facts: SafetyFacts & { readonly status: ComplaintStatus }): HeldCode | null {
  const state = safetyStateOf(facts)
  if (state === 'NONE') return 'NO_SAFETY_ALERT'
  if (state === 'ACKNOWLEDGED') return 'ACKNOWLEDGED'
  return facts.status === 'CLOSED' ? 'CLOSED' : null
}

export function registerHeld(facts: { readonly status: ComplaintStatus; readonly styleId: string | null; readonly inRegister: boolean }): HeldCode | null {
  if (facts.status === 'CLOSED') return 'CLOSED'
  if (facts.inRegister) return 'IN_REGISTER'
  return facts.styleId ? null : 'NO_STYLE'
}

export function complaintActions(facts: ActionFacts): ActionState[] {
  const state = (action: ComplaintAction, why: HeldCode | null): ActionState => {
    const held = !facts.may[action] ? 'NO_PERMISSION' : why
    return { action, allowed: held === null, held }
  }
  const closed = facts.status === 'CLOSED' ? 'CLOSED' : null
  return [
    state('edit', closed),
    state('triage', closed),
    state('startInvestigation', facts.status === 'ANSWERED' ? 'ALREADY_ANSWERED' : moveHeld(facts.status, 'INVESTIGATING')),
    state('markAnswered', moveHeld(facts.status, 'ANSWERED')),
    state('reopenInvestigation', facts.status === 'ANSWERED' ? null : facts.status === 'CLOSED' ? 'CLOSED' : 'NOT_ANSWERED'),
    state('close', closeHeld(facts)),
    state('acknowledge', acknowledgeHeld(facts)),
    state('register', registerHeld(facts)),
    state('createNcr', closed),
    state('makeRepair', closed),
  ]
}

// ---- checks of what a person types -----------------------------------------------------------------------------------

/** A few minutes for the clocks of the screen and the server. */
export const GRACE_MS = 5 * 60_000

const tooLong = (value: string | null | undefined, max: number): boolean => (value ?? '').trim().length > max

export interface ComplaintFacts {
  readonly description?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly receivedAt?: Date | null | undefined
}

/** What the customer said and what it is about, as typed: problems at body/<field>. `full`: the description is required. */
export function factProblems(facts: ComplaintFacts, now: Date, full: boolean): Issue[] {
  const problems: Issue[] = []
  const words = (facts.description ?? '').trim()
  if (full && words === '') problems.push({ path: 'body/description', message: "What happened, in the customer's words." })
  if (facts.description !== undefined && !full && facts.description !== null && words === '') problems.push({ path: 'body/description', message: "The customer's words stay on the complaint: change them, do not empty them." })
  if (tooLong(facts.description, COMPLAINT_LIMITS.description)) problems.push({ path: 'body/description', message: `At most ${COMPLAINT_LIMITS.description} characters.` })
  if (tooLong(facts.customerRef, COMPLAINT_LIMITS.customerRef)) problems.push({ path: 'body/customerRef', message: `At most ${COMPLAINT_LIMITS.customerRef} characters.` })
  if (tooLong(facts.size, COMPLAINT_LIMITS.size)) problems.push({ path: 'body/size', message: `At most ${COMPLAINT_LIMITS.size} characters.` })
  if (tooLong(facts.serial, COMPLAINT_LIMITS.serial)) problems.push({ path: 'body/serial', message: `At most ${COMPLAINT_LIMITS.serial} characters.` })
  if (tooLong(facts.batchNumber, COMPLAINT_LIMITS.batchNumber)) problems.push({ path: 'body/batchNumber', message: `At most ${COMPLAINT_LIMITS.batchNumber} characters.` })
  if (tooLong(facts.internalNote, COMPLAINT_LIMITS.internalNote)) problems.push({ path: 'body/internalNote', message: `At most ${COMPLAINT_LIMITS.internalNote} characters.` })
  if (facts.receivedAt && facts.receivedAt.getTime() > now.getTime() + GRACE_MS) problems.push({ path: 'body/receivedAt', message: 'The complaint came in now or earlier.' })
  return problems
}

export interface TriageInput {
  readonly category: ComplaintCategory
  readonly severity: ComplaintSeverity
  readonly answerDueOn: BusinessDate
  readonly styleId: string | null
}

/** The triage as typed against the complaint: problems at body/<field>. `receivedOn` is the day it came in (Rome). */
export function triageProblems(input: TriageInput, receivedOn: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (input.answerDueOn < receivedOn) problems.push({ path: 'body/answerDueOn', message: `The answer is due on or after the day the complaint came in (${receivedOn}).` })
  if (input.category === 'SAFETY' && !input.styleId) problems.push({ path: 'body/styleId', message: "A safety complaint goes to the PPE register, which keeps an entry per style: name the garment's style." })
  return problems
}

export function closeReasonProblems(reason: string | null | undefined): Issue[] {
  const words = (reason ?? '').trim()
  if (words === '') return [{ path: 'body/reason', message: 'Say why it closes (answered and accepted, a duplicate of another complaint, logged by mistake…).' }]
  return words.length > COMPLAINT_LIMITS.closeReason ? [{ path: 'body/reason', message: `At most ${COMPLAINT_LIMITS.closeReason} characters.` }] : []
}

// ---- the list ---------------------------------------------------------------------------------------------------------

/** The tiles (named saved filters, design cmp-metrics) and the list's other rows. */
export const COMPLAINT_TILES = ['new', 'safety', 'dueSoon', 'open', 'answeredMonth'] as const
export type ComplaintTile = (typeof COMPLAINT_TILES)[number]
export const COMPLAINT_VIEWS = [...COMPLAINT_TILES, 'closed', 'all'] as const
export type ComplaintView = (typeof COMPLAINT_VIEWS)[number]

const addDays = (date: BusinessDate, days: number): BusinessDate => {
  const at = new Date(`${date}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** The last day "Answer due in 3 days" reaches (today in Rome + 3; overdue ones count too). */
export const dueSoonUntil = (today: BusinessDate): BusinessDate => addDays(today, ANSWER_DUE_SOON_DAYS)
/** The first day of today's month (Rome), for "Answered this month". */
export const monthStart = (today: BusinessDate): BusinessDate => `${today.slice(0, 7)}-01`

/** How the answer due date stands for a complaint still waiting for its answer (the Countdown's words). */
export function answerDueState(status: ComplaintStatus, answerDueOn: BusinessDate | null, today: BusinessDate): 'NONE' | 'OVERDUE' | 'SOON' | 'LATER' {
  if (!answerDueOn || !AWAITING_ANSWER.includes(status)) return 'NONE'
  if (answerDueOn < today) return 'OVERDUE'
  return answerDueOn <= dueSoonUntil(today) ? 'SOON' : 'LATER'
}

/** Where the garment's evidence trail opens (the W1 page /compliance/evidence/<serial|batch>/<subject>), or null. */
export function evidenceOf(facts: { readonly serial: string | null; readonly batchNumber: string | null }): { kind: 'serial' | 'batch'; subject: string } | null {
  if (facts.serial && facts.serial.trim() !== '') return { kind: 'serial', subject: facts.serial.trim() }
  if (facts.batchNumber && facts.batchNumber.trim() !== '') return { kind: 'batch', subject: facts.batchNumber.trim() }
  return null
}

/** The fields a change names (complaint.changed's `fields`). */
export const CHANGED_FIELDS = ['customerRef', 'contactId', 'channel', 'receivedAt', 'description', 'salesOrderId', 'shipmentId', 'returnId', 'styleId', 'size', 'serial', 'batchNumber', 'internalNote', 'category', 'severity', 'ownerId', 'answerDueOn'] as const
export type ChangedField = (typeof CHANGED_FIELDS)[number]

// ---- W2b follow-ups (B-W2b-17) ---------------------------------------------------------------------------------------

/**
 * Link… / Unlink on a complaint's Linked records (design quality.complaints cmp-links "NCR, CAPA, return, register entry,
 * shipment, garment"): the complaint's own facts (the order, the shipment, the return it came with, the garment's serial)
 * and the NCRs that name it (an NcrLink of recordType Complaint). The register entry is opened by the triage (one per
 * complaint); CAPA comes with W2b-2.
 */
export const COMPLAINT_LINK_TYPES = ['SalesOrder', 'Shipment', 'ReturnAuthorisation', 'GarmentSerial', 'Nonconformance'] as const
export type ComplaintLinkType = (typeof COMPLAINT_LINK_TYPES)[number]

/** The complaint's own column each fact link sets (the NCR link lives on the NCR). */
export const LINK_FIELDS: Readonly<Record<Exclude<ComplaintLinkType, 'Nonconformance'>, 'salesOrderId' | 'shipmentId' | 'returnId' | 'serial'>> = Object.freeze({
  SalesOrder: 'salesOrderId',
  Shipment: 'shipmentId',
  ReturnAuthorisation: 'returnId',
  GarmentSerial: 'serial',
})

/**
 * Mail in (B-W2a-65's gap; design quality.complaints conn "home (mail to sort) — complaints from e-mail"): the complaint
 * numbers a mail's subject names, as written by the series ("CMP-2026-0012"), upper-cased, each once, in order. A
 * number is a run of letters, digits, '-' and '/' with at least one digit, between word boundaries.
 */
export function complaintNumbersIn(subject: string | null | undefined, numbers: readonly string[]): string[] {
  if (!subject) return []
  const text = subject.toUpperCase()
  const found: { number: string; at: number }[] = []
  for (const number of new Set(numbers.map((entry) => entry.toUpperCase()))) {
    if (!/\d/.test(number)) continue
    let from = 0
    for (;;) {
      const at = text.indexOf(number, from)
      if (at < 0) break
      const before = at === 0 ? '' : text[at - 1]!
      const after = text[at + number.length] ?? ''
      if (!/[A-Z0-9/-]/.test(before) && !/[A-Z0-9/-]/.test(after)) {
        found.push({ number, at })
        break
      }
      from = at + 1
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.number)
}
