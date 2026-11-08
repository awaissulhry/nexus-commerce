import type { Issue } from '@nexus/factory-domain/core/errors'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { isLengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { PRODUCTION_CUTORDERS_MANAGE } from '@nexus/factory-domain/production/cutorders/permissions'
import {
  cellFullRefusal,
  cellLeft,
  fabricGarments,
  planProblems,
  releaseRefusal,
  notPlanned,
  workOrderRefusal,
  type CutOrderKind,
  type CutOrderStatus,
  type LineDraft,
  type MarkerDraft,
} from '@nexus/factory-domain/production/cutorders/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { invalid, may, notFound, officeOf, refuse } from './access'
import { recordOf } from './read'
import { garmentsElsewhere, lockCells, readCells, readCutOrder, readLays, readLines, readTickets, type CutOrderRow } from './store'
import { emitOrder, emitTicket } from './emit'

/**
 * Planning cut orders (B-W2b-112; MES-034; design production.cutting pop "New cut order", the Cut record's head): the office
 * (production.cutorders.manage over the site's company and site) plans a cut order of work orders' cells of ONE material and
 * colour, re-plans it while it is PLANNED, releases it (its tickets are made: one per lay of a fabric cut order, one for a leather
 * one), sends it back to planning while no ticket was scanned (its OPEN tickets voided, the rolls allocated to its lays taken
 * off), or cancels it while nothing was started at a table. Each is ONE command at the cut order's version, audited, with
 * cut_order.changed (and cut_ticket.changed per ticket made or voided). The database's …_cutting_room_w2b_guards hold the same rules.
 *
 * The cells: a cell of a released or running work order of the cut order's site (not on hold) that takes the material (and the
 * colour) in its planned materials, at most once per cut order, and never more garments than live cut orders of the material
 * leave of it (the cells' advisory locks, in id order, make two plans of one cell take turns).
 */

export interface PlanBody {
  readonly stationId?: string | null | undefined
  readonly dueDate?: string | null | undefined
  readonly note?: string | null | undefined
  readonly marker?: MarkerDraft | null | undefined
  readonly plies?: number | undefined
  readonly lays?: readonly number[] | undefined
  readonly lines: readonly LineDraft[]
}

export interface CreateBody extends PlanBody {
  readonly siteId: string
  readonly kind: CutOrderKind
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
}

export interface ReplanBody extends PlanBody {
  readonly version: number
}

const text = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}
const dayOf = (value: string | null | undefined): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null)

interface Material {
  readonly companyId: string
  readonly siteId: string
  readonly kind: CutOrderKind
  readonly itemId: string
  readonly itemColourId: string | null
}

/** The plan's problems that need the database: the station, the marker's file (paths relative to the body). */
async function placeProblems(tx: CommandTx, material: Material, body: PlanBody): Promise<Issue[]> {
  const problems: Issue[] = []
  if (body.stationId) {
    const station = await tx.station.findUnique({ where: { id: body.stationId }, select: { siteId: true, status: true } })
    if (!station || station.siteId !== material.siteId) problems.push({ path: 'stationId', message: "The cutting table is a station of the cut order's site." })
  }
  const fileId = body.marker?.fileId
  if (fileId && !(await tx.storedFile.findUnique({ where: { id: fileId }, select: { id: true } }))) problems.push({ path: 'marker/fileId', message: 'The marker file is not found.' })
  return problems
}

/** The lines as rows to insert, every cell checked against the work orders and what live cut orders leave of it. */
async function checkedLines(tx: CommandTx, context: OfficeContext, material: Material, cutOrderId: string | null, body: PlanBody) {
  const cellIds = body.lines.map((line) => line.workOrderSizeId)
  await lockCells(tx, context.tenantId, cellIds)
  const cells = new Map((await readCells(tx, cellIds, material)).map((cell) => [cell.id, cell]))
  const elsewhere = await garmentsElsewhere(tx, material, cellIds, cutOrderId)
  const problems: Issue[] = []
  const rows = body.lines.map((line, index) => {
    const cell = cells.get(line.workOrderSizeId)
    if (!cell || !may(context, PRODUCTION_CUTTING_VIEW, cell.workOrder)) {
      problems.push({ path: `lines/${index}/workOrderSizeId`, message: 'The work order cell is not found.' })
      return null
    }
    if (cell.workOrder.siteId !== material.siteId) refuse({ code: 'WORK_ORDER_OTHER_SITE', message: `Work order ${cell.workOrder.number} is made at another site: a cut order cuts the work orders of its own site.` })
    const refusal = workOrderRefusal(cell.workOrder)
    if (refusal) refuse(refusal)
    if (cell.materials.length === 0) {
      refuse({ code: 'NOT_THE_MATERIAL', message: `${cell.workOrder.number} ${cell.colourway.code} ${cell.size} does not take this material${material.itemColourId ? ' in this colour' : ''}: a cut order groups work orders of one material and colour.` })
    }
    const quantity = body.plies !== undefined && line.ratio !== undefined ? fabricGarments(line.ratio, body.plies) : (line.quantity ?? 0)
    const others = elsewhere.get(cell.id) ?? 0
    if (quantity > cellLeft(cell.quantity, others)) refuse(cellFullRefusal({ workOrderNumber: cell.workOrder.number, size: cell.size, colourway: cell.colourway.code, quantity: cell.quantity, elsewhere: others }, quantity))
    return {
      seq: (index + 1) * 10,
      workOrderId: cell.workOrderId,
      workOrderSizeId: cell.id,
      quantity,
      ratio: material.kind === 'FABRIC' ? (line.ratio ?? null) : null,
      plies: material.kind === 'FABRIC' ? (body.plies ?? null) : null,
    }
  })
  if (problems.length > 0) invalid(problems, 'Some cells are not found.')
  return rows.filter((row): row is NonNullable<typeof row> => row !== null)
}

/** The marker's columns from the body (none for leather). */
function markerColumns(kind: CutOrderKind, marker: MarkerDraft | null | undefined) {
  if (kind === 'LEATHER' || !marker) return { markerName: null, markerLength: null, markerUom: null, markerWidthCm: null, markerFileId: null }
  return {
    markerName: marker.name.trim(),
    markerLength: marker.length.trim(),
    markerUom: marker.uom,
    markerWidthCm: text(marker.widthCm),
    markerFileId: marker.fileId ?? null,
  }
}

/** POST /production/cut-orders: a new cut order, PLANNED, numbered from the company's CUT_ORDER series. */
export async function createCutOrder(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = planProblems(body)
  if (problems.length > 0) invalid(problems, 'The cut order is not valid.')
  const facts = await caller.withClient(async (db) => {
    const site = isUuid(body.siteId) ? await db.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true } }) : null
    const item = isUuid(body.itemId) ? await db.item.findUnique({ where: { id: body.itemId }, select: { id: true, code: true, tracking: true, baseUom: true } }) : null
    const colour = body.itemColourId && isUuid(body.itemColourId) ? await db.itemColour.findUnique({ where: { id: body.itemColourId }, select: { id: true, itemId: true } }) : null
    return { site, item, colour }
  })
  if (!facts.site || !may(context, PRODUCTION_CUTTING_VIEW, { companyId: facts.site.companyId, siteId: facts.site.id })) return notFound('Site')
  if (!may(context, PRODUCTION_CUTORDERS_MANAGE, { companyId: facts.site!.companyId, siteId: facts.site!.id })) throw new ForbiddenError('Planning cut orders needs production.cutorders.manage at the site.')
  if (!facts.item) invalid([{ path: 'itemId', message: 'The material is not found.' }], 'The material is not found.')
  if (body.itemColourId && (!facts.colour || facts.colour.itemId !== body.itemId)) invalid([{ path: 'itemColourId', message: "Not a colour of the material." }], "Not a colour of the material.")
  const item = facts.item!
  const fits = body.kind === 'LEATHER' ? item.tracking === 'HIDE' : item.tracking === 'LOT' && isLengthUom(item.baseUom)
  if (!fits) {
    refuse({
      code: 'NOT_A_CUT_MATERIAL',
      message: `${item.code} is ${item.tracking === 'HIDE' ? 'leather tracked by hide' : item.tracking === 'LOT' ? `tracked by lot in ${item.baseUom}` : `tracked by ${item.tracking}`}: a ${body.kind === 'LEATHER' ? 'leather cut order cuts hides' : 'fabric cut order cuts a fabric counted by length'}.`,
    })
  }
  const material: Material = { companyId: facts.site!.companyId, siteId: facts.site!.id, kind: body.kind, itemId: item.id, itemColourId: body.itemColourId ?? null }
  const cutOrderId = newId()

  const { result } = await command(caller, { name: 'production.planCutOrder', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const placeIssues = await placeProblems(tx, material, body)
    if (placeIssues.length > 0) invalid(placeIssues, 'The cut order is not valid.')
    const lines = await checkedLines(tx, context, material, null, body)
    const issued = await allocateNumber(tools, { companyId: material.companyId, kind: 'CUT_ORDER' }, { type: 'CutOrder', id: cutOrderId })
    await tx.cutOrder.create({
      data: {
        id: cutOrderId,
        companyId: material.companyId,
        siteId: material.siteId,
        number: issued.formatted,
        kind: material.kind,
        itemId: material.itemId,
        itemColourId: material.itemColourId,
        stationId: body.stationId ?? null,
        ...markerColumns(material.kind, body.marker),
        dueDate: dayOf(body.dueDate),
        note: text(body.note),
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    await tx.cutOrderLine.createMany({ data: lines.map((line) => ({ id: newId(), siteId: material.siteId, cutOrderId, ...line, createdAt: now, updatedAt: now, createdById: context.actorId })) })
    const lays = material.kind === 'FABRIC' ? (body.lays ?? [body.plies!]) : []
    if (lays.length > 0) {
      await tx.lay.createMany({ data: lays.map((plies, index) => ({ id: newId(), siteId: material.siteId, cutOrderId, seq: index + 1, plies, createdAt: now, updatedAt: now, createdById: context.actorId })) })
    }
    const order = (await readCutOrder(tx, cutOrderId))!
    tools.audit({
      action: 'production.planCutOrder',
      recordType: 'CutOrder',
      recordId: cutOrderId,
      companyId: material.companyId,
      siteId: material.siteId,
      after: { number: order.number, kind: order.kind, itemId: order.itemId, itemColourId: order.itemColourId, marker: order.markerName, plies: body.plies ?? null, lays, lines: lines.map((line) => ({ workOrderSizeId: line.workOrderSizeId, quantity: line.quantity, ratio: line.ratio })) },
    })
    emitOrder(tools, order, 'PLANNED', lines.map((line) => line.workOrderId))
    return recordOf(tx, context, order)
  })
  return result
}

/** The cut order the office manages, read as the caller; 404 when it does not see it, 403 without manage. */
async function managedOrder(caller: CommandCaller, cutOrderId: string): Promise<{ context: OfficeContext; order: CutOrderRow }> {
  const context = officeOf(caller)
  const order = await caller.withClient((db) => readCutOrder(db, cutOrderId))
  if (!order || !may(context, PRODUCTION_CUTTING_VIEW, order)) return notFound('Cut order')
  if (!may(context, PRODUCTION_CUTORDERS_MANAGE, order!)) throw new ForbiddenError('Planning cut orders needs production.cutorders.manage at the site.')
  return { context, order: order! }
}

/** The order inside the command, after its version bump: its status as it is now. */
async function currentOrder(tx: CommandTx, cutOrderId: string): Promise<CutOrderRow> {
  return (await readCutOrder(tx, cutOrderId))!
}

/** PUT /production/cut-orders/:cutOrderId: the whole plan again while PLANNED (lines, marker, plies and lays, table, due, note). */
export async function replanCutOrder(caller: CommandCaller, cutOrderId: string, body: ReplanBody, idempotencyKey?: string) {
  const { context, order } = await managedOrder(caller, cutOrderId)
  const kind = order.kind as CutOrderKind
  const problems = planProblems({ ...body, kind })
  if (problems.length > 0) invalid(problems, 'The cut order is not valid.')
  if (order.status !== 'PLANNED') refuse(notPlanned(order.number, order.status as CutOrderStatus))
  const material: Material = { companyId: order.companyId, siteId: order.siteId, kind, itemId: order.itemId, itemColourId: order.itemColourId }

  const { result } = await command(caller, { name: 'production.replanCutOrder', idempotencyKey, input: { cutOrderId, ...body }, record: { type: 'CutOrder', id: cutOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const before = await currentOrder(tx, cutOrderId)
    if (before.status !== 'PLANNED') refuse(notPlanned(before.number, before.status as CutOrderStatus))
    const placeIssues = await placeProblems(tx, material, body)
    if (placeIssues.length > 0) invalid(placeIssues, 'The cut order is not valid.')
    const oldLines = await readLines(tx, [cutOrderId])
    const lines = await checkedLines(tx, context, material, cutOrderId, body)
    await tx.cutOrderLine.deleteMany({ where: { cutOrderId } })
    await tx.cutOrderLine.createMany({ data: lines.map((line) => ({ id: newId(), siteId: material.siteId, cutOrderId, ...line, createdAt: now, updatedAt: now, createdById: context.actorId })) })
    // The lays follow the new split: the planned ones take the new plies in order, more are added, the rest are cancelled.
    if (kind === 'FABRIC') {
      const wanted = body.lays ?? [body.plies!]
      const lays = (await readLays(tx, [cutOrderId])).filter((lay) => lay.status !== 'CANCELLED')
      const next = Math.max(0, ...(await readLays(tx, [cutOrderId])).map((lay) => lay.seq)) + 1
      for (const [index, plies] of wanted.entries()) {
        const lay = lays[index]
        if (lay && lay.plies !== plies) await tx.lay.update({ where: { id: lay.id }, data: { plies, updatedAt: now }, select: { id: true } })
        if (!lay) await tx.lay.create({ data: { id: newId(), siteId: material.siteId, cutOrderId, seq: next + index - lays.length, plies, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      }
      for (const lay of lays.slice(wanted.length)) {
        await tx.lay.update({ where: { id: lay.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: `Re-planned in ${wanted.length} ${wanted.length === 1 ? 'lay' : 'lays'}`, updatedAt: now }, select: { id: true } })
      }
    }
    await tx.cutOrder.update({
      where: { id: cutOrderId },
      data: { stationId: body.stationId ?? null, dueDate: dayOf(body.dueDate), note: text(body.note), ...markerColumns(kind, body.marker), updatedAt: now },
      select: { id: true },
    })
    const after = await currentOrder(tx, cutOrderId)
    tools.audit({
      action: 'production.replanCutOrder',
      recordType: 'CutOrder',
      recordId: cutOrderId,
      companyId: order.companyId,
      siteId: order.siteId,
      before: { marker: before.markerName, lines: oldLines.map((line) => ({ workOrderSizeId: line.workOrderSizeId, quantity: line.quantity, ratio: line.ratio, plies: line.plies })) },
      after: { marker: after.markerName, plies: body.plies ?? null, lays: kind === 'FABRIC' ? (body.lays ?? [body.plies!]) : [], lines: lines.map((line) => ({ workOrderSizeId: line.workOrderSizeId, quantity: line.quantity, ratio: line.ratio, plies: line.plies })) },
    })
    emitOrder(tools, after, 'PLAN_CHANGED', lines.map((line) => line.workOrderId))
    return recordOf(tx, context, after)
  })
  return result
}

/** One OPEN ticket of the cut order (and lay), numbered from the company's CUT_TICKET series; its scan code is its number. */
async function makeTicket(tools: CommandTools, order: CutOrderRow, layId: string | null) {
  const ticketId = newId()
  const issued = await allocateNumber(tools, { companyId: order.companyId, kind: 'CUT_TICKET' }, { type: 'CutTicket', id: ticketId })
  await tools.tx.cutTicket.create({
    data: { id: ticketId, companyId: order.companyId, siteId: order.siteId, number: issued.formatted, scanCode: issued.formatted.toUpperCase(), kind: 'CUT', cutOrderId: order.id, layId, createdAt: tools.now, updatedAt: tools.now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  return (await tools.tx.cutTicket.findUniqueOrThrow({ where: { id: ticketId }, select: { id: true, number: true, scanCode: true, layId: true, status: true } }))
}
export { makeTicket }

/** POST /production/cut-orders/:cutOrderId/release: RELEASED, with its tickets (one per lay of a fabric cut order, one for leather). */
export async function releaseCutOrder(caller: CommandCaller, cutOrderId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { context, order } = await managedOrder(caller, cutOrderId)
  const { result } = await command(caller, { name: 'production.releaseCutOrder', idempotencyKey, input: { cutOrderId, ...body }, record: { type: 'CutOrder', id: cutOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await currentOrder(tx, cutOrderId)
    const lines = await readLines(tx, [cutOrderId])
    const lays = (await readLays(tx, [cutOrderId])).filter((lay) => lay.status !== 'CANCELLED')
    const refusal = releaseRefusal({
      number: current.number,
      kind: current.kind as CutOrderKind,
      status: current.status as CutOrderStatus,
      lines: lines.length,
      marker: current.markerName !== null && current.markerLength !== null,
      plies: current.kind === 'FABRIC' ? Math.max(0, ...lines.map((line) => line.plies ?? 0)) : null,
      layPlies: lays.map((lay) => lay.plies),
    })
    if (refusal) refuse(refusal)
    await lockCells(tx, context.tenantId, lines.map((line) => line.workOrderSizeId))
    for (const line of lines) {
      const workOrder = await tx.workOrder.findUniqueOrThrow({ where: { id: line.workOrderId }, select: { number: true, status: true, holdReason: true } })
      const stop = workOrderRefusal(workOrder)
      if (stop) refuse(stop)
    }
    await tx.cutOrder.update({ where: { id: cutOrderId }, data: { status: 'RELEASED', releasedAt: now, releasedById: context.actorId, updatedAt: now }, select: { id: true } })
    const released = await currentOrder(tx, cutOrderId)
    const tickets = []
    for (const layId of current.kind === 'FABRIC' ? lays.map((lay) => lay.id) : [null]) tickets.push(await makeTicket(tools, released, layId))
    tools.audit({
      action: 'production.releaseCutOrder',
      recordType: 'CutOrder',
      recordId: cutOrderId,
      companyId: order.companyId,
      siteId: order.siteId,
      before: { status: current.status },
      after: { status: 'RELEASED', tickets: tickets.map((ticket) => ticket.number) },
    })
    const workOrderIds = [...new Set(lines.map((line) => line.workOrderId))]
    emitOrder(tools, released, 'RELEASED', workOrderIds)
    for (const ticket of tickets) emitTicket(tools, released, ticket, 'MADE', null)
    return recordOf(tx, context, released)
  })
  return result
}

const cleanReason = (reason: string): string => reason.trim()

/** Voids every OPEN ticket of the cut order with the reason (a ticket printed for a plan that changed). */
async function voidOpenTickets(tools: CommandTools, order: CutOrderRow, reason: string) {
  const open = (await readTickets(tools.tx, [order.id])).filter((ticket) => ticket.status === 'OPEN')
  for (const ticket of open) {
    await tools.tx.cutTicket.update({ where: { id: ticket.id }, data: { status: 'VOID', voidedAt: tools.now, voidReason: reason, updatedAt: tools.now }, select: { id: true } })
    emitTicket(tools, order, { ...ticket, status: 'VOID' }, 'VOIDED', null)
  }
  return open.map((ticket) => ticket.number)
}

/** Takes the rolls allocated to the cut order's PLANNED lays off them (an allocation is a plan; a spread roll stays). */
async function dropAllocations(tx: CommandTx, cutOrderId: string): Promise<number> {
  const planned = (await readLays(tx, [cutOrderId])).filter((lay) => lay.status === 'PLANNED').map((lay) => lay.id)
  if (planned.length === 0) return 0
  return (await tx.layRoll.deleteMany({ where: { layId: { in: planned } } })).count
}

/**
 * POST /production/cut-orders/:cutOrderId/unrelease: back to PLANNED while no ticket was scanned and no lay was spread; its OPEN
 * tickets are voided (their paper is no longer good), the rolls allocated to its lays taken off.
 */
export async function unreleaseCutOrder(caller: CommandCaller, cutOrderId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context, order } = await managedOrder(caller, cutOrderId)
  const { result } = await command(caller, { name: 'production.unreleaseCutOrder', idempotencyKey, input: { cutOrderId, ...body }, record: { type: 'CutOrder', id: cutOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await currentOrder(tx, cutOrderId)
    if (current.status !== 'RELEASED') {
      refuse({ code: 'NOT_AT_TABLE', message: `Cut order ${current.number} is ${current.status.toLowerCase().replace('_', ' ')}: only a released cut order goes back to planning.` })
    }
    const tickets = await readTickets(tx, [cutOrderId])
    const lays = await readLays(tx, [cutOrderId])
    if (tickets.some((ticket) => ticket.status === 'STARTED' || ticket.status === 'DONE') || lays.some((lay) => lay.status !== 'PLANNED' && lay.status !== 'CANCELLED')) {
      refuse({ code: 'TICKET_SCANNED', message: `Cut order ${current.number} was started at a table: it does not go back to planning.` })
    }
    const removed = await dropAllocations(tx, cutOrderId)
    const reason = cleanReason(body.reason)
    const voided = await voidOpenTickets(tools, current, `Back to planning: ${reason}`)
    await tx.cutOrder.update({ where: { id: cutOrderId }, data: { status: 'PLANNED', releasedAt: null, releasedById: null, updatedAt: now }, select: { id: true } })
    const after = await currentOrder(tx, cutOrderId)
    tools.audit({ action: 'production.unreleaseCutOrder', recordType: 'CutOrder', recordId: cutOrderId, companyId: order.companyId, siteId: order.siteId, before: { status: 'RELEASED' }, after: { status: 'PLANNED', voided, rollsRemoved: removed }, reason })
    emitOrder(tools, after, 'BACK_TO_PLANNING', [...new Set((await readLines(tx, [cutOrderId])).map((line) => line.workOrderId))])
    return recordOf(tx, context, after)
  })
  return result
}

/** POST /production/cut-orders/:cutOrderId/cancel: PLANNED or RELEASED → CANCELLED with the reason (its lays cancelled, tickets voided). */
export async function cancelCutOrder(caller: CommandCaller, cutOrderId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { context, order } = await managedOrder(caller, cutOrderId)
  const { result } = await command(caller, { name: 'production.cancelCutOrder', idempotencyKey, input: { cutOrderId, ...body }, record: { type: 'CutOrder', id: cutOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await currentOrder(tx, cutOrderId)
    if (current.status !== 'PLANNED' && current.status !== 'RELEASED') {
      const why = current.status === 'IN_PROGRESS' ? 'was started at a table: it is cut to the end' : `is ${current.status.toLowerCase()}`
      refuse({ code: 'NOT_OPEN', message: `Cut order ${current.number} ${why}; it is not cancelled.` })
    }
    const reason = cleanReason(body.reason)
    const removed = current.status === 'RELEASED' ? await dropAllocations(tx, cutOrderId) : 0
    const lays = (await readLays(tx, [cutOrderId])).filter((lay) => lay.status !== 'CUT' && lay.status !== 'CANCELLED')
    for (const lay of lays) await tx.lay.update({ where: { id: lay.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: `Cut order cancelled: ${reason}`, updatedAt: now }, select: { id: true } })
    const voided = await voidOpenTickets(tools, current, `Cut order cancelled: ${reason}`)
    await tx.cutOrder.update({ where: { id: cutOrderId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now }, select: { id: true } })
    const after = await currentOrder(tx, cutOrderId)
    tools.audit({ action: 'production.cancelCutOrder', recordType: 'CutOrder', recordId: cutOrderId, companyId: order.companyId, siteId: order.siteId, before: { status: current.status }, after: { status: 'CANCELLED', voided, laysCancelled: lays.length, rollsRemoved: removed }, reason })
    emitOrder(tools, after, 'CANCELLED', [...new Set((await readLines(tx, [cutOrderId])).map((line) => line.workOrderId))])
    return recordOf(tx, context, after)
  })
  return result
}
