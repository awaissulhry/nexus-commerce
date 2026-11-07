import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'
import { COURSE_FIELDS, COURSE_STATUSES, COURSE_TYPES, DUE_STATES, DUE_VIEWS, NEED_STATES, RECORD_RESULTS, SESSION_STATUSES, SIGN_METHODS, VALIDITY_STATES } from './constants'

/**
 * Every call of the training part of People › Skills & training (B-W2b-146) on the API of B-W2b-133 (the course catalogue,
 * who needs what) and B-W2b-139 (records, the due list, the instruction register, the two PDFs). The answer's shape is
 * checked (zod; unknown fields dropped, the API's English never drawn). A legal register names people (art. 37): the lists
 * here carry counts, names come only inside one record (a role's or a machine type's people) or in the registers the
 * safety readers keep. No money anywhere. Every write is one command with its own Idempotency-Key and the version read.
 */

export type CourseType = (typeof COURSE_TYPES)[number]
export type CourseStatus = (typeof COURSE_STATUSES)[number]
export type CourseField = (typeof COURSE_FIELDS)[number]
export type NeedState = (typeof NEED_STATES)[number]
export type DueState = (typeof DUE_STATES)[number]
export type DueView = (typeof DUE_VIEWS)[number]
export type RecordResult = (typeof RECORD_RESULTS)[number]
export type SignMethod = (typeof SIGN_METHODS)[number]
export type Validity = (typeof VALIDITY_STATES)[number]

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const names = z.record(z.string(), z.string()).nullable()
const codeName = z.object({ code: z.string(), name: z.string() })
const law = z.object({ training: z.string(), agreement: z.string(), machines: z.string() })
const counts = { people: z.number(), met: z.number(), due: z.number(), overdue: z.number() }

// ---- the course catalogue (B-W2b-133) ------------------------------------------------------------------------------------

const courseSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  company: codeName.nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  type: z.enum(COURSE_TYPES),
  hours: z.string(),
  refresherMonths: z.number().nullable(),
  refresherHours: z.string().nullable(),
  inPersonRequired: z.boolean(),
  provider: z.string().nullable(),
  legalBasis: z.string(),
  sortOrder: z.number(),
  status: z.enum(COURSE_STATUSES),
  version: z.number(),
  updatedAt: z.string(),
  requiredBy: z.object({ roleSheets: z.number(), machineClasses: z.number() }),
  canManage: z.boolean(),
})
export type Course = z.infer<typeof courseSchema>

export const courseRefSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, type: z.string(), hours: z.string(), refresherMonths: z.number().nullable(), status: z.string(), companyId: z.string().nullable() })
export type CourseRef = z.infer<typeof courseRefSchema>

const coursesSchema = z.object({ courses: z.array(courseSchema), complete: z.boolean(), canAdd: z.boolean(), canAddGroupWide: z.boolean(), law, today: z.string() })
export type Courses = z.infer<typeof coursesSchema>

export const listCourses = (api: ApiClient, query: { companyId?: string | null; status?: 'ACTIVE' | 'ARCHIVED' | 'all'; q?: string } = {}) =>
  api.get('/safety/training/courses', { query: clean({ companyId: query.companyId, status: query.status, q: query.q?.trim() }), schema: coursesSchema })

const roleRef = z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, companyId: z.string(), siteId: z.string(), site: codeName })
const classRef = z.object({ id: z.string(), code: z.string(), label: z.record(z.string(), z.string()), icon: z.string().nullable(), active: z.boolean() })
export type ClassRef = z.infer<typeof classRef>

const courseRecordSchema = z.object({
  course: courseSchema,
  createdAt: z.string(),
  askedBy: z.object({ roleSheets: z.array(roleRef.extend({ withinDays: z.number().nullable() })), machineClasses: z.array(classRef.extend({ withinDays: z.number().nullable() })) }),
  people: z.object(counts),
  law,
  today: z.string(),
})
export type CourseRecord = z.infer<typeof courseRecordSchema>

export const getCourse = (api: ApiClient, courseId: string) => api.get(`/safety/training/courses/${seg(courseId)}`, { schema: courseRecordSchema })

const standardSchema = z.object({
  courses: z.array(
    z.object({
      code: z.string(),
      type: z.enum(COURSE_TYPES),
      name: z.string(),
      nameI18n: z.record(z.string(), z.string()),
      legalBasis: z.string(),
      codeTaken: z.boolean(),
      existing: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.enum(COURSE_STATUSES) })),
    }),
  ),
  canAddGroupWide: z.boolean(),
  law,
})
export type StandardList = z.infer<typeof standardSchema>
export type StandardCourse = StandardList['courses'][number]

export const getStandardList = (api: ApiClient, companyId?: string | null) => api.get('/safety/training/courses/standard', { query: clean({ companyId }), schema: standardSchema })

/** The fields of a new course as sent (hours as "12" or "12.5"). */
export interface NewCourseBody {
  code: string
  type: CourseType
  name: string
  nameI18n?: Record<string, string> | null
  hours: string
  refresherMonths?: number | null
  refresherHours?: string | null
  inPersonRequired?: boolean
  provider?: string | null
  legalBasis?: string
}

export const addStandardCourses = (api: ApiClient, body: { companyId: string | null; courses: NewCourseBody[] }) =>
  api.post('/safety/training/courses/standard', { body, schema: z.object({ courses: z.array(courseSchema) }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.courses)

export const createCourse = (api: ApiClient, body: NewCourseBody & { companyId: string | null }) =>
  api.post('/safety/training/courses', { body, schema: z.object({ course: courseSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.course)

/** A course's draft: the fields left out stay as they are. */
export type CourseDraftBody = Partial<Omit<NewCourseBody, 'code' | 'type'>>

const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), z.string())])
const previewShape = {
  changes: z.array(z.object({ field: z.enum(COURSE_FIELDS), from: fieldValue, to: fieldValue })),
  refresher: z
    .object({
      from: z.number().nullable(),
      to: z.number().nullable(),
      holders: z.number(),
      followPeriod: z.number(),
      wouldMove: z.number(),
      ownDate: z.number(),
      people: z.array(z.object({ employeeId: z.string(), name: z.string(), completedOn: z.string(), validUntil: z.string().nullable(), withNewPeriod: z.string().nullable() })),
    })
    .nullable(),
  fingerprint: z.string(),
}
const previewSchema = z.object({ course: courseSchema, ...previewShape })
export type CoursePreview = z.infer<typeof previewSchema>

export const previewCourse = (api: ApiClient, courseId: string, draft: CourseDraftBody) => api.post(`/safety/training/courses/${seg(courseId)}/preview`, { body: draft, schema: previewSchema })

export const saveCourse = (api: ApiClient, courseId: string, body: CourseDraftBody & { version: number; impactFingerprint?: string }) =>
  api.request('PATCH', `/safety/training/courses/${seg(courseId)}`, { body, schema: z.object({ course: courseSchema, ...previewShape, changed: z.boolean() }), idempotencyKey: newIdempotencyKey() })

export const setCourseStatus = (api: ApiClient, courseId: string, to: 'archive' | 'restore', version: number) =>
  api.post(`/safety/training/courses/${seg(courseId)}/${to}`, { body: { version }, schema: z.object({ course: courseSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.course)

// ---- who needs what (B-W2b-133) -------------------------------------------------------------------------------------------

const requirementSchema = z.object({ courseId: z.string(), withinDays: z.number().nullable(), note: z.string().nullable(), ...counts })
export type Requirement = z.infer<typeof requirementSchema>

const requirementsSchema = z.object({
  roleSheets: z.array(roleRef.extend({ people: z.number(), courses: z.array(requirementSchema) })),
  machineClasses: z.array(classRef.extend({ people: z.number(), courses: z.array(requirementSchema) })),
  overall: z.object({ ...counts, needs: z.number() }),
  courses: z.array(courseRefSchema),
  complete: z.boolean(),
  canManageClasses: z.boolean(),
  law,
  today: z.string(),
})
export type Requirements = z.infer<typeof requirementsSchema>

export const getRequirements = (api: ApiClient, query: { companyId?: string | null; siteId?: string | null }) =>
  api.get('/safety/training/requirements', { query: clean({ companyId: query.companyId, siteId: query.siteId }), schema: requirementsSchema })

const personNeedSchema = z.object({ employeeId: z.string(), name: z.string(), siteId: z.string(), since: z.string(), courses: z.array(z.object({ courseId: z.string(), dueOn: z.string(), state: z.enum(NEED_STATES) })) })
export type PersonNeed = z.infer<typeof personNeedSchema>

const roleNeedsSchema = z.object({ roleSheet: roleRef.extend({ status: z.string() }), courses: z.array(requirementSchema.extend({ id: z.string() })), people: z.array(personNeedSchema), refs: z.array(courseRefSchema), law, today: z.string() })
const classNeedsSchema = z.object({
  machineClass: classRef,
  courses: z.array(requirementSchema.extend({ id: z.string(), version: z.number() })),
  people: z.array(personNeedSchema),
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  refs: z.array(courseRefSchema),
  canManage: z.boolean(),
  law,
  today: z.string(),
})
export type RoleNeeds = z.infer<typeof roleNeedsSchema>
export type ClassNeeds = z.infer<typeof classNeedsSchema>

export const getRoleNeeds = (api: ApiClient, roleSheetId: string) => api.get(`/safety/training/requirements/role-sheets/${seg(roleSheetId)}`, { schema: roleNeedsSchema })
export const getClassNeeds = (api: ApiClient, machineClassId: string) => api.get(`/safety/training/requirements/machine-classes/${seg(machineClassId)}`, { schema: classNeedsSchema })

export interface RequirementLine {
  courseId: string
  withinDays: number | null
  note?: string | null
}

const impactSchema = z.object({
  kind: z.string(),
  courseId: z.string().nullable(),
  people: z.number(),
  already: z.number(),
  names: z.array(z.object({ employeeId: z.string(), name: z.string() })).nullable(),
  withinDays: z.object({ from: z.number().nullable(), to: z.number().nullable() }).nullable(),
})
export type ImpactLine = z.infer<typeof impactSchema>
const classPreviewShape = {
  machineClass: classRef,
  changes: z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.object({ courseId: z.string(), withinDays: z.object({ from: z.number().nullable(), to: z.number().nullable() }) })), noted: z.array(z.string()), nothing: z.boolean() }),
  impact: z.array(impactSchema),
  people: z.number(),
  refs: z.array(courseRefSchema),
  fingerprint: z.string(),
}
const classPreviewSchema = z.object(classPreviewShape)
export type ClassPreview = z.infer<typeof classPreviewSchema>

export const previewClassCourses = (api: ApiClient, machineClassId: string, requirements: RequirementLine[]) =>
  api.post(`/safety/training/requirements/machine-classes/${seg(machineClassId)}/preview`, { body: { requirements }, schema: classPreviewSchema })

export const applyClassCourses = (api: ApiClient, machineClassId: string, requirements: RequirementLine[], fingerprint: string) =>
  api.request('PUT', `/safety/training/requirements/machine-classes/${seg(machineClassId)}`, { body: { requirements, fingerprint }, schema: z.object({ ...classPreviewShape, applied: z.boolean() }), idempotencyKey: newIdempotencyKey() })

// ---- records (B-W2b-139) ------------------------------------------------------------------------------------------------------

const fileSchema = z.object({ id: z.string(), kind: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number() })
export type RecordFile = z.infer<typeof fileSchema>

export const recordSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  companyId: z.string(),
  course: courseRefSchema.extend({ legalBasis: z.string() }),
  completedOn: z.string(),
  hours: z.string(),
  trainerName: z.string(),
  result: z.enum(RECORD_RESULTS),
  validUntil: z.string().nullable(),
  validUntilReason: z.string().nullable(),
  validity: z.enum(VALIDITY_STATES).nullable(),
  language: z.string(),
  languageChecked: z.boolean(),
  correctedBy: z.string().nullable(),
  corrects: z.object({ id: z.string(), reason: z.string().nullable() }).nullable(),
  standing: z.boolean(),
  session: z.object({ id: z.string(), heldOn: z.string(), location: z.string().nullable() }).nullable(),
  signed: z.object({ method: z.enum(SIGN_METHODS), countersignMethod: z.enum(SIGN_METHODS).nullable() }).nullable(),
  note: z.string().nullable(),
  certificates: z.array(fileSchema),
  createdAt: z.string(),
})
export type TrainingRecord = z.infer<typeof recordSchema>

/** The design's DueCell of one person × course. */
export const dueCellSchema = z.object({
  courseId: z.string(),
  state: z.enum(DUE_STATES),
  needed: z.boolean(),
  required: z.boolean(),
  dueOn: z.string().nullable(),
  overdue: z.boolean(),
  soon: z.boolean(),
  neededBy: z.string().nullable(),
  record: z.object({ id: z.string(), completedOn: z.string(), validUntil: z.string().nullable(), languageChecked: z.boolean() }).nullable(),
  lastResult: z.enum(['PASSED', 'FAILED']).nullable(),
  languageNotChecked: z.boolean(),
})
export type DueCellValue = z.infer<typeof dueCellSchema>

/** One person's lines of "Record training". */
export interface RecordPersonBody {
  employeeId: string
  result: 'PASSED' | 'FAILED'
  languageChecked: boolean
  validUntil?: string | null
  validUntilReason?: string | null
  note?: string | null
}

export interface RecordTrainingBody {
  courseId: string
  completedOn: string
  hours: string
  trainerName: string
  language: string
  people: RecordPersonBody[]
}

const recordedSchema = z.object({ records: z.array(recordSchema), certificate: z.object({ recordType: z.string(), kind: z.literal('CERTIFICATE'), companyId: z.string(), recordIds: z.array(z.string()) }) })
export type Recorded = z.infer<typeof recordedSchema>

/** POST /safety/training/records (safety.training.record): training given elsewhere, one record per person, in one command. */
export const recordTraining = (api: ApiClient, body: RecordTrainingBody, idempotencyKey: string = newIdempotencyKey()) => api.post('/safety/training/records', { body, schema: recordedSchema, idempotencyKey })

/** The provider's certificate onto one record (files.upload): announce, send, confirm (POST /files kind CERTIFICATE). */
export async function uploadCertificate(api: ApiClient, record: { id: string; companyId: string }, file: File): Promise<void> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'application/pdf'
  const { file: stored, upload } = await requestUpload(api, {
    companyId: record.companyId,
    record: { type: 'TrainingRecord', id: record.id },
    kind: 'CERTIFICATE',
    name: file.name || 'certificate.pdf',
    contentType,
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
}

/** GET /safety/training/records/:id/pdf (safety.view): the register's record, made now, stored nowhere. */
export const recordPdf = (api: ApiClient, recordId: string, language: 'it' | 'en') => api.bytes(`/safety/training/records/${seg(recordId)}/pdf`, { query: { language } })

// ---- sessions held elsewhere, closed from the office ("from the floor sign-off", QHS-248) ---------------------------------------

const sessionSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  course: courseRefSchema.extend({ legalBasis: z.string() }),
  heldOn: z.string(),
  hours: z.string(),
  language: z.string(),
  trainer: z.object({ employeeId: z.string().nullable(), name: z.string() }),
  location: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  version: z.number(),
  counts: z.object({ signed: z.number(), countersigned: z.number(), voided: z.number() }),
  canRecord: z.boolean(),
})
export type TrainingSession = z.infer<typeof sessionSchema>

export const listOpenSessions = (api: ApiClient, query: { companyId?: string | null; siteId?: string | null }) =>
  api.get('/safety/training/sessions', { query: clean({ companyId: query.companyId, siteId: query.siteId, status: 'OPEN' }), schema: z.object({ sessions: z.array(sessionSchema), complete: z.boolean(), canOpen: z.boolean(), today: z.string() }) })

const attendanceSchema = z.object({
  id: z.string(),
  employee: z.object({ id: z.string(), name: z.string(), code: z.string().nullable(), language: z.string().nullable() }),
  method: z.enum(SIGN_METHODS),
  signedAt: z.string(),
  countersign: z.object({ at: z.string(), method: z.enum(SIGN_METHODS), byOffice: z.string().nullable(), onFloor: z.boolean() }).nullable(),
  languageUnderstood: z.boolean().nullable(),
  languageDiffers: z.boolean(),
  voided: z.object({ at: z.string(), reason: z.string().nullable(), by: z.string().nullable() }).nullable(),
  recordId: z.string().nullable(),
  version: z.number(),
})
export type Attendance = z.infer<typeof attendanceSchema>

export const getSession = (api: ApiClient, sessionId: string) =>
  api.get(`/safety/training/sessions/${seg(sessionId)}`, { schema: z.object({ session: sessionSchema, attendances: z.array(attendanceSchema), today: z.string() }) })

/** POST /safety/training/sessions/:id/close: one record per countersigned attendance; signing stops. */
export const closeSession = (api: ApiClient, sessionId: string, body: { version: number; results: { attendanceId: string; result: 'PASSED' | 'FAILED' }[] }) =>
  api.post(`/safety/training/sessions/${seg(sessionId)}/close`, {
    body,
    schema: z.object({ session: sessionSchema, records: z.array(z.object({ id: z.string(), employeeId: z.string(), attendanceId: z.string(), result: z.enum(['PASSED', 'FAILED']), validUntil: z.string().nullable(), languageChecked: z.boolean() })) }),
    idempotencyKey: newIdempotencyKey(),
  })

// ---- the due list (B-W2b-139) -----------------------------------------------------------------------------------------------

/** GET /safety/training/due/pdf (safety.view): the list as filtered, for the RSPP or the provider (made now). */
export const dueListPdf = (api: ApiClient, query: { companyId?: string | null; siteId?: string | null; courseId?: string | null; roleSheetId?: string | null; view?: DueView | null; language: 'it' | 'en' }) =>
  api.bytes('/safety/training/due/pdf', { query: clean({ ...query }) })

const dueListSchema = z.object({ rows: z.array(z.object({ employee: z.object({ id: z.string(), name: z.string(), companyId: z.string(), siteId: z.string() }), courseId: z.string() })), complete: z.boolean(), courses: z.array(courseRefSchema), tiles: z.object({ overdue: z.number(), dueSoon: z.number(), languageNotChecked: z.number() }), view: z.enum(DUE_VIEWS), law: z.string(), today: z.string() })
export type DueListHead = z.infer<typeof dueListSchema>

/** GET /safety/training/due (safety.view): the register by name; here for the PDF window's tiles and the pickers' people. */
export const dueListHead = (api: ApiClient, query: { companyId?: string | null; siteId?: string | null; courseId?: string | null; view?: DueView | null }) =>
  api.get('/safety/training/due', { query: clean({ ...query }), schema: dueListSchema })

/** The people the due list names (every person × course in reach, `view=all`), once each: the pickers of a safety reader without the matrix. */
export const dueListPeople = (api: ApiClient, query: { companyId?: string | null; siteId?: string | null }) =>
  dueListHead(api, { ...query, view: 'all' }).then((answer) => {
    const seen = new Map<string, { employeeId: string; name: string; companyId: string; siteId: string }>()
    for (const row of answer.rows) if (!seen.has(row.employee.id)) seen.set(row.employee.id, { employeeId: row.employee.id, name: row.employee.name, companyId: row.employee.companyId, siteId: row.employee.siteId })
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

// ---- the instruction register (B-W2b-139) -------------------------------------------------------------------------------------

export const instructionSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: codeName,
  employee: z.object({ id: z.string(), name: z.string(), code: z.string().nullable() }),
  instructedOn: z.string(),
  task: z.string(),
  machineClass: z.object({ id: z.string(), code: z.string(), label: z.object({ it: z.string(), en: z.string() }) }).nullable(),
  machine: z.object({ id: z.string(), assetNumber: z.string() }).nullable(),
  instructor: z.object({ employeeId: z.string().nullable(), name: z.string() }),
  minutes: z.number(),
  language: z.string(),
  languageChecked: z.boolean(),
  signed: z.object({ at: z.string(), method: z.enum(SIGN_METHODS), verifiable: z.boolean() }).nullable(),
  voided: z.object({ at: z.string(), reason: z.string().nullable(), by: z.string().nullable() }).nullable(),
  note: z.string().nullable(),
  version: z.number(),
  canChange: z.boolean(),
})
export type InstructionEntry = z.infer<typeof instructionSchema>

export type InstructionView = 'all' | 'unsigned' | 'signed' | 'voided'
const instructionListSchema = z.object({ entries: z.array(instructionSchema), complete: z.boolean(), canAdd: z.boolean(), law: z.object({ instruction: z.string(), language: z.string() }), today: z.string() })
export type InstructionList = z.infer<typeof instructionListSchema>

export const listInstruction = (api: ApiClient, query: { companyId?: string | null; siteId?: string | null; employeeId?: string | null; view?: InstructionView; q?: string }) =>
  api.get('/safety/training/instruction', { query: clean({ companyId: query.companyId, siteId: query.siteId, employeeId: query.employeeId, view: query.view, q: query.q?.trim() }), schema: instructionListSchema })

export interface InstructionBody {
  employeeId: string
  siteId?: string
  instructedOn?: string
  task: string
  machineClassId?: string | null
  instructorEmployeeId?: string | null
  instructorName?: string | null
  minutes: number
  language: string
  languageChecked?: boolean
  note?: string | null
  /** Signed on paper in the office (the scan follows); left out: the person signs on the floor with their PIN. */
  paper?: boolean
}

const entryAnswer = z.object({ entry: instructionSchema })
export const addInstruction = (api: ApiClient, body: InstructionBody) => api.post('/safety/training/instruction', { body, schema: entryAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.entry)
export const paperInstruction = (api: ApiClient, id: string, version: number) => api.post(`/safety/training/instruction/${seg(id)}/paper`, { body: { version }, schema: entryAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.entry)
export const voidInstruction = (api: ApiClient, id: string, body: { version: number; reason: string }) => api.post(`/safety/training/instruction/${seg(id)}/void`, { body, schema: entryAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.entry)

// ---- one person's safety training (Employee › Skills & training) -------------------------------------------------------------

const personTrainingSchema = z.object({
  employee: z.object({ id: z.string(), name: z.string(), code: z.string().nullable(), companyId: z.string(), siteId: z.string(), language: z.string(), status: z.enum(['ACTIVE', 'LEFT']), roleSheet: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable() }),
  cells: z.array(dueCellSchema),
  counts: z.object({ overdue: z.number(), dueSoon: z.number(), languageNotChecked: z.number() }),
  records: z.array(recordSchema),
  instruction: z.array(instructionSchema),
  courses: z.array(courseRefSchema),
  canRecord: z.boolean(),
  canInstruct: z.boolean(),
  law: z.object({ training: z.string(), language: z.string() }),
  today: z.string(),
})
export type PersonTraining = z.infer<typeof personTrainingSchema>

export const getPersonTraining = (api: ApiClient, employeeId: string) => api.get(`/safety/training/people/${seg(employeeId)}`, { schema: personTrainingSchema })
