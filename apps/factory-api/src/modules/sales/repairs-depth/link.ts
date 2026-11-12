import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { OPEN_REPAIR_STAGES, REPAIR_KINDS } from '@nexus/factory-domain/sales/repairs/rules'
import { DEPTH_LIMITS } from '@nexus/factory-domain/sales/repairs-depth/rules'
import { idempotencyKeyFrom, type CommandCaller } from '../../../core/command'
import { systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { dropLinkDraft } from '../../../platform/links/drafts'
import { linkCommand, useLink } from '../../../platform/links/use'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { answerByFor, type ClaimScope } from '../portal-returns/create'
import type { OpenMode } from '../portal-returns/files'
import type { Place, Reader } from '../portal-returns/store'
import { announceRepairPhoto, completeRepairPhoto, openRepairFile, type RepairPhotoUpload } from './photos'
import { createRequestInCommand, planRequest, type RepairRequestBody } from './request'
import { customerRepairs, customerRepairView, readCustomerRepair } from './views'

/**
 * "Report a problem" › Repair or alteration by link (B-W2b-342; follow-ups RR1:01 "The claim link offers Repair with its
 * questions and damage photos", RR1:02; design links.claim sec:type "Return · Repair or alteration · …", sec:details
 * "Repair: the work wanted ('add 2 cm to the sleeve') — no payment data here", sec:photos): the CLAIM link of a shipment or
 * an order (B-W2b-192) takes a repair request beside its returns and complaints. B-W2b-192's own routes stay as they are;
 * these sit beside them:
 *
 *   GET  /link/claim/repair                      the repair is offered (its kinds), the repairs this link opened with
 *                                                where they are, the photos a repair takes
 *   POST /link/claim/repair {kind, …, typedName?}  the request checked first (a refusal uses nothing), then the link used
 *                                                (SUBMITTED, a counted use) in the link's own command, then ONE system
 *                                                command makes the repair (AWAITING_GOODS, channel LINK), drops the link's
 *                                                draft and notes the repair on the link; a repeat with the same key replays
 *   POST /link/claim/repair/photos (+ /:fileId/complete)  a damage photo of a repair this link opened, before the work
 *   GET  /link/claim/repair/:repairId            one repair this link opened, as the customer reads it (no price: the
 *                                                claim link holds no price grain)
 *   POST /link/claim/repair/files/:fileId/open   one of its photos (logged)
 *
 * The link session reads only its party's own rows; repairs are read here in the tenant's system scope, for the link's
 * company and party, and only the ones this link opened (its audit rows `repairsDepth.linkRepair`).
 */

const RECORD_TYPES = ['Shipment', 'SalesOrder']
const LINK_REPAIR_ACTION = 'repairsDepth.linkRepair'

function claimLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'CLAIM' || !RECORD_TYPES.includes(link.record.type)) throw linkUnavailable()
  return link
}

const placeOf = (link: LinkSession): Place => ({ companyId: link.companyId, partyId: link.partyId })
const systemOf = (request: FastifyRequest, link: { readonly tenantId: string }): CommandCaller => systemCallerOf(request)(link.tenantId)

async function scopeOf(db: Reader, link: LinkSession): Promise<ClaimScope> {
  if (link.record.type === 'SalesOrder') return { salesOrderId: link.record.id, shipmentId: null }
  const shipment = await db.shipment.findUnique({ where: { id: link.record.id }, select: { salesOrderId: true, partyId: true } })
  return { salesOrderId: shipment?.salesOrderId ?? null, shipmentId: link.record.id }
}

/** The repairs this link opened, from the audit rows its submits wrote on it. */
async function repairsOfLink(db: Reader, linkId: string): Promise<Set<string>> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'OneOffLink', recordId: linkId, action: LINK_REPAIR_ACTION }, select: { after: true } })
  return new Set(rows.flatMap((row) => {
    const after = (row.after ?? {}) as Record<string, unknown>
    return typeof after.repairId === 'string' ? [after.repairId] : []
  }))
}

const OPTIONS = (now: Date) => ({ seesPrices: false, mayRequest: true, mayUpload: true, preview: false, now })

/** GET /link/claim/repair */
export async function linkRepairPage(_app: FastifyInstance, request: FastifyRequest) {
  const link = claimLinkOf(request)
  const place = placeOf(link)
  const repairs = await systemOf(request, link).withClient(async (db) => customerRepairs(db, place, await repairsOfLink(db, link.id)))
  return { offered: true, kinds: [...REPAIR_KINDS], repairs, photos: { max: DEPTH_LIMITS.photos, damage: DEPTH_LIMITS.damagePhotos } }
}

export type LinkRepairBody = RepairRequestBody & { readonly typedName?: string | null | undefined }

/** POST /link/claim/repair: the repair, then this link's repairs and the end state's facts. */
export async function linkSubmitRepair(app: FastifyInstance, request: FastifyRequest, body: LinkRepairBody) {
  const link = claimLinkOf(request)
  const place = placeOf(link)
  const system = systemOf(request, link)
  const now = appClock(app).now()
  const { typedName, ...repair } = body
  // Checked before the link is used: a request that cannot go uses nothing (the command checks it all again).
  await system.withClient(async (db) => {
    const scope = await scopeOf(db, link)
    const plan = await planRequest(db, place, scope, repair)
    if (plan.serial) {
      const open = await db.repairOrder.findFirst({ where: { stage: { in: [...OPEN_REPAIR_STAGES] }, OR: [{ serial: plan.serial }, ...(plan.garmentSerial ? [{ garmentSerial: plan.garmentSerial }] : [])] }, select: { number: true, partyId: true } })
      if (open) {
        const words = open.partyId === place.partyId ? `Repair ${open.number} is open for this garment already: follow it there.` : 'This garment is with us for a repair already: write to us in the messages.'
        throw new DomainError('conflict', words, [{ path: 'body/serial', message: words }])
      }
    }
  })
  const key = idempotencyKeyFrom(request)
  const use = await linkCommand(request, { name: 'repairsDepth.linkSubmit', idempotencyKey: key, input: { kind: body.kind } }, async (tools) => {
    const used = await useLink(tools, request, { action: 'submit', typedName: typedName ?? null })
    return { evidenceId: used.evidenceId, usesLeft: used.usesLeft }
  })
  const scope = await system.withClient((db) => scopeOf(db, link))
  const { result } = await commandOn(app, system, { name: 'repairsDepth.linkRepair', idempotencyKey: key ? `repair.${createHash('sha256').update(`${link.id}|${key}`).digest('hex').slice(0, 48)}` : undefined, input: { linkId: link.id, ...repair } }, async (tools) => {
    const made = await createRequestInCommand(tools, place, scope, repair, { via: 'LINK', personId: null, linkId: link.id })
    await dropLinkDraft(tools, link.id)
    tools.audit({ action: LINK_REPAIR_ACTION, recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { repairId: made.repairId, number: made.number, evidenceId: use.result.evidenceId } })
    return made
  })
  const answerBy = await system.withClient((db) => answerByFor(db, place.companyId, now))
  const page = await linkRepairPage(app, request)
  return { ...page, link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: use.result.usesLeft, live: link.expiresAt.getTime() > now.getTime() }, sent: { type: 'REPAIR' as const, id: result.repairId, number: result.number, answerBy } }
}

async function linkRepair(request: FastifyRequest, link: LinkSession, repairId: string) {
  return systemOf(request, link).withClient(async (db) => {
    if (!isUuid(repairId) || !(await repairsOfLink(db, link.id)).has(repairId)) return null
    return readCustomerRepair(db, placeOf(link), repairId)
  })
}

/** GET /link/claim/repair/:repairId */
export async function linkRepairRecord(app: FastifyInstance, request: FastifyRequest, repairId: string) {
  const link = claimLinkOf(request)
  const row = await linkRepair(request, link, repairId)
  if (!row) throw new NotFoundError('Repair not found.')
  return { repair: await systemOf(request, link).withClient((db) => customerRepairView(db, row, OPTIONS(appClock(app).now()))) }
}

export async function linkRepairPhoto(files: FilesRuntime, request: FastifyRequest, body: RepairPhotoUpload & { readonly repairId: string }, idempotencyKey?: string) {
  const link = claimLinkOf(request)
  const row = await linkRepair(request, link, body.repairId)
  if (!row) throw new NotFoundError('Repair not found.')
  const { repairId: _repairId, ...photo } = body
  return announceRepairPhoto(files, request, link.tenantId, placeOf(link), row, photo, idempotencyKey)
}

export async function linkRepairPhotoDone(files: FilesRuntime, request: FastifyRequest, fileId: string, idempotencyKey?: string) {
  const link = claimLinkOf(request)
  const ids = await systemOf(request, link).withClient((db) => repairsOfLink(db, link.id))
  return completeRepairPhoto(files, request, link.tenantId, placeOf(link), [...ids], fileId, idempotencyKey)
}

export async function linkOpenRepairFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, fileId: string, body: { readonly mode: OpenMode }) {
  const link = claimLinkOf(request)
  const ids = await systemOf(request, link).withClient((db) => repairsOfLink(db, link.id))
  return openRepairFile(files, app, request, { tenantId: link.tenantId, place: placeOf(link), repairIds: [...ids], actor: { sessionId: null, linkId: link.id } }, fileId, body.mode)
}
