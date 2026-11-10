import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { parseInstant } from '@nexus/factory-domain/core/time'
import type { FloorRequestBody, PhotoBody } from '@nexus/factory-domain/product/changes/contracts'
import { floorRequestText } from '@nexus/factory-domain/product/changes/rules'
import { command, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type FloorContext, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { floorOf, scanWorkOrder, systemView } from '../../production/scans/access'
import { readOperations } from '../../production/scans/store'
import { databaseRefusal } from './store'

/**
 * "Report a spec problem" from the floor (B-W2b-226; PRD-259; design floor.instructions problem: "Type tiles (wrong
 * measurement, unclear, material differs, other) → photo (optional) → Send; linked to operation and work order"):
 *
 *   POST /product/floor/change-requests                         floor.work at the device's site: the request, online or from
 *                                                               the tablet's queue (floor-sync kind product.change.report),
 *                                                               keyed `<device>.<clientEventId>`: a resend answers the first
 *   POST /product/floor/change-requests/:id/photos              a PHOTO of it, announced (then PUT, then confirmed); never a
 *   POST /product/floor/change-requests/:id/photos/:fid/complete  face (the tablet says so)
 *
 * The tablet's role only INSERTS a request of its site (factory-db ownership/changes.json: source FLOOR, no number, no
 * decision, no creator, no SELECT, so the insert has no RETURNING): the request is written in the floor's own command, so the
 * database itself holds the floor to its site and to what it may say. It names no worker; the office numbers it when it
 * first takes it up. Its photos go through platform/files as the tenant's system caller holding exactly files.upload and
 * files.manage over the site's company and site (OFFICE + FLOOR), after this module checked, in the tenant's system scope,
 * that the request is one from this site's floor that nobody decided yet.
 */

const FLOOR_WORK = 'floor.work' satisfies Permission
const keyOf = (deviceId: string, clientEventId: string) => `${deviceId}.${clientEventId}`

/** Photos are added while the request is open or in review, at most a week after it was sent. */
const PHOTO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** POST /product/floor/change-requests, or the queue's product.change.report: the request; answers its id. */
export async function reportFromFloor(caller: CommandCaller, body: FloorRequestBody): Promise<{ changeRequest: { id: string }; replayed: boolean }> {
  const context = floorOf(caller)
  const workOrder = await scanWorkOrder(caller, body.workOrderId, FLOOR_WORK)
  const place = await caller.withClient(async (db) => {
    const revision = await db.workOrder.findUnique({ where: { id: workOrder.id }, select: { styleRevisionId: true } })
    const operation = body.workOrderOperationId ? ((await readOperations(db, workOrder.id)).find((entry) => entry.id === body.workOrderOperationId) ?? null) : null
    const bundle = body.bundleId ? await db.bundle.findFirst({ where: { id: body.bundleId, workOrderId: workOrder.id }, select: { code: true } }) : null
    return { revisionId: revision?.styleRevisionId ?? null, operation, bundle }
  })
  if (body.workOrderOperationId && !place.operation) throw new NotFoundError('Operation not found on this work order.')
  if (body.bundleId && !place.bundle) throw new NotFoundError('Bundle not found on this work order.')
  const text = floorRequestText({ problem: body.problem, note: body.note ?? null, workOrder: workOrder.number, operation: place.operation, bundle: place.bundle?.code ?? null })
  const tapped = body.occurredAt ? parseInstant(body.occurredAt) : null
  const id = newId()
  const { result, replayed } = await command(
    caller,
    { name: 'product.changes.reportFromFloor', idempotencyKey: keyOf(context.deviceId, body.clientEventId), input: body, ...(tapped ? { deviceTime: tapped } : {}) },
    async (tools) => {
      const { tx, now } = tools
      // INSERT without RETURNING, naming only the columns granted to the floor (Prisma's createMany would also write the
      // status and priority defaults, which the floor's role may not set): the floor adds the request, never reads it back.
      await tx.$executeRaw`
        INSERT INTO "ChangeRequest" ("id", "companyId", "siteId", "source", "styleId", "revisionId", "workOrderId", "title", "reason", "createdAt", "updatedAt")
        VALUES (${id}::uuid, ${workOrder.companyId}::uuid, ${context.siteId}::uuid, 'FLOOR'::"ChangeRequestSource", ${workOrder.styleId}::uuid, ${place.revisionId}::uuid,
                ${workOrder.id}::uuid, ${text.title}, ${text.reason}, ${now}, ${now})`
      tools.audit({
        action: 'product.changes.reportFromFloor',
        recordType: 'ChangeRequest',
        recordId: id,
        companyId: workOrder.companyId,
        siteId: context.siteId,
        after: { source: 'FLOOR', problem: body.problem, styleId: workOrder.styleId, revisionId: place.revisionId, workOrderId: workOrder.id, operationId: place.operation?.id ?? null, bundleId: body.bundleId ?? null, deviceId: context.deviceId },
      })
      tools.emit({ type: 'change_request.raised', subject: id, companyId: workOrder.companyId, siteId: context.siteId, payload: { changeRequestId: id, number: null, styleId: workOrder.styleId, source: 'FLOOR', workOrderId: workOrder.id } })
      return { changeRequest: { id } }
    },
  ).catch(databaseRefusal)
  return { ...result, replayed }
}

/** The tenant's system caller for the site's company and site only, holding exactly these permissions. */
function siteCaller(request: FastifyRequest, context: FloorContext, companyId: string, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [companyId], sites: [context.siteId], parties: 'all' }
  const system: SystemContext = Object.freeze({ audience: 'system', tenantId: context.tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = system
  return view
}

/** The request the photo is for: a floor request of this device's site, not decided, sent within the week (read as the system). */
async function floorRequestOf(request: FastifyRequest, changeRequestId: string): Promise<{ context: FloorContext; companyId: string }> {
  const context = floorOf(request)
  const row = isUuid(changeRequestId)
    ? await systemView(request).withClient((db) => db.changeRequest.findUnique({ where: { id: changeRequestId }, select: { companyId: true, siteId: true, source: true, status: true, createdAt: true } }))
    : null
  if (!row || row.source !== 'FLOOR' || row.siteId !== context.siteId) throw new NotFoundError('Change request not found.')
  if (row.status !== 'OPEN' && row.status !== 'IN_REVIEW') throw new InvalidStateError('The office has already decided this request: a photo is no longer added to it.')
  if (Date.now() - row.createdAt.getTime() > PHOTO_WINDOW_MS) throw new InvalidStateError('This request was sent more than a week ago: report the problem again with its photo.')
  return { context, companyId: row.companyId }
}

/** POST /product/floor/change-requests/:id/photos */
export async function announceFloorPhoto(request: FastifyRequest, changeRequestId: string, body: PhotoBody, idempotencyKey?: string) {
  const { context, companyId } = await floorRequestOf(request, changeRequestId)
  return requestUpload(
    processFiles(),
    siteCaller(request, context, companyId, [FILES_UPLOAD, FILES_MANAGE]),
    { ...body, companyId, recordType: 'ChangeRequest', recordId: changeRequestId, kind: 'PHOTO', visibility: ['OFFICE', 'FLOOR'], floorSiteId: context.siteId },
    idempotencyKey,
  )
}

/** POST /product/floor/change-requests/:id/photos/:fileId/complete */
export async function completeFloorPhoto(request: FastifyRequest, changeRequestId: string, fileId: string, idempotencyKey?: string) {
  const { context, companyId } = await floorRequestOf(request, changeRequestId)
  const uploader = siteCaller(request, context, companyId, [FILES_UPLOAD, FILES_MANAGE])
  const file = isUuid(fileId) ? await uploader.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: 'ChangeRequest', recordId: changeRequestId, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey) }
}
