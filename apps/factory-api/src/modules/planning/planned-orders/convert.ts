import { ConflictError, InvalidStateError, isDomainError, type DomainError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_PLANNED_CONVERT } from '@nexus/factory-domain/planning/planned-orders/permissions'
import { convertProblem, demandOf, workOrderLinesOf, type PlannedOrderKind, type PlannedOrderStatus } from '@nexus/factory-domain/planning/planned-orders/rules'
import { openSizes } from '@nexus/factory-domain/production/work-orders/cells'
import { WORKORDERS_MANAGE, WORKORDERS_RELEASE } from '@nexus/factory-domain/production/work-orders/permissions'
import { PURCHASING_SUBCONTRACT_MANAGE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { releaseWorkOrder } from '../../production/work-orders/release'
import { hasSeries, readOrderLines, readWorkOrder } from '../../production/work-orders/store'
import { createWorkOrder, numberPreview } from '../../production/work-orders/work-orders'
import { createOrder } from '../../purchasing/subcontracting/orders'
import { readWorkOrderFacts, workshopLocations } from '../../purchasing/subcontracting/store'
import { officeContextOf } from '../access'
import { dayOf, type Reader } from '../store'
import type { ConvertResult } from './contract'
import { plannedFor } from './read'
import { readPlanned, type PlannedRow } from './store'

/**
 * Making planned orders real (B-W2b-293; PLN-067, PLN-069, PLN-089; design planning.mrp "To make": "Create 4 work orders" /
 * "Create 2 subcontract orders" with ReviewChangesModal): a preview says what each becomes and what holds it, then each row
 * is made real on its own (one row held never stops the others; each answer in words).
 *
 *   MAKE          ONE command on the planned order (its version, as read): W1's create (production/work-orders
 *                 `createWorkOrder`, its checks, lock per order line and number) makes the DRAFT work order of the order
 *                 lines and sizes it pegs, at the revision they name (PLN-089; none named: the RELEASED one) and its due
 *                 date; the planned order becomes CONVERTED with it in the same transaction.
 *   SUBCONTRACT   the work order is made the same way (or the one named, made from it before), released by W1's release
 *                 (its whole check; a material shortage only with the planner's override and reason), then W2a's
 *                 subcontract order (purchasing/subcontracting `createOrder`) drafted to the workshop for the steps it does,
 *                 with the kit planned from the BOM's lines for the workshop; then ONE command on the planned order: the
 *                 kit's leaving time on the subcontract order (a DRAFT's term) and CONVERTED with both. A release that is
 *                 held leaves a DRAFT work order made from it: the answer names it, and sending the row again with that
 *                 work order goes on from there. Each step answers a resent request (the same Idempotency-Key) from its
 *                 first receipt.
 *
 * planning.planned.convert over the site, and what W1 and W2a ask of the steps themselves (workorders.manage, release,
 * purchasing.subcontract.manage): never widened.
 */

const KIT_HOUR_MS = 8 * 60 * 60 * 1000

interface Body {
  readonly rows: readonly { readonly id: string; readonly version: number; readonly workOrderId?: string | undefined }[]
  readonly preview?: boolean | undefined
  readonly materialOverride?: { readonly reason: string } | undefined
}

const mayAt = (office: OfficeContext, permission: Parameters<typeof can>[1], row: { companyId: string; siteId: string }) => can(actorOf(office), permission, { companyId: row.companyId, siteId: row.siteId })

/** What a row asks of its caller that it lacks, in words. */
function permissionProblems(office: OfficeContext, row: PlannedRow): string[] {
  const out: string[] = []
  if (!mayAt(office, WORKORDERS_MANAGE, row)) out.push('Making its work order needs workorders.manage at this site.')
  if (row.kind === 'SUBCONTRACT') {
    if (!mayAt(office, WORKORDERS_RELEASE, row)) out.push('Releasing its work order for the workshop needs workorders.release at this site.')
    if (!mayAt(office, PURCHASING_SUBCONTRACT_MANAGE, { companyId: row.companyId, siteId: row.siteId })) out.push('Drafting its subcontract order needs purchasing.subcontract.manage (a buyer).')
  }
  return out
}

/** The revision a row is made to, its steps and its workshop (read for the preview and the answer). */
async function factsOf(db: Reader, row: PlannedRow) {
  const named = row.styleRevisionId ? await db.styleRevision.findUnique({ where: { id: row.styleRevisionId }, select: { id: true, revision: true, status: true } }) : null
  const released = named ? null : await db.styleRevision.findFirst({ where: { styleId: row.styleId, status: 'RELEASED' }, select: { id: true, revision: true, status: true }, orderBy: { revision: 'desc' } })
  const revision = named ?? released
  const steps = revision ? await db.routingOperation.findMany({ where: { revisionId: revision.id }, select: { seq: true, code: true, name: true }, orderBy: { seq: 'asc' } }) : []
  const party = row.partyId ? await db.party.findUnique({ where: { id: row.partyId }, select: { id: true, code: true, legalName: true, tradeName: true, roles: true, status: true } }) : null
  return { revision, steps: steps.filter((step) => row.operationSeqs.length === 0 || row.operationSeqs.includes(step.seq)), party }
}

/** Why the row cannot be made real now (preview), every reason in words. */
async function previewProblems(db: Reader, office: OfficeContext, row: PlannedRow, version: number, facts: Awaited<ReturnType<typeof factsOf>>): Promise<string[]> {
  const demand = demandOf(row.demand)
  const problems: string[] = []
  const state = convertProblem({ status: row.status as PlannedOrderStatus, demand })
  if (state) return [state]
  if (row.version !== version) problems.push(`It changed since it was read (now version ${row.version}): read it again.`)
  problems.push(...permissionProblems(office, row))
  if (!facts.revision) problems.push('Its style has no released revision to make it to.')
  else if (facts.revision.status === 'OBSOLETE') problems.push(`Revision ${facts.revision.revision}, which its order lines name, is OBSOLETE.`)
  const lines = await readOrderLines(db, demand.map((entry) => entry.orderLineId))
  for (const entry of demand) {
    const line = lines.get(entry.orderLineId)
    if (!line) {
      problems.push('One of its order lines is gone.')
      continue
    }
    const open = openSizes(line).find((size) => size.size === entry.size)?.open ?? 0
    if (open < entry.pieces) problems.push(`${line.orderNumber} line ${line.seq} size ${entry.size}: ${open} piece(s) still open, it asks ${entry.pieces} (work was made since the plan): run the plan again.`)
  }
  if (!(await hasSeries(db, row.companyId, 'WORK_ORDER'))) problems.push('The company has no active work order number series: an admin sets one up under Numbering (kind WORK_ORDER).')
  if (row.kind === 'SUBCONTRACT') {
    const party = facts.party
    if (!party || !party.roles.includes('SUBCONTRACTOR') || party.status !== 'ACTIVE') problems.push('Its workshop may not get work now (an ACTIVE party with the SUBCONTRACTOR role).')
    else if ((await workshopLocations(db, row.siteId, [party.id])).length === 0) problems.push(`${party.code} has no stock location on the site yet: create one (a location of kind SUBCONTRACTOR, owned by the workshop).`)
    if (facts.steps.length === 0) problems.push('Its revision has none of the routing steps it sends out.')
  }
  return problems
}

const workshopOf = (facts: Awaited<ReturnType<typeof factsOf>>) => (facts.party ? { id: facts.party.id, code: facts.party.code, name: facts.party.tradeName ?? facts.party.legalName } : null)

function resultOf(row: PlannedRow, facts: Awaited<ReturnType<typeof factsOf>>, made: { ok: boolean; problems: string[]; error: string | null; workOrder?: { id: string; number: string; status: string } | null; number?: string | null; subcontract?: { id: string; number: string } | null; kitDueAt?: Date | null }): ConvertResult {
  const demand = demandOf(row.demand)
  return {
    id: row.id,
    kind: row.kind as PlannedOrderKind,
    ok: made.ok,
    workOrder: {
      id: made.workOrder?.id ?? null,
      number: made.workOrder?.number ?? made.number ?? null,
      status: made.workOrder?.status ?? null,
      revision: facts.revision?.revision ?? null,
      dueDate: dayOf(row.dueDate),
      cells: new Set(demand.map((entry) => `${entry.orderLineId}|${entry.size}`)).size,
      pieces: row.quantity,
    },
    subcontractOrder:
      row.kind === 'SUBCONTRACT'
        ? { id: made.subcontract?.id ?? null, number: made.subcontract?.number ?? null, workshop: workshopOf(facts), operations: facts.steps.map((step) => ({ seq: step.seq, code: step.code, name: step.name })), kitDueAt: (made.kitDueAt ?? row.kitDueAt) ? toUtcIso((made.kitDueAt ?? row.kitDueAt)!) : null }
        : null,
    problems: made.problems,
    error: made.error,
  }
}

const refusal = (error: DomainError): string[] => [error.message, ...(error.issues ?? []).map((issue) => issue.message).filter((message) => message !== error.message)]

/** The CONVERTED write of a planned order, with its audit row and event (inside the command that made its work). */
async function markConverted(tools: CommandTools, row: PlannedRow, made: { workOrderId: string; workOrderNumber: string; pieces: number; subcontractOrderId: string | null; subcontractOrderNumber: string | null }) {
  const { tx, now, context } = tools
  const current = await readPlanned(tx, row.id)
  if (!current || current.status !== 'PLANNED') throw new ConflictError('The planned order was made real or removed meanwhile: read the plan again.')
  await tx.plannedWorkOrder.update({
    where: { id: row.id },
    data: { status: 'CONVERTED', workOrderId: made.workOrderId, subcontractOrderId: made.subcontractOrderId, convertedAt: now, convertedById: context.audience === 'office' ? context.actorId : null },
    select: { id: true },
  })
  tools.audit({
    action: 'planning.plannedOrders.convert',
    recordType: 'PlannedWorkOrder',
    recordId: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    before: { status: 'PLANNED' },
    after: { status: 'CONVERTED', workOrderId: made.workOrderId, workOrderNumber: made.workOrderNumber, subcontractOrderId: made.subcontractOrderId, subcontractOrderNumber: made.subcontractOrderNumber },
  })
  tools.emit({
    type: 'planned_work_order.converted',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { plannedWorkOrderId: row.id, siteId: row.siteId, kind: row.kind as PlannedOrderKind, workOrderId: made.workOrderId, workOrderNumber: made.workOrderNumber, subcontractOrderId: made.subcontractOrderId, subcontractOrderNumber: made.subcontractOrderNumber, pieces: made.pieces },
  })
}

const workOrderBody = (row: PlannedRow) => ({
  siteId: row.siteId,
  ...(row.styleRevisionId ? { styleRevisionId: row.styleRevisionId } : {}),
  dueDate: dayOf(row.dueDate),
  lines: workOrderLinesOf(demandOf(row.demand)),
})

/** MAKE: the DRAFT work order and CONVERTED in one command. */
async function convertMake(caller: CommandCaller, row: PlannedRow, version: number, key: string | undefined) {
  const { workOrder } = await createWorkOrder(caller, workOrderBody(row), key, undefined, {
    plannedWorkOrderId: row.id,
    version,
    inCommand: (tools, made) => markConverted(tools, row, { workOrderId: made.id, workOrderNumber: made.number, pieces: made.pieces, subcontractOrderId: null, subcontractOrderNumber: null }),
  })
  return { workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, subcontract: null, kitDueAt: null }
}

/** The kit's leaving time on the subcontract order: the planned one, kept between the order's date and its due-back date. */
function kitTimeFor(planned: Date | null, orderDate: BusinessDate, backDate: BusinessDate | null, timezone: string): Date | null {
  if (!planned) return null
  let kitDay = planned.toISOString().slice(0, 10)
  if (kitDay < orderDate) kitDay = orderDate
  if (backDate !== null && kitDay > backDate) kitDay = backDate
  if (kitDay === planned.toISOString().slice(0, 10)) return planned
  const at = new Date(businessDayStart(kitDay, timezone).getTime() + KIT_HOUR_MS)
  return at.toISOString().slice(0, 10) === kitDay ? at : new Date(`${kitDay}T12:00:00.000Z`)
}

/** SUBCONTRACT: the work order (made, or the one named), its release, the subcontract order, then CONVERTED. */
async function convertSubcontract(caller: CommandCaller, row: PlannedRow, ref: Body['rows'][number], materialOverride: Body['materialOverride'], key: string | undefined) {
  const step = (name: string) => (key ? `${key}:${name}` : undefined)
  let workOrderId = ref.workOrderId ?? null
  if (workOrderId) {
    const named = await caller.withClient((db) => readWorkOrder(db, workOrderId!))
    if (!named || named.siteId !== row.siteId || named.styleId !== row.styleId) throw new ConflictError('The work order named is not one of this site and style.')
    if (['CANCELLED', 'CLOSED', 'COMPLETED'].includes(named.status)) throw new InvalidStateError(`Work order ${named.number} is ${named.status}: work is sent out only for a released or running one.`)
    const taken = await caller.withClient((db) => db.plannedWorkOrder.findFirst({ where: { workOrderId: named.id, NOT: { id: row.id } }, select: { id: true } }))
    if (taken) throw new ConflictError(`Work order ${named.number} was made from another planned order.`)
    // It makes what the planned order pegs: each order line and size, at least the pieces asked.
    const cells = await caller.withClient((db) => db.workOrderSize.findMany({ where: { workOrderId: named.id }, select: { salesOrderLineId: true, size: true, quantity: true } }))
    const missing = demandOf(row.demand).filter((entry) => !cells.some((cell) => cell.salesOrderLineId === entry.orderLineId && cell.size === entry.size && cell.quantity >= entry.pieces))
    if (missing.length > 0) throw new ConflictError(`Work order ${named.number} does not make what this planned order pegs (size ${missing.map((entry) => entry.size).join(', ')} of its order lines): name the work order made from it.`)
  } else {
    const { workOrder } = await createWorkOrder(caller, workOrderBody(row), step('work-order'))
    workOrderId = workOrder.id
  }
  const workOrder = (await caller.withClient((db) => readWorkOrder(db, workOrderId!)))!
  if (workOrder.status === 'DRAFT') {
    try {
      await releaseWorkOrder(caller, workOrder.id, { version: workOrder.version, ...(materialOverride ? { materialOverride } : {}) }, step('release'))
    } catch (error) {
      if (!isDomainError(error)) throw error
      throw new ConflictError(`Work order ${workOrder.number} was made from it and stays a DRAFT: its release is held. ${error.message} Release it (or override the material shortage with a reason), then make this planned order real again naming work order ${workOrder.number}.`)
    }
  }
  const facts = await caller.withClient((db) => readWorkOrderFacts(db, workOrder.id))
  const operations = (facts?.operations ?? []).filter((operation) => operation.routingSeq !== null && (row.operationSeqs.length === 0 || row.operationSeqs.includes(operation.routingSeq)))
  if (operations.length === 0) throw new ConflictError(`Work order ${workOrder.number} has none of the steps the workshop does (routing steps ${row.operationSeqs.join(', ') || 'all'}).`)
  let order: Awaited<ReturnType<typeof createOrder>>['order']
  try {
    ;({ order } = await createOrder(caller, { workOrderId: workOrder.id, partyId: row.partyId!, operations: operations.map((operation) => ({ workOrderOperationId: operation.id })), planKit: true }, step('subcontract')))
  } catch (error) {
    if (!isDomainError(error)) throw error
    throw new ConflictError(`Work order ${workOrder.number} is released for the workshop; its subcontract order could not be drafted: ${error.message} Then make this planned order real again naming work order ${workOrder.number}.`)
  }
  const site = await caller.withClient((db) => db.site.findUniqueOrThrow({ where: { id: row.siteId }, select: { timezone: true } }))
  const sc = await caller.withClient((db) => db.subcontractOrder.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, number: true, status: true, orderDate: true, expectedBackDate: true, kitDueAt: true } }))
  const kitDueAt = kitTimeFor(row.kitDueAt, dayOf(sc.orderDate), sc.expectedBackDate ? dayOf(sc.expectedBackDate) : null, site.timezone)
  await command(
    caller,
    { name: 'planning.plannedOrders.convert', idempotencyKey: step('convert'), input: { plannedWorkOrderId: row.id, workOrderId: workOrder.id, subcontractOrderId: sc.id }, record: { type: 'PlannedWorkOrder', id: row.id, expectedVersion: ref.version } },
    async (tools) => {
      if (kitDueAt && sc.status === 'DRAFT' && sc.kitDueAt === null) {
        await tools.tx.subcontractOrder.update({ where: { id: sc.id }, data: { kitDueAt, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: 'planning.plannedOrders.kitDue', recordType: 'SubcontractOrder', recordId: sc.id, companyId: row.companyId, siteId: row.siteId, before: { kitDueAt: null }, after: { kitDueAt: toUtcIso(kitDueAt) } })
      }
      await markConverted(tools, row, { workOrderId: workOrder.id, workOrderNumber: workOrder.number, pieces: row.quantity, subcontractOrderId: sc.id, subcontractOrderNumber: sc.number })
      return { id: row.id }
    },
  )
  const after = (await caller.withClient((db) => readWorkOrder(db, workOrder.id)))!
  return { workOrder: { id: after.id, number: after.number, status: after.status }, subcontract: { id: sc.id, number: sc.number }, kitDueAt }
}

/** POST /planning/planned-orders/convert: the preview, or each row made real (its own answer). */
export async function convertPlannedOrders(caller: CommandCaller, body: Body, idempotencyKey?: string): Promise<{ preview: boolean; made: number; held: number; results: ConvertResult[] }> {
  const office = officeContextOf(caller)
  const preview = body.preview === true
  const seen = new Set<string>()
  const results: ConvertResult[] = []
  for (const ref of body.rows) {
    if (seen.has(ref.id)) continue
    seen.add(ref.id)
    let row: PlannedRow | null = null
    try {
      row = await plannedFor(caller, ref.id, PLANNING_PLANNED_CONVERT)
      const facts = await caller.withClient((db) => factsOf(db, row!))
      if (preview) {
        const problems = await caller.withClient((db) => previewProblems(db, office, row!, ref.version, facts))
        const number = await caller.withClient((db) => numberPreview(db, row!.companyId))
        results.push(resultOf(row, facts, { ok: problems.length === 0, problems, error: null, number }))
        continue
      }
      const state = convertProblem({ status: row.status as PlannedOrderStatus, demand: demandOf(row.demand) })
      if (state) throw new InvalidStateError(state)
      const missing = permissionProblems(office, row)
      if (missing.length > 0) {
        results.push(resultOf(row, facts, { ok: false, problems: missing, error: 'forbidden' }))
        continue
      }
      const key = idempotencyKey ? `${idempotencyKey}:${row.id}` : undefined
      const made = row.kind === 'SUBCONTRACT' ? await convertSubcontract(caller, row, ref, body.materialOverride, key) : await convertMake(caller, row, ref.version, key)
      results.push(resultOf(row, facts, { ok: true, problems: [], error: null, workOrder: made.workOrder, subcontract: made.subcontract, kitDueAt: made.kitDueAt }))
    } catch (error) {
      if (!isDomainError(error)) throw error
      if (!row) {
        // Not found or not this caller's: said as the error, the row's own facts unknown.
        results.push({ id: ref.id, kind: null, ok: false, workOrder: null, subcontractOrder: null, problems: refusal(error), error: error.code })
        continue
      }
      const facts = await caller.withClient((db) => factsOf(db, row!))
      results.push(resultOf(row, facts, { ok: false, problems: refusal(error), error: error.code }))
    }
  }
  const made = preview ? 0 : results.filter((result) => result.ok).length
  return { preview, made, held: results.filter((result) => !result.ok).length, results }
}
