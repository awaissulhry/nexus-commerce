import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { decimalOf, UNITS } from '@nexus/factory-domain/product/units/units'
import { lineDaysOut } from '@nexus/factory-domain/purchasing/subcontract-depth/ageing'
import {
  adjustmentProblems,
  balanceOpen,
  declarationProblems,
  lineBalanceOf,
  movesOf,
  shareBackOf,
  suggestionOf,
  unscrapPlan,
  type ConsumptionKind,
  type LineFacts,
  type Quantities,
} from '@nexus/factory-domain/purchasing/subcontract-depth/balance'
import { PURCHASING_SUBCONTRACT_BALANCE } from '@nexus/factory-domain/purchasing/subcontract-depth/permissions'
import { materialBackOf } from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import type { SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { postCostsInCommand } from '../../costing/actual/post'
import { postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { type Reader } from '../store'
import { officeOrder, readOperations, readOrder, type OrderRow } from '../subcontracting/store'
import { storedReceipts } from '../subcontracting/views'
import { inWords } from './guarded'

/**
 * The material balance per job (B-W2b-331; SCM-143, SCM-144, follow-up TZ1:01; design purchasing.subcontracting record tab
 * "Material balance": a bridge per material "sent 240 → in garments 198 → returned 20 → scrap 12 → open 10 (flagged)",
 * "Book over- or under-consumption the workshop reports (ActionConfirm)"; factory-db SubcontractConsumption, B-W2b-285).
 * Office only; no money here (design: "No money in this section").
 *
 *   read     GET …/orders/:id/balance (purchasing.view): per SENT kit line its material, colour, lot, hide and unit; sent, the
 *            workshop's kit check (B-W2b-176), what its send-back notices announce, what came back into our places with the
 *            order's receipts, used / returned / scrapped as declared and adjusted, the open rest, the days it has been out,
 *            its flags in words, the rows (who booked what, when, why), a suggested declaration; the order's "balance open"
 *   declare  POST …/balance/declare (purchasing.subcontract.balance): the workshop's declaration with the goods back, one
 *            DECLARED row per kit line named (optionally with the receipt it came with)
 *   adjust   POST …/balance/adjust (the same): one ADJUSTMENT row of one kit line, signed, with its reason (SCM-143)
 *
 * Each is ONE command on the order (its version bump holds the row): the rows (seq = the line's last + 1; the database checks
 * the sums under a lock per kit line), then ONE postMoves batch that moves our stock where the material went — used: ISSUE
 * from the workshop's place to the work order (less used: RETURN from the work order into the place); scrapped: SCRAP at the
 * place (less scrap: the latest scrap moves of the line reversed whole, the rest scrapped again); returned moves nothing
 * (the receive brings it back) — each move keyed `purchasing.subcontract.balance:<row>:<what>`, then the work order's cost
 * ledger for those moves (costing's postCostsInCommand), so the workshop's place holds what is still out and the work order
 * carries the material its garments used.
 */

const MOVE_KEY = 'purchasing.subcontract.balance'
const moveKey = (rowId: string, what: string) => `${MOVE_KEY}:${rowId}:${what}`

const KIT_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  status: true,
  sentAt: true,
  moveId: true,
  receivedByWorkshopAt: true,
  receivedByWorkshopQuantity: true,
  receivedByWorkshopNote: true,
} as const satisfies Prisma.SubcontractKitLineSelect
type KitRow = Prisma.SubcontractKitLineGetPayload<{ select: typeof KIT_COLUMNS }>

const ROW_COLUMNS = {
  id: true,
  kitLineId: true,
  seq: true,
  kind: true,
  receiptId: true,
  usedQuantity: true,
  returnedQuantity: true,
  scrappedQuantity: true,
  reportedAt: true,
  reasonCode: true,
  reason: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SubcontractConsumptionSelect
type ConsumptionRow = Prisma.SubcontractConsumptionGetPayload<{ select: typeof ROW_COLUMNS }>

const q4 = (value: { toFixed(places: number): string }): string => value.toFixed(4)
const goodsKey = (row: { itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null }) => `${row.itemId}|${row.itemColourId}|${row.lotId}|${row.hideId}`
const named = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((row) => [row.id, row]))
const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const today = (): BusinessDate => businessDate(new Date())

/** A quantity of the kit line's unit in base units (the line's own ratio), 4 places. */
const inBase = (quantity: Decimal, line: KitRow): string =>
  (decimalOf(line.quantity.toString()).isZero() ? quantity : quantity.times(decimalOf(line.baseQuantity.toString())).div(decimalOf(line.quantity.toString()))).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

/** A base quantity in the kit line's unit (the line's own ratio). */
const inLineUnit = (base: Decimal, line: KitRow): Decimal => (decimalOf(line.baseQuantity.toString()).isZero() ? base : base.times(decimalOf(line.quantity.toString())).div(decimalOf(line.baseQuantity.toString())))

export interface BalanceFacts {
  readonly order: OrderRow
  readonly lines: KitRow[]
  readonly rows: ConsumptionRow[]
  /** Per kit line, in its unit: what came back into our places with the order's receipts. */
  readonly back: Map<string, Decimal>
  /** Per kit line, in its unit: what the workshop's ANNOUNCED send-backs say comes back. */
  readonly announced: Map<string, Decimal>
  readonly operations: Awaited<ReturnType<typeof readOperations>>
}

/** What the balance reads of one order (the SENT kit lines, their rows, what came back, what is announced). */
export async function balanceFacts(db: Reader, order: OrderRow): Promise<BalanceFacts> {
  const lines = await db.subcontractKitLine.findMany({ where: { subcontractOrderId: order.id, status: 'SENT' }, select: KIT_COLUMNS, orderBy: { seq: 'asc' } })
  const rows = lines.length === 0 ? [] : await db.subcontractConsumption.findMany({ where: { kitLineId: { in: lines.map((line) => line.id) } }, select: ROW_COLUMNS, orderBy: [{ kitLineId: 'asc' }, { seq: 'asc' }] })
  const operations = await readOperations(db, order.id)
  // The material back with the receipts: the receive's moves out of the workshop's place, by material, colour, lot, hide.
  const receipts = await storedReceipts(db, order.id)
  const moveIds = unique(receipts.flatMap((receipt) => receipt.returns.map((row) => row.moveId)))
  const moves = moveIds.length === 0 ? [] : await db.stockMove.findMany({ where: { id: { in: moveIds } }, select: { id: true, itemId: true, itemColourId: true, lotId: true, hideId: true, baseQuantity: true } })
  const pool = new Map<string, Decimal>()
  for (const move of moves) pool.set(goodsKey(move), (pool.get(goodsKey(move)) ?? new Dec(0)).plus(decimalOf(move.baseQuantity.toString())))
  const back = new Map<string, Decimal>()
  // Lines of the same goods share what came back in their order, each up to what it sent; the last one takes the rest.
  const byGoods = new Map<string, KitRow[]>()
  for (const line of lines) byGoods.set(goodsKey(line), [...(byGoods.get(goodsKey(line)) ?? []), line])
  for (const [key, group] of byGoods) {
    let left = pool.get(key) ?? new Dec(0)
    for (const [index, line] of group.entries()) {
      const sent = decimalOf(line.baseQuantity.toString())
      const take = index === group.length - 1 ? left : Dec.min(left, sent)
      back.set(line.id, inLineUnit(take, line))
      left = left.minus(take)
    }
  }
  const notices = await db.subcontractReturnNotice.findMany({ where: { subcontractOrderId: order.id, status: 'ANNOUNCED' }, select: { materialBack: true } })
  const announced = new Map<string, Decimal>()
  for (const notice of notices) for (const entry of materialBackOf(notice.materialBack)) announced.set(entry.kitLineId, (announced.get(entry.kitLineId) ?? new Dec(0)).plus(decimalOf(entry.quantity)))
  return { order, lines, rows, back, announced, operations }
}

const factsOfRow = (row: ConsumptionRow) => ({ kind: row.kind as ConsumptionKind, used: row.usedQuantity.toString(), returned: row.returnedQuantity.toString(), scrapped: row.scrappedQuantity.toString() })

const lineFactsOf = (facts: BalanceFacts, line: KitRow): LineFacts => ({
  sent: q4(line.quantity),
  uom: line.uom,
  checked: line.receivedByWorkshopQuantity === null ? null : q4(line.receivedByWorkshopQuantity),
  back: q4(facts.back.get(line.id) ?? new Dec(0)),
  rows: facts.rows.filter((row) => row.kitLineId === line.id).map(factsOfRow),
})

/** The order's goods back, as the balance reads it. */
const backOfOrder = (order: OrderRow, operations: BalanceFacts['operations']) => ({
  allBack: order.status === 'RECEIVED' || order.status === 'CLOSED',
  someBack: operations.some((row) => row.piecesBackGood + row.piecesBackDefective + row.piecesScrapped > 0),
})

function heldToBook(context: OfficeContext, order: OrderRow, facts: BalanceFacts): string | null {
  if (!can(actorOf(context), PURCHASING_SUBCONTRACT_BALANCE, { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId })) return 'Booking the material balance needs purchasing.subcontract.balance.'
  if (facts.lines.length === 0) return 'Nothing was sent yet: the balance starts with the kit.'
  return null
}

/** The Material balance tab of the order. */
export async function balanceView(db: Reader, context: OfficeContext, order: OrderRow) {
  const facts = await balanceFacts(db, order)
  const day = today()
  const items = named(await db.item.findMany({ where: { id: { in: unique(facts.lines.map((line) => line.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true } }))
  const colours = named(await db.itemColour.findMany({ where: { id: { in: unique(facts.lines.map((line) => line.itemColourId)) } }, select: { id: true, code: true, name: true } }))
  const lots = named(await db.lot.findMany({ where: { id: { in: unique(facts.lines.map((line) => line.lotId)) } }, select: { id: true, code: true } }))
  const hides = named(await db.hide.findMany({ where: { id: { in: unique(facts.lines.map((line) => line.hideId)) } }, select: { id: true, code: true } }))
  const receipts = new Map((await db.subcontractReceipt.findMany({ where: { subcontractOrderId: order.id }, select: { id: true, seq: true, receivedAt: true } })).map((row) => [row.id, row]))
  const people = named(await db.user.findMany({ where: { id: { in: unique(facts.rows.map((row) => row.createdById)) } }, select: { id: true, displayName: true } }))
  const back = backOfOrder(order, facts.operations)
  const shareBack = shareBackOf(facts.operations)
  const held = heldToBook(context, order, facts)
  const lines = facts.lines.map((line) => {
    const lineFacts = lineFactsOf(facts, line)
    const balance = lineBalanceOf(lineFacts, back)
    const item = items.get(line.itemId)
    const declared = lineFacts.rows.some((row) => row.kind === 'DECLARED')
    return {
      kitLineId: line.id,
      seq: line.seq,
      item: item ? { id: item.id, code: item.code, name: item.name } : { id: line.itemId, code: '', name: '' },
      colour: line.itemColourId ? (colours.get(line.itemColourId) ?? { id: line.itemColourId, code: '', name: '' }) : null,
      lot: line.lotId ? (lots.get(line.lotId) ?? { id: line.lotId, code: '' }) : null,
      hide: line.hideId ? (hides.get(line.hideId) ?? { id: line.hideId, code: '' }) : null,
      uom: line.uom,
      sentAt: line.sentAt ? toUtcIso(line.sentAt) : null,
      ...balance,
      checkedByWorkshop: line.receivedByWorkshopQuantity === null ? null : { quantity: q4(line.receivedByWorkshopQuantity), at: line.receivedByWorkshopAt ? toUtcIso(line.receivedByWorkshopAt) : null, note: line.receivedByWorkshopNote },
      announcedBack: q4(facts.announced.get(line.id) ?? new Dec(0)),
      backInOurPlaces: lineFacts.back,
      daysOut: lineDaysOut(line.sentAt, balance.open, day),
      rows: facts.rows
        .filter((row) => row.kitLineId === line.id)
        .map((row) => ({
          id: row.id,
          seq: row.seq,
          kind: row.kind as ConsumptionKind,
          used: q4(row.usedQuantity),
          returned: q4(row.returnedQuantity),
          scrapped: q4(row.scrappedQuantity),
          receipt: row.receiptId ? { id: row.receiptId, seq: receipts.get(row.receiptId)?.seq ?? 0 } : null,
          reportedAt: toUtcIso(row.reportedAt),
          reasonCode: row.reasonCode,
          reason: row.reason,
          bookedAt: toUtcIso(row.createdAt),
          bookedBy: row.createdById ? (people.get(row.createdById)?.displayName ?? null) : null,
        })),
      suggestion: suggestionOf({ line: lineFacts, shareBack }),
      actions: {
        declare: held ?? (decimalOf(balance.open).greaterThan(0) ? null : 'Nothing of it is open: every part is declared.'),
        adjust: held ?? (declared ? null : 'The workshop has not declared this material yet: book its declaration first.'),
      },
    }
  })
  return {
    order: { id: order.id, number: order.number, status: order.status as SubcontractOrderStatus, version: order.version, allBack: back.allBack, someBack: back.someBack },
    balanceOpen: balanceOpen(lines, back),
    lines,
    receipts: [...receipts.values()].sort((a, b) => a.seq - b.seq).map((row) => ({ id: row.id, seq: row.seq, receivedAt: toUtcIso(row.receivedAt) })),
    actions: { declare: held, adjust: held },
  }
}

/** GET /purchasing/subcontracting/orders/:subcontractOrderId/balance */
export async function orderBalance(caller: CommandCaller, orderId: string) {
  const { context, order } = await officeOrder(caller, orderId)
  return caller.withClient((client) => balanceView(client, context, order))
}

// ---- booking -------------------------------------------------------------------------------------------------------------

const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The material balance is not valid as it stands.', problems)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

interface RowDraft {
  readonly id: string
  readonly line: KitRow
  readonly kind: ConsumptionKind
  readonly change: Quantities
  readonly reasonCode: string | null
  readonly reason: string | null
}

/** The moves of the rows: ISSUE / RETURN for used, SCRAP and taking scrap back for scrapped (see the file's header). */
async function movesFor(tools: CommandTools, order: OrderRow, drafts: readonly RowDraft[], at: Date): Promise<MoveDraft[]> {
  const moves: MoveDraft[] = []
  for (const draft of drafts) {
    const plan = movesOf(draft.change)
    const goods = { siteId: order.siteId, itemId: draft.line.itemId, itemColourId: draft.line.itemColourId, lotId: draft.line.lotId, hideId: draft.line.hideId, uom: draft.line.uom, reference: order.number, occurredAt: at }
    const words = draft.reason ? `: ${draft.reason}`.slice(0, 300) : ''
    // A unit of the item's own size (a hide, a roll, a box …) carries its base quantity: the kit line's own ratio.
    const of = (quantity: string) => ({ quantity, ...(UNITS[draft.line.uom].reference === null ? { baseQuantity: inBase(decimalOf(quantity), draft.line) } : {}) })
    if (decimalOf(plan.issue).greaterThan(0)) {
      moves.push({ ...goods, ...of(plan.issue), reason: 'ISSUE', fromLocationId: order.locationId, workOrderId: order.workOrderId, note: `Used by the workshop in the goods of subcontract order ${order.number} (kit line ${draft.line.seq})${words}`, idempotencyKey: moveKey(draft.id, 'used') })
    }
    if (decimalOf(plan.giveBack).greaterThan(0)) {
      moves.push({ ...goods, ...of(plan.giveBack), reason: 'RETURN', toLocationId: order.locationId, workOrderId: order.workOrderId, note: `Less used by the workshop of subcontract order ${order.number} (kit line ${draft.line.seq})${words}`, idempotencyKey: moveKey(draft.id, 'less-used') })
    }
    if (decimalOf(plan.scrap).greaterThan(0)) {
      moves.push({ ...goods, ...of(plan.scrap), reason: 'SCRAP', fromLocationId: order.locationId, workOrderId: order.workOrderId, note: `Scrapped at the workshop of subcontract order ${order.number} (kit line ${draft.line.seq})${words}`, idempotencyKey: moveKey(draft.id, 'scrap') })
    }
    if (decimalOf(plan.unscrap).greaterThan(0)) {
      // The line's scrap moves standing (not reversed), oldest first; the newest are taken back whole.
      const standing = await standingScrapOf(tools, order, draft.line.id)
      const taken = unscrapPlan(standing, plan.unscrap)
      if (!taken) throw new ConflictError(`Kit line ${draft.line.seq}: the scrap booked at the workshop's place holds less than ${plan.unscrap} ${draft.line.uom} to take back.`)
      for (const moveId of taken.reverse) {
        // The scrap move taken back as it was: its locations swapped, its quantity, unit and base quantity.
        const original = standing.find((move) => move.id === moveId)!
        moves.push({ ...goods, quantity: original.quantity, uom: original.uom, baseQuantity: original.baseQuantity, reason: 'SCRAP', toLocationId: order.locationId, workOrderId: order.workOrderId, reversalOfId: moveId, note: `Less scrap declared by the workshop of subcontract order ${order.number}${words}`, idempotencyKey: moveKey(draft.id, `unscrap:${moveId}`) })
      }
      if (decimalOf(taken.scrapAgain).greaterThan(0)) {
        moves.push({ ...goods, ...of(taken.scrapAgain), reason: 'SCRAP', fromLocationId: order.locationId, workOrderId: order.workOrderId, note: `Scrapped at the workshop of subcontract order ${order.number} (kit line ${draft.line.seq}, booked again)${words}`, idempotencyKey: moveKey(draft.id, 'scrap-again') })
      }
    }
  }
  return moves
}

/** The SCRAP moves the balance booked for a kit line and that stand (not reversed), oldest first, in the line's unit. */
async function standingScrapOf(tools: CommandTools, order: OrderRow, kitLineId: string): Promise<{ id: string; quantity: string; uom: KitRow['uom']; baseQuantity: string }[]> {
  const rowIds = (await tools.tx.subcontractConsumption.findMany({ where: { kitLineId }, select: { id: true } })).map((row) => row.id)
  if (rowIds.length === 0) return []
  const keys = rowIds.flatMap((id) => [moveKey(id, 'scrap'), moveKey(id, 'scrap-again')])
  const moves = await tools.tx.stockMove.findMany({ where: { idempotencyKey: { in: keys }, reference: order.number, reason: 'SCRAP', reversalOfId: null }, select: { id: true, quantity: true, uom: true, baseQuantity: true, occurredAt: true }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
  const reversed = new Set((await tools.tx.stockMove.findMany({ where: { reversalOfId: { in: moves.map((move) => move.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId))
  return moves.filter((move) => !reversed.has(move.id)).map((move) => ({ id: move.id, quantity: q4(move.quantity), uom: move.uom, baseQuantity: q4(move.baseQuantity) }))
}

/** Writes the rows, moves the stock, posts the work order's material, audits and emits: the one body of both acts. */
async function bookRows(tools: CommandTools, order: OrderRow, kind: ConsumptionKind, drafts: readonly RowDraft[], options: { readonly receiptId: string | null; readonly reportedAt: Date; readonly periodLockOverride?: PeriodLockOverride | undefined }) {
  const { tx } = tools
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  for (const draft of drafts) {
    const last = await tx.subcontractConsumption.findFirst({ where: { kitLineId: draft.line.id }, select: { seq: true }, orderBy: { seq: 'desc' } })
    await tx.subcontractConsumption.create({
      data: {
        id: draft.id,
        siteId: order.siteId,
        workOrderId: order.workOrderId,
        partyId: order.partyId,
        subcontractOrderId: order.id,
        kitLineId: draft.line.id,
        seq: (last?.seq ?? 0) + 1,
        kind,
        receiptId: options.receiptId,
        usedQuantity: draft.change.used,
        returnedQuantity: draft.change.returned,
        scrappedQuantity: draft.change.scrapped,
        reportedAt: options.reportedAt,
        reasonCode: draft.reasonCode,
        reason: draft.reason,
        createdAt: tools.now,
        createdById: actorId,
      },
      select: { id: true },
    })
  }
  const drafted = await movesFor(tools, order, drafts, tools.now)
  const posted = drafted.length > 0 ? await postMoves(tools, drafted, { issuePath: (index) => `body/moves/${index}`, periodLockOverride: options.periodLockOverride }) : []
  const cost = posted.length > 0 ? await postCostsInCommand(tools, order.workOrderId, { moveIds: posted.map((move) => move.id) }) : { posted: [], waiting: [] }
  tools.audit({
    action: kind === 'DECLARED' ? 'purchasing.subcontract.balance.declare' : 'purchasing.subcontract.balance.adjust',
    recordType: 'SubcontractOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    after: {
      kind,
      receiptId: options.receiptId,
      reportedAt: toUtcIso(options.reportedAt),
      rows: drafts.map((draft) => ({ id: draft.id, kitLineId: draft.line.id, ...draft.change, reasonCode: draft.reasonCode, reason: draft.reason })),
      moveIds: posted.map((move) => move.id),
    },
    ...(kind === 'ADJUSTMENT' && drafts[0]?.reason ? { reason: drafts[0].reason } : {}),
  })
  tools.emit({
    type: 'subcontract_order.balance_booked',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { subcontractOrderId: order.id, number: order.number, status: order.status as SubcontractOrderStatus, partyId: order.partyId, kind, kitLineIds: drafts.map((draft) => draft.line.id), rowIds: drafts.map((draft) => draft.id), moves: posted.length },
  })
  return { rowIds: drafts.map((draft) => draft.id), moveIds: posted.map((move) => move.id), ledger: { posted: cost.posted.length, waiting: cost.waiting.map((entry) => entry.words) } }
}

export interface DeclareInput {
  readonly version: number
  readonly receiptId?: string | null | undefined
  readonly reportedAt?: string | undefined
  readonly lines: readonly { readonly kitLineId: string; readonly used: string; readonly returned: string; readonly scrapped: string; readonly reasonCode?: string | null | undefined; readonly reason?: string | null | undefined }[]
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

/** Checks the receipt (of this order) and the day it was reported (not in the future, not before the order went out). */
function whenProblems(order: OrderRow, reportedAt: Date, now: Date): Issue[] {
  if (reportedAt.getTime() > now.getTime() + 10 * 60_000) return [{ path: 'body/reportedAt', message: 'The workshop reported it now or before, not later.' }]
  if (order.issuedAt && reportedAt.getTime() < order.issuedAt.getTime()) return [{ path: 'body/reportedAt', message: 'The workshop reported it after the order was issued.' }]
  return []
}

async function receiptOf(tools: CommandTools, orderId: string, receiptId: string | null | undefined): Promise<Issue[]> {
  if (!receiptId) return []
  const receipt = isUuid(receiptId) ? await tools.tx.subcontractReceipt.findUnique({ where: { id: receiptId }, select: { subcontractOrderId: true } }) : null
  return receipt?.subcontractOrderId === orderId ? [] : [{ path: 'body/receiptId', message: 'Not a receipt of this order.' }]
}

/** POST /purchasing/subcontracting/orders/:subcontractOrderId/balance/declare */
export async function declareBalance(caller: CommandCaller, orderId: string, input: DeclareInput, idempotencyKey?: string) {
  const { context } = await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_BALANCE)
  if (input.lines.length === 0) throw refuse([{ path: 'body/lines', message: 'Declare at least one kit line.' }])
  const { result } = await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.balance.declare', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } }, async (tools) => {
      const order = (await readOrder(tools.tx, orderId))!
      if (order.status === 'DRAFT' || order.status === 'CANCELLED') throw new InvalidStateError(`The order is ${order.status === 'DRAFT' ? 'a draft' : 'cancelled'}: nothing of it went out.`)
      const facts = await balanceFacts(tools.tx, order)
      const reportedAt = input.reportedAt ? parseInstant(input.reportedAt)! : tools.now
      const problems = [...whenProblems(order, reportedAt, tools.now), ...(await receiptOf(tools, orderId, input.receiptId))]
      const drafts: RowDraft[] = []
      for (const [index, entry] of input.lines.entries()) {
        const at = `body/lines/${index}`
        const line = facts.lines.find((row) => row.id === entry.kitLineId)
        if (!line) {
          problems.push({ path: `${at}/kitLineId`, message: 'Not a kit line of this order that went out.' })
          continue
        }
        if (drafts.some((draft) => draft.line.id === line.id)) {
          problems.push({ path: `${at}/kitLineId`, message: `Kit line ${line.seq} is named twice: one declaration per line.` })
          continue
        }
        const change = { used: entry.used, returned: entry.returned, scrapped: entry.scrapped }
        problems.push(...declarationProblems(at, lineFactsOf(facts, line), { ...change, reasonCode: entry.reasonCode, reason: entry.reason }))
        drafts.push({ id: newId(), line, kind: 'DECLARED', change: { used: q4(decimalOf(entry.used)), returned: q4(decimalOf(entry.returned)), scrapped: q4(decimalOf(entry.scrapped)) }, reasonCode: blankToNull(entry.reasonCode), reason: blankToNull(entry.reason) })
      }
      if (problems.length > 0) throw refuse(problems)
      return bookRows(tools, order, 'DECLARED', drafts, { receiptId: input.receiptId ?? null, reportedAt: reportedAt.getTime() > tools.now.getTime() ? tools.now : reportedAt, periodLockOverride: input.periodLockOverride })
    }),
  )
  return { ...result, balance: await caller.withClient(async (client) => balanceView(client, context, (await readOrder(client, orderId))!)) }
}

export interface AdjustInput {
  readonly version: number
  readonly kitLineId: string
  readonly used?: string | undefined
  readonly returned?: string | undefined
  readonly scrapped?: string | undefined
  readonly reportedAt?: string | undefined
  readonly reasonCode?: string | null | undefined
  readonly reason: string
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

/** POST /purchasing/subcontracting/orders/:subcontractOrderId/balance/adjust (SCM-143) */
export async function adjustBalance(caller: CommandCaller, orderId: string, input: AdjustInput, idempotencyKey?: string) {
  const { context } = await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_BALANCE)
  const { result } = await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.balance.adjust', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } }, async (tools) => {
      const order = (await readOrder(tools.tx, orderId))!
      const facts = await balanceFacts(tools.tx, order)
      const reportedAt = input.reportedAt ? parseInstant(input.reportedAt)! : tools.now
      const problems = whenProblems(order, reportedAt, tools.now)
      const line = facts.lines.find((row) => row.id === input.kitLineId)
      if (!line) throw refuse([{ path: 'body/kitLineId', message: 'Not a kit line of this order that went out.' }])
      const change = { used: input.used ?? '0', returned: input.returned ?? '0', scrapped: input.scrapped ?? '0' }
      problems.push(...adjustmentProblems('body', lineFactsOf(facts, line), { ...change, reasonCode: input.reasonCode, reason: input.reason }))
      if (problems.length > 0) throw refuse(problems)
      const draft: RowDraft = { id: newId(), line, kind: 'ADJUSTMENT', change: { used: q4(decimalOf(change.used)), returned: q4(decimalOf(change.returned)), scrapped: q4(decimalOf(change.scrapped)) }, reasonCode: blankToNull(input.reasonCode), reason: blankToNull(input.reason) }
      return bookRows(tools, order, 'ADJUSTMENT', [draft], { receiptId: null, reportedAt: reportedAt.getTime() > tools.now.getTime() ? tools.now : reportedAt, periodLockOverride: input.periodLockOverride })
    }),
  )
  return { ...result, balance: await caller.withClient(async (client) => balanceView(client, context, (await readOrder(client, orderId))!)) }
}
