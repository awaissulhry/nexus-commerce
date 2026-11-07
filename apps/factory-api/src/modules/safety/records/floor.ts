import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { badgeCodeHash, normalizeBadgeCode } from '@nexus/factory-domain/auth/floor/badge'
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  ATTENDANCE_STATEMENT,
  COUNTERSIGN_STATEMENT,
  INSTRUCTION_STATEMENT,
  RECORDS_REFUSALS,
  sha256Hex,
  signedAttendanceText,
  signedInstructionText,
  statementLanguageOf,
  stoppedWords,
  type SessionStatus,
} from '@nexus/factory-domain/safety/records/rules'
import { command, type CommandTx } from '../../../core/command'
import { requireContext, type FloorContext } from '../../../core/context'
import { floorSessionOf } from '../../../platform/auth/floor/authenticator'
import { requireDevice } from '../../../platform/auth/floor/device'
import { claimProved, provedWorker, refuseByMode } from '../../../platform/auth/floor/sign-in'
import type { OfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { dayOf, refuse } from '../organisation/access'
import { i18nOf, lockSignatures, RECORD_INSTRUCTION, RECORD_SESSION } from './store'
import { countersignable } from './sessions'

/**
 * Training attendance and the instruction register on the floor (B-W2b-139; QHS-248, QHS-246, QHS-247; design floor.training
 * "Training attendance": "The trainer opens the session (from People › Skills & training). Each worker: badge scan + PIN; the
 * list fills ('8 signed'). Countersign with the trainer's PIN."; live "The session closed in the office → signing stops with
 * the reason"), at the tablet's own site, floor.work:
 *
 *   GET  /safety/floor/training/sessions                   the OPEN sessions of the site (course, day, hours, language,
 *                                                          trainer, where, how many signed)
 *   GET  /safety/floor/training/sessions/:id               one session: who signed (floor names), countersigned or not, the
 *                                                          words each person signs (in Italian and English), whether its
 *                                                          trainer countersigns here; a closed or cancelled one says why
 *   POST /safety/floor/training/sessions/:id/sign          the person's own badge (or name) and PIN: the floor sign-in's own
 *                                                          check (`provedWorker`: one answer for a wrong badge, PIN, a locked
 *                                                          or inactive worker; a wrong PIN counts on that person's lockout),
 *                                                          claimed again in ONE command (`claimProved`) that writes the
 *                                                          FLOOR_PIN attendance (their worker, the tablet, the request's id,
 *                                                          the SHA-256 of the words they signed)
 *   POST /safety/floor/training/sessions/:id/countersign   the trainer's own badge (or name) and PIN, the same way, with the
 *                                                          language check of each person they countersign (art. 37 c.13)
 *   POST /safety/floor/training/instruction/pending        a scanned badge (or a name): the person's unsigned entries of the
 *                                                          instruction register at this site and the words to sign; no PIN,
 *                                                          nothing written
 *   POST /safety/floor/training/instruction/:id/sign       the person's own badge (or name) and PIN: the entry signed once
 *
 * Online only (no floor-sync kind): a PIN is never queued or kept on a tablet, and a signature is the PIN proved when it is
 * signed (B-W2b-134's rule for the PPE receipt). Offline, the tile says it needs the network. A line board refuses before any
 * PIN is read; a personal phone signs only its own person (`refuseByMode`). The office never proves a worker's PIN.
 * A session's signatures are serialised by one advisory lock (`factory.training-session|tenant|session`) the office's close,
 * cancel, edit and countersignature take too: the floor role may not lock the session row itself.
 */

interface Credentials {
  readonly badgeCode?: string | undefined
  readonly workerId?: string | undefined
}

function floorContextOf(request: FastifyRequest): FloorContext {
  const context = requireContext(request)
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

const oneOf = (body: Credentials, who: string): void => {
  if ((body.badgeCode === undefined) === (body.workerId === undefined)) throw new ValidationError(`Scan the badge of ${who}, or pick their name.`, [{ path: 'badgeCode', message: 'Send a badge code or a worker id, not both.' }])
}

const keyRequired = (idempotencyKey: string | undefined): string => {
  if (idempotencyKey === undefined) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  return idempotencyKey
}

// ---- reads ------------------------------------------------------------------------------------------------------------------

/** What the floor role may read of a session (no opener, no closer: never who in the office). */
const FLOOR_SESSION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  courseId: true,
  heldOn: true,
  hours: true,
  language: true,
  trainerEmployeeId: true,
  trainerName: true,
  location: true,
  status: true,
  cancelReason: true,
  version: true,
  course: { select: { id: true, code: true, name: true, nameI18n: true } },
} as const satisfies Prisma.TrainingSessionSelect
type FloorSessionRow = Prisma.TrainingSessionGetPayload<{ select: typeof FLOOR_SESSION_SELECT }>

const readFloorSession = (client: Pick<CommandTx, 'trainingSession'>, id: string): Promise<FloorSessionRow | null> =>
  isUuid(id) ? (client.trainingSession.findUnique({ where: { id }, select: FLOOR_SESSION_SELECT }) as Promise<FloorSessionRow | null>) : Promise.resolve(null)

async function countsOf(client: Pick<CommandTx, 'trainingAttendance'>, sessionIds: readonly string[]): Promise<Map<string, { signed: number; countersigned: number }>> {
  const answer = new Map<string, { signed: number; countersigned: number }>()
  if (sessionIds.length === 0) return answer
  const rows = await client.trainingAttendance.findMany({ where: { sessionId: { in: [...sessionIds] }, voidedAt: null }, select: { sessionId: true, countersignedAt: true } })
  for (const row of rows) {
    const entry = answer.get(row.sessionId) ?? { signed: 0, countersigned: 0 }
    answer.set(row.sessionId, { signed: entry.signed + 1, countersigned: entry.countersigned + (row.countersignedAt ? 1 : 0) })
  }
  return answer
}

const floorView = (row: FloorSessionRow, counts: { signed: number; countersigned: number } | undefined) => ({
  id: row.id,
  course: { id: row.course.id, code: row.course.code, name: row.course.name, nameI18n: i18nOf(row.course.nameI18n) },
  heldOn: dayOf(row.heldOn),
  hours: row.hours.toString(),
  language: row.language,
  trainerName: row.trainerName,
  location: row.location,
  status: row.status as SessionStatus,
  stopped: stoppedWords(row.status as SessionStatus, row.cancelReason),
  signed: counts?.signed ?? 0,
  countersigned: counts?.countersigned ?? 0,
  version: row.version,
})

/** GET /safety/floor/training/sessions. */
export async function floorSessions(request: FastifyRequest) {
  const context = floorContextOf(request)
  return request.withClient(async (client) => {
    const rows = (await client.trainingSession.findMany({ where: { siteId: context.siteId, status: 'OPEN' }, orderBy: [{ heldOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 50, select: FLOOR_SESSION_SELECT })) as FloorSessionRow[]
    const counts = await countsOf(
      client,
      rows.map((row) => row.id),
    )
    return { sessions: rows.map((row) => floorView(row, counts.get(row.id))) }
  })
}

/** The trainer's floor sign-in at this site, when the trainer is a person of the company with one. */
async function trainerWorkerOf(client: Pick<CommandTx, 'worker'>, siteId: string, trainerEmployeeId: string | null): Promise<string | null> {
  if (trainerEmployeeId === null) return null
  const worker = await client.worker.findFirst({ where: { siteId, employeeId: trainerEmployeeId, status: 'ACTIVE' }, select: { id: true } })
  return worker?.id ?? null
}

/** GET /safety/floor/training/sessions/:sessionId. */
export async function floorSession(request: FastifyRequest, sessionId: string) {
  const context = floorContextOf(request)
  return request.withClient(async (client) => {
    const row = await readFloorSession(client, sessionId)
    if (!row || row.siteId !== context.siteId) throw new NotFoundError('Training session not found.')
    const attendances = await client.trainingAttendance.findMany({
      where: { sessionId: row.id, voidedAt: null },
      orderBy: [{ signedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, employeeId: true, method: true, signedAt: true, countersignedAt: true, languageUnderstood: true, signedByWorker: { select: { displayName: true } } },
    })
    // The floor reads its own site's people (their floor name only).
    const people = await client.employee.findMany({ where: { id: { in: attendances.map((attendance) => attendance.employeeId) } }, select: { id: true, displayName: true } })
    const nameOf = new Map(people.map((person) => [person.id, person.displayName]))
    const trainerWorkerId = await trainerWorkerOf(client, context.siteId, row.trainerEmployeeId)
    return {
      session: floorView(row, (await countsOf(client, [row.id])).get(row.id)),
      attendances: attendances.map((attendance) => ({
        id: attendance.id,
        displayName: attendance.signedByWorker?.displayName ?? nameOf.get(attendance.employeeId) ?? null,
        method: attendance.method as 'FLOOR_PIN' | 'PAPER',
        signedAt: toUtcIso(attendance.signedAt),
        countersigned: attendance.countersignedAt !== null,
        languageUnderstood: attendance.languageUnderstood,
      })),
      trainer: { name: row.trainerName, workerId: trainerWorkerId, countersignsHere: trainerWorkerId !== null },
      statements: { attendance: { ...ATTENDANCE_STATEMENT }, countersign: { ...COUNTERSIGN_STATEMENT } },
    }
  })
}

// ---- writes -----------------------------------------------------------------------------------------------------------------

async function provedOnFloor(auth: OfficeAuth, request: FastifyRequest, body: Credentials & { readonly pin: string }) {
  const session = floorSessionOf(request)
  const place = await requireDevice(auth, request)
  if (place.device.id !== session.device.id) throw new UnauthenticatedError()
  refuseByMode(place, null)
  // The person's own badge (or name) and PIN, by the floor sign-in's own rules: a wrong PIN counts towards their lockout.
  const proved = await provedWorker(auth, request, place, { badgeCode: body.badgeCode, workerId: body.workerId, pin: body.pin }, session.workerId)
  if (!proved.pinVerified) throw new ValidationError('A signature asks the person’s PIN.', [{ path: 'pin', message: 'Required.' }])
  refuseByMode(place, proved.candidate.worker.id)
  return { place, proved }
}

/** The open session of this site a signature names (404 elsewhere; SESSION_STOPPED with the reason once closed or cancelled). */
async function openSessionHere(tx: CommandTx, context: FloorContext, sessionId: string): Promise<FloorSessionRow> {
  const row = await readFloorSession(tx, sessionId)
  if (!row || row.siteId !== context.siteId) throw new NotFoundError('Training session not found.')
  if (row.status !== 'OPEN') refuse('SESSION_STOPPED', stoppedWords(row.status as SessionStatus, row.cancelReason) ?? RECORDS_REFUSALS.SESSION_STOPPED)
  return row
}

/** POST /safety/floor/training/sessions/:sessionId/sign. */
export async function floorSign(auth: OfficeAuth, request: FastifyRequest, sessionId: string, body: Credentials & { readonly pin: string }, idempotencyKey: string | undefined) {
  const context = floorContextOf(request)
  oneOf(body, 'the person who attended')
  const key = keyRequired(idempotencyKey)
  const { place, proved } = await provedOnFloor(auth, request, body)
  const signer = proved.candidate.worker
  const { result } = await command(request, { name: 'safety.signAttendance', idempotencyKey: key, input: { sessionId, workerId: signer.id } }, async (tools) => {
    const { tx, now } = tools
    await claimProved(tx, place.device, proved, now)
    await lockSignatures(tx, context.tenantId, sessionId)
    const row = await openSessionHere(tx, context, sessionId)
    const worker = (await tx.worker.findUnique({ where: { id: signer.id }, select: { id: true, companyId: true, employeeId: true, displayName: true, locale: true } }))!
    if (!worker.employeeId) refuse('NO_EMPLOYEE', RECORDS_REFUSALS.NO_EMPLOYEE)
    if (worker.companyId !== row.companyId) refuse('PERSON_OTHER_COMPANY', RECORDS_REFUSALS.PERSON_OTHER_COMPANY)
    // A record of another site of the company is not visible on this floor: the database checks it then.
    const employee = await tx.employee.findUnique({ where: { id: worker.employeeId! }, select: { status: true } })
    if (employee && employee.status !== 'ACTIVE') refuse('PERSON_NOT_ACTIVE', RECORDS_REFUSALS.PERSON_NOT_ACTIVE)
    const attendanceKey = `attendance:${row.id}:${worker.employeeId}`
    if (await tx.trainingAttendance.findFirst({ where: { key: attendanceKey }, select: { id: true } })) refuse('ATTENDED_ALREADY', RECORDS_REFUSALS.ATTENDED_ALREADY)
    const language = statementLanguageOf(worker.locale)
    const signedAt = toUtcIso(now)
    const sha256 = sha256Hex(
      signedAttendanceText({
        language,
        sessionId: row.id,
        courseCode: row.course.code,
        heldOn: dayOf(row.heldOn),
        hours: row.hours.toString(),
        sessionLanguage: row.language,
        trainerName: row.trainerName,
        employeeId: worker.employeeId!,
        workerId: worker.id,
        deviceId: context.deviceId,
        signedAt,
      }),
    )
    const id = newId()
    await tx.trainingAttendance.create({
      data: { id, siteId: row.siteId, sessionId: row.id, employeeId: worker.employeeId!, key: attendanceKey, method: 'FLOOR_PIN', signedAt: now, signedByWorkerId: worker.id, deviceId: context.deviceId, clientEventId: key, signatureSha256: sha256, createdAt: now, updatedAt: now },
      select: { id: true },
    })
    tools.audit({ action: 'safety.signAttendance', recordType: RECORD_SESSION, recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { attendanceId: id, employeeId: worker.employeeId, method: 'FLOOR_PIN', signedByWorkerId: worker.id, deviceId: context.deviceId, signedAt, sha256 } })
    const counts = (await countsOf(tx, [row.id])).get(row.id) ?? { signed: 0, countersigned: 0 }
    tools.emit({ type: 'training_attendance.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { sessionId: row.id, attendanceIds: [id], change: 'SIGNED', via: 'FLOOR', ...counts } })
    return { attendance: { id, signedAt, worker: { id: worker.id, displayName: worker.displayName }, statement: ATTENDANCE_STATEMENT[language], sha256 }, ...counts }
  })
  return result
}

/** POST /safety/floor/training/sessions/:sessionId/countersign. */
export async function floorCountersign(
  auth: OfficeAuth,
  request: FastifyRequest,
  sessionId: string,
  body: Credentials & { readonly pin: string; readonly attendances: readonly { readonly attendanceId: string; readonly languageUnderstood: boolean }[] },
  idempotencyKey: string | undefined,
) {
  const context = floorContextOf(request)
  oneOf(body, 'the trainer')
  const key = keyRequired(idempotencyKey)
  const { place, proved } = await provedOnFloor(auth, request, body)
  const trainer = proved.candidate.worker
  const { result } = await command(request, { name: 'safety.countersignAttendance', idempotencyKey: key, input: { sessionId, workerId: trainer.id, attendances: body.attendances } }, async (tools) => {
    const { tx, now } = tools
    await claimProved(tx, place.device, proved, now)
    await lockSignatures(tx, context.tenantId, sessionId)
    const row = await openSessionHere(tx, context, sessionId)
    if (row.trainerEmployeeId === null) refuse('NO_TRAINER_WORKER', RECORDS_REFUSALS.NO_TRAINER_WORKER)
    const worker = (await tx.worker.findUnique({ where: { id: trainer.id }, select: { id: true, employeeId: true, displayName: true, locale: true } }))!
    if (worker.employeeId !== row.trainerEmployeeId) refuse('NOT_THE_TRAINER', RECORDS_REFUSALS.NOT_THE_TRAINER)
    await countersignable(tx, row.id, body.attendances)
    for (const entry of body.attendances) {
      await tx.trainingAttendance.update({
        where: { id: entry.attendanceId },
        data: { countersignedAt: now, countersignMethod: 'FLOOR_PIN', countersignedByWorkerId: worker.id, languageUnderstood: entry.languageUnderstood, version: { increment: 1 }, updatedAt: now },
        select: { id: true },
      })
    }
    const ids = body.attendances.map((entry) => entry.attendanceId)
    tools.audit({
      action: 'safety.countersignAttendance',
      recordType: RECORD_SESSION,
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      after: { method: 'FLOOR_PIN', countersignedByWorkerId: worker.id, deviceId: context.deviceId, attendances: body.attendances.map((entry) => ({ attendanceId: entry.attendanceId, languageUnderstood: entry.languageUnderstood })) },
    })
    const counts = (await countsOf(tx, [row.id])).get(row.id) ?? { signed: 0, countersigned: 0 }
    tools.emit({ type: 'training_attendance.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { sessionId: row.id, attendanceIds: ids, change: 'COUNTERSIGNED', via: 'FLOOR', ...counts } })
    return { attendanceIds: ids, trainer: { id: worker.id, displayName: worker.displayName }, statement: COUNTERSIGN_STATEMENT[statementLanguageOf(worker.locale)], ...counts }
  })
  return result
}

// ---- the instruction register on the floor --------------------------------------------------------------------------------------

const FLOOR_INSTRUCTION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  employeeId: true,
  instructedOn: true,
  task: true,
  minutes: true,
  language: true,
  instructorName: true,
  signedAt: true,
  voidedAt: true,
  version: true,
  machineClass: { select: { code: true, labelEn: true, labelIt: true } },
  machine: { select: { assetNumber: true } },
} as const satisfies Prisma.InstructionRecordSelect

/** POST /safety/floor/training/instruction/pending: the scanned person's unsigned entries at this site. */
export async function floorInstructionPending(request: FastifyRequest, body: Credentials) {
  const context = floorContextOf(request)
  oneOf(body, 'the person instructed')
  return request.withClient(async (client) => {
    const select = { id: true, displayName: true, locale: true, employeeId: true, status: true } as const
    let worker: { id: string; displayName: string; locale: string; employeeId: string | null; status: string } | null = null
    if (body.badgeCode !== undefined) {
      const code = normalizeBadgeCode(body.badgeCode)
      const badge = code === null ? null : await client.badge.findUnique({ where: { codeHash: badgeCodeHash(code) }, select: { status: true, worker: { select } } })
      worker = badge && badge.status === 'ACTIVE' ? badge.worker : null
    } else {
      worker = await client.worker.findFirst({ where: { id: body.workerId!, siteId: context.siteId }, select })
    }
    if (!worker || worker.status !== 'ACTIVE') throw new NotFoundError('This badge is not known here, or the worker is not active.')
    const entries = worker.employeeId
      ? await client.instructionRecord.findMany({ where: { employeeId: worker.employeeId, siteId: context.siteId, signedAt: null, voidedAt: null }, orderBy: [{ instructedOn: 'asc' }, { id: 'asc' }], take: 50, select: FLOOR_INSTRUCTION_SELECT })
      : []
    return {
      worker: { id: worker.id, displayName: worker.displayName },
      entries: entries.map((entry) => ({
        id: entry.id,
        instructedOn: dayOf(entry.instructedOn),
        task: entry.task,
        machineClass: entry.machineClass ? { code: entry.machineClass.code, label: { it: entry.machineClass.labelIt, en: entry.machineClass.labelEn } } : null,
        machine: entry.machine ? { assetNumber: entry.machine.assetNumber } : null,
        instructorName: entry.instructorName,
        minutes: entry.minutes,
        language: entry.language,
        version: entry.version,
      })),
      statement: INSTRUCTION_STATEMENT[statementLanguageOf(worker.locale)],
    }
  })
}

/** POST /safety/floor/training/instruction/:instructionId/sign. */
export async function floorInstructionSign(auth: OfficeAuth, request: FastifyRequest, instructionId: string, body: Credentials & { readonly pin: string }, idempotencyKey: string | undefined) {
  const context = floorContextOf(request)
  oneOf(body, 'the person instructed')
  const key = keyRequired(idempotencyKey)
  const { place, proved } = await provedOnFloor(auth, request, body)
  const signer = proved.candidate.worker
  const { result } = await command(request, { name: 'safety.signInstruction', idempotencyKey: key, input: { instructionId, workerId: signer.id } }, async (tools) => {
    const { tx, now } = tools
    await claimProved(tx, place.device, proved, now)
    const entry = isUuid(instructionId) ? await tx.instructionRecord.findUnique({ where: { id: instructionId }, select: FLOOR_INSTRUCTION_SELECT }) : null
    if (!entry || entry.siteId !== context.siteId) throw new NotFoundError('Instruction entry not found.')
    if (entry.voidedAt) refuse('ENTRY_VOIDED', RECORDS_REFUSALS.ENTRY_VOIDED)
    if (entry.signedAt) refuse('ENTRY_SIGNED', RECORDS_REFUSALS.ENTRY_SIGNED)
    const worker = (await tx.worker.findUnique({ where: { id: signer.id }, select: { id: true, employeeId: true, displayName: true, locale: true } }))!
    // Only the person instructed signs their entry (the database holds the same rule).
    if (worker.employeeId !== entry.employeeId) throw new NotFoundError('Instruction entry not found.')
    const language = statementLanguageOf(worker.locale)
    const signedAt = toUtcIso(now)
    const sha256 = sha256Hex(
      signedInstructionText({
        language,
        entryId: entry.id,
        instructedOn: dayOf(entry.instructedOn),
        task: entry.task,
        machineClassCode: entry.machineClass?.code ?? null,
        machineAsset: entry.machine?.assetNumber ?? null,
        instructorName: entry.instructorName,
        minutes: entry.minutes,
        entryLanguage: entry.language,
        employeeId: entry.employeeId,
        workerId: worker.id,
        deviceId: context.deviceId,
        signedAt,
      }),
    )
    const claimed = await tx.instructionRecord.updateMany({
      where: { id: entry.id, version: entry.version, signedAt: null, voidedAt: null },
      data: { signedAt: now, signMethod: 'FLOOR_PIN', signedByWorkerId: worker.id, signatureSha256: sha256, version: { increment: 1 }, updatedAt: now },
    })
    if (claimed.count !== 1) refuse('ENTRY_SIGNED', RECORDS_REFUSALS.ENTRY_SIGNED)
    tools.audit({ action: 'safety.signInstruction', recordType: RECORD_INSTRUCTION, recordId: entry.id, companyId: entry.companyId, siteId: entry.siteId, after: { method: 'FLOOR_PIN', signedByWorkerId: worker.id, deviceId: context.deviceId, signedAt, sha256 } })
    tools.emit({ type: 'instruction.changed', subject: entry.id, companyId: entry.companyId, siteId: entry.siteId, payload: { instructionId: entry.id, employeeId: entry.employeeId, change: 'SIGNED', via: 'FLOOR' } })
    return { instruction: { id: entry.id, signedAt, worker: { id: worker.id, displayName: worker.displayName }, statement: INSTRUCTION_STATEMENT[language], sha256 } }
  })
  return result
}
