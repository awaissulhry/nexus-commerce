import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { ACTION_LABELS, actionMessagesOf, decideProblem, ignoredBefore, type ActionDecision, type ActionPlanned, type ActionRecordType, type ActionSubcontract, type ActionWorkOrder, type MrpAction } from '@nexus/factory-domain/planning/actions/messages'
import { PLANNING_ACTIONS_MANAGE } from '@nexus/factory-domain/planning/actions/permissions'
import type { DetectMaterial } from '@nexus/factory-domain/planning/exceptions/detect'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayAt, officeContextOf, siteFor } from '../access'
import type { PlanInputs } from '../inputs'
import { latestDoneRun } from '../inputs'
import { dayOf, type Reader, type SiteRow } from '../store'
import type { ActionMessageView } from './contract'

/**
 * Action messages on existing orders (B-W2b-306; PLN-073; design planning.mrp "To make": advance, postpone, increase,
 * decrease, cancel, each in words with a Done):
 *
 *   the run     in the run's own command, after its lines and planned work: factory-domain planning/actions/messages says
 *               what to do with the site's open purchase order lines, the firm planned orders it carries, its open work
 *               orders and subcontract orders and the planned work orders a planner protected; one MrpActionMessage per
 *               message (OPEN, its place in the run), never one a planner IGNORED before while it asks the same thing;
 *               event mrp_action_messages.raised
 *   the list    GET /planning/action-messages: the site's latest DONE run's messages (default OPEN), planning.view
 *   decide      POST /planning/action-messages/decide: DONE or IGNORED with an optional note, several at once, ONE command,
 *               all or nothing at the versions read, only while their run is the latest DONE one (the database's rule);
 *               planning.actions.manage; audited per message; event mrp_action_messages.decided
 *
 * Marking a message DONE changes nothing else: the purchase order, work order or planned order is changed on its own page
 * (the next run sees it). No money, no person in a list.
 */

const OPEN_WORK_ORDER = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const OPEN_SUBCONTRACT = ['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const
const GONE_ORDER = ['CANCELLED', 'CLOSED']

/** The open work and subcontract orders of the site, as the messages read them. */
async function ordersOf(db: Reader, site: SiteRow, inputs: PlanInputs): Promise<{ workOrders: ActionWorkOrder[]; subcontracts: ActionSubcontract[] }> {
  const rows = await db.workOrder.findMany({
    where: { siteId: site.id, status: { in: [...OPEN_WORK_ORDER] }, kind: { in: ['SIZE_GRID', 'MADE_TO_MEASURE'] } },
    select: { id: true, number: true, status: true, dueDate: true, startedAt: true, sizes: { select: { salesOrderLineId: true, salesOrderLine: { select: { order: { select: { status: true } } } } } } },
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
  })
  const planLine = new Map(inputs.input.orderLines.map((line) => [line.orderLineId, line]))
  const workOrders = rows.flatMap((row): ActionWorkOrder[] => {
    const lineIds = [...new Set(row.sizes.flatMap((size) => (size.salesOrderLineId ? [size.salesOrderLineId] : [])))]
    if (lineIds.length === 0) return []
    const dated = lineIds.flatMap((id) => { const line = planLine.get(id); return line?.dueDate ? [line] : [] }).sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0))
    const gone = row.sizes.every((size) => size.salesOrderLine !== null && GONE_ORDER.includes(size.salesOrderLine.order.status))
    return [{ id: row.id, number: row.number, status: row.status, dueDate: row.dueDate ? dayOf(row.dueDate) : null, neededBy: dated[0]?.dueDate ?? null, neededFor: dated[0]?.orderNumber ?? null, stillNeeded: !gone, started: row.status === 'IN_PROGRESS' || row.startedAt !== null }]
  })
  const byId = new Map(workOrders.map((row) => [row.id, row]))
  const orders = await db.subcontractOrder.findMany({
    where: { siteId: site.id, status: { in: [...OPEN_SUBCONTRACT] } },
    select: { id: true, number: true, expectedBackDate: true, workOrderId: true, party: { select: { code: true } }, workOrder: { select: { number: true, dueDate: true } } },
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
  })
  const subcontracts = orders.map((row) => ({
    id: row.id,
    number: row.number,
    workshop: row.party.code,
    expectedBackDate: row.expectedBackDate ? dayOf(row.expectedBackDate) : null,
    workOrderNumber: row.workOrder.number,
    neededBy: row.workOrder.dueDate ? dayOf(row.workOrder.dueDate) : (byId.get(row.workOrderId)?.neededBy ?? null),
  }))
  return { workOrders, subcontracts }
}

/** The run's step (../run): every message of this plan, written OPEN in the run's command. */
export async function raiseActionMessages(
  tools: CommandTools,
  site: SiteRow,
  runId: string,
  runDate: BusinessDate,
  facts: { readonly inputs: PlanInputs; readonly materials: readonly DetectMaterial[]; readonly requirementIdOf: (seq: number) => string; readonly protectedRows: readonly ActionPlanned[] },
): Promise<{ raised: number; notRaisedAgain: number }> {
  const { tx, now, context } = tools
  const purchases = new Map(facts.inputs.purchases.map((line) => [line.purchaseOrderLineId, { purchaseOrderNumber: line.purchaseOrderNumber, lineSeq: line.seq }]))
  const { workOrders, subcontracts } = await ordersOf(tx, site, facts.inputs)
  const drafts = actionMessagesOf({
    runDate,
    materials: facts.materials.map((material) => ({ requirementId: facts.requirementIdOf(material.seq), label: material.label, uom: material.uom, pegging: material.pegging, keptInStock: material.keptInStock })),
    purchaseOf: (lineId) => purchases.get(lineId),
    workOrders,
    subcontracts,
    planned: facts.protectedRows,
  })
  const recordIds = [...new Set(drafts.map((draft) => draft.recordId))]
  const ignored =
    recordIds.length === 0
      ? []
      : (await tx.mrpActionMessage.findMany({ where: { siteId: site.id, status: 'IGNORED', recordId: { in: recordIds } }, select: { recordType: true, recordId: true, action: true, toDate: true, toQuantity: true } })).map((row) => ({
          recordType: row.recordType,
          recordId: row.recordId,
          action: row.action,
          toDate: row.toDate ? dayOf(row.toDate) : null,
          toQuantity: row.toQuantity ? row.toQuantity.toString() : null,
        }))
  const raise = drafts.filter((draft) => !ignoredBefore(draft, ignored))
  if (raise.length > 0) {
    await tx.mrpActionMessage.createMany({
      data: raise.map((draft, index) => ({
        id: newId(),
        siteId: site.id,
        runId,
        seq: index + 1,
        recordType: draft.recordType,
        recordId: draft.recordId,
        action: draft.action,
        fromDate: draft.fromDate ? new Date(`${draft.fromDate}T00:00:00.000Z`) : null,
        toDate: draft.toDate ? new Date(`${draft.toDate}T00:00:00.000Z`) : null,
        fromQuantity: draft.fromQuantity,
        toQuantity: draft.toQuantity,
        uom: draft.uom,
        message: draft.message,
        facts: draft.facts as Prisma.InputJsonValue,
        createdAt: now,
        updatedAt: now,
        createdById: context.audience === 'office' ? context.actorId : null,
      })),
    })
  }
  const counts = { raised: raise.length, notRaisedAgain: drafts.length - raise.length }
  tools.emit({ type: 'mrp_action_messages.raised', subject: runId, companyId: site.companyId, siteId: site.id, payload: { runId, siteId: site.id, ...counts } })
  return counts
}

// ---- reading --------------------------------------------------------------------------------------------------------------

export const MESSAGE_COLUMNS = {
  id: true,
  siteId: true,
  runId: true,
  seq: true,
  recordType: true,
  recordId: true,
  action: true,
  fromDate: true,
  toDate: true,
  fromQuantity: true,
  toQuantity: true,
  uom: true,
  message: true,
  facts: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  version: true,
  run: { select: { companyId: true, status: true } },
} as const satisfies Prisma.MrpActionMessageSelect
type MessageRow = Prisma.MrpActionMessageGetPayload<{ select: typeof MESSAGE_COLUMNS }>

const quantity = (value: { toString(): string } | null): string | null => (value === null ? null : Number(value.toString()).toFixed(4))
const factsOf = (value: Prisma.JsonValue): Record<string, string | number | boolean | null> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) as Record<string, string | number | boolean | null> : {}

/** The records the messages name, with what opens them (a purchase order line opens its purchase order). */
async function recordsOf(db: Reader, rows: readonly MessageRow[]) {
  const idsOf = (type: ActionRecordType) => [...new Set(rows.filter((row) => row.recordType === type).map((row) => row.recordId))]
  const lines = idsOf('PurchaseOrderLine')
  const purchaseLines = lines.length === 0 ? [] : await db.purchaseOrderLine.findMany({ where: { id: { in: lines } }, select: { id: true, seq: true, purchaseOrder: { select: { id: true, number: true } } } })
  const workOrderIds = idsOf('WorkOrder')
  const workOrders = workOrderIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true } })
  const subcontractIds = idsOf('SubcontractOrder')
  const subcontracts = subcontractIds.length === 0 ? [] : await db.subcontractOrder.findMany({ where: { id: { in: subcontractIds } }, select: { id: true, number: true } })
  const out = new Map<string, { label: string; open: { type: string; id: string } }>()
  for (const line of purchaseLines) out.set(`PurchaseOrderLine|${line.id}`, { label: `${line.purchaseOrder.number} line ${line.seq}`, open: { type: 'PurchaseOrder', id: line.purchaseOrder.id } })
  for (const order of workOrders) out.set(`WorkOrder|${order.id}`, { label: order.number, open: { type: 'WorkOrder', id: order.id } })
  for (const order of subcontracts) out.set(`SubcontractOrder|${order.id}`, { label: order.number, open: { type: 'SubcontractOrder', id: order.id } })
  return out
}

function viewOf(row: MessageRow, records: Awaited<ReturnType<typeof recordsOf>>, office: OfficeContext): ActionMessageView {
  const facts = factsOf(row.facts)
  const record = records.get(`${row.recordType}|${row.recordId}`)
  const fallback = row.recordType === 'PlannedWorkOrder' ? String(facts.plannedWorkOrder ?? 'Planned work order') : row.recordType === 'MaterialRequirement' ? `Firm planned order of ${String(facts.material ?? 'a material')}` : row.recordType
  return {
    id: row.id,
    runId: row.runId,
    siteId: row.siteId,
    seq: row.seq,
    record: { type: row.recordType as ActionRecordType, id: row.recordId, label: record?.label ?? fallback, open: record?.open ?? { type: row.recordType, id: row.recordId } },
    action: row.action as MrpAction,
    label: ACTION_LABELS[row.action as MrpAction],
    fromDate: row.fromDate ? dayOf(row.fromDate) : null,
    toDate: row.toDate ? dayOf(row.toDate) : null,
    fromQuantity: quantity(row.fromQuantity),
    toQuantity: quantity(row.toQuantity),
    uom: row.uom,
    message: row.message,
    facts,
    status: row.status,
    decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
    decisionNote: row.decisionNote,
    version: row.version,
    may: { decide: row.status === 'OPEN' && row.run.status === 'DONE' && mayAt(office, PLANNING_ACTIONS_MANAGE, { companyId: row.run.companyId, siteId: row.siteId }) },
  }
}

export async function messageViews(db: Reader, rows: readonly MessageRow[], office: OfficeContext): Promise<ActionMessageView[]> {
  const records = await recordsOf(db, rows)
  return rows.map((row) => viewOf(row, records, office))
}

export interface ListMessagesQuery {
  readonly siteId: string
  readonly runId?: string | undefined
  readonly status?: string | undefined
  readonly action?: MrpAction | undefined
  readonly recordType?: ActionRecordType | undefined
}

/** GET /planning/action-messages: the latest DONE run's messages (or the run named), OPEN unless asked. */
export async function listActionMessages(caller: CommandCaller, query: ListMessagesQuery) {
  const office = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const run = query.runId ? await db.planningRun.findFirst({ where: { id: query.runId, siteId: site.id }, select: { id: true, startedAt: true, finishedAt: true, status: true } }) : await latestDoneRun(db, site.id)
    if (query.runId && !run) throw new NotFoundError('Run not found.')
    if (!run) return { siteId: site.id, run: null, counts: { open: 0, done: 0, ignored: 0 }, byAction: [], messages: [] }
    const statuses = (query.status ?? 'OPEN').split(',').map((value) => value.trim()).filter((value) => value !== '')
    const scope = scopeWhere(actorOf(office), PLANNING_VIEW, { site: 'siteId' }) as Prisma.MrpActionMessageWhereInput
    const where: Prisma.MrpActionMessageWhereInput = { AND: [scope, { runId: run.id }, { status: { in: statuses as ('OPEN' | 'DONE' | 'IGNORED')[] } }, query.action ? { action: query.action } : {}, query.recordType ? { recordType: query.recordType } : {}] }
    const rows = await db.mrpActionMessage.findMany({ where, select: MESSAGE_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }], take: 1000 })
    const all = await db.mrpActionMessage.groupBy({ by: ['status', 'action'], where: { runId: run.id }, _count: { _all: true } })
    const count = (status: string) => all.filter((row) => row.status === status).reduce((sum, row) => sum + row._count._all, 0)
    const actions = [...new Set(all.filter((row) => row.status === 'OPEN').map((row) => row.action))]
    return {
      siteId: site.id,
      run: { id: run.id, startedAt: toUtcIso(run.startedAt), finishedAt: run.finishedAt ? toUtcIso(run.finishedAt) : null },
      counts: { open: count('OPEN'), done: count('DONE'), ignored: count('IGNORED') },
      byAction: actions.map((action) => ({ action: action as MrpAction, open: all.filter((row) => row.status === 'OPEN' && row.action === action).reduce((sum, row) => sum + row._count._all, 0) })),
      messages: await messageViews(db, rows, office),
    }
  })
}

export interface DecideBody {
  readonly messages: readonly { readonly id: string; readonly version: number }[]
  readonly status: ActionDecision
  readonly note?: string | undefined
}

/** POST /planning/action-messages/decide: DONE or IGNORED, all or nothing. */
export async function decideActionMessages(caller: CommandCaller, body: DecideBody, idempotencyKey?: string) {
  const office = officeContextOf(caller)
  const ids = body.messages.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A message is named twice.', [{ path: 'body/messages', message: 'Name each message once.' }])
  const rows = await caller.withClient((db) => db.mrpActionMessage.findMany({ where: { id: { in: ids } }, select: MESSAGE_COLUMNS }))
  // Not seen with planning.view: not found; seen but not decided by the caller: forbidden (all or nothing).
  const missing = ids.filter((id) => !rows.some((row) => row.id === id && mayAt(office, PLANNING_VIEW, { companyId: row.run.companyId, siteId: row.siteId })))
  if (missing.length > 0) throw new NotFoundError(`${missing.length === 1 ? 'An action message was' : `${missing.length} action messages were`} not found.`)
  const sites = [...new Set(rows.map((row) => row.siteId))]
  if (sites.length !== 1) throw new ValidationError('Decide the messages of one site at a time.', [{ path: 'body/messages', message: 'Name messages of one site.' }])
  const first = rows[0]!
  await siteFor(caller, first.siteId, PLANNING_ACTIONS_MANAGE)
  const note = body.note?.trim() ? body.note.trim() : null
  const { replayed } = await command(caller, { name: 'planning.actionMessages.decide', idempotencyKey, input: { messages: body.messages, status: body.status, note } }, async (tools) => {
    const { tx, now, context } = tools
    const current = await tx.mrpActionMessage.findMany({ where: { id: { in: ids } }, select: MESSAGE_COLUMNS })
    for (const entry of body.messages) {
      const row = current.find((candidate) => candidate.id === entry.id)!
      const problem = decideProblem(row, row.run)
      if (problem) throw new ConflictError(`Message ${row.seq}: ${problem}`)
      const { count } = await tx.mrpActionMessage.updateMany({
        where: { id: row.id, status: 'OPEN', version: entry.version },
        data: { status: body.status, decidedAt: now, decidedById: context.audience === 'office' ? context.actorId : null, decisionNote: note, version: entry.version + 1, updatedAt: now },
      })
      if (count !== 1) throw new ConflictError(`Message ${row.seq} changed since you read it (version ${row.version}, you sent ${entry.version}): read it again.`)
      tools.audit({ action: 'planning.actionMessages.decide', recordType: 'MrpActionMessage', recordId: row.id, companyId: row.run.companyId, siteId: row.siteId, before: { status: 'OPEN' }, after: { status: body.status, note } })
    }
    tools.emit({ type: 'mrp_action_messages.decided', subject: first.runId, companyId: first.run.companyId, siteId: first.siteId, payload: { runId: first.runId, siteId: first.siteId, status: body.status, messageIds: ids } })
    return { decided: ids.length }
  })
  const after = await caller.withClient(async (db) => messageViews(db, await db.mrpActionMessage.findMany({ where: { id: { in: ids } }, select: MESSAGE_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] }), office))
  return { decided: ids.length, messages: after, replayed }
}
