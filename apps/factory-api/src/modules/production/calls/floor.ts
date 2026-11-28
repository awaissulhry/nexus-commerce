import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { askTo, CALL_FILE_LIMITS, callFileKindOf, floorGroupOf, floorTypesFor, minutesOpen, NO_FLOOR_TYPES, SIGNAL_REFUSALS, type AskTo, type FloorCallGroup } from '@nexus/factory-domain/production/baskets/signals'
import { PRODUCTION_CALLS_VIEW } from '@nexus/factory-domain/production/calls/permissions'
import { isOpenCall, type CallKind, type CallStatus } from '@nexus/factory-domain/production/calls/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type FloorContext, type SystemContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { reachesWorkOrder } from '../work-orders/scope'
import { contextOf, floorOf, refuse } from './access'
import { callPlaceOf, codeWordsOf, lockCall, readCall, scopeOfCall, typesOfSite, wordsOf, type CallRow } from './store'

/**
 * Problems and asks on a phone (owb- order workflow, S5 fl3 step 1; `_owb-fl-common.md` § 2 settles 1–5, § 3 "fl3"; LF plan.md
 * § 5 pick C: NO floor chat — an ask goes as a help call, its answer comes back as the call's resolutionNote):
 *
 *   GET  /production/calls/station/types?for=PROBLEM|ASK   the window's tiles: the site's ACTIVE help-call types of its codes
 *                                                          (factory-domain production/baskets/signals), in the site's order,
 *                                                          with who answers an ask (fixed by its code); none → a sentence
 *   POST /production/calls/:callId/files (+ /:fileId/complete)  a photo (image/…) or a voice note (audio/…, ≤ 2 min) on the
 *                                                          caller's OWN open call (sent from this device, or from the station of
 *                                                          its department pick): a PHOTO or AUDIO file of the HelpCall, shared
 *                                                          OFFICE + FLOOR at the call's site (the floor notes' pattern)
 *   POST /production/calls/:callId/spot                   { spot 0–8 }: where on the basket picture the problem is, on the
 *                                                          caller's own open call (HelpCall.spot; the guard keeps a closed
 *                                                          call's spot)
 *   GET  /production/baskets/:code/calls                  the basket's calls (by its code or id): state, minutes open, escalated,
 *                                                          the answer the worker reads; floor (floor.work, its site) and office
 *                                                          (production.calls.view, the brand wall)
 *
 * A call itself is sent with today's POST /production/calls/station: on a phone it goes to the station of the department pick
 * (FloorSession.stationId; ./station.ts placeOf). Floor face: no person (caller, answerer), no office note but the answer, no
 * price, never the customer's name (a call names no customer at all).
 */

// ---- the window's tiles -------------------------------------------------------------------------------------------------------

/** GET /production/calls/station/types?for=PROBLEM|ASK. */
export async function floorTypes(caller: CommandCaller, query: { readonly for: FloorCallGroup }) {
  const context = floorOf(caller)
  return caller.withClient(async (db) => {
    const types = floorTypesFor(await typesOfSite(db, context.siteId, { active: true }), query.for)
    const words = await codeWordsOf(db, types.map((type) => type.code))
    return {
      for: query.for,
      types: types.map((type) => ({
        id: type.id,
        code: type.code,
        kind: type.kind as CallKind,
        active: type.active,
        escalateAfterMinutes: type.escalateAfterMinutes,
        to: askTo(type.code),
        ...wordsOf(type.code, words),
      })),
      none: types.length === 0 ? NO_FLOOR_TYPES[query.for] : null,
    }
  })
}

// ---- photo and voice on a call -----------------------------------------------------------------------------------------------

/** The tenant's system caller for one call's company and site only (the floor role writes no files: the floor notes' pattern). */
export function siteUploader(request: FastifyRequest, tenantId: string, scope: { readonly companyId: string; readonly siteId: string }, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [scope.companyId], sites: [scope.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/**
 * The caller's own call: of the device's site (else not found), sent from this device or from the station it answers for now
 * (its department pick's, else its own); `open`: still open.
 */
async function ownCall(caller: CommandCaller, context: FloorContext, callId: string, open: boolean): Promise<CallRow> {
  const call = isUuid(callId) ? await caller.withClient((db) => readCall(db, callId)) : null
  if (!call || call.siteId !== context.siteId) throw new NotFoundError('Call not found.')
  const place = await caller.withClient((db) => callPlaceOf(db, context))
  if (call.deviceId !== context.deviceId && call.stationId !== place.stationId) refuse(SIGNAL_REFUSALS.NOT_YOUR_CALL)
  if (open && !isOpenCall(call.status)) refuse(SIGNAL_REFUSALS.CALL_CLOSED)
  return call
}

export interface CallFileBody {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly durationSeconds?: number | undefined
}

/** POST /production/calls/:callId/files: a photo or a voice note announced on the caller's own open call, then the presigned PUT. */
export async function announceCallFile(request: FastifyRequest, callId: string, body: CallFileBody, idempotencyKey?: string) {
  const context = floorOf(request)
  const call = await ownCall(request, context, callId, true)
  const kind = callFileKindOf(body.contentType)
  if (!kind) throw new ValidationError('A call takes a photo or a voice note.', [{ path: 'body/contentType', message: 'Send a picture (image/…) or a sound (audio/…).' }])
  if (kind === 'AUDIO' && (body.durationSeconds === undefined || body.durationSeconds > CALL_FILE_LIMITS.voiceSeconds)) {
    throw new ValidationError(`A voice note runs at most ${CALL_FILE_LIMITS.voiceSeconds} seconds.`, [{ path: 'body/durationSeconds', message: `Say the voice note's length: at most ${CALL_FILE_LIMITS.voiceSeconds} seconds.` }])
  }
  const scope = scopeOfCall(call)
  const uploader = siteUploader(request, context.tenantId, scope, [FILES_UPLOAD, FILES_MANAGE])
  const already = await uploader.withClient((client) => client.storedFile.count({ where: { recordType: 'HelpCall', recordId: call.id, kind: { in: ['PHOTO', 'AUDIO'] }, status: { notIn: ['DELETED'] } } }))
  if (already >= CALL_FILE_LIMITS.filesPerCall) refuse(SIGNAL_REFUSALS.TOO_MANY_FILES)
  return requestUpload(
    processFiles(),
    uploader,
    {
      companyId: scope.companyId,
      recordType: 'HelpCall',
      recordId: call.id,
      kind,
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE', 'FLOOR'],
      floorSiteId: call.siteId,
    },
    idempotencyKey,
  )
}

/** POST /production/calls/:callId/files/:fileId/complete: the file is on the call from its announce; this confirms the upload. */
export async function completeCallFile(request: FastifyRequest, callId: string, fileId: string, idempotencyKey?: string) {
  const context = floorOf(request)
  // The call may have been solved while the photo went up: the upload still completes (it was announced on the open call).
  const call = await ownCall(request, context, callId, false)
  const uploader = siteUploader(request, context.tenantId, scopeOfCall(call), [FILES_UPLOAD, FILES_MANAGE])
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'HelpCall', recordId: call.id, kind: { in: ['PHOTO', 'AUDIO'] } }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey) }
}

// ---- the place on the picture --------------------------------------------------------------------------------------------------

/** POST /production/calls/:callId/spot: the spot (0–8) on the caller's own open call; the same spot again changes nothing. */
export async function setCallSpot(caller: CommandCaller, callId: string, body: { readonly spot: number }, idempotencyKey?: string) {
  const context = floorOf(caller)
  const known = await ownCall(caller, context, callId, true)
  if (known.spot === body.spot) return { callId: known.id, spot: body.spot, replayed: true }
  const { result, replayed } = await command(caller, { name: 'production.spotCall', idempotencyKey, input: { callId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const call = (await lockCall(tx, callId))!
    if (!isOpenCall(call.status)) refuse(SIGNAL_REFUSALS.CALL_CLOSED)
    await tx.helpCall.update({ where: { id: callId }, data: { spot: body.spot, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const scope = scopeOfCall(call)
    tools.audit({ action: 'production.spotCall', recordType: 'HelpCall', recordId: callId, ...scope, before: { spot: call.spot }, after: { spot: body.spot } })
    tools.emit({ type: 'help_call.changed', subject: callId, ...scope, payload: { callId, stationId: call.stationId, lineId: call.lineId, change: 'DETAILS', outcomeRecordType: null } })
    return { callId, spot: body.spot }
  })
  return { ...result, replayed }
}

// ---- a basket's calls --------------------------------------------------------------------------------------------------------

export interface BasketCallView {
  readonly id: string
  readonly typeCode: string
  readonly group: FloorCallGroup | null
  readonly to: AskTo | null
  readonly state: CallStatus
  readonly open: boolean
  readonly sentAt: string
  readonly minutes: number | null
  readonly escalated: boolean
  readonly answer: string | null
  readonly answeredAt: string | null
  readonly spot: number | null
  readonly files: readonly { readonly id: string; readonly kind: 'PHOTO' | 'AUDIO' }[]
}

const BASKET_CALLS_MAX = 50
const FLOOR_WORK = 'floor.work' as Permission

/** GET /production/baskets/:code/calls: the basket's calls, newest first. */
export async function basketCalls(caller: CommandCaller, code: string): Promise<{ readonly basket: { readonly id: string; readonly code: string }; readonly calls: BasketCallView[] }> {
  const context = contextOf(caller)
  const select = { id: true, code: true, siteId: true, workOrder: { select: { companyId: true, siteId: true, partyId: true } } } as const
  const bundle = await caller.withClient((db) => (isUuid(code) ? db.bundle.findUnique({ where: { id: code }, select }) : db.bundle.findFirst({ where: { code }, select })))
  if (!bundle) throw new NotFoundError('Basket not found.')
  const scope = { companyId: bundle.workOrder.companyId, siteId: bundle.siteId }
  if (context.audience === 'floor') {
    if (context.siteId !== bundle.siteId) throw new NotFoundError('Basket not found.')
    if (!can(actorOf(context), FLOOR_WORK, scope)) throw new ForbiddenError("A basket's calls are read on a floor device signed in to work.")
  } else if (!reachesWorkOrder(actorOf(context), PRODUCTION_CALLS_VIEW, { ...scope, partyId: bundle.workOrder.partyId })) {
    // The brand wall: a basket of a customer the reader does not reach is not found.
    throw new NotFoundError('Basket not found.')
  }
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const rows = await db.helpCall.findMany({
      where: { bundleId: bundle.id },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: BASKET_CALLS_MAX,
      select: { id: true, status: true, sentAt: true, escalatedAt: true, solvedAt: true, resolutionNote: true, spot: true, type: { select: { code: true } } },
    })
    const ids = rows.map((row) => row.id)
    const files = ids.length === 0 ? [] : await db.storedFile.findMany({ where: { recordType: 'HelpCall', recordId: { in: ids }, kind: { in: ['PHOTO', 'AUDIO'] }, status: 'AVAILABLE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, recordId: true, kind: true } })
    return {
      basket: { id: bundle.id, code: bundle.code },
      calls: rows.map((row) => {
        const open = isOpenCall(row.status)
        return {
          id: row.id,
          typeCode: row.type.code,
          group: floorGroupOf(row.type.code),
          to: askTo(row.type.code),
          state: row.status as CallStatus,
          open,
          sentAt: row.sentAt.toISOString(),
          minutes: open ? minutesOpen(row.sentAt, now) : null,
          escalated: row.escalatedAt !== null,
          answer: row.status === 'SOLVED' ? row.resolutionNote : null,
          answeredAt: row.status === 'SOLVED' && row.solvedAt ? row.solvedAt.toISOString() : null,
          spot: row.spot ?? null,
          files: files.filter((file) => file.recordId === row.id).map((file) => ({ id: file.id, kind: file.kind as 'PHOTO' | 'AUDIO' })),
        }
      }),
    }
  })
}
