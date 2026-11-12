import { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { businessDate as businessDateSchema, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { RISK_STATES } from '@nexus/factory-domain/planning/promise-keep/risk'
import { arrivalDate, leadTimeWindow } from '@nexus/factory-domain/calendars/suppliers'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { detectExceptions, type ExceptionCondition } from '@nexus/factory-domain/planning/exceptions/detect'
import { refreshOf, type OpenException } from '@nexus/factory-domain/planning/exceptions/lifecycle'
import { PLANNING_EXCEPTIONS_MANAGE } from '@nexus/factory-domain/planning/exceptions/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { decimalOf } from '@nexus/factory-domain/product/units/units'
import { rankedSources } from '@nexus/factory-domain/purchasing/sources/sources'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { supplierCalendarsFor } from '../../../platform/calendars/service'
import { officeContextOf } from '../access'
import { latestDoneRun } from '../inputs'
import { promiseLinesOf } from '../promise-keep/lines'
import { livePlanOf, type LivePlan } from '../readiness/service'
import { scheduleWorld } from '../schedule/service'
import { materialStartsOf } from '../schedule-depth/material'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import { detectInputs, OPEN_COLUMNS } from './refresh'

/**
 * Supply too late (B-W2b-317; PLN-200 "Supplier date slip replans affected orders"; design planning.exceptions › tiles
 * "Supplier dates later than needed (W2b)", the detail "Fixes: chase PO-0091 · move WO-0221 on the board · buy elsewhere ·
 * re-promise (W2b)", live "purchasing.po.confirmed (later than needed) → New 'Supply too late' item (W2b)").
 *
 * B-W2a-22's run finds SUPPLY_LATE per purchase order line (it arrives after a need it would cover, or it is past its date)
 * once a night. Now a supplier's date that moves — the supplier confirms the order (W1), the buyer records the days the
 * supplier confirmed or a day that moved (B-W2b-296) — is checked against what the line feeds at once: the site's live
 * plan (THE readiness's netting with the new date, B-W2a-22) and the run's own detection for that order's lines; the
 * "Supply too late" exception of each line is raised, kept (its facts and impact now) or cleared, as the run would
 * (factory-domain planning/exceptions lifecycle `refreshOf`; the latest run named as the one it belongs to). The worker's
 * handler `planning.supplyLate` does it on the purchase order's date events; a planner may ask it too (POST …/check).
 *
 * What the late date feeds is replanned live: the promise list (planning/promise-keep) moves each work order's finish by the
 * days its material now comes after its planned start, so the orders it puts at risk show at once, with re-promise offered.
 *
 * The fixes of one exception (read now): CHASE the purchase order (the supplier, the line, its day and the day needed),
 * MOVE each work order waiting for it on the board (B-W2b-312's material day: the first day it can start with the
 * material), BUY_ELSEWHERE from another approved source of the material (its lead time, the supplier's calendar, whether it
 * arrives in time), REPROMISE each order line it feeds (its promise, the planned finish now, whether a re-promise waits).
 * Nothing is changed by a fix read: each fix names the record and the route that acts.
 */

export const SUPPLY_LATE = 'SUPPLY_LATE'
const keyOf = (purchaseOrderLineId: string) => `${SUPPLY_LATE}:${purchaseOrderLineId}`
const lineIdOfKey = (key: string): string | null => (key.startsWith(`${SUPPLY_LATE}:`) ? key.slice(SUPPLY_LATE.length + 1) : null)

/** The purchase order's events that move a supplier's date (W1 confirm; B-W2b-296's dates). */
export const SUPPLY_DATE_EVENTS = ['purchase_order.confirmed', 'purchase_order.dates_confirmed', 'purchase_order.date_changed'] as const

interface PlannedCheck {
  readonly site: SiteRow
  readonly purchaseOrder: { readonly id: string; readonly number: string; readonly companyId: string }
  readonly runId: string
  readonly today: BusinessDate
  readonly found: { readonly row: OpenException & { version: number; lastSeenAt: Date }; readonly condition: ExceptionCondition }[]
  readonly raised: ExceptionCondition[]
  readonly cleared: (OpenException & { version: number })[]
  readonly requirementOf: ReadonlyMap<string, string>
}

/** What a check of the order's lines would do (read only). null: the order has no site plan to check against. */
async function planCheck(db: Reader, purchaseOrderId: string, now: Date): Promise<PlannedCheck | null> {
  const order = isUuid(purchaseOrderId) ? await db.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { id: true, number: true, companyId: true, siteId: true } }) : null
  if (!order) return null
  const site = await db.site.findUnique({ where: { id: order.siteId }, select: SITE_COLUMNS })
  if (!site) return null
  const run = await latestDoneRun(db, site.id)
  if (!run) return null
  const lines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id }, select: { id: true, itemId: true, itemColourId: true }, orderBy: { seq: 'asc' } })
  if (lines.length === 0) return null
  const today = businessDate(now, site.timezone)
  const keys = new Set(lines.map((line) => keyOf(line.id)))
  const live = await livePlanOf(db, site, today)
  const lineIds = new Set(lines.map((line) => line.id))
  const touched = (index: number) => live.plan.netting[index]!.pegging.purchases.some((purchase) => lineIds.has(purchase.line.purchaseOrderLineId))
  const detected = await detectInputs({ tx: db as CommandTools['tx'] }, site, live.inputs, live.plan, today)
  const materials = detected.materials.filter((_, index) => touched(index))
  const conditions = detectExceptions({
    runDate: today,
    materials,
    purchaseOf: (lineId) => {
      const line = live.inputs.purchases.find((purchase) => purchase.purchaseOrderLineId === lineId)
      return line ? { purchaseOrderId: line.purchaseOrderId, purchaseOrderNumber: line.purchaseOrderNumber } : undefined
    },
  }).filter((condition) => condition.kind === SUPPLY_LATE && keys.has(condition.key))
  const open = (await db.planningException.findMany({ where: { siteId: site.id, status: { not: 'RESOLVED' }, dedupeKey: { in: [...keys] } }, select: OPEN_COLUMNS, orderBy: { id: 'asc' } })) as (OpenException & { version: number; lastSeenAt: Date })[]
  const refresh = refreshOf(open, conditions, [SUPPLY_LATE])
  // The latest run's buy line of each material (the "Buy elsewhere" fix's draft purchase order reads it).
  const requirementOf = new Map<string, string>()
  for (const condition of [...refresh.raised, ...refresh.found.map((entry) => entry.condition)]) {
    if (!condition.itemId) continue
    const requirement = await db.materialRequirement.findFirst({ where: { runId: run.id, itemId: condition.itemId, itemColourId: condition.itemColourId }, select: { id: true }, orderBy: { seq: 'asc' } })
    if (requirement) requirementOf.set(condition.key, requirement.id)
  }
  return {
    site,
    purchaseOrder: { id: order.id, number: order.number, companyId: order.companyId },
    runId: run.id,
    today,
    found: refresh.found.map(({ row, condition }) => ({ row: row as OpenException & { version: number; lastSeenAt: Date }, condition })),
    raised: [...refresh.raised],
    cleared: [...refresh.cleared] as unknown as (OpenException & { version: number })[],
    requirementOf,
  }
}

const factsOf = (condition: ExceptionCondition) => ({ ...condition.facts, sentence: condition.sentence, foundBy: 'SUPPLIER_DATE' }) as Prisma.InputJsonValue

/** Applies a planned check inside a command (planned again there: the facts as they are now). */
async function applyCheck(tools: CommandTools, purchaseOrderId: string): Promise<{ siteId: string; raised: number; stillOpen: number; cleared: number } | null> {
  const { tx, now } = tools
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.supply-late', ${purchaseOrderId}::uuid), 0))`
  const planned = await planCheck(tx, purchaseOrderId, now)
  if (!planned) {
    tools.audit({ action: 'planning.supplyLate.check', recordType: 'PurchaseOrder', recordId: purchaseOrderId, after: { checked: false } })
    return null
  }
  const { site, runId } = planned
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  for (const { row, condition } of planned.found) {
    await tx.planningException.update({
      where: { id: row.id },
      data: { lastRunId: runId, lastSeenAt: now.getTime() < row.lastSeenAt.getTime() ? row.lastSeenAt : now, facts: factsOf(condition), ordersAffected: condition.ordersAffected, daysLate: condition.daysLate, version: row.version + 1 },
      select: { id: true },
    })
  }
  if (planned.raised.length > 0) {
    const earlier = await tx.planningException.groupBy({ by: ['dedupeKey'], where: { siteId: site.id, dedupeKey: { in: planned.raised.map((condition) => condition.key) } }, _max: { occurrence: true } })
    const lastOf = new Map(earlier.map((row) => [row.dedupeKey, row._max.occurrence ?? 0]))
    await tx.planningException.createMany({
      data: planned.raised.map((condition) => ({
        id: newId(),
        companyId: site.companyId,
        siteId: site.id,
        kind: condition.kind,
        dedupeKey: condition.key,
        occurrence: (lastOf.get(condition.key) ?? 0) + 1,
        firstRunId: runId,
        lastRunId: runId,
        firstSeenAt: now,
        lastSeenAt: now,
        itemId: condition.itemId,
        itemColourId: condition.itemColourId,
        requirementId: planned.requirementOf.get(condition.key) ?? null,
        recordType: condition.record?.type ?? null,
        recordId: condition.record?.id ?? null,
        facts: factsOf(condition),
        ordersAffected: condition.ordersAffected,
        daysLate: condition.daysLate,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      })),
    })
  }
  for (const row of planned.cleared) {
    await tx.planningException.update({ where: { id: row.id }, data: { status: 'RESOLVED', resolvedAt: now, resolution: 'CLEARED', version: row.version + 1 }, select: { id: true } })
  }
  const counts = { raised: planned.raised.length, stillOpen: planned.found.length, cleared: planned.cleared.length }
  tools.audit({ action: 'planning.supplyLate.check', recordType: 'PurchaseOrder', recordId: purchaseOrderId, companyId: site.companyId, siteId: site.id, after: { runId, ...counts, raised: planned.raised.map((condition) => condition.key), cleared: planned.cleared.map((row) => row.dedupeKey) } })
  tools.emit({ type: 'supply_late.checked', subject: purchaseOrderId, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, purchaseOrderId, ...counts } })
  return { siteId: site.id, ...counts }
}

/**
 * Checks a purchase order's supplier dates against what they feed: nothing is written when nothing would change (an idle
 * check leaves no audit row); else ONE command under the order's check lock.
 */
export async function checkSupplyLate(caller: CommandCaller, purchaseOrderId: string, options: { readonly idempotencyKey?: string | undefined; readonly causationId?: string | undefined } = {}) {
  const planned = await caller.withClient((db) => planCheck(db, purchaseOrderId, serverClock.now()))
  if (!planned) return { checked: false, siteId: null, raised: 0, stillOpen: 0, cleared: 0, replayed: false }
  const changes = planned.raised.length + planned.cleared.length + planned.found.length
  if (changes === 0) return { checked: true, siteId: planned.site.id, raised: 0, stillOpen: 0, cleared: 0, replayed: false }
  const outcome = await command(caller, { name: 'planning.supplyLate.check', idempotencyKey: options.idempotencyKey, input: { purchaseOrderId }, ...(options.causationId ? { causationId: options.causationId } : {}) }, (tools) => applyCheck(tools, purchaseOrderId))
  const result = outcome.result ?? { siteId: planned.site.id, raised: 0, stillOpen: 0, cleared: 0 }
  return { checked: true, ...result, replayed: outcome.replayed }
}

/** The worker's handler: a supplier's date moved (W1 confirm, B-W2b-296's dates) → check the order's lines now. */
export function supplyLateHandler(): EventHandler {
  return defineHandler({
    name: 'planning.supplyLate',
    events: [...SUPPLY_DATE_EVENTS],
    async handle(event, tools) {
      const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>
      const purchaseOrderId = payload.purchaseOrderId
      if (typeof purchaseOrderId !== 'string' || !isUuid(purchaseOrderId)) return
      await checkSupplyLate(tools.caller, purchaseOrderId, { idempotencyKey: `supply-late:${event.eventId}`, causationId: event.eventId })
    },
  })
}

// ---- the office's reads and the check by hand -------------------------------------------------------------------------------

async function siteOf(caller: CommandCaller, db: Reader, siteId: string): Promise<{ context: OfficeContext; site: SiteRow }> {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await db.site.findUnique({ where: { id: siteId }, select: SITE_COLUMNS }) : null
  if (!site || !can(actorOf(context), PLANNING_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  return { context, site }
}

/** POST /planning/exceptions/supply-late/check — a planner checks a purchase order's dates now. */
export async function checkSupplyLateNow(caller: CommandCaller, body: { readonly purchaseOrderId: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await caller.withClient((db) => (isUuid(body.purchaseOrderId) ? db.purchaseOrder.findUnique({ where: { id: body.purchaseOrderId }, select: { id: true, companyId: true, siteId: true } }) : Promise.resolve(null)))
  if (!order || !can(actorOf(context), PLANNING_VIEW, { companyId: order.companyId, siteId: order.siteId })) throw new NotFoundError('Purchase order not found.')
  if (!can(actorOf(context), PLANNING_EXCEPTIONS_MANAGE, { companyId: order.companyId, siteId: order.siteId })) throw new ForbiddenError()
  const result = await checkSupplyLate(caller, order.id, { idempotencyKey })
  return { ...result, view: await supplyLateList(caller, { siteId: order.siteId }) }
}

type FixOrderLine = Awaited<ReturnType<typeof promiseLinesOf>>['lines'][number]

/** The fixes of the open SUPPLY_LATE exceptions of a site (or one). */
async function fixesOf(db: Reader, context: OfficeContext, site: SiteRow, exceptions: readonly { id: string; dedupeKey: string; itemId: string | null; itemColourId: string | null; requirementId: string | null; facts: Prisma.JsonValue; daysLate: number | null; ordersAffected: number }[], now: Date) {
  const today = businessDate(now, site.timezone)
  if (exceptions.length === 0) return new Map<string, ReturnType<typeof fixView>>()
  const live: LivePlan = await livePlanOf(db, site, today)
  const lineIds = exceptions.flatMap((row) => {
    const id = lineIdOfKey(row.dedupeKey)
    return id ? [id] : []
  })
  const poLines = await db.purchaseOrderLine.findMany({
    where: { id: { in: lineIds } },
    select: { id: true, seq: true, itemId: true, itemColourId: true, needDate: true, purchaseOrder: { select: { id: true, number: true, status: true, companyId: true, party: { select: { id: true, code: true, legalName: true, tradeName: true } } } }, item: { select: { code: true } } },
  })
  // What each purchase order line feeds now: the parts waiting for it (short before it comes) or counting on it.
  const fedOf = new Map<string, { orderLineIds: Set<string>; workOrderIds: Set<string>; needDate: BusinessDate | null; supplyDate: BusinessDate | null }>()
  live.plan.netting.forEach((netting) => {
    for (const purchase of netting.pegging.purchases) {
      const id = purchase.line.purchaseOrderLineId
      if (!lineIds.includes(id)) continue
      const walked = netting.pegging.coverage.filter((coverage) => decimalOf(coverage.part.quantity).minus(decimalOf(coverage.part.issued)).gt(0))
      const parts = walked.filter((coverage) => (decimalOf(coverage.short).gt(0) && coverage.day < purchase.line.dueDate) || coverage.supplies.some((supply) => supply.purchaseOrderLineId === id))
      const entry = fedOf.get(id) ?? { orderLineIds: new Set<string>(), workOrderIds: new Set<string>(), needDate: null, supplyDate: purchase.line.dueDate }
      for (const coverage of parts) {
        entry.orderLineIds.add(coverage.part.orderLineId)
        if (coverage.part.workOrderId) entry.workOrderIds.add(coverage.part.workOrderId)
        if (entry.needDate === null || coverage.day < entry.needDate) entry.needDate = coverage.day
      }
      fedOf.set(id, entry)
    }
  })
  const workOrderIds = [...new Set([...fedOf.values()].flatMap((entry) => [...entry.workOrderIds]))]
  const world = workOrderIds.length > 0 ? await scheduleWorld(db, site, { from: today, to: today }, now) : null
  const starts = world ? await materialStartsOf(db, world, workOrderIds.filter((id) => world.workOrders.some((workOrder) => workOrder.id === id))) : new Map()
  const orderLines = await promiseLinesOf(db, context, site, now, { orderLineIds: [...new Set([...fedOf.values()].flatMap((entry) => [...entry.orderLineIds]))] })
  // Other approved sources of each material, with the day they would bring it ordered today.
  const supplierIds = [...new Set(live.inputs.sources.map((source) => source.partyId))]
  const longest = Math.min(400, Math.max(0, ...live.inputs.sources.map((source) => source.leadTimeDays ?? 0), ...[...live.inputs.supplierLeadTimes.values()].map((days) => days ?? 0)))
  const calendars = supplierIds.length > 0 ? await supplierCalendarsFor(db, supplierIds, leadTimeWindow(today, longest, 'forward')) : new Map()
  const parties = supplierIds.length > 0 ? new Map((await db.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((party) => [party.id, party])) : new Map()
  const out = new Map<string, ReturnType<typeof fixView>>()
  for (const row of exceptions) {
    const poLineId = lineIdOfKey(row.dedupeKey)
    const poLine = poLines.find((line) => line.id === poLineId) ?? null
    const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts : {}) as Record<string, unknown>
    const fed = poLineId ? fedOf.get(poLineId) : undefined
    const supplyDate = typeof facts.supplyDate === 'string' ? facts.supplyDate : (fed?.supplyDate ?? null)
    const needDate = typeof facts.needDate === 'string' ? facts.needDate : (fed?.needDate ?? null)
    const sources = poLine
      ? rankedSources(live.inputs.sources, { companyId: poLine.purchaseOrder.companyId, itemId: poLine.itemId, itemColourId: poLine.itemColourId }).filter((source) => source.partyId !== poLine.purchaseOrder.party.id)
      : []
    const elsewhere = sources.map((source) => {
      const lead = source.leadTimeDays ?? live.inputs.supplierLeadTimes.get(source.partyId) ?? null
      const arrives = lead === null ? null : arrivalDate(calendars.get(source.partyId)?.calendar ?? null, today, lead).date
      const party = parties.get(source.partyId)
      return { supplier: { id: source.partyId, code: party?.code ?? '', name: party?.tradeName ?? party?.legalName ?? '' }, sourceId: source.id, leadTimeDays: lead, arrives, inTime: arrives !== null && needDate !== null ? arrives <= needDate : null }
    })
    const lines: FixOrderLine[] = fed ? orderLines.lines.filter((line) => fed.orderLineIds.has(line.id)) : []
    out.set(row.id, fixView({ row, poLine, supplyDate, needDate, today, fedWorkOrders: fed ? [...fed.workOrderIds] : [], world, starts, elsewhere, lines }))
  }
  return out
}

function fixView(input: {
  row: { id: string; requirementId: string | null; daysLate: number | null }
  poLine: { id: string; seq: number; item: { code: string }; purchaseOrder: { id: string; number: string; status: string; party: { id: string; code: string; legalName: string; tradeName: string | null } } } | null
  supplyDate: BusinessDate | null
  needDate: BusinessDate | null
  today: BusinessDate
  fedWorkOrders: string[]
  world: Awaited<ReturnType<typeof scheduleWorld>> | null
  starts: Map<string, { state: string; startDay: BusinessDate | null; words: string }>
  elsewhere: { supplier: { id: string; code: string; name: string }; sourceId: string; leadTimeDays: number | null; arrives: BusinessDate | null; inTime: boolean | null }[]
  lines: FixOrderLine[]
}) {
  const { poLine, supplyDate, needDate } = input
  const late = supplyDate !== null && needDate !== null ? Math.max(0, daysFrom(needDate, supplyDate)) : input.row.daysLate
  const supplier = poLine ? { id: poLine.purchaseOrder.party.id, code: poLine.purchaseOrder.party.code, name: poLine.purchaseOrder.party.tradeName ?? poLine.purchaseOrder.party.legalName } : null
  const dayOf = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString().slice(0, 10))
  return {
    chase: poLine
      ? {
          purchaseOrder: { id: poLine.purchaseOrder.id, number: poLine.purchaseOrder.number, status: poLine.purchaseOrder.status },
          supplier,
          line: { id: poLine.id, seq: poLine.seq, item: poLine.item.code },
          supplyDate,
          needDate,
          daysLate: late,
          words: `Chase ${poLine.purchaseOrder.number} line ${poLine.seq}: ${supplier?.name ?? 'the supplier'} brings ${poLine.item.code} ${supplyDate ?? 'on a day not known'}; it is needed ${needDate ?? 'soon'}${late ? ` (${late} days late)` : ''}.`,
        }
      : null,
    move: input.fedWorkOrders.flatMap((id) => {
      const workOrder = input.world?.workOrders.find((entry) => entry.id === id)
      if (!workOrder) return []
      const schedule = input.world!.schedules.get(id)
      const start = input.starts.get(id) ?? null
      return [
        {
          workOrder: { id, number: workOrder.number, status: workOrder.status, dueDate: workOrder.dueDate },
          plannedStart: schedule?.plannedStart ? toUtcIso(new Date(schedule.plannedStart)) : null,
          plannedFinish: schedule?.plannedFinish ? toUtcIso(new Date(schedule.plannedFinish)) : null,
          materialState: start?.state ?? null,
          earliestStart: start?.startDay ?? null,
          inTime: start?.startDay && schedule?.plannedStart ? start.startDay <= (dayOf(schedule.plannedStart) ?? start.startDay) : null,
          words: `Move ${workOrder.number} on the board: ${start?.words ?? 'its material day is not known.'}`,
        },
      ]
    }),
    buyElsewhere: input.elsewhere.map((entry) => ({
      ...entry,
      requirementId: input.row.requirementId,
      words: `Buy from ${entry.supplier.name || entry.supplier.code}: ${entry.leadTimeDays === null ? 'no lead time on record' : `${entry.leadTimeDays} days, ordered today it arrives ${entry.arrives}`}${entry.inTime === null ? '' : entry.inTime ? ' (in time).' : ' (still late).'}`,
    })),
    repromise: input.lines.map((line) => ({
      orderLine: { id: line.id, seq: line.seq },
      order: line.order,
      customer: line.customer,
      current: line.current,
      finish: line.finish,
      risk: line.risk,
      waiting: line.waiting,
      may: line.may.repromise,
      words: line.words,
    })),
  }
}

const SUPPLY_LATE_COLUMNS = { id: true, siteId: true, dedupeKey: true, status: true, itemId: true, itemColourId: true, requirementId: true, facts: true, daysLate: true, ordersAffected: true, recordType: true, recordId: true, firstSeenAt: true, lastSeenAt: true, version: true } as const satisfies Prisma.PlanningExceptionSelect

/** GET /planning/exceptions/supply-late — the tile "Supplier dates later than needed" and its exceptions with their fixes. */
export async function supplyLateList(caller: CommandCaller, query: { readonly siteId: string }) {
  return caller.withClient(async (db) => {
    const { context, site } = await siteOf(caller, db, query.siteId)
    const now = serverClock.now()
    const rows = await db.planningException.findMany({ where: { siteId: site.id, kind: SUPPLY_LATE, status: { not: 'RESOLVED' } }, select: SUPPLY_LATE_COLUMNS, orderBy: [{ daysLate: { sort: 'desc', nulls: 'last' } }, { firstSeenAt: 'asc' }, { id: 'asc' }], take: 200 })
    const fixes = await fixesOf(db, context, site, rows, now)
    return {
      site: { id: site.id, code: site.code, name: site.name },
      asOf: toUtcIso(now),
      tile: rows.length,
      exceptions: rows.map((row) => exceptionView(row, fixes.get(row.id) ?? null)),
    }
  })
}

/** GET /planning/exceptions/:exceptionId/fixes — one SUPPLY_LATE exception's fixes. */
export async function supplyLateFixes(caller: CommandCaller, exceptionId: string) {
  return caller.withClient(async (db) => {
    const row = isUuid(exceptionId) ? await db.planningException.findUnique({ where: { id: exceptionId }, select: { ...SUPPLY_LATE_COLUMNS, kind: true } }) : null
    if (!row) throw new NotFoundError('Exception not found.')
    const { context, site } = await siteOf(caller, db, row.siteId)
    if (row.kind !== SUPPLY_LATE) throw new NotFoundError('This exception is not a supply too late: it has no supply fixes.')
    const fixes = await fixesOf(db, context, site, [row], serverClock.now())
    return exceptionView(row, fixes.get(row.id) ?? null)
  })
}

function exceptionView(row: { id: string; siteId: string; dedupeKey: string; status: string; facts: Prisma.JsonValue; daysLate: number | null; ordersAffected: number; recordType: string | null; recordId: string | null; firstSeenAt: Date; lastSeenAt: Date; version: number }, fixes: ReturnType<typeof fixView> | null) {
  const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts : {}) as Record<string, unknown>
  return {
    id: row.id,
    siteId: row.siteId,
    status: row.status,
    version: row.version,
    purchaseOrderLineId: lineIdOfKey(row.dedupeKey),
    record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null,
    sentence: typeof facts.sentence === 'string' ? facts.sentence : '',
    foundBy: facts.foundBy === 'SUPPLIER_DATE' ? ('SUPPLIER_DATE' as const) : ('RUN' as const),
    supplyDate: typeof facts.supplyDate === 'string' ? facts.supplyDate : null,
    needDate: typeof facts.needDate === 'string' ? facts.needDate : null,
    overdue: facts.overdue === true,
    daysLate: row.daysLate,
    ordersAffected: row.ordersAffected,
    firstSeenAt: toUtcIso(row.firstSeenAt),
    lastSeenAt: toUtcIso(row.lastSeenAt),
    fixes,
  }
}

// ---- contracts (the route lines are in planning's routes.ts) -------------------------------------------------------------------

const named = output({ id: id(), code: z.string(), name: z.string() })

const fixesView = output({
  chase: output({
    purchaseOrder: output({ id: id(), number: z.string(), status: z.string() }),
    supplier: named.nullable(),
    line: output({ id: id(), seq: z.number().int(), item: z.string() }),
    supplyDate: businessDateSchema().nullable(),
    needDate: businessDateSchema().nullable(),
    daysLate: z.number().int().nullable(),
    words: z.string(),
  }).nullable(),
  move: z.array(
    output({
      workOrder: output({ id: id(), number: z.string(), status: z.string(), dueDate: businessDateSchema().nullable() }),
      plannedStart: instant().nullable(),
      plannedFinish: instant().nullable(),
      materialState: z.string().nullable(),
      /** The first day it can start with the material (B-W2b-312). */
      earliestStart: businessDateSchema().nullable(),
      inTime: z.boolean().nullable(),
      words: z.string(),
    }),
  ),
  buyElsewhere: z.array(
    output({
      supplier: named,
      sourceId: id(),
      leadTimeDays: z.number().int().nullable(),
      /** Ordered today, the day it arrives (the supplier's calendar). */
      arrives: businessDateSchema().nullable(),
      inTime: z.boolean().nullable(),
      /** The latest run's line of the material (a draft purchase order from the plan names it). */
      requirementId: id().nullable(),
      words: z.string(),
    }),
  ),
  repromise: z.array(
    output({
      orderLine: output({ id: id(), seq: z.number().int() }),
      order: output({ id: id(), number: z.string(), status: z.string(), priorityLevel: z.string(), backlogPosition: z.number().int().nullable() }),
      customer: named,
      current: businessDateSchema().nullable(),
      finish: businessDateSchema().nullable(),
      risk: z.enum(RISK_STATES).nullable(),
      waiting: output({ proposalId: id(), proposedAt: instant(), sizes: z.array(output({ size: z.string().nullable(), from: businessDateSchema().nullable(), to: businessDateSchema() })) }).nullable(),
      may: z.boolean(),
      words: z.string(),
    }),
  ),
})

const supplyLateView = output({
  id: id(),
  siteId: id(),
  status: z.string(),
  version: z.number().int(),
  purchaseOrderLineId: id().nullable(),
  record: output({ type: z.string(), id: id() }).nullable(),
  sentence: z.string(),
  /** RUN: the nightly run found it; SUPPLIER_DATE: a supplier's date checked at once. */
  foundBy: z.enum(['RUN', 'SUPPLIER_DATE']),
  supplyDate: businessDateSchema().nullable(),
  needDate: businessDateSchema().nullable(),
  overdue: z.boolean(),
  daysLate: z.number().int().nullable(),
  ordersAffected: z.number().int(),
  firstSeenAt: instant(),
  lastSeenAt: instant(),
  fixes: fixesView.nullable(),
})

const listView = output({ site: output({ id: id(), code: z.string(), name: z.string() }), asOf: instant(), tile: z.number().int(), exceptions: z.array(supplyLateView) })

export const supplyLateListContract = defineContract({ querystring: input({ siteId: id() }), response: { 200: listView } })

export const supplyLateFixesContract = defineContract({ params: input({ exceptionId: id() }), response: { 200: supplyLateView } })

export const supplyLateCheckContract = defineContract({
  body: input({ purchaseOrderId: id() }),
  response: {
    200: output({ checked: z.boolean(), siteId: id().nullable(), raised: z.number().int(), stillOpen: z.number().int(), cleared: z.number().int(), replayed: z.boolean(), view: listView }),
  },
})
