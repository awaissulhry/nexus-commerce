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
// B-OF-034 (order files tab): a photo that answers an office ask for a file.
import { serverClock } from '../../../core/time'
import { isFloorAddressee } from '@nexus/factory-domain/files/asks'
import { ASK_COLUMNS, auditViewOf, eventIdsOf, eventPlaceOf, writeCheckTask } from '../../sales/file-asks/file-asks'
import { answerableAsk } from './asks'

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
 * A comment written on the floor is for the floor (`forFloor`, B-W2b-F5): the other stations read it on My work.
 *
 * B-OF-034 (order files tab; 13-backend §2): a note may name the office's ask for a file it answers (`askId`, tile ASKED_FILE "Photo for an
 * ask"). When the ask is one this tablet answers (./asks.ts `answerableAsk`: OPEN, a floor ask of this site and work order, to the
 * worker's team, floor role, or this work order's step) the note's photos go to it in the SAME system command: OPEN → ARRIVED with the
 * note's files, answered by "the floor" (answeredById null: never the worker), the asker's "Check: …" Task, audit
 * files.fileAsk.answer (the note's own audit keeps its worker or station as before), event file_ask.arrived. An ask closed meanwhile
 * (or not this tablet's) is left as it is and the note posts as any note; the answer says so (`ask.answered` false).
 */

const keyOf = (deviceId: string, clientEventId: string) => `${deviceId}.${clientEventId}`

export const noteTiles = () => ({ tiles: FLOOR_NOTE_TILES.map((tile) => ({ code: tile.code, label: tile.label, needsDetail: tile.needsDetail })), reminder: NO_FACES_REMINDER, limits: FLOOR_NOTE_LIMITS })

// owb-fl1: exported — the basket's quality step photo (A/production/baskets/photo.ts) uploads through the same system caller.
export function siteUploader(request: FastifyRequest, tenantId: string, workOrder: Pick<ScanHeader, 'companyId' | 'siteId'>): CommandCaller {
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
  /** B-OF-034: the office's ask for a file this photo answers. */
  readonly askId?: string | undefined
}

/** POST /production/floor-notes/work-orders/:workOrderId, or the offline queue: the note on the work order's thread. */
export async function postFloorNote(caller: CommandCaller, workOrderId: string, input: NoteInput) {
  const context = floorOf(caller)
  const workOrder = await scanWorkOrder(caller, workOrderId, PRODUCTION_SCAN)
  const note = input.note?.trim() || null
  const fileIds = [...new Set(input.fileIds ?? [])]
  const problem = noteProblem({ tileCode: input.tileCode, note, files: fileIds.length })
  if (problem) throw new ValidationError(problem, [{ path: 'body/note', message: problem }])
  // ---- B-OF-034: an ask is answered with the note's photos (at least one); whether this tablet answers it is read here.
  const askId = input.askId ?? null
  if (askId && fileIds.length === 0) throw new ValidationError('A photo for an ask needs the photo.', [{ path: 'body/fileIds', message: 'A photo for an ask needs the photo.' }])
  const answerable = askId ? await answerableAsk(caller, context, askId, workOrder.id, input.workOrderOperationId ?? null, serverClock.now()) : null
  // ---- end B-OF-034
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
      const message = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author, bodyText, attachments: fileIds, forFloor: true })
      tools.audit({ action: 'production.postFloorNote', recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { messageId: message.id, tileCode: input.tileCode, bundleId: place.bundle?.id ?? null, operationId: place.operation?.id ?? null, files: fileIds.length, deviceId: context.deviceId, stationId: place.stationId, workerId: place.scanSubject === 'WORKER' ? context.actorId : null, /* B-OF-034 */ askId } })
      // ---- B-OF-034: the photos answer the ask (OPEN → ARRIVED, by the floor), unless it closed meanwhile.
      let ask: { id: string; answered: boolean } | null = askId ? { id: askId, answered: false } : null
      if (askId && answerable) {
        await tools.tx.$queryRaw`SELECT id FROM "FileAsk" WHERE id = ${askId}::uuid FOR UPDATE`
        const row = await tools.tx.fileAsk.findUnique({ where: { id: askId }, select: ASK_COLUMNS })
        if (row && row.status === 'OPEN' && isFloorAddressee(row.addressee) && row.workOrderId === workOrder.id) {
          const checkTaskId = await writeCheckTask(tools, row, null)
          const after = await tools.tx.fileAsk.update({ where: { id: row.id }, data: { status: 'ARRIVED', fileIds, answeredAt: tools.now, answeredById: null, checkTaskId, version: row.version + 1, updatedAt: tools.now }, select: ASK_COLUMNS })
          tools.audit({ action: 'files.fileAsk.answer', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditViewOf(row), after: { ...auditViewOf(after), by: 'FLOOR', messageId: message.id, checkTaskId } })
          tools.emit({ type: 'file_ask.arrived', ...eventPlaceOf(row), payload: eventIdsOf(row, 'ARRIVED') })
          ask = { id: row.id, answered: true }
        }
      }
      // ---- end B-OF-034
      return { messageId: message.id, threadId: thread.id, files: fileIds.length, ask }
    },
  )
  // B-OF-034: a note resent from before asks existed answers no ask.
  return { ...result, ask: result.ask ?? null, replayed }
}
