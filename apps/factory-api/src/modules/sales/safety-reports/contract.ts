import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import {
  ACCIDENT_OUTCOMES,
  HELD_CODES,
  MOVE_TARGETS,
  OFFICE_SOURCES,
  REPORT_ACTIONS,
  REPORT_STATUSES,
  REPORT_VIEWS,
  SAFETY_LIMITS,
  SAFETY_SOURCES,
} from '@nexus/factory-domain/sales/safety-reports/rules'

/**
 * Product-safety reports and the accident log (B-W2b-351; SAL-414, SAL-415, SAL-423). No amount anywhere. Every office write
 * takes an Idempotency-Key and the report's `version`; the public send requires one. Refusals in words: `body/<field>` (400),
 * a step the report's state holds (409 invalid_state, `held/<CODE>`; `held/OFF`: the doors from outside are closed), a stale
 * version (409 conflict). Whether someone was hurt is in no answer but POST …/injury/open's. Office people by id, their names
 * in `people`.
 */

const version = z.number().int().min(1)
const issue = output({ path: z.string(), message: z.string() })
const reportParams = input({ reportId: id() })
const person = output({ id: id(), name: z.string() })
const text = (max: number) => z.string().max(max * 2)
const label = text(SAFETY_LIMITS.label).nullish()

const reporter = input({ name: text(SAFETY_LIMITS.reporterName).nullish(), email: text(SAFETY_LIMITS.email).nullish(), phone: z.string().max(80).nullish() })

/** What every door asks (the public and portal doors: whether anyone was hurt, and the serial or the batch). */
const intakeShape = {
  serial: label,
  batchNumber: label,
  size: text(SAFETY_LIMITS.size).nullish(),
  /** The day it happened (an accident: required, with the place). */
  occurredOn: businessDate().nullish(),
  place: text(SAFETY_LIMITS.place).nullish(),
  whatHappened: text(SAFETY_LIMITS.whatHappened),
  wornAsIntended: z.boolean().nullish(),
  /** It happened in an accident or a fall: it goes in the accident log (anyone hurt, too). */
  accident: z.boolean().nullish(),
  injured: z.boolean().nullish(),
  /** The explicit consent to keep the injury words (GDPR art. 9(2)(a)); the words are refused without it. */
  injuryConsent: z.boolean().nullish(),
  injuryWords: text(SAFETY_LIMITS.injuryWords).nullish(),
  reporter: reporter.nullish(),
}

const action = output({ action: z.enum(REPORT_ACTIONS), allowed: z.boolean(), held: z.enum([...HELD_CODES, 'NO_PERMISSION']).nullable() })
const style = output({ id: id(), code: z.string(), name: z.string() })
const party = output({ id: id(), code: z.string(), legalName: z.string() })

const revision = output({
  id: id(),
  revision: z.number().int(),
  occurredOn: businessDate(),
  place: z.string(),
  styleId: id().nullable(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  outcome: z.enum(ACCIDENT_OUTCOMES),
  authority: output({ toldAt: instant(), byId: id(), reference: z.string().nullable(), noticeId: id().nullable() }).nullable(),
  note: z.string().nullable(),
  recordedAt: instant(),
  recordedById: id().nullable(),
})
const logState = output({ told: z.boolean(), mustTell: z.boolean(), words: z.string() })

/** One row of the list: never the reporter, what happened or anything of an injury. */
export const reportRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  source: z.enum(SAFETY_SOURCES),
  receivedAt: instant(),
  status: z.enum(REPORT_STATUSES),
  seen: z.boolean(),
  party: party.nullable(),
  style: style.nullable(),
  serial: z.string().nullable(),
  garmentSerial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  garmentBatch: z.string().nullable(),
  size: z.string().nullable(),
  occurredOn: businessDate().nullable(),
  case: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  filed: z.boolean(),
  /** Its accident log entry (the newest revision), coarsely. */
  accident: output({ outcome: z.enum(ACCIDENT_OUTCOMES), told: z.boolean(), mustTell: z.boolean() }).nullable(),
  ownerId: id().nullable(),
  version: z.number().int(),
})

export const reportView = reportRow.extend({
  sourceWords: z.string(),
  contact: output({ id: id(), name: z.string() }).nullable(),
  /** The reporter as they gave themselves (personal data): null for a role that does not manage reports (`reporterHidden`). */
  reporter: output({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  reporterHidden: z.boolean(),
  colourway: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  whatHappened: z.string(),
  wornAsIntended: z.boolean().nullable(),
  seenAt: instant().nullable(),
  seenById: id().nullable(),
  registerEntry: output({ id: id(), reference: z.string(), status: z.string() }).nullable(),
  closed: output({ at: instant(), byId: id().nullable(), note: z.string().nullable() }).nullable(),
  /** Never whether someone was hurt: whether the report says, and whether the caller may open it (POST …/injury/open). */
  injury: output({ recorded: z.boolean(), mayOpen: z.boolean() }),
  accidentLog: output({ revisions: z.number().int(), newest: revision.nullable(), state: logState, law: z.string(), q37: z.string() }),
  photos: z.array(output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), availableAt: instant().nullable() })),
  createdAt: instant(),
  createdById: id().nullable(),
  actions: z.array(action),
  people: z.array(person),
})

const oneReport = output({ report: reportView })

// ---- the office ---------------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    view: z.enum(REPORT_VIEWS).optional(),
    status: z.enum(REPORT_STATUSES).optional(),
    source: z.enum(SAFETY_SOURCES).optional(),
    companyId: id().optional(),
    styleId: id().optional(),
    serial: z.string().max(SAFETY_LIMITS.label).optional(),
    batch: z.string().max(SAFETY_LIMITS.label).optional(),
    owner: z.string().max(40).optional(),
    q: z.string().max(100).optional(),
    cursor: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(SAFETY_LIMITS.list).optional(),
  }),
  response: { 200: output({ reports: z.array(reportRow), nextCursor: z.string().nullable(), people: z.array(person), asOf: instant() }) },
})

export const countsContract = defineContract({
  response: {
    200: output({
      tiles: output({ notSeen: z.number().int(), assessing: z.number().int(), accidentsToTell: z.number().int() }),
      rows: output({ open: z.number().int(), new: z.number().int(), assessing: z.number().int(), closed: z.number().int(), all: z.number().int() }),
      asOf: instant(),
    }),
  },
})

export const recordContract = defineContract({
  body: input({
    companyId: id(),
    source: z.enum(OFFICE_SOURCES),
    partyId: id().nullish(),
    contactId: id().nullish(),
    styleId: id().nullish(),
    colourwayId: id().nullish(),
    /** A mail: when it came (not in the future); default now. */
    receivedAt: instant().nullish(),
    ownerId: id().nullish(),
    ...intakeShape,
  }),
  response: { 201: output({ report: reportView, serviceCase: output({ id: id(), number: z.string() }), warnings: z.array(issue) }) },
})

export const getContract = defineContract({ params: reportParams, response: { 200: oneReport } })

export const changeContract = defineContract({
  params: reportParams,
  body: input({
    version,
    ownerId: id().nullish(),
    styleId: id().nullish(),
    colourwayId: id().nullish(),
    size: text(SAFETY_LIMITS.size).nullish(),
    serial: label,
    batchNumber: label,
    occurredOn: businessDate().nullish(),
    wornAsIntended: z.boolean().nullish(),
  }),
  response: { 200: output({ report: reportView, warnings: z.array(issue) }) },
})

export const seenContract = defineContract({ params: reportParams, body: input({ version }), response: { 200: oneReport } })

export const statusContract = defineContract({
  params: reportParams,
  /** CLOSED with what quality found and did (`note`); ASSESSING marks it seen too, when not yet. */
  body: input({ version, to: z.enum(MOVE_TARGETS), note: text(SAFETY_LIMITS.closeNote).nullish() }),
  response: { 200: oneReport },
})

export const fileContract = defineContract({
  params: reportParams,
  /** An entry of the company to name; left out: a COMPLAINT entry opened for the report (compliance.register.manage). */
  body: input({ version, registerEntryId: id().nullish() }),
  response: { 200: output({ report: reportView, registerEntry: output({ id: id(), reference: z.string(), opened: z.boolean() }) }) },
})

export const eraseContract = defineContract({
  params: reportParams,
  /** The reporter's name, e-mail and phone blanked on request (the injury's words: POST …/injury/erase). */
  body: input({ version, reason: text(SAFETY_LIMITS.eraseReason) }),
  response: { 200: oneReport },
})

// ---- whether someone was hurt (sales.safety.injury) ---------------------------------------------------------------------

export const openInjuryContract = defineContract({
  params: reportParams,
  response: {
    200: output({
      injury: output({
        reportId: id(),
        number: z.string(),
        injured: z.boolean(),
        consentAt: instant().nullable(),
        words: z.string().nullable(),
        erased: output({ at: instant(), byId: id().nullable() }).nullable(),
        recordedAt: instant(),
        recordedById: id().nullable(),
      }),
    }),
  },
})

export const recordInjuryContract = defineContract({
  params: reportParams,
  body: input({ version, injured: z.boolean(), consent: z.boolean().optional(), words: text(SAFETY_LIMITS.injuryWords).nullish() }),
  response: { 200: oneReport },
})

export const eraseInjuryContract = defineContract({ params: reportParams, body: input({ version, reason: text(SAFETY_LIMITS.eraseReason) }), response: { 200: oneReport } })

// ---- the accident log -----------------------------------------------------------------------------------------------------

export const logContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    outcome: z.enum(ACCIDENT_OUTCOMES).optional(),
    told: z.enum(['yes', 'no']).optional(),
    limit: z.coerce.number().int().min(1).max(SAFETY_LIMITS.list).optional(),
  }),
  response: {
    200: output({
      entries: z.array(revision.extend({ reportId: id(), companyId: id(), number: z.string(), reportStatus: z.enum(REPORT_STATUSES), style: style.nullable(), revisions: z.number().int(), mustTell: z.boolean(), words: z.string() })),
      /** The log's entries the filters keep (a count, never money). */
      total: notMoney(z.number().int()),
      tiles: output({ entries: z.number().int(), toTell: z.number().int(), told: z.number().int() }),
      law: z.string(),
      q37: z.string(),
      people: z.array(person),
      asOf: instant(),
    }),
  },
})

export const revisionsContract = defineContract({
  params: reportParams,
  response: { 200: output({ reportId: id(), number: z.string(), revisions: z.array(revision), state: logState, people: z.array(person) }) },
})

export const reviseContract = defineContract({
  params: reportParams,
  /** What it leaves out is the newest revision's (revision 1: the day, the place, the outcome); `authorityToldAt` by the person recording it. */
  body: input({
    version,
    occurredOn: businessDate().optional(),
    place: text(SAFETY_LIMITS.place).optional(),
    outcome: z.enum(ACCIDENT_OUTCOMES).optional(),
    styleId: id().nullish(),
    serial: label,
    batchNumber: label,
    authorityToldAt: instant().optional(),
    authorityReference: text(SAFETY_LIMITS.reference).nullish(),
    authorityNoticeId: id().nullish(),
    note: text(SAFETY_LIMITS.note).nullish(),
  }),
  response: { 201: output({ report: reportView, entry: revision }) },
})

// ---- photos ---------------------------------------------------------------------------------------------------------------

const photoBody = { originalName: z.string().min(1).max(255), contentType: z.string().min(1).max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }
const announced = output({ file: output({ id: id(), originalName: z.string(), sizeBytes: z.number().int(), status: z.string() }), upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) })
const completed = output({ file: output({ id: id(), originalName: z.string(), sizeBytes: z.number().int(), status: z.string() }) })

export const photoContract = defineContract({ params: reportParams, body: input(photoBody), response: { 201: announced } })
export const photoDoneContract = defineContract({ params: input({ reportId: id(), fileId: id() }), response: { 200: completed } })
export const openPhotoContract = defineContract({
  params: input({ reportId: id(), fileId: id() }),
  response: { 200: output({ download: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})

// ---- the doors from outside (OFF until GATE-PRIVACY) ----------------------------------------------------------------------

const statusAnswer = output({ open: z.boolean(), words: z.string().nullable() })
const sentAnswer = output({ number: z.string(), words: z.string() })

export const publicStatusContract = defineContract({ response: { 200: statusAnswer } })

export const publicSendContract = defineContract({
  body: input({
    /** The code of the public DoC page (from its QR, or typed), and which product when a code fits several (`n`). */
    code: z.string().min(1).max(200),
    n: z.number().int().min(0).max(9).optional(),
    proof: input({ challenge: z.string().max(2000), nonce: z.string().max(200) }).optional(),
    ...intakeShape,
  }),
  response: { 201: output({ sent: sentAnswer, photos: output({ ticket: z.string(), until: instant(), max: z.number().int() }) }) },
})

export const publicPhotoContract = defineContract({ body: input({ ticket: z.string().max(200), ...photoBody }), response: { 201: announced } })
export const publicPhotoDoneContract = defineContract({ params: input({ fileId: id() }), body: input({ ticket: z.string().max(200) }), response: { 200: completed } })

export const portalStatusContract = defineContract({ response: { 200: statusAnswer.extend({ mayRequest: z.boolean(), mayUpload: z.boolean() }) } })

export const portalSendContract = defineContract({
  body: input(intakeShape),
  response: { 201: output({ report: output({ id: id(), number: z.string() }), sent: sentAnswer, photos: output({ until: instant(), max: z.number().int(), mayUpload: z.boolean() }) }) },
})

export const portalPhotoContract = defineContract({ params: reportParams, body: input(photoBody), response: { 201: announced } })
export const portalPhotoDoneContract = defineContract({ params: input({ reportId: id(), fileId: id() }), response: { 200: completed } })
