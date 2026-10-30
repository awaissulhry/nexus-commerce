import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { formatNumber } from '@nexus/factory-domain/numbering/format'
import { yearOfScope } from '@nexus/factory-domain/numbering/kinds'
import {
  allOpenCells,
  cellProblems,
  clashProblems,
  duplicateRequests,
  lineProblems,
  MADE_TO_MEASURE_LATER,
  openSizes,
  revisionFor,
  type CellRequest,
  type CellTarget,
} from '@nexus/factory-domain/production/work-orders/cells'
import { daysLate, OPEN_STATUSES, type WorkOrderKind, type WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { assertMay, officeContextOf } from './access'
import {
  asDay,
  clearDraftSpec,
  dayOf,
  dayOrNull,
  hasSeries,
  lockOrderLines,
  readOrderLines,
  readReleasedRevision,
  readWorkOrder,
  REVISION_COLUMNS,
  SITE_COLUMNS,
  STYLE_COLUMNS,
  type Header,
  type LineRow,
  type Reader,
  type RevisionRow,
} from './store'
import { progressTotalsOf, workOrderView, type WorkOrderView } from './views'

/**
 * The office's work orders (B-W1-38; MES-001, MES-002, MES-007, MES-305; A2 SCR-069, SCR-070): the list, the record,
 * a DRAFT made from sales order lines (numbered from the company's WORK_ORDER series), its cells and revision while it
 * is a DRAFT, its due date, priority and note. The release is ./release, the other moves ./moves, the comparison with
 * today's master ./compare. Every write is one command(): a draft's edits name the work order as the record (its version
 * bump locks the row), the cells of one order line are serialised by an advisory lock per line, and what is still open
 * on a line is read under those locks.
 */

export const todayNow = (): BusinessDate => businessDate(serverClock.now())
export const todayOfCommand = (tools: Pick<CommandTools, 'now'>): BusinessDate => businessDate(tools.now)

// ---- reading ------------------------------------------------------------------------------------------------------------

/** The work order the office may see (else 404) and act on with `permission` (else 403). */
export async function officeWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission = WORKORDERS_VIEW): Promise<Header> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readWorkOrder(client, workOrderId))
  assertMay(context, permission, row)
  return row!
}

export async function getWorkOrder(caller: CommandCaller, workOrderId: string): Promise<{ workOrder: WorkOrderView }> {
  const row = await officeWorkOrder(caller, workOrderId)
  return { workOrder: await caller.withClient((client) => workOrderView(client, row, todayNow())) }
}

export interface ListQuery {
  readonly status?: WorkOrderStatus | undefined
  /** B-W2a-12: one kind (a size run, made to measure, a repair). */
  readonly kind?: WorkOrderKind | undefined
  readonly styleId?: string | undefined
  readonly salesOrderId?: string | undefined
  readonly siteId?: string | undefined
  readonly late?: boolean | undefined
  /** Not finished yet: DRAFT, RELEASED or IN_PROGRESS (the list's default view). */
  readonly open?: boolean | undefined
  /** Part of the number, the batch number, or the style's code or name (any case). */
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The list's filters as one where (the list and its counts read the same rows). */
function listWhere(context: ReturnType<typeof officeContextOf>, query: Omit<ListQuery, 'cursor' | 'limit'>, today: BusinessDate): Prisma.WorkOrderWhereInput {
  const q = query.q?.trim()
  return {
    AND: [
      scopeWhere(actorOf(context), WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
      query.status ? { status: query.status } : {},
      query.kind ? { kind: query.kind } : {},
      query.open ? { status: { in: [...OPEN_STATUSES] } } : {},
      query.styleId ? { styleId: query.styleId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.salesOrderId ? { sizes: { some: { salesOrderLine: { orderId: query.salesOrderId } } } } : {},
      query.late ? { status: { in: [...OPEN_STATUSES] }, dueDate: { lt: asDay(today) } } : {},
      q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { batchNumber: { contains: q, mode: 'insensitive' } },
              { style: { code: { contains: q, mode: 'insensitive' } } },
              { style: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  }
}

/** The work orders the caller may see (its companies and sites), newest first, with SCR-069's filters (MES-305). */
export async function listWorkOrders(caller: CommandCaller, query: ListQuery) {
  const context = officeContextOf(caller)
  const today = todayNow()
  const where: Prisma.WorkOrderWhereInput = { AND: [listWhere(context, query, today), query.cursor ? { id: { lt: query.cursor } } : {}] }
  const rows = await caller.withClient((client) =>
    client.workOrder.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        number: true,
        batchNumber: true,
        status: true,
        kind: true,
        version: true,
        companyId: true,
        siteId: true,
        dueDate: true,
        priority: true,
        releasedAt: true,
        createdAt: true,
        site: { select: { code: true } },
        style: { select: { id: true, code: true, name: true } },
        styleRevision: { select: { revision: true } },
        sizes: { select: { quantity: true, colourway: { select: { code: true } }, salesOrderLine: { select: { order: { select: { id: true, number: true, party: { select: { legalName: true, tradeName: true } } } } } } } },
      },
    }),
  )
  const page = rows.slice(0, query.limit)
  // Progress per row (SCR-069): the record's own counts, summed (null for a draft).
  const progress = await caller.withClient(async (client) => {
    const totals = new Map<string, Awaited<ReturnType<typeof progressTotalsOf>>>()
    for (const row of page) totals.set(row.id, await progressTotalsOf(client, { id: row.id, siteId: row.siteId, styleId: row.style.id, status: row.status }))
    return totals
  })
  return {
    workOrders: page.map((row) => {
      const orders = new Map(row.sizes.map((cell) => [cell.salesOrderLine.order.id, cell.salesOrderLine.order]))
      const dueDate = dayOrNull(row.dueDate)
      return {
        id: row.id,
        number: row.number,
        batchNumber: row.batchNumber,
        status: row.status,
        kind: row.kind,
        version: row.version,
        companyId: row.companyId,
        siteId: row.siteId,
        siteCode: row.site.code,
        styleId: row.style.id,
        styleCode: row.style.code,
        styleName: row.style.name,
        revision: row.styleRevision?.revision ?? null,
        colourways: [...new Set(row.sizes.map((cell) => cell.colourway.code))].sort(),
        orders: [...orders.values()].map((order) => ({ id: order.id, number: order.number, partyName: order.party.tradeName ?? order.party.legalName })),
        cells: row.sizes.length,
        pieces: row.sizes.reduce((sum, cell) => sum + cell.quantity, 0),
        progress: progress.get(row.id) ?? null,
        dueDate,
        daysLate: daysLate(row.status, dueDate, today),
        priority: row.priority,
        releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
        createdAt: toUtcIso(row.createdAt),
      }
    }),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  }
}

/**
 * How many work orders the caller may see per state, for the list's tiles (SCR-069 "Work order tiles"; the floor's
 * tiles, SCR-073): draft, released not started, in progress, completed, and late (open past its due date). The same
 * scope as the list (its companies and sites; one site when asked).
 */
export async function countWorkOrders(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeContextOf(caller)
  const today = todayNow()
  return caller.withClient(async (client) => {
    const byStatus = await client.workOrder.groupBy({ by: ['status'], where: listWhere(context, { siteId: query.siteId }, today), _count: { _all: true } })
    const of = (status: WorkOrderStatus) => byStatus.find((row) => row.status === status)?._count._all ?? 0
    const late = await client.workOrder.count({ where: listWhere(context, { siteId: query.siteId, late: true }, today) })
    return { counts: { draft: of('DRAFT'), released: of('RELEASED'), inProgress: of('IN_PROGRESS'), completed: of('COMPLETED'), open: of('DRAFT') + of('RELEASED') + of('IN_PROGRESS'), late, onHold: of('ON_HOLD') } }
  })
}

/** The open lines of a sales order a new work order can be made from (design 02 "New work order"), and its next number. */
export async function openLines(caller: CommandCaller, salesOrderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const order = isUuid(salesOrderId) ? await client.salesOrder.findUnique({ where: { id: salesOrderId }, select: { id: true, number: true, status: true, companyId: true } }) : null
    if (!order || !can(actorOf(context), WORKORDERS_VIEW, { companyId: order.companyId })) throw new NotFoundError('Sales order not found.')
    const ids = (await client.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true }, orderBy: { seq: 'asc' } })).map((line) => line.id)
    const lines = await readOrderLines(client, ids)
    const styles = await client.style.findMany({ where: { id: { in: [...new Set([...lines.values()].map((line) => line.styleId))] } }, select: { id: true, code: true, name: true } })
    const styleOf = new Map(styles.map((style) => [style.id, style]))
    return {
      salesOrder: { id: order.id, number: order.number, status: order.status },
      numberPreview: await numberPreview(client, order.companyId),
      lines: ids.flatMap((id) => {
        const line = lines.get(id)
        if (!line) return []
        return [
          {
            id: line.id,
            seq: line.seq,
            kind: line.kind,
            styleId: line.styleId,
            styleCode: styleOf.get(line.styleId)?.code ?? '',
            styleName: styleOf.get(line.styleId)?.name ?? '',
            styleRevisionId: line.styleRevisionId,
            colourwayId: line.colourwayId,
            colourwayCode: line.colourwayCode,
            siteId: line.siteId,
            madeToMeasure: line.kind === 'MADE_TO_MEASURE',
            sizes: openSizes(line),
          },
        ]
      }),
    }
  })
}

/** The number the next work order of the company gets (the only active WORK_ORDER series), or null. */
async function numberPreview(db: Reader, companyId: string): Promise<string | null> {
  const series = await db.numberSeries.findMany({ where: { companyId, kind: 'WORK_ORDER', status: 'ACTIVE' }, select: { pattern: true, nextValue: true, scopeKey: true }, orderBy: { scopeKey: 'desc' } })
  const newest = series[0]
  if (!newest || new Set(series.map((row) => row.pattern)).size > 1) return null
  return formatNumber(newest.pattern, { value: newest.nextValue, year: yearOfScope(newest.scopeKey) })
}

// ---- the lines a request names --------------------------------------------------------------------------------------

/** The named lines, each one the caller may see (else 404); a made-to-measure one is refused (409, deferred). */
async function linesFor(caller: CommandCaller, lineIds: readonly string[]): Promise<Map<string, LineRow>> {
  const context = officeContextOf(caller)
  const lines = await caller.withClient((client) => readOrderLines(client, lineIds))
  for (const lineId of lineIds) {
    const line = lines.get(lineId)
    if (!line || !can(actorOf(context), WORKORDERS_VIEW, { companyId: line.companyId })) throw new NotFoundError('Sales order line not found.')
  }
  if ([...lines.values()].some((line) => line.kind === 'MADE_TO_MEASURE')) throw new ConflictError(MADE_TO_MEASURE_LATER)
  return lines
}

/** The requests' problems against the lines as read under their locks: 400 with every one. */
function assertCells(requests: readonly (CellRequest & { index: number })[], lines: ReadonlyMap<string, LineRow>, target: CellTarget, path: string): void {
  const problems: Issue[] = []
  const lineChecked = new Set<string>()
  for (const request of requests) {
    const line = lines.get(request.salesOrderLineId)!
    const at = `${path}/${request.index}`
    if (!lineChecked.has(line.id)) {
      problems.push(...lineProblems(line, target, at))
      lineChecked.add(line.id)
    }
    problems.push(...cellProblems(line, target, request.size, request.quantity, at))
  }
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These cells cannot be made on this work order.', problems)
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

const changedEvent = (tools: CommandTools, workOrder: Pick<Header, 'id' | 'number' | 'companyId' | 'siteId'>, changes: ('cells' | 'revision' | 'details')[], cells: { quantity: number }[]) =>
  tools.emit({
    type: 'workorder.changed',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: { workOrderId: workOrder.id, number: workOrder.number, changes, cells: cells.length, pieces: cells.reduce((sum, cell) => sum + cell.quantity, 0) },
  })

// ---- create -------------------------------------------------------------------------------------------------------------

export interface CreateInput {
  readonly siteId?: string | undefined
  readonly styleRevisionId?: string | undefined
  readonly dueDate?: BusinessDate | undefined
  readonly priority?: number | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly { readonly salesOrderLineId: string; readonly sizes?: readonly { readonly size: string; readonly quantity: number }[] | undefined }[]
}

/** A revision of this style a work order may be made to: a DRAFT or the RELEASED one (an OBSOLETE one never). */
async function revisionOf(db: Reader, styleId: string, revisionId: string, path: string): Promise<RevisionRow> {
  const revision = await db.styleRevision.findUnique({ where: { id: revisionId }, select: REVISION_COLUMNS })
  if (!revision || revision.styleId !== styleId) throw new ValidationError('Not a revision of the style.', [{ path, message: 'Expected a revision of the order lines\' style.' }])
  if (revision.status === 'OBSOLETE') throw new ValidationError(`Revision ${revision.revision} is OBSOLETE.`, [{ path, message: 'Expected the RELEASED revision (or a DRAFT one, released before the work order).' }])
  return revision
}

/**
 * workorders.manage: a DRAFT work order of one style at one site from sales order lines of its company (MES-001,
 * MES-002), numbered from the company's WORK_ORDER series. Each line gives the sizes named, or every size still open.
 * Site: the one asked, else the lines' own, else the company's only active plant. Revision: the one asked, else the one
 * the lines fix, else the style's released one. Due date: the earliest promise (or request) of its lines and orders;
 * priority: the highest.
 */
export async function createWorkOrder(caller: CommandCaller, body: CreateInput, idempotencyKey?: string): Promise<{ workOrder: WorkOrderView }> {
  const context = officeContextOf(caller)
  const lineIds = body.lines.map((line) => line.salesOrderLineId)
  const named = new Set<string>()
  body.lines.forEach((line, index) => {
    if (named.has(line.salesOrderLineId)) throw new ValidationError('An order line is named twice.', [{ path: `body/lines/${index}/salesOrderLineId`, message: 'Name each order line once.' }])
    named.add(line.salesOrderLineId)
  })
  const lines = await linesFor(caller, lineIds)
  const first = lines.get(lineIds[0]!)!

  const plan = await caller.withClient(async (client) => {
    const style = await client.style.findUniqueOrThrow({ where: { id: first.styleId }, select: STYLE_COLUMNS })
    const lineSites = new Set([...lines.values()].flatMap((line) => (line.siteId ? [line.siteId] : [])))
    let siteId = body.siteId ?? (lineSites.size === 1 ? [...lineSites][0]! : null)
    if (!siteId && lineSites.size === 0) {
      const plants = await client.site.findMany({ where: { companyId: first.companyId, kind: 'PLANT', status: 'ACTIVE' }, select: { id: true } })
      if (plants.length === 1) siteId = plants[0]!.id
    }
    if (!siteId) throw new ValidationError('Name the site that makes it.', [{ path: 'body/siteId', message: 'Required: the lines name no single site and the company has several plants.' }])
    const site = isUuid(siteId) ? await client.site.findUnique({ where: { id: siteId }, select: SITE_COLUMNS }) : null
    if (!site || site.companyId !== first.companyId || site.kind !== 'PLANT' || site.status !== 'ACTIVE') {
      throw new ValidationError("Not an active plant of the order's company.", [{ path: 'body/siteId', message: "Expected an active plant (site kind PLANT) of the order lines' company." }])
    }
    assertMay(context, WORKORDERS_MANAGE, { companyId: site.companyId, siteId: site.id }, 'Sales order line')
    const asked = body.styleRevisionId ? await revisionOf(client, style.id, body.styleRevisionId, 'body/styleRevisionId') : null
    const released = await readReleasedRevision(client, style.id)
    const chosen = revisionFor(asked?.id ?? null, [...lines.values()], released?.id ?? null)
    if (chosen.problem) throw new ValidationError(chosen.problem, [{ path: 'body/styleRevisionId', message: chosen.problem }])
    const orders = await client.salesOrder.findMany({ where: { id: { in: [...new Set([...lines.values()].map((line) => line.orderId))] } }, select: { id: true, priority: true, requestedDate: true, promiseDate: true } })
    return { style, site, revisionId: chosen.revisionId, orders }
  })
  const { style, site, revisionId, orders } = plan
  const orderOf = new Map(orders.map((order) => [order.id, order]))
  const dues = [...lines.values()].flatMap((line) => {
    const order = orderOf.get(line.orderId)
    const due = line.promiseDate ?? line.requestedDate ?? order?.promiseDate ?? order?.requestedDate ?? null
    return due ? [dayOf(due)] : []
  })
  const dueDate = body.dueDate ?? (dues.length > 0 ? [...dues].sort()[0]! : null)
  const priority = body.priority ?? Math.max(0, ...[...lines.values()].map((line) => line.priority ?? orderOf.get(line.orderId)?.priority ?? 0))
  const target: CellTarget = { companyId: site.companyId, siteId: site.id, styleId: style.id, styleSizes: style.sizes, styleRevisionId: revisionId }

  const { result } = await command(caller, { name: 'workorders.create', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    await lockOrderLines(tx, context.tenantId, lineIds)
    const current = await readOrderLines(tx, lineIds)
    const requests: (CellRequest & { index: number; colourwayId: string })[] = []
    body.lines.forEach((entry, index) => {
      const line = current.get(entry.salesOrderLineId)!
      const asked = entry.sizes ? entry.sizes.map((size) => ({ salesOrderLineId: line.id, size: size.size, quantity: size.quantity })) : allOpenCells(line)
      for (const request of asked) requests.push({ ...request, index, colourwayId: line.colourwayId })
    })
    const problems = [...duplicateRequests(requests, 'body/cells'), ...clashProblems(requests, [], 'body/cells')]
    if (problems.length > 0) throw new ValidationError('These cells cannot be made on one work order.', problems)
    assertCells(requests, current, target, 'body/lines')
    const cells = requests.filter((request) => request.quantity > 0)
    if (cells.length === 0) throw new ValidationError('Nothing is open to make on these order lines.', [{ path: 'body/lines', message: 'Every size of these lines is already on work orders.' }])
    if (!(await hasSeries(tx, site.companyId, 'WORK_ORDER'))) {
      throw new InvalidStateError('The company has no active work order number series: an admin sets one up under Numbering (kind WORK_ORDER).')
    }

    const id = newId()
    const number = await allocateNumber(tools, { companyId: site.companyId, kind: 'WORK_ORDER' }, { type: 'WorkOrder', id })
    await tx.workOrder.create({
      data: {
        id,
        companyId: site.companyId,
        siteId: site.id,
        number: number.formatted,
        kind: 'SIZE_GRID',
        styleId: style.id,
        styleRevisionId: revisionId,
        dueDate: dueDate ? asDay(dueDate) : null,
        priority,
        note: blankToNull(body.note),
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    const rows = cells.map((cell) => {
      const line = current.get(cell.salesOrderLineId)!
      return { id: newId(), siteId: site.id, workOrderId: id, styleId: style.id, colourwayId: line.colourwayId, size: cell.size, quantity: cell.quantity, salesOrderLineId: line.id, partyId: line.partyId, createdById: actorIdOf(tools) }
    })
    await tx.workOrderSize.createMany({ data: rows })
    const salesOrderIds = [...new Set(cells.map((cell) => current.get(cell.salesOrderLineId)!.orderId))]
    const pieces = rows.reduce((sum, row) => sum + row.quantity, 0)
    tools.audit({
      recordType: 'WorkOrder',
      recordId: id,
      companyId: site.companyId,
      siteId: site.id,
      after: {
        number: number.formatted,
        status: 'DRAFT',
        kind: 'SIZE_GRID',
        styleId: style.id,
        styleRevisionId: revisionId,
        dueDate,
        priority,
        cells: rows.map((row) => ({ id: row.id, salesOrderLineId: row.salesOrderLineId, colourwayId: row.colourwayId, size: row.size, quantity: row.quantity })),
      },
    })
    tools.emit({ type: 'workorder.created', subject: id, companyId: site.companyId, siteId: site.id, payload: { workOrderId: id, number: number.formatted, siteId: site.id, styleId: style.id, salesOrderIds, cells: rows.length, pieces } })
    return { workOrder: await workOrderView(tx, (await readWorkOrder(tx, id))!, todayOfCommand(tools)) }
  })
  return result
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

// ---- a draft's cells ------------------------------------------------------------------------------------------------------

/** A command on the work order: its version guards it and its bump locks the row. */
export async function onWorkOrder<Result>(
  caller: CommandCaller,
  workOrder: Header,
  spec: { name: `workorders.${string}`; idempotencyKey: string | undefined; input: unknown; version: number | undefined },
  work: (tools: CommandTools) => Promise<Result>,
): Promise<Result> {
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'WorkOrder', id: workOrder.id, expectedVersion: spec.version } }, work)
  return result
}

export interface CellsInput {
  readonly version?: number | undefined
  readonly cells: readonly { readonly salesOrderLineId: string; readonly size: string; readonly quantity: number }[]
}

/**
 * workorders.manage: sets cells of a DRAFT (SizeGridEditor: per cell, paste): each named line and size gets its pieces;
 * 0 removes the cell; a line not on the work order yet joins it (same style, company, site). The draft's stored
 * operations and planned materials, if any, are removed: the release writes them from the revision.
 */
export async function setCells(caller: CommandCaller, workOrderId: string, body: CellsInput, idempotencyKey?: string): Promise<{ workOrder: WorkOrderView }> {
  const context = officeContextOf(caller)
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  if (workOrder.status !== 'DRAFT') throw new InvalidStateError(`Work order ${workOrder.number} is ${workOrder.status}; its cells are frozen (a change is a new work order).`)
  // B-W2a-12: a repair's one garment comes from its repair order.
  if (workOrder.kind === 'REPAIR') throw new InvalidStateError(`Work order ${workOrder.number} repairs one garment of its repair order: its cell does not change (a different garment is a new repair work order).`)
  const lineIds = [...new Set(body.cells.map((cell) => cell.salesOrderLineId))]
  await linesFor(caller, lineIds)
  const requests = body.cells.map((cell, index) => ({ ...cell, index }))
  const duplicates = duplicateRequests(requests, 'body/cells')
  if (duplicates.length > 0) throw new ValidationError('A cell is named twice.', duplicates)

  return onWorkOrder(caller, workOrder, { name: 'workorders.setCells', idempotencyKey, input: { workOrderId, ...body }, version: body.version }, async (tools) => {
    const { tx } = tools
    const current = await lockedDraft(tx, workOrder.id, 'its cells change')
    const style = await tx.style.findUniqueOrThrow({ where: { id: current.styleId }, select: STYLE_COLUMNS })
    await lockOrderLines(tx, context.tenantId, lineIds)
    const lines = await readOrderLines(tx, lineIds, current.id)
    const held = await tx.workOrderSize.findMany({ where: { workOrderId: current.id }, select: { id: true, salesOrderLineId: true, colourwayId: true, size: true, quantity: true } })
    const target: CellTarget = { companyId: current.companyId, siteId: current.siteId, styleId: current.styleId, styleSizes: style.sizes, styleRevisionId: current.styleRevisionId }
    const withColour = requests.map((request) => ({ ...request, colourwayId: lines.get(request.salesOrderLineId)!.colourwayId }))
    const sameCell = (cell: { salesOrderLineId: string; size: string }, request: { salesOrderLineId: string; size: string }) => cell.salesOrderLineId === request.salesOrderLineId && cell.size === request.size
    const others = held.filter((cell) => !requests.some((request) => sameCell(cell, request)))
    const clashes = clashProblems(withColour, others, 'body/cells')
    if (clashes.length > 0) throw new ValidationError(clashes[0]!.message, clashes)
    assertCells(requests, lines, target, 'body/cells')

    const cleared = await clearDraftSpec(tx, current.id)
    const changes: { cellId: string; before: number; after: number; size: string; salesOrderLineId: string }[] = []
    for (const request of requests) {
      const line = lines.get(request.salesOrderLineId)!
      const cell = held.find((entry) => sameCell(entry, request))
      if (cell && request.quantity === 0) {
        await tx.workOrderSize.delete({ where: { id: cell.id }, select: { id: true } })
        changes.push({ cellId: cell.id, before: cell.quantity, after: 0, size: cell.size, salesOrderLineId: cell.salesOrderLineId })
      } else if (cell && request.quantity !== cell.quantity) {
        await tx.workOrderSize.update({ where: { id: cell.id }, data: { quantity: request.quantity, version: { increment: 1 } }, select: { id: true } })
        changes.push({ cellId: cell.id, before: cell.quantity, after: request.quantity, size: cell.size, salesOrderLineId: cell.salesOrderLineId })
      } else if (!cell && request.quantity > 0) {
        const cellId = newId()
        await tx.workOrderSize.create({
          data: { id: cellId, siteId: current.siteId, workOrderId: current.id, styleId: current.styleId, colourwayId: line.colourwayId, size: request.size, quantity: request.quantity, salesOrderLineId: line.id, partyId: line.partyId, createdById: actorIdOf(tools) },
          select: { id: true },
        })
        changes.push({ cellId, before: 0, after: request.quantity, size: request.size, salesOrderLineId: line.id })
      }
    }
    for (const change of changes) {
      tools.audit({
        action: 'workorders.setCell',
        recordType: 'WorkOrderSize',
        recordId: change.cellId,
        companyId: current.companyId,
        siteId: current.siteId,
        before: change.before === 0 ? undefined : { quantity: change.before, size: change.size, salesOrderLineId: change.salesOrderLineId },
        after: change.after === 0 ? undefined : { quantity: change.after, size: change.size, salesOrderLineId: change.salesOrderLineId },
      })
    }
    const cells = await tx.workOrderSize.findMany({ where: { workOrderId: current.id }, select: { quantity: true } })
    tools.audit({ recordType: 'WorkOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { cells: changes, draftSpecCleared: cleared } })
    changedEvent(tools, current, ['cells'], cells)
    return { workOrder: await workOrderView(tx, (await readWorkOrder(tx, current.id))!, todayOfCommand(tools)) }
  })
}

/** Inside the command: the work order is still a DRAFT (else 409 saying what it is). */
async function lockedDraft(tx: CommandTx, workOrderId: string, doing: string): Promise<Header> {
  const row = await readWorkOrder(tx, workOrderId)
  if (!row) throw new InvalidStateError('The work order is gone.')
  if (row.status !== 'DRAFT') throw new InvalidStateError(`Work order ${row.number} is ${row.status}; ${doing} only while it is a DRAFT.`)
  return row
}

// ---- details and revision ------------------------------------------------------------------------------------------------

export interface UpdateInput {
  readonly version?: number | undefined
  readonly dueDate?: BusinessDate | null | undefined
  readonly priority?: number | undefined
  readonly note?: string | null | undefined
  readonly styleRevisionId?: string | undefined
}

/**
 * workorders.manage: the due date and priority (until CLOSED or CANCELLED), the note (always), and the revision while
 * a DRAFT (a revision of its style, not OBSOLETE, the one its lines fix if they fix one; its stored draft spec, if any,
 * is removed first: the release writes it from the revision).
 */
export async function updateWorkOrder(caller: CommandCaller, workOrderId: string, body: UpdateInput, idempotencyKey?: string): Promise<{ workOrder: WorkOrderView }> {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  return onWorkOrder(caller, workOrder, { name: 'workorders.update', idempotencyKey, input: { workOrderId, ...body }, version: body.version }, async (tools) => {
    const { tx } = tools
    const current = (await readWorkOrder(tx, workOrder.id))!
    const final = current.status === 'CLOSED' || current.status === 'CANCELLED'
    if (final && (body.dueDate !== undefined || body.priority !== undefined)) throw new InvalidStateError(`Work order ${current.number} is ${current.status}; only its note changes.`)
    const changes: ('revision' | 'details')[] = []
    const data: Prisma.WorkOrderUncheckedUpdateInput = {}
    let cleared: { operations: number; materials: number } | null = null
    if (body.styleRevisionId !== undefined && body.styleRevisionId !== current.styleRevisionId) {
      if (current.status !== 'DRAFT') throw new InvalidStateError(`Work order ${current.number} is ${current.status}; its revision is frozen (a different specification is a new work order).`)
      // B-W2a-12: a repair's steps were chosen from its revision's routing.
      if (current.kind === 'REPAIR') throw new InvalidStateError(`Work order ${current.number} is a repair whose steps were chosen from its revision's routing: cancel it and make a new repair work order for another revision.`)
      const revision = await revisionOf(tx, current.styleId, body.styleRevisionId, 'body/styleRevisionId')
      const cellLines = await tx.workOrderSize.findMany({ where: { workOrderId: current.id }, select: { salesOrderLineId: true } })
      const fixed = await tx.salesOrderLine.findMany({ where: { id: { in: [...new Set(cellLines.map((cell) => cell.salesOrderLineId))] }, styleRevisionId: { not: null } }, select: { seq: true, styleRevisionId: true } })
      const other = fixed.find((line) => line.styleRevisionId !== revision.id)
      if (other) throw new ValidationError('An order line of this work order is ordered to another revision.', [{ path: 'body/styleRevisionId', message: `Line ${other.seq} fixes another revision of the style.` }])
      cleared = await clearDraftSpec(tx, current.id)
      data.styleRevisionId = revision.id
      changes.push('revision')
    }
    if (body.dueDate !== undefined) data.dueDate = body.dueDate === null ? null : asDay(body.dueDate)
    if (body.priority !== undefined) data.priority = body.priority
    if (body.note !== undefined) data.note = blankToNull(body.note)
    if (body.dueDate !== undefined || body.priority !== undefined || body.note !== undefined) changes.push('details')
    if (changes.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send a due date, priority, note or revision.' }])
    await tx.workOrder.update({ where: { id: current.id }, data, select: { id: true } })
    const before = { styleRevisionId: current.styleRevisionId, dueDate: dayOrNull(current.dueDate), priority: current.priority, note: current.note }
    const after = (await readWorkOrder(tx, current.id))!
    tools.audit({
      recordType: 'WorkOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before,
      after: { styleRevisionId: after.styleRevisionId, dueDate: dayOrNull(after.dueDate), priority: after.priority, note: after.note, ...(cleared ? { draftSpecCleared: cleared } : {}) },
    })
    const cells = await tx.workOrderSize.findMany({ where: { workOrderId: current.id }, select: { quantity: true } })
    changedEvent(tools, current, changes, cells)
    return { workOrder: await workOrderView(tx, after, todayOfCommand(tools)) }
  })
}

