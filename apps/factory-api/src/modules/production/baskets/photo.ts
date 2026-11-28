import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { stepsClosedRefusal, stepUnknownRefusal } from '@nexus/factory-domain/production/checklists/rules'
import { NO_FACES_REMINDER } from '@nexus/factory-domain/production/floornotes/rules'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { clientIdReusedRefusal, standingKey, standingScans, subjectRefusal } from '@nexus/factory-domain/production/scans/rules'
import { command, IdempotencyKeyReusedError, idempotencyKeyFrom } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { lockBundleForScan, readBundle } from '../bundles/store'
import { readTickByClient, stepsOfOperation } from '../checklists/store'
import { floorViewerOf } from '../checklists/views'
import { siteUploader } from '../floornotes/notes'
import { floorOf, refuse, scanWorkOrder } from '../scans/access'
import { refuseIfHeld } from '../scans/scans'
import { lockBundleScans, readBundleScans, readHeader, readOperations, scanWorkOrderLock, type ScanHeader } from '../scans/store'
import { floorRecordSubjectFor, hasAcknowledgedNotice } from '../settings/subject'
import { employeesOf } from '../terminal/store'

/**
 * The quality step's photo (owb- order workflow, S5 fl1; LF _owb-fl-common.md § 3 "fl1" QC photo; owb-fl0's
 * OperationChecklistResult.fileId and its guard): the floornotes file pattern (announce → presigned PUT → complete), then the
 * step ticked WITH the photo in one command — the tick row never changes (append-only), so the photo is written with it.
 *
 *   POST …/checklist/:stepCode/photo                    a picture of the basket's work order (PHOTO, OFFICE + FLOOR, the work
 *                                                       order's site: the floor reads it back; the database refuses anything
 *                                                       else as a step's photo), through the tenant's system caller holding
 *                                                       exactly files.upload + files.manage there (floornotes siteUploader)
 *   POST …/checklist/:stepCode/photo/:fileId/complete   the upload confirmed, then ONE command keyed `<device>.<clientEventId>`
 *                                                       in the scans' lock order (as checklists/tick): the work order open and
 *                                                       not held, the step one of the operation's, the operation not reported
 *                                                       yet for the basket, the subject by the site's floor rules; a DONE tick
 *                                                       with the photo. A photo always writes a new tick (it is proof); a
 *                                                       resend of the client event id answers the first one
 *
 * Floor, production.scan, the device's own site (scanWorkOrder: another site's basket is not found). No name in the answer.
 */

export interface AnnouncePhotoInput {
  readonly workOrderOperationId: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface CompletePhotoInput {
  readonly workOrderOperationId: string
  readonly clientEventId: string
  readonly occurredAt?: string | undefined
}

/** The basket at the device's site, its work order (one this floor may scan for) and the step named on one of its operations. */
async function basketStep(request: FastifyRequest, context: FloorContext, bundleId: string, operationId: string, stepCode: string): Promise<{ readonly bundleId: string; readonly workOrder: ScanHeader }> {
  const bundle = await request.withClient((db) => readBundle(db, bundleId))
  if (!bundle || bundle.siteId !== context.siteId) throw new NotFoundError('Not a basket of this site: scan its ticket.')
  const workOrder = await scanWorkOrder(request, bundle.workOrderId, PRODUCTION_SCAN)
  const known = await request.withClient(async (db) => {
    const operation = (await readOperations(db, workOrder.id)).find((entry) => entry.id === operationId)
    return operation ? (await stepsOfOperation(db, operation.id)).some((step) => step.code === stepCode) : null
  })
  if (known === null) refuse({ code: 'NOT_AN_OPERATION', message: `This is not an operation of work order ${workOrder.number}.`, fix: 'Scan the basket again and pick one of its steps.', final: true })
  if (!known) refuse(stepUnknownRefusal(stepCode))
  return { bundleId: bundle.id, workOrder }
}

/** POST …/checklist/:stepCode/photo */
export async function announcePhoto(request: FastifyRequest, params: { readonly bundleId: string; readonly stepCode: string }, body: AnnouncePhotoInput, idempotencyKey?: string) {
  const context = floorOf(request)
  const { workOrder } = await basketStep(request, context, params.bundleId, body.workOrderOperationId, params.stepCode)
  const { workOrderOperationId: _operation, ...file } = body
  const answer = await requestUpload(
    processFiles(),
    siteUploader(request, context.tenantId, workOrder),
    { ...file, companyId: workOrder.companyId, recordType: 'WorkOrder', recordId: workOrder.id, kind: 'PHOTO', visibility: ['OFFICE', 'FLOOR'], floorSiteId: workOrder.siteId },
    idempotencyKey,
    { clip: false },
  )
  return { ...answer, reminder: NO_FACES_REMINDER }
}

interface PhotoTick {
  readonly id: string
  readonly stepCode: string
  readonly outcome: string
  readonly fileId: string
  readonly at: string
}

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

/** POST …/checklist/:stepCode/photo/:fileId/complete */
export async function completePhoto(request: FastifyRequest, params: { readonly bundleId: string; readonly stepCode: string; readonly fileId: string }, body: CompletePhotoInput) {
  const context = floorOf(request)
  const { bundleId, workOrder } = await basketStep(request, context, params.bundleId, body.workOrderOperationId, params.stepCode)
  const uploader = siteUploader(request, context.tenantId, workOrder)
  const owned = isUuid(params.fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: params.fileId, recordType: 'WorkOrder', recordId: workOrder.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!owned) throw new NotFoundError('File not found.')
  const file = await completeUpload(processFiles(), uploader, params.fileId, idempotencyKeyFrom(request) ?? `${keyOf(context, body.clientEventId)}.file`)
  // A resend under the same client event id: the tick recorded first (same step, basket and photo), else CLIENT_ID_REUSED.
  const before = await request.withClient((db) => readTickByClient(db, context.deviceId, body.clientEventId))
  if (before) {
    const sameFile = await request.withClient((db) => db.operationChecklistResult.findUnique({ where: { id: before.id }, select: { fileId: true } }))
    if (before.bundleId !== bundleId || before.stepCode !== params.stepCode || sameFile?.fileId !== params.fileId) refuse(clientIdReusedRefusal(body.clientEventId))
    return { file, tick: { id: before.id, stepCode: before.stepCode, outcome: before.outcome, fileId: params.fileId, at: toUtcIso(before.serverTime) } }
  }
  const deviceTime = body.occurredAt ? parseInstant(body.occurredAt) : null
  try {
    const { result } = await command(
      request,
      { name: 'production.tickChecklistPhoto', idempotencyKey: keyOf(context, body.clientEventId), input: { ...body, bundleId, stepCode: params.stepCode, fileId: params.fileId }, ...(deviceTime ? { deviceTime } : {}) },
      async (tools): Promise<PhotoTick> => {
        const { tx, now } = tools
        await scanWorkOrderLock(tx, context.tenantId, workOrder.id)
        const locked = await lockBundleForScan(tx, bundleId)
        if (!locked) throw new NotFoundError('Not a basket of this site: scan its ticket.')
        await lockBundleScans(tx, context.tenantId, locked.bundle.siteId, locked.bundle.id)
        await refuseIfHeld(tools, locked.bundle.id, workOrder.id)
        const header = (await readHeader(tx, workOrder.id))!
        if (standingScans(await readBundleScans(tx, locked.bundle.id)).has(standingKey(locked.bundle.id, body.workOrderOperationId))) refuse(stepsClosedRefusal(locked.bundle.code))
        const viewer = await floorViewerOf(tx, context)
        const acknowledged = viewer.scanSubject === 'WORKER' ? await hasAcknowledgedNotice(tx, header.siteId, context.actorId) : false
        const notNamed = subjectRefusal({ scanSubject: viewer.scanSubject, workerId: context.actorId, acknowledged, stationId: viewer.stationId })
        if (notNamed) refuse(notNamed)
        const subject = await floorRecordSubjectFor(tx, { siteId: header.siteId, workerId: context.actorId, stationId: viewer.stationId })
        const employees = subject.workerId ? await employeesOf(tx, [subject.workerId]) : new Map<string, string | null>()
        const row = await tx.operationChecklistResult.create({
          data: {
            id: newId(),
            siteId: header.siteId,
            workOrderId: header.id,
            workOrderOperationId: body.workOrderOperationId,
            bundleId: locked.bundle.id,
            stepCode: params.stepCode,
            outcome: 'DONE',
            workerId: subject.workerId,
            employeeId: subject.workerId ? (employees.get(subject.workerId) ?? null) : null,
            stationId: subject.stationId,
            deviceId: context.deviceId,
            clientEventId: body.clientEventId,
            deviceTime,
            serverTime: now,
            createdById: subject.workerId ? context.actorId : null,
            fileId: params.fileId,
          },
          select: { id: true, stepCode: true, outcome: true, serverTime: true },
        })
        tools.audit({ action: 'production.tickChecklistPhoto', recordType: 'OperationChecklistResult', recordId: row.id, companyId: header.companyId, siteId: header.siteId, after: { workOrderId: header.id, bundleId: locked.bundle.id, operationId: body.workOrderOperationId, stepCode: row.stepCode, outcome: 'DONE', fileId: params.fileId, workerId: subject.workerId, stationId: subject.stationId } })
        return { id: row.id, stepCode: row.stepCode, outcome: row.outcome, fileId: params.fileId, at: toUtcIso(row.serverTime) }
      },
    )
    return { file, tick: result }
  } catch (error) {
    if (error instanceof IdempotencyKeyReusedError) refuse(clientIdReusedRefusal(body.clientEventId))
    throw error
  }
}

