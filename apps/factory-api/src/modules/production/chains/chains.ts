import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { NOTHING_LEFT, nextToReport, slowestStep } from '@nexus/factory-domain/production/baskets/board'
import { departmentOfStep } from '@nexus/factory-domain/production/baskets/steps'
import { previousStep, standingScans } from '@nexus/factory-domain/production/scans/rules'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { departmentsOf } from '../baskets/board-store'
import { refuse } from '../calls/access'
import { wipFor } from '../scans/progress'
import { floorOf, systemView } from '../scans/access'
import { reportScan } from '../scans/scans'
import { readCells, readOperations, readScanByClient, readWorkOrderScans, type Reader } from '../scans/store'
import { workOrderWhere } from '../work-orders/scope'

/**
 * Chains (owb- order workflow, S5 fl4 step 3; `_owb-fl-common.md` § 3 "fl4", settle 10; design P/lines.js chainHead, chainMatrix
 * (the office: lots × steps, red = the slowest), chainSteps (the floor: ONE step, the lots as big rows, "+12" / "−12")):
 *
 *   GET  /production/chains                       the lines with live work (RELEASED, IN_PROGRESS, ON_HOLD) allocated to them
 *   GET  /production/chains/:lineId?operationId=  the line's work orders (all of them: several on one line are several
 *                                                 work orders), each one's WIP per size × step exactly as today's scans count
 *                                                 it (factory-domain scans/wip.ts through modules/production/scans/progress
 *                                                 wipFor), and the slowest step (most garments waiting)
 *   POST /production/chains/report                "+12": the cell's next ACTIVE bundle not reported yet at that step (one that
 *                                                 reached it first) is reported in full (good = its quantity) through TODAY's
 *                                                 REPORT command (modules/production/scans reportScan: pay, cost, guards and
 *                                                 holds unchanged); nothing left → "Every bundle of this size is done here."
 *                                                 "−12" is the worker's own Undo of that scan (today's 2-minute rule, the queue
 *                                                 kind production.scan.undo).
 *
 * Who: the office with workorders.view (the base's page row), only the work orders it reaches (the brand wall); the floor with
 * production.scan at its own site. A lot is a model (the style's code and the colourway's) and a size: no customer, no money,
 * no person.
 */

const LIVE_WORK = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
type ChainContext = OfficeContext | FloorContext

function chainContextOf(caller: Pick<CommandCaller, 'factoryContext'>): { readonly context: ChainContext; readonly right: Permission; readonly actor: Actor } {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office' && context.audience !== 'floor') throw new ForbiddenError()
  const actor = actorOf(context)
  const right = context.audience === 'floor' ? PRODUCTION_SCAN : WORKORDERS_VIEW
  if (!holds(actor, right)) throw new ForbiddenError(context.audience === 'floor' ? 'The chains are read on a floor device signed in to scan.' : 'The chains need the right to see the work orders.')
  return { context, right, actor }
}

/** The work orders a reader may see on lines: the floor at its site; the office within the brand wall. */
const workWhere = (context: ChainContext, right: Permission, actor: Actor): Prisma.WorkOrderWhereInput =>
  context.audience === 'floor' ? { siteId: context.siteId, status: { in: [...LIVE_WORK] } } : { AND: [workOrderWhere(actor, right), { status: { in: [...LIVE_WORK] } }] }

/** GET /production/chains. */
export async function chains(caller: CommandCaller) {
  const { context, right, actor } = chainContextOf(caller)
  return systemView(caller).withClient(async (db) => {
    const counts = await db.workOrder.groupBy({ by: ['lineId'], where: { AND: [workWhere(context, right, actor), { lineId: { not: null } }] }, _count: { _all: true } })
    const lineIds = counts.flatMap((row) => (row.lineId ? [row.lineId] : []))
    const lineScope = context.audience === 'floor' ? { siteId: context.siteId } : (scopeWhere(actor, right, { company: 'companyId', site: 'siteId' }) as Prisma.LineWhereInput)
    const lines = lineIds.length === 0 ? [] : await db.line.findMany({ where: { AND: [{ id: { in: lineIds } }, lineScope] }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, name: true } })
    return { lines: lines.map((line) => ({ ...line, workOrders: counts.find((row) => row.lineId === line.id)?._count._all ?? 0 })) }
  })
}

/** The line as the reader may read it, or not found. */
async function knownLine(db: Reader, context: ChainContext, right: Permission, actor: Actor, lineId: string) {
  const line = isUuid(lineId) ? await db.line.findUnique({ where: { id: lineId }, select: { id: true, code: true, name: true, siteId: true, companyId: true } }) : null
  if (!line || (context.audience === 'floor' && line.siteId !== context.siteId) || !can(actor, right, { companyId: line.companyId, siteId: line.siteId })) throw new NotFoundError('Line not found.')
  return line
}

/** GET /production/chains/:lineId. */
export async function chainOf(caller: CommandCaller, lineId: string, query: { readonly operationId?: string | undefined }) {
  const { context, right, actor } = chainContextOf(caller)
  return systemView(caller).withClient(async (db) => {
    const line = await knownLine(db, context, right, actor, lineId)
    const workOrders = await db.workOrder.findMany({ where: { AND: [workWhere(context, right, actor), { lineId: line.id }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, siteId: true, companyId: true, styleId: true } })
    const departments = await departmentsOf(db, [line.companyId])
    const styles = new Map((workOrders.length === 0 ? [] : await db.style.findMany({ where: { id: { in: [...new Set(workOrders.map((workOrder) => workOrder.styleId))] } }, select: { id: true, code: true } })).map((style) => [style.id, style.code]))
    const steps: { operationId: string; workOrderId: string; name: string; department: (typeof departments)[number] | null; waiting: number; done: number }[] = []
    const lots: { workOrderSizeId: string; workOrderId: string; model: string; size: string; perStep: { operationId: string; done: number; waiting: number }[] }[] = []
    for (const workOrder of workOrders) {
      const operations = await readOperations(db, workOrder.id)
      if (query.operationId && !operations.some((operation) => operation.id === query.operationId)) continue
      const wip = await wipFor(db, workOrder)
      const facts = new Map((await db.workOrderOperation.findMany({ where: { workOrderId: workOrder.id }, select: { id: true, routingOperation: { select: { departmentId: true } }, libraryOperation: { select: { departmentId: true } } } })).map((row) => [row.id, row]))
      const shown = wip.operations.filter((operation) => operation.scanRequired && (!query.operationId || operation.operationId === query.operationId))
      for (const operation of shown) {
        const kind = operations.find((entry) => entry.id === operation.operationId)?.workCentreKind ?? 'SEWING'
        const fact = facts.get(operation.operationId)
        const look = departmentOfStep({ routingDepartmentId: fact?.routingOperation?.departmentId ?? null, operationDepartmentId: fact?.libraryOperation?.departmentId ?? null, workCentreKind: kind }, departments)
        steps.push({ operationId: operation.operationId, workOrderId: workOrder.id, name: operation.name, department: look ? (departments.find((department) => department.id === look.id) ?? null) : null, waiting: operation.waiting, done: operation.good })
      }
      for (const cell of await readCells(db, workOrder.id)) {
        lots.push({
          workOrderSizeId: cell.id,
          workOrderId: workOrder.id,
          model: [styles.get(workOrder.styleId), cell.colourwayCode].filter((part) => part).join(' '),
          size: cell.size,
          perStep: shown.map((operation) => {
            const flow = operation.cells.find((entry) => entry.workOrderSizeId === cell.id)
            return { operationId: operation.operationId, done: flow?.good ?? 0, waiting: flow?.waiting ?? 0 }
          }),
        })
      }
    }
    const slowest = slowestStep(steps)
    return {
      line: { id: line.id, code: line.code, name: line.name },
      steps: steps.map((step) => ({ ...step, department: step.department ? { id: step.department.id, number: step.department.number, name: step.department.name, shortName: step.department.shortName, tone: step.department.tone, icon: step.department.icon, nameI18n: step.department.nameI18n } : null, slowest: step.operationId === slowest })),
      lots,
    }
  })
}

export interface ChainReportBody {
  readonly lineId: string
  readonly operationId: string
  readonly workOrderSizeId: string
  readonly clientEventId: string
}

/** POST /production/chains/report: "+12" (see the file's head). */
export async function reportOnChain(caller: CommandCaller, body: ChainReportBody) {
  const context = floorOf(caller)
  const actor = actorOf(context)
  const picked = await systemView(caller).withClient(async (db) => {
    // A resent tap: the scan this device made under the id, nothing picked again.
    const before = await readScanByClient(db, context.deviceId, body.clientEventId)
    if (before) {
      const bundle = await db.bundle.findUnique({ where: { id: before.bundleId }, select: { id: true, code: true, quantity: true } })
      return { replay: before, bundle: bundle! }
    }
    const operation = isUuid(body.operationId) ? await db.workOrderOperation.findUnique({ where: { id: body.operationId }, select: { id: true, workOrderId: true, workOrder: { select: { siteId: true, companyId: true, lineId: true, status: true } } } }) : null
    if (!operation || operation.workOrder.siteId !== context.siteId || operation.workOrder.lineId !== body.lineId || !can(actor, PRODUCTION_SCAN, { companyId: operation.workOrder.companyId, siteId: operation.workOrder.siteId })) throw new NotFoundError('Step not found on this line.')
    const cell = await db.workOrderSize.findFirst({ where: { id: body.workOrderSizeId, workOrderId: operation.workOrderId }, select: { id: true } })
    if (!cell) throw new NotFoundError('Size not found on this work order.')
    const operations = await readOperations(db, operation.workOrderId)
    const standing = standingScans(await readWorkOrderScans(db, operation.workOrderId))
    const bundles = await db.bundle.findMany({ where: { workOrderId: operation.workOrderId, workOrderSizeId: cell.id }, select: { id: true, code: true, quantity: true, workOrderSizeId: true, status: true, createdAt: true } })
    const next = nextToReport(bundles, { workOrderSizeId: cell.id, operationId: operation.id, previousOperationIds: previousStep(operations, operation.id).map((step) => step.id), standing: new Set(standing.keys()) })
    if (!next) refuse(NOTHING_LEFT)
    return { replay: null, bundle: next! }
  })
  if (picked.replay) return { scan: { id: picked.replay.id }, bundle: { id: picked.bundle.id, code: picked.bundle.code, quantity: picked.bundle.quantity }, operationId: picked.replay.workOrderOperationId, replayed: true }
  // Today's REPORT, as a scan of the bundle at the step (the device's own session: its worker, its station, its guards).
  const answer = await reportScan(caller, { clientScanId: body.clientEventId, bundleId: picked.bundle.id, workOrderOperationId: body.operationId, good: picked.bundle.quantity })
  return { scan: { id: answer.scan.id }, bundle: { id: picked.bundle.id, code: picked.bundle.code, quantity: picked.bundle.quantity }, operationId: body.operationId, replayed: answer.replayed }
}
