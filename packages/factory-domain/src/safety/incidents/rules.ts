/**
 * Incidents, near misses and hazards (B-W2b-125; QHS-265 "report in three taps", QHS-268 "the INAIL reporting deadline
 * tracker", QHS-270 "injury details as protected data"; design plant.incidents SCR-210, floor.incident SCR-230), pure. The
 * tables are factory-db health.prisma's Incident, IncidentPerson, IncidentAction, InailFiling and ProtectedView (B-W2b-91);
 * its guards hold the same rules for every login. The law is named in words only where the plan names it: D.Lgs. 81/2008
 * art. 18 c.1 r (the INAIL communication: an absence of at least one day beyond the day of the event, a statistical
 * communication; over three days, the insurance report; both within 48 hours of receiving the medical certificate; filed on
 * the INAIL portal by hand) and GDPR art. 9 (the people involved and their injuries). No deadline here that the plan does
 * not give: the reminders before the 48 hours are this module's own, not the law's.
 */

export const INCIDENT_KINDS = ['INJURY', 'NEAR_MISS', 'HAZARD'] as const
export type IncidentKind = (typeof INCIDENT_KINDS)[number]
/** Only these may be sent without a name (the plan: "a hazard or near miss may stay unnamed"). */
export const ANONYMOUS_KINDS: readonly IncidentKind[] = Object.freeze(['NEAR_MISS', 'HAZARD'])

export const INCIDENT_SEVERITIES = ['NONE', 'FIRST_AID', 'LOST_DAYS'] as const
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number]

export const INCIDENT_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

export const REPORTED_VIA = ['FLOOR', 'OFFICE'] as const
export type ReportedVia = (typeof REPORTED_VIA)[number]

export const INVOLVEMENTS = ['INJURED', 'INVOLVED'] as const
export type Involvement = (typeof INVOLVEMENTS)[number]

/** factory-db IncidentBodyPart (the INAIL report's "sede della lesione" in general words). */
export const BODY_PARTS = ['HEAD', 'EYE', 'FACE', 'NECK', 'SHOULDER', 'ARM', 'ELBOW', 'WRIST', 'HAND', 'FINGER', 'BACK', 'CHEST', 'ABDOMEN', 'HIP', 'LEG', 'KNEE', 'ANKLE', 'FOOT', 'TOE', 'MULTIPLE'] as const
export type BodyPart = (typeof BODY_PARTS)[number]
export const BODY_SIDES = ['LEFT', 'RIGHT', 'BOTH'] as const
export type BodySide = (typeof BODY_SIDES)[number]
/** factory-db IncidentInjuryNature (the INAIL report's "natura della lesione" in general words). */
export const INJURY_NATURES = ['CUT', 'PUNCTURE', 'CRUSH', 'BRUISE', 'BURN', 'CHEMICAL_BURN', 'FRACTURE', 'SPRAIN', 'STRAIN', 'FOREIGN_BODY', 'ELECTRIC_SHOCK', 'AMPUTATION', 'OTHER'] as const
export type InjuryNature = (typeof INJURY_NATURES)[number]

export const ACTION_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]
/** What an action is made into in one step (design "Make a job", "Add to improvement plan", "Plan training"). */
export const ACTION_LINKS = ['MAINTENANCE_JOB', 'RISK_MEASURE', 'TRAINING_SESSION'] as const
export type ActionLink = (typeof ACTION_LINKS)[number]

export const FILING_TYPES = ['STATISTICAL', 'INSURANCE'] as const
export type FilingType = (typeof FILING_TYPES)[number]
export const FILING_STATUSES = ['WAITING_CERTIFICATE', 'DUE', 'FILED', 'NOT_NEEDED'] as const
export type FilingStatus = (typeof FILING_STATUSES)[number]
/** The design's states (plant.incidents "Filing": Not needed / Waiting certificate / Due / Overdue / Filed): OVERDUE is a DUE past its deadline. */
export const FILING_STATES = ['NOT_NEEDED', 'WAITING_CERTIFICATE', 'DUE', 'OVERDUE', 'FILED'] as const
export type FilingState = (typeof FILING_STATES)[number]

export const INCIDENT_LAW = 'D.Lgs. 81/2008 art. 18 c.1 r'
export const PROTECTED_LAW = 'GDPR art. 9'
/** design floor.incident "Someone badly hurt?": "Call 112 first". */
export const EMERGENCY_NUMBER = '112'

/** The INAIL rule (design plant.incidents "What the law asks"; D.Lgs. 81/2008 art. 18 c.1 r). */
export const INAIL_RULE = Object.freeze({
  /** An absence of at least this many days beyond the day of the event: a statistical communication. */
  statisticalFromDays: 1,
  /** An absence of more than this many days: the insurance report. */
  insuranceAboveDays: 3,
  /** Both within this many hours of receiving the medical certificate. */
  hoursAfterCertificate: 48,
})
export const FILING_WINDOW_MS = INAIL_RULE.hoursAfterCertificate * 3_600_000

/** The rule in plain words, as the Authority notice tab shows it (it, en). */
export const INAIL_RULE_WORDS = Object.freeze({
  en: [
    'An absence of at least one day beyond the day of the event: a statistical communication to INAIL.',
    'An absence of more than three days: the insurance report to INAIL.',
    'Both within 48 hours of receiving the medical certificate, filed by hand on the INAIL portal; Nexus records the filing.',
  ],
  it: [
    'Assenza di almeno un giorno oltre quello dell’evento: comunicazione a fini statistici all’INAIL.',
    'Assenza di oltre tre giorni: denuncia a fini assicurativi all’INAIL.',
    'Entrambe entro 48 ore dalla ricezione del certificato medico, inviate a mano sul portale INAIL; Nexus registra l’invio.',
  ],
})

export const INCIDENT_LIMITS = Object.freeze({
  what: 2000,
  place: 500,
  immediateAction: 500,
  outsideName: 200,
  title: 300,
  evidence: 2000,
  reason: 500,
  certificate: 100,
  protocol: 100,
  absenceDays: 3650,
  /** People named in one report. */
  people: 20,
  /** Photos a tablet adds to its report, and the minutes after the report it may add them (then the office does). */
  floorPhotos: 4,
  floorPhotoMinutes: 30,
  /** How far back a tablet sees its report's "seen by safety" (days). */
  floorReadDays: 7,
  /** Rows of one list page, and incidents of one "Show people". */
  page: 200,
  peopleList: 100,
})

// ---- the report --------------------------------------------------------------------------------------------------------

/** Where it happened: an area, a station, a machine of the site, or a place in words; at least one (the guard's rule). */
export interface Where {
  readonly areaId?: string | null | undefined
  readonly stationId?: string | null | undefined
  readonly machineId?: string | null | undefined
  readonly place?: string | null | undefined
}

export const hasWhere = (where: Where): boolean => Boolean(where.areaId || where.stationId || where.machineId || (where.place ?? '').trim())

export interface PersonInput {
  readonly involvement: Involvement
  readonly employeeId?: string | null | undefined
  readonly outsideName?: string | null | undefined
  readonly bodyParts?: readonly BodyPart[] | undefined
  readonly bodySide?: BodySide | null | undefined
  readonly nature?: InjuryNature | null | undefined
  readonly firstAidGiven?: boolean | undefined
  readonly sentToHospital?: boolean | undefined
}

/** An injury's shape (the guard's rules in words; [] = fine): each part once, a side with parts, someone only involved not hurt. */
export function injuryProblems(person: Omit<PersonInput, 'employeeId' | 'outsideName'>, path = 'people/0'): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = []
  const parts = person.bodyParts ?? []
  if (new Set(parts).size !== parts.length) problems.push({ path: `${path}/bodyParts`, message: 'Each body part once.' })
  if (person.bodySide && parts.length === 0) problems.push({ path: `${path}/bodySide`, message: 'A side goes with the body parts hurt.' })
  if (person.involvement === 'INVOLVED' && (parts.length > 0 || person.nature || person.firstAidGiven || person.sentToHospital)) {
    problems.push({ path: `${path}/involvement`, message: 'Someone only involved was not hurt: no injury, first aid or hospital is recorded.' })
  }
  return problems
}

/** A person's shape: a person of the company or someone from outside by name, exactly one, and the injury's shape. */
export function personProblems(person: PersonInput, path = 'people/0'): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = []
  const outside = (person.outsideName ?? '').trim()
  if (Boolean(person.employeeId) === Boolean(outside)) problems.push({ path: `${path}/employeeId`, message: 'Name a person of the company or someone from outside by name, one of the two.' })
  if (outside.length > INCIDENT_LIMITS.outsideName) problems.push({ path: `${path}/outsideName`, message: `At most ${INCIDENT_LIMITS.outsideName} characters.` })
  return [...problems, ...injuryProblems(person, path)]
}

export const INCIDENT_REFUSALS = [
  'ANONYMOUS_INJURY',
  'ANONYMOUS_NAMES_NOBODY',
  'ANONYMOUS_FROM_OFFICE',
  'ANONYMOUS_NOT_QUEUED',
  'WHERE_MISSING',
  'WHERE_OTHER_SITE',
  'OCCURRED_IN_FUTURE',
  'INJURED_NOT_INJURY',
  'PERSON_OTHER_COMPANY',
  'PERSON_TWICE',
  'NOT_OPEN',
  'NOT_CLOSED',
  'STAYS_INJURY',
  'ACTIONS_OPEN',
  'FILING_WAITING',
  'REQUEST_OTHER_SITE',
  'ACTION_NOT_OPEN',
  'MADE_ALREADY',
  'NO_MACHINE',
  'NO_ASSESSMENT',
  'COURSE_NOT_ACTIVE',
  'TRAINER_NOT_ACTIVE',
  'FILING_NOT_EMPLOYEE',
  'NO_FILING_NEEDED',
  'FILING_EXISTS',
  'FILING_FILED',
  'FILING_NOT_NEEDED_NOW',
  'CERTIFICATE_MISSING',
  'CERTIFICATE_IN_FUTURE',
  'CERTIFICATE_BEFORE_EVENT',
  'FILED_BEFORE_CERTIFICATE',
  'FILED_IN_FUTURE',
  'PERSON_HAS_FILING',
  'PHOTOS_FULL',
  'PHOTO_WINDOW',
] as const
export type IncidentRefusalCode = (typeof INCIDENT_REFUSALS)[number]
export interface IncidentRefusal {
  readonly code: IncidentRefusalCode
  readonly message: string
  readonly field?: string
}

/** The words of each refusal (the API's 409 `refusal/<CODE>`; the screens show their own words per code). */
export const REFUSAL_WORDS: Readonly<Record<IncidentRefusalCode, string>> = Object.freeze({
  ANONYMOUS_INJURY: 'An injury is reported with a name: only a near miss or a hazard may be sent without one.',
  ANONYMOUS_NAMES_NOBODY: 'A report without your name names nobody: leave the people out, or send it with your name.',
  ANONYMOUS_FROM_OFFICE: 'From the office a report carries your name; a tablet can send a near miss or a hazard without one.',
  ANONYMOUS_NOT_QUEUED: 'A report without your name is sent at once, never kept in the tablet’s queue (the queue records the tablet): send it when the network is back.',
  WHERE_MISSING: 'Say where it happened: this station, an area, a machine or a place in words.',
  WHERE_OTHER_SITE: 'The area, station or machine is one of this site’s.',
  OCCURRED_IN_FUTURE: 'It happened at the latest now.',
  INJURED_NOT_INJURY: 'An injured person is reported in an injury: choose Injury, or name the person as involved.',
  PERSON_OTHER_COMPANY: 'The person works for another company: name them as someone from outside, or a person of this company.',
  PERSON_TWICE: 'This person is in the incident already.',
  NOT_OPEN: 'This incident is closed or cancelled: reopen it first (a cancelled one no longer changes).',
  NOT_CLOSED: 'Only a closed incident is reopened.',
  STAYS_INJURY: 'It stays an injury while a person is injured in it.',
  ACTIONS_OPEN: 'It stays open while an action is open: finish or cancel the actions first.',
  FILING_WAITING: 'It stays open while an INAIL filing waits for its certificate or its filing: record it, or mark it not needed.',
  REQUEST_OTHER_SITE: 'The machine request is one of this site’s.',
  ACTION_NOT_OPEN: 'This action is done or cancelled; it no longer changes.',
  MADE_ALREADY: 'This action was made into its linked record already; that never changes.',
  NO_MACHINE: 'A maintenance job is for a machine: name the machine (the incident names none).',
  NO_ASSESSMENT: 'A measure belongs to a risk assessment of the incident’s site: the site has no active one (Plant › Risk assessment), or name one of its.',
  COURSE_NOT_ACTIVE: 'The course is an active course of the whole group or of the incident’s company.',
  TRAINER_NOT_ACTIVE: 'The trainer is a person of the company who works there now, or an outside trainer by name.',
  FILING_NOT_EMPLOYEE: 'An INAIL filing is for an injured person of the company in an injury (not someone from outside, not someone only involved).',
  NO_FILING_NEEDED: 'An absence of less than one day beyond the day of the event needs no INAIL filing.',
  FILING_EXISTS: 'This person has a filing of that type already: change that one.',
  FILING_FILED: 'This filing was recorded as filed; it no longer changes.',
  FILING_NOT_NEEDED_NOW: 'Only a filing marked not needed is needed again.',
  CERTIFICATE_MISSING: 'Record when the medical certificate was received first: it starts the 48-hour clock.',
  CERTIFICATE_IN_FUTURE: 'The certificate was received at the latest now.',
  CERTIFICATE_BEFORE_EVENT: 'The certificate was received after the incident happened.',
  FILED_BEFORE_CERTIFICATE: 'A filing is sent after the certificate was received.',
  FILED_IN_FUTURE: 'It was filed at the latest now.',
  PERSON_HAS_FILING: 'This person has an INAIL filing: they stay in the incident (mark the filing not needed if it was a mistake).',
  PHOTOS_FULL: 'A report from a tablet takes up to 4 photos; the office adds more.',
  PHOTO_WINDOW: 'A tablet adds photos within 30 minutes of its report; later the office adds them.',
})

export const refusalOf = (code: IncidentRefusalCode, field?: string): IncidentRefusal => ({ code, message: REFUSAL_WORDS[code], ...(field ? { field } : {}) })

export interface ReportFacts {
  readonly kind: IncidentKind
  readonly anonymous: boolean
  readonly via: ReportedVia
  readonly queued?: boolean
  readonly people: readonly Pick<PersonInput, 'involvement' | 'employeeId'>[]
  readonly where: Where
  readonly occurredAt: Date
  readonly now: Date
}

/** A report sent without a name (null: fine): a near miss or a hazard from a tablet, naming nobody, sent at once. */
export function anonymousRefusal(facts: Pick<ReportFacts, 'kind' | 'anonymous' | 'via' | 'queued'> & { readonly people: readonly unknown[] }): IncidentRefusal | null {
  if (!facts.anonymous) return null
  if (facts.via === 'OFFICE') return refusalOf('ANONYMOUS_FROM_OFFICE', 'anonymous')
  if (!ANONYMOUS_KINDS.includes(facts.kind)) return refusalOf('ANONYMOUS_INJURY', 'kind')
  if (facts.people.length > 0) return refusalOf('ANONYMOUS_NAMES_NOBODY', 'people')
  if (facts.queued) return refusalOf('ANONYMOUS_NOT_QUEUED', 'anonymous')
  return null
}

/** A report's rules before it is written (null: it may be sent). */
export function reportRefusal(facts: ReportFacts): IncidentRefusal | null {
  const anonymous = anonymousRefusal(facts)
  if (anonymous) return anonymous
  if (!hasWhere(facts.where)) return refusalOf('WHERE_MISSING', 'where')
  if (facts.occurredAt.getTime() > facts.now.getTime()) return refusalOf('OCCURRED_IN_FUTURE', 'occurredAt')
  if (facts.kind !== 'INJURY' && facts.people.some((person) => person.involvement === 'INJURED')) return refusalOf('INJURED_NOT_INJURY', 'people')
  const employees = facts.people.map((person) => person.employeeId).filter((id): id is string => Boolean(id))
  if (new Set(employees).size !== employees.length) return refusalOf('PERSON_TWICE', 'people')
  return null
}

/** What a tablet's three-tap report says when nothing was typed (the guard asks words): the tile's words. */
export const FLOOR_WHAT: Readonly<Record<IncidentKind, { readonly en: string; readonly it: string }>> = Object.freeze({
  INJURY: { en: 'Someone was hurt (reported from a tablet).', it: 'Una persona si è fatta male (segnalato da tablet).' },
  NEAR_MISS: { en: 'A near miss (reported from a tablet).', it: 'Un quasi incidente (segnalato da tablet).' },
  HAZARD: { en: 'A hazard (reported from a tablet).', it: 'Un pericolo (segnalato da tablet).' },
})

export const whatOf = (kind: IncidentKind, typed: string | null | undefined, language: 'en' | 'it'): string => {
  const words = (typed ?? '').trim()
  return words === '' ? FLOOR_WHAT[kind][language] : words
}

/** The tiles' words (design floor.incident "What happened?": Incident (someone hurt) · Near miss · Hazard). */
export const KIND_WORDS: Readonly<Record<IncidentKind, { readonly en: string; readonly it: string }>> = Object.freeze({
  INJURY: { en: 'Incident (someone hurt)', it: 'Infortunio (qualcuno si è fatto male)' },
  NEAR_MISS: { en: 'Near miss', it: 'Quasi incidente' },
  HAZARD: { en: 'Hazard', it: 'Pericolo' },
})

// ---- closing -----------------------------------------------------------------------------------------------------------

/** Close (null: it may close). The guard holds the same. */
export function closeRefusal(facts: { readonly status: IncidentStatus; readonly actionsOpen: number; readonly filingsWaiting: number }): IncidentRefusal | null {
  if (facts.status !== 'OPEN') return refusalOf('NOT_OPEN')
  if (facts.actionsOpen > 0) return refusalOf('ACTIONS_OPEN')
  if (facts.filingsWaiting > 0) return refusalOf('FILING_WAITING')
  return null
}

// ---- INAIL filings -----------------------------------------------------------------------------------------------------

/** The filing an absence calls for (null: none): over three days the insurance report, from one day the statistical one. */
export function filingTypeFor(absenceDays: number): FilingType | null {
  if (absenceDays > INAIL_RULE.insuranceAboveDays) return 'INSURANCE'
  if (absenceDays >= INAIL_RULE.statisticalFromDays) return 'STATISTICAL'
  return null
}

/**
 * The filings to add for an absence, given the types the person has already: the type it calls for when the person has
 * none of it. A statistical one whose absence grows past three days gets the insurance report too (B-W2b-91: the module
 * decides from the days); the statistical one stays as it is (the plan gives no rule that one replaces the other: the
 * person marks it not needed when that is so).
 */
export function filingsToAdd(absenceDays: number, existing: readonly FilingType[]): FilingType[] {
  const wanted = filingTypeFor(absenceDays)
  return wanted && !existing.includes(wanted) ? [wanted] : []
}

/** The deadline: 48 hours after the certificate was received, to the millisecond (the guard's rule). */
export const dueAtOf = (certificateReceivedAt: Date): Date => new Date(certificateReceivedAt.getTime() + FILING_WINDOW_MS)

/** The state the screen shows: a DUE filing past its deadline is OVERDUE (shown, never refused). */
export function filingStateOf(filing: { readonly status: FilingStatus; readonly dueAt: Date | null }, now: Date): FilingState {
  if (filing.status === 'DUE' && filing.dueAt !== null && filing.dueAt.getTime() < now.getTime()) return 'OVERDUE'
  return filing.status
}

export interface Countdown {
  readonly dueAt: string
  /** Whole minutes left (negative: late by that much). */
  readonly minutesLeft: number
  /** Whole hours left, rounded down (negative when late). */
  readonly hoursLeft: number
  /** Under 24 hours and not late yet: the critical banner. */
  readonly under24h: boolean
  readonly late: boolean
}

/** The countdown to a deadline at a time (the screen keeps counting from dueAt; the server's now names its start). */
export function countdownOf(dueAt: Date, now: Date): Countdown {
  const ms = dueAt.getTime() - now.getTime()
  const minutesLeft = ms >= 0 ? Math.floor(ms / 60_000) : -Math.ceil(-ms / 60_000)
  return { dueAt: dueAt.toISOString(), minutesLeft, hoursLeft: ms >= 0 ? Math.floor(ms / 3_600_000) : -Math.ceil(-ms / 3_600_000), under24h: ms >= 0 && ms < 24 * 3_600_000, late: ms < 0 }
}

/**
 * The reminders of a DUE filing (the module's own, not the law's): 24 hours before the deadline (the plan: "an INAIL deadline
 * under 24 hours is never missed"), 4 hours before, and at the deadline (late). Kept with the date timers (platform/timers):
 * the scheduler fires each within a minute, the fan-out tells the people who keep the filings. A stage whose time has passed
 * when the certificate is recorded is folded into the latest passed one, which fires at once: never two at the same minute.
 */
export const INAIL_TIMER_KIND = 'INAIL_FILING_DUE'
export const INAIL_REMINDER_HOURS = [24, 4, 0] as const

export function reminderPlan(dueAt: Date, now: Date): { readonly timerKey: string; readonly fireAt: Date; readonly hoursBefore: number }[] {
  const stages = INAIL_REMINDER_HOURS.map((hours) => ({ hours, at: new Date(dueAt.getTime() - hours * 3_600_000) }))
  const passed = stages.filter((stage) => stage.at.getTime() <= now.getTime())
  const latestPassed = passed.length > 0 ? passed[passed.length - 1]! : null
  return stages
    .filter((stage) => stage.at.getTime() > now.getTime() || stage === latestPassed)
    .map((stage) => ({ timerKey: stage.hours === 0 ? INAIL_TIMER_KIND : `${INAIL_TIMER_KIND}:-${stage.hours}h`, fireAt: stage.at.getTime() > now.getTime() ? stage.at : now, hoursBefore: stage.hours }))
}

/** The hours before the deadline a reminder's key stands for (24, 4 or 0), or null when it is not one of these. */
export function reminderHoursOf(timerKey: string): number | null {
  if (timerKey === INAIL_TIMER_KIND) return 0
  const match = new RegExp(`^${INAIL_TIMER_KIND}:-([0-9]+)h$`).exec(timerKey)
  if (!match) return null
  const hours = Number(match[1])
  return (INAIL_REMINDER_HOURS as readonly number[]).includes(hours) ? hours : null
}

/** A certificate's time (null: fine): at the latest now, after the incident happened. */
export function certificateRefusal(receivedAt: Date, facts: { readonly occurredAt: Date; readonly now: Date }): IncidentRefusal | null {
  if (receivedAt.getTime() > facts.now.getTime()) return refusalOf('CERTIFICATE_IN_FUTURE', 'certificateReceivedAt')
  if (receivedAt.getTime() < facts.occurredAt.getTime()) return refusalOf('CERTIFICATE_BEFORE_EVENT', 'certificateReceivedAt')
  return null
}

/** Recording the filing (null: fine): after the certificate, at the latest now, with INAIL's protocol number. */
export function fileRefusal(filing: { readonly status: FilingStatus; readonly certificateReceivedAt: Date | null }, filedAt: Date, now: Date): IncidentRefusal | null {
  if (filing.status === 'FILED') return refusalOf('FILING_FILED')
  if (filing.certificateReceivedAt === null) return refusalOf('CERTIFICATE_MISSING', 'certificateReceivedAt')
  if (filedAt.getTime() > now.getTime()) return refusalOf('FILED_IN_FUTURE', 'filedAt')
  if (filedAt.getTime() < filing.certificateReceivedAt.getTime()) return refusalOf('FILED_BEFORE_CERTIFICATE', 'filedAt')
  return null
}

/** A floor photo (null: fine): up to four, within 30 minutes of the report. */
export function floorPhotoRefusal(facts: { readonly reportedAt: Date; readonly photos: number; readonly now: Date }): IncidentRefusal | null {
  if (facts.now.getTime() - facts.reportedAt.getTime() > INCIDENT_LIMITS.floorPhotoMinutes * 60_000) return refusalOf('PHOTO_WINDOW')
  if (facts.photos >= INCIDENT_LIMITS.floorPhotos) return refusalOf('PHOTOS_FULL')
  return null
}

// ---- a machine locked as unsafe opens a hazard report ------------------------------------------------------------------

/**
 * The hazard report a machine lock opens when the site asks for one (B-W2b-96's seam: maintenance_request.locked with
 * `hazardReport`, the site's PlantSettings.hazardReportOnLock): its words in the company's language.
 */
export function lockHazardWords(locale: string, assetNumber: string, problem: string | null): { readonly what: string; readonly immediateAction: string } {
  const italian = !locale.toLowerCase().startsWith('en')
  const words = (problem ?? '').trim()
  return italian
    ? { what: `Macchina ${assetNumber} bloccata perché non sicura${words ? `: ${words}` : ''}.`, immediateAction: 'Macchina bloccata (non usare) finché un tecnico non la dichiara sicura.' }
    : { what: `Machine ${assetNumber} was locked as unsafe${words ? `: ${words}` : ''}.`, immediateAction: 'Machine locked as unsafe (do not use) until a technician signs it safe.' }
}
