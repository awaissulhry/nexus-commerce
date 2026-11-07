import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_HEALTH_MANAGE, SAFETY_HEALTH_VIEW } from '@nexus/factory-domain/safety/health/permissions'
import { HEALTH_LIMITS, healthRefusalOf, judgementProblems, type FitnessOutcome, type JudgementState, type VisitStatus, type VoidReason } from '@nexus/factory-domain/safety/health/rules'
import { command, type CommandCaller } from '../../../core/command'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { askedPeople, assertMay, assertMayWrite, assertVersion, dateOf, MANAGE_WORDS, may, officeOf, peopleScope, placeCaller, problemsError, refuse, todayOf } from './access'
import { currentIdsOf, judgementRow } from './protected'
import { copiesOf, doctorFor, readPerson, visitChanged } from './store'

/**
 * The fitness judgements (B-W2b-135; QHS-254 "Fitness judgement only, no clinical data"; design plant.health "Judgements",
 * "Record a judgement", "Judgement copy (PDF)"; D.Lgs. 81/2008 art. 41 c.6): ONLY the outcome, the task limits the doctor wrote
 * for the task (never the medical reason: the form's hint, and words that name a reason are refused), the day, the expiry, the
 * visit and the doctor. Office only; safety.health.view reads, safety.health.manage writes, against the person's company and site.
 *
 *   GET  /safety/health/judgements                         ANONYMISED: day, expiry, state, from a visit, a copy on file; no
 *                                                          person, no outcome, no limit (the page's "Show" and a row's open
 *                                                          are ./protected.ts, recorded)
 *   POST /safety/health/judgements                         record one (and its visit DONE on the judgement's day, same command)
 *   POST /safety/health/judgements/:id/void                a wrong one voided with a reason from the list (WRONG_PERSON clears
 *                                                          its task limits), then recorded again
 *   POST /safety/health/judgements/:id/copy (+ /:fileId/complete)  the doctor's written judgement as a file of the row: office only
 *                                                          (the database's StoredFile_protected_office_only), this module's own
 *                                                          (platform/files/owned.ts: no generic upload, no generic read)
 * Never changed, never deleted: the guard holds it for every login.
 */

/** GET /safety/health/judgements. */
export async function listJudgements(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly employeeId?: string | undefined; readonly state?: JudgementState | 'current' | 'all' | undefined; readonly offset?: number | undefined; readonly limit?: number | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const limit = query.limit ?? HEALTH_LIMITS.list
  const where: Prisma.FitnessJudgementWhereInput = { employee: { AND: [peopleScope(context, SAFETY_HEALTH_VIEW), askedPeople(query)] }, ...(query.state === 'VOIDED' ? { voidedAt: { not: null } } : query.state && query.state !== 'all' ? { voidedAt: null } : {}) }
  return caller.withClient(async (client) => {
    const rows = await client.fitnessJudgement.findMany({ where, orderBy: [{ judgedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: 2000, select: { id: true, companyId: true, employeeId: true, visitId: true, judgedOn: true, expiresOn: true, voidedAt: true, version: true } })
    const currentIds = await currentIdsOf(client, rows.map((row) => row.employeeId))
    const copies = new Set((await copiesOf(client, rows.map((row) => row.id))).map((file) => file.recordId))
    const states = rows.map((row) => judgementRow(row, currentIds, copies, today))
    const wanted = states.filter((row) => (query.state === undefined || query.state === 'all' ? true : query.state === 'current' ? row.state === 'IN_FORCE' || row.state === 'EXPIRING' || row.state === 'EXPIRED' : row.state === query.state))
    const offset = query.offset ?? 0
    return { today, judgements: wanted.slice(offset, offset + limit), more: wanted.length > offset + limit }
  })
}

export interface JudgementBody {
  readonly employeeId: string
  readonly visitId?: string | undefined
  readonly outcome: FitnessOutcome
  readonly taskLimits?: string | undefined
  readonly unfitUntil?: BusinessDate | undefined
  readonly judgedOn: BusinessDate
  readonly expiresOn?: BusinessDate | undefined
  readonly doctorAppointmentId?: string | undefined
}

/** POST /safety/health/judgements: the judgement, and its visit DONE on the judgement's day when it was due or booked. */
export async function recordJudgement(caller: CommandCaller, body: JudgementBody, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const problems = judgementProblems({ ...body, today })
  if (problems.length > 0) throw problemsError(problems, 'The judgement is not as a judgement is: outcome, limits, days.')
  const known = await caller.withClient((client) => readPerson(client, body.employeeId))
  if (!known || !may(context, SAFETY_HEALTH_VIEW, known)) throw new NotFoundError('Employee not found.')
  assertMayWrite(context, SAFETY_HEALTH_MANAGE, known, MANAGE_WORDS)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.recordFitnessJudgement', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    let visit: { id: string; version: number; status: VisitStatus } | null = null
    if (body.visitId) {
      await tx.$queryRaw`SELECT "id" FROM "HealthVisit" WHERE "id" = ${body.visitId}::uuid FOR UPDATE`
      const row = await tx.healthVisit.findUnique({ where: { id: body.visitId }, select: { id: true, employeeId: true, status: true, version: true } })
      if (!row || row.employeeId !== known.id) refuse(healthRefusalOf('VISIT_OTHER_PERSON', 'visitId'))
      if (row!.status === 'CANCELLED') refuse(healthRefusalOf('VISIT_CANCELLED', 'visitId'))
      if (await tx.fitnessJudgement.findFirst({ where: { visitId: row!.id, voidedAt: null }, select: { id: true } })) refuse(healthRefusalOf('VISIT_JUDGED', 'visitId'))
      if (row!.status === 'DUE' || row!.status === 'BOOKED') {
        await tx.healthVisit.update({ where: { id: row!.id }, data: { status: 'DONE', doneOn: dateOf(body.judgedOn), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
        visitChanged(tools, { id: row!.id, companyId: known.companyId, siteId: known.siteId }, 'DONE', 'DONE', 'OFFICE', 'safety.doneHealthVisit')
        visit = { id: row!.id, version: row!.version + 1, status: 'DONE' }
      } else visit = { id: row!.id, version: row!.version, status: row!.status as VisitStatus }
    }
    const doctor = await doctorFor(tx, known.companyId, body.doctorAppointmentId, body.judgedOn)
    if (doctor.refused) refuse(healthRefusalOf('NOT_A_DOCTOR', 'doctorAppointmentId'))
    await tx.fitnessJudgement.create({
      data: {
        id,
        companyId: known.companyId,
        employeeId: known.id,
        visitId: body.visitId ?? null,
        outcome: body.outcome,
        taskLimits: body.outcome === 'FIT_WITH_LIMITS' ? body.taskLimits!.trim() : null,
        unfitUntil: body.unfitUntil ? dateOf(body.unfitUntil) : null,
        judgedOn: dateOf(body.judgedOn),
        expiresOn: body.expiresOn ? dateOf(body.expiresOn) : null,
        doctorAppointmentId: doctor.id,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    // The audit row names the judgement, never its outcome, limits or person (the row itself is behind this module's rules).
    tools.audit({ action: 'safety.recordFitnessJudgement', recordType: 'FitnessJudgement', recordId: id, companyId: known.companyId, siteId: known.siteId, after: { change: 'RECORDED', fromVisit: body.visitId !== undefined } })
    tools.emit({ type: 'fitness_judgement.changed', subject: id, companyId: known.companyId, siteId: known.siteId, payload: { judgementId: id, change: 'RECORDED' } })
    return { judgement: { id, version: 1 }, visit }
  })
  return { ...result, replayed }
}

async function writableJudgement(caller: CommandCaller, judgementId: string) {
  const context = officeOf(caller)
  const row = isUuid(judgementId) ? await caller.withClient((client) => client.fitnessJudgement.findUnique({ where: { id: judgementId }, select: { id: true, companyId: true, employeeId: true, voidedAt: true, version: true, employee: { select: { companyId: true, siteId: true } } } })) : null
  if (!row) throw new NotFoundError('Judgement not found.')
  assertMay(context, SAFETY_HEALTH_VIEW, row.employee, 'Judgement')
  assertMayWrite(context, SAFETY_HEALTH_MANAGE, row.employee, MANAGE_WORDS)
  return { context, row }
}

/** POST /safety/health/judgements/:judgementId/void. */
export async function voidJudgement(caller: CommandCaller, judgementId: string, body: { readonly version: number; readonly reason: VoidReason }, idempotencyKey?: string) {
  const { context, row: known } = await writableJudgement(caller, judgementId)
  const { result, replayed } = await command(caller, { name: 'safety.voidFitnessJudgement', idempotencyKey, input: { judgementId, ...body } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT "id" FROM "FitnessJudgement" WHERE "id" = ${judgementId}::uuid FOR UPDATE`
    const row = (await tools.tx.fitnessJudgement.findUnique({ where: { id: judgementId }, select: { id: true, voidedAt: true, version: true } }))!
    assertVersion('judgement', row.version, body.version)
    if (row.voidedAt) refuse(healthRefusalOf('JUDGEMENT_VOIDED'))
    // Recorded on the wrong person: its task limits go with the void (the guard allows clearing them only then).
    await tools.tx.fitnessJudgement.update({ where: { id: row.id }, data: { voidedAt: tools.now, voidedById: context.actorId, voidReason: body.reason, ...(body.reason === 'WRONG_PERSON' ? { taskLimits: null } : {}), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.voidFitnessJudgement', recordType: 'FitnessJudgement', recordId: row.id, companyId: known.companyId, siteId: known.employee.siteId, after: { change: 'VOIDED' } })
    tools.emit({ type: 'fitness_judgement.changed', subject: row.id, companyId: known.companyId, siteId: known.employee.siteId, payload: { judgementId: row.id, change: 'VOIDED' } })
    return { judgement: { id: row.id, version: row.version + 1 }, visit: null }
  })
  return { ...result, replayed }
}

export interface AnnounceBody {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** POST /safety/health/judgements/:judgementId/copy: the doctor's copy, a DOCUMENT of the row, office only. */
export async function announceCopy(request: FastifyRequest, judgementId: string, body: AnnounceBody, idempotencyKey?: string) {
  const { context, row } = await writableJudgement(request, judgementId)
  if (row.voidedAt) refuse(healthRefusalOf('JUDGEMENT_VOIDED'))
  return requestUpload(
    processFiles(),
    placeCaller(request, context.tenantId, { companyId: row.employee.companyId, siteId: row.employee.siteId }, [FILES_UPLOAD]),
    { companyId: row.companyId, recordType: 'FitnessJudgement', recordId: row.id, kind: 'DOCUMENT', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE'] },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /safety/health/judgements/:judgementId/copy/:fileId/complete. */
export async function completeCopy(request: FastifyRequest, judgementId: string, fileId: string, idempotencyKey?: string) {
  const { context, row } = await writableJudgement(request, judgementId)
  const uploader = placeCaller(request, context.tenantId, { companyId: row.employee.companyId, siteId: row.employee.siteId }, [FILES_UPLOAD])
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'FitnessJudgement', recordId: row.id, kind: 'DOCUMENT' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey, { viaModule: true }) }
}
