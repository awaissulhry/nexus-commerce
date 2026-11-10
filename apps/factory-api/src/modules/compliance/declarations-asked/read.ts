import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { SUPPLIER_DECLARATIONS_MANAGE, SUPPLIER_DECLARATIONS_VIEW } from '@nexus/factory-domain/compliance/declarations-asked/permissions'
import { holds } from '@nexus/factory-domain/core/permissions'
import { OPEN, type ShownStatus } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import type { DeclarationKind } from '@nexus/factory-domain/compliance/substances/rules'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf } from '../../../core/context'
import { companyReach, officeOf } from '../register-of-rules/common'
import { substancesClock } from '../substances/common'
import { mayManage, readRequest } from './common'
import { dayOf, dayValue, newestListVersion, REQUEST_SELECT, requestDetail, requestViews } from './store'

/**
 * The office's reads of the declarations asked (B-W2b-256; design compliance.tests › Supplier declarations, its tiles and
 * the Supplier declaration record). compliance.certificates.view: the requests of the companies the person reads.
 */

export const LIST_LIMIT = 500

export interface ListQuery {
  readonly status?: string | undefined
  readonly shown?: ShownStatus | undefined
  readonly kind?: DeclarationKind | undefined
  readonly partyId?: string | undefined
  readonly itemId?: string | undefined
  readonly q?: string | undefined
}

/** GET /compliance/declarations-asked — the list (newest first), the tiles' counts and `mayAsk`. */
export async function listRequests(request: FastifyRequest, query: ListQuery) {
  const actor = actorOf(officeOf(request))
  const now = substancesClock().now()
  const today = businessDate(now)
  return request.withClient(async (db) => {
    const reach = companyReach(actor, SUPPLIER_DECLARATIONS_VIEW) as Prisma.SupplierDeclarationRequestWhereInput
    const statuses = query.status ? query.status.split(',').filter(Boolean) : null
    const where: Prisma.SupplierDeclarationRequestWhereInput = {
      AND: [
        reach,
        ...(statuses ? [{ status: { in: statuses as never } }] : []),
        ...(query.shown === 'EXPIRED' || query.shown === 'REREQUEST_NEEDED' || query.shown === 'ACCEPTED' ? [{ status: 'ACCEPTED' as const }] : []),
        ...(query.shown === 'REQUESTED' ? [{ status: 'SENT' as const }] : query.shown === 'OVERDUE' ? [{ status: 'OVERDUE' as const }] : query.shown === 'ANSWERED' ? [{ status: 'ANSWERED' as const }] : query.shown === 'REJECTED' ? [{ status: 'REFUSED' as const }] : query.shown === 'CANCELLED' ? [{ status: 'CANCELLED' as const }] : []),
        ...(query.kind ? [{ kind: query.kind }] : []),
        ...(query.partyId ? [{ partyId: query.partyId }] : []),
        ...(query.itemId ? [{ lines: { some: { itemId: query.itemId } } }] : []),
        ...(query.q ? [{ OR: [{ number: { contains: query.q, mode: 'insensitive' as const } }, { party: { code: { contains: query.q, mode: 'insensitive' as const } } }, { party: { legalName: { contains: query.q, mode: 'insensitive' as const } } }, { lines: { some: { articleLabel: { contains: query.q, mode: 'insensitive' as const } } } }] }] : []),
      ],
    }
    const rows = await db.supplierDeclarationRequest.findMany({ where, select: REQUEST_SELECT, orderBy: [{ sentAt: 'desc' }, { number: 'desc' }], take: LIST_LIMIT + 1 })
    const views = (await requestViews(db, rows.slice(0, LIST_LIMIT), now)).filter((view) => !query.shown || view.shown === query.shown)
    // The tiles (design ts-metrics): overdue, to decide, to ask again because the Candidate List grew, expired.
    const overdue = await db.supplierDeclarationRequest.count({ where: { AND: [reach, { OR: [{ status: 'OVERDUE' }, { status: 'SENT', dueOn: { lt: dayValue(today) } }] }] } })
    const answered = await db.supplierDeclarationRequest.count({ where: { AND: [reach, { status: 'ANSWERED' }] } })
    const newest = await newestListVersion(db)
    const accepted = await db.supplierDeclarationRequest.findMany({ where: { AND: [reach, { status: 'ACCEPTED' }] }, select: { kind: true, validTo: true, svhcListVersionId: true, answeredListVersionId: true } })
    const expired = accepted.filter((row) => row.validTo !== null && dayOf(row.validTo) < today).length
    const rerequest = accepted.filter((row) => row.kind === 'REACH_SVHC' && newest !== null && (row.answeredListVersionId ?? row.svhcListVersionId) !== newest.id && (row.validTo === null || dayOf(row.validTo) >= today)).length
    const open = await db.supplierDeclarationRequest.count({ where: { AND: [reach, { status: { in: [...OPEN] } }] } })
    return {
      requests: views,
      more: rows.length > LIST_LIMIT,
      counts: { open, overdue, answered, rerequest, expired },
      newestListVersion: newest,
      mayAsk: holds(actor, SUPPLIER_DECLARATIONS_MANAGE),
      asOf: toUtcIso(now),
    }
  })
}

/** GET /compliance/declarations-asked/:requestId — the record: Request, Answer, Decision. */
export async function getRequest(request: FastifyRequest, requestId: string) {
  const actor = actorOf(officeOf(request))
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const row = await readRequest(db, actor, requestId)
    return { request: await requestDetail(db, row, now), mayManage: mayManage(actor, row.companyId), asOf: toUtcIso(now) }
  })
}
