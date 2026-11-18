import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { CHANGE_WORDS, extraOf as extraOfPlanned, planChanges, type ChangeCell, type ChangeRefusal, type ExtraOutcome, type ExtraPieces, type PlannedChange, type WorkCell, type Words } from '@nexus/factory-domain/order-apply/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOrder } from '../../sales/orders/moves'
import { officeContextOf } from '../work-orders/access'
import { reachesWorkOrder } from '../work-orders/scope'
import { cellsOf, changeViews, CHANGE_COLUMNS, WORK_ORDER_COLUMNS, type Reader } from './read'
import { decideInCommand } from './decide'

/**
 * B-SA-041 (sales page plan, lead picks P6', R1; 13-backend B4b): proposing a WorkOrderChange — the gap an accepted change of a
 * sales order leaves on one of its work orders, held for a person who manages the work order (Home › Approvals, B-SA-044; the
 * work order's band notice). A proposal is not an approval (rule 42; review C-11): it moves no money and promises nothing.
 *
 *   POST /production/work-order-changes {salesOrderId, workOrderId?, requestId?, amendmentId?, kind, cells, extra?,
 *        extraOutcome?, reason}   orders.manage over the order; the work order reached with workorders.view (a mixed one made
 *                                 before the one-customer rule: only by a person of every customer) — an office's own change
 *   proposeInCommand(tools, …)    the same rows inside a command that is already open: B-SA-042's Accept of a customer's
 *                                 change (factory-domain order-apply planChanges: one change per work order)
 *
 * Each row PROPOSED, of the order's customer, named its proposer; audited; `work_order_change.proposed` (ids, kind; the order's
 * customer as partyId). The database's …_order_apply_guards hold the shape and the wall for every login (a work order of another
 * customer, a line of another order, extra pieces of a cell it does not lower are refused).
 */

/** A refusal of the work-order changes: 409 with `refusal/<CODE>` and the words (both languages in factory-domain CHANGE_WORDS). */
export class ChangeRefusedError extends ConflictError {
  override name = 'ChangeRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    // S7 end check: the refusal's code is `refusal` (as the other …RefusedError), never `code` — that one is DomainError's
    // 'conflict', which mapError turns into the 409.
    readonly refusal: ChangeRefusal,
    readonly words: Words,
  ) {
    super(words.en)
    this.issues = [{ path: `refusal/${refusal}`, message: words.en }]
  }
}

export const refuseChange = (code: ChangeRefusal, words: Words): never => {
  throw new ChangeRefusedError(code, words)
}

/** The order a change is of (its customer and company: the reference's keys). */
export interface ChangeOrder {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
}

export interface ProposeInput {
  readonly order: ChangeOrder
  readonly requestId: string | null
  readonly amendmentId: string | null
  readonly reason: string
  /** What happens to the extra pieces of the changes that leave some (chosen before Accept, R1 / Round 4). */
  readonly extraOutcome: ExtraOutcome | null
  readonly changes: readonly PlannedChange[]
}

export interface Proposed {
  readonly id: string
  readonly kind: PlannedChange['kind']
  readonly workOrderId: string | null
  readonly number: string | null
  readonly cells: readonly ChangeCell[]
  readonly extra: readonly ExtraPieces[]
}

/** The changes written PROPOSED inside an open command (see the file's head); [] when there is none. */
export async function proposeInCommand(tools: CommandTools, context: OfficeContext, input: ProposeInput): Promise<Proposed[]> {
  const { tx, now } = tools
  const made: Proposed[] = []
  const workOrderIds = [...new Set(input.changes.flatMap((change) => (change.workOrderId ? [change.workOrderId] : [])))]
  const sites = new Map((workOrderIds.length > 0 ? await tx.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, siteId: true } }) : []).map((row) => [row.id, row.siteId]))
  for (const change of input.changes) {
    if (change.extra.length > 0 && input.extraOutcome === null) throw new ValidationError('Choose what happens to the extra pieces.', [{ path: 'body/extraOutcome', message: 'Choose what happens to the extra pieces already cut.' }])
    const siteId = change.workOrderId ? sites.get(change.workOrderId) : null
    if (change.workOrderId && !siteId) throw new NotFoundError('Work order not found.')
    const id = newId()
    const extra = change.kind === 'LOWER_TO_ORDER' && change.extra.length > 0 ? change.extra : null
    await tx.workOrderChange.create({
      data: {
        id,
        companyId: input.order.companyId,
        partyId: input.order.partyId,
        salesOrderId: input.order.id,
        siteId: siteId ?? null,
        workOrderId: change.workOrderId,
        requestId: input.requestId,
        amendmentId: input.amendmentId,
        kind: change.kind,
        cells: change.cells as unknown as Prisma.InputJsonValue,
        ...(extra ? { extra: extra as unknown as Prisma.InputJsonValue, extraOutcome: input.extraOutcome! } : {}),
        reason: input.reason.slice(0, 500),
        proposedById: context.actorId,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      action: 'workorders.proposeChange',
      recordType: 'WorkOrderChange',
      recordId: id,
      companyId: input.order.companyId,
      siteId: siteId ?? null,
      after: { status: 'PROPOSED', kind: change.kind, salesOrderId: input.order.id, workOrderId: change.workOrderId, requestId: input.requestId, amendmentId: input.amendmentId, cells: change.cells, extra, extraOutcome: extra ? input.extraOutcome : null },
      reason: input.reason,
    })
    tools.emit({
      type: 'work_order_change.proposed',
      subject: id,
      companyId: input.order.companyId,
      siteId: siteId ?? null,
      payload: { changeId: id, salesOrderId: input.order.id, workOrderId: change.workOrderId, partyId: input.order.partyId, kind: change.kind, requestId: input.requestId, amendmentId: input.amendmentId, hasExtra: extra !== null },
    })
    made.push({ id, kind: change.kind, workOrderId: change.workOrderId, number: change.number, cells: change.cells, extra: extra ?? [] })
  }
  return made
}

export interface ProposeBody {
  readonly salesOrderId: string
  readonly workOrderId?: string | null | undefined
  readonly requestId?: string | null | undefined
  readonly amendmentId?: string | null | undefined
  readonly kind: PlannedChange['kind']
  readonly cells: readonly ChangeCell[]
  readonly extra?: readonly ExtraPieces[] | null | undefined
  readonly extraOutcome?: ExtraOutcome | null | undefined
  readonly reason: string
}

/** The body's problems against the order and the work order as they are (400 / 409 in words; the database holds the rest). */
async function checkedChange(caller: CommandCaller, context: OfficeContext, body: ProposeBody, order: ChangeOrder): Promise<PlannedChange> {
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const workOrder = body.workOrderId ? await db.workOrder.findUnique({ where: { id: body.workOrderId }, select: { ...WORK_ORDER_COLUMNS, styleId: true } }) : null
    if (body.workOrderId && (!workOrder || !reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))) throw new NotFoundError('Work order not found.')
    if (body.kind === 'LOWER_TO_ORDER' && !workOrder) throw new ValidationError('Name the work order it lowers.', [{ path: 'body/workOrderId', message: 'A change that lowers names its work order.' }])
    if (body.requestId) {
      const request = await db.orderChangeRequest.findUnique({ where: { id: body.requestId }, select: { orderId: true, status: true } })
      if (!request || request.orderId !== order.id) throw new NotFoundError('Change request not found.')
      // Accept is the commercial decision (P6', R1): a change of a work order carries out an accepted request only, so a request
      // withdrawn by the customer or refused by us never leaves one behind (and the customer's session, which has no grant on
      // these office records, never needs to touch one).
      if (request.status !== 'ACCEPTED') refuseChange('REQUEST_NOT_ACCEPTED', CHANGE_WORDS.requestNotAccepted())
    }
    if (body.amendmentId) {
      const amendment = await db.salesOrderAmendment.findUnique({ where: { id: body.amendmentId }, select: { orderId: true } })
      if (!amendment || amendment.orderId !== order.id) throw new NotFoundError('Amendment not found.')
    }
    const lines = await db.salesOrderLine.findMany({ where: { id: { in: [...new Set(body.cells.map((cell) => cell.salesOrderLineId))] } }, select: { id: true, orderId: true, styleId: true, siteId: true } })
    const lineOf = new Map(lines.map((line) => [line.id, line]))
    if (body.cells.some((cell) => lineOf.get(cell.salesOrderLineId)?.orderId !== order.id)) refuseChange('NOT_THIS_ORDER', CHANGE_WORDS.notThisOrder())
    const named = body.cells.flatMap((cell) => (cell.workOrderSizeId ? [cell.workOrderSizeId] : []))
    const held = new Map((named.length > 0 ? await db.workOrderSize.findMany({ where: { id: { in: named } }, select: { id: true, workOrderId: true, salesOrderLineId: true, size: true, quantity: true } }) : []).map((row) => [row.id, row]))
    const problems: Issue[] = []
    body.cells.forEach((cell, index) => {
      const at = `body/cells/${index}`
      if (body.kind === 'LOWER_TO_ORDER' ? cell.to >= cell.from || cell.workOrderSizeId === null : cell.to <= cell.from) problems.push({ path: at, message: body.kind === 'LOWER_TO_ORDER' ? 'A change that lowers names its cell and goes below what it makes.' : 'A change that makes more goes above what it makes.' })
      if (cell.workOrderSizeId !== null) {
        const row = held.get(cell.workOrderSizeId)
        if (!row || row.workOrderId !== workOrder?.id || row.salesOrderLineId !== cell.salesOrderLineId || row.size !== cell.size) problems.push({ path: `${at}/workOrderSizeId`, message: "Not a cell of this work order, of that line and size." })
        else if (row.quantity !== cell.from) refuseChange('CHANGED_SINCE', CHANGE_WORDS.changedSince(workOrder!.number))
      } else if (cell.from !== 0) problems.push({ path: `${at}/from`, message: 'A new cell starts from 0.' })
    })
    const extra = body.extra ?? []
    if (extra.length > 0 && body.kind !== 'LOWER_TO_ORDER') problems.push({ path: 'body/extra', message: 'Only a change that lowers leaves extra pieces.' })
    if ((extra.length > 0) !== (body.extraOutcome !== undefined && body.extraOutcome !== null)) problems.push({ path: 'body/extraOutcome', message: 'Extra pieces come with what happens to them, and only then.' })
    for (const [index, entry] of extra.entries()) {
      if (!body.cells.some((cell) => cell.workOrderSizeId === entry.workOrderSizeId && cell.salesOrderLineId === entry.salesOrderLineId && cell.size === entry.size)) problems.push({ path: `body/extra/${index}`, message: 'Extra pieces of a cell this change lowers.' })
    }
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    const first = lineOf.get(body.cells[0]!.salesOrderLineId)!
    return { kind: body.kind, workOrderId: workOrder?.id ?? null, number: workOrder?.number ?? null, styleId: workOrder?.styleId ?? first.styleId, siteId: workOrder?.siteId ?? first.siteId, cells: body.cells, extra }
  })
}

/** orders.manage: POST /production/work-order-changes (see the file's head). */
export async function proposeChange(caller: CommandCaller, body: ProposeBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, body.salesOrderId, ORDERS_MANAGE)
  const planned = await checkedChange(caller, context, body, order)
  const { result } = await command(caller, { name: 'workorders.proposeChange', idempotencyKey, input: body }, async (tools) => {
    const [made] = await proposeInCommand(tools, context, { order, requestId: body.requestId ?? null, amendmentId: body.amendmentId ?? null, reason: body.reason.trim(), extraOutcome: body.extraOutcome ?? null, changes: [planned] })
    return { changeId: made!.id }
  })
  return caller.withClient(async (db) => {
    const row = await db.workOrderChange.findUniqueOrThrow({ where: { id: result.changeId }, select: CHANGE_COLUMNS })
    return { change: (await changeViews(db, actorOf(context), [row]))[0]! }
  })
}


// ── B-SA-042 (sales page plan, lead picks P6', R1; review C-4, C-16): Accept runs the commercial change at once, and the gap it
// leaves on the order's work orders is proposed in the SAME command — the amendment, the close of lines and the cancel each call
// proposeGapsInCommand (Accept once, at its end). ──

/** A line as the gap reads it: what its work orders should make of each size now. */
export interface GapLine {
  readonly id: string
  readonly styleId: string
  readonly siteId: string | null
  readonly madeToMeasure: boolean
  readonly sizes: ReadonlyMap<string, number>
}

/** The work order kinds a change touches (a repair or a sample round makes no order line's pieces). */
const MADE_FOR_ORDERS = ['SIZE_GRID', 'MADE_TO_MEASURE'] as const

/**
 * The order's lines as stored, as the gap reads them: a line closed short wants what shipped of it (nothing more is made); a
 * cancelled order wants nothing; a made-to-measure unit its one piece of its base size. Only the lines named (none: every line).
 */
export async function storedGapLines(db: Reader, order: { readonly id: string; readonly status: string }, lineIds?: readonly string[], /** A preview: these lines read as closed short already. */ closing?: ReadonlySet<string>): Promise<GapLine[]> {
  const lines = await db.salesOrderLine.findMany({
    where: { orderId: order.id, kind: { in: [...MADE_FOR_ORDERS] }, ...(lineIds ? { id: { in: [...lineIds] } } : {}) },
    select: { id: true, styleId: true, siteId: true, kind: true, baseSize: true, closedShortQuantity: true, sizes: { select: { size: true, quantity: true } } },
  })
  const isClosed = (line: { readonly id: string; readonly closedShortQuantity: number | null }) => line.closedShortQuantity !== null || closing?.has(line.id) === true
  const closed = lines.filter(isClosed).map((line) => line.id)
  const shipped = closed.length === 0 ? [] : await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: closed }, quantity: { gt: 0 }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } }, select: { salesOrderLineId: true, size: true, quantity: true } })
  return lines.map((line) => {
    const sizes = new Map<string, number>()
    const unit = line.kind === 'MADE_TO_MEASURE'
    if (order.status === 'CANCELLED') {
      if (unit && line.baseSize) sizes.set(line.baseSize, 0)
      for (const size of line.sizes) sizes.set(size.size, 0)
    } else if (isClosed(line)) {
      for (const size of line.sizes) sizes.set(size.size, 0)
      if (unit && line.baseSize) sizes.set(line.baseSize, 0)
      for (const row of shipped.filter((entry) => entry.salesOrderLineId === line.id)) {
        const size = row.size
        sizes.set(size, (sizes.get(size) ?? 0) + row.quantity)
      }
    } else if (unit) {
      if (line.baseSize) sizes.set(line.baseSize, 1)
    } else {
      for (const size of line.sizes) sizes.set(size.size, size.quantity)
    }
    return { id: line.id, styleId: line.styleId, siteId: line.siteId, madeToMeasure: unit, sizes }
  })
}

/** The cells of these lines' work orders (not cancelled is the plan's to judge), with what is already cut (the database's floor). */
export async function workCellsOf(db: Reader, tenantId: string, lineIds: readonly string[]): Promise<WorkCell[]> {
  if (lineIds.length === 0) return []
  const rows = await db.workOrderSize.findMany({
    where: { salesOrderLineId: { in: [...lineIds] }, workOrder: { is: { kind: { in: [...MADE_FOR_ORDERS] } } } },
    select: { id: true, salesOrderLineId: true, size: true, quantity: true, workOrder: { select: { id: true, number: true, status: true, kind: true, styleId: true, siteId: true } } },
  })
  const started = rows.filter((row) => ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'].includes(row.workOrder.status)).map((row) => row.id)
  const floors = new Map<string, number>()
  if (started.length > 0) {
    const found = await db.$queryRaw<{ id: string; floor: number }[]>`SELECT c.id::text AS id, "factory_work_order_cell_floor"(${tenantId}::uuid, c.id) AS floor FROM unnest(${started}::uuid[]) AS c(id)`
    for (const row of found) floors.set(row.id, Number(row.floor))
  }
  return rows.map((row) => ({
    workOrderId: row.workOrder.id,
    number: row.workOrder.number,
    status: row.workOrder.status,
    kind: row.workOrder.kind,
    styleId: row.workOrder.styleId,
    siteId: row.workOrder.siteId,
    cellId: row.id,
    salesOrderLineId: row.salesOrderLineId!,
    size: row.size,
    quantity: row.quantity,
    cut: floors.get(row.id) ?? 0,
  }))
}

/** The plan of these lines against their work orders: only lines in work (a counted cell); raises capped by `raiseAtMost`. */
export function gapOf(lines: readonly GapLine[], cells: readonly WorkCell[], raiseAtMost: ReadonlyMap<string, number>): PlannedChange[] {
  const inWork = new Set(cells.filter((cell) => cell.status !== 'CANCELLED').map((cell) => cell.salesOrderLineId))
  return planChanges(
    lines.filter((line) => inWork.has(line.id)).map((line) => ({ lineId: line.id, styleId: line.styleId, siteId: line.siteId, madeToMeasure: line.madeToMeasure, sizes: line.sizes })),
    cells,
    raiseAtMost,
  )
}

/** The raise a change allows per `<lineId>|<size>`: what it added (after − before), and what the changes it replaces still asked. */
export function raisesOf(before: ReadonlyMap<string, ReadonlyMap<string, number>>, after: readonly GapLine[], replaced: readonly { readonly kind: string; readonly cells: readonly ChangeCell[] }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of after) {
    const was = before.get(line.id)
    if (!was) continue
    for (const [size, quantity] of line.sizes) {
      const added = quantity - (was.get(size) ?? 0)
      if (added > 0) out.set(`${line.id}|${size}`, added)
    }
  }
  for (const change of replaced) {
    if (change.kind !== 'MAKE_MORE') continue
    for (const cell of change.cells) {
      const key = `${cell.salesOrderLineId}|${cell.size}`
      out.set(key, (out.get(key) ?? 0) + (cell.to - cell.from))
    }
  }
  return out
}

export interface GapInput {
  readonly order: ChangeOrder & { readonly status: string }
  readonly requestId: string | null
  readonly amendmentId: string | null
  readonly reason: string
  readonly extraOutcome: ExtraOutcome | null
  /** An Accept of a customer's change, an amendment: Accept stays held until the extra pieces' outcome is chosen. An office's close
   * or cancel: without an outcome the extra pieces are left to production (as before), named on the order (B-SA-043). */
  readonly requireOutcome: boolean
  /** The lines the change touched. */
  readonly lineIds: readonly string[]
  /** Their sizes before the change (a raise is what the change added); none: the change raises nothing (a close, a cancel). */
  readonly before?: ReadonlyMap<string, ReadonlyMap<string, number>>
}

/**
 * The gap the change leaves, proposed (see the block's head): the lines it touched (and those of the PROPOSED changes it replaces:
 * a newer change of the same lines makes them STALE, their raises carried) against their work orders. Only from an office person's
 * command (the database names an ACTIVE office proposer; the system's own commands leave the gap to production). Refused in words,
 * nothing written, when extra pieces are left with no outcome and the change needs one.
 */
export async function proposeGapsInCommand(tools: CommandTools, input: GapInput): Promise<{ proposed: Proposed[]; extra: ExtraPieces[] }> {
  const none = { proposed: [], extra: [] }
  if (tools.context.audience !== 'office' || input.lineIds.length === 0) return none
  const context = tools.context as OfficeContext
  const { tx } = tools
  const proposer = await tx.user.findFirst({ where: { id: context.actorId, status: 'ACTIVE' }, select: { id: true } })
  if (!proposer) return none
  // The waiting changes of the order that name a touched line are replaced (and their lines read again with them).
  const waiting = await tx.workOrderChange.findMany({ where: { salesOrderId: input.order.id, status: 'PROPOSED' }, select: CHANGE_COLUMNS })
  const touched = new Set(input.lineIds)
  const replaced: typeof waiting = []
  for (let grew = true; grew; ) {
    grew = false
    for (const row of waiting) {
      if (replaced.includes(row) || !cellsOf(row).some((cell) => touched.has(cell.salesOrderLineId))) continue
      replaced.push(row)
      for (const cell of cellsOf(row)) if (!touched.has(cell.salesOrderLineId)) {
        touched.add(cell.salesOrderLineId)
        grew = true
      }
    }
  }
  const lines = await storedGapLines(tx, input.order, [...touched])
  const cells = await workCellsOf(tx, context.tenantId, [...touched])
  let changes = gapOf(lines, cells, raisesOf(input.before ?? new Map(), lines, replaced.map((row) => ({ kind: row.kind, cells: cellsOf(row) }))))
  const extra = extraOfPlanned(changes)
  if (extra.length > 0 && input.extraOutcome === null) {
    if (input.requireOutcome) refuseChange('EXTRA_OUTCOME', CHANGE_WORDS.chooseExtra(extra.reduce((sum, entry) => sum + entry.count, 0)))
    changes = changes.map((change) => ({ ...change, extra: [] }))
  }
  for (const row of replaced) await decideInCommand(tools, context, row, 'STALE')
  const proposed = await proposeInCommand(tools, context, { order: input.order, requestId: input.requestId, amendmentId: input.amendmentId, reason: input.reason, extraOutcome: input.extraOutcome, changes })
  return { proposed, extra }
}
// ── end B-SA-042 ──
