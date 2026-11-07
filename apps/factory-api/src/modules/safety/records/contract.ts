import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DUE_STATES, DUE_VIEWS, RECORD_LIMITS, RECORD_RESULTS, SESSION_STATUSES, SIGN_METHODS, VALIDITY_STATES } from '@nexus/factory-domain/safety/records/rules'
import { COURSE_STATUSES, COURSE_TYPES, HOURS } from '@nexus/factory-domain/safety/training/rules'

/**
 * The training records (B-W2b-139; QHS-243, QHS-244, QHS-246, QHS-247, QHS-248; design people.skills "Record training",
 * "Instruction register", the tiles and the matrix's safety columns, the new tabs "Certificate (PDF)" and "Training due list
 * (PDF)", people.employees › "Safety training", floor.training "Training attendance"). No money. A session's attendances, a
 * person's records, the due list and the instruction register name people: legal registers (art. 37) the safety readers keep;
 * the tiles count person × course, never a figure about one person. The floor reads floor names only.
 */

const L = RECORD_LIMITS
const words = (max: number) => z.string().trim().min(1).max(max)
const maybeWords = (max: number) => z.string().trim().max(max)
const version = () => z.number().int().min(1)
const day = () => z.string()
const hours = () => z.string().trim().regex(HOURS, 'Hours with at most two decimals ("4", "1.5").')
const language = () => z.string().trim().min(2).max(8)
const names = z.record(z.string(), z.string()).nullable()
const codeName = output({ code: z.string(), name: z.string() })
const statements = output({ it: z.string(), en: z.string() })
const method = z.enum(SIGN_METHODS)
const placeQuery = { companyId: id().optional(), siteId: id().optional() }
const credentials = { badgeCode: z.string().max(64).optional(), workerId: id().optional() }
const pin = () => z.string().min(1).max(12)
const fileOut = output({ id: id(), kind: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int() })
const scanOut = output({ recordType: z.string(), recordId: id(), companyId: id() })

export const courseRefOut = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  type: z.enum(COURSE_TYPES),
  hours: z.string(),
  refresherMonths: z.number().int().nullable(),
  status: z.enum(COURSE_STATUSES),
  companyId: id().nullable(),
})

// ---- sessions ---------------------------------------------------------------------------------------------------------------

const sessionCounts = output({ signed: z.number().int(), countersigned: z.number().int(), voided: z.number().int() })

export const sessionOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  site: codeName,
  course: courseRefOut.extend({ legalBasis: z.string() }),
  heldOn: day(),
  hours: z.string(),
  language: z.string(),
  trainer: output({ employeeId: id().nullable(), name: z.string() }),
  provider: output({ id: id(), name: z.string() }).nullable(),
  location: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  /** Why signing stopped (closed, or cancelled with the reason); null while OPEN. */
  stopped: z.string().nullable(),
  closedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
  counts: sessionCounts,
  canRecord: z.boolean(),
})

export const attendanceOut = output({
  id: id(),
  employee: output({ id: id(), name: z.string(), code: z.string().nullable(), language: z.string().nullable() }),
  method,
  signedAt: instant(),
  deviceId: z.string().nullable(),
  /** A floor signature keeps the SHA-256 of the words signed. */
  verifiable: z.boolean(),
  countersign: output({ at: instant(), method, byOffice: z.string().nullable(), onFloor: z.boolean() }).nullable(),
  /** The trainer's language check (art. 37 c.13); null until countersigned. */
  languageUnderstood: z.boolean().nullable(),
  languageDiffers: z.boolean(),
  voided: output({ at: instant(), reason: z.string().nullable(), by: z.string().nullable() }).nullable(),
  recordId: id().nullable(),
  version: z.number().int(),
})

export const listSessionsContract = defineContract({
  querystring: input({ ...placeQuery, status: z.enum([...SESSION_STATUSES, 'all']).optional(), courseId: id().optional(), from: businessDate().optional(), to: businessDate().optional() }),
  response: { 200: output({ sessions: z.array(sessionOut), complete: z.boolean(), canOpen: z.boolean(), today: day() }) },
})

export const sessionRecordContract = defineContract({
  params: input({ sessionId: id() }),
  response: {
    200: output({
      session: sessionOut,
      attendances: z.array(attendanceOut),
      records: z.array(output({ id: id(), employeeId: id(), result: z.enum(RECORD_RESULTS), validUntil: day().nullable(), languageChecked: z.boolean() })),
      /** The paper sheet's scans (files of the session). */
      scans: z.array(fileOut),
      statements: output({ attendance: statements, countersign: statements }),
      scan: scanOut,
      law: output({ training: z.string(), language: z.string() }),
      today: day(),
    }),
  },
})

const sessionFields = {
  heldOn: businessDate(),
  hours: hours(),
  language: language(),
  trainerEmployeeId: id().nullable().optional(),
  trainerName: maybeWords(L.trainerName).nullable().optional(),
  providerPartyId: id().nullable().optional(),
  location: maybeWords(L.location).nullable().optional(),
  note: maybeWords(L.note).nullable().optional(),
}

export const openSessionContract = defineContract({
  body: input({ siteId: id(), courseId: id(), ...sessionFields }),
  response: { 200: output({ session: sessionOut }), 201: output({ session: sessionOut }) },
})

export const editSessionContract = defineContract({
  params: input({ sessionId: id() }),
  body: input({ version: version(), heldOn: businessDate().optional(), hours: hours().optional(), language: language().optional(), trainerEmployeeId: sessionFields.trainerEmployeeId, trainerName: sessionFields.trainerName, providerPartyId: sessionFields.providerPartyId, location: sessionFields.location, note: sessionFields.note }),
  response: { 200: output({ session: sessionOut }) },
})

export const paperAttendanceContract = defineContract({
  params: input({ sessionId: id() }),
  body: input({ employeeIds: z.array(id()).min(1).max(L.people) }),
  response: { 200: output({ attendances: z.array(attendanceOut), scan: scanOut }) },
})

const countersignLines = z.array(input({ attendanceId: id(), languageUnderstood: z.boolean() })).min(1).max(L.attendances)

export const countersignContract = defineContract({
  params: input({ sessionId: id() }),
  body: input({ method: z.enum(['PAPER', 'OFFICE']), attendances: countersignLines }),
  response: { 200: output({ attendances: z.array(attendanceOut) }) },
})

export const voidAttendanceContract = defineContract({
  params: input({ sessionId: id(), attendanceId: id() }),
  body: input({ version: version(), reason: words(L.reason) }),
  response: { 200: output({ attendance: attendanceOut }) },
})

export const closeSessionContract = defineContract({
  params: input({ sessionId: id() }),
  body: input({ version: version(), results: z.array(input({ attendanceId: id(), result: z.enum(['PASSED', 'FAILED']), note: maybeWords(L.note).nullable().optional() })).max(L.attendances).optional() }),
  response: {
    200: output({
      session: sessionOut,
      records: z.array(output({ id: id(), employeeId: id(), attendanceId: id(), result: z.enum(['PASSED', 'FAILED']), validUntil: day().nullable(), languageChecked: z.boolean() })),
    }),
  },
})

export const cancelSessionContract = defineContract({
  params: input({ sessionId: id() }),
  body: input({ version: version(), reason: words(L.reason) }),
  response: { 200: output({ session: sessionOut }) },
})

// ---- records ----------------------------------------------------------------------------------------------------------------

export const recordOut = output({
  id: id(),
  employeeId: id(),
  companyId: id(),
  course: courseRefOut.extend({ legalBasis: z.string() }),
  completedOn: day(),
  hours: z.string(),
  trainerName: z.string(),
  result: z.enum(RECORD_RESULTS),
  validUntil: day().nullable(),
  validUntilReason: z.string().nullable(),
  /** A PASSED record that stands: VALID, DUE_SOON or EXPIRED; null otherwise. */
  validity: z.enum(VALIDITY_STATES).nullable(),
  language: z.string(),
  languageChecked: z.boolean(),
  correctedBy: id().nullable(),
  corrects: output({ id: id(), reason: z.string().nullable() }).nullable(),
  standing: z.boolean(),
  session: output({ id: id(), heldOn: day(), location: z.string().nullable() }).nullable(),
  signed: output({ method, countersignMethod: method.nullable() }).nullable(),
  note: z.string().nullable(),
  /** The provider's certificate and other files of the record. */
  certificates: z.array(fileOut),
  createdAt: instant(),
})

/** The design's DueCell: valid until, due soon, expired, Needed; shaded = required by the role sheet. */
export const dueCellOut = output({
  courseId: id(),
  state: z.enum(DUE_STATES),
  needed: z.boolean(),
  required: z.boolean(),
  dueOn: day().nullable(),
  overdue: z.boolean(),
  soon: z.boolean(),
  neededBy: day().nullable(),
  record: output({ id: id(), completedOn: day(), validUntil: day().nullable(), languageChecked: z.boolean() }).nullable(),
  lastResult: z.enum(['PASSED', 'FAILED']).nullable(),
  languageNotChecked: z.boolean(),
})

const dueTiles = output({ overdue: z.number().int(), dueSoon: z.number().int(), languageNotChecked: z.number().int() })
const certificateOut = output({ recordType: z.string(), kind: z.literal('CERTIFICATE'), companyId: id() })

export const instructionOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  site: codeName,
  employee: output({ id: id(), name: z.string(), code: z.string().nullable() }),
  instructedOn: day(),
  task: z.string(),
  machineClass: output({ id: id(), code: z.string(), label: output({ it: z.string(), en: z.string() }) }).nullable(),
  machine: output({ id: id(), assetNumber: z.string() }).nullable(),
  instructor: output({ employeeId: id().nullable(), name: z.string() }),
  minutes: z.number().int(),
  language: z.string(),
  languageChecked: z.boolean(),
  signed: output({ at: instant(), method, verifiable: z.boolean() }).nullable(),
  voided: output({ at: instant(), reason: z.string().nullable(), by: z.string().nullable() }).nullable(),
  note: z.string().nullable(),
  scans: z.array(fileOut),
  version: z.number().int(),
  canChange: z.boolean(),
})

export const personTrainingContract = defineContract({
  params: input({ employeeId: id() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string(), code: z.string().nullable(), companyId: id(), siteId: id(), language: z.string(), status: z.enum(['ACTIVE', 'LEFT']), roleSheet: output({ id: id(), code: z.string(), name: z.string() }).nullable() }),
      cells: z.array(dueCellOut),
      counts: dueTiles,
      records: z.array(recordOut),
      instruction: z.array(instructionOut),
      courses: z.array(courseRefOut),
      canRecord: z.boolean(),
      canInstruct: z.boolean(),
      certificate: certificateOut,
      law: output({ training: z.string(), language: z.string() }),
      today: day(),
    }),
  },
})

const recordedOut = output({ records: z.array(recordOut), certificate: certificateOut.extend({ recordIds: z.array(id()) }) })

export const recordTrainingContract = defineContract({
  body: input({
    courseId: id(),
    completedOn: businessDate(),
    hours: hours(),
    trainerName: words(L.trainerName),
    language: language(),
    people: z
      .array(
        input({
          employeeId: id(),
          result: z.enum(['PASSED', 'FAILED']),
          languageChecked: z.boolean(),
          validUntil: businessDate().nullable().optional(),
          validUntilReason: maybeWords(L.reason).nullable().optional(),
          note: maybeWords(L.note).nullable().optional(),
        }),
      )
      .min(1)
      .max(L.people),
  }),
  response: { 200: recordedOut, 201: recordedOut },
})

export const correctRecordContract = defineContract({
  params: input({ recordId: id() }),
  body: input({
    reason: words(L.reason),
    result: z.enum(RECORD_RESULTS).optional(),
    completedOn: businessDate().optional(),
    hours: hours().optional(),
    trainerName: words(L.trainerName).optional(),
    language: language().optional(),
    languageChecked: z.boolean().optional(),
    validUntil: businessDate().nullable().optional(),
    validUntilReason: maybeWords(L.reason).nullable().optional(),
    note: maybeWords(L.note).nullable().optional(),
  }),
  response: { 200: output({ record: recordOut, corrected: recordOut }) },
})

export const recordPdfContract = defineContract({
  params: input({ recordId: id() }),
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  response: {},
})

// ---- due and overdue ----------------------------------------------------------------------------------------------------------

const dueQuery = { ...placeQuery, courseId: id().optional(), roleSheetId: id().optional(), view: z.enum(DUE_VIEWS).optional(), q: z.string().trim().max(80).optional() }

export const dueListContract = defineContract({
  querystring: input(dueQuery),
  response: {
    200: output({
      rows: z.array(
        dueCellOut.omit({ courseId: true }).extend({
          employee: output({ id: id(), name: z.string(), companyId: id(), siteId: id(), site: codeName.nullable() }),
          courseId: id(),
          why: z.enum(['ROLE', 'MACHINE', 'NONE']),
        }),
      ),
      complete: z.boolean(),
      courses: z.array(courseRefOut),
      /** Person × course over everyone in reach of the company and site asked (never narrowed by the search). */
      tiles: dueTiles,
      view: z.enum(DUE_VIEWS),
      canRecord: z.boolean(),
      canInstruct: z.boolean(),
      law: z.string(),
      today: day(),
    }),
  },
})

export const dueListPdfContract = defineContract({
  querystring: input({ ...dueQuery, language: z.enum(['it', 'en']).optional() }),
  response: {},
})

// ---- the instruction register ------------------------------------------------------------------------------------------------

export const listInstructionContract = defineContract({
  querystring: input({
    ...placeQuery,
    employeeId: id().optional(),
    machineClassId: id().optional(),
    view: z.enum(['all', 'unsigned', 'signed', 'voided']).optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    q: z.string().trim().max(80).optional(),
  }),
  response: { 200: output({ entries: z.array(instructionOut), complete: z.boolean(), canAdd: z.boolean(), statement: statements, law: output({ instruction: z.string(), language: z.string() }), today: day() }) },
})

const entryOut = output({ entry: instructionOut, scan: scanOut })

export const addInstructionContract = defineContract({
  body: input({
    employeeId: id(),
    siteId: id().optional(),
    instructedOn: businessDate().optional(),
    task: words(L.task),
    machineClassId: id().nullable().optional(),
    machineId: id().nullable().optional(),
    instructorEmployeeId: id().nullable().optional(),
    instructorName: maybeWords(L.trainerName).nullable().optional(),
    minutes: z.number().int(),
    language: language(),
    languageChecked: z.boolean().optional(),
    note: maybeWords(L.note).nullable().optional(),
    paper: z.boolean().optional(),
  }),
  response: { 200: entryOut, 201: entryOut },
})

export const paperInstructionContract = defineContract({
  params: input({ instructionId: id() }),
  body: input({ version: version() }),
  response: { 200: entryOut },
})

export const voidInstructionContract = defineContract({
  params: input({ instructionId: id() }),
  body: input({ version: version(), reason: words(L.reason) }),
  response: { 200: output({ entry: instructionOut }) },
})

// ---- the floor ---------------------------------------------------------------------------------------------------------------

const floorSessionOut = output({
  id: id(),
  course: output({ id: id(), code: z.string(), name: z.string(), nameI18n: names }),
  heldOn: day(),
  hours: z.string(),
  language: z.string(),
  trainerName: z.string(),
  location: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  stopped: z.string().nullable(),
  signed: z.number().int(),
  countersigned: z.number().int(),
  version: z.number().int(),
})
const workerOut = output({ id: id(), displayName: z.string() })
const signedCounts = { signed: z.number().int(), countersigned: z.number().int() }

export const floorSessionsContract = defineContract({
  response: { 200: output({ sessions: z.array(floorSessionOut) }) },
})

export const floorSessionContract = defineContract({
  params: input({ sessionId: id() }),
  response: {
    200: output({
      session: floorSessionOut,
      attendances: z.array(output({ id: id(), displayName: z.string().nullable(), method: z.enum(['FLOOR_PIN', 'PAPER']), signedAt: instant(), countersigned: z.boolean(), languageUnderstood: z.boolean().nullable() })),
      trainer: output({ name: z.string(), workerId: id().nullable(), countersignsHere: z.boolean() }),
      statements: output({ attendance: statements, countersign: statements }),
    }),
  },
})

export const floorSignContract = defineContract({
  params: input({ sessionId: id() }),
  body: input({ ...credentials, pin: pin() }),
  response: { 200: output({ attendance: output({ id: id(), signedAt: instant(), worker: workerOut, statement: z.string(), sha256: z.string() }), ...signedCounts }) },
})

export const floorCountersignContract = defineContract({
  params: input({ sessionId: id() }),
  body: input({ ...credentials, pin: pin(), attendances: countersignLines }),
  response: { 200: output({ attendanceIds: z.array(id()), trainer: workerOut, statement: z.string(), ...signedCounts }) },
})

export const floorInstructionPendingContract = defineContract({
  body: input(credentials),
  response: {
    200: output({
      worker: workerOut,
      entries: z.array(
        output({
          id: id(),
          instructedOn: day(),
          task: z.string(),
          machineClass: output({ code: z.string(), label: output({ it: z.string(), en: z.string() }) }).nullable(),
          machine: output({ assetNumber: z.string() }).nullable(),
          instructorName: z.string(),
          minutes: z.number().int(),
          language: z.string(),
          version: z.number().int(),
        }),
      ),
      statement: z.string(),
    }),
  },
})

export const floorInstructionSignContract = defineContract({
  params: input({ instructionId: id() }),
  body: input({ ...credentials, pin: pin() }),
  response: { 200: output({ instruction: output({ id: id(), signedAt: instant(), worker: workerOut, statement: z.string(), sha256: z.string() }) }) },
})
