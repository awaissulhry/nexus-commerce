import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { subcontractOrderKitTimed as timedEvent } from '@nexus/factory-domain/planning-subcontract/events'
import { PLANNING_SUBCONTRACT_OUTSOURCE } from '@nexus/factory-domain/planning/subcontract-capacity/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { DEFAULT_TRANSPORT_DAYS, jobAmount, KIT_HOUR, kitWords, rowOn, workDaysOf, type CapacityKey } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { addWorkingDaysFor, supplierArrivalFor } from '../../../platform/calendars/service'
import { kitPlanOf } from '../../purchasing/subcontracting/orders'
import { readWorkOrderFacts } from '../../purchasing/subcontracting/store'
import { assertMayAt, officeContextOf } from '../access'
import { scheduleWorld } from '../schedule/service'
import { dayOf, type Reader, type SiteRow } from '../store'
import { capacityRowOf, readCapacityRows, type Job, type WorkOrderOperations } from './store'
import { operationsNamed, plannedWorkOrder } from './workshops'

/**
 * Kit timing (B-W2b-321; PLN-164; design planning.allocation › pop:kit-timing "Send to Workshop Beta": "Kit ship-out date =
 * start − 2 transport days", "Kit list from the BOM", "Return date drives later operations"):
 *
 *   GET /planning/work-orders/:workOrderId/kit-timing?partyId&operationIds&start   the popover: when the outside work
 *       starts (given, else the board's latest safe start of the first operation sent, else today), the transport days
 *       (the workshop's lead time, else 2), the day the kit leaves (that many of the site's working days before) and its
 *       time (08:00), late or not, the days the work takes (its capacity, else the routing's days, else one), the day the
 *       goods are back (the workshop's closed days skipped), the kit list (the work order's planned materials for the
 *       workshop, W2a's kit plan) and the operations after it that wait for the goods
 *   PUT /planning/subcontract-orders/:subcontractOrderId/kit-due {version, kitDueAt}   a DRAFT order's term: when its kit
 *       must leave, between its order date and its due-back date (B-W2b-286's rule); planning.subcontract.outsource
 */

export interface KitTiming {
  readonly start: BusinessDate
  readonly startSource: 'GIVEN' | 'SCHEDULE' | 'TODAY'
  readonly transportDays: number
  readonly transportSource: 'WORKSHOP' | 'DEFAULT'
  readonly shipOn: BusinessDate
  readonly kitDueAt: Date
  readonly late: boolean
  readonly words: string
  readonly workDays: number
  readonly workDaysSource: 'CAPACITY' | 'ROUTING' | 'DEFAULT'
  readonly backOn: BusinessDate
  readonly closedSkipped: number
}

type Operation = WorkOrderOperations['operations'][number]

/** The kit timing of some operations of a work order at a workshop (see above). */
export async function timingOf(db: Reader, site: SiteRow, workOrder: WorkOrderOperations, operations: readonly Operation[], party: { id: string; name: string; leadTimeDays: number | null }, startGiven: BusinessDate | null, garments: number): Promise<KitTiming & { latestStarts: Map<string, number | null> }> {
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  const world = await scheduleWorld(db, site, { from: today, to: today }, now)
  const schedule = world.schedules.get(workOrder.id)
  const latestStarts = new Map((schedule?.operations ?? []).map((times) => [times.id, times.latestStart]))
  const first = operations[0]
  const scheduled = first ? latestStarts.get(first.id) ?? null : null
  const start = startGiven ?? (scheduled !== null ? businessDate(new Date(Math.max(scheduled, now.getTime())), site.timezone) : today)
  const startSource = startGiven ? 'GIVEN' : scheduled !== null ? 'SCHEDULE' : 'TODAY'
  const transportDays = party.leadTimeDays !== null && party.leadTimeDays >= 0 ? party.leadTimeDays : DEFAULT_TRANSPORT_DAYS
  let shipOn: BusinessDate
  try {
    shipOn = (await addWorkingDaysFor(db as never, { scope: 'SITE', id: site.id }, start, -transportDays)).date ?? plusDays(start, -transportDays)
  } catch {
    shipOn = plusDays(start, -transportDays)
  }
  if (transportDays === 0) shipOn = start
  // The days the work takes: its capacity row of the first operation's kind (else the one for all work).
  const rows = (await readCapacityRows(db, [party.id])).map(capacityRowOf)
  const row = rowOn(rows, party.id, first?.workCentreKind ?? null, start) ?? rowOn(rows, party.id, null, start)
  const job: Job = { kind: 'ALLOCATION', id: workOrder.id, partyId: party.id, workOrderId: workOrder.id, from: start, to: start, garments, operations: operations.map((operation) => ({ workCentreKind: operation.workCentreKind, minutes: new Dec(operation.standardMinutes).times(garments).toFixed(3) })), number: null, status: 'CANDIDATE', workOrderNumber: null, style: null, proposed: false }
  const key: CapacityKey | null = row ? { partyId: party.id, workCentreKind: row.workCentreKind, unit: row.unit } : null
  const routingDays = Math.max(0, ...operations.filter((operation) => operation.outsidePartyId === party.id).map((operation) => operation.routingDays ?? 0)) || null
  const work = workDaysOf({ amount: key ? jobAmount(job, key) : null, perWeek: row?.perWeek ?? null, routingDays, transportDays })
  const back = await supplierArrivalFor(db as never, party.id, start, work.days + transportDays)
  const kitDueAt = new Date(businessDayStart(shipOn, site.timezone).getTime() + KIT_HOUR * 60 * 60 * 1000)
  const { late, words } = kitWords({ workshop: party.name, shipOn, start, transportDays, today })
  return { start, startSource, transportDays, transportSource: party.leadTimeDays !== null && party.leadTimeDays >= 0 ? 'WORKSHOP' : 'DEFAULT', shipOn, kitDueAt, late, words, workDays: work.days, workDaysSource: work.source, backOn: back.walk.date, closedSkipped: back.walk.skipped.length, latestStarts }
}

/** GET /planning/work-orders/:workOrderId/kit-timing. */
export async function kitTiming(caller: CommandCaller, workOrderId: string, query: { readonly partyId: string; readonly operationIds?: string | undefined; readonly start?: BusinessDate | undefined; readonly pieces?: number | undefined }) {
  const { workOrder, site } = await plannedWorkOrder(caller, workOrderId)
  const operations = operationsNamed(workOrder, query.operationIds ? query.operationIds.split(',').map((value) => value.trim()).filter(Boolean) : undefined)
  if (operations.length === 0) throw new ConflictError(`${workOrder.number} has no work left to send out.`)
  const garments = query.pieces ?? workOrder.garments
  if (garments < 1 || garments > workOrder.garments) throw new ValidationError(`From 1 to ${workOrder.garments} garments.`, [{ path: 'querystring/pieces', message: `At most the work order's ${workOrder.garments}.` }])
  return caller.withClient(async (db) => {
    const party = isUuid(query.partyId) ? await db.party.findUnique({ where: { id: query.partyId }, select: { id: true, code: true, legalName: true, tradeName: true, roles: true, leadTimeDays: true } }) : null
    if (!party || !party.roles.includes('SUBCONTRACTOR')) throw new NotFoundError('Workshop not found: a workshop is a party with the subcontractor role.')
    const name = party.tradeName ?? party.legalName
    const timing = await timingOf(db, site, workOrder, operations, { id: party.id, name, leadTimeDays: party.leadTimeDays }, query.start ?? null, garments)
    // The kit list: W2a's kit plan of the operations sent (the BOM lines for the workshop; HIDE leather goes cut, as bundles).
    const facts = await readWorkOrderFacts(db, workOrder.id)
    const plan = facts ? await kitPlanOf(db, workOrder.id, operations.map((operation) => ({ workOrderOperationId: operation.id, pieces: garments, sizes: [] })), facts.cells) : { lines: [], note: null }
    const items = plan.lines.length === 0 ? [] : await db.item.findMany({ where: { id: { in: plan.lines.map((line) => line.itemId) } }, select: { id: true, code: true, name: true } })
    const colours = plan.lines.some((line) => line.itemColourId) ? await db.itemColour.findMany({ where: { id: { in: plan.lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])) } }, select: { id: true, code: true } }) : []
    const sentSeqs = operations.map((operation) => operation.seq)
    const lastSent = Math.max(...sentSeqs)
    const laterOperations = workOrder.operations
      .filter((operation) => operation.seq > lastSent && !operation.outsourced && !sentSeqs.includes(operation.seq))
      .map((operation) => {
        const latest = timing.latestStarts.get(operation.id) ?? null
        const latestDay = latest !== null ? businessDate(new Date(latest), site.timezone) : null
        const waits = latestDay !== null && timing.backOn > latestDay
        return {
          id: operation.id,
          seq: operation.seq,
          name: operation.name,
          earliestStart: timing.backOn,
          latestStart: latestDay,
          finishesLate: waits,
          words: waits ? `Op ${operation.seq} ${operation.name} can start on ${timing.backOn}, after the goods are back; its latest safe start is ${latestDay}: the work order would finish late.` : `Op ${operation.seq} ${operation.name} starts once the goods are back on ${timing.backOn}.`,
        }
      })
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, garments: workOrder.garments },
      workshop: { id: party.id, code: party.code, name },
      operations: operations.map((operation) => ({ id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, workCentreKind: operation.workCentreKind })),
      pieces: garments,
      start: timing.start,
      startSource: timing.startSource,
      transportDays: timing.transportDays,
      transportSource: timing.transportSource,
      kitShipOn: timing.shipOn,
      kitDueAt: toUtcIso(timing.kitDueAt),
      late: timing.late,
      words: timing.words,
      workDays: timing.workDays,
      workDaysSource: timing.workDaysSource,
      backOn: timing.backOn,
      closedDaysSkipped: timing.closedSkipped,
      kit: {
        note: plan.note ?? null,
        // W2a's kit plan is for every garment of the work order: a part of them takes its share.
        lines: plan.lines.map((line) => ({ item: items.find((item) => item.id === line.itemId) ?? { id: line.itemId, code: '', name: '' }, colour: line.itemColourId ? (colours.find((colour) => colour.id === line.itemColourId) ?? { id: line.itemColourId, code: '' }) : null, quantity: new Dec(line.quantity).times(garments).div(Math.max(1, workOrder.garments)).toFixed(4), uom: line.baseUom })),
      },
      laterOperations,
      finishesLate: laterOperations.some((operation) => operation.finishesLate),
    }
  })
}

/** PUT /planning/subcontract-orders/:subcontractOrderId/kit-due. */
export async function setKitDue(caller: CommandCaller, orderId: string, body: { readonly version: number; readonly kitDueAt: string | null }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await caller.withClient((db) => (isUuid(orderId) ? db.subcontractOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, siteId: true, number: true, status: true, orderDate: true, expectedBackDate: true, kitDueAt: true, version: true, site: { select: { timezone: true } } } }) : Promise.resolve(null)))
  assertMayAt(context, PLANNING_SUBCONTRACT_OUTSOURCE, order ? { companyId: order.companyId, siteId: order.siteId } : null, 'Subcontract order')
  if (order!.status !== 'DRAFT') throw new ConflictError(`${order!.number} is ${order!.status.toLowerCase()}: its kit time is one of its terms, set while it is a draft (reopen it to change it).`)
  const kitDueAt = body.kitDueAt === null ? null : new Date(body.kitDueAt)
  if (kitDueAt) {
    const kitDay = businessDate(kitDueAt, order!.site.timezone)
    const orderDay = dayOf(order!.orderDate)
    if (kitDay < orderDay) throw new ValidationError(`The kit leaves on or after the order date (${orderDay}).`, [{ path: 'body/kitDueAt', message: `On or after ${orderDay}.` }])
    if (order!.expectedBackDate && kitDay > dayOf(order!.expectedBackDate)) throw new ValidationError(`The kit leaves on or before the day the goods are due back (${dayOf(order!.expectedBackDate)}).`, [{ path: 'body/kitDueAt', message: `On or before ${dayOf(order!.expectedBackDate)}.` }])
  }
  const { result } = await command(caller, { name: 'planning.subcontractKit.due', idempotencyKey, input: { orderId, ...body }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: body.version } }, async (tools) => {
    const current = await tools.tx.subcontractOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, kitDueAt: true } })
    if (current.status !== 'DRAFT') throw new ConflictError(`${order!.number} is no longer a draft.`)
    await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { kitDueAt }, select: { id: true } })
    tools.audit({ action: 'planning.subcontractKit.due', recordType: 'SubcontractOrder', recordId: orderId, companyId: order!.companyId, siteId: order!.siteId, before: { kitDueAt: current.kitDueAt ? toUtcIso(current.kitDueAt) : null }, after: { kitDueAt: kitDueAt ? toUtcIso(kitDueAt) : null } })
    tools.emit(eventFor(timedEvent, { subject: orderId, companyId: order!.companyId, siteId: order!.siteId, payload: { subcontractOrderId: orderId, siteId: order!.siteId, kitDueAt: kitDueAt ? toUtcIso(kitDueAt) : null } }))
    return { order: { id: orderId, number: order!.number, status: 'DRAFT', version: tools.record!.version, kitDueAt: kitDueAt ? toUtcIso(kitDueAt) : null } }
  })
  return result
}
