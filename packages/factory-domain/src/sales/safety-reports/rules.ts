import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Product-safety reports and the accident log (B-W2b-351; SAL-414 the intake, SAL-415 serial, photos and injury kept apart,
 * SAL-423 the accident log for GPSR notices; design links.claim "Safety", portal.customer.returns "Report a safety incident",
 * links.doc "Report a problem", compliance.register "Accident log"), pure. apps/factory-api's modules/sales/safety-reports says
 * these rules in words before the …_service_safety_w2b_guards triggers would refuse the same.
 *
 *   the report     from the public DoC page (the batch from the QR, no sign-in), a customer's portal, or the office (a call, a
 *                  visit, a mail); numbered PSR-… from the company's SAFETY_REPORT series; the garment (serial or batch, style,
 *                  size), what happened and when, whether it was worn as intended, photos; NEW → ASSESSING | CLOSED,
 *                  ASSESSING → CLOSED; seen once by quality before it is assessed. Each report opens a SAFETY service case in
 *                  the same command, so it never waits in a mailbox.
 *   the injury     whether someone was hurt and in what words: special-category data (GDPR art. 9) in a table of its own (one
 *                  row per report); the words only when someone was hurt and with the reporter's explicit consent (the tick's
 *                  time); read only by the product-safety role (sales.safety.injury), each opening recorded; never in a list,
 *                  an export, a mail, a search entry, a thread or an audit row; erased on request (the words blanked, never back).
 *   the log        an accident (or anyone hurt) is entered in the accident log in the same command (revision 1: the day, the
 *                  place, the product, what came of it coarsely, never the injury's words); a later revision corrects or
 *                  completes it with why, and records when the market surveillance authority was told (GPSR art. 20: an accident
 *                  that caused a death or serious adverse effects on health). Whether GPSR reaches PPE is the Owner's open
 *                  question (Q37): the log is kept either way.
 *   the doors      the public and portal doors stay OFF until the privacy notice for these reports is published (GATE-PRIVACY):
 *                  the office types a report from a mail meanwhile.
 */

export const SAFETY_REPORT_RECORD = 'ProductSafetyReport' as const
export const SAFETY_INJURY_RECORD = 'ProductSafetyInjury' as const
export const ACCIDENT_LOG_RECORD = 'AccidentLogEntry' as const
export const SAFETY_NUMBER_KIND = 'SAFETY_REPORT' as const

export const SAFETY_SOURCES = ['PUBLIC_LINK', 'PORTAL', 'OFFICE', 'MAIL'] as const
export type SafetySource = (typeof SAFETY_SOURCES)[number]
/** The office's own doors (a call or a visit; a mail). */
export const OFFICE_SOURCES = ['OFFICE', 'MAIL'] as const satisfies readonly SafetySource[]
export type OfficeSource = (typeof OFFICE_SOURCES)[number]

export const REPORT_STATUSES = ['NEW', 'ASSESSING', 'CLOSED'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]
export const MOVE_TARGETS = ['ASSESSING', 'CLOSED'] as const satisfies readonly ReportStatus[]
export type MoveTarget = (typeof MOVE_TARGETS)[number]

export const ACCIDENT_OUTCOMES = ['NO_HARM', 'MINOR_HARM', 'SERIOUS_HARM', 'DEATH', 'NOT_KNOWN'] as const
export type AccidentOutcome = (typeof ACCIDENT_OUTCOMES)[number]
/** The outcomes GPSR art. 20 asks the authority to be told of (a death, serious adverse effects on health). */
export const NOTIFIABLE_OUTCOMES = ['SERIOUS_HARM', 'DEATH'] as const satisfies readonly AccidentOutcome[]

/** The saved rows of the list. */
export const REPORT_VIEWS = ['open', 'new', 'assessing', 'closed', 'all'] as const
export type SavedView = (typeof REPORT_VIEWS)[number]

export const SAFETY_LIMITS = Object.freeze({
  whatHappened: 4000,
  injuryWords: 2000,
  closeNote: 2000,
  place: 300,
  reference: 200,
  reporterName: 200,
  email: 254,
  label: 100,
  size: 20,
  note: 2000,
  eraseReason: 500,
  /** A list page at most; the default page. */
  list: 200,
  page: 50,
  /** Photos per report (the API's). */
  photos: 6,
  /** How long after its send a public or portal report takes its photos. */
  outsidePhotoMinutes: 120,
  /** Reports a network sends by the public door in an hour (on top of the abuse guard's lookups). */
  publicPerHour: 5,
  /** The accident log rows one read looks at (accidents are rare). */
  logRead: 2000,
})

export const injuryKeyOf = (reportId: string): string => `injury:${reportId}`

const STATUS_WORDS: Readonly<Record<ReportStatus, string>> = Object.freeze({ NEW: 'new', ASSESSING: 'being assessed', CLOSED: 'closed' })
export const statusWords = (status: ReportStatus): string => STATUS_WORDS[status]

export const SOURCE_WORDS: Readonly<Record<SafetySource, string>> = Object.freeze({
  PUBLIC_LINK: 'the public DoC page',
  PORTAL: "the customer's portal",
  OFFICE: 'a call or a visit',
  MAIL: 'a mail',
})

export const OUTCOME_WORDS: Readonly<Record<AccidentOutcome, string>> = Object.freeze({
  NO_HARM: 'nobody was hurt',
  MINOR_HARM: 'minor harm',
  SERIOUS_HARM: 'serious harm to health',
  DEATH: 'a death',
  NOT_KNOWN: 'not known yet',
})

/** The law the screens cite (LawRef chips). */
export const SAFETY_LAW = Object.freeze({
  intake: 'Reg. (EU) 2023/988 (GPSR) art. 19, Reg. (EU) 2016/425 art. 8(4)',
  injury: 'GDPR art. 9(2)(a): health data kept only with explicit consent',
  log: 'Reg. (EU) 2023/988 (GPSR) art. 20',
  q37: "Whether GPSR's complaint and accident duties reach PPE is the Owner's open question (Q37): the accident log is kept either way.",
})

const oneLine = (value: string): boolean => !/[\r\n]/.test(value)
/** No control character but a line break (the database's factory_recall_words_ok with lines). */
const cleanText = (value: string): boolean => !/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const cleanLine = (value: string): boolean => oneLine(value) && !/[\x00-\x1f\x7f]/.test(value)
const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''

export const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const PHONE_SHAPE = /^\+?[0-9][0-9 ()./-]{4,39}$/

/** What a report says when it is sent, whatever the door. */
export interface IntakeFacts {
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly size?: string | null | undefined
  readonly occurredOn?: BusinessDate | null | undefined
  readonly place?: string | null | undefined
  readonly whatHappened?: string | null | undefined
  readonly accident?: boolean | null | undefined
  readonly injured?: boolean | null | undefined
  readonly injuryConsent?: boolean | null | undefined
  readonly injuryWords?: string | null | undefined
  readonly reporter?: { readonly name?: string | null | undefined; readonly email?: string | null | undefined; readonly phone?: string | null | undefined } | null | undefined
}

/** An accident to enter in the log: the reporter said it was one, or someone was hurt. */
export const accidentNeeded = (facts: Pick<IntakeFacts, 'accident' | 'injured'>): boolean => facts.accident === true || facts.injured === true

/** What came of it at the intake, coarsely: nobody hurt, else not known yet (quality grades it in a later revision). */
export const intakeOutcomeOf = (injured: boolean | null | undefined): AccidentOutcome => (injured === false ? 'NO_HARM' : 'NOT_KNOWN')

/**
 * The intake's problems in words (body/<field>). `outside`: the public and portal doors ask whether anyone was hurt (yes or no)
 * and the garment's serial or batch; the office may leave the injury unsaid (a mail that does not say).
 */
export function intakeProblems(facts: IntakeFacts, today: BusinessDate, outside: boolean): Issue[] {
  const problems: Issue[] = []
  const what = (facts.whatHappened ?? '').trim()
  if (what.length === 0) problems.push({ path: 'body/whatHappened', message: 'Say what happened, and to the garment.' })
  else if (what.length > SAFETY_LIMITS.whatHappened || !cleanText(what)) problems.push({ path: 'body/whatHappened', message: `At most ${SAFETY_LIMITS.whatHappened} characters.` })
  if (outside && typeof facts.injured !== 'boolean') problems.push({ path: 'body/injured', message: 'Say whether anyone was hurt (yes or no).' })
  if (outside && blank(facts.serial) && blank(facts.batchNumber)) problems.push({ path: 'body/serial', message: "Give the serial or the batch on the garment's label." })
  problems.push(...injuryProblems(facts))
  if (accidentNeeded(facts)) {
    if (!facts.occurredOn) problems.push({ path: 'body/occurredOn', message: 'Say the day it happened: an accident goes in the accident log.' })
    if (blank(facts.place)) problems.push({ path: 'body/place', message: 'Say where it happened (one line): an accident goes in the accident log.' })
  }
  if (facts.occurredOn && facts.occurredOn > today) problems.push({ path: 'body/occurredOn', message: 'It happened today or earlier.' })
  if (!blank(facts.place) && (facts.place!.trim().length > SAFETY_LIMITS.place || !cleanLine(facts.place!.trim()))) problems.push({ path: 'body/place', message: `One line of at most ${SAFETY_LIMITS.place} characters.` })
  for (const field of ['serial', 'batchNumber'] as const) {
    const value = facts[field]
    if (!blank(value) && (value!.trim().length > SAFETY_LIMITS.label || !cleanLine(value!.trim()))) problems.push({ path: `body/${field}`, message: `One line of at most ${SAFETY_LIMITS.label} characters.` })
  }
  if (!blank(facts.size) && (facts.size!.trim().length > SAFETY_LIMITS.size || !cleanLine(facts.size!.trim()))) problems.push({ path: 'body/size', message: `One line of at most ${SAFETY_LIMITS.size} characters.` })
  problems.push(...reporterProblems(facts.reporter ?? null))
  return problems
}

/** The injury's words: only when someone was hurt, with the consent tick, at most SAFETY_LIMITS.injuryWords characters. */
export function injuryProblems(facts: Pick<IntakeFacts, 'injured' | 'injuryConsent' | 'injuryWords'>): Issue[] {
  const problems: Issue[] = []
  const words = (facts.injuryWords ?? '').trim()
  if (words === '') return problems
  if (facts.injured !== true) problems.push({ path: 'body/injuryWords', message: 'The injury is described only when someone was hurt.' })
  else if (facts.injuryConsent !== true) problems.push({ path: 'body/injuryConsent', message: 'Tick the consent first: the injury words are health data (GDPR art. 9), kept only with an explicit consent.' })
  if (words.length > SAFETY_LIMITS.injuryWords || !cleanText(words)) problems.push({ path: 'body/injuryWords', message: `At most ${SAFETY_LIMITS.injuryWords} characters.` })
  return problems
}

/** The reporter as they gave themselves: a name of one line, an e-mail and a phone in their shapes. */
export function reporterProblems(reporter: IntakeFacts['reporter']): Issue[] {
  if (!reporter) return []
  const problems: Issue[] = []
  if (!blank(reporter.name) && (reporter.name!.trim().length > SAFETY_LIMITS.reporterName || !cleanLine(reporter.name!.trim()))) problems.push({ path: 'body/reporter/name', message: `One line of at most ${SAFETY_LIMITS.reporterName} characters.` })
  if (!blank(reporter.email) && (reporter.email!.trim().length > SAFETY_LIMITS.email || !EMAIL_SHAPE.test(reporter.email!.trim()))) problems.push({ path: 'body/reporter/email', message: 'An e-mail address such as name@example.com.' })
  if (!blank(reporter.phone) && !PHONE_SHAPE.test(reporter.phone!.trim())) problems.push({ path: 'body/reporter/phone', message: 'A phone number: digits, spaces and + ( ) . / - only.' })
  return problems
}

/** The words a sender reads when the report reached us (the screens may say them in the reader's language). */
export const sentWords = (number: string): string => `Safety report ${number} received: our quality team reads it today. Thank you for telling us.`

/**
 * The SAFETY case's own words: never the reporter's words (a case is read by every role with the service cases, and a reporter
 * may have written about an injury in "what happened"); the report holds them, for the roles that read reports.
 */
export const caseProblemOf = (number: string, source: SafetySource): string =>
  `Product-safety report ${number}, from ${SOURCE_WORDS[source]}: what happened is on the report, and whether someone was hurt only for the product-safety role.`

/** The PPE register entry's description, without the reporter's words or anything of an injury. */
export function registerDescriptionOf(facts: { readonly number: string; readonly source: SafetySource; readonly receivedOn: BusinessDate; readonly serial: string | null; readonly batchNumber: string | null }): string {
  const garment = [facts.batchNumber ? `batch ${facts.batchNumber}` : null, facts.serial ? `serial ${facts.serial}` : null].filter(Boolean).join(', ')
  return `Product-safety report ${facts.number} received on ${facts.receivedOn} from ${SOURCE_WORDS[facts.source]}${garment ? ` (${garment})` : ''}: what happened is on the report.`
}

// ---- the moves ------------------------------------------------------------------------------------------------------------

export const HELD_CODES = ['CLOSED', 'ALREADY', 'SEEN', 'NOT_SEEN', 'NO_STYLE', 'FILED', 'INJURY_RECORDED', 'NO_INJURY', 'NO_WORDS', 'ERASED', 'NOTHING_TO_ERASE', 'NO_PHOTOS_LEFT', 'NOT_FROM_HERE'] as const
export type HeldCode = (typeof HELD_CODES)[number]

const HELD_WORDS: Readonly<Record<HeldCode, string>> = Object.freeze({
  CLOSED: 'is closed: it changes no more (its accident log and an erasure on request still may)',
  ALREADY: 'is there already',
  SEEN: 'was seen already (who saw it first is kept)',
  NOT_SEEN: 'has not been seen by quality yet',
  NO_STYLE: 'names no style: a PPE register entry concerns one style, so name the style first',
  FILED: 'is filed in the PPE register already',
  INJURY_RECORDED: 'says already whether someone was hurt (it never changes; an erasure on request blanks the words)',
  NO_INJURY: 'does not say whether someone was hurt',
  NO_WORDS: 'keeps no injury words to erase',
  ERASED: 'had its injury words erased on request already',
  NOTHING_TO_ERASE: "keeps none of the reporter's personal data",
  NO_PHOTOS_LEFT: `holds ${SAFETY_LIMITS.photos} photos already`,
  NOT_FROM_HERE: 'cannot move that way',
})
export const heldWords = (code: HeldCode): string => HELD_WORDS[code]

/** Why a move is held, or null: NEW → ASSESSING | CLOSED, ASSESSING → CLOSED; CLOSED is final. */
export function moveHeld(from: ReportStatus, to: MoveTarget): HeldCode | null {
  if (from === 'CLOSED') return 'CLOSED'
  if (from === to) return 'ALREADY'
  if (from === 'NEW' || (from === 'ASSESSING' && to === 'CLOSED')) return null
  return 'NOT_FROM_HERE'
}

export function closeProblems(note: string | null | undefined): Issue[] {
  const words = (note ?? '').trim()
  if (words.length === 0) return [{ path: 'body/note', message: 'Say what quality found and what was done (the closing words).' }]
  if (words.length > SAFETY_LIMITS.closeNote || !cleanText(words)) return [{ path: 'body/note', message: `At most ${SAFETY_LIMITS.closeNote} characters.` }]
  return []
}

export function eraseReasonProblems(reason: string | null | undefined): Issue[] {
  const words = (reason ?? '').trim()
  if (words.length === 0) return [{ path: 'body/reason', message: 'Say whose request it is and when it came (the erasure is recorded with it, GDPR art. 17).' }]
  if (words.length > SAFETY_LIMITS.eraseReason || !cleanText(words)) return [{ path: 'body/reason', message: `At most ${SAFETY_LIMITS.eraseReason} characters.` }]
  return []
}

// ---- the accident log -----------------------------------------------------------------------------------------------------

/** One revision as the caller asks it: what it leaves out is the newest revision's (revision 1 names its day, place, outcome). */
export interface RevisionFacts {
  readonly first: boolean
  readonly occurredOn: BusinessDate | null
  readonly place: string | null
  readonly outcome: AccidentOutcome | null
  readonly serial: string | null
  readonly batchNumber: string | null
  readonly authorityToldAt: Date | null
  readonly authorityReference: string | null
  readonly authorityNoticeId: string | null
  readonly note: string | null
  /** The day the report reached us (the accident happened by then) and today. */
  readonly receivedOn: BusinessDate
  readonly today: BusinessDate
  readonly now: Date
  readonly authorityDay: BusinessDate | null
}

export function revisionProblems(facts: RevisionFacts): Issue[] {
  const problems: Issue[] = []
  if (!facts.occurredOn) problems.push({ path: 'body/occurredOn', message: 'Say the day of the accident.' })
  else if (facts.occurredOn > facts.today || facts.occurredOn > facts.receivedOn) problems.push({ path: 'body/occurredOn', message: 'The accident happened on or before the day its report reached us, and not in the future.' })
  if (blank(facts.place)) problems.push({ path: 'body/place', message: 'Say where it happened (one line).' })
  else if (facts.place!.length > SAFETY_LIMITS.place || !cleanLine(facts.place!)) problems.push({ path: 'body/place', message: `One line of at most ${SAFETY_LIMITS.place} characters.` })
  if (!facts.outcome) problems.push({ path: 'body/outcome', message: 'Say what came of it (coarsely: never the injury words).' })
  for (const field of ['serial', 'batchNumber'] as const) {
    const value = facts[field]
    if (value !== null && (value.length === 0 || value.length > SAFETY_LIMITS.label || !cleanLine(value))) problems.push({ path: `body/${field}`, message: `One line of at most ${SAFETY_LIMITS.label} characters.` })
  }
  if (!facts.first && blank(facts.note)) problems.push({ path: 'body/note', message: 'Say why this revision corrects or completes the accident log.' })
  if (!blank(facts.note) && (facts.note!.length > SAFETY_LIMITS.note || !cleanText(facts.note!))) problems.push({ path: 'body/note', message: `At most ${SAFETY_LIMITS.note} characters.` })
  if (facts.authorityToldAt === null) {
    if (facts.authorityReference !== null) problems.push({ path: 'body/authorityReference', message: 'A reference comes with the time the authority was told.' })
    if (facts.authorityNoticeId !== null) problems.push({ path: 'body/authorityNoticeId', message: 'An authority notice comes with the time the authority was told.' })
  } else {
    if (facts.authorityToldAt.getTime() > facts.now.getTime()) problems.push({ path: 'body/authorityToldAt', message: 'The authority was told now or earlier.' })
    else if (facts.occurredOn && facts.authorityDay && facts.authorityDay < facts.occurredOn) problems.push({ path: 'body/authorityToldAt', message: 'The authority was told on or after the day of the accident.' })
  }
  if (facts.authorityReference !== null && (facts.authorityReference.length === 0 || facts.authorityReference.length > SAFETY_LIMITS.reference || !cleanLine(facts.authorityReference))) {
    problems.push({ path: 'body/authorityReference', message: `One line of at most ${SAFETY_LIMITS.reference} characters.` })
  }
  return problems
}

/** What the log says of one report's newest revision: the authority told, or to be told (a death or serious harm). */
export function logStateOf(newest: { readonly outcome: AccidentOutcome; readonly authorityToldAt: Date | null } | null): { readonly told: boolean; readonly mustTell: boolean; readonly words: string } {
  if (!newest) return { told: false, mustTell: false, words: 'Not in the accident log.' }
  const told = newest.authorityToldAt !== null
  const mustTell = !told && (NOTIFIABLE_OUTCOMES as readonly string[]).includes(newest.outcome)
  return {
    told,
    mustTell,
    words: told
      ? 'The authority was told.'
      : mustTell
        ? `The accident caused ${OUTCOME_WORDS[newest.outcome]}: under GPSR art. 20 the authority is told through the Safety Business Gateway without delay. ${SAFETY_LAW.q37}`
        : `In the accident log (${OUTCOME_WORDS[newest.outcome]}); the authority has not been told.`,
  }
}

// ---- what a report offers -------------------------------------------------------------------------------------------------

export const REPORT_ACTIONS = ['seen', 'assess', 'close', 'edit', 'file', 'photos', 'logAccident', 'eraseReporter', 'openInjury', 'recordInjury', 'eraseInjury'] as const
export type ReportAction = (typeof REPORT_ACTIONS)[number]

export interface ActionFacts {
  readonly status: ReportStatus
  readonly seen: boolean
  readonly filed: boolean
  readonly hasStyle: boolean
  readonly photos: number
  readonly reporterKept: boolean
  /** The injury row: absent, or whether its words are kept and were erased. */
  readonly injury: { readonly words: boolean; readonly erased: boolean } | null
  readonly mayManage: boolean
  readonly mayInjury: boolean
  readonly mayLog: boolean
  readonly mayOpenRegister: boolean
}

export type ActionHeld = HeldCode | 'NO_PERMISSION'

export function reportActions(facts: ActionFacts): { action: ReportAction; allowed: boolean; held: ActionHeld | null }[] {
  const closed = facts.status === 'CLOSED'
  const decide = (action: ReportAction, permitted: boolean, held: HeldCode | null) => ({ action, allowed: permitted && held === null, held: !permitted ? ('NO_PERMISSION' as const) : held })
  return [
    decide('seen', facts.mayManage, closed ? 'CLOSED' : facts.seen ? 'SEEN' : null),
    decide('assess', facts.mayManage, moveHeld(facts.status, 'ASSESSING')),
    decide('close', facts.mayManage, moveHeld(facts.status, 'CLOSED')),
    decide('edit', facts.mayManage, closed ? 'CLOSED' : null),
    decide('file', facts.mayManage, closed ? 'CLOSED' : facts.filed ? 'FILED' : !facts.hasStyle ? 'NO_STYLE' : null),
    decide('photos', facts.mayManage, closed ? 'CLOSED' : facts.photos >= SAFETY_LIMITS.photos ? 'NO_PHOTOS_LEFT' : null),
    decide('logAccident', facts.mayLog, null),
    decide('eraseReporter', facts.mayManage, facts.reporterKept ? null : 'NOTHING_TO_ERASE'),
    decide('openInjury', facts.mayInjury, facts.injury ? null : 'NO_INJURY'),
    decide('recordInjury', facts.mayInjury, facts.injury ? 'INJURY_RECORDED' : null),
    decide('eraseInjury', facts.mayInjury, !facts.injury ? 'NO_INJURY' : facts.injury.erased ? 'ERASED' : !facts.injury.words ? 'NO_WORDS' : null),
  ]
}

// ---- the photos after the send (public door) -----------------------------------------------------------------------------

/** The public door's photo ticket: `<tenantId>.<reportId>.<expires, unix seconds>.<signature>` (the API signs and checks it). */
export const PHOTO_TICKET = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/
