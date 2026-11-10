import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CreateRequestBody, MoveRequestBody, RequestListQuery, RequestView, UpdateRequestBody } from '@nexus/factory-domain/product/changes/contracts'
import { PRODUCT_CHANGES_MANAGE, PRODUCT_CHANGES_REQUEST, PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import { REQUEST_TILE_STATUSES, REQUEST_TILES, requestEditRefusal, requestMoveRefusal, type ChangeRequestStatus, type RequestTile } from '@nexus/factory-domain/product/changes/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
import { databaseRefusal, madeOf, may, NOTHING_MADE, officeOf, readRequestFor, refuse, REQUEST_COLUMNS, requestRowsOf, type RequestData } from './store'

/**
 * Change requests from the office (B-W2b-226; PRD-169, MES-006; design products.changes "New change request", changes.grid,
 * production.workorders "Change request"). The floor's are ./floor.ts.
 *
 *   GET   /product/change-requests                        product.changes.view: the list with its tiles (to triage, accepted
 *                                                         and not in a change order, mine, all) and filters
 *   GET   /product/change-requests/:id                    the record: what, why, from where, its photos, the triage moves
 *                                                         allowed now, what of its work order is already made
 *   POST  /product/change-requests                        product.changes.request: raise one (numbered at once; its author
 *                                                         follows it)
 *   PATCH /product/change-requests/:id                    product.changes.request: what, why, the revision, the priority
 *                                                         until it is decided
 *   POST  /product/change-requests/:id/move               product.changes.manage: into review, accepted, rejected with why
 *                                                         (a floor request is numbered when it is first taken up)
 *   GET   /product/change-requests/work-orders/:id        product.changes.view: a work order's "Change request" pop-up: what
 *                                                         is cut and worked (MES-006) and the requests about it
 *
 * Photos of an office request go up through the generic files routes (record type "ChangeRequest", POST /files): no rule of
 * this module rests on them. Each write is ONE command on the request at the version the caller read.
 */

const LIST_LIMIT = 100

/** Who raised it, for the audit and the creator's follow: the office person. */
const authorOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** Numbers a floor request when the office first takes it up (the database refuses it leaving OPEN without one). */
export async function numberIfNeeded(tools: CommandTools, row: Pick<RequestData, 'id' | 'number' | 'companyId'>): Promise<string> {
  if (row.number !== null) return row.number
  const issued = await allocateNumber(tools, { companyId: row.companyId, kind: 'CHANGE_REQUEST' }, { type: 'ChangeRequest', id: row.id })
  return issued.formatted
}

function badBody(path: string, message: string): never {
  throw new ValidationError(message, [{ path: `body/${path}`, message }])
}

/** POST /product/change-requests */
export async function createRequest(caller: CommandCaller, body: CreateRequestBody, idempotencyKey?: string): Promise<RequestView> {
  const context = officeOf(caller)
  const checked = await caller.withClient(async (db) => {
    const style = await db.style.findUnique({ where: { id: body.styleId }, select: { id: true, code: true, companyId: true } })
    if (!style || (style.companyId !== null && !may(context, PRODUCT_CHANGES_VIEW, style.companyId))) throw new NotFoundError('Style not found.')
    const workOrder = body.workOrderId ? await db.workOrder.findUnique({ where: { id: body.workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, styleId: true } }) : null
    if (body.workOrderId && (!workOrder || !may(context, PRODUCT_CHANGES_VIEW, workOrder.companyId))) throw new NotFoundError('Work order not found.')
    if (workOrder && workOrder.styleId !== style.id) badBody('workOrderId', `Work order ${workOrder.number} makes another style.`)
    // The company it is numbered in: the style's; a tenant-wide style's: its work order's, else the one named.
    const companyId = style.companyId ?? workOrder?.companyId ?? body.companyId ?? context.companyId ?? null
    if (companyId === null) badBody('companyId', `Style ${style.code} is every company's: say which company the request is for.`)
    if ((style.companyId !== null || workOrder) && body.companyId !== undefined && body.companyId !== companyId) badBody('companyId', `The request is for the company of the ${workOrder ? 'work order' : 'style'}.`)
    const partyWanted = body.source === 'CUSTOMER' || body.source === 'SUPPLIER'
    if (partyWanted !== (body.partyId !== undefined)) badBody('partyId', partyWanted ? `Say which ${body.source === 'CUSTOMER' ? 'customer' : 'supplier'} asked.` : 'A party is named only for a customer’s or a supplier’s request.')
    if (body.partyId) {
      const party = await db.party.findUnique({ where: { id: body.partyId }, select: { roles: true, companyId: true } })
      const roles = body.source === 'CUSTOMER' ? ['CUSTOMER', 'BRAND'] : ['SUPPLIER', 'SUBCONTRACTOR']
      if (!party || (party.companyId !== null && party.companyId !== companyId)) badBody('partyId', 'No such customer or supplier for this company.')
      if (!party!.roles.some((role) => roles.includes(role))) badBody('partyId', body.source === 'CUSTOMER' ? 'This party is not a customer or a brand.' : 'This party is not a supplier or a subcontractor.')
    }
    if ((body.source === 'SAMPLE') !== (body.sampleRoundId !== undefined)) badBody('sampleRoundId', body.source === 'SAMPLE' ? 'Say which sample round raised it.' : 'A sample round is named only for a request from a sample round.')
    if (body.sampleRoundId) {
      const round = await db.sampleRound.findUnique({ where: { id: body.sampleRoundId }, select: { styleId: true } })
      if (!round || round.styleId !== style.id) badBody('sampleRoundId', 'No such sample round of this style.')
    }
    if (body.revisionId) {
      const revision = await db.styleRevision.findUnique({ where: { id: body.revisionId }, select: { styleId: true } })
      if (!revision || revision.styleId !== style.id) badBody('revisionId', 'No such revision of this style.')
    }
    return { style, workOrder, companyId: companyId! }
  })
  if (!may(context, PRODUCT_CHANGES_REQUEST, checked.companyId)) refuseForbidden()
  const id = newId()
  await command(caller, { name: 'product.changes.raiseRequest', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const { formatted: number } = await allocateNumber(tools, { companyId: checked.companyId, kind: 'CHANGE_REQUEST' }, { type: 'ChangeRequest', id })
    const createdById = authorOf(tools)
    const data = {
      id,
      number,
      companyId: checked.companyId,
      siteId: checked.workOrder?.siteId ?? null,
      source: body.source,
      partyId: body.partyId ?? null,
      sampleRoundId: body.sampleRoundId ?? null,
      styleId: body.styleId,
      revisionId: body.revisionId ?? null,
      workOrderId: body.workOrderId ?? null,
      title: body.title,
      reason: body.reason,
      priority: body.priority ?? 'NORMAL',
      createdAt: now,
      updatedAt: now,
      createdById,
    }
    await tx.changeRequest.create({ data, select: { id: true } })
    tools.audit({ action: 'product.changes.raiseRequest', recordType: 'ChangeRequest', recordId: id, companyId: checked.companyId, siteId: data.siteId, after: { ...data, createdAt: toUtcIso(now), updatedAt: undefined } })
    if (createdById) await followInCommand(tools, { type: 'ChangeRequest', id, companyId: checked.companyId, siteId: data.siteId }, createdById, 'CREATOR', createdById)
    tools.emit({ type: 'change_request.raised', subject: id, companyId: checked.companyId, siteId: data.siteId, payload: { changeRequestId: id, number, styleId: body.styleId, source: body.source, workOrderId: data.workOrderId } })
    return { id }
  }).catch(databaseRefusal)
  return readRequest(caller, id)
}

function refuseForbidden(): never {
  throw new ForbiddenError('Your role does not raise change requests for this company (product.changes.request).')
}

/** PATCH /product/change-requests/:id */
export async function updateRequest(caller: CommandCaller, changeRequestId: string, body: UpdateRequestBody, idempotencyKey?: string): Promise<RequestView> {
  const { row: seen } = await readRequestFor(caller, changeRequestId, PRODUCT_CHANGES_REQUEST)
  const { version, ...changes } = body
  const fields = Object.keys(changes).filter((key) => changes[key as keyof typeof changes] !== undefined)
  if (fields.length === 0) badBody('version', 'Say what changes.')
  if (changes.revisionId) {
    const revision = await caller.withClient((db) => db.styleRevision.findUnique({ where: { id: changes.revisionId! }, select: { styleId: true } }))
    if (!revision || revision.styleId !== seen.styleId) badBody('revisionId', 'No such revision of this style.')
  }
  await command(caller, { name: 'product.changes.updateRequest', idempotencyKey, input: { changeRequestId, ...body }, record: { type: 'ChangeRequest', id: changeRequestId, expectedVersion: version } }, async (tools) => {
    const row = await tools.tx.changeRequest.findUniqueOrThrow({ where: { id: changeRequestId }, select: REQUEST_COLUMNS })
    refuse(requestEditRefusal(row, fields))
    const data = { ...(changes.title !== undefined ? { title: changes.title } : {}), ...(changes.reason !== undefined ? { reason: changes.reason } : {}), ...(changes.revisionId !== undefined ? { revisionId: changes.revisionId } : {}), ...(changes.priority !== undefined ? { priority: changes.priority } : {}) }
    await tools.tx.changeRequest.update({ where: { id: changeRequestId }, data, select: { id: true } })
    const before = Object.fromEntries(Object.keys(data).map((key) => [key, row[key as keyof typeof row]]))
    tools.audit({ action: 'product.changes.updateRequest', recordType: 'ChangeRequest', recordId: changeRequestId, companyId: row.companyId, siteId: row.siteId, before, after: data })
    if (row.number) tools.emit({ type: 'change_request.changed', subject: changeRequestId, companyId: row.companyId, siteId: row.siteId, payload: { changeRequestId, number: row.number, styleId: row.styleId, status: row.status, changeOrderId: row.changeOrderId, change: 'UPDATED' } })
    return null
  }).catch(databaseRefusal)
  return readRequest(caller, changeRequestId)
}

/** POST /product/change-requests/:id/move: the office's triage. */
export async function moveRequest(caller: CommandCaller, changeRequestId: string, body: MoveRequestBody, idempotencyKey?: string): Promise<RequestView> {
  const { row: seen } = await readRequestFor(caller, changeRequestId, PRODUCT_CHANGES_MANAGE)
  refuse(requestMoveRefusal(seen, body.to, body.note ?? null))
  await command(caller, { name: 'product.changes.moveRequest', idempotencyKey, input: { changeRequestId, ...body }, record: { type: 'ChangeRequest', id: changeRequestId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.changeRequest.findUniqueOrThrow({ where: { id: changeRequestId }, select: REQUEST_COLUMNS })
    refuse(requestMoveRefusal(row, body.to, body.note ?? null))
    const number = await numberIfNeeded(tools, row)
    const decided = body.to === 'IN_REVIEW' ? {} : { decidedAt: now, decidedById: authorOf(tools), decisionNote: body.note ?? null }
    await tx.changeRequest.update({ where: { id: changeRequestId }, data: { number, status: body.to, ...decided }, select: { id: true } })
    tools.audit({
      action: 'product.changes.moveRequest',
      recordType: 'ChangeRequest',
      recordId: changeRequestId,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: row.status, number: row.number },
      after: { status: body.to, number, ...(body.to === 'IN_REVIEW' ? {} : { decidedAt: toUtcIso(now), decidedById: authorOf(tools) }) },
      ...(body.note ? { reason: body.note } : {}),
    })
    tools.emit({ type: 'change_request.changed', subject: changeRequestId, companyId: row.companyId, siteId: row.siteId, payload: { changeRequestId, number, styleId: row.styleId, status: body.to, changeOrderId: row.changeOrderId, change: body.to } })
    return null
  }).catch(databaseRefusal)
  return readRequest(caller, changeRequestId)
}

/** The where of a tile (and the other filters) over what the caller may see. */
function requestWhere(caller: CommandCaller, query: RequestListQuery, tile: RequestTile): Prisma.ChangeRequestWhereInput {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCT_CHANGES_VIEW, { company: 'companyId' }) as Prisma.ChangeRequestWhereInput
  const statuses: readonly ChangeRequestStatus[] = query.status ? REQUEST_TILE_STATUSES[tile].filter((status) => status === query.status) : REQUEST_TILE_STATUSES[tile]
  return {
    AND: [
      scope,
      { status: { in: [...statuses] } },
      tile === 'ACCEPTED_FREE' ? { changeOrderId: null } : {},
      tile === 'MINE' ? { createdById: context.actorId } : {},
      query.source ? { source: query.source } : {},
      query.styleId ? { styleId: query.styleId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.changeOrderId ? { changeOrderId: query.changeOrderId } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { title: { contains: query.q, mode: 'insensitive' } }, { style: { code: { contains: query.q, mode: 'insensitive' } } }] } : {},
    ],
  }
}

const PRIORITY_RANK: Readonly<Record<string, number>> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 }

/** GET /product/change-requests: newest first (most urgent first to triage). */
export async function listRequests(caller: CommandCaller, query: RequestListQuery) {
  officeOf(caller)
  const tile = query.tile ?? 'ALL'
  const limit = query.limit ?? LIST_LIMIT
  return caller.withClient(async (db) => {
    const found = await db.changeRequest.findMany({ where: requestWhere(caller, query, tile), select: REQUEST_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const page = found.slice(0, limit)
    const rows = await requestRowsOf(db, tile === 'TO_TRIAGE' ? [...page].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)) : page)
    const counts = Object.fromEntries(await Promise.all(REQUEST_TILES.map(async (each) => [each, await db.changeRequest.count({ where: requestWhere(caller, { ...query, status: undefined }, each) })] as const)))
    return { rows, counts: counts as Record<RequestTile, number>, complete: found.length <= limit }
  })
}

const TRIAGE = ['IN_REVIEW', 'ACCEPTED', 'REJECTED'] as const

/** GET /product/change-requests/:id */
export async function readRequest(caller: CommandCaller, changeRequestId: string): Promise<RequestView> {
  const { context, row } = await readRequestFor(caller, changeRequestId)
  return caller.withClient(async (db) => {
    const [base] = await requestRowsOf(db, [row])
    const photos = await db.storedFile.findMany({
      where: { recordType: 'ChangeRequest', recordId: row.id, kind: 'PHOTO', status: 'AVAILABLE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, originalName: true, contentType: true, sizeBytes: true, availableAt: true },
    })
    const manage = may(context, PRODUCT_CHANGES_MANAGE, row.companyId)
    const moves = TRIAGE.map((to) => {
      const refusal = manage ? requestMoveRefusal(row, to, 'given') : { code: 'REQUEST_MOVE' as const, message: 'Your role does not triage change requests (product.changes.manage).' }
      return { to, allowed: refusal === null, refusal }
    })
    const workOrderSite = row.workOrderId ? await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { companyId: true, siteId: true } }) : null
    const seesWork = workOrderSite !== null && canRead(context, workOrderSite)
    const made = seesWork && row.workOrderId ? ((await madeOf(db, [row.workOrderId])).get(row.workOrderId) ?? NOTHING_MADE) : null
    return { ...base!, photosList: photos.map((photo) => ({ ...photo, availableAt: photo.availableAt ? toUtcIso(photo.availableAt) : null })), moves, made }
  })
}

/** May the office person read the work order (workorders.view at its company and site)? */
const canRead = (context: ReturnType<typeof officeOf>, place: { companyId: string; siteId: string }): boolean => can(actorOf(context), WORKORDERS_VIEW, place)

/** GET /product/change-requests/work-orders/:workOrderId: the work order's "Change request" pop-up (MES-006). */
export async function workOrderChanges(caller: CommandCaller, workOrderId: string) {
  const context = officeOf(caller)
  const workOrder = isUuid(workOrderId)
    ? await caller.withClient((db) => db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, status: true, companyId: true, siteId: true, styleId: true, styleRevisionId: true } }))
    : null
  if (!workOrder || !canRead(context, workOrder) || !may(context, PRODUCT_CHANGES_VIEW, workOrder.companyId)) throw new NotFoundError('Work order not found.')
  return caller.withClient(async (db) => {
    const style = await db.style.findUniqueOrThrow({ where: { id: workOrder.styleId }, select: { id: true, code: true, name: true } })
    const revision = workOrder.styleRevisionId ? await db.styleRevision.findUnique({ where: { id: workOrder.styleRevisionId }, select: { id: true, revision: true, status: true } }) : null
    const requests = await db.changeRequest.findMany({ where: { workOrderId }, select: REQUEST_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 })
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, companyId: workOrder.companyId, siteId: workOrder.siteId, style, revision },
      made: (await madeOf(db, [workOrderId])).get(workOrderId) ?? NOTHING_MADE,
      requests: await requestRowsOf(db, requests),
    }
  })
}
