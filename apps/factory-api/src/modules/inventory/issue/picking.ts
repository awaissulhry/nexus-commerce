import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { pickList } from '@nexus/factory-domain/inventory/issue/pick-list'
import type { Balance } from '@nexus/factory-domain/inventory/ledger/moves'
import { usabilityOf } from '@nexus/factory-domain/planning/usable'
import { blockedWords } from '@nexus/factory-domain/quality/holds/rules'
import { ISSUABLE_STATUSES, type Refusal } from '@nexus/factory-domain/inventory/issue/rules'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { LEDGER_SELECT, type LedgerRow } from '../ledger/post-moves'
import { reasonWords } from '../../../platform/reasons/service'
import { activeHoldsOf, type ActiveHold } from '../../quality/holds/checks'
import { heldByQualityHolds } from '../../quality/holds/stock'
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
  type HideRow,
  type LotRow,
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
  // B-W2a-58 (the lead's follow-up of #973): stock under an ACTIVE quality hold is never offered; it is held, with the hold.
  const quality = await qualityHeldOf(db, stock, lots, hides)
  const lines = pickList({
    materials,
    items: new Map([...items.values()].map((item) => [item.id, pickItemOf(item)])),
    colours,
    stock: pickStockOf(quality.free, locations),
    lots: new Map([...lots.values()].map((lot) => [lot.id, pickLotOf(lot)])),
    hides: new Map([...hides.values()].map((hide) => [hide.id, pickHideOf(hide)])),
    atWorkOrder,
    cuts,
  }).map((line) => withHolds(line, quality.held))
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

// ---- quality holds (B-W2a-26) in the pick list -----------------------------------------------------------------------------

/** The hold behind a held entry: its reason (both languages, for the screens' own words) and since when. */
export interface PickHold {
  readonly id: string
  readonly subjectType: 'Lot' | 'Hide'
  readonly reasonCode: string
  readonly reasonIt: string
  readonly reasonEn: string
  readonly placedAt: string
}

/** A held entry of a line for stock under a quality hold: the lot (all its stock), or one hide of a lot that is not held. */
export interface QualityHeldEntry {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly reason: 'QUALITY_HOLD'
  readonly words: string
  readonly lotId: string
  readonly lotCode: string
  readonly onHand: string
  readonly hides: number
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly hold: PickHold
}

/**
 * The site's balances split by the quality holds (B-W2a-26; QHS-074): `free` is what the pick list may offer (a balance a
 * lot status already holds stays there: the pick list says that reason itself), `held` the entries of the lots and hides
 * an ACTIVE hold holds, with the hold in words ("Lot … is on hold (Supplier check, since 21 Nov 2026): …", the issue's
 * own refusal). Releasing the hold offers the stock again on the next read.
 */
export async function qualityHeldOf(db: Reader, stock: readonly Balance[], lots: ReadonlyMap<string, LotRow>, hides: ReadonlyMap<string, HideRow>): Promise<{ free: Balance[]; held: QualityHeldEntry[] }> {
  const quality = await heldByQualityHolds(db, { lotIds: stock.map((row) => row.lotId), hideIds: stock.map((row) => row.hideId) })
  const offered = (row: Balance) => usabilityOf(row.lotId ? (lots.has(row.lotId) ? pickLotOf(lots.get(row.lotId)!) : null) : null).usable
  const isHeld = (row: Balance) => quality.holds(row) && offered(row)
  const heldRows = stock.filter(isHeld)
  if (heldRows.length === 0) return { free: [...stock], held: [] }
  const lotHolds = await activeHoldsOf(db, 'Lot', heldRows.map((row) => row.lotId))
  const hideHolds = await activeHoldsOf(db, 'Hide', heldRows.map((row) => row.hideId))
  const reasons = await reasonWords(db as Prisma.TransactionClient, 'HOLD')
  const holdOf = (hold: ActiveHold, subjectType: 'Lot' | 'Hide'): PickHold => {
    const reason = reasons.get(hold.reasonCode)
    return { id: hold.id, subjectType, reasonCode: hold.reasonCode, reasonIt: reason?.labelIt ?? hold.reasonCode, reasonEn: reason?.labelEn ?? hold.reasonCode, placedAt: toUtcIso(hold.placedAt) }
  }
  const entries = new Map<string, QualityHeldEntry & { hideSet: Set<string> }>()
  for (const row of heldRows) {
    const lot = row.lotId ? lots.get(row.lotId) : undefined
    const lotHold = row.lotId ? lotHolds.find((hold) => hold.subjectIds.includes(row.lotId!)) : undefined
    const hide = row.hideId ? hides.get(row.hideId) : undefined
    const hideHold = !lotHold && row.hideId ? hideHolds.find((hold) => hold.subjectIds.includes(row.hideId!)) : undefined
    const hold = lotHold ? holdOf(lotHold, 'Lot') : hideHold ? holdOf(hideHold, 'Hide') : null
    if (!hold || !row.lotId || !lot) continue
    const key = hold.subjectType === 'Lot' ? `lot|${row.lotId}` : `hide|${row.hideId}`
    const label = hold.subjectType === 'Lot' ? lot.code : (hide?.code ?? '')
    const entry = entries.get(key) ?? {
      itemId: row.itemId,
      itemColourId: row.itemColourId,
      reason: 'QUALITY_HOLD' as const,
      words: blockedWords({ holdId: hold.id, subjectType: hold.subjectType, label, reason: hold.reasonEn, placedAt: hold.placedAt }, hold.subjectType === 'Lot' ? 'its stock is not issued' : 'it is not issued'),
      lotId: row.lotId,
      lotCode: lot.code,
      onHand: '0.0000',
      hides: 0,
      hideId: hold.subjectType === 'Hide' ? row.hideId : null,
      hideCode: hold.subjectType === 'Hide' ? (hide?.code ?? null) : null,
      hold,
      hideSet: new Set<string>(),
    }
    if (row.hideId) entry.hideSet.add(row.hideId)
    entries.set(key, { ...entry, onHand: quantityText(new Dec(entry.onHand).plus(row.onHand)), hides: entry.hideSet.size })
  }
  const held = [...entries.values()].map(({ hideSet: _hides, ...entry }) => entry)
  return { free: stock.filter((row) => !isHeld(row)), held }
}

/** A pick list line with the quality-held entries of its material and colour after the ones its lots' state holds. */
export function withHolds<Line extends { readonly itemId: string; readonly itemColourId: string | null; readonly held: readonly object[] }>(line: Line, held: readonly QualityHeldEntry[]): Line {
  const mine = held
    .filter((entry) => entry.itemId === line.itemId && entry.itemColourId === line.itemColourId)
    .map(({ itemId: _item, itemColourId: _colour, ...entry }) => entry)
    .sort((a, b) => (a.lotCode < b.lotCode ? -1 : a.lotCode > b.lotCode ? 1 : (a.hideCode ?? '') < (b.hideCode ?? '') ? -1 : 1))
  return mine.length === 0 ? line : { ...line, held: [...line.held, ...mine] }
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
