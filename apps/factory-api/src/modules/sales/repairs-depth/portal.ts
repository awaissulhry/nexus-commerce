import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EstimateAnswer } from '@nexus/factory-domain/sales/repairs-depth/rules'
import type { CommandSpec, CommandTools } from '../../../core/command'
import { portalOf } from '../../../platform/auth/portal/service'
import type { FilesRuntime } from '../../../platform/files/service'
import { appClock } from '../../../platform/portal/tasks/clock'
import { assertMayRequest, assertMayUpload, portalReader, PREVIEW_WORDS, REQUEST_WORDS, type PortalReader } from '../portal-returns/access'
import { answerByFor, NO_SCOPE } from '../portal-returns/create'
import type { OpenMode } from '../portal-returns/files'
import { lockRepair } from '../repairs/stages'
import { answerInCommand, lockEstimate } from './estimates'
import { announceRepairPhoto, completeRepairPhoto, openRepairFile, type RepairPhotoUpload } from './photos'
import { createRequestInCommand, type RepairRequestBody } from './request'
import { customerRepairs, customerRepairView, readCustomerRepair } from './views'

/**
 * Repairs in the customer's portal (B-W2b-342; SAL-384, SAL-385, SAL-387; follow-up RR1:02; design portal.customer.returns
 * "Start a return or claim" with the repair's own questions, the repair's record with its photos and the estimate):
 *
 *   GET  /portal/repairs                         the party's repairs, newest first, with the next step for the customer
 *   POST /portal/repairs                         a repair or alteration request: a repair AWAITING_GOODS, channel PORTAL
 *   GET  /portal/repairs/:id                     the repair: what was asked, where it is, the photos, the estimate once sent
 *   POST /portal/repairs/:id/photos (+ /:fileId/complete)   a damage photo, while the work has not started
 *   POST /portal/repairs/files/:fileId/open      one of the customer's photos of their repair (logged)
 *   POST /portal/repairs/:id/estimate/answer     accept or decline the sent estimate (the price grain and the right to ask);
 *                                                an acceptance approves the repair in the same command
 *
 * Route permission portal.returns.view (the Returns & claims page); asking, answering and a photo also portal.returns.request
 * (a photo the upload capability), checked here with words. Reads and writes run in the tenant's office scope AS THE
 * PERSON (the partner role has no write on repairs) and name the session's company and party (B-W2b-192's pattern).
 */

function asPerson<Result>(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>) {
  const auth = portalOf(app).auth
  return auth.command(auth.contextFor(request, reader.session.tenantId, reader.session.userId), spec, work)
}

const optionsOf = (app: FastifyInstance, reader: PortalReader) => ({ seesPrices: reader.seesPrices, mayRequest: reader.mayRequest, mayUpload: reader.mayUpload, preview: reader.session.preview, now: appClock(app).now() })

export async function portalRepairs(app: FastifyInstance, request: FastifyRequest) {
  const reader = portalReader(app, request)
  const items = await reader.inTenant((db) => customerRepairs(db, reader.place))
  return { items, mayRequest: reader.mayRequest, seesPrices: reader.seesPrices, asOf: toUtcIso(appClock(app).now()) }
}

async function heldRepair(reader: PortalReader, repairId: string) {
  const row = isUuid(repairId) ? await reader.inTenant((db) => readCustomerRepair(db, reader.place, repairId)) : null
  if (!row) throw new NotFoundError('Repair not found.')
  return row
}

export async function portalRepair(app: FastifyInstance, request: FastifyRequest, repairId: string) {
  const reader = portalReader(app, request)
  const row = await heldRepair(reader, repairId)
  return { repair: await reader.inTenant((db) => customerRepairView(db, row, optionsOf(app, reader))), mayRequest: reader.mayRequest, mayUpload: reader.mayUpload, seesPrices: reader.seesPrices }
}

export async function portalRequestRepair(app: FastifyInstance, request: FastifyRequest, body: RepairRequestBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayRequest(reader)
  const { result } = await asPerson(app, request, reader, { name: 'repairsDepth.portalRequest', idempotencyKey, input: { ...body, sessionId: reader.session.id } }, (tools) =>
    createRequestInCommand(tools, reader.place, NO_SCOPE, body, { via: 'PORTAL', personId: reader.session.userId, linkId: null }),
  )
  const answerBy = await reader.inTenant((db) => answerByFor(db, reader.place.companyId, appClock(app).now()))
  return { ...(await portalRepair(app, request, result.repairId)), sent: { type: 'REPAIR' as const, id: result.repairId, number: result.number, answerBy } }
}

export async function portalRepairPhoto(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, repairId: string, body: RepairPhotoUpload, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayUpload(reader)
  const row = await heldRepair(reader, repairId)
  return announceRepairPhoto(files, request, reader.session.tenantId, reader.place, row, body, idempotencyKey)
}

export async function portalRepairPhotoDone(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, repairId: string, fileId: string, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayUpload(reader)
  const row = await heldRepair(reader, repairId)
  return completeRepairPhoto(files, request, reader.session.tenantId, reader.place, [row.id], fileId, idempotencyKey)
}

export async function portalOpenRepairFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, fileId: string, body: { readonly mode: OpenMode }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const repairs = await reader.inTenant((db) => customerRepairs(db, reader.place))
  return openRepairFile(files, app, request, { tenantId: reader.session.tenantId, place: reader.place, repairIds: repairs.map((row) => row.id), actor: { sessionId: reader.session.id, linkId: null } }, fileId, body.mode, idempotencyKey)
}

export interface PortalAnswerBody {
  readonly estimateId: string
  readonly version: number
  readonly answer: EstimateAnswer
  readonly declineReason?: string | null | undefined
}

export async function portalAnswerEstimate(app: FastifyInstance, request: FastifyRequest, repairId: string, body: PortalAnswerBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError(PREVIEW_WORDS)
  if (!reader.mayRequest) throw new ForbiddenError(REQUEST_WORDS)
  if (!reader.seesPrices) throw new ForbiddenError('Your access does not show prices: the estimate is answered by someone who sees them.')
  const row = await heldRepair(reader, repairId)
  const estimate = isUuid(body.estimateId) ? await reader.inTenant((db) => db.repairEstimate.findFirst({ where: { id: body.estimateId, repairId: row.id, partyId: reader.place.partyId }, select: { id: true, status: true } })) : null
  if (!estimate || estimate.status === 'DRAFT' || estimate.status === 'WITHDRAWN') throw new NotFoundError('Estimate not found.')
  await asPerson(app, request, reader, { name: 'repairsDepth.portalAnswer', idempotencyKey, input: { repairId, ...body, sessionId: reader.session.id } }, async (tools) => {
    const repair = await lockRepair(tools, row.id, undefined)
    const locked = await lockEstimate(tools, estimate.id, body.version)
    const reason = (body.declineReason ?? '').trim()
    await answerInCommand(tools, repair, locked, { answer: body.answer, via: 'PORTAL', at: tools.now, byName: reader.session.person.displayName.slice(0, 200), recordedById: null, declineReason: reason === '' ? null : reason, how: null })
    return null
  })
  return portalRepair(app, request, row.id)
}
