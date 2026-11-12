import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Warranty and service cases (B-W2b-345; SAL-368 legal versus factory guarantee, SAL-436 status-change updates to
 * customers; design sales.service "Warranty & service" and its record "Service case"), pure. apps/factory-api's
 * modules/sales/service says these rules in words before the …_service_safety_w2b_guards triggers would refuse the same,
 * and builds its answers from them.
 *
 *   the case       a warranty, complaint, repair, question or safety case about one garment (its serial) or a batch (the
 *                  work order's batch number), numbered SVC-… from the company's SERVICE_CASE series: who (a customer or
 *                  dealer and its person, or a rider named in the words), what is wrong, what the customer wants.
 *   the moves      NEW → OPEN | CLOSED; OPEN → WAITING_CUSTOMER | WAITING_PART | RESOLVED | CLOSED; a waiting case → OPEN |
 *                  the other waiting state | RESOLVED | CLOSED; RESOLVED → OPEN (it came back: the resolution is cleared) |
 *                  CLOSED. Resolved with what was done; closed without a resolution only with the reason. A warranty claim
 *                  is resolved only once its cover is decided (the remedy follows from it). CLOSED is final.
 *   the warranty   the legal guarantee of conformity (Directive (EU) 2019/771; Codice del Consumo arts. 128-135): the seller
 *   check          answers to a CONSUMER for a defect that shows within 2 years of delivery (art. 10), and within the first
 *                  year it is presumed to have existed at delivery (art. 11); its remedies are repair or replacement, then a
 *                  price reduction or the end of the contract (art. 13). Between businesses it is not ours: the contract and
 *                  the Civil Code's warranty for defects (art. 1490-1495 c.c.) apply, and a dealer who sold to a consumer may
 *                  turn to us (the right of redress, art. 18). The factory's own guarantee comes on top, on its own terms
 *                  (art. 17: never in place of the legal one). Said in words, decided by a person: the legal or the factory
 *                  guarantee, covered, partly or not covered, and why. The legal wording is the lawyer's to confirm.
 *   the customer   told at each status change when the case says so (`notifyCustomer`, OFF by default): a mail to the case's
 *                  contact on the case's thread, in their language (./mail.ts); through email out (FAKE locally and in
 *                  tests) — no mail without a contact with an e-mail.
 */

export const SERVICE_CASE_RECORD = 'ServiceCase' as const
export const SERVICE_CASE_LINK_RECORD = 'ServiceCaseLink' as const
/** The number series (factory-domain numbering/kinds: prefix SVC; subcontract orders use SC-). */
export const SERVICE_NUMBER_KIND = 'SERVICE_CASE' as const

export const CASE_KINDS = ['WARRANTY', 'COMPLAINT', 'REPAIR', 'QUESTION', 'SAFETY'] as const
export type CaseKind = (typeof CASE_KINDS)[number]
export const CASE_CHANNELS = ['OFFICE', 'MAIL', 'PHONE', 'PORTAL', 'LINK'] as const
export type CaseChannel = (typeof CASE_CHANNELS)[number]
/** How the office takes a case (the portal's and a claim link's are their own doors: the service inbox is Later, SAL-447). */
export const OFFICE_CASE_CHANNELS = ['OFFICE', 'MAIL', 'PHONE'] as const satisfies readonly CaseChannel[]
export const CASE_WISHES = ['REPAIR', 'REPLACE', 'CREDIT', 'ANSWER'] as const
export type CaseWish = (typeof CASE_WISHES)[number]
export const CASE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type CasePriority = (typeof CASE_PRIORITIES)[number]
export const CASE_STATUSES = ['NEW', 'OPEN', 'WAITING_CUSTOMER', 'WAITING_PART', 'RESOLVED', 'CLOSED'] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]
/** Every status but CLOSED: the case may still change. */
export const OPEN_CASE_STATUSES = ['NEW', 'OPEN', 'WAITING_CUSTOMER', 'WAITING_PART', 'RESOLVED'] as const satisfies readonly CaseStatus[]
export const WAITING_STATUSES = ['WAITING_CUSTOMER', 'WAITING_PART'] as const satisfies readonly CaseStatus[]
/** Where a move may go (NEW is only where a case starts). */
export const MOVE_TARGETS = ['OPEN', 'WAITING_CUSTOMER', 'WAITING_PART', 'RESOLVED', 'CLOSED'] as const satisfies readonly CaseStatus[]
export type MoveTarget = (typeof MOVE_TARGETS)[number]

export const COVERS = ['LEGAL_GUARANTEE', 'FACTORY_GUARANTEE', 'NONE'] as const
export type Cover = (typeof COVERS)[number]
export const COVER_DECISIONS = ['COVERED', 'PARTLY', 'NOT_COVERED'] as const
export type CoverDecision = (typeof COVER_DECISIONS)[number]

/** The saved rows and tiles of the list (design service.grid savedRows Open · Mine · Waiting · Closed · All; service.tiles). */
export const CASE_VIEWS = ['open', 'new', 'waitingCustomer', 'waitingPart', 'waiting', 'mine', 'closed', 'all'] as const
export type CaseView = (typeof CASE_VIEWS)[number]

export const CASE_LIMITS = Object.freeze({
  problem: 4000,
  label: 100,
  size: 20,
  coverNote: 2000,
  resolution: 4000,
  closeReason: 2000,
  internalNote: 4000,
  linkNote: 500,
  /** Words to the customer added to one status mail. */
  message: 2000,
  /** A list page at most; the default page. */
  list: 200,
  page: 50,
  /** Links per case (the API's; the database has no limit). */
  links: 100,
  /** The other open cases of the same garment a preview names. */
  others: 10,
  summary: 120,
})

const STATUS_WORDS: Readonly<Record<CaseStatus, string>> = Object.freeze({
  NEW: 'new',
  OPEN: 'open',
  WAITING_CUSTOMER: 'waiting for the customer',
  WAITING_PART: 'waiting for a part',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
})
export const statusWords = (status: CaseStatus): string => STATUS_WORDS[status]
export const isFinal = (status: CaseStatus): boolean => status === 'CLOSED'
export const isWaiting = (status: CaseStatus): boolean => (WAITING_STATUSES as readonly string[]).includes(status)

/** The moves the database allows (ServiceCase_guard), here so a refusal comes in words first. */
export function moveAllowed(from: CaseStatus, to: CaseStatus): boolean {
  if (from === to) return false
  switch (from) {
    case 'NEW':
      return to === 'OPEN' || to === 'CLOSED'
    case 'OPEN':
      return to === 'WAITING_CUSTOMER' || to === 'WAITING_PART' || to === 'RESOLVED' || to === 'CLOSED'
    case 'WAITING_CUSTOMER':
    case 'WAITING_PART':
      return to !== 'NEW'
    case 'RESOLVED':
      return to === 'OPEN' || to === 'CLOSED'
    case 'CLOSED':
      return false
  }
}

// ---- the warranty check (SAL-368) -----------------------------------------------------------------------------------

/** Directive (EU) 2019/771 art. 10(1); Codice del Consumo art. 133: 2 years from delivery. */
export const LEGAL_GUARANTEE_YEARS = 2
/** Directive (EU) 2019/771 art. 11(1); Codice del Consumo art. 135: the first year, the defect is presumed. */
export const PRESUMPTION_YEARS = 1

/** Who the customer of the case is to the guarantee: a private person buys as a consumer, an organisation as a business. */
export const BUYER_KINDS = ['CONSUMER', 'BUSINESS', 'NOT_NAMED'] as const
export type BuyerKind = (typeof BUYER_KINDS)[number]
export const buyerOfParty = (party: { readonly kind: string } | null | undefined): BuyerKind => (!party ? 'NOT_NAMED' : party.kind === 'PERSON' ? 'CONSUMER' : 'BUSINESS')

const DAY_MS = 86_400_000
const dayNumber = (day: BusinessDate): number => Date.parse(`${day}T00:00:00.000Z`) / DAY_MS
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round(dayNumber(to) - dayNumber(from))

/**
 * The day `years` after `day` (Reg. (EEC, Euratom) 1182/71 art. 3: a period in years ends on the day of the same date; when
 * that day does not exist, the last day of the month: 29 February → 28 February).
 */
export function addYears(day: BusinessDate, years: number): BusinessDate {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const year = y + years
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate()
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** The legal guarantee's last day the facts give: 2 years from delivery for a consumer we sold to; none otherwise. */
export const legalGuaranteeEndOf = (buyer: BuyerKind, deliveredOn: BusinessDate | null): BusinessDate | null => (buyer === 'CONSUMER' && deliveredOn ? addYears(deliveredOn, LEGAL_GUARANTEE_YEARS) : null)

export const GUARANTEE_STATES = ['RUNS', 'ENDED', 'NONE', 'UNKNOWN'] as const
export type GuaranteeState = (typeof GUARANTEE_STATES)[number]

export interface GuaranteeReading {
  readonly state: GuaranteeState
  readonly endsOn: BusinessDate | null
  /** Days from today to its last day (0 = today is the last day); null without an end. */
  readonly daysLeft: number | null
  readonly words: string
}

/** The list's Cover column (design service.grid "legal guarantee / factory warranty / out of cover"). */
export const COVER_STATES = ['LEGAL_GUARANTEE', 'FACTORY_GUARANTEE', 'OUT_OF_COVER', 'UNKNOWN'] as const
export type CoverState = (typeof COVER_STATES)[number]

export interface WarrantyFacts {
  readonly today: BusinessDate
  readonly buyer: BuyerKind
  readonly deliveredOn: BusinessDate | null
  readonly legalGuaranteeEndsOn: BusinessDate | null
  readonly factoryGuaranteeEndsOn: BusinessDate | null
}

export interface WarrantyCheck {
  readonly buyer: BuyerKind
  readonly deliveredOn: BusinessDate | null
  readonly legal: GuaranteeReading
  readonly factory: GuaranteeReading
  /** The consumer's first year (the defect presumed at delivery); null for a business or an unnamed customer. */
  readonly presumption: { readonly applies: boolean; readonly until: BusinessDate | null; readonly words: string } | null
  /** The cover the facts point to today; null while the delivery day is not known (the check cannot tell). */
  readonly suggested: Cover | null
  readonly state: CoverState
  /** What the customer may ask under the suggested cover, in words. */
  readonly remedies: string
  /** Who answers to whom, in words. */
  readonly liable: string
  /** The why, sentence by sentence (the design's "with why"). */
  readonly words: string[]
}

function reading(endsOn: BusinessDate | null, today: BusinessDate): { state: GuaranteeState; endsOn: BusinessDate | null; daysLeft: number | null } {
  if (!endsOn) return { state: 'NONE', endsOn: null, daysLeft: null }
  const daysLeft = daysBetween(today, endsOn)
  return { state: daysLeft >= 0 ? 'RUNS' : 'ENDED', endsOn, daysLeft }
}

const left = (days: number): string => (days === 0 ? 'today is its last day' : `${days} day${days === 1 ? '' : 's'} left`)

function legalReading(facts: WarrantyFacts): GuaranteeReading {
  if (facts.buyer === 'BUSINESS') {
    return {
      state: 'NONE',
      endsOn: null,
      daysLeft: null,
      words:
        "A business customer: the consumer's legal guarantee (Directive (EU) 2019/771) is not ours toward them; the contract of sale and the Civil Code's warranty for defects (art. 1490-1495 c.c.) apply. When they sold the garment to a consumer, they answer to the consumer and may turn to us (right of redress, Directive (EU) 2019/771 art. 18).",
    }
  }
  if (facts.buyer === 'NOT_NAMED') {
    return {
      state: 'NONE',
      endsOn: null,
      daysLeft: null,
      words: "No customer of ours is named: a rider's legal guarantee is owed by the seller who sold them the garment, not by us; ours is the factory guarantee.",
    }
  }
  const endsOn = facts.legalGuaranteeEndsOn ?? legalGuaranteeEndOf(facts.buyer, facts.deliveredOn)
  if (!endsOn) {
    return { state: 'UNKNOWN', endsOn: null, daysLeft: null, words: 'A consumer: the legal guarantee runs 2 years from delivery (Directive (EU) 2019/771 art. 10; Codice del Consumo art. 133); the delivery day is not known yet.' }
  }
  const r = reading(endsOn, facts.today)
  return {
    ...r,
    words:
      r.state === 'RUNS'
        ? `A consumer: the legal guarantee of conformity runs until ${endsOn} (${left(r.daysLeft!)}), 2 years from delivery (Directive (EU) 2019/771 art. 10; Codice del Consumo art. 133).`
        : `A consumer: the legal guarantee ended on ${endsOn}${facts.deliveredOn ? `, 2 years from delivery on ${facts.deliveredOn}` : ''}.`,
  }
}

function factoryReading(facts: WarrantyFacts): GuaranteeReading {
  const r = reading(facts.factoryGuaranteeEndsOn, facts.today)
  const words =
    r.state === 'RUNS'
      ? `The factory guarantee runs until ${r.endsOn} (${left(r.daysLeft!)}), on the factory's own terms, on top of any legal guarantee (Directive (EU) 2019/771 art. 17).`
      : r.state === 'ENDED'
        ? `The factory guarantee ended on ${r.endsOn}.`
        : 'No factory guarantee is recorded for this garment (warranty terms per product family come later): type its last day from the terms the customer was given, or leave it out.'
  return { ...r, words }
}

const REMEDIES: Readonly<Record<Cover, string>> = Object.freeze({
  LEGAL_GUARANTEE:
    'Under the legal guarantee: a repair or a replacement free of charge, within a reasonable time and without serious inconvenience; when neither is possible or it fails, a price reduction or the end of the contract (Directive (EU) 2019/771 art. 13).',
  FACTORY_GUARANTEE: "Under the factory guarantee: what its terms give (a repair, a replacement or a credit), on top of any legal guarantee and never in its place.",
  NONE: 'Out of cover: a repair or a replacement is a paid service or a courtesy; say why in the decision.',
})
export const remediesOf = (cover: Cover): string => REMEDIES[cover]

/** The warranty check of a case (design case.warranty "Legal 2-year guarantee or factory warranty, with why"). */
export function warrantyCheckOf(facts: WarrantyFacts): WarrantyCheck {
  const legal = legalReading(facts)
  const factory = factoryReading(facts)
  const words: string[] = []
  if (facts.deliveredOn) words.push(`Delivered on ${facts.deliveredOn}: the guarantees run from that day.`)
  else words.push('The delivery day is not known: type it (the guarantees run from it).')
  words.push(legal.words, factory.words)
  let presumption: WarrantyCheck['presumption'] = null
  if (facts.buyer === 'CONSUMER') {
    const until = facts.deliveredOn ? addYears(facts.deliveredOn, PRESUMPTION_YEARS) : null
    const applies = until !== null && daysBetween(facts.today, until) >= 0
    presumption = {
      applies,
      until,
      words: !until
        ? 'Within the first year after delivery a defect is presumed to have existed at delivery (Directive (EU) 2019/771 art. 11; Codice del Consumo art. 135).'
        : applies
          ? `Within 1 year of delivery (until ${until}): the defect is presumed to have existed at delivery; the customer need not prove it (Directive (EU) 2019/771 art. 11; Codice del Consumo art. 135).`
          : `More than 1 year after delivery (since ${until}): the customer shows the defect existed at delivery.`,
    }
    words.push(presumption.words)
  }
  let suggested: Cover | null
  if (legal.state === 'RUNS') suggested = 'LEGAL_GUARANTEE'
  else if (factory.state === 'RUNS') suggested = 'FACTORY_GUARANTEE'
  else if (legal.state === 'UNKNOWN' || (!facts.deliveredOn && factory.state === 'NONE')) suggested = null
  else suggested = 'NONE'
  const state: CoverState = suggested === null ? 'UNKNOWN' : suggested === 'NONE' ? 'OUT_OF_COVER' : suggested
  const liable =
    facts.buyer === 'CONSUMER'
      ? 'We sold to this consumer: we answer to them as the seller, for the legal guarantee and for our own.'
      : facts.buyer === 'BUSINESS'
        ? "The seller answers to the consumer; our duty to this business customer is the contract's (and our own guarantee, when it runs)."
        : 'The seller who sold the garment answers to the rider; we answer for our own guarantee.'
  return { buyer: facts.buyer, deliveredOn: facts.deliveredOn, legal, factory, presumption, suggested, state, remedies: suggested ? remediesOf(suggested) : 'The cover is not known until the delivery day is.', liable, words }
}

/** The cover as decided, when it is (a decision wins over the check's suggestion in the list). */
export const coverStateOf = (decided: Cover | null, check: Pick<WarrantyCheck, 'state'>): CoverState => (decided === null ? check.state : decided === 'NONE' ? 'OUT_OF_COVER' : decided)

const oneLine = (value: string): boolean => !/[\r\n]/.test(value)
const wordsOk = (value: string | null | undefined, max: number): boolean => value === null || value === undefined || (value.trim().length >= 1 && value.trim().length <= max)

/** The decision of a claim's cover in words (ServiceCase_guard: all or none; COVERED or PARTLY under a guarantee with its end; NOT_COVERED with NONE). */
export function coverProblems(input: { readonly cover: Cover; readonly decision: CoverDecision; readonly note: string; readonly legalGuaranteeEndsOn: BusinessDate | null; readonly factoryGuaranteeEndsOn: BusinessDate | null }): Issue[] {
  const problems: Issue[] = []
  if ((input.decision === 'COVERED' || input.decision === 'PARTLY') && input.cover === 'NONE') problems.push({ path: 'body/cover', message: 'Covered or partly covered: under the legal guarantee or the factory guarantee.' })
  if (input.decision === 'NOT_COVERED' && input.cover !== 'NONE') problems.push({ path: 'body/cover', message: 'Not covered: the cover is none (out of cover).' })
  if (input.cover === 'LEGAL_GUARANTEE' && !input.legalGuaranteeEndsOn) problems.push({ path: 'body/cover', message: "The legal guarantee's last day is not known: type the delivery day (or the guarantee's last day) first." })
  if (input.cover === 'FACTORY_GUARANTEE' && !input.factoryGuaranteeEndsOn) problems.push({ path: 'body/cover', message: "The factory guarantee's last day is not known: type it from the customer's terms first." })
  if (input.note.trim().length === 0) problems.push({ path: 'body/note', message: 'Say why, in words.' })
  else if (input.note.trim().length > CASE_LIMITS.coverNote) problems.push({ path: 'body/note', message: `At most ${CASE_LIMITS.coverNote} characters.` })
  return problems
}

/** What a decision may want to know before it is made (never a refusal: the person decides). */
export function coverWarnings(input: { readonly cover: Cover; readonly decision: CoverDecision; readonly check: WarrantyCheck }): Issue[] {
  const warnings: Issue[] = []
  if (input.cover === 'LEGAL_GUARANTEE' && input.check.legal.state === 'ENDED') warnings.push({ path: 'body/cover', message: `The legal guarantee ended on ${input.check.legal.endsOn}.` })
  if (input.cover === 'LEGAL_GUARANTEE' && input.check.buyer !== 'CONSUMER') warnings.push({ path: 'body/cover', message: 'The customer of this case is not a consumer we sold to: the legal guarantee is the seller’s toward the consumer (a dealer’s redress claim).' })
  if (input.cover === 'FACTORY_GUARANTEE' && input.check.factory.state === 'ENDED') warnings.push({ path: 'body/cover', message: `The factory guarantee ended on ${input.check.factory.endsOn}.` })
  if (input.decision === 'NOT_COVERED' && input.check.legal.state === 'RUNS') warnings.push({ path: 'body/decision', message: `The legal guarantee runs until ${input.check.legal.endsOn}: a refusal under it needs a reason the customer can check (misuse, wear, a cause after delivery).` })
  return warnings
}

// ---- the facts --------------------------------------------------------------------------------------------------------

export interface CaseFacts {
  readonly problem?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly size?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly deliveredOn?: BusinessDate | null | undefined
  readonly legalGuaranteeEndsOn?: BusinessDate | null | undefined
  readonly factoryGuaranteeEndsOn?: BusinessDate | null | undefined
}

/** The facts' shapes (ServiceCase_guard), at `body/<field>`; `creating`: the problem is required. */
export function factProblems(facts: CaseFacts, today: BusinessDate, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating || facts.problem !== undefined) {
    const problem = (facts.problem ?? '').trim()
    if (problem.length === 0) problems.push({ path: 'body/problem', message: "Say what is wrong, in the customer's words." })
    else if (problem.length > CASE_LIMITS.problem) problems.push({ path: 'body/problem', message: `At most ${CASE_LIMITS.problem} characters.` })
  }
  for (const field of ['serial', 'batchNumber'] as const) {
    const value = facts[field]
    if (value === null || value === undefined || value.trim() === '') continue
    if (!oneLine(value) || value.trim().length > CASE_LIMITS.label) problems.push({ path: `body/${field}`, message: `One line of at most ${CASE_LIMITS.label} characters.` })
  }
  if (facts.size && (!oneLine(facts.size) || facts.size.trim().length > CASE_LIMITS.size)) problems.push({ path: 'body/size', message: `One line of at most ${CASE_LIMITS.size} characters.` })
  if (!wordsOk(facts.internalNote === '' ? null : facts.internalNote, CASE_LIMITS.internalNote)) problems.push({ path: 'body/internalNote', message: `At most ${CASE_LIMITS.internalNote} characters.` })
  if (facts.deliveredOn && facts.deliveredOn > today) problems.push({ path: 'body/deliveredOn', message: 'The garment was delivered today or earlier.' })
  for (const field of ['legalGuaranteeEndsOn', 'factoryGuaranteeEndsOn'] as const) {
    const end = facts[field]
    if (end && facts.deliveredOn && end < facts.deliveredOn) problems.push({ path: `body/${field}`, message: 'A guarantee ends on or after the day the garment was delivered.' })
  }
  return problems
}

/** The first line of the customer's words, short (the list, a search result's subtitle never: those are the customer's words). */
export function summaryOf(problem: string, max = CASE_LIMITS.summary): string {
  const first = problem.trim().split(/\r?\n/)[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

// ---- the moves --------------------------------------------------------------------------------------------------------

export const HELD_CODES = ['NO_PERMISSION', 'CLOSED', 'NOT_NEW', 'ALREADY', 'NOT_FROM_HERE', 'NOT_RESOLVED', 'COVER_UNDECIDED', 'NO_CUSTOMER', 'NO_CONTACT_EMAIL'] as const
export type HeldCode = (typeof HELD_CODES)[number]

export interface MoveFacts {
  readonly from: CaseStatus
  readonly to: MoveTarget
  readonly kind: CaseKind
  readonly coverDecided: boolean
}

/** Why a move is held, or null: the code the screens show in words. */
export function moveHeld(facts: MoveFacts): HeldCode | null {
  if (facts.from === 'CLOSED') return 'CLOSED'
  if (facts.from === facts.to) return 'ALREADY'
  if (!moveAllowed(facts.from, facts.to)) return facts.from === 'NEW' ? 'NOT_NEW' : 'NOT_FROM_HERE'
  if (facts.to === 'RESOLVED' && facts.kind === 'WARRANTY' && !facts.coverDecided) return 'COVER_UNDECIDED'
  return null
}

const HELD_WORDS: Readonly<Record<HeldCode, string>> = Object.freeze({
  NO_PERMISSION: 'your role may not do this',
  CLOSED: 'is closed: it changes no more (open a new case)',
  NOT_NEW: 'is new: open it first',
  ALREADY: 'is there already',
  NOT_FROM_HERE: 'cannot move there from where it is',
  NOT_RESOLVED: 'is not resolved',
  COVER_UNDECIDED: 'is a warranty claim: decide its cover first (the remedy follows from it)',
  NO_CUSTOMER: 'names no customer of ours: name the customer first',
  NO_CONTACT_EMAIL: "names no contact with an e-mail: the status mails go to the customer's contact",
})
export const heldWords = (code: HeldCode): string => HELD_WORDS[code]

/** The words a move needs: what was done to resolve it; the reason to close one that was not resolved. */
export function moveProblems(input: { readonly from: CaseStatus; readonly to: MoveTarget; readonly resolution?: string | null | undefined; readonly reason?: string | null | undefined; readonly message?: string | null | undefined }): Issue[] {
  const problems: Issue[] = []
  const resolution = (input.resolution ?? '').trim()
  const reason = (input.reason ?? '').trim()
  if (input.to === 'RESOLVED') {
    if (resolution.length === 0) problems.push({ path: 'body/resolution', message: 'Say what was done, in words.' })
    else if (resolution.length > CASE_LIMITS.resolution) problems.push({ path: 'body/resolution', message: `At most ${CASE_LIMITS.resolution} characters.` })
  } else if (resolution.length > 0) problems.push({ path: 'body/resolution', message: 'A resolution goes with the move to resolved only.' })
  if (input.to === 'CLOSED' && input.from !== 'RESOLVED' && reason.length === 0) problems.push({ path: 'body/reason', message: 'Closed without a resolution: say why, in words.' })
  if (reason.length > CASE_LIMITS.closeReason) problems.push({ path: 'body/reason', message: `At most ${CASE_LIMITS.closeReason} characters.` })
  if (reason.length > 0 && input.to !== 'CLOSED') problems.push({ path: 'body/reason', message: 'A reason goes with the close only.' })
  if ((input.message ?? '').trim().length > CASE_LIMITS.message) problems.push({ path: 'body/message', message: `At most ${CASE_LIMITS.message} characters.` })
  return problems
}

// ---- the record's actions ---------------------------------------------------------------------------------------------

export const CASE_ACTIONS = ['edit', 'decideCover', 'open', 'waitCustomer', 'waitPart', 'resume', 'resolve', 'reopen', 'close', 'link', 'makeRepair', 'makeReturn', 'notify'] as const
export type CaseAction = (typeof CASE_ACTIONS)[number]

/** The move each move-action makes. */
export const MOVE_OF: Readonly<Partial<Record<CaseAction, MoveTarget>>> = Object.freeze({ open: 'OPEN', waitCustomer: 'WAITING_CUSTOMER', waitPart: 'WAITING_PART', resume: 'OPEN', resolve: 'RESOLVED', reopen: 'OPEN', close: 'CLOSED' })

export interface ActionFacts {
  readonly status: CaseStatus
  readonly kind: CaseKind
  readonly coverDecided: boolean
  readonly hasParty: boolean
  readonly hasContactEmail: boolean
  readonly notifyCustomer: boolean
  readonly may: Readonly<Record<CaseAction, boolean>>
}

function actionHeld(action: CaseAction, facts: ActionFacts): HeldCode | null {
  if (!facts.may[action]) return 'NO_PERMISSION'
  if (facts.status === 'CLOSED') return 'CLOSED'
  const to = MOVE_OF[action]
  if (to) {
    // One OPEN target, three doors: open (from NEW), resume (from waiting), reopen (from RESOLVED).
    if (action === 'open' && facts.status !== 'NEW') return facts.status === 'OPEN' ? 'ALREADY' : 'NOT_FROM_HERE'
    if (action === 'resume' && !isWaiting(facts.status)) return facts.status === 'OPEN' ? 'ALREADY' : 'NOT_FROM_HERE'
    if (action === 'reopen' && facts.status !== 'RESOLVED') return 'NOT_RESOLVED'
    return moveHeld({ from: facts.status, to, kind: facts.kind, coverDecided: facts.coverDecided })
  }
  if ((action === 'makeRepair' || action === 'makeReturn') && !facts.hasParty) return 'NO_CUSTOMER'
  if (action === 'notify' && !facts.notifyCustomer && !facts.hasContactEmail) return 'NO_CONTACT_EMAIL'
  return null
}

/** Every action of the record with whether it may be done now, and why not (design case.* bands and verbs). */
export function caseActions(facts: ActionFacts): { action: CaseAction; allowed: boolean; held: HeldCode | null }[] {
  return CASE_ACTIONS.map((action) => {
    const held = actionHeld(action, facts)
    return { action, allowed: held === null, held }
  })
}

// ---- links and the actions that open records --------------------------------------------------------------------------

/** The records a case may name by hand (design case.linked "Order, garment serial, dealer, RMA, repair"; a credit note is an Invoice). */
export const LINK_RECORD_TYPES = ['SalesOrder', 'Shipment', 'ReturnAuthorisation', 'RepairOrder', 'Invoice', 'Complaint', 'WorkOrder'] as const
export type LinkRecordType = (typeof LINK_RECORD_TYPES)[number]
/** How a link came: by hand, or by the case's action that opened the record. */
export const LINK_VIAS = ['LINK', 'REPAIR', 'RETURN', 'REMAKE', 'CREDIT'] as const
export type LinkVia = (typeof LINK_VIAS)[number]
/** What a return opened from a case is for: the goods back, a remake of the garment, or a credit (with or without the goods). */
export const RETURN_PURPOSES = ['RETURN', 'REMAKE', 'CREDIT'] as const
export type ReturnPurpose = (typeof RETURN_PURPOSES)[number]

export const linkNoteProblems = (note: string | null | undefined): Issue[] =>
  note === null || note === undefined || note.trim() === '' ? [] : !oneLine(note) || note.trim().length > CASE_LIMITS.linkNote ? [{ path: 'body/note', message: `One line of at most ${CASE_LIMITS.linkNote} characters.` }] : []

/** The link's note a case's action writes (one line). */
export function actionLinkNote(via: Exclude<LinkVia, 'LINK'>, number: string): string {
  switch (via) {
    case 'REPAIR':
      return `Repair ${number} opened from the case.`
    case 'RETURN':
      return `Return ${number} opened from the case: the goods come back.`
    case 'REMAKE':
      return `Return ${number} opened from the case for a remake.`
    case 'CREDIT':
      return `Return ${number} opened from the case for a credit.`
  }
}
