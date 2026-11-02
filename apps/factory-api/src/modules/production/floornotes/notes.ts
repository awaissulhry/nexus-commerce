import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { FLOOR_NOTE_LIMITS, FLOOR_NOTE_TILES, isClip, NO_FACES_REMINDER, noteProblem, noteText, type FloorNoteTileCode } from '@nexus/factory-domain/production/floornotes/rules'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { subjectRefusal } from '@nexus/factory-domain/production/scans/rules'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { attachmentProblems, ensureThread, writeMessage, type MessageInput } from '../../../platform/threads/threads'
import { asTenantSystem } from '../bundles/codes'
import { floorOf, refuse, scanWorkOrder } from '../scans/access'
import { deviceStationOf, readOperations, readStations, workerNames, type ScanHeader } from '../scans/store'
import { hasAcknowledgedNotice, scanSubjectFor } from '../settings/subject'

/**
 * A comment or a photo from the floor (B-W2b-47; MES-101 "Comment and photo", COL-017 "Photo and short video from the
 * floor"; design floor.operation "Photo or comment": "posted to the work order's thread"; factory-domain floornotes/rules).
 *
 *   tiles     what differs (short tiles), the reminder the photo step shows ("Keep faces out of the picture"), the limits
 *   file      a picture or a clip of up to 15 seconds, a PHOTO file of the WorkOrder, announced, PUT, confirmed
 *   note      the tile, the worker's words and the files: an internal message of the work order's thread
 *
 * The tablet's role may write neither files nor threads, so after the floor's own checks (production.scan at the device's
 * site, a work order of that site) the file goes through as the tenant's system caller holding exactly files.upload and
 * files.manage over the work order's company and site (OFFICE + FLOOR, as the dock's photos), and the note in a command of the
 * tenant's system caller, keyed `<device>.<clientEventId>`. The author is the worker where the site names workers (once they
 * acknowledged the notice, as any floor record), else the station: a site that records stations names no person here either.
 */

const keyOf = (deviceId: string, clientEventId: string) => `${deviceId}.${clientEventId}`

export const noteTiles = () => ({ tiles: FLOOR_NOTE_TILES.map((tile) => ({ code: tile.code, label: tile.label, needsDetail: tile.needsDetail })), reminder: NO_FACES_REMINDER, limits: FLOOR_NOTE_LIMITS })

function siteUploader(request: FastifyRequest, tenantId: string, workOrder: Pick<ScanHeader, 'companyId' | 'siteId'>): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [workOrder.companyId], sites: [workOrder.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

export interface AnnounceInput {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly durationSeconds?: number | undefined
}

/** POST …/files: a picture or a short clip of the work order, then the presigned PUT; the answer carries the reminder. */
export async function announceFile(request: FastifyRequest, workOrderId: string, body: AnnounceInput, idempotencyKey?: string) {
  const context = floorOf(request)
  const workOrder = await scanWorkOrder(request, workOrderId, PRODUCTION_SCAN)
  const clip = isClip(body.contentType)
  if (clip && (body.durationSeconds === undefined || body.durationSeconds > FLOOR_NOTE_LIMITS.clipSeconds)) {
    throw new ValidationError(`A clip from the floor runs at most ${FLOOR_NOTE_LIMITS.clipSeconds} seconds.`, [{ path: 'body/durationSeconds', message: `Say the clip's length: at most ${FLOOR_NOTE_LIMITS.clipSeconds} seconds.` }])
  }
  const { durationSeconds: _length, ...file } = body
  const answer = await requestUpload(
    processFiles(),
    siteUploader(request, context.tenantId, workOrder),
    { ...file, companyId: workOrder.companyId, recordType: 'WorkOrder', recordId: workOrder.id, kind: 'PHOTO', visibility: ['OFFICE', 'FLOOR'], floorSiteId: workOrder.siteId },
    idempotencyKey,
    { clip },
  )
  return { ...answer, reminder: NO_FACES_REMINDER }
}

/** POST …/files/:fileId/complete */
export async function completeFile(request: FastifyRequest, workOrderId: string, fileId: string, idempotencyKey?: string) {
  const context = floorOf(request)
  const workOrder = await scanWorkOrder(request, workOrderId, PRODUCTION_SCAN)
  const uploader = siteUploader(request, context.tenantId, workOrder)
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'WorkOrder', recordId: workOrder.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey) }
}

export interface NoteInput {
  readonly clientEventId: string
  readonly tileCode: FloorNoteTileCode
  readonly note?: string | undefined
  readonly fileIds?: readonly string[] | undefined
  readonly bundleId?: string | undefined
  readonly workOrderOperationId?: string | undefined
  readonly occurredAt?: string | undefined
}

/** POST /production/floor-notes/work-orders/:workOrderId, or the offline queue: the note on the work order's thread. */
export async function postFloorNote(caller: CommandCaller, workOrderId: string, input: NoteInput) {
  const context = floorOf(caller)
  const workOrder = await scanWorkOrder(caller, workOrderId, PRODUCTION_SCAN)
  const note = input.note?.trim() || null
  const fileIds = [...new Set(input.fileIds ?? [])]
  const problem = noteProblem({ tileCode: input.tileCode, note, files: fileIds.length })
  if (problem) throw new ValidationError(problem, [{ path: 'body/note', message: problem }])
  const place = await caller.withClient(async (db) => {
    const scanSubject = await scanSubjectFor(db, workOrder.siteId)
    const stationId = await deviceStationOf(db, context.deviceId)
    const bundle = input.bundleId ? await db.bundle.findFirst({ where: { id: input.bundleId, workOrderId: workOrder.id }, select: { id: true, code: true } }) : null
    const operation = input.workOrderOperationId ? ((await readOperations(db, workOrder.id)).find((entry) => entry.id === input.workOrderOperationId) ?? null) : null
    return {
      scanSubject,
      stationId,
      bundle,
      operation,
      acknowledged: scanSubject === 'WORKER' ? await hasAcknowledgedNotice(db, workOrder.siteId, context.actorId) : false,
      stationCode: stationId ? ((await readStations(db, [stationId])).get(stationId)?.code ?? null) : null,
      name: (await workerNames(db, [context.actorId])).get(context.actorId) ?? null,
    }
  })
  if (input.bundleId && !place.bundle) throw new NotFoundError('Bundle not found on this work order.')
  if (input.workOrderOperationId && !place.operation) throw new NotFoundError('Operation not found on this work order.')
  const notNamed = subjectRefusal({ scanSubject: place.scanSubject, workerId: context.actorId, acknowledged: place.acknowledged, stationId: place.stationId })
  if (notNamed) refuse(notNamed)
  const author: MessageInput['author'] = place.scanSubject === 'WORKER' ? { kind: 'WORKER', id: context.actorId, name: place.name } : { kind: 'SYSTEM', id: null, name: place.stationCode }
  const bodyText = cleanBody(noteText({ tileCode: input.tileCode, note, bundleCode: place.bundle?.code ?? null, operation: place.operation }))
  const deviceTime = input.occurredAt ? parseInstant(input.occurredAt) : null
  const { result, replayed } = await command(
    asTenantSystem(caller, context),
    { name: 'production.postFloorNote', idempotencyKey: keyOf(context.deviceId, input.clientEventId), input: { workOrderId: workOrder.id, ...input }, ...(deviceTime ? { deviceTime } : {}) },
    async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'WorkOrder', id: workOrder.id }, null)
      if (thread.status !== 'OPEN') throw new InvalidStateError("This work order's thread is closed in the office: the note cannot be posted.")
      const issues = await attachmentProblems(tools.tx, tools.context, thread, fileIds, 'OFFICE')
      if (issues.length > 0) throw new ValidationError('The note is not valid.', issues)
      const message = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author, bodyText, attachments: fileIds })
      tools.audit({ action: 'production.postFloorNote', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { messageId: message.id, tileCode: input.tileCode, bundleId: place.bundle?.id ?? null, operationId: place.operation?.id ?? null, files: fileIds.length, deviceId: context.deviceId, stationId: place.stationId, workerId: place.scanSubject === 'WORKER' ? context.actorId : null } })
      return { messageId: message.id, threadId: thread.id, files: fileIds.length }
    },
  )
  return { ...result, replayed }
}
