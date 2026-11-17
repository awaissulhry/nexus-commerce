import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, reachesEveryParty, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_FIRM } from '@nexus/factory-domain/planning/mrp/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PLANNING_PLANNED_CONVERT } from '@nexus/factory-domain/planning/planned-orders/permissions'
// B-W2b-306 (PLN-076, PLN-083): edits, the plan's values of protected fields, late planned orders.
import { PLANNING_PLANNED_EDIT } from '@nexus/factory-domain/planning/actions/permissions'
import { lateOf, readPlanValues } from '@nexus/factory-domain/planning/actions/protect'
import { protectedPlanOf, readRunInputs } from '@nexus/factory-domain/planning/run-log/inputs'
import { convertProblem, demandOf, needDateOf, PROTECTABLE_FIELDS, sizesOf, type PlannedOrderKind, type PlannedOrderStatus } from '@nexus/factory-domain/planning/planned-orders/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMayAt, mayAt, officeContextOf, siteFor } from '../access'
import { latestDoneRun } from '../inputs'
import { dayOf, type Reader } from '../store'
import type { PlannedOrderView } from './contract'
import { PLANNED_COLUMNS, readPlanned, type PlannedRow } from './store'
// B-W2b-365: the steps a planned order's cells are for.
import { STEP_VARIANT_COLUMNS } from '../capacity/steps'
import { cellsOfDemand, lineOptionsOf, stepsForCells } from './steps'
// B-W2b-GB29 (G219): a planned subcontract order's workshop load, in words.
import { businessDate } from '@nexus/factory-domain/core/time'
import { roomFor } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { serverClock } from '../../../core/time'
import { SITE_COLUMNS } from '../store'
import { capacityRowOf, closedDaysOf, readCapacityRows, readJobs } from '../subcontract-capacity/store'

/**
 * Reading the planned orders (B-W2b-293; design planning.mrp "To make"): the site's planned work orders and planned
 * subcontract orders with what each makes (style, colourway, the revision the lines name, its size run and group), when
 * (start, due, the kit's leaving time), for whom (the order lines it pegs), on which line or at which workshop and its
 * steps, firm or not, what a planner protected, and what it became once made real. planning.view over the site; `may`
 * says what the caller may do with it (the screen holds the rest with the reason). No money, no person.
 */

/** The rows' names and links, read once for a page of rows. */
async function contextOf(db: Reader, rows: readonly PlannedRow[]) {
  const ids = <T>(pick: (row: PlannedRow) => T | null | undefined) => [...new Set(rows.flatMap((row) => { const value = pick(row); return value === null || value === undefined ? [] : [value] }))] as T[]
  const styleIds = ids((row) => row.styleId)
  const styles = styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })
  const colourwayIds = ids((row) => row.colourwayId)
  const colourways = colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } })
  // The revision each row plans: the one it names, else the style's RELEASED one (its routing names the steps).
  const named = ids((row) => row.styleRevisionId)
  const released = styleIds.length === 0 ? [] : await db.styleRevision.findMany({ where: { styleId: { in: styleIds }, status: 'RELEASED' }, select: { id: true, styleId: true, revision: true, status: true }, orderBy: { revision: 'desc' } })
  const namedRows = named.length === 0 ? [] : await db.styleRevision.findMany({ where: { id: { in: named } }, select: { id: true, styleId: true, revision: true, status: true } })
  const revisionOf = new Map([...released, ...namedRows].map((row) => [row.id, row]))
  const releasedOf = new Map<string, (typeof released)[number]>()
  for (const row of released) if (!releasedOf.has(row.styleId)) releasedOf.set(row.styleId, row)
  const plannedRevisionIds = [...new Set(rows.flatMap((row) => { const id = row.styleRevisionId ?? releasedOf.get(row.styleId)?.id; return id ? [id] : [] }))]
  const steps = plannedRevisionIds.length === 0 ? [] : await db.routingOperation.findMany({ where: { revisionId: { in: plannedRevisionIds } }, select: { revisionId: true, seq: true, code: true, name: true, supplierId: true, /* B-W2b-365 */ ...STEP_VARIANT_COLUMNS }, orderBy: [{ revisionId: 'asc' }, { seq: 'asc' }] })
  const partyIds = ids((row) => row.partyId)
  const parties = partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const lineIds = ids((row) => row.lineId)
  const lines = lineIds.length === 0 ? [] : await db.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })
  const orderLineIds = [...new Set(rows.flatMap((row) => demandOf(row.demand).map((entry) => entry.orderLineId)))]
  const orderLines = orderLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, seq: true, order: { select: { id: true, number: true } } } })
  const options = await lineOptionsOf(db, orderLineIds) // B-W2b-365
  const workOrderIds = ids((row) => row.workOrderId)
  const workOrders = workOrderIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true } })
  const subcontractIds = ids((row) => row.subcontractOrderId)
  const subcontracts = subcontractIds.length === 0 ? [] : await db.subcontractOrder.findMany({ where: { id: { in: subcontractIds } }, select: { id: true, number: true, status: true } })
  // B-W2b-306 (PLN-076): the latest DONE run's log of each site (the plan's values of protected fields).
  const logs = new Map<string, ReturnType<typeof readRunInputs>>()
  for (const siteId of rows.some((row) => row.protectedFields.length > 0) ? ids((row) => row.siteId) : []) {
    const run = await latestDoneRun(db, siteId)
    const stored = run ? await db.planningRun.findUnique({ where: { id: run.id }, select: { inputs: true } }) : null
    logs.set(siteId, readRunInputs(stored?.inputs ?? null))
  }
  return {
    logOf: (siteId: string) => logs.get(siteId) ?? null,
    style: new Map(styles.map((row) => [row.id, row])),
    colourway: new Map(colourways.map((row) => [row.id, row])),
    revisionOf,
    releasedOf,
    stepsOf: (revisionId: string | undefined) => steps.filter((step) => step.revisionId === revisionId),
    party: new Map(parties.map((row) => [row.id, row])),
    line: new Map(lines.map((row) => [row.id, row])),
    orderLine: new Map(orderLines.map((row) => [row.id, row])),
    options,
    workOrder: new Map(workOrders.map((row) => [row.id, row])),
    subcontract: new Map(subcontracts.map((row) => [row.id, row])),
  }
}

type Context = Awaited<ReturnType<typeof contextOf>>

/** One row as the screen reads it. */
export function plannedOrderViewOf(row: PlannedRow, facts: Context, office: OfficeContext): PlannedOrderView {
  const style = facts.style.get(row.styleId)
  const colourway = facts.colourway.get(row.colourwayId)
  const named = row.styleRevisionId ? facts.revisionOf.get(row.styleRevisionId) : undefined
  const planned = named ?? facts.releasedOf.get(row.styleId)
  // B-W2b-365: of its routing, the steps one of its cells is for (the order lines' sizes and chosen options).
  const steps = stepsForCells(facts.stepsOf(planned?.id), cellsOfDemand(row.colourwayId, demandOf(row.demand), facts.options))
  const party = row.partyId ? facts.party.get(row.partyId) : undefined
  const line = row.lineId ? facts.line.get(row.lineId) : undefined
  const workOrder = row.workOrderId ? facts.workOrder.get(row.workOrderId) : undefined
  const subcontract = row.subcontractOrderId ? facts.subcontract.get(row.subcontractOrderId) : undefined
  const demand = demandOf(row.demand)
  // The routing's outside steps a MAKE row does not send out (no usable workshop): said, never hidden.
  const outsideSteps = steps.filter((step) => step.supplierId !== null)
  const status = row.status as PlannedOrderStatus
  const held = convertProblem({ status, demand, workOrderNumber: workOrder?.number ?? null }) ?? (planned ? null : 'Its style has no released revision to make it to.')
  return {
    id: row.id,
    kind: row.kind as PlannedOrderKind,
    status,
    siteId: row.siteId,
    runId: row.runId,
    style: { id: row.styleId, code: style?.code ?? '', name: style?.name ?? '' },
    colourway: { id: row.colourwayId, code: colourway?.code ?? '' },
    revision: named ? { id: named.id, revision: named.revision, status: named.status } : null,
    plannedRevision: planned ? { id: planned.id, revision: planned.revision, status: planned.status } : null,
    sizes: sizesOf(row.sizes),
    quantity: row.quantity,
    sizeGroup: row.sizeGroup,
    startDate: dayOf(row.startDate),
    dueDate: dayOf(row.dueDate),
    demand: demand.map((entry) => {
      const orderLine = facts.orderLine.get(entry.orderLineId)
      return { orderId: entry.orderId, orderNumber: orderLine?.order.number ?? '', orderLineId: entry.orderLineId, lineSeq: orderLine?.seq ?? 0, size: entry.size, pieces: entry.pieces }
    }),
    line: line ? { id: line.id, code: line.code, name: line.name } : null,
    workshop: party ? { id: party.id, code: party.code, name: party.tradeName ?? party.legalName } : null,
    operations: steps.filter((step) => (row.kind === 'SUBCONTRACT' ? row.operationSeqs.length === 0 || row.operationSeqs.includes(step.seq) : false)).map((step) => ({ seq: step.seq, code: step.code, name: step.name })),
    outsideStepsInHouse: row.kind === 'MAKE' ? outsideSteps.map((step) => ({ seq: step.seq, code: step.code, name: step.name })) : [],
    kitDueAt: row.kitDueAt ? toUtcIso(row.kitDueAt) : null,
    firm: row.firm,
    firmedAt: row.firmedAt ? toUtcIso(row.firmedAt) : null,
    protectedFields: row.protectedFields.filter((field): field is (typeof PROTECTABLE_FIELDS)[number] => (PROTECTABLE_FIELDS as readonly string[]).includes(field)),
    workOrder: workOrder ? { id: workOrder.id, number: workOrder.number, status: workOrder.status } : null,
    subcontractOrder: subcontract ? { id: subcontract.id, number: subcontract.number, status: subcontract.status } : null,
    convertedAt: row.convertedAt ? toUtcIso(row.convertedAt) : null,
    note: row.note,
    version: row.version,
    held,
    // B-W2b-306 (PLN-083, PLN-076).
    late: lateOfRow(row, demand, facts),
    workshopLoad: null, // B-W2b-GB29 (G219): filled by viewsOf (a read of the workshops' load)
    plan: row.protectedFields.length > 0 ? planViewOf(readPlanValues(protectedPlanOf(facts.logOf(row.siteId), row.id))) : {},
    may: { convert: status === 'PLANNED' && mayAt(office, PLANNING_PLANNED_CONVERT, row), firm: status === 'PLANNED' && mayAt(office, PLANNING_FIRM, row), edit: status === 'PLANNED' && mayAt(office, PLANNING_PLANNED_EDIT, row) },
  }
}

/** B-W2b-306 (PLN-076): the plan's values of the protected fields, as answered. */
function planViewOf(values: ReturnType<typeof readPlanValues>): PlannedOrderView['plan'] {
  const { sizes, operationSeqs, ...rest } = values
  return { ...rest, ...(sizes ? { sizes: sizes.map((entry) => ({ ...entry })) } : {}), ...(operationSeqs ? { operationSeqs: [...operationSeqs] } : {}) }
}

/** B-W2b-306 (PLN-083): a planned order due after its demand's day, with the reason in words. */
function lateOfRow(row: PlannedRow, demand: ReturnType<typeof demandOf>, facts: Context): PlannedOrderView['late'] {
  if (row.status !== 'PLANNED' || demand.length === 0) return null
  const due = dayOf(row.dueDate)
  const late = lateOf(needDateOf(demand, due), due)
  if (!late) return null
  const first = demand.find((entry) => entry.needDate === late.needDate) ?? demand[0]!
  const orderLine = facts.orderLine.get(first.orderLineId)
  const label = orderLine ? `${orderLine.order.number} line ${orderLine.seq}` : 'Its order line'
  const days = `${late.daysLate} ${late.daysLate === 1 ? 'day' : 'days'} late`
  // A planner's due date says so; else the plan could not make it in time (it starts today at the earliest).
  if (row.protectedFields.includes('dueDate')) return { ...late, reason: `${label} needs it on ${late.needDate}; its due date ${due} is protected (${days}).` }
  return { ...late, reason: `${label} needs it on ${late.needDate}; it starts ${dayOf(row.startDate)} and cannot be ready before ${due} (${days}).` }
}

export async function viewsOf(db: Reader, rows: readonly PlannedRow[], office: OfficeContext): Promise<PlannedOrderView[]> {
  const facts = await contextOf(db, rows)
  const loads = await workshopLoadsOf(db, rows) // B-W2b-GB29 (G219)
  return rows.map((row) => ({ ...plannedOrderViewOf(row, facts, office), workshopLoad: loads.get(row.id) ?? null }))
}

/**
 * B-W2b-GB29 (G219): a planned subcontract order's workshop load on its days, in words: the work booked there (live orders, the
 * allocation board's parts, the plan's other planned subcontract orders) with it, against the workshop's weekly capacity
 * (factory-domain planning/subcontract-capacity `roomFor`, as the run levelled it). Null: not a planned subcontract order.
 */
async function workshopLoadsOf(db: Reader, rows: readonly PlannedRow[]): Promise<Map<string, NonNullable<PlannedOrderView['workshopLoad']>>> {
  const out = new Map<string, NonNullable<PlannedOrderView['workshopLoad']>>()
  const asked = rows.filter((row) => row.kind === 'SUBCONTRACT' && row.status === 'PLANNED' && row.partyId)
  for (const siteId of [...new Set(asked.map((row) => row.siteId))]) {
    const site = await db.site.findUnique({ where: { id: siteId }, select: SITE_COLUMNS })
    if (!site) continue
    const jobs = await readJobs(db, site, businessDate(serverClock.now(), site.timezone))
    const mine = asked.filter((row) => row.siteId === siteId)
    const partyIds = [...new Set(mine.map((row) => row.partyId!))]
    const capacity = (await readCapacityRows(db, partyIds)).map(capacityRowOf)
    const codes = new Map((await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true } })).map((party) => [party.id, party.code]))
    for (const row of mine) {
      const own = jobs.find((job) => job.kind === 'PLANNED' && job.id === row.id)
      if (!own) continue
      const shut = (await closedDaysOf(db, [own.partyId], own.from, own.to)).get(own.partyId) ?? new Set<string>()
      const room = roomFor(capacity, jobs.filter((job) => job !== own), own, shut)
      const code = codes.get(own.partyId) ?? 'The workshop'
      out.set(row.id, {
        loadPct: room.loadPct,
        over: room.known && !room.fits,
        words: !room.known ? `${code} has no weekly capacity set.` : room.fits ? `${code} has room on these days (${room.loadPct} % with it).` : `${code} is over its capacity on these days (${room.loadPct} % with it).`,
      })
    }
  }
  return out
}

// ── B-PR-07 ──
/**
 * B-PR-07 (production plan §2, the brand wall): of `rows`, the planned orders `permission` reaches. A planned order is of the
 * customer of the order lines it makes (one customer each, B-PR-03); a person of every customer at its site reaches every one;
 * one limited to some customers reaches it only when every order line it pegs is of a customer they reach. One that makes for
 * stock (no order line) names no customer: only with every customer, as a work order of no customer.
 */
export async function reachedPlanned(db: Reader, office: OfficeContext, permission: Permission, rows: readonly Pick<PlannedRow, 'id' | 'companyId' | 'siteId' | 'demand'>[]): Promise<Set<string>> {
  const actor = actorOf(office)
  const limited = rows.filter((row) => !reachesEveryParty(actor, permission, { companyId: row.companyId, siteId: row.siteId }))
  const lineIds = [...new Set(limited.flatMap((row) => demandOf(row.demand).map((entry) => entry.orderLineId)))]
  const partyOf = new Map(lineIds.length === 0 ? [] : (await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, partyId: true } })).map((line) => [line.id, line.partyId]))
  const out = new Set(rows.map((row) => row.id))
  for (const row of limited) {
    const demand = demandOf(row.demand)
    const reached = demand.length > 0 && demand.every((entry) => {
      const partyId = partyOf.get(entry.orderLineId)
      return typeof partyId === 'string' && can(actor, permission, { companyId: row.companyId, siteId: row.siteId, partyId })
    })
    if (!reached) out.delete(row.id)
  }
  return out
}
// ── end B-PR-07 ──

export interface ListQuery {
  readonly siteId: string
  readonly status?: PlannedOrderStatus | undefined
  readonly kind?: PlannedOrderKind | undefined
}

/** GET /planning/planned-orders: the site's planned orders (default: still PLANNED, "To make"), soonest start first. */
export async function listPlannedOrders(caller: CommandCaller, query: ListQuery) {
  const office = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const where: Prisma.PlannedWorkOrderWhereInput = {
      AND: [
        scopeWhere(actorOf(office), PLANNING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.PlannedWorkOrderWhereInput,
        { siteId: site.id, status: query.status ?? 'PLANNED' },
        query.kind ? { kind: query.kind } : {},
      ],
    }
    const run = await latestDoneRun(db, site.id)
    // B-PR-07: a person limited to some customers gets the planned orders of those customers, and counts of them only.
    if (!reachesEveryParty(actorOf(office), PLANNING_VIEW, { companyId: site.companyId, siteId: site.id })) {
      const open = await db.plannedWorkOrder.findMany({ where: { siteId: site.id, status: 'PLANNED' }, select: { id: true, companyId: true, siteId: true, demand: true, kind: true, firm: true } })
      const reachedOpen = await reachedPlanned(db, office, PLANNING_VIEW, open)
      const mine = open.filter((row) => reachedOpen.has(row.id))
      const listed = await db.plannedWorkOrder.findMany({ where, select: PLANNED_COLUMNS, orderBy: [{ startDate: 'asc' }, { dueDate: 'asc' }, { id: 'asc' }] })
      const reached = await reachedPlanned(db, office, PLANNING_VIEW, listed)
      return {
        siteId: site.id,
        run: run ? { id: run.id, startedAt: toUtcIso(run.startedAt), finishedAt: run.finishedAt ? toUtcIso(run.finishedAt) : null } : null,
        counts: { make: mine.filter((row) => row.kind === 'MAKE').length, subcontract: mine.filter((row) => row.kind === 'SUBCONTRACT').length, firm: mine.filter((row) => row.firm).length },
        plannedOrders: await viewsOf(db, listed.filter((row) => reached.has(row.id)).slice(0, 500), office),
      }
    }
    const rows = await db.plannedWorkOrder.findMany({ where, select: PLANNED_COLUMNS, orderBy: [{ startDate: 'asc' }, { dueDate: 'asc' }, { id: 'asc' }], take: 500 })
    const all = await db.plannedWorkOrder.groupBy({ by: ['kind'], where: { siteId: site.id, status: 'PLANNED' }, _count: { _all: true } })
    const firm = await db.plannedWorkOrder.count({ where: { siteId: site.id, status: 'PLANNED', firm: true } })
    return {
      siteId: site.id,
      run: run ? { id: run.id, startedAt: toUtcIso(run.startedAt), finishedAt: run.finishedAt ? toUtcIso(run.finishedAt) : null } : null,
      counts: { make: all.find((row) => row.kind === 'MAKE')?._count._all ?? 0, subcontract: all.find((row) => row.kind === 'SUBCONTRACT')?._count._all ?? 0, firm },
      plannedOrders: await viewsOf(db, rows, office),
    }
  })
}

/** The row the caller sees with planning.view and acts on with `permission` (else 404 / 403). */
export async function plannedFor(caller: CommandCaller, id: string, permission: Permission = PLANNING_VIEW): Promise<PlannedRow> {
  const office = officeContextOf(caller)
  const row = isUuid(id) ? await caller.withClient((db) => readPlanned(db, id)) : null
  // B-PR-07: another customer's planned order is as unknown (404), for every read and write that names it.
  const reached = row ? (await caller.withClient((db) => reachedPlanned(db, office, PLANNING_VIEW, [row]))).has(row.id) : false
  assertMayAt(office, permission, reached ? row : null, 'Planned work order')
  return row!
}

/** GET /planning/planned-orders/:plannedOrderId */
export async function getPlannedOrder(caller: CommandCaller, id: string): Promise<{ plannedOrder: PlannedOrderView }> {
  const office = officeContextOf(caller)
  const row = await plannedFor(caller, id)
  const [view] = await caller.withClient((db) => viewsOf(db, [row], office))
  if (!view) throw new NotFoundError('Planned work order not found.')
  return { plannedOrder: view }
}
