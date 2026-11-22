import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { joinProblems, joinVerdict } from '@nexus/factory-domain/shipping/shipments'
import {
  garmentsLeft,
  mergeProblems,
  mergedReason,
  moveProblems,
  moveRefusalPath,
  moveRefusalWords,
  takeOffRefusalPath,
  takeOffRefusalWords,
  type MoveAsk,
  type MoveRefusalCode,
  type SplitReason,
  type TakeOffRefusalCode,
} from '@nexus/factory-domain/shipping/split/split'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { holdOnPacking } from '../../quality/holds/checks'
import { mayOn, officeContextOf } from '../access'
import { lockCells, tenantOf } from '../cells'
import { carryHoldsOntoInCommand, lockShipmentRow, readHolds, releaseHoldInCommand } from '../holds/store'
import { syncSystemHoldsInCommand } from '../holds/system'
import { joinOrderOf, joinOrdersOf, joinShipmentFacts, orderRefsOfShipments, ordersChanged, ordersOfShipment } from '../shipments/orders-of'
import { officeShipment, packingChanged, shipmentDetail, unpackSerialsOf } from '../shipments/shipments'
import { readSplitLines, type SplitLineFacts } from '../split/split'
import { readShipment, type ShipmentHeader } from '../store'

/**
 * Consolidate and split from the order's Shipments tab (and Warehouse's record), B-OS-011 … B-OS-013 (order shipments lane; X1;
 * Owner D3: only while DRAFT; rules factory-domain shipping/split). Office only, shipping.manage over every shipment it touches
 * (reading the targets: shipping.view). A shipment, its lines and parcels carry the customer in every key, so garments never move
 * to another customer's shipment for any login; the API answers another customer's target as an unknown one.
 *
 *   take off   POST …/shipments/:shipmentId/orders/:salesOrderId/take-off — every line of one order (not the shipment's first)
 *              comes off a DRAFT in ONE command: the cells locked, the serials unpacked, the lines deleted (removeLine's steps),
 *              the orders it carries and the system's holds settled. Refused NOT_DRAFT, NOT_ON_IT, FIRST_ORDER, IN_CARTON.
 *   targets    GET …/shipments/:shipmentId/move-targets — the other DRAFTs of the same customer, company and site, each with the
 *              orders it carries, its garments and, for each order of the source, whether it may join (joinProblems).
 *   move       POST …/shipments/:shipmentId/move — garments onto another DRAFT in ONE command: both rows locked in id order (their
 *              versions checked), each order that joins the target passes its join rules (JOIN_<CODE>), quality holds checked,
 *              the cells locked, the source's lines shrink first, then the target's grow (the split's order); the source's holds
 *              in force carried; both shipments' system holds settled.
 *   merge      POST …/shipments/:shipmentId/merge — the move of every garment, then the emptied DRAFT is CANCELLED "Merged into
 *              {number}" (never deleted; its parcels stay as history), its holds (carried first) released with the same words.
 *
 * Every command writes audit rows on both shipments (before → after, the reason) and the events W1's readers follow
 * (shipment.packing_changed, shipment.orders_changed, shipment.status_changed) and shipment.garments_moved.
 */

type Reader = CommandTx

/** The most targets the move-targets read lists. */
const MAX_TARGETS = 50

function refusedMove(code: MoveRefusalCode, facts: { readonly number: string; readonly target?: string | null; readonly status?: string | null }): never {
  const message = moveRefusalWords(code, facts)
  throw new DomainError('conflict', message, [{ path: moveRefusalPath(code), message }])
}

// ---- take this order off a shared DRAFT (B-OS-013) ---------------------------------------------------------------------

export interface TakeOffBody {
  readonly version?: number | undefined
  readonly reason: string
}

/** POST /shipping/shipments/:shipmentId/orders/:salesOrderId/take-off (shipping.manage). */
export async function takeOrderOff(caller: CommandCaller, shipmentId: string, salesOrderId: string, body: TakeOffBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  // The order: of this shipment's own customer only (another customer's, or an unknown id: not found — the brand wall).
  const order = isUuid(salesOrderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: salesOrderId }, select: { id: true, number: true, partyId: true } })) : null
  if (!order || order.partyId !== shipment.partyId) throw new NotFoundError('Sales order not found.')
  const { result } = await command(
    caller,
    { name: 'shipping.takeOff', idempotencyKey, input: { shipmentId, salesOrderId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const refuse = (code: TakeOffRefusalCode): never => {
        const message = takeOffRefusalWords(code, { number: current.number, order: order.number, status: current.status })
        throw new DomainError('conflict', message, [{ path: takeOffRefusalPath(code), message }])
      }
      if (current.status !== 'DRAFT') refuse('NOT_DRAFT')
      // Shipment.salesOrderId never changes (the shipment was made for it): its garments move with Split… or Move garments to….
      if (current.salesOrderId === order.id) refuse('FIRST_ORDER')
      const lines = await tools.tx.shipmentLine.findMany({
        where: { shipmentId: current.id, salesOrderLine: { orderId: order.id } },
        select: { id: true, quantity: true, workOrderSizeId: true, parcelId: true, salesOrderLineId: true, size: true, serials: { select: { id: true, serial: true } } },
        orderBy: { id: 'asc' },
      })
      if (lines.length === 0) refuse('NOT_ON_IT')
      // Carton contents stay with their line (ShipmentLine_contents_kept): they are taken out at the bench first.
      if ((await tools.tx.parcelLine.count({ where: { shipmentLineId: { in: lines.map((line) => line.id) } } })) > 0) refuse('IN_CARTON')
      const before = await ordersOfShipment(tools.tx, current)
      await lockCells(tools.tx, tenantOf(tools.context), lines.map((line) => line.workOrderSizeId))
      for (const line of lines) {
        await unpackSerialsOf(tools, current, line.serials.map((serial) => ({ ...serial, lineId: line.id })))
        await tools.tx.shipmentLine.delete({ where: { id: line.id }, select: { id: true } })
        tools.audit({ recordType: 'ShipmentLine', recordId: line.id, companyId: current.companyId, siteId: current.siteId, before: { shipmentId: current.id, workOrderSizeId: line.workOrderSizeId, quantity: line.quantity, parcelId: line.parcelId } })
      }
      const garments = lines.reduce((sum, line) => sum + line.quantity, 0)
      tools.audit({
        action: 'shipping.takeOff',
        recordType: 'Shipment',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { salesOrderId: order.id, lines: lines.map((line) => ({ lineId: line.id, salesOrderLineId: line.salesOrderLineId, size: line.size, quantity: line.quantity })) },
        after: { salesOrderId: order.id, lines: [], garments },
        reason: body.reason.trim(),
      })
      packingChanged(tools, current, current.status, 'lines')
      // The order leaves with its last line (REMOVED); the system's holds settle (another order's payment hold no longer applies).
      ordersChanged(tools, current, before, await ordersOfShipment(tools.tx, current))
      await syncSystemHoldsInCommand(tools, [current.id])
      return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!), takenOff: { salesOrderId: order.id, lines: lines.length, garments } }
    },
  )
  return result
}

// ---- the targets a DRAFT's garments may move to (B-OS-011) -------------------------------------------------------------

/** GET /shipping/shipments/:shipmentId/move-targets (shipping.view). */
export async function moveTargets(caller: CommandCaller, shipmentId: string) {
  const context = officeContextOf(caller)
  const source = await officeShipment(caller, shipmentId)
  return caller.withClient(async (client) => {
    const rows = await client.shipment.findMany({
      where: { partyId: source.partyId, companyId: source.companyId, siteId: source.siteId, status: 'DRAFT', id: { not: source.id } },
      select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, salesOrderId: true, shipTo: true },
      orderBy: [{ number: 'asc' }, { id: 'asc' }],
      take: MAX_TARGETS * 2,
    })
    // Never another customer's (also for a person who sees every customer); only those the caller may see.
    const visible = rows.filter((row) => row.partyId === source.partyId && mayOn(context, SHIPPING_VIEW, row)).slice(0, MAX_TARGETS)
    const sourceOrders = await ordersOfShipment(client, source)
    const orders = await joinOrdersOf(client, sourceOrders)
    const refs = await orderRefsOfShipments(client, visible)
    const garments = visible.length > 0 ? await client.shipmentLine.groupBy({ by: ['shipmentId'], where: { shipmentId: { in: visible.map((row) => row.id) } }, _sum: { quantity: true } }) : []
    const garmentsOf = new Map(garments.map((row) => [row.shipmentId, row._sum.quantity ?? 0]))
    const targets = []
    // One target after another: a scoped client's transaction has one connection.
    for (const row of visible) {
      const facts = await joinShipmentFacts(client, { number: row.number, status: row.status, siteId: row.siteId, salesOrderId: row.salesOrderId, shipTo: row.shipTo })
      const carried = (refs.get(row.id) ?? []).map((ref) => ref.id)
      targets.push({
        id: row.id,
        number: row.number,
        orders: (refs.get(row.id) ?? []).map((ref) => ({ id: ref.id, number: ref.number })),
        garments: garmentsOf.get(row.id) ?? 0,
        // For every order of the source: an order the target carries already joins as it is; any other passes the join rules.
        verdicts: sourceOrders.map((orderId) => {
          const order = orders.get(orderId)
          const verdict = carried.includes(orderId) ? joinVerdict([]) : order && facts ? joinVerdict(joinProblems(facts, joinOrderOf(order))) : { allowed: false, code: 'CUSTOMER' as const, why: 'Sales order not found.' }
          return { orderId, ...verdict }
        }),
      })
    }
    return { shipmentId: source.id, number: source.number, version: source.version, targets }
  })
}

// ---- move and merge (B-OS-011, B-OS-012) -------------------------------------------------------------------------------

export interface MoveBody {
  readonly version?: number | undefined
  readonly toShipmentId: string
  readonly toVersion?: number | undefined
  readonly lines: readonly MoveAsk[]
  readonly reason: SplitReason
  readonly words?: string | null | undefined
}

export interface MergeBody {
  readonly version?: number | undefined
  readonly intoShipmentId: string
  readonly intoVersion?: number | undefined
  readonly words?: string | null | undefined
}

/**
 * The target the office may move onto: shipping.manage over it, and of the source's own customer — another customer's shipment
 * (whatever the caller sees) is answered as an unknown one ("Shipment not found.").
 */
async function targetOf(caller: CommandCaller, source: ShipmentHeader, targetId: string): Promise<ShipmentHeader> {
  const target = await officeShipment(caller, targetId, SHIPPING_MANAGE)
  if (target.partyId !== source.partyId) throw new NotFoundError('Shipment not found.')
  if (target.id === source.id) refusedMove('SAME', { number: source.number })
  return target
}

/** Both shipments' rows locked in id order (FOR UPDATE: two moves between the same drafts never wait on each other in a ring), their versions checked, then bumped. */
async function lockPair(tx: Reader, pairs: readonly { readonly id: string; readonly version: number | undefined }[]): Promise<void> {
  for (const pair of [...pairs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const rows = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM "Shipment" WHERE id = ${pair.id}::uuid FOR UPDATE`
    const row = rows[0]
    if (!row) throw new NotFoundError('Shipment not found.')
    if (pair.version !== undefined && pair.version !== row.version) throw new StaleVersionError('Shipment', pair.id, row.version, pair.version)
  }
  for (const pair of pairs) await tx.shipment.update({ where: { id: pair.id }, data: { version: { increment: 1 } }, select: { id: true } })
}

interface MovePlan {
  readonly merged: boolean
  readonly asks: readonly MoveAsk[]
  readonly reason: SplitReason | null
  readonly words: string | null
}

/** Inside the command, both rows locked: the garments move from `source` onto `target` (and, merged, the source is cancelled). */
async function moveInCommand(tools: CommandTools, sourceId: string, targetId: string, plan: (lines: readonly SplitLineFacts[], source: ShipmentHeader, target: ShipmentHeader) => Promise<MovePlan>) {
  const { tx } = tools
  const source = (await readShipment(tx, sourceId))!
  const target = (await readShipment(tx, targetId))!
  for (const shipment of [source, target]) if (shipment.status !== 'DRAFT') refusedMove('NOT_DRAFT', { number: shipment.number, status: shipment.status })
  if (target.siteId !== source.siteId) refusedMove('OTHER_SITE', { number: source.number, target: target.number })
  const lines = await readSplitLines(tx, source.id)
  const { merged, asks, reason, words } = await plan(lines, source, target)
  const byId = new Map(lines.map((line) => [line.id, line]))
  const moved = asks.map((ask) => ({ ...ask, line: byId.get(ask.lineId)! }))

  // Each order whose garments join the target passes the join rules there (an order the target carries already joins as it is).
  const before = { source: await ordersOfShipment(tx, source), target: await ordersOfShipment(tx, target) }
  const lineOrders = moved.length > 0 ? await tx.salesOrderLine.findMany({ where: { id: { in: [...new Set(moved.map((move) => move.line.salesOrderLineId))] } }, select: { id: true, orderId: true } }) : []
  const joining = [...new Set(lineOrders.map((row) => row.orderId))].filter((orderId) => !before.target.includes(orderId))
  if (joining.length > 0) {
    const facts = await joinShipmentFacts(tx, { number: target.number, status: target.status, siteId: target.siteId, salesOrderId: target.salesOrderId, shipTo: target.shipTo })
    const rows = await joinOrdersOf(tx, joining)
    for (const orderId of joining) {
      const row = rows.get(orderId)
      const problem = row && facts ? joinProblems(facts, joinOrderOf(row))[0] : { code: 'CUSTOMER' as const, message: 'Sales order not found.' }
      if (problem) throw new DomainError('conflict', problem.message, [{ path: moveRefusalPath(`JOIN_${problem.code}`), message: problem.message }])
    }
  }
  // Goods on a quality hold (their work order, or the target) wait where they are (the database's ShipmentLine_awaits_quality_hold).
  const held = await holdOnPacking(tx, tools.context, { shipmentId: target.id, workOrderIds: [...new Set(moved.map((move) => move.line.workOrderId))] })
  if (held) {
    const message = `${moveRefusalWords('ON_HOLD_QUALITY', { number: source.number })} ${held}`
    throw new DomainError('conflict', message, [{ path: moveRefusalPath('ON_HOLD_QUALITY'), message }])
  }
  await lockCells(tx, tenantOf(tools.context), moved.map((move) => move.line.workOrderSizeId))

  // The source's lines shrink (or go) first, then the target's grow: a cell's lines over every shipment never pass its releases.
  const changes: { lineId: string; workOrderSizeId: string; size: string; before: number; after: number }[] = []
  for (const move of moved) {
    const after = move.line.quantity - move.quantity
    if (after === 0) await tx.shipmentLine.delete({ where: { id: move.line.id }, select: { id: true } })
    else await tx.shipmentLine.update({ where: { id: move.line.id }, data: { quantity: after, version: { increment: 1 } }, select: { id: true } })
    changes.push({ lineId: move.line.id, workOrderSizeId: move.line.workOrderSizeId, size: move.line.size, before: move.line.quantity, after })
  }
  const unpacked = new Map((await tx.shipmentLine.findMany({ where: { shipmentId: target.id, parcelId: null, workOrderSizeId: { in: moved.map((move) => move.line.workOrderSizeId) } }, select: { id: true, workOrderSizeId: true, quantity: true } })).map((line) => [line.workOrderSizeId, line]))
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const added: { lineId: string; workOrderSizeId: string; size: string; before: number; after: number }[] = []
  for (const move of moved) {
    const existing = unpacked.get(move.line.workOrderSizeId)
    if (existing) {
      const after = existing.quantity + move.quantity
      await tx.shipmentLine.update({ where: { id: existing.id }, data: { quantity: after, version: { increment: 1 } }, select: { id: true } })
      added.push({ lineId: existing.id, workOrderSizeId: move.line.workOrderSizeId, size: move.line.size, before: existing.quantity, after })
      unpacked.set(move.line.workOrderSizeId, { ...existing, quantity: after })
    } else {
      const lineId = newId()
      await tx.shipmentLine.create({
        data: { id: lineId, siteId: target.siteId, partyId: target.partyId, shipmentId: target.id, workOrderId: move.line.workOrderId, workOrderSizeId: move.line.workOrderSizeId, salesOrderLineId: move.line.salesOrderLineId, size: move.line.size, quantity: move.quantity, createdById: actorId },
        select: { id: true },
      })
      added.push({ lineId, workOrderSizeId: move.line.workOrderSizeId, size: move.line.size, before: 0, after: move.quantity })
      unpacked.set(move.line.workOrderSizeId, { id: lineId, workOrderSizeId: move.line.workOrderSizeId, quantity: move.quantity })
    }
  }
  const garments = moved.reduce((sum, move) => sum + move.quantity, 0)

  // The holds the garments were under come along (a move never frees goods from a hold).
  const from = await lockShipmentRow(tx, source.id)
  const to = await lockShipmentRow(tx, target.id)
  await carryHoldsOntoInCommand(tools, from, to)

  const action = merged ? 'shipping.merge' : 'shipping.moveLines'
  const into = { id: target.id, number: target.number }
  const outOf = { id: source.id, number: source.number }
  tools.audit({ action, recordType: 'Shipment', recordId: source.id, companyId: source.companyId, siteId: source.siteId, before: { lines: changes.map(({ lineId, before: quantity }) => ({ lineId, quantity })) }, after: { into, from: outOf, lines: changes, garments, ...(reason ? { splitReason: reason } : {}) }, ...(words ? { reason: words } : {}) })
  tools.audit({ action, recordType: 'Shipment', recordId: target.id, companyId: target.companyId, siteId: target.siteId, before: { lines: added.map(({ lineId, before: quantity }) => ({ lineId, quantity })) }, after: { into, from: outOf, lines: added, garments, ...(reason ? { splitReason: reason } : {}) }, ...(words ? { reason: words } : {}) })
  tools.emit({
    type: 'shipment.garments_moved',
    subject: source.id,
    companyId: source.companyId,
    siteId: source.siteId,
    payload: { shipmentId: source.id, number: source.number, toShipmentId: target.id, toNumber: target.number, merged, lines: moved.length, garments, partyId: source.partyId /* B-SA-004 */ },
  })
  packingChanged(tools, target, target.status, 'lines')

  if (merged) {
    // The emptied DRAFT: its holds (carried above) released with the merge's words, then CANCELLED "Merged into …" (never deleted).
    const cancelReason = mergedReason(target.number, words)
    for (const hold of (await readHolds(tx, [source.id])).filter((row) => row.releasedAt === null)) await releaseHoldInCommand(tools, from, hold, { words: cancelReason, bySystem: false })
    await tx.shipment.update({ where: { id: source.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason }, select: { id: true } })
    tools.audit({ recordType: 'Shipment', recordId: source.id, companyId: source.companyId, siteId: source.siteId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED', mergedInto: into }, reason: cancelReason })
    tools.emit({ type: 'shipment.status_changed', subject: source.id, companyId: source.companyId, siteId: source.siteId, payload: { shipmentId: source.id, number: source.number, from: 'DRAFT', to: 'CANCELLED', partyId: source.partyId /* B-SA-004 */ } })
    packingChanged(tools, source, 'CANCELLED', 'status')
  } else packingChanged(tools, source, source.status, 'lines')

  // The orders each one carries now (an order joins the target, or leaves the source with its last line).
  ordersChanged(tools, source, before.source, await ordersOfShipment(tx, source))
  ordersChanged(tools, target, before.target, await ordersOfShipment(tx, target))
  await syncSystemHoldsInCommand(tools, merged ? [target.id] : [source.id, target.id])
  return {
    shipment: await shipmentDetail(tx, (await readShipment(tx, target.id))!),
    from: await shipmentDetail(tx, (await readShipment(tx, source.id))!),
    moved: { lines: moved.length, garments, merged },
  }
}

/** POST /shipping/shipments/:shipmentId/move (shipping.manage over both): garments onto another DRAFT of the same customer. */
export async function moveGarments(caller: CommandCaller, shipmentId: string, body: MoveBody, idempotencyKey?: string) {
  const source = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const target = await targetOf(caller, source, body.toShipmentId)
  const words = body.words?.trim() ? body.words.trim() : null
  const { result } = await command(caller, { name: 'shipping.moveLines', idempotencyKey, input: { shipmentId, ...body } }, async (tools) => {
    await lockPair(tools.tx, [
      { id: source.id, version: body.version },
      { id: target.id, version: body.toVersion },
    ])
    return moveInCommand(tools, source.id, target.id, async (lines, current, into) => {
      const problems = moveProblems(lines, body.lines)
      if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
      // Something stays: to move everything, merge.
      if (garmentsLeft(lines, body.lines) < 1) refusedMove('NOTHING_STAYS', { number: current.number, target: into.number })
      return { merged: false, asks: body.lines, reason: body.reason, words }
    })
  })
  return result
}

/** POST /shipping/shipments/:shipmentId/merge (shipping.manage over both): every garment onto another DRAFT; this one CANCELLED. */
export async function mergeShipment(caller: CommandCaller, shipmentId: string, body: MergeBody, idempotencyKey?: string) {
  const source = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const target = await targetOf(caller, source, body.intoShipmentId)
  const words = body.words?.trim() ? body.words.trim() : null
  const { result } = await command(caller, { name: 'shipping.merge', idempotencyKey, input: { shipmentId, ...body } }, async (tools) => {
    await lockPair(tools.tx, [
      { id: source.id, version: body.version },
      { id: target.id, version: body.intoVersion },
    ])
    return moveInCommand(tools, source.id, target.id, async (lines, current) => {
      const problem = mergeProblems(lines)
      if (problem) refusedMove(problem, { number: current.number })
      // A carrier label (or a TEST one) names the parcels: void it first (the cancelled DRAFT keeps its parcels as history).
      const labelled = await tools.tx.parcel.count({ where: { shipmentId: current.id, OR: [{ trackingNumber: { not: null } }, { carrierParcelId: { not: null } }] } })
      if (labelled > 0) refusedMove('MERGE_LABELLED', { number: current.number })
      return { merged: true, asks: lines.map((line) => ({ lineId: line.id, quantity: line.quantity })), reason: null, words }
    })
  })
  return result
}
