import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { isSmallPartsType } from '@nexus/factory-domain/production/baskets/at-print'
import { PRODUCTION_PRINT_START } from '@nexus/factory-domain/production/print-start/permissions'
import { openSizes } from '@nexus/factory-domain/production/work-orders/cells'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { artworkOf } from '../../sales/configurator/artwork'
import { officeContextOf } from '../work-orders/access'
import { readOrderLines } from '../work-orders/store'

/**
 * The reads of "Print and start the work", "Print again" and the print sheet (owb- order workflow, S3 ss2; settles L1, L6, L7, L8):
 * the order the person may print, its goods lines and their design pages, its work orders, the groups of lines still to make, and
 * its prints. Every read names its columns; a reader takes the command's transaction or a scoped client.
 */

type Reader = FactoryClient | CommandTx

const ORDER_COLUMNS = { id: true, number: true, status: true, companyId: true, partyId: true, version: true, promiseDate: true, requestedDate: true } as const

export interface PrintOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly companyId: string
  readonly partyId: string
  readonly version: number
  readonly promiseDate: Date | null
  readonly requestedDate: Date | null
}

/** The order the caller may print and start (production.print.start over its company and customer), else 404 in the words of an unknown id. */
export async function printOrder(caller: CommandCaller, orderId: string): Promise<{ order: PrintOrder; context: OfficeContext }> {
  const context = officeContextOf(caller)
  const order = isUuid(orderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_COLUMNS })) : null
  if (!order || !can(actorOf(context), PRODUCTION_PRINT_START, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
  return { order, context }
}

/** The order read again inside a command (its row locked). */
export const orderNow = (db: Reader, orderId: string): Promise<PrintOrder> => db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_COLUMNS })

/** A goods line of the order (a fee line is never made), in its order. */
export interface PrintLine {
  readonly id: string
  readonly seq: number
  readonly styleId: string
  readonly styleCode: string
  readonly colourwayCode: string
  readonly quoteLineId: string | null
  /** "JKT-01 BLK" — the line for the eye. */
  readonly label: string
}

export async function goodsLinesOf(db: Reader, orderId: string): Promise<PrintLine[]> {
  const rows = await db.salesOrderLine.findMany({
    where: { orderId, kind: { not: 'FEE' } },
    select: { id: true, seq: true, styleId: true, quoteLineId: true, style: { select: { code: true } }, colourway: { select: { code: true } } },
    orderBy: { seq: 'asc' },
  })
  return rows.flatMap((row) =>
    row.styleId && row.style ? [{ id: row.id, seq: row.seq, styleId: row.styleId, styleCode: row.style.code, colourwayCode: row.colourway?.code ?? '', quoteLineId: row.quoteLineId, label: `${row.style.code} ${row.colourway?.code ?? ''}`.trim() }] : [],
  )
}

/** Each line's design page: its newest AVAILABLE artwork file (a PDF or a picture), or none. */
export async function designFilesOf(db: Reader, lines: readonly PrintLine[]): Promise<Map<string, { fileId: string; contentType: string }>> {
  const out = new Map<string, { fileId: string; contentType: string }>()
  for (const line of lines) {
    const files = await artworkOf(db, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } })
    const file = files.find((entry) => entry.status === 'AVAILABLE' && (entry.contentType === 'application/pdf' || entry.contentType.startsWith('image/')))
    if (file) out.set(line.id, { fileId: file.fileId, contentType: file.contentType })
  }
  return out
}

/** A work order that makes the order's lines (not cancelled, not a repair), with its cells of those lines. */
export interface OrderWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly kind: string
  readonly siteId: string
  readonly companyId: string
  readonly partyId: string | null
  readonly styleId: string
  readonly styleCode: string
  readonly smallParts: boolean
  readonly cells: readonly { readonly id: string; readonly salesOrderLineId: string | null; readonly size: string; readonly colourwayCode: string; readonly quantity: number }[]
}

export async function workOrdersOf(db: Reader, lineIds: readonly string[]): Promise<OrderWorkOrder[]> {
  if (lineIds.length === 0) return []
  const rows = await db.workOrder.findMany({
    where: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' }, sizes: { some: { salesOrderLineId: { in: [...lineIds] } } } },
    select: {
      id: true,
      number: true,
      status: true,
      kind: true,
      siteId: true,
      companyId: true,
      partyId: true,
      styleId: true,
      style: { select: { code: true, productType: true } },
      sizes: { select: { id: true, salesOrderLineId: true, size: true, quantity: true, colourway: { select: { code: true } } }, orderBy: [{ size: 'asc' }, { id: 'asc' }] },
    },
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    kind: row.kind,
    siteId: row.siteId,
    companyId: row.companyId,
    partyId: row.partyId,
    styleId: row.styleId,
    styleCode: row.style.code,
    smallParts: isSmallPartsType(row.style.productType),
    cells: row.sizes.filter((cell) => cell.salesOrderLineId !== null && lineIds.includes(cell.salesOrderLineId)).map((cell) => ({ id: cell.id, salesOrderLineId: cell.salesOrderLineId, size: cell.size, colourwayCode: cell.colourway.code, quantity: cell.quantity })),
  }))
}

/** A group of the order's lines still to make: ONE draft per style × site × revision × customer (a made-to-measure unit alone). */
export interface DraftGroup {
  readonly styleId: string
  readonly styleCode: string
  /** null: the lines name no site and the company has several plants (the print refuses: choose it in Make work orders…). */
  readonly siteId: string | null
  readonly styleRevisionId: string | null
  readonly lines: readonly { readonly salesOrderLineId: string; readonly sizes: readonly { readonly size: string; readonly quantity: number }[] }[]
  readonly pieces: number
}

/**
 * The lines with sizes not yet on a work order, grouped as today's "Make work orders…" makes them (createWorkOrder's site: the
 * line's own, else the company's only active plant).
 */
export async function draftGroupsOf(db: Reader, order: Pick<PrintOrder, 'companyId'>, lines: readonly PrintLine[]): Promise<DraftGroup[]> {
  if (lines.length === 0) return []
  const facts = await readOrderLines(db, lines.map((line) => line.id))
  const plants = await db.site.findMany({ where: { companyId: order.companyId, kind: 'PLANT', status: 'ACTIVE' }, select: { id: true } })
  const onlyPlant = plants.length === 1 ? plants[0]!.id : null
  const groups = new Map<string, { styleId: string; styleCode: string; siteId: string | null; styleRevisionId: string | null; lines: { salesOrderLineId: string; sizes: { size: string; quantity: number }[] }[]; pieces: number }>()
  for (const line of lines) {
    const fact = facts.get(line.id)
    if (!fact) continue
    const open = openSizes(fact).filter((size) => size.open > 0).map((size) => ({ size: size.size, quantity: size.open }))
    if (open.length === 0) continue
    const siteId = fact.siteId ?? onlyPlant
    const key = [fact.styleId, siteId ?? 'none', fact.styleRevisionId ?? '', fact.kind === 'MADE_TO_MEASURE' ? fact.id : ''].join('|')
    const group = groups.get(key) ?? { styleId: fact.styleId, styleCode: line.styleCode, siteId, styleRevisionId: fact.styleRevisionId, lines: [], pieces: 0 }
    group.lines.push({ salesOrderLineId: line.id, sizes: open })
    group.pieces += open.reduce((sum, size) => sum + size.quantity, 0)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** The order's prints, oldest first. */
export async function printsOf(db: Reader, orderId: string) {
  const rows = await db.orderPrint.findMany({ where: { salesOrderId: orderId }, select: { id: true, kind: true, reason: true, note: true, pages: true, cards: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return rows.map((row) => ({
    ...row,
    kind: row.kind as 'FIRST' | 'AGAIN',
    pages: (Array.isArray(row.pages) ? row.pages : []) as { salesOrderLineId: string; page: number }[],
    cards: (Array.isArray(row.cards) ? row.cards : []) as { bundleId: string }[],
  }))
}

/** Whether each site makes its baskets at print (ProductionSettings.basketsAtPrint; no row: off). */
export async function basketsAtPrintBySite(db: Reader, siteIds: readonly string[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(siteIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.productionSettings.findMany({ where: { id: { in: ids } }, select: { id: true, basketsAtPrint: true } })
  const on = new Map(rows.map((row) => [row.id, row.basketsAtPrint]))
  return new Map(ids.map((id) => [id, on.get(id) ?? false]))
}

/** The baskets one cell makes at print (one garment a basket; a small-parts line one basket a cell; made-to-measure always one a garment). */
export const basketsOfCell = (workOrder: { readonly smallParts: boolean; readonly kind: string }, quantity: number): number =>
  quantity < 1 ? 0 : workOrder.smallParts && workOrder.kind !== 'MADE_TO_MEASURE' ? 1 : quantity
