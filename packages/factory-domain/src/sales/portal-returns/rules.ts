import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { STAGES, type CapaStatus, type CapaType } from '../../quality/capa/rules'
import { COMPLAINT_LIMITS, type ComplaintStatus } from '../../quality/complaints/rules'
import { RETURN_LIMITS, type ReturnDisposition, type ReturnGrade, type ReturnStatus } from '../returns/rules'

/**
 * Returns and complaints from outside (B-W2b-192; SAL-334, SAL-424; design portal.customer.returns "Returns & claims" and
 * links.claim "Report a problem"), pure: what the customer reads of a return (RMA) or a complaint, in their words, and the
 * checks of what they send.
 *
 *   a case        a return request (W2a ReturnAuthorisation, REQUESTED until the office authorises it) or a quality
 *                 complaint (W2a Complaint, channel PORTAL or LINK); the customer's list shows both, the next step first
 *   next step     what the customer does now ("Print the return instructions and send it back by 30 Oct"), or what the
 *                 factory does ("We answer within 2 working days"); `forYou` says whose move it is (the "Waiting for you"
 *                 chip)
 *   where it is   a return: Asked · Decided · Back with us · Inspected · Outcome, each DONE (with its day), CURRENT, TODO
 *                 or SKIPPED; a complaint: Received · Being investigated · Answered · Closed, and the 8D's disciplines
 *                 when the factory runs one for it (D1–D8 with the day each was reached)
 *   outcome       per line, in customer words: repaired, made again, replaced, a credit note, sent back unchanged, not
 *                 sent back; never the internal cause, a cost or a note of the office
 *
 * Never money here: the credit note is named by its number (the price grain decides in the API whether it is shown).
 */

export type Locale = 'it' | 'en'
export interface Words {
  readonly it: string
  readonly en: string
}

export const CASE_TYPES = ['RETURN', 'COMPLAINT'] as const
export type CaseType = (typeof CASE_TYPES)[number]

/** What the customer would like (design rec Return › Request "outcome wanted (replace / repair / credit)"). */
export const OUTCOMES_WANTED = ['REPLACE', 'REPAIR', 'CREDIT'] as const
export type OutcomeWanted = (typeof OUTCOMES_WANTED)[number]
export const OUTCOME_WANTED_WORDS: Readonly<Record<OutcomeWanted, Words>> = Object.freeze({
  REPLACE: { en: 'A replacement', it: 'Una sostituzione' },
  REPAIR: { en: 'A repair', it: 'Una riparazione' },
  CREDIT: { en: 'A credit note', it: 'Una nota di credito' },
})

/** The list's chips (design cases "Chips: Open (default) · Waiting for you · Closed"). */
export const CASE_CHIPS = ['OPEN', 'WAITING', 'CLOSED', 'ALL'] as const
export type CaseChip = (typeof CASE_CHIPS)[number]

export const CASE_LIMITS = Object.freeze({
  lines: RETURN_LIMITS.lines,
  reasonNote: RETURN_LIMITS.reasonNote,
  serial: RETURN_LIMITS.serial,
  customerRef: RETURN_LIMITS.customerRef,
  /** The customer's words about the whole request. */
  note: 2000,
  description: COMPLAINT_LIMITS.description,
  /** Photos the customer adds to one case (a line or the request), at most. */
  photos: 10,
  /** A claim link made from one tracking link: at most this many live at once (each is a new link to a shipment). */
  claimLinksFromTracking: 3,
  /** The customer's list: at most this many cases in one answer (a customer has far fewer). */
  list: 500,
})

/** The working days within which the factory answers a request (design links.claim done "We answer within 2 working days"). */
export const ANSWER_WORKING_DAYS = 2

const dayWords = (day: BusinessDate, locale: Locale): string => (locale === 'it' ? day.split('-').reverse().join('/') : day)

// ---- a return in customer words -------------------------------------------------------------------------------------

export const RETURN_CASE_STATES = ['REQUESTED', 'SEND_IT_BACK', 'BACK_WITH_US', 'INSPECTED', 'DONE', 'NOT_ACCEPTED', 'CANCELLED'] as const
export type ReturnCaseState = (typeof RETURN_CASE_STATES)[number]

const RETURN_STATE_OF: Readonly<Record<ReturnStatus, ReturnCaseState>> = Object.freeze({
  REQUESTED: 'REQUESTED',
  AUTHORISED: 'SEND_IT_BACK',
  RECEIVED: 'BACK_WITH_US',
  INSPECTED: 'INSPECTED',
  CLOSED: 'DONE',
  REJECTED: 'NOT_ACCEPTED',
  CANCELLED: 'CANCELLED',
})

export const RETURN_STATE_WORDS: Readonly<Record<ReturnCaseState, Words>> = Object.freeze({
  REQUESTED: { en: 'Requested', it: 'Richiesto' },
  SEND_IT_BACK: { en: 'Approved — send it back', it: 'Approvato — da rispedire' },
  BACK_WITH_US: { en: 'Back with us', it: 'Arrivato da noi' },
  INSPECTED: { en: 'Inspected', it: 'Controllato' },
  DONE: { en: 'Closed', it: 'Chiuso' },
  NOT_ACCEPTED: { en: 'Not accepted', it: 'Non accettato' },
  CANCELLED: { en: 'Cancelled', it: 'Annullato' },
})

export const returnStateOf = (status: ReturnStatus): ReturnCaseState => RETURN_STATE_OF[status]
export const isOpenReturn = (status: ReturnStatus): boolean => status === 'REQUESTED' || status === 'AUTHORISED' || status === 'RECEIVED' || status === 'INSPECTED'

export interface NextStep {
  /** The customer's move (the "Waiting for you" chip), or the factory's. */
  readonly forYou: boolean
  readonly code: string
  readonly words: Words
}

export interface ReturnFacts {
  readonly status: ReturnStatus
  readonly goodsDueBy: BusinessDate | null
  /** The day the factory answers by (REQUESTED: the request's day plus ANSWER_WORKING_DAYS of the company's calendar). */
  readonly answerBy: BusinessDate | null
  /** The reason the office gave a rejection (the customer reads it). */
  readonly rejectReason: string | null
  /** The office asked the customer something on this case (an OPEN partner task). */
  readonly openTask: boolean
  /** What the decided lines give the customer, once decided. */
  readonly dispositions: readonly ReturnDisposition[]
}

/** What happens next on a return, in the customer's words. */
export function returnNextStep(facts: ReturnFacts): NextStep {
  if (facts.openTask && isOpenReturn(facts.status)) return { forYou: true, code: 'ANSWER_US', words: { en: 'We asked you something: answer us in the messages.', it: 'Ti abbiamo chiesto qualcosa: rispondici nei messaggi.' } }
  switch (facts.status) {
    case 'REQUESTED':
      return {
        forYou: false,
        code: 'WE_DECIDE',
        words: facts.answerBy
          ? { en: `We look at your request and answer by ${dayWords(facts.answerBy, 'en')}.`, it: `Esaminiamo la richiesta e rispondiamo entro il ${dayWords(facts.answerBy, 'it')}.` }
          : { en: 'We look at your request and answer soon.', it: 'Esaminiamo la richiesta e rispondiamo a breve.' },
      }
    case 'AUTHORISED':
      return {
        forYou: true,
        code: 'SEND_IT_BACK',
        words: facts.goodsDueBy
          ? { en: `Print the return instructions and send it back by ${dayWords(facts.goodsDueBy, 'en')}.`, it: `Stampa le istruzioni di reso e rispediscilo entro il ${dayWords(facts.goodsDueBy, 'it')}.` }
          : { en: 'Print the return instructions and send it back.', it: 'Stampa le istruzioni di reso e rispediscilo.' },
      }
    case 'RECEIVED':
      return { forYou: false, code: 'WE_INSPECT', words: { en: 'We received the goods and are inspecting them.', it: 'Abbiamo ricevuto la merce e la stiamo controllando.' } }
    case 'INSPECTED':
      return { forYou: false, code: 'WE_CARRY_OUT', words: outcomeSentence(facts.dispositions) }
    case 'CLOSED':
      return { forYou: false, code: 'DONE', words: { en: 'Closed.', it: 'Chiuso.' } }
    case 'REJECTED':
      return {
        forYou: false,
        code: 'NOT_ACCEPTED',
        words: facts.rejectReason ? { en: `Not accepted: ${facts.rejectReason}`, it: `Non accettato: ${facts.rejectReason}` } : { en: 'Not accepted.', it: 'Non accettato.' },
      }
    case 'CANCELLED':
      return { forYou: false, code: 'CANCELLED', words: { en: 'Cancelled.', it: 'Annullato.' } }
  }
}

/** What a decided line gives the customer (never the internal cause, a stock move or an amount). */
export const DISPOSITION_WORDS: Readonly<Record<ReturnDisposition, Words>> = Object.freeze({
  REPAIR: { en: 'We repair it and send it back', it: 'Lo ripariamo e te lo rispediamo' },
  REMAKE: { en: 'We make it again', it: 'Lo rifacciamo' },
  REPLACE: { en: 'A replacement', it: 'Una sostituzione' },
  CREDIT_ONLY: { en: 'A credit note', it: 'Una nota di credito' },
  RETURN_UNCHANGED: { en: 'Sent back to you as it came', it: 'Ti viene rispedito com’è arrivato' },
  SCRAP: { en: 'Not sent back', it: 'Non viene rispedito' },
})

/** The inspection's grade in customer words (the cause found is the office's). */
export const GRADE_WORDS: Readonly<Record<ReturnGrade, Words>> = Object.freeze({
  NEW: { en: 'As new', it: 'Come nuovo' },
  LIKE_NEW: { en: 'Like new', it: 'Quasi nuovo' },
  GOOD: { en: 'Good, used', it: 'Buono, usato' },
  DAMAGED: { en: 'Damaged', it: 'Danneggiato' },
  UNUSABLE: { en: 'Not usable', it: 'Non utilizzabile' },
})

function outcomeSentence(dispositions: readonly ReturnDisposition[]): Words {
  const kinds = [...new Set(dispositions)]
  if (kinds.length === 0) return { en: 'Inspected: we decide what happens next.', it: 'Controllato: decidiamo come procedere.' }
  const join = (locale: Locale) => kinds.map((kind) => DISPOSITION_WORDS[kind][locale].toLowerCase()).join(locale === 'it' ? '; ' : '; ')
  return { en: `Inspected: ${join('en')}.`, it: `Controllato: ${join('it')}.` }
}

export const MILESTONE_STEPS = ['ASKED', 'DECIDED', 'BACK_WITH_US', 'INSPECTED', 'OUTCOME'] as const
export type MilestoneStep = (typeof MILESTONE_STEPS)[number]
export type MilestoneState = 'DONE' | 'CURRENT' | 'TODO' | 'SKIPPED'

export interface Milestone {
  readonly step: MilestoneStep
  readonly state: MilestoneState
  /** When it was reached (an ISO instant), for DONE. */
  readonly at: string | null
  readonly words: Words
}

export const MILESTONE_WORDS: Readonly<Record<MilestoneStep, Words>> = Object.freeze({
  ASKED: { en: 'Asked', it: 'Richiesto' },
  DECIDED: { en: 'Decided', it: 'Deciso' },
  BACK_WITH_US: { en: 'Back with us', it: 'Arrivato da noi' },
  INSPECTED: { en: 'Inspected', it: 'Controllato' },
  OUTCOME: { en: 'Outcome', it: 'Esito' },
})

export interface MilestoneFacts {
  readonly status: ReturnStatus
  readonly requestedAt: string
  readonly authorisedAt: string | null
  readonly receivedAt: string | null
  readonly inspectedAt: string | null
  readonly closedAt: string | null
}

/** Where a return is (design rec Return › Status "MilestoneTracker: Received · Decided · Back with us · Inspected · Outcome"). */
export function returnMilestones(facts: MilestoneFacts): Milestone[] {
  const ended = facts.status === 'REJECTED' || facts.status === 'CANCELLED'
  const reached: Record<MilestoneStep, string | null> = {
    ASKED: facts.requestedAt,
    DECIDED: facts.authorisedAt ?? (facts.status === 'REJECTED' ? facts.closedAt : null),
    BACK_WITH_US: facts.receivedAt,
    INSPECTED: facts.inspectedAt,
    OUTCOME: facts.status === 'CLOSED' ? facts.closedAt : null,
  }
  let current = false
  return MILESTONE_STEPS.map((step) => {
    const at = reached[step]
    if (at) return { step, state: 'DONE' as const, at, words: MILESTONE_WORDS[step] }
    if (ended || (facts.status === 'CLOSED' && step !== 'OUTCOME')) return { step, state: 'SKIPPED' as const, at: null, words: MILESTONE_WORDS[step] }
    const state: MilestoneState = current ? 'TODO' : 'CURRENT'
    current = true
    return { step, state, at: null, words: MILESTONE_WORDS[step] }
  })
}

/** The words of the decision (design "Decision in words ('Approved: send it back by 30 Oct')"); null before it. */
export function decisionWords(facts: Pick<ReturnFacts, 'status' | 'goodsDueBy' | 'rejectReason'> & { readonly authorised: boolean }): Words | null {
  if (facts.authorised) {
    return facts.goodsDueBy
      ? { en: `Approved: send it back by ${dayWords(facts.goodsDueBy, 'en')}.`, it: `Approvato: rispediscilo entro il ${dayWords(facts.goodsDueBy, 'it')}.` }
      : { en: 'Approved: send it back.', it: 'Approvato: rispediscilo.' }
  }
  if (facts.status === 'REJECTED') return facts.rejectReason ? { en: `Not accepted: ${facts.rejectReason}`, it: `Non accettato: ${facts.rejectReason}` } : { en: 'Not accepted.', it: 'Non accettato.' }
  return null
}

/** Why the customer may not cancel a return now (null: it may): only before the goods leave them. */
export function cancelHeld(status: ReturnStatus): Words | null {
  if (status === 'REQUESTED' || status === 'AUTHORISED') return null
  if (status === 'RECEIVED' || status === 'INSPECTED') return { en: 'The goods are with us already: write to us in the messages instead.', it: 'La merce è già da noi: scrivici nei messaggi.' }
  return { en: 'This return is closed already.', it: 'Questo reso è già chiuso.' }
}

/** Whether the customer may still add photos or words: before the factory decided. */
export const returnTakesPhotos = (status: ReturnStatus): boolean => status === 'REQUESTED' || status === 'AUTHORISED' || status === 'RECEIVED'

// ---- a complaint in customer words ----------------------------------------------------------------------------------

export const COMPLAINT_CASE_STATES = ['RECEIVED', 'INVESTIGATING', 'ANSWERED', 'CLOSED'] as const
export type ComplaintCaseState = (typeof COMPLAINT_CASE_STATES)[number]

const COMPLAINT_STATE_OF: Readonly<Record<ComplaintStatus, ComplaintCaseState>> = Object.freeze({
  NEW: 'RECEIVED',
  TRIAGED: 'INVESTIGATING',
  INVESTIGATING: 'INVESTIGATING',
  ANSWERED: 'ANSWERED',
  CLOSED: 'CLOSED',
})

export const COMPLAINT_STATE_WORDS: Readonly<Record<ComplaintCaseState, Words>> = Object.freeze({
  RECEIVED: { en: 'Received', it: 'Ricevuto' },
  INVESTIGATING: { en: 'Being investigated', it: 'In analisi' },
  ANSWERED: { en: 'Answered', it: 'Risposto' },
  CLOSED: { en: 'Closed', it: 'Chiuso' },
})

export const complaintStateOf = (status: ComplaintStatus): ComplaintCaseState => COMPLAINT_STATE_OF[status]

export interface ComplaintFacts {
  readonly status: ComplaintStatus
  /** The day the answer is due (set by quality at triage); before it: the received day plus ANSWER_WORKING_DAYS. */
  readonly answerBy: BusinessDate | null
  readonly openTask: boolean
  /** The person may read the answer letter (portal.complaints.view, or the claim link that opened it). */
  readonly readsAnswer: boolean
}

export function complaintNextStep(facts: ComplaintFacts): NextStep {
  if (facts.openTask && facts.status !== 'CLOSED') return { forYou: true, code: 'ANSWER_US', words: { en: 'We asked you something: answer us in the messages.', it: 'Ti abbiamo chiesto qualcosa: rispondici nei messaggi.' } }
  switch (facts.status) {
    case 'NEW':
    case 'TRIAGED':
    case 'INVESTIGATING':
      return {
        forYou: false,
        code: 'WE_INVESTIGATE',
        words: facts.answerBy
          ? { en: `We look into it and answer by ${dayWords(facts.answerBy, 'en')}.`, it: `Lo analizziamo e rispondiamo entro il ${dayWords(facts.answerBy, 'it')}.` }
          : { en: 'We look into it and answer soon.', it: 'Lo analizziamo e rispondiamo a breve.' },
      }
    case 'ANSWERED':
      return facts.readsAnswer
        ? { forYou: true, code: 'READ_ANSWER', words: { en: 'We answered: read our letter.', it: 'Abbiamo risposto: leggi la nostra lettera.' } }
        : { forYou: false, code: 'ANSWERED', words: { en: 'We answered your quality contact.', it: 'Abbiamo risposto al vostro referente qualità.' } }
    case 'CLOSED':
      return { forYou: false, code: 'DONE', words: { en: 'Closed.', it: 'Chiuso.' } }
  }
}

/** Whether the customer may still add photos to a complaint: until it is answered. */
export const complaintTakesPhotos = (status: ComplaintStatus): boolean => status === 'NEW' || status === 'TRIAGED' || status === 'INVESTIGATING'

// ---- the 8D's disciplines the customer follows ----------------------------------------------------------------------

const DISCIPLINE_WORDS: Readonly<Partial<Record<CapaStatus, Words>>> = Object.freeze({
  D1: { en: 'D1 Team', it: 'D1 Team' },
  D2: { en: 'D2 Problem described', it: 'D2 Descrizione del problema' },
  D3: { en: 'D3 Containment', it: 'D3 Contenimento' },
  D4: { en: 'D4 Root cause', it: 'D4 Causa radice' },
  D5: { en: 'D5 Corrective actions chosen', it: 'D5 Azioni correttive scelte' },
  D6: { en: 'D6 Corrective actions in place', it: 'D6 Azioni correttive attuate' },
  D7: { en: 'D7 Prevention', it: 'D7 Prevenzione' },
  D8: { en: 'D8 Closure', it: 'D8 Chiusura' },
  PLAN: { en: 'Plan', it: 'Pianificazione' },
  ACT: { en: 'Act', it: 'Attuazione' },
  CHECK: { en: 'Check', it: 'Verifica' },
})

export interface Discipline {
  readonly stage: CapaStatus
  readonly state: 'DONE' | 'CURRENT' | 'TODO'
  /** The day the stage was left (DONE) or reached (CURRENT), when known. */
  readonly on: BusinessDate | null
  readonly words: Words
}

/**
 * The investigation's steps of a complaint's CAPA (design rec Status › complaint-8d "D1–D8 with done dates"): every stage of
 * its type, the ones before the current DONE, the current one CURRENT, the rest TODO; a closed CAPA has them all DONE. A
 * cancelled one shows none (null). `reached` = the day each stage was first reached (the CAPA's audit rows).
 */
export function disciplinesOf(type: CapaType, status: CapaStatus, reached: ReadonlyMap<string, BusinessDate>): Discipline[] | null {
  if (status === 'CANCELLED') return null
  const stages = STAGES[type]
  const at = status === 'CLOSED' ? stages.length : stages.indexOf(status)
  return stages.map((stage, index) => {
    const state = index < at ? 'DONE' : index === at ? 'CURRENT' : 'TODO'
    const next = stages[index + 1]
    const on = state === 'DONE' ? ((next ? reached.get(next) : reached.get('CLOSED')) ?? null) : state === 'CURRENT' ? (reached.get(stage) ?? null) : null
    return { stage, state, on, words: DISCIPLINE_WORDS[stage] ?? { en: stage, it: stage } }
  })
}

/** The stage a list shows ("8D step reached"), or null. */
export function stageReachedWords(type: CapaType, status: CapaStatus): Words | null {
  if (status === 'CANCELLED') return null
  if (status === 'CLOSED') return { en: type === 'EIGHT_D' ? 'D8 Closure — done' : 'Done', it: type === 'EIGHT_D' ? 'D8 Chiusura — fatto' : 'Fatto' }
  return DISCIPLINE_WORDS[status] ?? null
}

// ---- what the customer sends ----------------------------------------------------------------------------------------

export interface RequestLine {
  readonly invoiceLineId?: string | null | undefined
  readonly salesOrderLineId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly quantity: number
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  readonly serial?: string | null | undefined
}

export interface ReturnRequestDraft {
  readonly lines: readonly RequestLine[]
  readonly outcomeWanted?: OutcomeWanted | null | undefined
  readonly customerRef?: string | null | undefined
  readonly note?: string | null | undefined
}

const tooLong = (value: string | null | undefined, max: number): boolean => (value ?? '').trim().length > max

/** The shape of a return request (what the API checks against what was sold comes after): problems at body/<field>. */
export function returnRequestProblems(draft: ReturnRequestDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.lines.length === 0) problems.push({ path: 'body/lines', message: 'Pick at least one item that comes back.' })
  if (draft.lines.length > CASE_LIMITS.lines) problems.push({ path: 'body/lines', message: `At most ${CASE_LIMITS.lines} items in one request.` })
  for (const [index, line] of draft.lines.slice(0, CASE_LIMITS.lines).entries()) {
    const at = (field: string) => `body/lines/${index}/${field}`
    if (!line.invoiceLineId && !line.salesOrderLineId) problems.push({ path: at('salesOrderLineId'), message: 'Pick the item from what you received.' })
    if (!Number.isInteger(line.quantity) || line.quantity < 1) problems.push({ path: at('quantity'), message: 'One piece or more.' })
    if (!line.reasonCode || line.reasonCode.trim() === '') problems.push({ path: at('reasonCode'), message: 'Say why it comes back.' })
    if (tooLong(line.reasonNote, CASE_LIMITS.reasonNote)) problems.push({ path: at('reasonNote'), message: `At most ${CASE_LIMITS.reasonNote} characters.` })
    if (tooLong(line.serial, CASE_LIMITS.serial)) problems.push({ path: at('serial'), message: `At most ${CASE_LIMITS.serial} characters.` })
  }
  if (tooLong(draft.customerRef, CASE_LIMITS.customerRef)) problems.push({ path: 'body/customerRef', message: `At most ${CASE_LIMITS.customerRef} characters.` })
  if (tooLong(draft.note, CASE_LIMITS.note)) problems.push({ path: 'body/note', message: `At most ${CASE_LIMITS.note} characters.` })
  return problems
}

export interface ComplaintDraft {
  readonly description?: string | null | undefined
  readonly salesOrderLineId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly customerRef?: string | null | undefined
}

/** The shape of a quality complaint from outside: problems at body/<field>. */
export function complaintRequestProblems(draft: ComplaintDraft): Issue[] {
  const problems: Issue[] = []
  const words = (draft.description ?? '').trim()
  if (words === '') problems.push({ path: 'body/description', message: 'Tell us what happened.' })
  if (words.length > CASE_LIMITS.description) problems.push({ path: 'body/description', message: `At most ${CASE_LIMITS.description} characters.` })
  if (tooLong(draft.size, COMPLAINT_LIMITS.size)) problems.push({ path: 'body/size', message: `At most ${COMPLAINT_LIMITS.size} characters.` })
  if (tooLong(draft.serial, COMPLAINT_LIMITS.serial)) problems.push({ path: 'body/serial', message: `At most ${COMPLAINT_LIMITS.serial} characters.` })
  if (tooLong(draft.batchNumber, COMPLAINT_LIMITS.batchNumber)) problems.push({ path: 'body/batchNumber', message: `At most ${COMPLAINT_LIMITS.batchNumber} characters.` })
  if (tooLong(draft.customerRef, COMPLAINT_LIMITS.customerRef)) problems.push({ path: 'body/customerRef', message: `At most ${COMPLAINT_LIMITS.customerRef} characters.` })
  return problems
}

/** The end state's words (design links.claim done "Case C-2026-0019 opened. We answer within 2 working days."). */
export function sentWords(type: CaseType, number: string, answerBy: BusinessDate | null): Words {
  const what = type === 'RETURN' ? { en: 'Return request', it: 'Richiesta di reso' } : { en: 'Complaint', it: 'Reclamo' }
  return answerBy
    ? { en: `${what.en} ${number} opened. We answer by ${dayWords(answerBy, 'en')}.`, it: `${what.it} ${number} aperto. Rispondiamo entro il ${dayWords(answerBy, 'it')}.` }
    : { en: `${what.en} ${number} opened. We answer within ${ANSWER_WORKING_DAYS} working days.`, it: `${what.it} ${number} aperto. Rispondiamo entro ${ANSWER_WORKING_DAYS} giorni lavorativi.` }
}

/** The chip a case falls under. */
export function chipOf(entry: { readonly open: boolean; readonly forYou: boolean }): Exclude<CaseChip, 'ALL'>[] {
  if (!entry.open) return ['CLOSED']
  return entry.forYou ? ['OPEN', 'WAITING'] : ['OPEN']
}

export const inChip = (chip: CaseChip, entry: { readonly open: boolean; readonly forYou: boolean }): boolean => chip === 'ALL' || chipOf(entry).includes(chip)

// ---- the office's publishing of an answer and sharing of an 8D ------------------------------------------------------

export interface PublishFacts {
  readonly status: ComplaintStatus
  readonly answerText: string | null
  readonly answerLanguage: string | null
  /** The customer's portal is on (PortalSettings.portalOn). */
  readonly portalOn: boolean
  readonly channel: string
}

/** Why the answer may not be published to the customer now (null: it may), in words. */
export function publishHeld(facts: PublishFacts): { readonly code: string; readonly words: string } | null {
  if (facts.status === 'CLOSED') return { code: 'CLOSED', words: 'The complaint is closed: it changes no more.' }
  if (facts.status === 'NEW') return { code: 'NOT_TRIAGED', words: 'The complaint is new: triage it first.' }
  if (facts.status === 'ANSWERED') return { code: 'ANSWER_SENT', words: 'The complaint is answered: its letter changes once it goes back to investigating.' }
  if (!facts.answerText || facts.answerText.trim() === '' || !facts.answerLanguage) return { code: 'NO_ANSWER', words: "The letter has no words yet: write it first." }
  if (!facts.portalOn && facts.channel !== 'LINK') return { code: 'NO_PORTAL', words: "The customer has no portal and did not write by a claim link: send the answer by e-mail." }
  return null
}

/**
 * Why an 8D may not be shared with the complaint's customer now (null: it may). A closed complaint may still get it: the 8D
 * often closes (D8) after the answer went out, and the copy is a file of the complaint, not a change of it.
 */
export function shareHeld(facts: { readonly capaType: CapaType | null; readonly reportFileId: string | null }): { readonly code: string; readonly words: string } | null {
  if (!facts.capaType) return { code: 'NO_CAPA', words: 'No CAPA or 8D was opened from this complaint: escalate it first.' }
  if (!facts.reportFileId) return { code: 'NO_REPORT', words: "The 8D has no report kept yet: keep a version on the CAPA's Report tab first." }
  return null
}
