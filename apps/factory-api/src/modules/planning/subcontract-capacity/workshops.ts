import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { Bucket } from '@nexus/factory-domain/planning/settings/buckets'
import { PLANNING_SUBCONTRACT_OUTSOURCE } from '@nexus/factory-domain/planning/subcontract-capacity/permissions'
import { amountText, jobAmount, loadPctOf, needLabel, outsideWorkOf, verdictOf, type NeedAnswer, type Verdict } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { askStateOf, bestDocument } from '@nexus/factory-domain/purchasing/qualification/vault'
import { newOrderProblem } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { qualificationsFor } from '../../purchasing/qualification/qualifications'
import { vaultFilesOf } from '../../purchasing/qualification/store'
import { SUPPLIER_COLUMNS, standingOf } from '../../purchasing/suppliers-depth/store'
import { assertMayAt, mayAt, officeContextOf, siteFor } from '../access'
import { workshopsOf, type WorkshopRow } from '../schedule/store'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import { capacityRowOf, closedDaysOf, linesOf, readCapacityRows, readJobs, readWorkOrderOperations, type Job, type WorkOrderOperations, type WorkshopLine } from './store'

/**
 * Only approved workshops (B-W2b-321; PLN-162; design planning.allocation "Workshops not approved for the style are held
 * drop zones with the reason (no valid DURC, not approved for armour pockets)", "Only qualified workshops accept a drop,
 * and the reason is visible before the drag ends"):
 *
 *   GET /planning/allocation/workshops?siteId                 the site's workshops (qualification per kind of work, the
 *                                                             DURC, the supplier status, the location, the capacity of
 *                                                             the next four weeks) and, per open work order, whether
 *                                                             each workshop is offered for its outside work, with why not
 *   GET /planning/work-orders/:workOrderId/workshops?operationIds   one work order: every workshop for the operations named
 *                                                             (default: its outside work), per operation qualified or
 *                                                             not, and the capacity with this work added
 *
 * planning.view over the site. The verdict is factory-domain planning/subcontract-capacity verdictOf over B-W2b-315's
 * qualification (`qualificationsFor`) and vault (the DURC), B-W2b-311's supplier status and the site's locations.
 */

const OPEN = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING'] as const

type Operation = WorkOrderOperations['operations'][number]

export interface WorkshopWorld {
  readonly site: SiteRow
  readonly today: BusinessDate
  readonly workshops: readonly WorkshopRow[]
  readonly lines: readonly WorkshopLine[]
  readonly jobs: readonly Job[]
  readonly window: { readonly from: BusinessDate; readonly to: BusinessDate }
  readonly durc: ReadonlyMap<string, { checked: boolean; state: 'MET' | 'EXPIRING' | 'EXPIRED' | 'MISSING'; expiresOn: BusinessDate | null }>
  readonly supplierProblem: ReadonlyMap<string, string | null>
  readonly active: ReadonlyMap<string, boolean>
}

/** The workshops of the site (and `alsoIds`), their capacity over the next four weeks, their DURC and supplier status. */
export async function workshopWorld(db: Reader, site: SiteRow, today: BusinessDate, alsoIds: readonly string[] = []): Promise<WorkshopWorld> {
  const jobs = await readJobs(db, site, today)
  const workshops = await workshopsOf(db, site, [...jobs.map((job) => job.partyId), ...alsoIds])
  const ids = workshops.map((workshop) => workshop.id)
  const rows = (await readCapacityRows(db, ids)).map(capacityRowOf)
  const window = { from: today, to: plusDays(today, 27) }
  const bucket: Bucket = { key: 'next4', kind: 'DAY', from: window.from, to: window.to }
  const closed = await closedDaysOf(db, ids, window.from, window.to)
  const lines = linesOf(workshops, rows, jobs, [bucket], closed)
  const parties = ids.length === 0 ? [] : await db.party.findMany({ where: { id: { in: ids } }, select: SUPPLIER_COLUMNS })
  const durc = new Map<string, { checked: boolean; state: 'MET' | 'EXPIRING' | 'EXPIRED' | 'MISSING'; expiresOn: BusinessDate | null }>()
  const supplierProblem = new Map<string, string | null>()
  const active = new Map<string, boolean>()
  for (const party of parties) {
    supplierProblem.set(party.id, newOrderProblem(standingOf(party)))
    active.set(party.id, party.status === 'ACTIVE')
    if (!party.supplierKinds.includes('SUBCONTRACTOR')) {
      durc.set(party.id, { checked: false, state: 'MISSING', expiresOn: null })
      continue
    }
    const document = bestDocument(await vaultFilesOf(db, party.id), 'SUPPLIER_CERTIFICATE', today)
    durc.set(party.id, { checked: true, state: askStateOf(document, today), expiresOn: document?.expiresOn ?? null })
  }
  return { site, today, workshops, lines, jobs, window, durc, supplierProblem, active }
}

/** The capacity of a workshop over the next four weeks, with `extra` (a work's jobs) added: the fullest line. */
function capacityWith(world: WorkshopWorld, partyId: string, extra: Job | null) {
  const own = world.lines.filter((line) => line.workshop.id === partyId)
  let known = false
  let worst: { loadPct: string | null; over: boolean } = { loadPct: null, over: false }
  for (const line of own) {
    const cell = line.cells[0]!
    if (!line.key || !cell.known) continue
    known = true
    const add = extra ? jobAmount(extra, line.key) : new Dec(0)
    const booked = cell.booked.plus(add)
    const loadPct = loadPctOf(booked, cell.available)
    const over = booked.gt(cell.available)
    if (worst.loadPct === null || (loadPct !== null && Number(loadPct) > Number(worst.loadPct))) worst = { loadPct, over }
  }
  return { known, ...worst }
}

/** Each workshop's answer for each operation (qualification by kind of work and by the library operation). */
type Answers = Map<string, Awaited<ReturnType<typeof qualificationsFor>>>

async function needsOf(db: Reader, companyId: string, partyIds: readonly string[], operations: readonly Operation[], today: BusinessDate, cache: Answers = new Map()): Promise<Map<string, Map<string, NeedAnswer>>> {
  const out = new Map<string, Map<string, NeedAnswer>>(partyIds.map((id) => [id, new Map()]))
  const asked = new Map<string, Operation[]>()
  for (const operation of operations) {
    const key = `${operation.workCentreKind}|${operation.operationId ?? ''}`
    asked.set(key, [...(asked.get(key) ?? []), operation])
  }
  for (const group of asked.values()) {
    const first = group[0]!
    // One question per kind of work and library operation (the allocation board asks it for every card).
    const asking = `${first.workCentreKind}|${first.operationId ?? ''}`
    const answers = cache.get(asking) ?? (await qualificationsFor(db, { companyId, partyIds, need: { workCentreKind: first.workCentreKind as never, operationId: first.operationId }, today }))
    cache.set(asking, answers)
    for (const partyId of partyIds) {
      const answer = answers.get(partyId)!
      for (const operation of group) out.get(partyId)!.set(operation.id, { label: needLabel(operation), qualified: answer.qualified, standing: answer.standing, words: answer.words })
    }
  }
  return out
}

/** The verdict of each workshop for some operations of a work order. */
export async function verdictsFor(db: Reader, world: WorkshopWorld, workOrder: Pick<WorkOrderOperations, 'id' | 'companyId'>, operations: readonly Operation[], extra: (partyId: string) => Job | null, cache?: Answers) {
  const answers = await needsOf(db, workOrder.companyId, world.workshops.map((workshop) => workshop.id), operations, world.today, cache)
  return world.workshops.map((workshop) => {
    const perOperation = operations.map((operation) => ({ operation, answer: answers.get(workshop.id)!.get(operation.id)! }))
    const verdict: Verdict = verdictOf({
      name: workshop.name,
      isWorkshop: true,
      active: world.active.get(workshop.id) ?? workshop.status === 'ACTIVE',
      supplierProblem: world.supplierProblem.get(workshop.id) ?? null,
      siteName: world.site.name,
      hasLocation: workshop.location !== null,
      needs: perOperation.map((entry) => entry.answer),
      durc: world.durc.get(workshop.id) ?? { checked: false, state: 'MISSING', expiresOn: null },
      capacity: capacityWith(world, workshop.id, extra(workshop.id)),
    })
    return { workshop, verdict, perOperation }
  })
}

const workshopView = (world: WorkshopWorld, workshop: WorkshopRow) => ({
  id: workshop.id,
  code: workshop.code,
  name: workshop.name,
  location: workshop.location,
  active: world.active.get(workshop.id) ?? workshop.status === 'ACTIVE',
  supplierProblem: world.supplierProblem.get(workshop.id) ?? null,
  durc: world.durc.get(workshop.id) ?? { checked: false, state: 'MISSING' as const, expiresOn: null },
  capacity: world.lines
    .filter((line) => line.workshop.id === workshop.id)
    .map((line) => ({ workCentreKind: line.key?.workCentreKind ?? null, unit: line.key?.unit ?? null, available: line.cells[0]!.known ? amountText(line.cells[0]!.available) : null, booked: amountText(line.cells[0]!.booked), proposed: amountText(line.cells[0]!.proposed), loadPct: line.cells[0]!.loadPct, over: line.cells[0]!.over })),
})

/** The job a work's operations would put at a workshop over the next four weeks. */
const jobOf = (world: WorkshopWorld, workOrder: Pick<WorkOrderOperations, 'id' | 'garments'>, operations: readonly Operation[], garments: number) => (partyId: string): Job => ({
  kind: 'ALLOCATION',
  id: workOrder.id,
  partyId,
  workOrderId: workOrder.id,
  from: world.window.from,
  to: world.window.to,
  garments,
  operations: operations.map((operation) => ({ workCentreKind: operation.workCentreKind, minutes: new Dec(operation.standardMinutes).times(garments).toFixed(3) })),
  number: null,
  status: 'CANDIDATE',
  workOrderNumber: null,
  style: null,
  proposed: false,
})

const operationView = (operation: Operation) => ({ id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, workCentreKind: operation.workCentreKind, outsourced: operation.outsourced, subcontractOrderId: operation.subcontractOrderId, outsideStep: operation.outsideStep, version: operation.version })
const reasonsView = (verdict: Verdict) => ({ offered: verdict.offered, held: [...verdict.held], warnings: [...verdict.warnings] })

/** GET /planning/allocation/workshops. */
export async function allocationWorkshops(caller: CommandCaller, query: { readonly siteId: string }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  return caller.withClient(async (db) => {
    const world = await workshopWorld(db, site, today)
    const ids = world.workshops.map((workshop) => workshop.id)
    const open = await db.workOrder.findMany({ where: { siteId: site.id, status: { in: [...OPEN] } }, select: { id: true }, orderBy: [{ dueDate: 'asc' }, { number: 'asc' }], take: 500 })
    const workOrders = await readWorkOrderOperations(db, open.map((row) => row.id))
    // Per kind of work, whether each workshop is qualified (the lanes' head), one question per kind.
    const kinds = new Map<string, Map<string, { qualified: boolean; standing: string; words: string }>>()
    for (const kind of KINDS) kinds.set(kind, await qualificationsFor(db, { companyId: site.companyId, partyIds: ids, need: { workCentreKind: kind }, today }))
    const cards = []
    const cache: Answers = new Map()
    for (const workOrder of workOrders.values()) {
      const sent = outsideWorkOf(workOrder.operations)
      const verdicts = await verdictsFor(db, world, workOrder, sent, () => null, workOrder.companyId === site.companyId ? cache : undefined)
      cards.push({
        workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, version: workOrder.version },
        operations: sent.map(operationView),
        workshops: verdicts.map((entry) => ({ partyId: entry.workshop.id, ...reasonsView(entry.verdict) })),
      })
    }
    return {
      site: { id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone },
      today,
      asOf: toUtcIso(now),
      window: world.window,
      workshops: world.workshops.map((workshop) => ({ ...workshopView(world, workshop), qualifications: KINDS.map((kind) => ({ workCentreKind: kind, ...kinds.get(kind)!.get(workshop.id)! })) })),
      workOrders: cards,
    }
  })
}

/** The work order the caller plans (planning.view over its site; `permission` too). */
export async function plannedWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission = PLANNING_VIEW): Promise<{ workOrder: WorkOrderOperations; site: SiteRow }> {
  const context = officeContextOf(caller)
  const found = await caller.withClient(async (db) => {
    const workOrder = (await readWorkOrderOperations(db, isUuid(workOrderId) ? [workOrderId] : [])).get(workOrderId) ?? null
    const site = workOrder ? await db.site.findUnique({ where: { id: workOrder.siteId }, select: SITE_COLUMNS }) : null
    return workOrder && site ? { workOrder, site } : null
  })
  assertMayAt(context, permission, found ? { companyId: found.workOrder.companyId, siteId: found.workOrder.siteId } : null, 'Work order')
  return found!
}

/** The operations a request names (default: the work order's outside work). */
export function operationsNamed(workOrder: WorkOrderOperations, ids: readonly string[] | undefined): Operation[] {
  if (!ids || ids.length === 0) return outsideWorkOf(workOrder.operations)
  const out: Operation[] = []
  for (const id of ids) {
    const operation = workOrder.operations.find((candidate) => candidate.id === id)
    if (!operation) throw new ValidationError('An operation is not one of the work order’s.', [{ path: 'querystring/operationIds', message: `Not an operation of ${workOrder.number}: ${id}.` }])
    if (!out.includes(operation)) out.push(operation)
  }
  return out
}

/** GET /planning/work-orders/:workOrderId/workshops. */
export async function workOrderWorkshops(caller: CommandCaller, workOrderId: string, query: { readonly operationIds?: string | undefined }) {
  const { workOrder, site } = await plannedWorkOrder(caller, workOrderId)
  const context = officeContextOf(caller)
  const operations = operationsNamed(workOrder, query.operationIds ? query.operationIds.split(',').map((value) => value.trim()).filter(Boolean) : undefined)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  return caller.withClient(async (db) => {
    const routing = [...new Set(operations.flatMap((operation) => (operation.outsidePartyId ? [operation.outsidePartyId] : [])))]
    const world = await workshopWorld(db, site, today, routing)
    const verdicts = await verdictsFor(db, world, workOrder, operations, jobOf(world, workOrder, operations, workOrder.garments))
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, version: workOrder.version, garments: workOrder.garments, style: workOrder.style },
      asOf: toUtcIso(now),
      operations: operations.map(operationView),
      mayOutsource: mayAt(context, PLANNING_SUBCONTRACT_OUTSOURCE, { companyId: workOrder.companyId, siteId: workOrder.siteId }),
      workshops: verdicts.map((entry) => ({
        ...workshopView(world, entry.workshop),
        routing: operations.some((operation) => operation.outsidePartyId === entry.workshop.id),
        ...reasonsView(entry.verdict),
        operations: entry.perOperation.map(({ operation, answer }) => ({ operationId: operation.id, qualified: answer.qualified, standing: answer.standing, words: answer.words })),
      })),
    }
  })
}

/** For a command: the verdict of one workshop for these operations now (not found when it is not one of the site's). */
export async function verdictNow(db: Reader, site: SiteRow, workOrder: WorkOrderOperations, operations: readonly Operation[], partyId: string, garments: number) {
  const today = businessDate(serverClock.now(), site.timezone)
  const world = await workshopWorld(db, site, today, [partyId])
  const verdicts = await verdictsFor(db, world, workOrder, operations, jobOf(world, workOrder, operations, garments))
  const entry = verdicts.find((candidate) => candidate.workshop.id === partyId)
  if (!entry) throw new NotFoundError('Workshop not found: a workshop is an active party with the subcontractor role.')
  return { world, workshop: entry.workshop, verdict: entry.verdict }
}
