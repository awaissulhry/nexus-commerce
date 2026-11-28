import type { Prisma } from '@nexus/factory-db'
import { isSmallPartsType } from '@nexus/factory-domain/production/baskets/at-print'
import type { MoveFact } from '@nexus/factory-domain/production/baskets/place'
import type { RouteEditFact } from '@nexus/factory-domain/production/baskets/route'
import { departmentOfStep, type DepartmentLook } from '@nexus/factory-domain/production/baskets/steps'
import { departmentOfKind } from '@nexus/factory-domain/production/departments/kinds'
import { floorOrderPicture } from '../../sales/orders/floor-picture'
import { customerCodesOf } from '../dispatch/world'
import type { OperationRow, Reader } from '../scans/store'

/**
 * The basket's reads (owb- order workflow, S5 fl1). Every read names its columns and runs as the caller: the floor role reads its
 * own site's rows (row-level security), the office its tenant's. What the floor role may not read — the order (SalesOrder,
 * SalesOrderLine), the customer (Party) — is read by `orderFactsOf` through the tenant's system view AFTER the basket read's own
 * checks (scans/access systemView), as dispatch reads the customer codes; it answers the customer's CODE only, never a name.
 */

const DEPARTMENT_LOOK = { id: true, number: true, name: true, shortName: true, tone: true, icon: true, nameI18n: true } as const satisfies Prisma.DepartmentSelect

const asWords = (value: Prisma.JsonValue | null): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).flatMap(([key, word]) => (typeof word === 'string' ? [[key, word]] : []))) : {}

/** Every department of the tenant the reader sees, as the chips draw them. */
export async function departmentLooks(db: Reader): Promise<DepartmentLook[]> {
  const rows = await db.department.findMany({ select: DEPARTMENT_LOOK, orderBy: [{ seq: 'asc' }, { number: 'asc' }] })
  return rows.map((row) => ({ ...row, nameI18n: asWords(row.nameI18n) }))
}

/** Each operation's department of one work order (factory-domain baskets/steps departmentOfStep), by operation id. */
export async function stepDepartments(db: Reader, workOrderId: string, operations: readonly OperationRow[], departments: readonly DepartmentLook[]): Promise<Map<string, DepartmentLook | null>> {
  return stepDepartmentsOf(db, [workOrderId], operations, departments)
}

/** The same for many work orders at once (the home): `operations` are theirs, by operation id. */
export async function stepDepartmentsOf(db: Reader, workOrderIds: readonly string[], operations: readonly OperationRow[], departments: readonly DepartmentLook[]): Promise<Map<string, DepartmentLook | null>> {
  if (workOrderIds.length === 0) return new Map()
  const rows = await db.workOrderOperation.findMany({ where: { workOrderId: { in: [...workOrderIds] } }, select: { id: true, routingSeq: true, operationId: true, styleRevisionId: true } })
  const revisionIds = [...new Set(rows.map((row) => row.styleRevisionId))]
  const routing = revisionIds.length === 0 ? [] : await db.routingOperation.findMany({ where: { revisionId: { in: revisionIds } }, select: { revisionId: true, seq: true, departmentId: true } })
  const routingOf = new Map(routing.map((row) => [`${row.revisionId}|${row.seq}`, row.departmentId]))
  const libraryIds = [...new Set(rows.flatMap((row) => (row.operationId ? [row.operationId] : [])))]
  const library = new Map(libraryIds.length === 0 ? [] : (await db.operation.findMany({ where: { id: { in: libraryIds } }, select: { id: true, departmentId: true } })).map((row) => [row.id, row.departmentId]))
  const kindOf = new Map(operations.map((operation) => [operation.id, operation.workCentreKind]))
  return new Map(
    rows.map((row) => [
      row.id,
      departmentOfStep(
        {
          routingDepartmentId: row.routingSeq === null ? null : (routingOf.get(`${row.styleRevisionId}|${row.routingSeq}`) ?? null),
          operationDepartmentId: row.operationId ? (library.get(row.operationId) ?? null) : null,
          workCentreKind: kindOf.get(row.id) ?? 'SEWING',
        },
        departments,
      ),
    ]),
  )
}

/** The operations of many work orders at once, as scans/store readOperations reads one (by work order id). */
export async function operationsOf(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, OperationRow[]>> {
  if (workOrderIds.length === 0) return new Map()
  const rows = await db.workOrderOperation.findMany({ where: { workOrderId: { in: [...workOrderIds] } }, select: { id: true, workOrderId: true, seq: true, routingSeq: true, code: true, name: true, scanRequired: true, parallelGroup: true, workCentreId: true, plannedQuantity: true }, orderBy: [{ workOrderId: 'asc' }, { seq: 'asc' }] })
  const centres = new Map((await db.workCentre.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workCentreId))] } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind as OperationRow['workCentreKind']]))
  const out = new Map<string, OperationRow[]>()
  for (const { routingSeq, workOrderId, ...row } of rows) out.set(workOrderId, [...(out.get(workOrderId) ?? []), { ...row, unplanned: routingSeq === null, workCentreKind: centres.get(row.workCentreId) ?? 'SEWING' }])
  return out
}

/** A hand move as the readers read it (factory-domain baskets/place MoveFact), with who and where. */
export interface MoveRow extends MoveFact {
  readonly workerId: string | null
  readonly userId: string | null
  readonly deviceId: string | null
}
/** A route edit as the readers read it (factory-domain baskets/route RouteEditFact), with when, who and where. */
export interface EditRow extends RouteEditFact {
  readonly serverTime: Date
  readonly workerId: string | null
  readonly userId: string | null
  readonly deviceId: string | null
}

const MOVE = { id: true, kind: true, fromOperationId: true, toOperationId: true, undoesId: true, serverTime: true, workerId: true, userId: true, deviceId: true } as const satisfies Prisma.BasketMoveSelect
const EDIT = { kind: true, operationId: true, serverTime: true, workerId: true, userId: true, deviceId: true } as const satisfies Prisma.BasketRouteEditSelect

/** The basket's hand moves, oldest first. */
export async function readMoves(db: Reader, bundleIds: readonly string[]): Promise<Map<string, MoveRow[]>> {
  const rows = bundleIds.length === 0 ? [] : await db.basketMove.findMany({ where: { bundleId: { in: [...bundleIds] } }, select: { ...MOVE, bundleId: true }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, MoveRow[]>()
  for (const { bundleId, ...row } of rows) out.set(bundleId, [...(out.get(bundleId) ?? []), row])
  return out
}

/** The basket's route edits, oldest first. */
export async function readEdits(db: Reader, bundleIds: readonly string[]): Promise<Map<string, EditRow[]>> {
  const rows = bundleIds.length === 0 ? [] : await db.basketRouteEdit.findMany({ where: { bundleId: { in: [...bundleIds] } }, select: { ...EDIT, bundleId: true }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, EditRow[]>()
  for (const { bundleId, ...row } of rows) out.set(bundleId, [...(out.get(bundleId) ?? []), row])
  return out
}

/** The baskets' standing "Do this first" marks (bundle ids). */
export async function readFirstFlags(db: Reader, bundleIds: readonly string[]): Promise<Set<string>> {
  if (bundleIds.length === 0) return new Set()
  return new Set((await db.basketFlag.findMany({ where: { bundleId: { in: [...bundleIds] }, kind: 'FIRST', clearedAt: null }, select: { bundleId: true } })).map((row) => row.bundleId))
}

/** The open "Will be late" warnings of the work orders: of a basket, or of the whole work order (bundleId null); newest first. */
export async function readLate(db: Reader, workOrderIds: readonly string[]) {
  if (workOrderIds.length === 0) return []
  return db.floorLateWarning.findMany({ where: { workOrderId: { in: [...workOrderIds] }, state: 'OPEN' }, select: { workOrderId: true, bundleId: true, days: true, reason: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}

const CALL = { id: true, bundleId: true, typeId: true, status: true, sentAt: true, escalatedAt: true, solvedAt: true, resolutionNote: true, spot: true, workerId: true, deviceId: true } as const satisfies Prisma.HelpCallSelect
export type CallRow = Prisma.HelpCallGetPayload<{ select: typeof CALL }> & { readonly typeCode: string }

/** The help calls about these baskets (newest first), each with its type's code. */
export async function readCalls(db: Reader, where: Prisma.HelpCallWhereInput, take = 200): Promise<CallRow[]> {
  const rows = await db.helpCall.findMany({ where, select: CALL, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take })
  const typeIds = [...new Set(rows.map((row) => row.typeId))]
  const codes = new Map(typeIds.length === 0 ? [] : (await db.helpCallType.findMany({ where: { id: { in: typeIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return rows.map((row) => ({ ...row, typeCode: codes.get(row.typeId) ?? '' }))
}

/** The basket's own columns the card does not carry. */
export async function readBasketRow(db: Reader, bundleId: string) {
  return db.bundle.findUnique({ where: { id: bundleId }, select: { id: true, code: true, madeAtPrint: true, part: true, workOrderSizeId: true } })
}

/** Whether the work order's style makes small parts (one basket a cell; at-print isSmallPartsType). */
export async function smallPartsOf(db: Reader, styleId: string): Promise<boolean> {
  const style = await db.style.findUnique({ where: { id: styleId }, select: { productType: true } })
  return isSmallPartsType(style?.productType ?? null)
}

/** The department the phone picked in its open session (and the station it took), else the device's station's kind's. */
export async function hereOfDevice(db: Reader, deviceId: string, departments: readonly DepartmentLook[]): Promise<{ readonly departmentId: string | null; readonly stationId: string | null; readonly picked: boolean }> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { currentSessionId: true, stationId: true } })
  const session = device?.currentSessionId ? await db.floorSession.findUnique({ where: { id: device.currentSessionId }, select: { departmentId: true, stationId: true, endedAt: true } }) : null
  if (session && session.endedAt === null && session.departmentId) return { departmentId: session.departmentId, stationId: session.stationId, picked: true }
  if (!device?.stationId) return { departmentId: null, stationId: null, picked: false }
  const station = await db.station.findUnique({ where: { id: device.stationId }, select: { workCentreId: true } })
  const centre = station ? await db.workCentre.findUnique({ where: { id: station.workCentreId }, select: { kind: true } }) : null
  const number = centre ? departmentOfKind(centre.kind) : null
  const department = typeof number === 'number' ? departments.find((entry) => entry.number === number) : undefined
  return { departmentId: department?.id ?? null, stationId: device.stationId, picked: false }
}

/** The order facts of a basket the floor role may not read (see the file's head). */
export interface OrderFacts {
  readonly salesOrderId: string | null
  readonly customerCode: string | null
  readonly floorRestricted: boolean
  readonly picture: { readonly fileId: string; readonly contentType: string } | null
  /** The open teams of the order: in charge, and the baskets each one holds. */
  readonly teams: readonly { readonly teamId: string; readonly inCharge: boolean; readonly bundleIds: readonly string[] }[]
}

/** Read through the tenant's system view (or the office's own client): the basket's order, customer code, picture, teams. */
export async function orderFactsOf(db: Reader, input: { readonly workOrderId: string; readonly workOrderSizeId: string; readonly siteId: string }): Promise<OrderFacts> {
  const cell = await db.workOrderSize.findUnique({ where: { id: input.workOrderSizeId }, select: { salesOrderLineId: true } })
  const line = cell?.salesOrderLineId ? await db.salesOrderLine.findUnique({ where: { id: cell.salesOrderLineId }, select: { salesOrderId: true } }) : null
  const salesOrderId = line?.salesOrderId ?? null
  const order = salesOrderId ? await db.salesOrder.findUnique({ where: { id: salesOrderId }, select: { floorRestricted: true } }) : null
  const customerCode = (await customerCodesOf(db, [input.workOrderId])).get(input.workOrderId) ?? null
  const picture = salesOrderId ? await floorOrderPicture(db, { salesOrderId, siteId: input.siteId }) : null
  const teams = salesOrderId ? await db.orderTeam.findMany({ where: { salesOrderId, endedAt: null }, select: { teamId: true, inCharge: true, bundleIds: true } }) : []
  return { salesOrderId, customerCode, floorRestricted: order?.floorRestricted ?? false, picture, teams }
}

/** The team a worker is in today (its employee's open TeamMember row), or null. */
export async function teamOfWorker(db: Reader, workerId: string, today: Date): Promise<string | null> {
  const worker = await db.worker.findUnique({ where: { id: workerId }, select: { employeeId: true } })
  if (!worker?.employeeId) return null
  const member = await db.teamMember.findFirst({ where: { employeeId: worker.employeeId, since: { lte: today }, OR: [{ until: null }, { until: { gte: today } }] }, select: { teamId: true }, orderBy: { since: 'desc' } })
  return member?.teamId ?? null
}

/** A team as its chip draws it (no photo: letters or an icon on a tone). */
export async function teamLook(db: Reader, teamId: string) {
  const team = await db.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, pictureKind: true, pictureIcon: true, pictureColour: true } })
  return team ? { id: team.id, name: team.name, picture: { kind: team.pictureKind, icon: team.pictureIcon, colour: team.pictureColour } } : null
}

