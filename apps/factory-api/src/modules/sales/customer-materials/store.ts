import type { Prisma } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { explodeExact } from '@nexus/factory-domain/product/bom-structure/explode'
import { apportion, expectedRows, leftOf, rowKey, shareReceived, type CountRow, type LineNeeds, type NeedPerPiece } from '@nexus/factory-domain/sales/customer-materials/rules'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { readExplosion } from '../../product/bom/explode'
import type { Reader } from '../orders/store'

/**
 * Customer-owned materials on the order (B-W2b-309; SAL-306; follow-up SO2:01): the rows (factory-db CustomerMaterial,
 * B-W2b-281) and how the module keeps them. The rules are factory-domain sales/customer-materials.
 *
 *   plan     `planInCommand`: per goods line of the order, its revision (the line's, else the style's newest RELEASED one)
 *            walked by B-W2b-223's explosion in each size and its colourway, with the options chosen on the line; every
 *            customer-supplied BOM line the ORDER'S customer supplies (BomLine.customerSuppliedByPartyId) gives a row: what
 *            the line's sizes need of it. Rows missing are made, rows whose expectation moved are changed, rows the BOM no
 *            longer asks are removed while nothing was received, used or returned of them (the database refuses otherwise).
 *   recount  `recountInCommand`: received, used and returned of every row of the customer for the materials named, from the
 *            moves of the customer's own lots (Lot.ownerPartyId): received = what came in (RECEIPT, OPENING) net of
 *            reversals, used = issued to work orders net of returns to stock (shared among the rows of the lines each work
 *            order makes, by what each expects), returned = SUPPLIER_RETURN moves back to the customer (to the order the move
 *            names by its number, else the newest row); received shared oldest order first (rules `shareReceived`).
 *   removed  `materialsOfRemovedLines`: an amendment that removes a line removes its rows first, refused in words when
 *            something of them was received, used or returned (the FK is Restrict).
 */

export const MATERIAL_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  orderId: true,
  orderLineId: true,
  bomRevisionId: true,
  bomLineId: true,
  itemId: true,
  itemColourId: true,
  uom: true,
  expectedQuantity: true,
  expectedBySize: true,
  receivedQuantity: true,
  usedQuantity: true,
  returnedQuantity: true,
  note: true,
  updatedById: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.CustomerMaterialSelect
export type MaterialRow = Prisma.CustomerMaterialGetPayload<{ select: typeof MATERIAL_COLUMNS }>

const q = (value: { toString(): string }): string => new Dec(value.toString()).toFixed(4)
const actorOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

interface OrderLike {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
}

/** What the order's goods lines need of the materials its customer supplies (one row per line, BOM line and colour). */
export async function expectedOfOrder(db: Reader, order: OrderLike, lineIds?: readonly string[]) {
  const lines = await db.salesOrderLine.findMany({
    where: { orderId: order.id, kind: { in: ['SIZE_GRID', 'MADE_TO_MEASURE'] }, ...(lineIds ? { id: { in: [...lineIds] } } : {}) },
    select: { id: true, seq: true, kind: true, styleId: true, styleRevisionId: true, colourwayId: true, baseSize: true, sizes: { select: { size: true, quantity: true } } },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
  })
  if (lines.length === 0) return { rows: [], problems: [] as string[], unread: [] as string[] }
  const styleIds = [...new Set(lines.filter((line) => line.styleRevisionId === null).map((line) => line.styleId))]
  const revisions = styleIds.length === 0 ? [] : await db.styleRevision.findMany({ where: { styleId: { in: styleIds } }, select: { id: true, styleId: true, revision: true, status: true }, orderBy: [{ revision: 'desc' }, { id: 'asc' }] })
  const releasedOf = new Map<string, string>()
  for (const revision of revisions) if (revision.status === 'RELEASED' && !releasedOf.has(revision.styleId)) releasedOf.set(revision.styleId, revision.id)
  // No released revision yet (a brand's style still being developed): its newest revision, said so.
  const newestOf = new Map<string, { id: string; revision: number }>()
  for (const revision of revisions) if (!newestOf.has(revision.styleId)) newestOf.set(revision.styleId, { id: revision.id, revision: revision.revision })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const options = await db.salesOrderLineOption.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, valueId: true } })
  const explosions = new Map<string, Awaited<ReturnType<typeof readExplosion>>>()
  const problems: string[] = []
  const unread: string[] = []
  const needs: LineNeeds[] = []
  for (const line of lines) {
    const newest = newestOf.get(line.styleId)
    const revisionId = line.styleRevisionId ?? releasedOf.get(line.styleId) ?? newest?.id ?? null
    if (revisionId === null) {
      problems.push(`Line ${line.seq}: its style has no revision, so its BOM is not read.`)
      unread.push(line.id)
      continue
    }
    if (line.styleRevisionId === null && !releasedOf.has(line.styleId) && newest) problems.push(`Line ${line.seq}: read from revision ${newest.revision}, not released yet.`)
    if (!explosions.has(revisionId)) explosions.set(revisionId, await readExplosion(db, revisionId))
    const read = explosions.get(revisionId)
    if (!read) {
      problems.push(`Line ${line.seq}: its revision cannot be read.`)
      unread.push(line.id)
      continue
    }
    const input = { top: read.top, revisions: read.revisions, unitsOf: (itemId: string) => read.materials.get(itemId)?.units, codeOf: (itemId: string) => read.materials.get(itemId)?.code ?? '?', options: new Set(options.filter((option) => option.lineId === line.id).map((option) => option.valueId)) }
    // A made-to-measure unit: one piece of its base size (as planning reads it); its row keeps no sizes.
    const sizes = line.kind === 'MADE_TO_MEASURE' ? [{ size: line.baseSize ?? '', pieces: 1 }] : line.sizes.map((size) => ({ size: size.size, pieces: size.quantity }))
    const needsBySize = new Map<string, NeedPerPiece[]>()
    for (const { size } of sizes) {
      const exact = explodeExact(input, { size, colourwayId: line.colourwayId, colourwayCode: colourways.get(line.colourwayId) ?? '' })
      needsBySize.set(
        size,
        exact.materials.filter((row) => row.customerSupplied).map((row) => ({ bomRevisionId: row.revisionId, bomLineId: row.lineId, itemId: row.itemId, itemColourId: row.itemColourId, uom: row.uom, perPiece: row.quantity.toFixed() })),
      )
    }
    needs.push({ orderLineId: line.id, sizes, needsBySize })
  }
  // Only the lines this customer supplies (a brand's material on another customer's order is not modelled: B-W2b-281's gap).
  const bomLineIds = [...new Set(needs.flatMap((line) => [...line.needsBySize.values()].flat().map((need) => need.bomLineId)))]
  const supplier = new Map((bomLineIds.length === 0 ? [] : await db.bomLine.findMany({ where: { id: { in: bomLineIds } }, select: { id: true, customerSuppliedByPartyId: true } })).map((row) => [row.id, row.customerSuppliedByPartyId]))
  const own = needs.map((line) => ({ ...line, needsBySize: new Map([...line.needsBySize.entries()].map(([size, list]) => [size, list.filter((need) => supplier.get(need.bomLineId) === order.partyId)])) }))
  const madeToMeasure = new Set(lines.filter((line) => line.kind === 'MADE_TO_MEASURE').map((line) => line.id))
  const rows = expectedRows(own).map((row) => (madeToMeasure.has(row.orderLineId) ? { ...row, expectedBySize: {} } : row))
  return { rows, problems, unread }
}

/** Makes, changes and removes the order's rows to what its lines need (all lines, or the ones named). Returns what moved. */
export async function planInCommand(tools: CommandTools, order: OrderLike, lineIds?: readonly string[]): Promise<{ made: number; changed: number; removed: number; kept: number; problems: string[] }> {
  const { tx, now } = tools
  const { rows, problems, unread } = await expectedOfOrder(tx, order, lineIds)
  // A line whose BOM could not be read keeps its rows as they are (never removed for want of a reading).
  const unreadable = new Set(unread)
  const existing = await tx.customerMaterial.findMany({ where: { orderId: order.id, ...(lineIds ? { orderLineId: { in: [...lineIds] } } : {}) }, select: MATERIAL_COLUMNS })
  const byKey = new Map(existing.map((row) => [rowKey(row), row]))
  const wanted = new Set(rows.map((row) => rowKey(row)))
  let made = 0
  let changed = 0
  let removed = 0
  let kept = 0
  for (const row of rows) {
    const known = byKey.get(rowKey(row))
    if (!known) {
      await tx.customerMaterial.create({
        data: { id: newId(), companyId: order.companyId, partyId: order.partyId, orderId: order.id, orderLineId: row.orderLineId, bomRevisionId: row.bomRevisionId, bomLineId: row.bomLineId, itemId: row.itemId, itemColourId: row.itemColourId, uom: row.uom as MaterialRow['uom'], expectedQuantity: row.expectedQuantity, expectedBySize: row.expectedBySize, updatedById: actorOf(tools), createdAt: now, updatedAt: now, createdById: actorOf(tools) },
        select: { id: true },
      })
      made += 1
      continue
    }
    const same = q(known.expectedQuantity) === row.expectedQuantity && JSON.stringify(known.expectedBySize ?? {}) === JSON.stringify(row.expectedBySize)
    if (same) continue
    await tx.customerMaterial.update({ where: { id: known.id }, data: { expectedQuantity: row.expectedQuantity, expectedBySize: row.expectedBySize, updatedById: actorOf(tools), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    changed += 1
  }
  for (const row of existing) {
    if (wanted.has(rowKey(row)) || unreadable.has(row.orderLineId)) continue
    if (new Dec(row.receivedQuantity.toString()).gt(0) || new Dec(row.usedQuantity.toString()).gt(0) || new Dec(row.returnedQuantity.toString()).gt(0)) {
      // Something came, was used or went back: the row stays with nothing expected.
      if (new Dec(row.expectedQuantity.toString()).gt(0)) await tx.customerMaterial.update({ where: { id: row.id }, data: { expectedQuantity: '0', expectedBySize: {}, updatedById: actorOf(tools), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      kept += 1
      continue
    }
    await tx.customerMaterial.delete({ where: { id: row.id }, select: { id: true } })
    removed += 1
  }
  return { made, changed, removed, kept, problems }
}

/** The rows of lines an amendment removes: deleted first, refused in words when something of them came, was used or went back. */
export async function materialsOfRemovedLines(tools: CommandTools, removed: readonly { readonly id: string; readonly seq: number }[]): Promise<void> {
  if (removed.length === 0) return
  const rows = await tools.tx.customerMaterial.findMany({ where: { orderLineId: { in: removed.map((line) => line.id) } }, select: { id: true, orderLineId: true, receivedQuantity: true, usedQuantity: true, returnedQuantity: true } })
  const busy = rows.filter((row) => [row.receivedQuantity, row.usedQuantity, row.returnedQuantity].some((value) => new Dec(value.toString()).gt(0)))
  if (busy.length > 0) {
    const seqs = [...new Set(busy.map((row) => removed.find((line) => line.id === row.orderLineId)!.seq))].sort((a, b) => a - b)
    const message = `Line ${seqs.join(', ')} has material the customer sent for it (received, used or returned): it cannot be removed; close it short instead, or lower its sizes.`
    throw new DomainError('conflict', message, [{ path: 'body/lines', message }])
  }
  if (rows.length > 0) await tools.tx.customerMaterial.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
}

// ---- the recount ------------------------------------------------------------------------------------------------------------

const key = (itemId: string, itemColourId: string | null): string => `${itemId}|${itemColourId ?? '-'}`

/** Signed base quantity of a move: + into stock (a location to go to and none it came from), − out of it. */
function intoStock(move: { readonly fromLocationId: string | null; readonly toLocationId: string | null; readonly baseQuantity: { toString(): string } }): Decimal {
  const value = new Dec(move.baseQuantity.toString())
  if (move.toLocationId && !move.fromLocationId) return value
  if (move.fromLocationId && !move.toLocationId) return value.negated()
  return new Dec(0)
}

/**
 * Received, used and returned of every row of the customer for the materials named (item|colour keys; none: every material
 * of its rows), from the moves of its own lots. Returns the rows that changed.
 */
export async function recountInCommand(tools: CommandTools, partyId: string, materials?: readonly { readonly itemId: string; readonly itemColourId: string | null }[]): Promise<{ changed: number; orders: { id: string; number: string; companyId: string; rows: number }[] }> {
  const { tx, now } = tools
  const itemIds = materials ? [...new Set(materials.map((entry) => entry.itemId))] : undefined
  const rows = await tx.customerMaterial.findMany({
    where: { partyId, ...(itemIds ? { itemId: { in: itemIds } } : {}) },
    select: { ...MATERIAL_COLUMNS, order: { select: { number: true, createdAt: true, companyId: true } }, orderLine: { select: { seq: true } } },
    orderBy: [{ order: { createdAt: 'asc' } }, { orderId: 'asc' }, { orderLine: { seq: 'asc' } }, { id: 'asc' }],
  })
  if (rows.length === 0) return { changed: 0, orders: [] }
  const wantedKeys = materials ? new Set(materials.map((entry) => key(entry.itemId, entry.itemColourId))) : null
  const lots = await tx.lot.findMany({ where: { ownerPartyId: partyId, itemId: { in: [...new Set(rows.map((row) => row.itemId))] } }, select: { id: true, itemId: true, itemColourId: true } })
  const lotKey = new Map(lots.map((lot) => [lot.id, key(lot.itemId, lot.itemColourId)]))
  const moves = lots.length === 0 ? [] : await tx.stockMove.findMany({ where: { lotId: { in: lots.map((lot) => lot.id) } }, select: { lotId: true, reason: true, fromLocationId: true, toLocationId: true, baseQuantity: true, workOrderId: true, reference: true } })
  const received = new Map<string, Decimal>()
  const usedByWorkOrder = new Map<string, Decimal>()
  const returnedBy = new Map<string, Decimal>()
  const add = (map: Map<string, Decimal>, at: string, value: Decimal) => map.set(at, (map.get(at) ?? new Dec(0)).plus(value))
  for (const move of moves) {
    const material = lotKey.get(move.lotId!)!
    if (move.reason === 'RECEIPT' || move.reason === 'OPENING') add(received, material, intoStock(move))
    else if (move.workOrderId && (move.reason === 'ISSUE' || move.reason === 'RETURN' || move.reason === 'REMNANT')) add(usedByWorkOrder, `${move.workOrderId}|${material}`, intoStock(move).negated())
    else if (move.reason === 'SUPPLIER_RETURN') add(returnedBy, `${move.reference ?? ''}|${material}`, intoStock(move).negated())
  }
  // Used: per work order and material, shared among the rows of the lines its cells make (by what each expects).
  const used = new Map<string, Decimal>()
  const workOrderIds = [...new Set([...usedByWorkOrder.keys()].map((entry) => entry.split('|')[0]!))]
  const cells = workOrderIds.length === 0 ? [] : await tx.workOrderSize.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { workOrderId: true, salesOrderLineId: true } })
  for (const [entry, total] of usedByWorkOrder) {
    const [workOrderId, itemId, colour] = entry.split('|') as [string, string, string]
    const lineIds = new Set(cells.filter((cell) => cell.workOrderId === workOrderId && cell.salesOrderLineId).map((cell) => cell.salesOrderLineId!))
    const sharing = rows.filter((row) => lineIds.has(row.orderLineId) && row.itemId === itemId && (row.itemColourId ?? '-') === colour)
    if (sharing.length === 0 || total.lte(0)) continue
    for (const [rowId, part] of apportion(total.toFixed(4), sharing.map((row) => ({ id: row.id, weight: q(row.expectedQuantity) })))) add(used, rowId, new Dec(part))
  }
  // Returned: to the order the move names by its number, else the newest row of the material.
  const returned = new Map<string, Decimal>()
  for (const [entry, total] of returnedBy) {
    if (total.lte(0)) continue
    const [reference, itemId, colour] = entry.split('|') as [string, string, string]
    const ofMaterial = rows.filter((row) => row.itemId === itemId && (row.itemColourId ?? '-') === colour)
    const named = ofMaterial.filter((row) => row.order.number === reference)
    const target = named.length > 0 ? named : ofMaterial.slice(-1)
    for (const [rowId, part] of apportion(total.toFixed(4), target.map((row) => ({ id: row.id, weight: q(row.expectedQuantity) })))) add(returned, rowId, new Dec(part))
  }
  const counted: CountRow[] = rows.map((row) => ({ id: row.id, itemId: row.itemId, itemColourId: row.itemColourId, expected: q(row.expectedQuantity), used: (used.get(row.id) ?? new Dec(0)).toFixed(4), returned: (returned.get(row.id) ?? new Dec(0)).toFixed(4) }))
  const totals = new Map([...received.entries()].map(([material, value]) => [material, (value.lt(0) ? new Dec(0) : value).toFixed(4)]))
  const shared = shareReceived(counted, totals)
  let changedRows = 0
  const orders = new Map<string, { id: string; number: string; companyId: string; rows: number }>()
  for (const row of rows) {
    if (wantedKeys && !wantedKeys.has(key(row.itemId, row.itemColourId))) continue
    const next = { receivedQuantity: shared.received.get(row.id) ?? '0.0000', usedQuantity: counted.find((entry) => entry.id === row.id)!.used, returnedQuantity: counted.find((entry) => entry.id === row.id)!.returned }
    if (q(row.receivedQuantity) === next.receivedQuantity && q(row.usedQuantity) === next.usedQuantity && q(row.returnedQuantity) === next.returnedQuantity) continue
    await tx.customerMaterial.update({ where: { id: row.id }, data: { ...next, updatedById: actorOf(tools), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    changedRows += 1
    const entry = orders.get(row.orderId) ?? { id: row.orderId, number: row.order.number, companyId: row.order.companyId, rows: 0 }
    entry.rows += 1
    orders.set(row.orderId, entry)
  }
  return { changed: changedRows, orders: [...orders.values()] }
}

/** A row as the order's tab reads it (base unit, 4 decimals; no money: customer-owned stock is never valued). */
export function materialView(row: MaterialRow, names: { readonly items: ReadonlyMap<string, { code: string; name: string }>; readonly colours: ReadonlyMap<string, { code: string; name: string | null }> }) {
  const received = q(row.receivedQuantity)
  const used = q(row.usedQuantity)
  const returned = q(row.returnedQuantity)
  return {
    id: row.id,
    orderLineId: row.orderLineId,
    bomRevisionId: row.bomRevisionId,
    bomLineId: row.bomLineId,
    item: { id: row.itemId, code: names.items.get(row.itemId)?.code ?? '?', name: names.items.get(row.itemId)?.name ?? '' },
    colour: row.itemColourId ? { id: row.itemColourId, code: names.colours.get(row.itemColourId)?.code ?? '?', name: names.colours.get(row.itemColourId)?.name ?? null } : null,
    uom: row.uom,
    expected: q(row.expectedQuantity),
    expectedBySize: row.expectedBySize as Record<string, string>,
    received,
    used,
    returned,
    left: leftOf({ received, used, returned }),
    note: row.note,
    version: row.version,
  }
}
