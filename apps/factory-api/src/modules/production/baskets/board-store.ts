import type { Prisma } from '@nexus/factory-db'
import { FLOOR_PROBLEM_CODES, minutesOpen, type LateReason, type LateState } from '@nexus/factory-domain/production/baskets/signals'
import { basketPlace, type MoveFact } from '@nexus/factory-domain/production/baskets/place'
import { basketRoute, type RouteEditFact } from '@nexus/factory-domain/production/baskets/route'
import { departmentOfStep, stepStates, type DepartmentLook } from '@nexus/factory-domain/production/baskets/steps'
import { OPEN_CALL_STATUSES } from '@nexus/factory-domain/production/calls/rules'
import { SCAN_KINDS, scannedOperations, standingKey, standingScans, type ScanFact, type ScanKind } from '@nexus/factory-domain/production/scans/rules'
import { openStretchOf, stretchesOf, type TimingRow } from '@nexus/factory-domain/production/terminal/rules'
import { customerCodesOf } from '../dispatch/world'
import { readOperations, type OperationRow, type Reader } from '../scans/store'

/**
 * The facts of many baskets at once (owb- order workflow, S5 fl4), for the Baskets board (./board.ts), the leader's team home
 * (./team.ts) and S2's order Production tab (the board with `salesOrderId`). The caller has checked who reads and passes the
 * scope as a Bundle `where` (the brand wall included for the office); this reads in the tenant's system view (the floor role
 * reads no Party, SalesOrderLine or OrderTeam) and answers facts only — the routes choose what each audience sees (a
 * customer's CODE on the floor, its name in the office; a worker per the site's rules).
 *
 * Each basket's place is server A's ONE pure pair (factory-domain production/baskets/route.ts basketRoute + place.ts
 * basketPlace: its work order's steps plus its route edits, its standing reports plus its hand moves), its department the
 * step's (steps.ts departmentOfStep), its progress the route's steps done of all (steps.ts stepStates), its state the
 * terminal's open stretch at its step (WORKING running, PAUSED paused, else WAITING). Only ACTIVE baskets of released work
 * (RELEASED, IN_PROGRESS, ON_HOLD), at most BASKETS_MAX (oldest first; `more` says the list was cut).
 */

export const BASKETS_MAX = 600
const LIVE_WORK = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const

/** A department as the board draws it (the base's look) and orders it. */
export interface BoardDepartment extends DepartmentLook {
  readonly seq: number
  readonly floorReady: boolean
  readonly status: string
}

export interface BasketFact {
  readonly bundleId: string
  readonly code: string
  readonly quantity: number
  readonly siteId: string
  readonly companyId: string
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly partyId: string | null
  readonly salesOrderId: string | null
  /** The customer's code (the floor's label; null: no customer). */
  readonly customerCode: string | null
  /** The step it is at (null: Ready to ship) and how that is known. */
  readonly operationId: string | null
  readonly how: 'SCANS' | 'MOVE'
  readonly department: BoardDepartment | null
  readonly ready: boolean
  /** The departments of every scanned step of its route (the board's columns in use). */
  readonly routeDepartmentIds: string[]
  readonly state: 'WAITING' | 'WORKING' | 'PAUSED'
  /** The worker of the open stretch at its step (null: nobody, or nobody named). The route decides who may read it. */
  readonly workerId: string | null
  readonly progress: { readonly done: number; readonly total: number }
  /** When its route's last scanned step was reported (the team's "done today"); null: not yet. */
  readonly finishedAt: Date | null
  readonly first: boolean
  readonly late: { readonly id: string; readonly days: number; readonly reason: LateReason; readonly state: LateState } | null
  readonly problem: { readonly callId: string; readonly typeCode: string; readonly minutes: number; readonly escalated: boolean } | null
  readonly team: { readonly id: string; readonly name: string; readonly pictureKind: string; readonly pictureIcon: string | null; readonly pictureColour: string | null } | null
}

const asWords = (value: Prisma.JsonValue | null): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).flatMap(([key, word]) => (typeof word === 'string' ? [[key, word]] : []))) : {}

/** The departments of these companies (and the whole factory's), every status (an old step may name a closed one). */
export async function departmentsOf(db: Reader, companyIds: readonly string[]): Promise<BoardDepartment[]> {
  const rows = await db.department.findMany({
    where: { OR: [{ companyId: null }, ...(companyIds.length > 0 ? [{ companyId: { in: [...new Set(companyIds)] } }] : [])] },
    orderBy: [{ seq: 'asc' }, { number: 'asc' }],
    select: { id: true, number: true, name: true, shortName: true, tone: true, icon: true, nameI18n: true, seq: true, floorReady: true, status: true },
  })
  return rows.map((row) => ({ ...row, nameI18n: asWords(row.nameI18n), status: row.status as string }))
}

/** Each step's department of these work orders (route step's, else the library operation's, else its kind's default). */
async function stepDepartments(db: Reader, operationsOf: ReadonlyMap<string, OperationRow[]>, departments: readonly BoardDepartment[]): Promise<Map<string, BoardDepartment | null>> {
  const ids = [...operationsOf.values()].flat().map((operation) => operation.id)
  const rows = ids.length === 0 ? [] : await db.workOrderOperation.findMany({ where: { id: { in: ids } }, select: { id: true, routingOperation: { select: { departmentId: true } }, libraryOperation: { select: { departmentId: true } } } })
  const factsOf = new Map(rows.map((row) => [row.id, row]))
  const out = new Map<string, BoardDepartment | null>()
  for (const operation of [...operationsOf.values()].flat()) {
    const facts = factsOf.get(operation.id)
    const look = departmentOfStep({ routingDepartmentId: facts?.routingOperation?.departmentId ?? null, operationDepartmentId: facts?.libraryOperation?.departmentId ?? null, workCentreKind: operation.workCentreKind }, departments)
    out.set(operation.id, look ? (departments.find((department) => department.id === look.id) ?? null) : null)
  }
  return out
}

const BUNDLE = {
  id: true,
  code: true,
  quantity: true,
  siteId: true,
  workOrderId: true,
  createdAt: true,
  workOrder: { select: { number: true, companyId: true, partyId: true } },
  workOrderSize: { select: { salesOrderLine: { select: { orderId: true } } } },
} as const satisfies Prisma.BundleSelect

const SCAN = {
  id: true,
  kind: true,
  bundleId: true,
  workOrderOperationId: true,
  correctsId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  pauseReasonCode: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  clientScanId: true,
  deviceTime: true,
  serverTime: true,
} as const satisfies Prisma.OperationScanSelect

const groupBy = <Row, Key>(rows: readonly Row[], key: (row: Row) => Key): Map<Key, Row[]> => {
  const out = new Map<Key, Row[]>()
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row])
  return out
}

/** The facts of the ACTIVE baskets of released work matching `where` (see the file's head). */
export async function basketFacts(db: Reader, where: Prisma.BundleWhereInput, now: Date): Promise<{ readonly facts: BasketFact[]; readonly departments: BoardDepartment[]; readonly more: boolean }> {
  const found = await db.bundle.findMany({
    where: { AND: [where, { status: 'ACTIVE' }, { workOrder: { status: { in: [...LIVE_WORK] } } }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: BASKETS_MAX + 1,
    select: BUNDLE,
  })
  const more = found.length > BASKETS_MAX
  const bundles = found.slice(0, BASKETS_MAX)
  const departments = await departmentsOf(db, bundles.map((bundle) => bundle.workOrder.companyId))
  if (bundles.length === 0) return { facts: [], departments, more }
  const bundleIds = bundles.map((bundle) => bundle.id)
  const workOrderIds = [...new Set(bundles.map((bundle) => bundle.workOrderId))]

  const operationsOf = new Map<string, OperationRow[]>()
  for (const workOrderId of workOrderIds) operationsOf.set(workOrderId, await readOperations(db, workOrderId))
  const departmentOf = await stepDepartments(db, operationsOf, departments)

  const edits = groupBy(await db.basketRouteEdit.findMany({ where: { bundleId: { in: bundleIds } }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }], select: { bundleId: true, kind: true, operationId: true } }), (row) => row.bundleId)
  const moves = groupBy(await db.basketMove.findMany({ where: { bundleId: { in: bundleIds } }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }], select: { id: true, bundleId: true, kind: true, fromOperationId: true, toOperationId: true, undoesId: true, serverTime: true } }), (row) => row.bundleId)
  const scans = await db.operationScan.findMany({ where: { bundleId: { in: bundleIds } }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }], select: SCAN })
  const counts = scans.filter((scan) => (SCAN_KINDS as readonly string[]).includes(scan.kind)) as unknown as (ScanFact & { kind: ScanKind })[]
  const standing = standingScans(counts)
  const timingOf = groupBy(scans, (scan) => `${scan.bundleId}|${scan.workOrderOperationId}`)

  const flagged = new Set((await db.basketFlag.findMany({ where: { bundleId: { in: bundleIds }, kind: 'FIRST', clearedAt: null }, select: { bundleId: true } })).map((row) => row.bundleId))
  const lates = await db.floorLateWarning.findMany({ where: { workOrderId: { in: workOrderIds }, state: 'OPEN' }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: { id: true, workOrderId: true, bundleId: true, days: true, reason: true, state: true } })
  const problems = await db.helpCall.findMany({
    where: { bundleId: { in: bundleIds }, status: { in: [...OPEN_CALL_STATUSES] }, type: { code: { in: [...FLOOR_PROBLEM_CODES] } } },
    orderBy: [{ sentAt: 'desc' }, { id: 'asc' }],
    select: { id: true, bundleId: true, sentAt: true, escalatedAt: true, type: { select: { code: true } } },
  })
  const salesOrderIds = [...new Set(bundles.flatMap((bundle) => (bundle.workOrderSize.salesOrderLine?.orderId ? [bundle.workOrderSize.salesOrderLine.orderId] : [])))]
  const orderTeams = salesOrderIds.length === 0
    ? []
    : await db.orderTeam.findMany({
        where: { salesOrderId: { in: salesOrderIds }, endedAt: null },
        orderBy: [{ inCharge: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { salesOrderId: true, bundleIds: true, team: { select: { id: true, name: true, pictureKind: true, pictureIcon: true, pictureColour: true } } },
      })
  const codes = await customerCodesOf(db, workOrderIds)

  const facts = bundles.map((bundle): BasketFact => {
    const operations = operationsOf.get(bundle.workOrderId) ?? []
    const route = basketRoute(operations, (edits.get(bundle.id) ?? []) as RouteEditFact[])
    const place = basketPlace(route, standing, bundle.id, (moves.get(bundle.id) ?? []) as MoveFact[])
    const steps = stepStates(route, place)
    const scanned = steps.filter((step) => step.state !== 'SKIPPED')
    const department = place.operationId ? (departmentOf.get(place.operationId) ?? null) : null
    const rows = place.operationId ? ((timingOf.get(`${bundle.id}|${place.operationId}`) ?? []) as TimingRow[]) : []
    const open = openStretchOf(stretchesOf(rows))
    const salesOrderId = bundle.workOrderSize.salesOrderLine?.orderId ?? null
    const teamRows = salesOrderId ? orderTeams.filter((row) => row.salesOrderId === salesOrderId) : []
    const team = (teamRows.find((row) => row.bundleIds.includes(bundle.id)) ?? teamRows.find((row) => row.bundleIds.length === 0))?.team ?? null
    const late = lates.find((row) => row.workOrderId === bundle.workOrderId && (row.bundleId === null || row.bundleId === bundle.id)) ?? null
    const problem = problems.find((row) => row.bundleId === bundle.id) ?? null
    const last = scannedOperations(route).at(-1) ?? null
    return {
      bundleId: bundle.id,
      code: bundle.code,
      quantity: bundle.quantity,
      siteId: bundle.siteId,
      companyId: bundle.workOrder.companyId,
      workOrderId: bundle.workOrderId,
      workOrderNumber: bundle.workOrder.number,
      partyId: bundle.workOrder.partyId,
      salesOrderId,
      customerCode: codes.get(bundle.workOrderId) ?? null,
      operationId: place.operationId,
      how: place.how,
      department,
      ready: place.operationId === null,
      routeDepartmentIds: [...new Set(scannedOperations(route).flatMap((operation) => (departmentOf.get(operation.id) ? [departmentOf.get(operation.id)!.id] : [])))],
      state: open?.open === 'RUNNING' ? 'WORKING' : open?.open === 'PAUSED' ? 'PAUSED' : 'WAITING',
      workerId: open?.workerId ?? null,
      progress: { done: scanned.filter((step) => step.state === 'DONE').length, total: scanned.length },
      finishedAt: last ? (standing.get(standingKey(bundle.id, last.id))?.serverTime ?? null) : null,
      first: flagged.has(bundle.id),
      late: late ? { id: late.id, days: late.days, reason: late.reason as LateReason, state: late.state as LateState } : null,
      problem: problem ? { callId: problem.id, typeCode: problem.type.code, minutes: minutesOpen(problem.sentAt, now), escalated: problem.escalatedAt !== null } : null,
      team: team ? { id: team.id, name: team.name, pictureKind: team.pictureKind as string, pictureIcon: team.pictureIcon, pictureColour: team.pictureColour } : null,
    }
  })
  return { facts, departments, more }
}

/** The Bundle `where` of a sales order's baskets (its lines' cells). */
export const ofSalesOrder = (salesOrderId: string): Prisma.BundleWhereInput => ({ workOrderSize: { salesOrderLine: { is: { orderId: salesOrderId } } } })

/**
 * The Bundle `where` of a team's baskets: the bundles of the orders it has an open OrderTeam row of (a row naming baskets: those
 * only). `rows`: the team's open rows.
 */
export function ofTeamOrders(rows: readonly { readonly salesOrderId: string; readonly bundleIds: readonly string[] }[]): Prisma.BundleWhereInput {
  if (rows.length === 0) return { id: { in: [] } }
  return {
    OR: rows.map((row) => (row.bundleIds.length > 0 ? { id: { in: [...row.bundleIds] } } : ofSalesOrder(row.salesOrderId))),
  }
}

/**
 * Where each of these baskets is (Give to…'s seam: a bundle named without its step), by the same pair: its work order's steps
 * plus its route edits, its standing reports plus its hand moves. Read in the caller's own scope (the floor reads its site's
 * bundles, scans, moves and edits).
 */
export async function basketPlacesOf(db: Reader, bundleIds: readonly string[]): Promise<Map<string, { readonly workOrderId: string; readonly operationId: string | null }>> {
  const ids = [...new Set(bundleIds)]
  const bundles = ids.length === 0 ? [] : await db.bundle.findMany({ where: { id: { in: ids } }, select: { id: true, workOrderId: true } })
  const out = new Map<string, { workOrderId: string; operationId: string | null }>()
  if (bundles.length === 0) return out
  const edits = groupBy(await db.basketRouteEdit.findMany({ where: { bundleId: { in: ids } }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }], select: { bundleId: true, kind: true, operationId: true } }), (row) => row.bundleId)
  const moves = groupBy(await db.basketMove.findMany({ where: { bundleId: { in: ids } }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }], select: { id: true, bundleId: true, kind: true, fromOperationId: true, toOperationId: true, undoesId: true, serverTime: true } }), (row) => row.bundleId)
  const counts = (await db.operationScan.findMany({ where: { bundleId: { in: ids }, kind: { in: [...SCAN_KINDS] } }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }], select: SCAN })) as unknown as (ScanFact & { kind: ScanKind })[]
  const standing = standingScans(counts)
  const operationsOf = new Map<string, OperationRow[]>()
  for (const workOrderId of new Set(bundles.map((bundle) => bundle.workOrderId))) operationsOf.set(workOrderId, await readOperations(db, workOrderId))
  for (const bundle of bundles) {
    const route = basketRoute(operationsOf.get(bundle.workOrderId) ?? [], (edits.get(bundle.id) ?? []) as RouteEditFact[])
    out.set(bundle.id, { workOrderId: bundle.workOrderId, operationId: basketPlace(route, standing, bundle.id, (moves.get(bundle.id) ?? []) as MoveFact[]).operationId })
  }
  return out
}
