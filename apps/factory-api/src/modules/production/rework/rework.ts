import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { LabelLanguage } from '@nexus/factory-domain/labels/model'
import { PRODUCTION_REWORK } from '@nexus/factory-domain/production/rework/permissions'
import { moveRefusal, openedFrom, openRefusal, statusAfter, type ReworkMove, type ReworkRefusal, type ReworkStatus } from '@nexus/factory-domain/production/rework/rules'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { assertFloorReady, printTickets, ticketPrinter, type TicketAnswer } from '../bundles/bundles'
import { withTicketCodes } from '../bundles/codes'
import { splitInCommand } from '../bundles/split'
import { readHeader as readBundleHeader } from '../bundles/store'
import { lockRework, readBundleLive, readOperations, readOrder, readRework, readReworkReasons, readReworksOfScan, readSourceScan, REWORK_COLUMNS, reworkViews, type OrderRow, type Reader } from './store'

/**
 * The rework loop (B-W2a-13; MES-126; design production.scrap "Scrap & rework", floor.operation "Rework"): garments of a
 * cell sent back to an operation to be made again, and back into the flow. Floor (its own site) and office, with
 * production.rework; the office also reads it with production.scrap.view. Each write is ONE command() with an
 * Idempotency-Key; the rules are factory-domain production/rework/rules; a refusal is a 409 with `refusal/<CODE>`; the
 * …_production_w2a_guards ReworkOrder trigger is the last word.
 *
 *   open    the work order's issue lock (a scan takes it shared: the flow does not change under a scan) → the source
 *           scan (its rework count, less the rework opened from it already; a voided scan sends nothing back) or the
 *           cell and bundle named → the rules → when the garments are part of a bundle, a child bundle is split off for
 *           them in the same command (bundles/split.ts splitInCommand, a ticket of its own; not while the work order is
 *           ON_HOLD: the gate holds new bundles, so the rework names the bundle) → the row (no worker named: a floor
 *           rework names nobody, an office one its user) → audits → production.rework_opened. The child's ticket prints
 *           after the commit.
 *   moves   start (→ IN_PROGRESS), done (→ DONE with good + scrapped = its garments), cancel (→ CANCELLED with the
 *           reason): the issue lock, the row FOR UPDATE, the version, the rules (a held work order: in words) →
 *           production.rework_moved. A DONE rework's good garments count as passed at the operation the fault was
 *           found at (bundles/flow.ts): the scans take them on from there.
 */

export class ReworkRefusedError extends ConflictError {
  override name = 'ReworkRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: ReworkRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}
const refused = (refusal: ReworkRefusal): never => {
  throw new ReworkRefusedError(refusal)
}

type Worker = FloorContext | OfficeContext

function workerOf(caller: Pick<CommandCaller, 'factoryContext'>): Worker {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new ForbiddenError()
  return context
}

/** May the caller act on (or read) this work order's rework? A floor device: its own site, production.rework. */
function mayRework(context: Worker, workOrder: { readonly companyId: string; readonly siteId: string }, read = false): boolean {
  if (context.audience === 'floor') return context.siteId === workOrder.siteId && can(actorOf(context), PRODUCTION_REWORK, workOrder)
  return can(actorOf(context), PRODUCTION_REWORK, workOrder) || (read && can(actorOf(context), PRODUCTION_SCRAP_VIEW, workOrder))
}

const postedBy = (context: Worker) => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')

// ---- open --------------------------------------------------------------------------------------------------------------------

export interface OpenInput {
  /** The scan (a REPORT or CORRECTION with rework) whose rework count sends them back; or the cell and bundle by hand. */
  readonly sourceScanId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly workOrderSizeId?: string | undefined
  readonly bundleId?: string | null | undefined
  /** By hand: where the fault was found (null: outside the routing, a final check). From a scan: the scan's operation. */
  readonly foundAtOperationId?: string | null | undefined
  readonly reworkAtOperationId: string
  readonly quantity: number
  /** A REWORK reason; from a scan with one rework reason, that one by default. */
  readonly reasonCode?: string | undefined
  readonly description?: string | undefined
  /** The record behind it (a nonconformance, a hold): both or neither. */
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly note?: string | undefined
  /** False: name the bundle as it is, even when the garments are only part of it (default: split them off). */
  readonly split?: boolean | undefined
  readonly clientEventId?: string | undefined
  readonly printerId?: string | null | undefined
  readonly language?: LabelLanguage | undefined
}

const bodyIssue = (path: string, message: string) => new ValidationError(message, [{ path: `body/${path}`, message }])

/** The work order the open names (by its scan or directly), checked for the caller. */
async function openTarget(caller: CommandCaller, body: OpenInput): Promise<OrderRow> {
  const context = workerOf(caller)
  const workOrderId = body.sourceScanId
    ? (await caller.withClient((client) => readSourceScan(client, body.sourceScanId!)))?.workOrderId
    : body.bundleId
      ? (await caller.withClient((client) => readBundleLive(client, body.bundleId!)))?.workOrderId
      : body.workOrderId
  if (!workOrderId) {
    if (body.sourceScanId) throw new NotFoundError('Scan not found.')
    if (body.bundleId) throw new NotFoundError('Bundle not found.')
    throw bodyIssue('workOrderId', 'Name the scan whose rework count sends the garments back, or the work order and cell.')
  }
  const order = await caller.withClient((client) => readOrder(client, workOrderId))
  if (!order || !mayRework(context, order)) throw new NotFoundError('Work order not found.')
  if (body.workOrderId && body.workOrderId !== order.id) throw bodyIssue('workOrderId', 'The scan or bundle named is of another work order.')
  return order
}

async function openInCommand(tools: CommandTools, order: OrderRow, body: OpenInput, take: (tx: CommandTools['tx'], count: number) => Promise<string[]>) {
  const context = tools.context as Worker
  const { tx } = tools
  await lockWorkOrderIssues(tx, context.tenantId, order.id)
  const workOrder = (await readOrder(tx, order.id))!
  const operations = await readOperations(tx, workOrder.id)
  const opOf = (id: string | null | undefined) => (id ? (operations.find((operation) => operation.id === id) ?? null) : null)

  // The source scan, or the cell and bundle named.
  const source = body.sourceScanId ? await readSourceScan(tx, body.sourceScanId) : null
  if (body.sourceScanId && (!source || source.workOrderId !== workOrder.id)) throw new NotFoundError('Scan not found.')
  const bundleId = source ? source.bundleId : (body.bundleId ?? null)
  const bundle = bundleId ? await readBundleLive(tx, bundleId) : null
  if (bundleId && (!bundle || bundle.workOrderId !== workOrder.id)) throw new NotFoundError('Bundle not found.')
  const cellId = bundle?.workOrderSizeId ?? body.workOrderSizeId
  if (!cellId) throw bodyIssue('workOrderSizeId', 'Name the cell (colourway and size) of the garments, or their bundle.')
  const cell = await tx.workOrderSize.findUnique({ where: { id: cellId }, select: { id: true, workOrderId: true } })
  if (!cell || cell.workOrderId !== workOrder.id) throw bodyIssue('workOrderSizeId', 'Not a cell of this work order.')
  const foundAt = source ? opOf(source.workOrderOperationId) : opOf(body.foundAtOperationId)
  if (!source && body.foundAtOperationId && !foundAt) throw bodyIssue('foundAtOperationId', 'Not an operation of this work order.')
  const reworkAt = opOf(body.reworkAtOperationId)
  if (!reworkAt) throw bodyIssue('reworkAtOperationId', 'Not an operation of this work order.')
  if ((body.recordType === undefined) !== (body.recordId === undefined)) throw bodyIssue('recordType', 'Name the record behind it as type and id, or neither.')

  const reasons = (await readReworkReasons(tx)).map((row) => row.code)
  const reasonCode = body.reasonCode ?? (source && source.lines.length === 1 ? source.lines[0]!.reasonCode : undefined)
  if (!reasonCode) throw bodyIssue('reasonCode', 'Name the rework reason.')
  // By hand, with a bundle: the next scanned operation after the fault's must not have taken the bundle already.
  let nextReported: { seq: number } | null = null
  if (!source && bundle && foundAt) {
    const next = operations.find((operation) => operation.scanRequired && operation.seq > foundAt.seq)
    if (next) {
      const standing = await tx.operationScan.findMany({ where: { bundleId: bundle.id, workOrderOperationId: next.id, kind: { in: ['REPORT', 'CORRECTION'] } }, select: { id: true } })
      const voided = standing.length === 0 ? 0 : await tx.operationScan.count({ where: { correctsId: { in: standing.map((row) => row.id) } } })
      if (standing.length > voided) nextReported = { seq: next.seq }
    }
  }
  const refusal = openRefusal({
    workOrder,
    quantity: body.quantity,
    reasonCode,
    activeReasons: reasons,
    foundAt,
    reworkAt,
    source: source ? { kind: source.kind, voided: source.voided, reworkQuantity: source.reworkQuantity, opened: openedFrom(await readReworksOfScan(tx, source.id), source.id) } : null,
    bundle: bundle ? { code: bundle.code, status: bundle.status, live: bundle.live, sameCell: bundle.workOrderSizeId === cell.id } : null,
    nextReported,
  })
  if (refusal) refused(refusal)

  // A part of a bundle goes off into a child bundle of its own (not while the work order is held: the gate holds bundles).
  let carrier = bundle?.id ?? null
  let split: Awaited<ReturnType<typeof splitInCommand>> | null = null
  if (bundle && body.split !== false && body.quantity < bundle.live && workOrder.status !== 'ON_HOLD') {
    split = await splitInCommand(tools, { parentId: bundle.id, quantity: body.quantity, reason: 'REWORK', note: body.description ?? null, clientEventId: body.clientEventId, language: body.language, codes: { take } })
    carrier = split.child.id
  }

  const id = newId()
  const data: Prisma.ReworkOrderUncheckedCreateInput = {
    id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    workOrderId: workOrder.id,
    workOrderSizeId: cell.id,
    bundleId: carrier,
    sourceScanId: source?.id ?? null,
    foundAtOperationId: foundAt?.id ?? null,
    reworkAtOperationId: reworkAt.id,
    quantity: body.quantity,
    reasonCode,
    description: body.description?.trim() || null,
    recordType: body.recordType ?? null,
    recordId: body.recordId ?? null,
    note: body.note?.trim() || null,
    createdAt: tools.now,
    updatedAt: tools.now,
    // No worker named (Statuto dei Lavoratori art. 4): a floor rework names nobody, an office one its user.
    createdById: context.audience === 'office' ? context.actorId : null,
  }
  await tx.reworkOrder.create({ data, select: { id: true } })
  const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  tools.audit({ action: 'production.openRework', recordType: 'ReworkOrder', recordId: id, ...scope, after: { ...data, createdAt: undefined, updatedAt: undefined, split: split ? { bundleId: split.child.id, code: split.child.code } : null } })
  tools.audit({ action: 'production.openRework', recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after: { reworkId: id, quantity: body.quantity, reasonCode, bundleId: carrier } })
  tools.emit({
    type: 'production.rework_opened',
    subject: workOrder.id,
    ...scope,
    payload: {
      workOrderId: workOrder.id,
      number: workOrder.number,
      reworkId: id,
      workOrderSizeId: cell.id,
      bundleId: carrier,
      sourceScanId: source?.id ?? null,
      foundAtOperationId: foundAt?.id ?? null,
      reworkAtOperationId: reworkAt.id,
      quantity: body.quantity,
      split: split !== null,
      postedBy: postedBy(context),
    },
  })
  const [view] = await reworkViews(tx, [(await readRework(tx, id))!], { office: context.audience === 'office' })
  return { rework: view!, split: split ? { bundle: split.view, parent: split.parent } : null, ticket: split?.ticket ?? null }
}

/** POST /production/rework: one command (with the split when there is one), then the child's ticket. */
export async function openRework(caller: CommandCaller, body: OpenInput, idempotencyKey?: string) {
  const context = workerOf(caller)
  const order = await openTarget(caller, body)
  const header = (await caller.withClient((client) => readBundleHeader(client, order.id)))!
  // The floor's work needs its site's floor ready (the privacy gate), as a split from the bundles screen does.
  if (context.audience === 'floor') await assertFloorReady(caller, context, order.siteId)
  // The child's ticket printer, checked before anything is made (only when a split may happen; a problem prints as PDF).
  const target = body.split !== false && (body.sourceScanId || body.bundleId) ? await ticketPrinter(caller, header, body.printerId).catch((error: unknown) => ({ printer: null, problem: error instanceof Error ? error.message : 'No label printer.' })) : null
  const outcome = await withTicketCodes(caller, (codes) =>
    command(caller, { name: 'production.openRework', idempotencyKey, input: body }, (tools) => openInCommand(tools, order, body, (tx, count) => codes.take(tx, count))),
  )
  const { ticket, ...opened } = outcome.result
  const printed: TicketAnswer | null = ticket ? ((await printTickets(caller, target ?? { printer: null, problem: 'No label printer is chosen: print the ticket as PDF.' }, [ticket]))[0] ?? null) : null
  return { ...opened, ticket: printed, replayed: outcome.replayed }
}

// ---- moves -------------------------------------------------------------------------------------------------------------------------

export interface MoveInput {
  readonly version: number
  readonly good?: number | undefined
  readonly scrap?: number | undefined
  /** cancel: why (required). */
  readonly reason?: string | undefined
  readonly note?: string | undefined
}

/** POST /production/rework/:reworkId/start|done|cancel. */
export async function moveRework(caller: CommandCaller, reworkId: string, move: ReworkMove, body: MoveInput, idempotencyKey?: string) {
  const context = workerOf(caller)
  const known = await caller.withClient((client) => readRework(client, reworkId))
  if (!known || !mayRework(context, known)) throw new NotFoundError('Rework not found.')
  if (move === 'cancel' && !body.reason?.trim()) throw bodyIssue('reason', 'Say why the rework is cancelled.')
  const { result, replayed } = await command(caller, { name: `production.${move}Rework`, idempotencyKey, input: { reworkId, move, ...body } }, async (tools) => {
    const { tx } = tools
    await lockWorkOrderIssues(tx, context.tenantId, known.workOrderId)
    const rework = await lockRework(tx, reworkId)
    if (!rework) throw new NotFoundError('Rework not found.')
    if (rework.version !== body.version) throw new ConflictError(`This rework changed since you read it (version ${rework.version}, not ${body.version}): read it again.`)
    const workOrder = (await readOrder(tx, rework.workOrderId))!
    const refusal = moveRefusal({ workOrder, rework, move, good: body.good, scrap: body.scrap })
    if (refusal) refused(refusal)
    const status: ReworkStatus = statusAfter(move)
    const data: Prisma.ReworkOrderUncheckedUpdateInput = {
      status,
      version: { increment: 1 },
      updatedAt: tools.now,
      ...(move === 'start' || (move === 'done' && rework.startedAt === null) ? { startedAt: tools.now } : {}),
      ...(move === 'done' ? { doneAt: tools.now, goodQuantity: body.good ?? 0, scrapQuantity: body.scrap ?? 0 } : {}),
      ...(move === 'cancel' ? { cancelledAt: tools.now, cancelReason: body.reason!.trim() } : {}),
      ...(body.note?.trim() ? { note: body.note.trim() } : {}),
    }
    await tx.reworkOrder.update({ where: { id: rework.id }, data, select: { id: true } })
    const after = (await readRework(tx, rework.id))!
    const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
    tools.audit({
      action: `production.${move}Rework`,
      recordType: 'ReworkOrder',
      recordId: rework.id,
      ...scope,
      before: { status: rework.status, goodQuantity: rework.goodQuantity, scrapQuantity: rework.scrapQuantity },
      after: { status, goodQuantity: after.goodQuantity, scrapQuantity: after.scrapQuantity },
      ...(move === 'cancel' ? { reason: body.reason!.trim() } : {}),
    })
    tools.emit({
      type: 'production.rework_moved',
      subject: workOrder.id,
      ...scope,
      payload: { workOrderId: workOrder.id, number: workOrder.number, reworkId: rework.id, bundleId: rework.bundleId, status, goodQuantity: after.goodQuantity, scrapQuantity: after.scrapQuantity, postedBy: postedBy(context) },
    })
    const [view] = await reworkViews(tx, [after], { office: context.audience === 'office' })
    return { rework: view! }
  })
  return { ...result, replayed }
}

// ---- reads -------------------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly bundleId?: string | undefined
  readonly status?: readonly ReworkStatus[] | undefined
  /** Only OPEN and IN_PROGRESS. */
  readonly open?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const SCOPE = { company: 'companyId', site: 'siteId' } as const

/** GET /production/rework: newest first, in pages; the floor its own site (production.rework), the office its grants. */
export async function listRework(caller: CommandCaller, query: ListQuery) {
  const context = workerOf(caller)
  const actor = actorOf(context)
  const scope =
    context.audience === 'floor'
      ? (scopeWhere(actor, PRODUCTION_REWORK, SCOPE) as Prisma.ReworkOrderWhereInput)
      : ({ OR: [scopeWhere(actor, PRODUCTION_REWORK, SCOPE), scopeWhere(actor, PRODUCTION_SCRAP_VIEW, SCOPE)] } as Prisma.ReworkOrderWhereInput)
  const where: Prisma.ReworkOrderWhereInput = {
    AND: [
      scope,
      query.siteId ? { siteId: query.siteId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.bundleId ? { bundleId: query.bundleId } : {},
      query.status && query.status.length > 0 ? { status: { in: [...query.status] } } : {},
      query.open ? { status: { in: ['OPEN', 'IN_PROGRESS'] } } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client: Reader) => {
    const rows = await client.reworkOrder.findMany({ where, select: REWORK_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    return { rework: await reworkViews(client, page, { office: context.audience === 'office' }), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** GET /production/rework/:reworkId. */
export async function reworkRecord(caller: CommandCaller, reworkId: string) {
  const context = workerOf(caller)
  return caller.withClient(async (client: Reader) => {
    const row = await readRework(client, reworkId)
    if (!row || !mayRework(context, row, true)) throw new NotFoundError('Rework not found.')
    const [view] = await reworkViews(client, [row], { office: context.audience === 'office' })
    return { rework: view! }
  })
}
