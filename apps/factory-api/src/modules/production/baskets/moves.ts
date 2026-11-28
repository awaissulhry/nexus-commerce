import type { z } from 'zod'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { badEventRefusal, type SyncRefusal } from '@nexus/factory-domain/floor-sync/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { parseInstant } from '@nexus/factory-domain/core/time'
import { moveDecision, stayWords, undoDecision, type MoveKind, type MoveReason } from '@nexus/factory-domain/production/baskets/moves'
import { PRODUCTION_BASKETS_MOVE, PRODUCTION_BASKETS_ROUTE } from '@nexus/factory-domain/production/baskets/permissions'
import { basketPlace } from '@nexus/factory-domain/production/baskets/place'
import { basketRoute } from '@nexus/factory-domain/production/baskets/route'
import { standingScans } from '@nexus/factory-domain/production/scans/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { holdOnScan } from '../../quality/holds/checks'
import { lockBundleForScan } from '../bundles/store'
import { floorOrOffice, scanWorkOrder, systemView } from '../scans/access'
import { deviceStationOf, lockBundleScans, readBundleScans, readOperations, scanWorkOrderLock, type OperationRow, type Reader, type ScanHeader } from '../scans/store'
import { floorRecordSubjectFor } from '../settings/subject'
import { employeesOf } from '../terminal/store'
import { readEdits, readMoves } from './store'
import type { Applied, QueuedEvent } from '../../../platform/floor-sync/kinds'
import { moveBody, undoQueuedBody } from './contract'

/**
 * Moving baskets by hand (owb- order workflow, S5 fl2; build/briefs/owb-fl2.md step 2; LF _owb-fl-common.md § 1 D, § 2 settles 7,
 * 8; § 3 "fl2"):
 *
 *   POST /production/baskets/move                   1 to 50 baskets, one act (one `groupId`): FORWARD and TAKEN_HERE with
 *                                                   production.baskets.move, BACK with production.baskets.route and a reason.
 *                                                   Each basket moves by factory-domain baskets/moves moveDecision on its own
 *                                                   route and place, or stays (counted, with its words): a step not on its
 *                                                   route (another work order's step id), at it already, Ready to ship
 *                                                   before its last step is reported, on hold
 *   POST /production/baskets/moves/:groupId/undo    every move of the act that still counts, undone (a new UNDO row each, back
 *                                                   to where it came from): the mover's own while nobody moved the basket
 *                                                   since needs production.baskets.move; another person's production.baskets.route
 *
 * ONE command each, in the scans' lock order (the work order, then each basket), keyed `<device>.<clientEventId>` on the floor
 * (the queue's kinds production.baskets.move / moveUndo replay it unchanged). A move writes a BasketMove row and NEVER a scan,
 * a pay line (EarningsEntry) or a cost entry; the database's G5 trigger keeps the steps of the basket's own work order. The
 * worker is named only where the site's floor rules name workers (floorRecordSubjectFor); the office reads the act on the
 * order as "Changed on the floor" (an audit row on its SalesOrder: the order log reads those; the customer never does — not in
 * the log's customer ALLOW-list).
 */

export interface MoveInput {
  readonly bundleIds: readonly string[]
  readonly toOperationId: string | null
  readonly kind: MoveKind
  readonly reason?: MoveReason | undefined
  readonly note?: string | undefined
  readonly clientEventId: string
  readonly occurredAt?: string | undefined
}

export interface MoveAnswer {
  readonly groupId: string
  readonly moved: number
  readonly stay: number
  readonly stayWords: readonly string[]
  /** The baskets that moved, each with where it went (null: Ready to ship). */
  readonly baskets: readonly { readonly bundleId: string; readonly to: string | null }[]
}

const keyOf = (context: FloorContext | OfficeContext, clientEventId: string) => (context.audience === 'floor' ? `${context.deviceId}.${clientEventId}` : `office.${clientEventId}`)

/** The baskets named, read as the caller (a floor device: its own site), and their work orders reached with the right. */
async function basketsOf(caller: CommandCaller, bundleIds: readonly string[], right: typeof PRODUCTION_BASKETS_MOVE | typeof PRODUCTION_BASKETS_ROUTE) {
  const unique = [...new Set(bundleIds)]
  const rows = await caller.withClient((db: Reader) => db.bundle.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true, siteId: true, status: true } }))
  if (rows.length !== unique.length) throw new NotFoundError('Not a basket of this site: scan its ticket.')
  const workOrders = new Map<string, ScanHeader>()
  for (const workOrderId of new Set(rows.map((row) => row.workOrderId))) workOrders.set(workOrderId, await scanWorkOrder(caller, workOrderId, right))
  return { rows: unique.map((id) => rows.find((row) => row.id === id)!), workOrders }
}

/** The sales order of each work order cell (the order log's record), read through the tenant's system view. */
async function ordersOf(caller: CommandCaller, cellIds: readonly string[]): Promise<Map<string, string>> {
  return systemView(caller).withClient(async (db: Reader) => {
    const cells = await db.workOrderSize.findMany({ where: { id: { in: [...new Set(cellIds)] } }, select: { id: true, salesOrderLineId: true } })
    const lineIds = [...new Set(cells.flatMap((cell) => (cell.salesOrderLineId ? [cell.salesOrderLineId] : [])))]
    const lines = new Map(lineIds.length === 0 ? [] : (await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, salesOrderId: true } })).map((line) => [line.id, line.salesOrderId]))
    return new Map(cells.flatMap((cell) => (cell.salesOrderLineId && lines.has(cell.salesOrderLineId) ? [[cell.id, lines.get(cell.salesOrderLineId)!] as const] : [])))
  })
}

/** Who a move names: the worker where the site names workers (and their employee), else the station; the office user. */
async function moverOf(tools: CommandTools, context: FloorContext | OfficeContext, siteId: string) {
  if (context.audience === 'office') return { workerId: null, employeeId: null, userId: context.actorId, deviceId: null }
  const stationId = await deviceStationOf(tools.tx, context.deviceId)
  const subject = await floorRecordSubjectFor(tools.tx, { siteId, workerId: context.actorId, stationId })
  const employees = subject.workerId ? await employeesOf(tools.tx, [subject.workerId]) : new Map<string, string | null>()
  return { workerId: subject.workerId, employeeId: subject.workerId ? (employees.get(subject.workerId) ?? null) : null, userId: null, deviceId: context.deviceId }
}

/** A basket's route, place and standing reports inside the command (after its locks). */
async function basketNow(tools: CommandTools, bundleId: string, operations: readonly OperationRow[]) {
  const standing = standingScans(await readBundleScans(tools.tx, bundleId))
  const moves = (await readMoves(tools.tx, [bundleId])).get(bundleId) ?? []
  const edits = (await readEdits(tools.tx, [bundleId])).get(bundleId) ?? []
  const route = basketRoute(operations, edits)
  return { standing, moves, route, place: basketPlace(route, standing, bundleId, moves) }
}

/** POST /production/baskets/move (see the file's head). */
export async function moveBaskets(caller: CommandCaller, input: MoveInput, key?: string): Promise<MoveAnswer & { readonly replayed: boolean }> {
  const context = floorOrOffice(caller)
  const actor = actorOf(context)
  const right = input.kind === 'BACK' ? PRODUCTION_BASKETS_ROUTE : PRODUCTION_BASKETS_MOVE
  if (!holds(actor, right)) throw new ForbiddenError(input.kind === 'BACK' ? 'Moving a basket back is the team leader’s.' : 'Moving a basket by hand needs the right to move baskets.')
  if (input.kind === 'BACK' && !input.reason) throw new ValidationError('Say why the basket goes back.', [{ path: 'body/reason', message: 'A move back gives its reason: REDO, MISTAKE or OTHER.' }])
  const note = input.note?.trim() || null
  if (input.reason === 'OTHER' && !note) throw new ValidationError('Say in a few words why.', [{ path: 'body/note', message: 'OTHER needs a few words.' }])
  const { rows, workOrders } = await basketsOf(caller, input.bundleIds, right)
  const orders = await ordersOf(caller, rows.map((row) => row.workOrderSizeId))
  const deviceTime = input.occurredAt ? parseInstant(input.occurredAt) : null
  const { result, replayed } = await command(caller, { name: 'production.baskets.move', idempotencyKey: key ?? keyOf(context, input.clientEventId), input: { ...input, bundleIds: rows.map((row) => row.id) }, ...(deviceTime ? { deviceTime } : {}) }, async (tools): Promise<MoveAnswer> => {
    const groupId = newId()
    const moved: { bundleId: string; to: string | null }[] = []
    const stays: string[] = []
    const operationsOf = new Map<string, OperationRow[]>()
    for (const workOrderId of [...workOrders.keys()].sort()) {
      await scanWorkOrderLock(tools.tx, context.tenantId, workOrderId)
      operationsOf.set(workOrderId, await readOperations(tools.tx, workOrderId))
    }
    for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const locked = await lockBundleForScan(tools.tx, row.id)
      if (!locked || locked.bundle.status !== 'ACTIVE') {
        stays.push(stayWords('NOT_A_BASKET', row.code))
        continue
      }
      await lockBundleScans(tools.tx, context.tenantId, locked.bundle.siteId, row.id)
      // Pick B: a held basket stays where it is (the hold is lifted in the office); its words are the scans'.
      if (await holdOnScan(tools.tx, context, { bundleId: row.id, workOrderId: row.workOrderId })) {
        stays.push(stayWords('HELD', row.code))
        continue
      }
      const now = await basketNow(tools, row.id, operationsOf.get(row.workOrderId)!)
      const decision = moveDecision(input.kind, { bundleId: row.id, route: now.route, place: now.place, standing: now.standing }, input.toOperationId)
      if (!decision.ok) {
        stays.push(stayWords(decision.stay, row.code))
        continue
      }
      const workOrder = workOrders.get(row.workOrderId)!
      const mover = await moverOf(tools, context, workOrder.siteId)
      const id = newId()
      await tools.tx.basketMove.create({
        data: {
          id,
          siteId: workOrder.siteId,
          workOrderId: workOrder.id,
          bundleId: row.id,
          fromOperationId: decision.from,
          toOperationId: decision.to,
          kind: input.kind,
          reason: input.reason ?? null,
          note,
          groupId,
          ...mover,
          clientEventId: context.audience === 'floor' ? input.clientEventId : null,
          deviceTime,
          serverTime: tools.now,
        },
        select: { id: true },
      })
      const after = { bundleId: row.id, code: row.code, kind: input.kind, from: decision.from, to: decision.to, reason: input.reason ?? null, groupId, workerId: mover.workerId }
      tools.audit({ action: 'production.baskets.move', recordType: 'BasketMove', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, after, ...(note ? { reason: note } : {}) })
      // The office's "Changed on the floor" on the order (never the customer's: not in the log's customer ALLOW-list).
      const salesOrderId = orders.get(row.workOrderSizeId)
      if (salesOrderId) tools.audit({ action: 'production.baskets.move', recordType: 'SalesOrder', recordId: salesOrderId, companyId: workOrder.companyId, siteId: workOrder.siteId, after })
      moved.push({ bundleId: row.id, to: decision.to })
    }
    return { groupId, moved: moved.length, stay: stays.length, stayWords: stays, baskets: moved }
  })
  return { ...result, replayed }
}

export interface UndoInput {
  readonly clientEventId: string
  readonly occurredAt?: string | undefined
}

/** POST /production/baskets/moves/:groupId/undo (see the file's head). */
export async function undoMoves(caller: CommandCaller, groupId: string, input: UndoInput, key?: string): Promise<{ readonly groupId: string; readonly undone: number; readonly stay: number; readonly stayWords: readonly string[]; readonly replayed: boolean }> {
  const context = floorOrOffice(caller)
  const actor = actorOf(context)
  if (!holds(actor, PRODUCTION_BASKETS_MOVE) && !holds(actor, PRODUCTION_BASKETS_ROUTE)) throw new ForbiddenError('Undoing a move needs the right to move baskets.')
  const group = await caller.withClient((db: Reader) => db.basketMove.findMany({ where: { groupId, kind: { not: 'UNDO' } }, select: { id: true, bundleId: true } }))
  if (group.length === 0) throw new NotFoundError('No move of this site to undo.')
  const { rows, workOrders } = await basketsOf(caller, group.map((move) => move.bundleId), holds(actor, PRODUCTION_BASKETS_MOVE) ? PRODUCTION_BASKETS_MOVE : PRODUCTION_BASKETS_ROUTE)
  const orders = await ordersOf(caller, rows.map((row) => row.workOrderSizeId))
  const deviceTime = input.occurredAt ? parseInstant(input.occurredAt) : null
  const { result, replayed } = await command(caller, { name: 'production.baskets.moveUndo', idempotencyKey: key ?? keyOf(context, input.clientEventId), input: { groupId, ...input }, ...(deviceTime ? { deviceTime } : {}) }, async (tools) => {
    const undoGroup = newId()
    let undone = 0
    const stays: string[] = []
    for (const workOrderId of [...workOrders.keys()].sort()) await scanWorkOrderLock(tools.tx, context.tenantId, workOrderId)
    for (const target of [...group].sort((a, b) => (a.bundleId < b.bundleId ? -1 : 1))) {
      const row = rows.find((entry) => entry.id === target.bundleId)!
      await lockBundleForScan(tools.tx, row.id)
      await lockBundleScans(tools.tx, context.tenantId, row.siteId, row.id)
      const moves = (await readMoves(tools.tx, [row.id])).get(row.id) ?? []
      const move = moves.find((entry) => entry.id === target.id)!
      const decision = undoDecision({ move, moves, byWorkerId: context.audience === 'floor' ? context.actorId : null, byUserId: context.audience === 'office' ? context.actorId : null })
      if (!decision.ok) {
        stays.push(`${row.code}: this move was undone already, or is not one to undo.`)
        continue
      }
      if (!holds(actor, decision.needs)) {
        stays.push(`${row.code}: someone moved it since, or another person moved it: the team leader undoes that.`)
        continue
      }
      const workOrder = workOrders.get(row.workOrderId)!
      const mover = await moverOf(tools, context, workOrder.siteId)
      const id = newId()
      await tools.tx.basketMove.create({
        data: { id, siteId: workOrder.siteId, workOrderId: workOrder.id, bundleId: row.id, fromOperationId: decision.from, toOperationId: decision.to, kind: 'UNDO', undoesId: move.id, groupId: undoGroup, ...mover, clientEventId: context.audience === 'floor' ? input.clientEventId : null, deviceTime, serverTime: tools.now },
        select: { id: true },
      })
      const after = { bundleId: row.id, code: row.code, kind: 'UNDO', undoes: move.id, groupId: undoGroup, workerId: mover.workerId }
      tools.audit({ action: 'production.baskets.moveUndo', recordType: 'BasketMove', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, after })
      const salesOrderId = orders.get(row.workOrderSizeId)
      if (salesOrderId) tools.audit({ action: 'production.baskets.moveUndo', recordType: 'SalesOrder', recordId: salesOrderId, companyId: workOrder.companyId, siteId: workOrder.siteId, after })
      undone++
    }
    return { groupId: undoGroup, undone, stay: stays.length, stayWords: stays }
  })
  return { ...result, replayed }
}

// ---- the offline queue (factory-domain floor-sync/kinds: production.baskets.move, production.baskets.moveUndo) ------------------

/** The payload as its body, or the first problem in words. */
function parsedQueued<Schema extends z.ZodType>(schema: Schema, value: unknown): { ok: true; value: z.infer<Schema> } | { ok: false; refusal: SyncRefusal } {
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  return { ok: false, refusal: badEventRefusal(issue ? `${issue.message} (${issue.path.join('/') || 'payload'})` : 'the payload is not valid.') }
}

/**
 * Applies one queued move or undo through its own command with the queue's key (`<device>.<client event id>`): a resent event
 * changes nothing (the command's receipt answers it). Called by platform/floor-sync/kinds.ts `applyQueued` (S5's cases).
 */
export async function applyBasketMove(caller: CommandCaller, event: QueuedEvent, key: string): Promise<Applied> {
  const envelope = { clientEventId: event.clientEventId, ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}) }
  const refused = (refusal: SyncRefusal): Applied => ({ status: 'refused', refusal, moduleRefusal: null })
  switch (event.kind) {
    case 'production.baskets.move': {
      const body = parsedQueued(moveBody, { ...event.payload, ...envelope })
      if (!body.ok) return refused(body.refusal)
      const result = await moveBaskets(caller, body.value, key)
      return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'BasketMove', id: result.groupId } }
    }
    case 'production.baskets.moveUndo': {
      const body = parsedQueued(undoQueuedBody, { ...event.payload, ...envelope })
      if (!body.ok) return refused(body.refusal)
      const { groupId, ...undo } = body.value
      const result = await undoMoves(caller, groupId, undo, key)
      return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'BasketMove', id: result.groupId } }
    }
    default:
      return refused(badEventRefusal(`${event.kind} is not a basket move.`))
  }
}
