import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_PRINT_START } from '@nexus/factory-domain/production/print-start/permissions'
import { mmOf, placementProblems, type PlacementAsk } from '@nexus/factory-domain/production/print-start/placement'
import { ORDERS_VIEW_OWN } from '@nexus/factory-domain/sales/orders/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { artworkOf } from '../../sales/configurator/artwork'
import { isOnOrder } from '../../sales/orders/on-the-order'
import { officeContextOf } from '../work-orders/access'
import { designFilesOf, goodsLinesOf } from '../print-start/store'

/**
 * Place the scan code (owb- order workflow, S3 ss2b steps b.1 + b.2; settle L8; design § 5f; factory-db ScanCodePlacement of the S3
 * wave owb-ssw). Office:
 *
 *   GET /production/orders/:orderId/placements                     the order's places
 *   PUT /production/orders/:orderId/placements/:salesOrderLineId   one place of a line's design page: a square of at least 20 mm,
 *                                                                  wholly inside the page (the body's page sides); one row per line,
 *                                                                  file and page (a second save moves it, at its version); ONE audit row
 * Who: production.print.start over the order's company and customer, or the Factory designer ON the order (orders.view.own and S2's
 * isOnOrder: a follower of the order or its request, or the customer's factory designer) — anyone else gets the not-found of an
 * unknown order. `placedOf()` gives S2's Design desk its "0 of 3 placed" (never a stop).
 */

type Reader = FactoryClient | CommandTx

const PLACEMENT_COLUMNS = { id: true, salesOrderLineId: true, fileId: true, page: true, xMm: true, yMm: true, sizeMm: true, version: true, placedAt: true, placedById: true } as const

type PlacementRow = { readonly id: string; readonly salesOrderLineId: string; readonly fileId: string; readonly page: number; readonly xMm: unknown; readonly yMm: unknown; readonly sizeMm: unknown; readonly version: number; readonly placedAt: Date; readonly placedById: string | null }

const viewOf = (row: PlacementRow, names: ReadonlyMap<string, string>) => ({
  salesOrderLineId: row.salesOrderLineId,
  fileId: row.fileId,
  page: row.page,
  xMm: Number(String(row.xMm)),
  yMm: Number(String(row.yMm)),
  sizeMm: Number(String(row.sizeMm)),
  version: row.version,
  placedAt: toUtcIso(row.placedAt),
  placedBy: { name: row.placedById ? (names.get(row.placedById) ?? '') : '' },
})

async function namesOf(db: Reader, userIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** The order the caller may place codes on (production.print.start, or the designer on the order), else 404. */
async function placingOrder(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const order = isUuid(orderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true } })) : null
  if (!order) throw new NotFoundError('Sales order not found.')
  const scope = { companyId: order.companyId, partyId: order.partyId }
  const actor = actorOf(context)
  const prints = can(actor, PRODUCTION_PRINT_START, scope)
  const designer = !prints && can(actor, ORDERS_VIEW_OWN, scope) && (await caller.withClient((client) => isOnOrder(client, { tenantId: context.tenantId, userId: context.actorId, salesOrderId: order.id })))
  if (!prints && !designer) throw new NotFoundError('Sales order not found.')
  return { order, context }
}

/** GET /production/orders/:orderId/placements. */
export async function listPlacements(caller: CommandCaller, orderId: string) {
  const { order } = await placingOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const rows = await client.scanCodePlacement.findMany({ where: { salesOrderId: order.id }, select: PLACEMENT_COLUMNS, orderBy: [{ salesOrderLineId: 'asc' }, { page: 'asc' }, { id: 'asc' }] })
    const names = await namesOf(client, rows.map((row) => row.placedById))
    return { placements: rows.map((row) => viewOf(row, names)) }
  })
}

export interface PlacementInput extends PlacementAsk {
  readonly fileId: string
  readonly version?: number | undefined
}

/** PUT /production/orders/:orderId/placements/:salesOrderLineId. */
export async function savePlacement(caller: CommandCaller, orderId: string, lineId: string, body: PlacementInput, idempotencyKey?: string) {
  const { order, context } = await placingOrder(caller, orderId)
  const problems = placementProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The place does not hold together.', problems)
  const { result } = await command(caller, { name: 'production.placeScanCode', idempotencyKey, input: { orderId, lineId, ...body } }, async (tools) => {
    const { tx } = tools
    const line = isUuid(lineId) ? await tx.salesOrderLine.findFirst({ where: { id: lineId, orderId: order.id }, select: { id: true, quoteLineId: true } }) : null
    if (!line) throw new NotFoundError('Sales order line not found.')
    const files = await artworkOf(tx, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } })
    if (!files.some((file) => file.fileId === body.fileId && file.status === 'AVAILABLE')) throw new ValidationError('Not a design file of this line.', [{ path: 'body/fileId', message: 'Expected an AVAILABLE design file of the line.' }])
    await tx.$queryRaw`SELECT 1 FROM "SalesOrderLine" WHERE "id" = ${line.id}::uuid FOR UPDATE`
    const existing = await tx.scanCodePlacement.findFirst({ where: { salesOrderLineId: line.id, fileId: body.fileId, page: body.page }, select: PLACEMENT_COLUMNS })
    const place = { xMm: mmOf(body.xMm), yMm: mmOf(body.yMm), sizeMm: mmOf(body.sizeMm) }
    let id: string
    if (existing) {
      if (body.version !== undefined && body.version !== existing.version) throw new StaleVersionError('ScanCodePlacement', existing.id, existing.version, body.version)
      id = existing.id
      await tx.scanCodePlacement.update({ where: { id }, data: { ...place, version: { increment: 1 }, placedAt: tools.now, placedById: context.actorId }, select: { id: true } })
    } else {
      id = newId()
      await tx.scanCodePlacement.create({ data: { id, companyId: order.companyId, partyId: order.partyId, salesOrderId: order.id, salesOrderLineId: line.id, fileId: body.fileId, page: body.page, ...place, placedAt: tools.now, placedById: context.actorId }, select: { id: true } })
    }
    tools.audit({
      action: 'production.placeScanCode',
      recordType: 'ScanCodePlacement',
      recordId: id,
      companyId: order.companyId,
      before: existing ? { xMm: String(existing.xMm), yMm: String(existing.yMm), sizeMm: String(existing.sizeMm) } : null,
      after: { salesOrderId: order.id, salesOrderLineId: line.id, fileId: body.fileId, page: body.page, ...place },
    })
    const row = (await tx.scanCodePlacement.findUniqueOrThrow({ where: { id }, select: PLACEMENT_COLUMNS }))!
    return viewOf(row, await namesOf(tx, [row.placedById]))
  })
  return result
}

/** The order's places by line, file and page (the preview and the sheet read them). */
export async function placementsOf(db: Reader, orderId: string): Promise<Map<string, { xMm: number; yMm: number; sizeMm: number }>> {
  const rows = await db.scanCodePlacement.findMany({ where: { salesOrderId: orderId }, select: { salesOrderLineId: true, fileId: true, page: true, xMm: true, yMm: true, sizeMm: true } })
  return new Map(rows.map((row) => [placeKey(row.salesOrderLineId, row.fileId, row.page), { xMm: Number(String(row.xMm)), yMm: Number(String(row.yMm)), sizeMm: Number(String(row.sizeMm)) }]))
}

export const placeKey = (lineId: string, fileId: string, page: number): string => `${lineId}|${fileId}|${page}`

/**
 * For S2's Design desk (no route): per order, its design pages (page 1 of each goods line with a design file) and how many carry a
 * place — `{ done, of }`; an order with no design page is `{ done: 0, of: 0 }`. `db`: the office scope the desk reads in.
 */
export async function placedOf(db: Reader, input: { readonly orderIds: readonly string[] }): Promise<Map<string, { done: number; of: number }>> {
  const out = new Map<string, { done: number; of: number }>()
  for (const orderId of [...new Set(input.orderIds)].filter(isUuid)) {
    const lines = await goodsLinesOf(db as CommandTx, orderId)
    const files = await designFilesOf(db as CommandTx, lines)
    const places = await placementsOf(db, orderId)
    const pages = lines.filter((line) => files.has(line.id))
    out.set(orderId, { done: pages.filter((line) => places.has(placeKey(line.id, files.get(line.id)!.fileId, 1))).length, of: pages.length })
  }
  return out
}
