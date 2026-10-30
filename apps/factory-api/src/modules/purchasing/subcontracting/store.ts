import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { Cell, SizePieces } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { assertMay, officeContextOf, type Reader } from '../store'

/**
 * The subcontract orders' reads (factory-db subcontract.prisma: SubcontractOrder, SubcontractOperation,
 * SubcontractKitLine; B-W2a-25): the columns every read names, who may see and act on an order (can() on its company,
 * site AND workshop: a role limited to some workshops reaches only theirs), and the work order, routing, workshop and
 * location facts an order needs. Office only. A reader takes a command's transaction or a scoped client: row-level
 * security decides what it finds.
 */

export const ORDER_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  partyId: true,
  locationId: true,
  workOrderId: true,
  status: true,
  orderDate: true,
  expectedBackDate: true,
  currency: true,
  netAmount: true,
  note: true,
  internalNote: true,
  issuedAt: true,
  issuedById: true,
  closedAt: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SubcontractOrderSelect
export type OrderRow = Prisma.SubcontractOrderGetPayload<{ select: typeof ORDER_COLUMNS }>

export const OPERATION_COLUMNS = {
  id: true,
  subcontractOrderId: true,
  seq: true,
  workOrderOperationId: true,
  pieces: true,
  sizes: true,
  pricePerPiece: true,
  netAmount: true,
  expectedBackDate: true,
  piecesSent: true,
  piecesBackGood: true,
  piecesBackDefective: true,
  piecesScrapped: true,
  note: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.SubcontractOperationSelect
export type OperationRow = Prisma.SubcontractOperationGetPayload<{ select: typeof OPERATION_COLUMNS }>

export const KIT_COLUMNS = {
  id: true,
  subcontractOrderId: true,
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
  ddtId: true,
  note: true,
  version: true,
} as const satisfies Prisma.SubcontractKitLineSelect
export type KitRow = Prisma.SubcontractKitLineGetPayload<{ select: typeof KIT_COLUMNS }>

export const readOrder = (db: Reader, id: string): Promise<OrderRow | null> => (isUuid(id) ? db.subcontractOrder.findUnique({ where: { id }, select: ORDER_COLUMNS }) : Promise.resolve(null))
export const readOperations = (db: Reader, orderId: string): Promise<OperationRow[]> =>
  db.subcontractOperation.findMany({ where: { subcontractOrderId: orderId }, orderBy: { seq: 'asc' }, select: OPERATION_COLUMNS })
export const readKitLines = (db: Reader, orderId: string): Promise<KitRow[]> => db.subcontractKitLine.findMany({ where: { subcontractOrderId: orderId }, orderBy: { seq: 'asc' }, select: KIT_COLUMNS })

/** The order the caller may see (purchasing.view, else 404), and act on with `permission` (else 403). */
export async function officeOrder(caller: CommandCaller, orderId: string, permission: Permission = PURCHASING_VIEW): Promise<{ context: OfficeContext; order: OrderRow }> {
  const context = officeContextOf(caller)
  const order = await caller.withClient((client) => readOrder(client, orderId))
  assertMay(context, permission, order, 'Subcontract order')
  return { context, order: order! }
}

/** The sizes column as typed rows (the trigger keeps it an array of { workOrderSizeId, pieces }). */
export function sizesOf(value: Prisma.JsonValue): SizePieces[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = entry as { workOrderSizeId?: unknown; pieces?: unknown } | null
    return row && typeof row.workOrderSizeId === 'string' && typeof row.pieces === 'number' ? [{ workOrderSizeId: row.workOrderSizeId, pieces: row.pieces }] : []
  })
}

// ---- the work order ------------------------------------------------------------------------------------------------------

export interface WorkOrderFacts {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly siteId: string
  readonly status: string
  readonly styleRevisionId: string | null
  readonly style: { readonly id: string; readonly code: string; readonly name: string }
  readonly cells: (Cell & { readonly colourway: string; readonly size: string })[]
  readonly operations: { readonly id: string; readonly seq: number; readonly routingSeq: number; readonly code: string; readonly name: string; readonly styleRevisionId: string }[]
}

/** The work order with its cells and operations, or null (not found or not in scope). */
export async function readWorkOrderFacts(db: Reader, workOrderId: string): Promise<WorkOrderFacts | null> {
  if (!isUuid(workOrderId)) return null
  const row = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, status: true, styleRevisionId: true, styleId: true } })
  if (!row) return null
  const style = await db.style.findUnique({ where: { id: row.styleId }, select: { id: true, code: true, name: true } })
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, quantity: true, size: true, colourwayId: true }, orderBy: [{ colourwayId: 'asc' }, { size: 'asc' }] })
  const colourways = new Map(
    (await db.colourway.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.colourwayId))] } }, select: { id: true, code: true } })).map((colourway) => [colourway.id, colourway.code]),
  )
  const operations = await db.workOrderOperation.findMany({ where: { workOrderId }, select: { id: true, seq: true, routingSeq: true, code: true, name: true, styleRevisionId: true }, orderBy: { seq: 'asc' } })
  return {
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    siteId: row.siteId,
    status: row.status,
    styleRevisionId: row.styleRevisionId,
    style: style ?? { id: row.styleId, code: '', name: '' },
    cells: cells
      .map((cell) => ({ id: cell.id, quantity: cell.quantity, colourway: colourways.get(cell.colourwayId) ?? '', size: cell.size }))
      .sort((a, b) => (a.colourway === b.colourway ? (a.size < b.size ? -1 : a.size > b.size ? 1 : 0) : a.colourway < b.colourway ? -1 : 1)),
    operations,
  }
}

/** A routing step's outside work (W2a, PRD-120): its workshop, fee per piece (a cost) and transit days. */
export interface OutsideStep {
  readonly supplierId: string
  readonly pricePerPiece: string | null
  readonly transitDays: number | null
}

/**
 * The outside work of the work order's operations, by operation id: the frozen revision's routing step each one copies
 * (WorkOrderOperation styleRevisionId + routingSeq → RoutingOperation revisionId + seq; the release copies no workshop).
 */
export async function outsideStepsOf(db: Reader, operations: WorkOrderFacts['operations']): Promise<Map<string, OutsideStep>> {
  const revisions = [...new Set(operations.map((operation) => operation.styleRevisionId))]
  if (revisions.length === 0) return new Map()
  const steps = await db.routingOperation.findMany({
    where: { revisionId: { in: revisions }, seq: { in: [...new Set(operations.map((operation) => operation.routingSeq))] }, supplierId: { not: null } },
    select: { revisionId: true, seq: true, supplierId: true, pricePerPiece: true, transitDays: true },
  })
  const byStep = new Map(steps.map((step) => [`${step.revisionId}|${step.seq}`, step]))
  const out = new Map<string, OutsideStep>()
  for (const operation of operations) {
    const step = byStep.get(`${operation.styleRevisionId}|${operation.routingSeq}`)
    if (step?.supplierId) out.set(operation.id, { supplierId: step.supplierId, pricePerPiece: step.pricePerPiece === null ? null : step.pricePerPiece.toFixed(6), transitDays: step.transitDays })
  }
  return out
}

// ---- the workshop and its location ---------------------------------------------------------------------------------------

export const WORKSHOP_COLUMNS = { id: true, companyId: true, code: true, legalName: true, tradeName: true, roles: true, status: true, currency: true, leadTimeDays: true } as const satisfies Prisma.PartySelect
export type WorkshopRow = Prisma.PartyGetPayload<{ select: typeof WORKSHOP_COLUMNS }>

export const readWorkshop = (db: Reader, partyId: string): Promise<WorkshopRow | null> => (isUuid(partyId) ? db.party.findUnique({ where: { id: partyId }, select: WORKSHOP_COLUMNS }) : Promise.resolve(null))

export const nameOf = (party: { readonly legalName: string; readonly tradeName: string | null }): string => party.tradeName ?? party.legalName

/** The workshop the order goes to: a SUBCONTRACTOR party of the work order's company (or every company), else 400. */
export function assertWorkshop(party: WorkshopRow | null, companyId: string, path = 'body/partyId'): asserts party is WorkshopRow {
  const problem = !party || (party.companyId !== null && party.companyId !== companyId)
    ? 'Not a workshop of the work order’s company.'
    : !party.roles.includes('SUBCONTRACTOR')
      ? 'The party is no subcontractor: give it the SUBCONTRACTOR role first.'
      : party.status !== 'ACTIVE'
        ? `The workshop is ${party.status.toLowerCase()}; no work is sent to it.`
        : null
  if (problem) throw new ValidationError(problem, [{ path, message: problem }])
}

export const LOCATION_COLUMNS = { id: true, siteId: true, code: true, name: true, kind: true, partyId: true, status: true } as const satisfies Prisma.LocationSelect
export type LocationRow = Prisma.LocationGetPayload<{ select: typeof LOCATION_COLUMNS }>

/** The workshop's ACTIVE stock locations on a site (one, as the locations module keeps it). */
export const workshopLocations = (db: Reader, siteId: string, partyIds: readonly string[]): Promise<LocationRow[]> =>
  partyIds.length === 0
    ? Promise.resolve([])
    : db.location.findMany({ where: { siteId, kind: 'SUBCONTRACTOR', partyId: { in: [...partyIds] }, status: 'ACTIVE' }, select: LOCATION_COLUMNS, orderBy: { code: 'asc' } })

export const readLocationRow = (db: Reader, id: string): Promise<LocationRow | null> => (isUuid(id) ? db.location.findUnique({ where: { id }, select: LOCATION_COLUMNS }) : Promise.resolve(null))

/** Not found, in the order's words. */
export const orderNotFound = () => new NotFoundError('Subcontract order not found.')
