import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_INSTRUCTION_RECORD, SAFETY_TRAINING_RECORD } from '@nexus/factory-domain/safety/records/permissions'
import { stoppedWords, validityOf, type RecordResult, type SessionStatus, type SignMethod } from '@nexus/factory-domain/safety/records/rules'
import type { CourseType } from '@nexus/factory-domain/safety/training/rules'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { userNames } from '../../people/employees/employees'
import { dayOf, dayOrNull, mayAt, refuse, type SafetyPlace } from '../organisation/access'

/**
 * The training records as the screens read them (B-W2b-139): every read names its columns. A person's records, a session's
 * attendances and the instruction register name people: legal registers (art. 37) the safety readers keep (safety.view over
 * the person's company and site, as the role sheets' people); lists that are not registers carry counts. No money.
 */

type Client = FactoryClient | CommandTx

export const RECORD_SESSION = 'TrainingSession'
export const RECORD_ATTENDANCE = 'TrainingAttendance'
export const RECORD_TRAINING = 'TrainingRecord'
export const RECORD_INSTRUCTION = 'InstructionRecord'

export const mayRead = (context: OfficeContext, place: SafetyPlace): boolean => mayAt(context, SAFETY_VIEW, place)
export const mayRecord = (context: OfficeContext, place: SafetyPlace): boolean => mayAt(context, SAFETY_TRAINING_RECORD, place)
export const mayInstruct = (context: OfficeContext, place: SafetyPlace): boolean => mayAt(context, SAFETY_INSTRUCTION_RECORD, place)

export const i18nOf = (value: Prisma.JsonValue | null): Record<string, string> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)
export const fullName = (row: { readonly firstName: string; readonly lastName: string }): string => `${row.firstName} ${row.lastName}`

const COURSE_REF = { id: true, code: true, name: true, nameI18n: true, type: true, refresherMonths: true, status: true, companyId: true, legalBasis: true, hours: true } as const satisfies Prisma.SafetyCourseSelect
type CourseRefRow = Prisma.SafetyCourseGetPayload<{ select: typeof COURSE_REF }>
export const courseRefOf = (row: CourseRefRow) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  nameI18n: i18nOf(row.nameI18n),
  type: row.type as CourseType,
  hours: row.hours.toString(),
  refresherMonths: row.refresherMonths,
  status: row.status as 'ACTIVE' | 'ARCHIVED',
  companyId: row.companyId,
  legalBasis: row.legalBasis,
})

/** The course a new session or record names: ACTIVE, of the whole group or of the company (COURSE_NOT_AVAILABLE otherwise). */
export async function availableCourse(tx: CommandTx, courseId: string, companyId: string, field = 'courseId'): Promise<CourseRefRow> {
  const course = isUuid(courseId) ? await tx.safetyCourse.findUnique({ where: { id: courseId }, select: COURSE_REF }) : null
  if (!course) throw new NotFoundError('Course not found.')
  if (course.status !== 'ACTIVE' || (course.companyId !== null && course.companyId !== companyId)) refuse('COURSE_NOT_AVAILABLE', 'The course is archived or of another company: pick an active course of the whole group or of this company.', field)
  return course
}

// ---- sessions -------------------------------------------------------------------------------------------------------------

export const SESSION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  courseId: true,
  heldOn: true,
  hours: true,
  language: true,
  trainerEmployeeId: true,
  trainerName: true,
  providerPartyId: true,
  location: true,
  status: true,
  openedById: true,
  closedAt: true,
  closedById: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  course: { select: COURSE_REF },
  site: { select: { code: true, name: true } },
  provider: { select: { id: true, legalName: true } },
} as const satisfies Prisma.TrainingSessionSelect
export type SessionRow = Prisma.TrainingSessionGetPayload<{ select: typeof SESSION_SELECT }>

export const readSession = (client: Client, id: string): Promise<SessionRow | null> => (isUuid(id) ? (client.trainingSession.findUnique({ where: { id }, select: SESSION_SELECT }) as Promise<SessionRow | null>) : Promise.resolve(null))

export const placeOf = (row: { readonly companyId: string; readonly siteId: string }): SafetyPlace => ({ companyId: row.companyId, siteId: row.siteId })

export interface SessionCounts {
  readonly signed: number
  readonly countersigned: number
  readonly voided: number
}

/** Attendances per session: signed (not voided), of them countersigned, voided. */
export async function sessionCounts(client: Client, sessionIds: readonly string[]): Promise<Map<string, SessionCounts>> {
  const answer = new Map<string, SessionCounts>()
  if (sessionIds.length === 0) return answer
  const rows = await client.trainingAttendance.findMany({ where: { sessionId: { in: [...new Set(sessionIds)] } }, select: { sessionId: true, countersignedAt: true, voidedAt: true } })
  for (const row of rows) {
    const entry = answer.get(row.sessionId) ?? { signed: 0, countersigned: 0, voided: 0 }
    answer.set(row.sessionId, row.voidedAt ? { ...entry, voided: entry.voided + 1 } : { ...entry, signed: entry.signed + 1, countersigned: entry.countersigned + (row.countersignedAt ? 1 : 0) })
  }
  return answer
}

export function sessionView(context: OfficeContext, row: SessionRow, counts: SessionCounts | undefined) {
  const status = row.status as SessionStatus
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    site: row.site,
    course: courseRefOf(row.course),
    heldOn: dayOf(row.heldOn),
    hours: row.hours.toString(),
    language: row.language,
    trainer: { employeeId: row.trainerEmployeeId, name: row.trainerName },
    provider: row.provider ? { id: row.provider.id, name: row.provider.legalName } : null,
    location: row.location,
    status,
    stopped: stoppedWords(status, row.cancelReason),
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    note: row.note,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
    counts: counts ?? { signed: 0, countersigned: 0, voided: 0 },
    canRecord: status === 'OPEN' && mayRecord(context, placeOf(row)),
  }
}

/**
 * A session's signatures one at a time: the floor's sign and countersign (the floor role may not lock the session row) and
 * every office command on the session take this advisory lock FIRST (`factory.training-session|tenant|session`), then the
 * office locks the row: never the other way round (an attendance's insert takes a key-share lock on its session).
 */
export async function lockSignatures(tx: CommandTx, tenantId: string, sessionId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.training-session', ${tenantId}::uuid, ${sessionId}::uuid), 0))`
}

/** The session row locked for the rest of the command (the signatures' lock, then FOR UPDATE), read again under the lock. */
export async function lockSession(tx: CommandTx, tenantId: string, sessionId: string): Promise<SessionRow> {
  if (!isUuid(sessionId)) throw new NotFoundError('Training session not found.')
  await lockSignatures(tx, tenantId, sessionId)
  const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "TrainingSession" WHERE "id" = ${sessionId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Training session not found.')
  return (await readSession(tx, sessionId))!
}

// ---- attendances ----------------------------------------------------------------------------------------------------------

export const ATTENDANCE_SELECT = {
  id: true,
  siteId: true,
  sessionId: true,
  employeeId: true,
  method: true,
  signedAt: true,
  signedByWorkerId: true,
  deviceId: true,
  signatureSha256: true,
  countersignedAt: true,
  countersignMethod: true,
  countersignedByWorkerId: true,
  countersignedById: true,
  languageUnderstood: true,
  voidedAt: true,
  voidedById: true,
  voidReason: true,
  version: true,
  employee: { select: { firstName: true, lastName: true, displayName: true, employeeCode: true, locale: true, companyId: true, siteId: true, status: true } },
  records: { select: { id: true, result: true, correctsId: true } },
} as const satisfies Prisma.TrainingAttendanceSelect
export type AttendanceRow = Prisma.TrainingAttendanceGetPayload<{ select: typeof ATTENDANCE_SELECT }>

/** The attendances of a register (the session record): names, how each signed, the trainer's countersignature and check. */
export async function attendanceViews(client: Client, rows: readonly AttendanceRow[], sessionLanguage: string) {
  const names = await userNames(client, rows.flatMap((row) => [row.countersignedById, row.voidedById]))
  return rows.map((row) => {
    const personLanguage = row.employee.locale ? row.employee.locale.slice(0, 2).toLowerCase() : null
    return {
      id: row.id,
      employee: { id: row.employeeId, name: fullName(row.employee), code: row.employee.employeeCode, language: personLanguage },
      method: row.method as SignMethod,
      signedAt: toUtcIso(row.signedAt),
      deviceId: row.deviceId,
      verifiable: row.signatureSha256 !== null,
      countersign: row.countersignedAt
        ? { at: toUtcIso(row.countersignedAt), method: row.countersignMethod as SignMethod, byOffice: row.countersignedById ? (names.get(row.countersignedById) ?? null) : null, onFloor: row.countersignedByWorkerId !== null }
        : null,
      languageUnderstood: row.languageUnderstood,
      /** The person's own language differs from the session's: the trainer's check matters most (art. 37 c.13). */
      languageDiffers: personLanguage !== null && personLanguage !== sessionLanguage,
      voided: row.voidedAt ? { at: toUtcIso(row.voidedAt), reason: row.voidReason, by: row.voidedById ? (names.get(row.voidedById) ?? null) : null } : null,
      recordId: row.records.find((record) => record.correctsId === null)?.id ?? null,
      version: row.version,
    }
  })
}

// ---- records --------------------------------------------------------------------------------------------------------------

export const RECORD_SELECT = {
  id: true,
  companyId: true,
  employeeId: true,
  courseId: true,
  sessionId: true,
  attendanceId: true,
  completedOn: true,
  hours: true,
  trainerName: true,
  result: true,
  validUntil: true,
  validUntilReason: true,
  language: true,
  languageChecked: true,
  correctsId: true,
  correctionReason: true,
  note: true,
  createdAt: true,
  createdById: true,
  course: { select: COURSE_REF },
  corrections: { select: { id: true } },
  session: { select: { id: true, heldOn: true, location: true } },
  attendance: { select: { method: true, countersignMethod: true } },
  employee: { select: { firstName: true, lastName: true, employeeCode: true, siteId: true, companyId: true } },
} as const satisfies Prisma.TrainingRecordSelect
export type RecordRow = Prisma.TrainingRecordGetPayload<{ select: typeof RECORD_SELECT }>

export const readRecord = (client: Client, id: string): Promise<RecordRow | null> => (isUuid(id) ? (client.trainingRecord.findUnique({ where: { id }, select: RECORD_SELECT }) as Promise<RecordRow | null>) : Promise.resolve(null))

/** The certificates (and other files) of these records: AVAILABLE StoredFiles of record type TrainingRecord. */
export async function filesOf(client: Client, recordType: string, recordIds: readonly string[]): Promise<Map<string, { id: string; kind: string; originalName: string; contentType: string; sizeBytes: number }[]>> {
  const answer = new Map<string, { id: string; kind: string; originalName: string; contentType: string; sizeBytes: number }[]>()
  if (recordIds.length === 0) return answer
  const rows = await client.storedFile.findMany({
    where: { recordType, recordId: { in: [...new Set(recordIds)] }, status: 'AVAILABLE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, recordId: true, kind: true, originalName: true, contentType: true, sizeBytes: true },
  })
  for (const row of rows) answer.set(row.recordId, [...(answer.get(row.recordId) ?? []), { id: row.id, kind: row.kind, originalName: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes }])
  return answer
}

export function recordView(row: RecordRow, today: BusinessDate, files: readonly { id: string; kind: string; originalName: string; contentType: string; sizeBytes: number }[] = []) {
  const result = row.result as RecordResult
  const validUntil = dayOrNull(row.validUntil)
  const corrected = row.corrections.length > 0
  return {
    id: row.id,
    employeeId: row.employeeId,
    companyId: row.companyId,
    course: courseRefOf(row.course),
    completedOn: dayOf(row.completedOn),
    hours: row.hours.toString(),
    trainerName: row.trainerName,
    result,
    validUntil,
    validUntilReason: row.validUntilReason,
    /** A PASSED record that stands: VALID, DUE_SOON or EXPIRED; null otherwise. */
    validity: result === 'PASSED' && !corrected ? validityOf(validUntil, today) : null,
    language: row.language,
    languageChecked: row.languageChecked,
    /** Corrected by a newer record (that one stands), and the record this one corrects. */
    correctedBy: corrected ? row.corrections[0]!.id : null,
    corrects: row.correctsId ? { id: row.correctsId, reason: row.correctionReason } : null,
    standing: !corrected && result !== 'VOID',
    session: row.session ? { id: row.session.id, heldOn: dayOf(row.session.heldOn), location: row.session.location } : null,
    signed: row.attendance ? { method: row.attendance.method as SignMethod, countersignMethod: (row.attendance.countersignMethod as SignMethod | null) ?? null } : null,
    note: row.note,
    certificates: [...files],
    createdAt: toUtcIso(row.createdAt),
  }
}

// ---- the instruction register ----------------------------------------------------------------------------------------------

export const INSTRUCTION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  employeeId: true,
  instructedOn: true,
  task: true,
  machineClassId: true,
  machineId: true,
  instructorEmployeeId: true,
  instructorName: true,
  minutes: true,
  language: true,
  languageChecked: true,
  signedAt: true,
  signMethod: true,
  signedByWorkerId: true,
  signatureSha256: true,
  voidedAt: true,
  voidedById: true,
  voidReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
  employee: { select: { firstName: true, lastName: true, employeeCode: true, locale: true, status: true } },
  machineClass: { select: { id: true, code: true, labelEn: true, labelIt: true } },
  machine: { select: { id: true, assetNumber: true } },
  site: { select: { code: true, name: true } },
} as const satisfies Prisma.InstructionRecordSelect
export type InstructionRow = Prisma.InstructionRecordGetPayload<{ select: typeof INSTRUCTION_SELECT }>

export const readInstruction = (client: Client, id: string): Promise<InstructionRow | null> => (isUuid(id) ? (client.instructionRecord.findUnique({ where: { id }, select: INSTRUCTION_SELECT }) as Promise<InstructionRow | null>) : Promise.resolve(null))

export async function instructionViews(client: Client, context: OfficeContext, rows: readonly InstructionRow[]) {
  const names = await userNames(client, rows.map((row) => row.voidedById))
  const scans = await filesOf(client, RECORD_INSTRUCTION, rows.map((row) => row.id))
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    site: row.site,
    employee: { id: row.employeeId, name: fullName(row.employee), code: row.employee.employeeCode },
    instructedOn: dayOf(row.instructedOn),
    task: row.task,
    machineClass: row.machineClass ? { id: row.machineClass.id, code: row.machineClass.code, label: { it: row.machineClass.labelIt, en: row.machineClass.labelEn } } : null,
    machine: row.machine ? { id: row.machine.id, assetNumber: row.machine.assetNumber } : null,
    instructor: { employeeId: row.instructorEmployeeId, name: row.instructorName },
    minutes: row.minutes,
    language: row.language,
    languageChecked: row.languageChecked,
    signed: row.signedAt ? { at: toUtcIso(row.signedAt), method: row.signMethod as SignMethod, verifiable: row.signatureSha256 !== null } : null,
    voided: row.voidedAt ? { at: toUtcIso(row.voidedAt), reason: row.voidReason, by: row.voidedById ? (names.get(row.voidedById) ?? null) : null } : null,
    note: row.note,
    scans: scans.get(row.id) ?? [],
    version: row.version,
    canChange: row.voidedAt === null && mayInstruct(context, placeOf(row)),
  }))
}
