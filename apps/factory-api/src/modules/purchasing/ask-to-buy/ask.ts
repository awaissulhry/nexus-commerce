import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { OPEN_WORK_ORDER_STATUSES } from '@nexus/factory-domain/planning/explode'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { baseFactor, convertibleUnits, QUANTITY_SCALE, type Uom } from '@nexus/factory-domain/product/units/units'
import {
  ASK_LIMITS,
  ASK_REFUSALS,
  askProblems,
  cancelProblem,
  LIVE_REQUEST_STATUSES,
  quantityOf,
  readShortage,
  rejectProblem,
  shortageSeen,
  wordsOf,
  type PurchaseRequestStatus,
  type ShortageThen,
} from '@nexus/factory-domain/purchasing/ask-to-buy/ask-to-buy'
import { PURCHASING_REQUESTS_ASK } from '@nexus/factory-domain/purchasing/ask-to-buy/permissions'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { requestIdOf } from '@nexus/factory-domain/purchasing/requests/requests'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { askApproval, withdrawPending, type AskOutcome } from '../../../platform/approvals/engine'
import { livePlanOf } from '../../planning/readiness/service'
import { shortageRows } from '../../planning/readiness/readiness'
import { SITE_COLUMNS as PLAN_SITE_COLUMNS } from '../../planning/store'
import { draftLineOf, draftLines } from '../from-plan'
import { assertMay, officeContextOf, unitsOf, type Reader } from '../store'
import { askedRaws, buildRequests } from '../requests/build'
import { markConverted } from './convert'
import { ASKED_COLUMNS, namesOf, type AskedRow } from './store'

/**
 * Ask to buy (B-W2b-332; SCM-035, SCM-037; design purchasing.requests pop-up "Ask to buy", planning.mrp "Short on open work
 * orders"): factory-db PurchaseRequest, through command() only. factory-domain purchasing/ask-to-buy holds the rules.
 *
 *   ask           purchasing.requests.ask over the site: a material we buy (active; its active colour), how much in one of
 *                 its units, by when, why, the work order (an open one of the site). Written OPEN, then the approval engine
 *                 is asked in the same command (PURCHASE_REQUEST): a switched-on rule in force that holds makes it
 *                 PENDING_APPROVAL with its task (never decided by the person who asked); none: it waits for the buyer.
 *   fromShortage  the same from a line of the shortage list (planning.view over the site too): the work order and material
 *                 must be short now (planning's live plan, the list's own reading); the quantity is what is short, by the
 *                 day it is needed (today when that has passed), the shortage kept as seen; one open request per work order
 *                 and material. then DRAFT (purchasing.manage): the request is drafted into a purchase order line at once,
 *                 in the same command, as the buyer's queue drafts it (no yes is asked: the buyer decides).
 *   cancel        the person who asked, or a buyer (purchasing.manage): an open request, or one that waits for a yes (its
 *                 request for a yes withdrawn with it), with the reason
 *   reject        a buyer (purchasing.manage over the site): an open request, with the reason
 *   list / get    one's own requests always; everybody's of the sites one reads purchasing (purchasing.view)
 *   options       what the dialog offers: the sites one may ask for, the materials we buy, the site's open work orders
 *
 * Converting is the buyer's queue (purchasing/requests: kind ASKED; ./convert `markConverted`). No money here.
 */

type Tools = CommandTools

const day = (value: Date): string => value.toISOString().slice(0, 10)
const dayValue = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

/** The caller sees the request: they asked it, or they read purchasing over its site. */
const sees = (context: OfficeContext, row: Pick<AskedRow, 'companyId' | 'siteId' | 'requestedById'>): boolean =>
  row.requestedById === context.actorId || can(actorOf(context), PURCHASING_VIEW, { companyId: row.companyId, siteId: row.siteId })

const isBuyer = (context: OfficeContext, row: Pick<AskedRow, 'companyId' | 'siteId'>): boolean => can(actorOf(context), PURCHASING_MANAGE, { companyId: row.companyId, siteId: row.siteId })

// ---- views ---------------------------------------------------------------------------------------------------------------

interface ViewFacts {
  readonly names: ReadonlyMap<string, string>
  readonly items: ReadonlyMap<string, { id: string; code: string; name: string; kind: string }>
  readonly colours: ReadonlyMap<string, { id: string; code: string; name: string }>
  readonly sites: ReadonlyMap<string, { code: string; name: string }>
  readonly orders: ReadonlyMap<string, { id: string; number: string; status: string }>
}

async function factsOf(db: Reader, rows: readonly AskedRow[]): Promise<ViewFacts> {
  const itemIds = [...new Set(rows.flatMap((row) => (row.itemId ? [row.itemId] : [])))]
  const colourIds = [...new Set(rows.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const siteIds = [...new Set(rows.map((row) => row.siteId))]
  const lineIds = [...new Set(rows.flatMap((row) => (row.purchaseOrderLineId ? [row.purchaseOrderLineId] : [])))]
  const [items, colours, sites, lines, names] = await Promise.all([
    itemIds.length ? db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, kind: true } }) : [],
    colourIds.length ? db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } }) : [],
    siteIds.length ? db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true } }) : [],
    lineIds.length ? db.purchaseOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, purchaseOrder: { select: { id: true, number: true, status: true } } } }) : [],
    namesOf(db, rows.flatMap((row) => [row.requestedById, row.rejectedById, row.convertedById])),
  ])
  return {
    names,
    items: new Map(items.map((item) => [item.id, item])),
    colours: new Map(colours.map((colour) => [colour.id, colour])),
    sites: new Map(sites.map((site) => [site.id, site])),
    orders: new Map(lines.map((line) => [line.id, line.purchaseOrder])),
  }
}

function requestView(row: AskedRow, facts: ViewFacts, context: OfficeContext) {
  const status = row.status as PurchaseRequestStatus
  const cancelWhy = cancelProblem({ status, requestedById: row.requestedById }, context.actorId, isBuyer(context, row))
  const order = row.purchaseOrderLineId ? (facts.orders.get(row.purchaseOrderLineId) ?? null) : null
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    site: facts.sites.get(row.siteId) ?? { code: '', name: '' },
    source: row.source,
    status,
    version: row.version,
    requestedBy: { id: row.requestedById, name: facts.names.get(row.requestedById) ?? '' },
    requestedAt: toUtcIso(row.requestedAt),
    mine: row.requestedById === context.actorId,
    item: row.itemId ? (facts.items.get(row.itemId) ?? null) : null,
    colour: row.itemColourId ? (facts.colours.get(row.itemColourId) ?? null) : null,
    description: row.description,
    quantity: row.quantity.toFixed(QUANTITY_SCALE),
    uom: row.uom,
    needDate: day(row.needDate),
    reason: row.reason,
    workOrder: row.workOrder ? { id: row.workOrder.id, number: row.workOrder.number } : null,
    shortage: readShortage(row.shortage),
    approvalTaskId: row.approvalTaskId,
    rejected: row.rejectedAt ? { at: toUtcIso(row.rejectedAt), by: facts.names.get(row.rejectedById ?? '') ?? '', reason: row.rejectReason ?? '' } : null,
    converted: row.convertedAt ? { at: toUtcIso(row.convertedAt), by: facts.names.get(row.convertedById ?? '') ?? '', purchaseOrder: order as { id: string; number: string; status: never } | null } : null,
    cancelled: row.cancelledAt ? { at: toUtcIso(row.cancelledAt), reason: row.cancelReason ?? '' } : null,
    cancel: { allowed: cancelWhy === null, why: cancelWhy },
  }
}

async function viewsOf(db: Reader, rows: readonly AskedRow[], context: OfficeContext) {
  const facts = await factsOf(db, rows)
  return rows.map((row) => requestView(row, facts, context))
}

const approvalOf = (outcome: AskOutcome | null) =>
  outcome && outcome.asked
    ? { asked: true, taskId: outcome.taskId, approverRoleId: outcome.approverRoleId, approverUserId: outcome.approverUserId, dueAt: outcome.dueAt }
    : { asked: false, taskId: null, approverRoleId: null, approverUserId: null, dueAt: null }

// ---- checks ----------------------------------------------------------------------------------------------------------------

async function siteToAsk(tools: Tools, context: OfficeContext, siteId: string) {
  const site = await tools.tx.site.findUnique({ where: { id: siteId }, select: PLAN_SITE_COLUMNS })
  if (!site || site.status !== 'ACTIVE' || !can(actorOf(context), PURCHASING_REQUESTS_ASK, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  return site
}

interface Asked {
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
  readonly description?: string | null | undefined
  readonly quantity: string
  readonly uom: Uom
  readonly needDate: BusinessDate
  readonly reason: string
  readonly workOrderId?: string | null | undefined
}

/** What is asked, checked as the database will (and in words before it): material, colour, unit, work order. */
async function checkAsked(tools: Tools, site: { id: string; companyId: string }, asked: Asked, today: BusinessDate): Promise<{ quantity: string; reason: string; description: string | null }> {
  const problems = askProblems(asked, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const item = await tools.tx.item.findUnique({ where: { id: asked.itemId }, select: { id: true, companyId: true, kind: true, status: true, baseUom: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true } })
  if (!item || (item.companyId !== null && item.companyId !== site.companyId) || item.kind === 'FINISHED') throw new ValidationError(ASK_REFUSALS.NOT_A_MATERIAL, [{ path: 'body/itemId', message: ASK_REFUSALS.NOT_A_MATERIAL }])
  if (item.status !== 'ACTIVE') throw new ValidationError(ASK_REFUSALS.MATERIAL_ARCHIVED, [{ path: 'body/itemId', message: ASK_REFUSALS.MATERIAL_ARCHIVED }])
  if (asked.itemColourId) {
    const colour = await tools.tx.itemColour.findFirst({ where: { id: asked.itemColourId, itemId: item.id, status: 'ACTIVE' }, select: { id: true } })
    if (!colour) throw new ValidationError(ASK_REFUSALS.COLOUR_NOT_OURS, [{ path: 'body/itemColourId', message: ASK_REFUSALS.COLOUR_NOT_OURS }])
  }
  const factor = baseFactor(asked.uom, unitsOf(item))
  if (factor === null || factor.lte(0)) throw new ValidationError(ASK_REFUSALS.UNIT_NOT_CONVERTED, [{ path: 'body/uom', message: ASK_REFUSALS.UNIT_NOT_CONVERTED }])
  if (asked.workOrderId) {
    const order = await tools.tx.workOrder.findFirst({ where: { id: asked.workOrderId, siteId: site.id, status: { in: [...OPEN_WORK_ORDER_STATUSES] } }, select: { id: true } })
    if (!order) throw new ValidationError(ASK_REFUSALS.WORK_ORDER_GONE, [{ path: 'body/workOrderId', message: ASK_REFUSALS.WORK_ORDER_GONE }])
  }
  const description = asked.description?.trim() ? asked.description.trim() : null
  return { quantity: quantityOf(asked.quantity)!, reason: asked.reason.trim(), description }
}

/** Writes the request OPEN and asks the engine; PENDING_APPROVAL with the task when a rule holds. */
async function writeRequest(
  tools: Tools,
  context: OfficeContext,
  data: Omit<Prisma.PurchaseRequestUncheckedCreateInput, 'id' | 'tenantId' | 'requestedById' | 'requestedAt' | 'status' | 'createdAt' | 'updatedAt' | 'createdById' | 'version'>,
  approval: { ask: boolean; note: string | null },
): Promise<{ id: string; outcome: AskOutcome | null }> {
  const id = newId()
  await tools.tx.purchaseRequest.create({ data: { ...data, id, requestedById: context.actorId, requestedAt: tools.now, status: 'OPEN', createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId } })
  let outcome: AskOutcome | null = null
  if (approval.ask) {
    outcome = await askApproval(tools, { kind: 'PURCHASE_REQUEST', recordId: id, requester: { userId: context.actorId }, note: approval.note })
    if (outcome.asked) await tools.tx.purchaseRequest.update({ where: { id }, data: { status: 'PENDING_APPROVAL', approvalTaskId: outcome.taskId, version: { increment: 1 }, updatedAt: tools.now } })
  }
  const status = outcome?.asked ? 'PENDING_APPROVAL' : 'OPEN'
  tools.audit({ action: 'purchasing.askToBuy.asked', recordType: 'PurchaseRequest', recordId: id, companyId: data.companyId, siteId: data.siteId, after: { status, source: data.source, itemId: data.itemId, itemColourId: data.itemColourId ?? null, quantity: data.quantity, uom: data.uom, needDate: day(data.needDate as Date), workOrderId: data.workOrderId ?? null, approvalTaskId: outcome?.asked ? outcome.taskId : null } })
  tools.emit({
    type: 'purchase_requests.asked',
    subject: id,
    companyId: data.companyId,
    siteId: data.siteId,
    payload: { purchaseRequestId: id, siteId: data.siteId, source: data.source as 'OFFICE' | 'SHORTAGE', status, workOrderId: data.workOrderId ?? null, approvalTaskId: outcome?.asked ? outcome.taskId : null, requestedById: context.actorId },
  })
  return { id, outcome }
}

const readOne = async (db: Reader, id: string): Promise<AskedRow> => {
  const row = await db.purchaseRequest.findUnique({ where: { id }, select: ASKED_COLUMNS })
  if (!row) throw new NotFoundError('Request not found.')
  return row
}

// ---- the commands ------------------------------------------------------------------------------------------------------------

export interface AskInput extends Asked {
  readonly siteId: string
  readonly note?: string | null | undefined
}

/** "Send request" (POST /purchasing/ask-to-buy). */
export async function askToBuy(caller: CommandCaller, body: AskInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const { result } = await command(caller, { name: 'purchasing.askToBuy', idempotencyKey, input: body }, async (tools) => {
    const site = await siteToAsk(tools, context, body.siteId)
    const checked = await checkAsked(tools, site, body, businessDate(tools.now, site.timezone))
    const { id, outcome } = await writeRequest(
      tools,
      context,
      { companyId: site.companyId, siteId: site.id, source: 'OFFICE', itemId: body.itemId, itemColourId: body.itemColourId ?? null, description: checked.description, quantity: checked.quantity, uom: body.uom, needDate: dayValue(body.needDate), reason: checked.reason, workOrderId: body.workOrderId ?? null },
      { ask: true, note: body.note?.trim() ? body.note.trim() : null },
    )
    const [view] = await viewsOf(tools.tx, [await readOne(tools.tx, id)], context)
    return { request: view!, approval: approvalOf(outcome) }
  })
  return result
}

export interface FromShortageInput {
  readonly siteId: string
  readonly workOrderId: string
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
  readonly reason: string
  readonly then: ShortageThen
  readonly supplierId?: string | undefined
  readonly purchaseOrderId?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A line of the shortage list asked, or drafted into a purchase order at once (POST /purchasing/ask-to-buy/from-shortage). */
export async function askFromShortage(caller: CommandCaller, body: FromShortageInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const { result } = await command(caller, { name: 'purchasing.askToBuyFromShortage', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const site = await siteToAsk(tools, context, body.siteId)
    if (!can(actor, PLANNING_VIEW, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError('Reading the shortage list needs planning (planning.view) at this site.')
    if (body.then === 'DRAFT' && !can(actor, PURCHASING_MANAGE, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError('Drafting a purchase order needs purchasing.manage: send it to the buyers instead.')
    const colourId = body.itemColourId ?? null
    // One open request per work order and material: the second asker waits for the first one's lock and finds it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ask-shortage', ${context.tenantId}::uuid, ${body.workOrderId}::text, ${body.itemId}::text, ${colourId ?? '-'}::text), 0))`
    const live = await livePlanOf(tx, site)
    const row = (await shortageRows(tx, live)).find((entry) => entry.workOrder.id === body.workOrderId && entry.material.itemId === body.itemId && entry.material.itemColourId === colourId)
    if (!row) throw new ConflictError(ASK_REFUSALS.SHORTAGE_GONE)
    const open = await tx.purchaseRequest.findFirst({ where: { source: 'SHORTAGE', workOrderId: body.workOrderId, itemId: body.itemId, itemColourId: colourId, status: { in: [...LIVE_REQUEST_STATUSES] } }, select: { id: true } })
    if (open) throw new ConflictError(ASK_REFUSALS.SHORTAGE_ASKED)
    const needDate = row.neededBy < live.today ? live.today : row.neededBy
    const checked = await checkAsked(tools, site, { itemId: body.itemId, itemColourId: colourId, quantity: row.short, uom: row.material.uom as Uom, needDate, reason: body.reason, workOrderId: body.workOrderId }, live.today)
    const shortage = shortageSeen({ word: row.word as 'NOT_ENOUGH' | 'DELAYED', short: row.short, uom: row.material.uom, needDate: row.neededBy, runId: live.latestRun?.id ?? null, workOrderNumber: row.workOrder.number })
    const { id, outcome } = await writeRequest(
      tools,
      context,
      { companyId: site.companyId, siteId: site.id, source: 'SHORTAGE', itemId: body.itemId, itemColourId: colourId, description: null, quantity: checked.quantity, uom: row.material.uom as Uom, needDate: dayValue(needDate), reason: checked.reason, workOrderId: body.workOrderId, shortage: shortage as Prisma.InputJsonObject },
      { ask: body.then === 'REQUEST', note: body.note?.trim() ? body.note.trim() : null },
    )
    let draft: { purchaseOrderId: string; number: string; created: boolean; purchaseOrderLineId: string } | null = null
    if (body.then === 'DRAFT') {
      const [built] = await buildRequests(tx, await askedRaws(tx, { id }), { today: live.today, choices: body.supplierId ? new Map([[requestIdOf('ASKED', id), { supplierId: body.supplierId }]]) : undefined, triggeredOnly: false })
      if (!built) throw new NotFoundError('Request not found.')
      if (built.supplier) assertMay(context, PURCHASING_MANAGE, { companyId: built.companyId, siteId: built.siteId, partyId: built.supplier.id }, 'Request')
      const line = draftLineOf(built, 'body', { requestId: built.id, kind: 'ASKED', refId: id, quantityFrom: built.quantityFrom, sourceId: built.source?.id ?? null, fromShortage: true })
      const into = body.supplierId && body.purchaseOrderId !== undefined ? [{ supplierId: built.supplier!.id, siteId: built.siteId, purchaseOrderId: body.purchaseOrderId }] : []
      const { orders, made } = await draftLines(tools, context, [line], into, 'purchasing.convertRequests')
      await markConverted(tools, context, [built], made)
      const order = orders[0]!
      draft = { purchaseOrderId: order.id, number: order.number, created: order.created, purchaseOrderLineId: made[0]!.purchaseOrderLineId }
      tools.emit({ type: 'purchase_requests.converted', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, created: order.created, requests: 1, fromPlan: 0, fromReorder: 0 } })
    }
    const [view] = await viewsOf(tx, [await readOne(tx, id)], context)
    return { request: view!, approval: body.then === 'REQUEST' ? approvalOf(outcome) : null, draft }
  })
  return result
}

export interface ManyInput {
  readonly requests: readonly { readonly id: string; readonly version: number }[]
  readonly reason: string
}

const idsOf = (body: ManyInput): string[] => {
  const ids = body.requests.map((request) => request.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A request is listed twice.', [{ path: 'body/requests', message: 'Each request once.' }])
  return ids
}

/** Take requests back (POST /purchasing/ask-to-buy/cancel): one's own, or any as a buyer. */
export async function cancelRequests(caller: CommandCaller, body: ManyInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const reason = wordsOf(body.reason)
  if (!reason) throw new ValidationError('Say why it is taken back.', [{ path: 'body/reason', message: 'Say why it is taken back.' }])
  idsOf(body)
  const { result } = await command(caller, { name: 'purchasing.askToBuyCancel', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const done: string[] = []
    for (const [index, asked] of [...body.requests].map((entry, at) => [at, entry] as const).sort((a, b) => (a[1].id < b[1].id ? -1 : 1))) {
      await tx.$queryRaw`SELECT 1 FROM "PurchaseRequest" WHERE id = ${asked.id}::uuid FOR UPDATE`
      const row = await tx.purchaseRequest.findUnique({ where: { id: asked.id }, select: ASKED_COLUMNS })
      if (!row || !sees(context, row)) throw new NotFoundError('Request not found.')
      const why = cancelProblem({ status: row.status as PurchaseRequestStatus, requestedById: row.requestedById }, context.actorId, isBuyer(context, row))
      if (why) throw new ConflictError(why)
      if (row.version !== asked.version) throw new ConflictError(`This request changed since it was read (body/requests/${index}): read it again.`)
      await tx.purchaseRequest.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason, version: { increment: 1 }, updatedAt: tools.now } })
      // Its request for a yes goes with it (the kind's hook finds the request taken back and does nothing more).
      if (row.status === 'PENDING_APPROVAL') await withdrawPending(tools, { kind: 'PURCHASE_REQUEST', recordId: row.id, byId: row.requestedById === context.actorId ? context.actorId : null, words: reason })
      tools.audit({ action: 'purchasing.askToBuy.cancelled', recordType: 'PurchaseRequest', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'CANCELLED' }, reason })
      tools.emit({ type: 'purchase_requests.status_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { purchaseRequestId: row.id, siteId: row.siteId, from: row.status as PurchaseRequestStatus, to: 'CANCELLED', purchaseOrderId: null, requestedById: row.requestedById } })
      done.push(row.id)
    }
    const rows = await tx.purchaseRequest.findMany({ where: { id: { in: done } }, select: ASKED_COLUMNS, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }] })
    return { requests: await viewsOf(tx, rows, context) }
  })
  return result
}

/** Refuse requests with the reason (POST /purchasing/ask-to-buy/reject): a buyer over each request's site. */
export async function rejectRequests(caller: CommandCaller, body: ManyInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const reason = wordsOf(body.reason)
  if (!reason) throw new ValidationError('Say why it is refused.', [{ path: 'body/reason', message: 'Say why it is refused.' }])
  idsOf(body)
  const { result } = await command(caller, { name: 'purchasing.askToBuyReject', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const done: string[] = []
    for (const [index, asked] of [...body.requests].map((entry, at) => [at, entry] as const).sort((a, b) => (a[1].id < b[1].id ? -1 : 1))) {
      await tx.$queryRaw`SELECT 1 FROM "PurchaseRequest" WHERE id = ${asked.id}::uuid FOR UPDATE`
      const row = await tx.purchaseRequest.findUnique({ where: { id: asked.id }, select: ASKED_COLUMNS })
      if (!row || !sees(context, row)) throw new NotFoundError('Request not found.')
      if (!isBuyer(context, row)) throw new ForbiddenError('Refusing a request is the buyer’s (purchasing.manage).')
      const why = rejectProblem(row.status as PurchaseRequestStatus)
      if (why) throw new ConflictError(why)
      if (row.version !== asked.version) throw new ConflictError(`This request changed since it was read (body/requests/${index}): read it again.`)
      await tx.purchaseRequest.update({ where: { id: row.id }, data: { status: 'REJECTED', rejectedAt: tools.now, rejectedById: context.actorId, rejectReason: reason, version: { increment: 1 }, updatedAt: tools.now } })
      tools.audit({ action: 'purchasing.askToBuy.rejected', recordType: 'PurchaseRequest', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'REJECTED' }, reason })
      tools.emit({ type: 'purchase_requests.status_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { purchaseRequestId: row.id, siteId: row.siteId, from: 'OPEN', to: 'REJECTED', purchaseOrderId: null, requestedById: row.requestedById } })
      done.push(row.id)
    }
    const rows = await tx.purchaseRequest.findMany({ where: { id: { in: done } }, select: ASKED_COLUMNS, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }] })
    return { requests: await viewsOf(tx, rows, context) }
  })
  return result
}

// ---- the reads -----------------------------------------------------------------------------------------------------------------

export interface ListInput {
  readonly status: 'LIVE' | 'ALL' | PurchaseRequestStatus
  readonly mine?: boolean | undefined
  readonly siteId?: string | undefined
  readonly source?: 'OFFICE' | 'SHORTAGE' | undefined
  readonly workOrderId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** One's own requests, and everybody's of the sites one reads purchasing (newest first; a cursor of ids). */
export async function listAsked(caller: CommandCaller, query: ListInput) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    // Everybody's where one reads purchasing (an empty scope is every row: Prisma drops an empty object from an OR).
    const reach = scopeWhere(actor, PURCHASING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.PurchaseRequestWhereInput
    const visible: Prisma.PurchaseRequestWhereInput = query.mine ? { requestedById: context.actorId } : Object.keys(reach).length === 0 ? {} : { OR: [{ requestedById: context.actorId }, reach] }
    const status: Prisma.PurchaseRequestWhereInput = query.status === 'ALL' ? {} : query.status === 'LIVE' ? { status: { in: [...LIVE_REQUEST_STATUSES] } } : { status: query.status }
    const where: Prisma.PurchaseRequestWhereInput = {
      AND: [visible, status, query.siteId ? { siteId: query.siteId } : {}, query.source ? { source: query.source } : {}, query.workOrderId ? { workOrderId: query.workOrderId } : {}, query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}],
    }
    const rows = await db.purchaseRequest.findMany({ where, select: ASKED_COLUMNS, orderBy: [{ id: 'desc' }], take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    return { asOf: toUtcIso(serverClock.now()), requests: await viewsOf(db, page, context), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
  })
}

/** One request with its request for a yes (GET /purchasing/ask-to-buy/:requestId). */
export async function getAsked(caller: CommandCaller, requestId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const row = isUuid(requestId) ? await db.purchaseRequest.findUnique({ where: { id: requestId }, select: ASKED_COLUMNS }) : null
    if (!row || !sees(context, row)) throw new NotFoundError('Request not found.')
    const [view] = await viewsOf(db, [row], context)
    const task = row.approvalTaskId
      ? await db.approvalTask.findUnique({ where: { id: row.approvalTaskId }, select: { id: true, status: true, approverRoleId: true, approverUserId: true, requestedAt: true, dueAt: true, decidedAt: true, decidedById: true } })
      : null
    let approval = null
    if (task) {
      const people = await namesOf(db, [task.approverUserId, task.decidedById])
      const role = task.approverRoleId ? await db.role.findUnique({ where: { id: task.approverRoleId }, select: { name: true } }) : null
      approval = {
        id: task.id,
        status: task.status,
        approver: task.approverUserId ? (people.get(task.approverUserId) ?? null) : (role?.name ?? null),
        requestedAt: toUtcIso(task.requestedAt),
        dueAt: task.dueAt ? toUtcIso(task.dueAt) : null,
        decidedAt: task.decidedAt ? toUtcIso(task.decidedAt) : null,
        decidedBy: task.decidedById ? (people.get(task.decidedById) ?? null) : null,
      }
    }
    return { request: view!, approval }
  })
}

/** What the dialog offers (GET /purchasing/ask-to-buy/options). */
export async function askOptions(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly q?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const sites = (await db.site.findMany({ where: { status: 'ACTIVE' }, select: { id: true, companyId: true, code: true, name: true, timezone: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })).filter((site) =>
      can(actor, PURCHASING_REQUESTS_ASK, { companyId: site.companyId, siteId: site.id }),
    )
    const site = (query.siteId ? sites.find((entry) => entry.id === query.siteId) : sites[0]) ?? null
    if (query.siteId && !site) throw new NotFoundError('Site not found.')
    const q = query.q?.toLowerCase()
    const materials = site
      ? await db.item.findMany({
          where: { status: 'ACTIVE', kind: { not: 'FINISHED' }, OR: [{ companyId: null }, { companyId: site.companyId }], ...(q ? { AND: [{ OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }] } : {}) },
          select: { id: true, code: true, name: true, kind: true, baseUom: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true, colours: { where: { status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] } },
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
          take: ASK_LIMITS.options + 1,
        })
      : []
    const workOrders = site
      ? await db.workOrder.findMany({ where: { siteId: site.id, status: { in: [...OPEN_WORK_ORDER_STATUSES] } }, select: { id: true, number: true, dueDate: true, style: { select: { code: true } } }, orderBy: [{ number: 'desc' }, { id: 'desc' }], take: ASK_LIMITS.options })
      : []
    return {
      sites: sites.map((entry) => ({ id: entry.id, companyId: entry.companyId, code: entry.code, name: entry.name })),
      siteId: site?.id ?? null,
      today: businessDate(serverClock.now(), site?.timezone),
      materials: materials.slice(0, ASK_LIMITS.options).map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        kind: item.kind,
        baseUom: item.baseUom,
        purchaseUom: item.purchaseUom,
        units: convertibleUnits(unitsOf(item)),
        colours: item.colours,
      })),
      workOrders: workOrders.map((order) => ({ id: order.id, number: order.number, style: order.style?.code ?? null, dueDate: order.dueDate ? day(order.dueDate) : null })),
      more: materials.length > ASK_LIMITS.options,
    }
  })
}
