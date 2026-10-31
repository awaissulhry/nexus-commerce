import type { Uom } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { availabilityOf } from '@nexus/factory-domain/inventory/reservations/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PRODUCTION_SCRAP } from '@nexus/factory-domain/production/scrap/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { actorOf, type OfficeContext } from '../../../core/context'
import { readHides, readLots, readSiteStock } from '../../inventory/issue/store'
import { completeKeys, postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { ReservationRefusedError } from '../../inventory/reservations/reserve'
import { demandWords, lockReservations, readDemands, readKeyFacts, reserveKeyOf, type ReserveKey } from '../../inventory/reservations/store'

/**
 * Scrap posts stock by lot (B-W2a-13; MES-129; design production.scrap "lot and area leaving stock", Movements "SCRAP
 * moves by lot and area"): material scrapped for a work order while it is still in stock (a damaged remnant or part of
 * a hide at the cutting rack, a lot of lining at the line side) leaves stock as SCRAP moves by lot, for the work order
 * (StockMove.workOrderId: the cost ledger's SCRAP entry of the work order names it, B-W2a-21), valued by the stock
 * ledger in the command (the lot's cost, else the standard cost). Office, production.scrap. ONE command():
 *
 *   the work order (RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED: material scrapped for it) → the reason (an active
 *   SCRAP reason of the tenant's floor list, ScrapReason) → the lines: an area of a hide (from the location named, or
 *   the one holding it), a lot or untracked material by quantity from a location → the reserve lock of each item and
 *   colour (inventory reservations: after the work order, before the stock): a hide another demand reserves is refused in
 *   words → postMoves (inventory/ledger, the ONE way stock moves): SCRAP moves, reasonCode + note `<CODE>: <note>`, reference the
 *   work order's number, keys `production.scrap:<Idempotency-Key>:<n>` → a hide left with nothing is SCRAPPED (final) →
 *   the audit row (record `ProductionScrap`, id = the first move's) and production.scrap_posted.
 *
 * The answer says, in words, which keys the scrap leaves over-reserved (the reservations stay; a reservation of this
 * work order is not refused, its stock is simply gone): never a silent refusal. Its value is the cost grain.
 *
 * A garment scrapped at an operation (a scan's scrap, a rework's) moves no stock again: its leather left stock when it
 * was issued to the work order. The scrap list (views.ts) says which lot and hide lost how much area.
 */

export interface ScrapStockLine {
  readonly hideId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly fromLocationId?: string | undefined
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
}

export interface ScrapStockInput {
  readonly workOrderId: string
  readonly reasonCode: string
  readonly note?: string | undefined
  readonly sourceScanId?: string | undefined
  readonly reworkOrderId?: string | undefined
  readonly lines: readonly ScrapStockLine[]
}

const SCRAP_STATUSES = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'] as const
const path = (index: number, field?: string) => `body/lines/${index}${field ? `/${field}` : ''}`

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** POST /production/scrap/stock. */
export async function scrapStock(caller: CommandCaller, body: ScrapStockInput, idempotencyKey?: string) {
  const context = officeOf(caller)
  const order = await caller.withClient((client) => client.workOrder.findUnique({ where: { id: body.workOrderId }, select: { id: true, companyId: true, siteId: true } }))
  if (!order || !can(actorOf(context), PRODUCTION_SCRAP, order)) throw new NotFoundError('Work order not found.')
  const shape = body.lines.flatMap((line, index) => {
    if (line.hideId) return line.itemId || line.lotId ? [{ path: path(index), message: 'A hide names its own lot and material: send the hide alone.' }] : []
    if (!line.itemId && !line.lotId) return [{ path: path(index, 'itemId'), message: 'Name the material, its lot, or a hide.' }]
    if (!line.fromLocationId) return [{ path: path(index, 'fromLocationId'), message: 'Name the location it leaves.' }]
    if (!line.quantity) return [{ path: path(index, 'quantity'), message: 'Name how much is scrapped.' }]
    return []
  })
  if (shape.length > 0) throw new ValidationError(shape[0]!.message, shape)
  const withCost = heldGrains(actorOf(context)).has('cost')
  const { result } = await command(caller, { name: 'production.scrapStock', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const workOrder = (await tx.workOrder.findUnique({ where: { id: order.id }, select: { id: true, companyId: true, siteId: true, number: true, status: true } }))!
    if (!(SCRAP_STATUSES as readonly string[]).includes(workOrder.status)) {
      throw new ValidationError(`Work order ${workOrder.number} is ${workOrder.status}: material is scrapped for it while it is RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED.`, [{ path: 'body/workOrderId', message: 'Not a work order material is scrapped for now.' }])
    }
    const reason = await tx.scrapReason.findFirst({ where: { kind: 'SCRAP', code: body.reasonCode }, select: { code: true, active: true, labelEn: true } })
    if (!reason || !reason.active) throw new ValidationError(`${body.reasonCode} is not an active scrap reason.`, [{ path: 'body/reasonCode', message: 'Pick an active scrap reason of the floor list.' }])
    if (body.sourceScanId && !(await tx.operationScan.findFirst({ where: { id: body.sourceScanId, workOrderId: workOrder.id }, select: { id: true } }))) {
      throw new ValidationError('That scan is not of this work order.', [{ path: 'body/sourceScanId', message: 'A scan of this work order.' }])
    }
    if (body.reworkOrderId && !(await tx.reworkOrder.findFirst({ where: { id: body.reworkOrderId, workOrderId: workOrder.id }, select: { id: true } }))) {
      throw new ValidationError('That rework is not of this work order.', [{ path: 'body/reworkOrderId', message: 'A rework of this work order.' }])
    }
    const note = body.note?.trim() ? `${reason.code}: ${body.note.trim()}` : `${reason.code}: ${reason.labelEn}`

    const hides = await readHides(tx, body.lines.flatMap((line) => (line.hideId && isUuid(line.hideId) ? [line.hideId] : [])))
    const lots = await readLots(tx, body.lines.flatMap((line) => (!line.hideId && !line.itemId && line.lotId && isUuid(line.lotId) ? [line.lotId] : [])))
    const drafts: MoveDraft[] = []
    const lineOf: number[] = []
    for (const [index, line] of body.lines.entries()) {
      // B-W2b-15: the floor list's code is the move's own column (the SCRAP list's usage counts read it).
      const common = { siteId: workOrder.siteId, reason: 'SCRAP' as const, workOrderId: workOrder.id, note, reasonCode: reason.code, reference: workOrder.number }
      if (line.hideId) {
        const hide = hides.get(line.hideId)
        if (!hide || hide.siteId !== workOrder.siteId) throw new ValidationError('Not a hide of this site.', [{ path: path(index, 'hideId'), message: 'Not a hide of this site.' }])
        const held = (await readSiteStock(tx, workOrder.siteId, { itemIds: [hide.itemId], hideId: hide.id })).filter((balance) => !line.fromLocationId || balance.locationId === line.fromLocationId)
        if (held.length === 0) throw new ValidationError(`Hide ${hide.code} is not in stock${line.fromLocationId ? ' at that location' : ''} (${hide.state}): only stock in a location is scrapped here.`, [{ path: path(index, 'hideId'), message: 'Not in stock.' }])
        if (line.quantity && held.length > 1) throw new ValidationError(`Hide ${hide.code} is at ${held.length} locations: name the one its area leaves.`, [{ path: path(index, 'fromLocationId'), message: 'Name the location.' }])
        for (const balance of held) {
          drafts.push({ ...common, itemId: hide.itemId, lotId: hide.lotId, hideId: hide.id, fromLocationId: balance.locationId, quantity: line.quantity ?? quantityText(balance.onHand), ...(line.uom ? { uom: line.uom } : {}) })
          lineOf.push(index)
        }
      } else {
        const itemId = line.itemId ?? (line.lotId ? lots.get(line.lotId)?.itemId : undefined)
        if (!itemId) throw new ValidationError('Name the material.', [{ path: path(index, 'itemId'), message: 'Name the material, its lot, or a hide.' }])
        drafts.push({ ...common, itemId, ...(line.itemColourId !== undefined ? { itemColourId: line.itemColourId } : {}), ...(line.lotId !== undefined ? { lotId: line.lotId } : {}), hideId: null, fromLocationId: line.fromLocationId!, quantity: line.quantity!, ...(line.uom ? { uom: line.uom } : {}) })
        lineOf.push(index)
      }
    }

    // The reserve lock of each item and colour; a hide another demand reserves is refused in words (release it first).
    const keyed = await completeKeys(tx, drafts)
    const keys = new Map<string, ReserveKey>(keyed.map((draft) => [reserveKeyOf({ siteId: workOrder.siteId, itemId: draft.itemId, itemColourId: draft.itemColourId }), { siteId: workOrder.siteId, itemId: draft.itemId, itemColourId: draft.itemColourId }]))
    await lockReservations(tx, context.tenantId, [...keys.values()])
    const hideIds = [...hides.keys()]
    if (hideIds.length > 0) {
      const holding = await tx.reservation.findMany({ where: { hideId: { in: hideIds }, status: 'ACTIVE', NOT: { workOrderId: workOrder.id } }, select: { id: true, hideId: true, workOrderId: true, salesOrderLineId: true } })
      if (holding.length > 0) {
        const demands = await readDemands(tx, holding, { withOrders: true })
        const issues = holding.map((row) => ({ path: path(body.lines.findIndex((line) => line.hideId === row.hideId), 'hideId'), message: `Hide ${hides.get(row.hideId!)?.code} is reserved for ${demandWords(row, demands)}: release that reservation first.` }))
        throw new ReservationRefusedError(issues.length === 1 ? issues[0]!.message : `${issues.length} hides are reserved for other work: release their reservations first.`, issues)
      }
    }

    const moves = await postMoves(tools, keyed, { key: `production.scrap:${idempotencyKey ?? `g-${newId()}`}`, issuePath: (index) => path(lineOf[index]!) })
    // A hide left with nothing in stock is scrapped for good (the …_production_leftovers_guards trigger keeps SCRAPPED).
    const scrappedHides: string[] = []
    const hideLeft = new Map<string, Decimal>()
    for (const hide of hides.values()) {
      const left = (await readSiteStock(tx, workOrder.siteId, { itemIds: [hide.itemId], hideId: hide.id })).reduce((sum, balance) => sum.plus(balance.onHand), ZERO)
      hideLeft.set(hide.id, left)
      if (left.gt(0)) continue
      await tx.hide.update({ where: { id: hide.id }, data: { state: 'SCRAPPED', version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'inventory.hideState', recordType: 'Hide', recordId: hide.id, companyId: workOrder.companyId, siteId: workOrder.siteId, before: { state: hide.state }, after: { state: 'SCRAPPED' }, reason: note })
      scrappedHides.push(hide.id)
    }

    // What the scrap leaves over-reserved, in words (the reservations stay; the stock is gone either way): a hide this
    // work order reserves whole holds less than its reservation now; a material and colour reserved beyond its stock.
    const overReserved = []
    for (const hide of hides.values()) {
      const open = (await tx.reservation.findMany({ where: { hideId: hide.id, status: 'ACTIVE' }, select: { quantity: true, issuedQuantity: true } })).reduce((sum, row) => sum.plus(new Dec(row.quantity.toString()).minus(new Dec(row.issuedQuantity.toString()))), ZERO)
      const left = hideLeft.get(hide.id) ?? ZERO
      if (open.lte(left)) continue
      const item = await tx.item.findUnique({ where: { id: hide.itemId }, select: { baseUom: true } })
      overReserved.push({
        itemId: hide.itemId,
        itemColourId: keyed.find((draft) => draft.hideId === hide.id)?.itemColourId ?? null,
        hideId: hide.id,
        available: quantityText(left),
        reserved: quantityText(open),
        words: `Hide ${hide.code} is reserved whole (${quantityText(open)} ${item?.baseUom ?? ''}) but holds ${quantityText(left)} ${item?.baseUom ?? ''} after this scrap: the reservation stays; release it or reserve more for the rest.`,
      })
    }
    for (const entry of keys.values()) {
      const facts = await readKeyFacts(tx, entry, { withOrders: true })
      const figures = availabilityOf(facts.stock, facts.reservations)
      if (!figures.overReserved) continue
      const item = await tx.item.findUnique({ where: { id: entry.itemId }, select: { code: true, baseUom: true } })
      overReserved.push({
        itemId: entry.itemId,
        itemColourId: entry.itemColourId,
        hideId: null,
        available: quantityText(figures.available),
        reserved: quantityText(figures.reserved),
        words: `${item?.code ?? 'This material'} is now reserved beyond what is in stock: ${quantityText(figures.reserved)} ${item?.baseUom ?? ''} reserved, ${quantityText(figures.available)} available. Release or move a reservation, or buy more.`,
      })
    }

    const scrapId = moves[0]!.id
    const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
    const lotIds = [...new Set(moves.flatMap((move) => (move.lotId ? [move.lotId] : [])))]
    tools.audit({
      action: 'production.scrapStock',
      recordType: 'ProductionScrap',
      recordId: scrapId,
      ...scope,
      after: { workOrderId: workOrder.id, reasonCode: reason.code, moveIds: moves.map((move) => move.id), hideIds, scrappedHides, sourceScanId: body.sourceScanId ?? null, reworkOrderId: body.reworkOrderId ?? null },
      reason: note,
    })
    tools.audit({ action: 'production.scrapStock', recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after: { scrapId, moveIds: moves.map((move) => move.id) }, reason: note })
    tools.emit({
      type: 'production.scrap_posted',
      subject: workOrder.id,
      ...scope,
      payload: {
        workOrderId: workOrder.id,
        number: workOrder.number,
        scrapId,
        moveIds: moves.map((move) => move.id),
        itemIds: [...new Set(moves.map((move) => move.itemId))],
        lotIds,
        hideIds,
        sourceScanId: body.sourceScanId ?? null,
        reworkOrderId: body.reworkOrderId ?? null,
      },
    })
    const valuations = withCost ? await tx.stockValuation.findMany({ where: { moveId: { in: moves.map((move) => move.id) } }, select: { moveId: true, valueAmount: true, currency: true } }) : []
    const byCurrency = new Map<string, number>()
    for (const row of valuations) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) - row.valueAmount)
    return {
      scrap: {
        id: scrapId,
        workOrderId: workOrder.id,
        number: workOrder.number,
        reasonCode: reason.code,
        note,
        moves: moves.map((move) => ({ id: move.id, itemId: move.itemId, lotId: move.lotId, hideId: move.hideId, fromLocationId: move.fromLocationId, quantity: new Dec(move.quantity).toFixed(4), uom: move.uom, baseQuantity: new Dec(move.baseQuantity).toFixed(4) })),
        scrappedHides,
        ...(withCost ? { values: asMoney('cost', { valued: valuations.length, moves: moves.length, byCurrency: [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount: asMoney('cost', amount) })) }) } : {}),
      },
      overReserved,
    }
  })
  return result
}
