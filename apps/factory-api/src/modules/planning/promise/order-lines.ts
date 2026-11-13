import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { MADE_WORK_ORDER_STATUSES, OPEN_WORK_ORDER_STATUSES } from '@nexus/factory-domain/planning/explode'
import { demandOf } from '@nexus/factory-domain/planning/planned-orders/rules'
import { PLANNING_PROMISE_MANAGE, PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import {
  currentPromiseOf,
  dayWords,
  groupsWords,
  promiseAskProblems,
  promisePlanOf,
  promiseRowWords,
  sizeGroupsOf,
  type PromiseAsk,
  type PromiseWarning,
  type SizeState,
  type StoredPromise,
} from '@nexus/factory-domain/planning/promise/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { countryOf } from '../../compliance/gates/facts'
import { officeContextOf } from '../access'
import { scheduleWorld } from '../schedule/service'
import { dayOf, SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import { certificatesOn, type SizeCertificate } from './certificates'
import { answerPromises } from './engine'
import { whereOf } from './read'
import { PROMISABLE_ORDER_STATUSES, mayPromiseAt, readPromiseRows } from './store'
// B-W2b-365: the options chosen on the line (a step only for some options counts when one of them is chosen).
import { lineOptionsOf } from '../planned-orders/steps'

/**
 * An order line's promise per size (B-W2b-301; PLN-171, PLN-179; design planning.promise "Per size when sizes differ (S–L
 * 4 Dec, XL 11 Dec)", Sales › Order › Dates & promise): what each size still waits for, its promise now (its own newest
 * PromiseRecord, else the line's, else the date sales typed), and the day the plan says it is ready — the open work orders
 * making it at the board's planned finish, the plan's planned work orders on their due date, the calculator for what nothing
 * makes yet — with the certificate on that day. Read with planning.promise.view over the line's making site and
 * orders.view over its order (company, customer).
 *
 * Recording (planning.promise.manage): ONE command under the line's promise lock writes B-W2b-286's append-only rows — a
 * size's FIRST promise, or a RE_PROMISE of a size promised apart from the line with its reason (the date sales typed
 * becomes the line's FIRST row first) — only for sizes a valid certificate covers through their date (PLN-179). The order's
 * own dates (W1's, sales') are not changed here; nobody is told (B-W2b-317 tells the customer).
 */

const LINE_SELECT = {
  id: true,
  seq: true,
  kind: true,
  companyId: true,
  partyId: true,
  orderId: true,
  styleId: true,
  styleRevisionId: true,
  colourwayId: true,
  baseSize: true,
  siteId: true,
  promiseDate: true,
  requestedDate: true,
  sizes: { select: { size: true, quantity: true } },
  style: { select: { id: true, code: true, name: true, sizes: true, baseSize: true } },
  colourway: { select: { id: true, code: true, name: true } },
  order: { select: { id: true, number: true, status: true, orderDate: true, promiseDate: true, originalPromiseDate: true, shipTo: true, createdAt: true, createdById: true } },
} as const

async function readLine(db: Reader, orderLineId: string) {
  return isUuid(orderLineId) ? db.salesOrderLine.findUnique({ where: { id: orderLineId }, select: LINE_SELECT }) : null
}
type LineRow = NonNullable<Awaited<ReturnType<typeof readLine>>>

/** The line (orders.view over its order, else not found) and its making site (`permission` there, else forbidden). */
async function lineFor(caller: CommandCaller, db: Reader, orderLineId: string, permission: Permission): Promise<{ context: OfficeContext; line: LineRow; site: SiteRow }> {
  const context = officeContextOf(caller)
  const line = await readLine(db, orderLineId)
  if (!line || line.kind === 'FEE' || !can(actorOf(context), ORDERS_VIEW, { companyId: line.companyId, partyId: line.partyId })) throw new NotFoundError('Order line not found.')
  let site: SiteRow | null = line.siteId ? await db.site.findUnique({ where: { id: line.siteId }, select: SITE_COLUMNS }) : null
  if (!site) {
    const plants = await db.site.findMany({ where: { companyId: line.companyId, kind: 'PLANT', status: 'ACTIVE' }, select: SITE_COLUMNS, take: 2 })
    if (plants.length !== 1) throw new InvalidStateError(`${line.order.number} line ${line.seq} has no making site yet and the company has ${plants.length === 0 ? 'no active plant' : 'several plants'}: choose its site first.`)
    site = plants[0]!
  }
  if (!mayPromiseAt(context, PLANNING_PROMISE_VIEW, site)) throw new ForbiddenError()
  if (permission !== PLANNING_PROMISE_VIEW && !mayPromiseAt(context, permission, site)) throw new ForbiddenError()
  return { context, line, site }
}

const typedOf = (line: LineRow): BusinessDate | null => {
  const day = line.promiseDate ?? line.order.promiseDate
  return day ? dayOf(day) : null
}

/** The line's sizes in the style's order (a made-to-measure line: one unit, size null). */
function sizesOfLine(line: LineRow): { size: string | null; ordered: number }[] {
  if (line.kind === 'MADE_TO_MEASURE') return [{ size: null, ordered: 1 }]
  const order = line.style.sizes
  return [...line.sizes].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size)).map((entry) => ({ size: entry.size, ordered: entry.quantity }))
}

async function shippedOf(db: Reader, line: LineRow): Promise<(size: string | null) => number> {
  const rows = await db.shipmentLine.groupBy({ by: ['size'], where: { salesOrderLineId: line.id, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } }, _sum: { quantity: true } })
  const total = rows.reduce((sum, row) => sum + (row._sum.quantity ?? 0), 0)
  const bySize = new Map(rows.map((row) => [row.size, row._sum.quantity ?? 0]))
  return (size) => (size === null ? total : (bySize.get(size) ?? 0))
}

const max0 = (value: number): number => (value > 0 ? value : 0)
const latest = (dates: readonly (BusinessDate | null)[]): BusinessDate | null => dates.reduce<BusinessDate | null>((best, date) => (date === null ? best : best === null || date > best ? date : best), null)

/** The line's view: sizes, promises, the plan's days, the history. */
async function lineView(db: Reader, context: OfficeContext, line: LineRow, site: SiteRow, now: Date) {
  const { where, view } = await whereOf(db, site, now, countryOf(line.order.shipTo))
  const today = where.today
  const sizes = sizesOfLine(line)
  const shipped = await shippedOf(db, line)
  const typed = typedOf(line)
  const history = await db.promiseRecord.findMany({
    where: { salesOrderLineId: line.id },
    select: { id: true, size: true, promisedDate: true, kind: true, reasonCode: true, reason: true, promisedAt: true, promisedById: true, customerToldAt: true },
    orderBy: [{ promisedAt: 'asc' }, { id: 'asc' }],
  })
  const stored: StoredPromise[] = history.map((row) => ({ id: row.id, size: row.size, promisedDate: dayOf(row.promisedDate), kind: row.kind, promisedAt: row.promisedAt }))
  const people = [...new Set(history.map((row) => row.promisedById))]
  const names = people.length === 0 ? new Map<string, string>() : new Map((await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))

  // What makes the line: its work order cells (open and made), the plan's planned work orders.
  const cells = await db.workOrderSize.findMany({
    where: { salesOrderLineId: line.id, workOrder: { kind: { not: 'REPAIR' }, status: { in: [...OPEN_WORK_ORDER_STATUSES, ...MADE_WORK_ORDER_STATUSES] } } },
    select: { workOrderId: true, size: true, quantity: true, workOrder: { select: { number: true, status: true, dueDate: true } } },
    orderBy: [{ workOrderId: 'asc' }, { size: 'asc' }],
  })
  const openCells = cells.filter((cell) => OPEN_WORK_ORDER_STATUSES.includes(cell.workOrder.status as (typeof OPEN_WORK_ORDER_STATUSES)[number]))
  const finishOf = new Map<string, BusinessDate | null>()
  if (openCells.length > 0) {
    const world = await scheduleWorld(db, site, { from: today, to: today }, now)
    for (const workOrderId of new Set(openCells.map((cell) => cell.workOrderId))) {
      const schedule = world.schedules.get(workOrderId)
      const planned = schedule?.plannedFinish ?? null
      finishOf.set(workOrderId, planned === null ? null : businessDate(new Date(planned), site.timezone))
    }
  }
  const planned = await db.plannedWorkOrder.findMany({ where: { siteId: site.id, styleId: line.styleId, status: 'PLANNED' }, select: { id: true, demand: true, dueDate: true }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })
  const plannedFor = (size: string | null) =>
    planned.flatMap((row) => {
      const pieces = demandOf(row.demand)
        .filter((entry) => entry.orderLineId === line.id && (size === null || entry.size === size))
        .reduce((sum, entry) => sum + entry.pieces, 0)
      return pieces > 0 ? [{ id: row.id, pieces, dueDate: dayOf(row.dueDate) }] : []
    })

  const perSize = sizes.map((entry) => {
    const ofSize = cells.filter((cell) => entry.size === null || cell.size === entry.size)
    const made = ofSize.filter((cell) => !openCells.includes(cell)).reduce((sum, cell) => sum + cell.quantity, 0)
    const shippedPieces = shipped(entry.size)
    const open = max0(entry.ordered - shippedPieces)
    const workOrders = ofSize
      .filter((cell) => openCells.includes(cell))
      .map((cell) => {
        const dueDate = cell.workOrder.dueDate ? dayOf(cell.workOrder.dueDate) : null
        const plannedFinish = finishOf.get(cell.workOrderId) ?? null
        return { id: cell.workOrderId, number: cell.workOrder.number, status: cell.workOrder.status, pieces: cell.quantity, dueDate, plannedFinish, finish: plannedFinish ?? dueDate }
      })
    const plannedOrders = plannedFor(entry.size)
    const readyNow = max0(made - shippedPieces)
    const covered = readyNow + workOrders.reduce((sum, row) => sum + row.pieces, 0) + plannedOrders.reduce((sum, row) => sum + row.pieces, 0)
    return { ...entry, shipped: shippedPieces, open, readyNow, workOrders, plannedOrders, uncovered: max0(open - covered) }
  })

  // What nothing makes yet: the calculator, from the line's own place in the plan.
  const askSize = (size: string | null) => size ?? line.baseSize ?? line.style.baseSize ?? line.style.sizes[0] ?? ''
  const asked = perSize.filter((entry) => entry.uncovered > 0)
  const warnings: PromiseWarning[] = []
  const engineOf = new Map<string, { date: BusinessDate | null; state: SizeState; certificate: SizeCertificate | null }>()
  if (asked.length > 0) {
    const [answer] = await answerPromises(db, where, [
      { key: 'line', orderLineId: line.id, styleId: line.styleId, colourwayId: line.colourwayId, revisionId: line.styleRevisionId, sizes: asked.map((entry) => ({ size: askSize(entry.size), quantity: entry.uncovered })), madeToMeasure: line.kind === 'MADE_TO_MEASURE', wantedDate: null, optionValueIds: (await lineOptionsOf(db, [line.id])).get(line.id) ?? [] },
    ])
    for (const size of answer!.sizes) engineOf.set(size.size, { date: size.date ?? size.readyDate, state: size.state, certificate: size.certificate })
    warnings.push(...answer!.warnings)
  }
  const proposals = perSize.map((entry) => {
    if (entry.open === 0) return { entry, proposed: null as BusinessDate | null, engine: null }
    const engine = entry.uncovered > 0 ? (engineOf.get(askSize(entry.size)) ?? null) : null
    const dates = [entry.readyNow > 0 ? today : null, ...entry.workOrders.map((row) => row.finish ?? today), ...entry.plannedOrders.map((row) => row.dueDate), entry.uncovered > 0 ? (engine?.date ?? null) : null]
    const noDate = entry.uncovered > 0 && (engine?.date ?? null) === null
    const proposed = noDate ? null : latest(dates)
    return { entry, proposed: proposed !== null && proposed < today ? today : proposed, engine }
  })
  // The certificate on each proposed day (PLN-179).
  const certificateOf = new Map<string, SizeCertificate>()
  for (const day of [...new Set(proposals.flatMap((row) => (row.proposed ? [row.proposed] : [])))].sort()) {
    const onDay = proposals.filter((row) => row.proposed === day)
    const answers = await certificatesOn(db, { styleId: line.styleId, styleCode: line.style.code, asks: onDay.map((row) => ({ key: askSize(row.entry.size), colourwayId: line.colourwayId, colourwayCode: line.colourway.code, size: askSize(row.entry.size) })), market: where.market, destination: where.destination, day, now })
    for (const [key, answer] of answers) certificateOf.set(key, answer)
  }
  const rows = proposals.map(({ entry, proposed, engine }) => {
    const certificate = certificateOf.get(askSize(entry.size)) ?? engine?.certificate ?? null
    const notCertified = certificate?.state === 'MISSING' || engine?.state === 'NOT_CERTIFIED'
    const state: SizeState = notCertified ? 'NOT_CERTIFIED' : proposed === null ? 'NO_DATE' : entry.uncovered === 0 && entry.workOrders.length === 0 && entry.plannedOrders.length === 0 ? 'FROM_STOCK' : 'MAKE'
    const current = currentPromiseOf(entry.size, stored, typed)
    const date = state === 'NOT_CERTIFIED' ? null : proposed
    const label = entry.size === null ? 'The unit' : `Size ${entry.size}`
    const words =
      entry.open === 0
        ? `${label} has shipped.`
        : state === 'NOT_CERTIFIED'
          ? `${label} is not promised: ${certificate?.words ?? 'no valid certificate covers it.'}`
          : date === null
            ? `${label} has no date yet: what nothing makes does not fit within the horizon.`
            : `${label}: ${entry.open} open, ready by ${dayWords(date, today)}${current ? (current.date === date ? ' (as promised).' : `; promised ${dayWords(current.date, today)}.`) : '; not promised yet.'}`
    return {
      size: entry.size,
      ordered: entry.ordered,
      shipped: entry.shipped,
      open: entry.open,
      current,
      workOrders: entry.workOrders,
      plannedOrders: entry.plannedOrders,
      uncovered: entry.uncovered,
      proposed: date,
      state: entry.open === 0 ? ('SHIPPED' as SizeState) : state,
      certificate,
      differs: date !== null && current !== null && current.date !== date,
      words,
    }
  })
  const open = rows.filter((row) => row.open > 0)
  const groups = sizeGroupsOf(
    open.map((row) => ({ size: row.size ?? '—', date: row.proposed })),
    line.style.sizes,
    today,
  )
  return {
    ...view,
    order: { id: line.order.id, number: line.order.number, status: line.order.status, orderDate: dayOf(line.order.orderDate), promiseDate: line.order.promiseDate ? dayOf(line.order.promiseDate) : null, originalPromiseDate: line.order.originalPromiseDate ? dayOf(line.order.originalPromiseDate) : null },
    line: { id: line.id, seq: line.seq, kind: line.kind, style: { id: line.style.id, code: line.style.code, name: line.style.name }, colourway: line.colourway, promiseDate: line.promiseDate ? dayOf(line.promiseDate) : null, requestedDate: line.requestedDate ? dayOf(line.requestedDate) : null },
    sizes: rows,
    groups,
    groupsWords: groupsWords(groups),
    history: history.map((row) => ({
      id: row.id,
      size: row.size,
      promisedDate: dayOf(row.promisedDate),
      kind: row.kind,
      reasonCode: row.reasonCode,
      reason: row.reason,
      promisedAt: toUtcIso(row.promisedAt),
      promisedBy: names.has(row.promisedById) ? { id: row.promisedById, name: names.get(row.promisedById)! } : null,
      customerToldAt: row.customerToldAt ? toUtcIso(row.customerToldAt) : null,
    })),
    warnings,
    may: { record: mayPromiseAt(context, PLANNING_PROMISE_MANAGE, site) && (PROMISABLE_ORDER_STATUSES as readonly string[]).includes(line.order.status) },
  }
}

/** GET /planning/promise/order-lines/:orderLineId */
export async function orderLinePromise(caller: CommandCaller, orderLineId: string) {
  return caller.withClient(async (db) => {
    const { context, line, site } = await lineFor(caller, db, orderLineId, PLANNING_PROMISE_VIEW)
    return lineView(db, context, line, site, serverClock.now())
  })
}

export interface RecordBody {
  readonly sizes: readonly { readonly size?: string | null | undefined; readonly date: BusinessDate }[]
  readonly reasonCode?: string | undefined
  readonly reason?: string | undefined
}

/** A database refusal of the promise rows (…_planning_depth_w2b_guards 'planning: …'), as a 409 in its words. */
function planningRefusal(error: unknown): ConflictError | null {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if ((cause?.originalCode === '23514' || cause?.originalCode === '23505') && typeof cause.originalMessage === 'string') {
    const message = cause.originalMessage.replace(/^planning: /, '')
    return new ConflictError(cause.originalCode === '23505' ? 'This size has its first promise already: record the date again to re-promise it.' : `${message.charAt(0).toUpperCase()}${message.slice(1)}.`)
  }
  return null
}

/** POST /planning/promise/order-lines/:orderLineId — record the line's promise per size. */
export async function recordPromise(caller: CommandCaller, orderLineId: string, body: RecordBody, idempotencyKey?: string) {
  const asks: PromiseAsk[] = body.sizes.map((entry) => ({ size: entry.size ?? null, date: entry.date }))
  const checked = await caller.withClient(async (db) => {
    const { context, line, site } = await lineFor(caller, db, orderLineId, PLANNING_PROMISE_MANAGE)
    if (!(PROMISABLE_ORDER_STATUSES as readonly string[]).includes(line.order.status)) throw new InvalidStateError(`${line.order.number} is ${line.order.status}: nothing more is promised on it.`)
    const now = serverClock.now()
    const today = businessDate(now, site.timezone)
    const shipped = await shippedOf(db, line)
    const sizes = sizesOfLine(line)
    const problems = promiseAskProblems({
      asks,
      sizes: sizes.flatMap((entry) => (entry.size ? [entry.size] : [])),
      openOf: (size) => max0((sizes.find((entry) => entry.size === size)?.ordered ?? 0) - shipped(size)),
      madeToMeasure: line.kind === 'MADE_TO_MEASURE',
      today,
      orderDate: dayOf(line.order.orderDate),
    })
    if (problems.length > 0) throw new ValidationError('The promise cannot be recorded like this.', problems)
    // PLN-179: only sizes a valid certificate covers through their date are promised.
    const { where } = await whereOf(db, site, now, countryOf(line.order.shipTo))
    const sizeOf = (size: string | null) => size ?? line.baseSize ?? line.style.baseSize ?? line.style.sizes[0] ?? ''
    const refused: { path: string; message: string }[] = []
    for (const day of [...new Set(asks.map((ask) => ask.date))].sort()) {
      const onDay = asks.flatMap((ask, index) => (ask.date === day ? (ask.size === null && line.kind !== 'MADE_TO_MEASURE' ? sizes.filter((entry) => entry.size !== null && max0(entry.ordered - shipped(entry.size)) > 0).map((entry) => ({ index, size: entry.size! })) : [{ index, size: sizeOf(ask.size) }]) : []))
      const answers = await certificatesOn(db, { styleId: line.styleId, styleCode: line.style.code, asks: onDay.map((entry) => ({ key: entry.size, colourwayId: line.colourwayId, colourwayCode: line.colourway.code, size: entry.size })), market: where.market, destination: where.destination, day, now })
      for (const entry of onDay) {
        const answer = answers.get(entry.size)
        if (answer?.state === 'MISSING') refused.push({ path: `body/sizes/${entry.index}/date`, message: answer.words })
      }
    }
    if (refused.length > 0) throw new DomainError('conflict', `Only sizes a valid certificate covers through their date are promised: ${refused[0]!.message}`, refused)
    const plan = await db.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true } })
    // Nothing to write (every size asked has that date already): no command, the view as it is.
    const rows = (await readPromiseRows(db, [line.id])).get(line.id) ?? []
    const nothing = promisePlanOf({ asks, sizes: sizes.flatMap((entry) => (entry.size ? [entry.size] : [])), rows, typed: typedOf(line), reasonCode: body.reasonCode ?? null, reason: body.reason ?? null }).rows.length === 0
    return { context, line, site, today, planVersionId: plan?.id ?? null, nothing, view: nothing ? await lineView(db, context, line, site, now) : null }
  })
  const { line, site, today } = checked
  if (checked.nothing && !idempotencyKey) return { written: [], unchanged: asks.map((ask) => ask.size), replayed: false, view: checked.view! }
  const actorId = checked.context.actorId
  let outcome
  try {
    outcome = await command(caller, { name: 'planning.promise.record', idempotencyKey, input: { orderLineId, ...body } }, async (tools) => {
      const { tx, now } = tools
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order-promise', ${checked.context.tenantId}::uuid, ${line.id}::uuid), 0))`
      const rows = (await readPromiseRows(tx, [line.id])).get(line.id) ?? []
      const fresh = await tx.salesOrderLine.findUnique({ where: { id: line.id }, select: { promiseDate: true, order: { select: { status: true, promiseDate: true } } } })
      if (!fresh || !(PROMISABLE_ORDER_STATUSES as readonly string[]).includes(fresh.order.status)) throw new InvalidStateError(`${line.order.number} is ${fresh?.order.status ?? 'gone'}: nothing more is promised on it.`)
      const typed = fresh.promiseDate ?? fresh.order.promiseDate
      const planned = promisePlanOf({ asks, sizes: sizesOfLine(line).flatMap((entry) => (entry.size ? [entry.size] : [])), rows, typed: typed ? dayOf(typed) : null, reasonCode: body.reasonCode ?? null, reason: body.reason ?? null })
      const written: { id: string; size: string | null; promisedDate: string; kind: 'FIRST' | 'RE_PROMISE'; reasonCode: string | null; backfill: boolean; words: string }[] = []
      for (const row of planned.rows) {
        const id = newId()
        await tx.promiseRecord.create({
          data: {
            id,
            salesOrderLineId: line.id,
            partyId: line.partyId,
            size: row.size,
            promisedDate: new Date(`${row.promisedDate}T00:00:00.000Z`),
            kind: row.kind,
            reasonCode: row.reasonCode,
            reason: row.reason,
            // The date sales typed is the line's first promise: made when the order was (by whoever made it).
            promisedById: row.backfill ? (line.order.createdById ?? actorId) : actorId,
            promisedAt: row.backfill ? line.order.createdAt : now,
            siteId: row.backfill || !checked.planVersionId ? null : site.id,
            planVersionId: row.backfill ? null : checked.planVersionId,
            createdById: actorId,
          },
          select: { id: true },
        })
        written.push({ id, size: row.size, promisedDate: row.promisedDate, kind: row.kind, reasonCode: row.reasonCode, backfill: row.backfill, words: promiseRowWords(row, today) })
      }
      tools.audit({
        action: 'planning.promise.record',
        recordType: 'SalesOrder',
        recordId: line.orderId,
        companyId: line.companyId,
        siteId: site.id,
        before: { orderLineId: line.id, promises: asks.map((ask) => ({ size: ask.size, current: currentPromiseOf(ask.size, rows, typed ? dayOf(typed) : null)?.date ?? null })) },
        after: { orderLineId: line.id, rows: written.map((row) => ({ id: row.id, size: row.size, promisedDate: row.promisedDate, kind: row.kind, reasonCode: row.reasonCode, backfill: row.backfill })), unchanged: planned.unchanged },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      if (written.length > 0) {
        tools.emit({
          type: 'order_promise.recorded',
          subject: line.orderId,
          companyId: line.companyId,
          siteId: site.id,
          payload: { orderId: line.orderId, orderLineId: line.id, siteId: checked.planVersionId ? site.id : null, rows: written.map((row) => ({ size: row.size, promisedDate: row.promisedDate, kind: row.kind })) },
        })
      }
      return { written, unchanged: planned.unchanged }
    })
  } catch (error) {
    throw planningRefusal(error) ?? error
  }
  const view = await caller.withClient(async (db) => {
    const fresh = (await readLine(db, line.id))!
    return lineView(db, checked.context, fresh, site, serverClock.now())
  })
  return { written: outcome.result.written, unchanged: outcome.result.unchanged, replayed: outcome.replayed, view }
}
