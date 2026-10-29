import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { pickList } from '@nexus/factory-domain/inventory/issue/pick-list'
import { ISSUABLE_STATUSES, type Refusal } from '@nexus/factory-domain/inventory/issue/rules'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { LEDGER_SELECT, type LedgerRow } from '../ledger/post-moves'
import {
  pickHideOf,
  pickItemOf,
  pickLotOf,
  pickStockOf,
  readAtWorkOrder,
  readColours,
  readCuts,
  readHides,
  readItems,
  readLocations,
  readLots,
  readPickHeader,
  readPickMaterials,
  readSiteStock,
  STYLE_COLUMNS,
  type PickHeader,
  type Reader,
} from './store'

/**
 * The pick screens' reads (B-W1-39; A2 SCR-093 "scan-wo" and "need"; SCR-070 "Materials & leather"): the work orders a
 * site picks for (RELEASED and IN_PROGRESS, the most urgent first; a scanned number finds one) and a work order's pick
 * list (factory-domain inventory/issue/pick-list) with the caller's own last issue, which it may still undo. For the
 * office within its grants and a floor device at its own site (inventory.issue; row-level security keeps the floor to
 * its site, so another site's work order is not found). No figure here carries money.
 */

/** A pick refused by its rule (factory-domain inventory/issue/rules): a 409 with the refusal's code in `refusal/<CODE>`. */
export class PickRefusedError extends ConflictError {
  override name = 'PickRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

/** The work order the caller picks for: one it may see with `permission` at its site (else not found). */
export async function pickingWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission = INVENTORY_ISSUE): Promise<{ context: StockContext; workOrder: PickHeader }> {
  const context = stockContextOf(caller)
  const workOrder = await caller.withClient((client) => readPickHeader(client, workOrderId))
  if (!workOrder || !mayAt(context, permission, workOrder)) throw new NotFoundError('Work order not found.')
  return { context, workOrder }
}

export interface WorkOrdersQuery {
  readonly siteId?: string | undefined
  /** A scanned or typed work order number (exact). */
  readonly number?: string | undefined
  readonly limit: number
}

/** The work orders to pick for: RELEASED and IN_PROGRESS at the caller's sites, highest priority, then earliest due. */
export async function pickingWorkOrders(caller: CommandCaller, query: WorkOrdersQuery) {
  const context = stockContextOf(caller)
  const where: Prisma.WorkOrderWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_ISSUE, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
      { status: { in: [...ISSUABLE_STATUSES] } },
      query.siteId ? { siteId: query.siteId } : {},
      query.number ? { number: query.number.trim() } : {},
    ],
  }
  const rows = await caller.withClient((client) =>
    client.workOrder.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { number: 'asc' }],
      take: query.limit,
      select: {
        id: true,
        number: true,
        batchNumber: true,
        status: true,
        siteId: true,
        dueDate: true,
        priority: true,
        style: { select: { id: true, code: true, name: true } },
        sizes: { select: { quantity: true, colourway: { select: { code: true } } } },
      },
    }),
  )
  return {
    workOrders: rows.map((row) => ({
      id: row.id,
      number: row.number,
      batchNumber: row.batchNumber,
      status: row.status,
      siteId: row.siteId,
      dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
      priority: row.priority,
      style: row.style,
      pieces: row.sizes.reduce((pieces, cell) => pieces + cell.quantity, 0),
      colourways: [...new Set(row.sizes.map((cell) => cell.colourway.code))].sort(),
    })),
  }
}

/** A work order's pick list, with the caller's own last issue to it while it may still be undone. */
export async function getPickList(caller: CommandCaller, workOrderId: string) {
  const { context, workOrder } = await pickingWorkOrder(caller, workOrderId)
  return caller.withClient((client) => pickListView(client, context, workOrder))
}

export async function pickListView(db: Reader, context: StockContext, workOrder: PickHeader) {
  const style = await db.style.findUniqueOrThrow({ where: { id: workOrder.styleId }, select: STYLE_COLUMNS })
  const materials = await readPickMaterials(db, workOrder.id, style)
  const itemIds = [...new Set(materials.map((row) => row.itemId))]
  const items = await readItems(db, itemIds)
  const colours = await readColours(db, [...new Set(materials.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))])
  const stock = await readSiteStock(db, workOrder.siteId, { itemIds })
  const atWorkOrder = await readAtWorkOrder(db, workOrder.siteId, workOrder.id)
  const lots = await readLots(db, [...new Set([...stock, ...atWorkOrder].flatMap((row) => (row.lotId ? [row.lotId] : [])))])
  const hideIds = [...new Set([...stock, ...atWorkOrder].flatMap((row) => (row.hideId ? [row.hideId] : [])))]
  const hides = await readHides(db, hideIds)
  const locations = await readLocations(db, [...new Set(stock.map((row) => row.locationId))])
  const cuts = await readCuts(db, workOrder.siteId, workOrder.id, atWorkOrder.flatMap((row) => (row.hideId ? [row.hideId] : [])))
  const lines = pickList({
    materials,
    items: new Map([...items.values()].map((item) => [item.id, pickItemOf(item)])),
    colours,
    stock: pickStockOf(stock, locations),
    lots: new Map([...lots.values()].map((lot) => [lot.id, pickLotOf(lot)])),
    hides: new Map([...hides.values()].map((hide) => [hide.id, pickHideOf(hide)])),
    atWorkOrder,
    cuts,
  })
  const last = await lastIssueOf(db, context, workOrder.siteId)
  return {
    workOrder: {
      id: workOrder.id,
      number: workOrder.number,
      batchNumber: workOrder.batchNumber,
      status: workOrder.status,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      dueDate: workOrder.dueDate ? workOrder.dueDate.toISOString().slice(0, 10) : null,
      priority: workOrder.priority,
      version: workOrder.version,
      issuable: ISSUABLE_STATUSES.includes(workOrder.status),
      style: { id: style.id, code: style.code, name: style.name },
    },
    lines,
    undo: last && last.moves[0]!.workOrderId === workOrder.id ? undoView(last.moves) : null,
  }
}

// ---- the poster's last issue ----------------------------------------------------------------------------------------------

/** The moves one command posted: its key without the move's `:<n>` (a move with a key of its own is alone). */
export const groupPrefixOf = (idempotencyKey: string): string | null => (/^.+:\d+$/.test(idempotencyKey) ? idempotencyKey.replace(/:\d+$/, '') : null)

const indexOf = (idempotencyKey: string): number => {
  const match = /:(\d+)$/.exec(idempotencyKey)
  // A key is digits only after its last colon: well below Number.MAX_SAFE_INTEGER (a batch has at most 500 moves).
  return match ? Number.parseInt(match[1]!, 10) : 0
}

/** The moves of the command that posted `move` (the same key prefix, the same work order and reason), in their order. */
export async function readGroup(db: Reader, move: LedgerRow): Promise<LedgerRow[]> {
  const prefix = groupPrefixOf(move.idempotencyKey)
  if (!prefix) return [move]
  const rows = await db.stockMove.findMany({
    where: { siteId: move.siteId, workOrderId: move.workOrderId, reason: move.reason, reversalOfId: null, idempotencyKey: { startsWith: `${prefix}:` } },
    select: LEDGER_SELECT,
  })
  // startsWith is a LIKE: keep only the exact `<prefix>:<n>` keys.
  return rows.filter((row) => groupPrefixOf(row.idempotencyKey) === prefix).sort((a, b) => indexOf(a.idempotencyKey) - indexOf(b.idempotencyKey))
}

/** Who posted a move as the undo sees it: a floor device's worker, or an office user (no device). */
export function posterWhere(context: StockContext): Prisma.StockMoveWhereInput | null {
  if (context.audience === 'floor') return { deviceId: context.deviceId, createdById: context.actorId }
  if (context.audience === 'office') return { deviceId: null, createdById: context.actorId }
  return null
}

/** The id of the newest move the poster made at the site (a floor device: by the device, whoever signed in). */
export async function latestMoveOf(db: Reader, context: StockContext, siteId: string): Promise<string | null> {
  const where: Prisma.StockMoveWhereInput | null = context.audience === 'floor' ? { deviceId: context.deviceId } : posterWhere(context)
  if (!where) return null
  const row = await db.stockMove.findFirst({ where: { ...where, siteId }, orderBy: { id: 'desc' }, select: { id: true } })
  return row?.id ?? null
}

/** The poster's last stock action at the site when it is an issue it may still undo (not reversed). */
async function lastIssueOf(db: Reader, context: StockContext, siteId: string): Promise<{ moves: LedgerRow[] } | null> {
  const latest = await latestMoveOf(db, context, siteId)
  if (!latest) return null
  const move = await db.stockMove.findUnique({ where: { id: latest }, select: LEDGER_SELECT })
  const poster = posterWhere(context)
  if (!move || !poster || move.reason !== 'ISSUE' || move.reversalOfId || !move.workOrderId) return null
  if (move.createdById !== context.actorId) return null
  const moves = await readGroup(db, move)
  const reversed = await db.stockMove.count({ where: { reversalOfId: { in: moves.map((row) => row.id) } } })
  return reversed > 0 ? null : { moves }
}

function undoView(moves: readonly LedgerRow[]) {
  const first = moves[0]!
  return {
    issueId: first.id,
    itemId: first.itemId,
    itemColourId: first.itemColourId,
    lotId: first.lotId,
    hideId: first.hideId,
    baseQuantity: quantityText(moves.reduce((sum, move) => sum.plus(new Dec(move.baseQuantity.toString())), ZERO)),
    occurredAt: toUtcIso(first.occurredAt),
  }
}
