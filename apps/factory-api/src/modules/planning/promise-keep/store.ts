import { z } from 'zod'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import { DECISION_ACTIONS, PROPOSAL_DECISIONS, PROPOSE_ACTION, proposalStateOf, type ProposalDecision, type ProposalSize, type ProposalState } from '@nexus/factory-domain/planning/promise-keep/repromise'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf } from '../access'
import { mayPromiseAt } from '../promise/store'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'

/**
 * What keeping promises reads (B-W2b-317), in one client, one query after another. Office only. An order line is seen with
 * orders.view over its order (company, customer; else not found) and planning.promise.view over its making site (else
 * forbidden), as B-W2b-301's order-line promise.
 *
 *   lines       the open order lines of the promise list and the history (their sizes, style, colourway, order, customer)
 *   proposals   the re-promises: each is the audit row of its proposal on the order (PROPOSE_ACTION, the dates per size,
 *               the reason, the words to the customer) and its task on the order for sales (the task id is the proposal's
 *               id); its decision is the audit row of the accept, decline or withdraw that names it
 *   recipients  who the customer's message goes to: the quote's contact of the order, else the customer's ORDERS contacts
 */

/** The order states a line is kept in the promise list (B-W2b-301's states a promise may be recorded in). */
export const KEEP_ORDER_STATUSES = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

export const KEEP_LINE_SELECT = {
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
  closedShortAt: true,
  sizes: { select: { size: true, quantity: true } },
  style: { select: { id: true, code: true, name: true, sizes: true, baseSize: true } },
  colourway: { select: { id: true, code: true, name: true } },
  order: {
    select: {
      id: true,
      number: true,
      status: true,
      orderDate: true,
      promiseDate: true,
      originalPromiseDate: true,
      shipTo: true,
      createdAt: true,
      createdById: true,
      customerRef: true,
      language: true,
      priorityLevel: true,
      priority: true,
      backlogRank: true,
      quoteVersionId: true,
      party: { select: { id: true, code: true, legalName: true, tradeName: true } },
    },
  },
} as const

export async function readKeepLine(db: Reader, orderLineId: string) {
  return isUuid(orderLineId) ? db.salesOrderLine.findUnique({ where: { id: orderLineId }, select: KEEP_LINE_SELECT }) : null
}
export type KeepLine = NonNullable<Awaited<ReturnType<typeof readKeepLine>>>

/** A customer as the lists name it: its trade name, else its legal name. */
export const customerOf = (party: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null }) => ({ id: party.id, code: party.code, name: party.tradeName ?? party.legalName })

/** The line's making site: its own, else the company's only ACTIVE plant (as MRP places order lines); null: none known. */
export async function makingSiteOf(db: Reader, line: Pick<KeepLine, 'siteId' | 'companyId'>): Promise<SiteRow | null> {
  if (line.siteId) return db.site.findUnique({ where: { id: line.siteId }, select: SITE_COLUMNS })
  const plants = await db.site.findMany({ where: { companyId: line.companyId, kind: 'PLANT', status: 'ACTIVE' }, select: SITE_COLUMNS, take: 2 })
  return plants.length === 1 ? plants[0]! : null
}

/** The line (orders.view over its order, else not found), its making site (planning.promise.view and `permission` there). */
export async function keepLineFor(caller: CommandCaller, db: Reader, orderLineId: string, permission: Permission = PLANNING_PROMISE_VIEW): Promise<{ context: OfficeContext; line: KeepLine; site: SiteRow }> {
  const context = officeContextOf(caller)
  const line = await readKeepLine(db, orderLineId)
  if (!line || line.kind === 'FEE' || !can(actorOf(context), ORDERS_VIEW, { companyId: line.companyId, partyId: line.partyId })) throw new NotFoundError('Order line not found.')
  const site = await makingSiteOf(db, line)
  if (!site) throw new InvalidStateError(`${line.order.number} line ${line.seq} has no making site yet and its company has no single active plant: choose its site first.`)
  if (!mayPromiseAt(context, PLANNING_PROMISE_VIEW, site)) throw new ForbiddenError()
  if (permission !== PLANNING_PROMISE_VIEW && !mayPromiseAt(context, permission, site)) throw new ForbiddenError()
  return { context, line, site }
}

/** The line's sizes in the style's order (a made-to-measure line: one unit, size null). */
export function sizesOfLine(line: Pick<KeepLine, 'kind' | 'sizes' | 'style'>): { size: string | null; ordered: number }[] {
  if (line.kind === 'MADE_TO_MEASURE') return [{ size: null, ordered: 1 }]
  const order = line.style.sizes
  return [...line.sizes].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size)).map((entry) => ({ size: entry.size, ordered: entry.quantity }))
}

/** The date typed on the line or its order (W1). */
export const typedOf = (line: Pick<KeepLine, 'promiseDate' | 'order'>): BusinessDate | null => {
  const day = line.promiseDate ?? line.order.promiseDate
  return day ? day.toISOString().slice(0, 10) : null
}

/** The first promise typed on the order (W1's originalPromiseDate, kept once). */
export const originalOf = (line: Pick<KeepLine, 'order'>): BusinessDate | null => (line.order.originalPromiseDate ? line.order.originalPromiseDate.toISOString().slice(0, 10) : null)

/** Shipped pieces per line and size (SHIPPED / DELIVERED shipments). */
export async function shippedOfLines(db: Reader, lineIds: readonly string[]): Promise<(lineId: string, size: string | null) => number> {
  const rows = lineIds.length === 0 ? [] : await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { salesOrderLineId: { in: [...lineIds] }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } }, _sum: { quantity: true } })
  const bySize = new Map(rows.map((row) => [`${row.salesOrderLineId}|${row.size ?? ''}`, row._sum.quantity ?? 0]))
  const total = new Map<string, number>()
  for (const row of rows) if (row.salesOrderLineId) total.set(row.salesOrderLineId, (total.get(row.salesOrderLineId) ?? 0) + (row._sum.quantity ?? 0))
  return (lineId, size) => (size === null ? (total.get(lineId) ?? 0) : (bySize.get(`${lineId}|${size}`) ?? 0))
}

/** The line's promise lock (B-W2b-301's key: the record and every re-promise of a line queue on it). */
export async function lockLinePromise(tx: CommandTx, tenantId: string, lineId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order-promise', ${tenantId}::uuid, ${lineId}::uuid), 0))`
}

// ---- proposals ---------------------------------------------------------------------------------------------------------------

const PROPOSAL_AFTER = z.object({
  proposalId: z.uuid(),
  orderLineId: z.uuid(),
  siteId: z.uuid(),
  planVersionId: z.uuid().nullable(),
  sizes: z.array(z.object({ size: z.string().nullable(), from: z.string().nullable(), to: z.string() })),
  reasonCode: z.string(),
  reason: z.string().nullable(),
  message: z.object({ language: z.enum(['it', 'en']), subject: z.string(), body: z.string() }),
  recipients: z.array(z.string()),
})

const DECISION_AFTER = z.object({
  proposalId: z.uuid(),
  decision: z.enum(PROPOSAL_DECISIONS),
  told: z.boolean().optional(),
  outboundId: z.uuid().nullable().optional(),
  rows: z.number().int().optional(),
  lineDate: z.string().nullable().optional(),
})

export interface ProposalRecord {
  readonly id: string
  readonly orderId: string
  readonly orderLineId: string
  readonly siteId: string
  readonly planVersionId: string | null
  readonly sizes: ProposalSize[]
  readonly reasonCode: string
  readonly reason: string | null
  readonly message: { readonly language: 'it' | 'en'; readonly subject: string; readonly body: string }
  readonly recipients: string[]
  readonly proposedById: string
  readonly proposedAt: Date
  readonly state: ProposalState
  readonly taskStatus: 'OPEN' | 'DONE' | 'CANCELLED' | null
  readonly taskAssigneeId: string | null
  readonly decision: { readonly decision: ProposalDecision; readonly byId: string; readonly at: Date; readonly reason: string | null; readonly told: boolean; readonly outboundId: string | null } | null
}

/** The re-promises of the orders (newest first), with their state. */
export async function readProposals(db: Reader, orderIds: readonly string[]): Promise<ProposalRecord[]> {
  if (orderIds.length === 0) return []
  const rows = await db.auditLog.findMany({
    where: { recordType: 'SalesOrder', recordId: { in: [...new Set(orderIds)] }, action: { in: [PROPOSE_ACTION, ...Object.values(DECISION_ACTIONS)] } },
    select: { id: true, recordId: true, action: true, actorId: true, at: true, after: true, reason: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
  const decisions = new Map<string, ProposalRecord['decision']>()
  for (const row of rows) {
    if (row.action === PROPOSE_ACTION) continue
    const after = DECISION_AFTER.safeParse(row.after)
    if (!after.success || decisions.has(after.data.proposalId)) continue
    decisions.set(after.data.proposalId, { decision: after.data.decision, byId: row.actorId, at: row.at, reason: row.reason, told: after.data.told ?? false, outboundId: after.data.outboundId ?? null })
  }
  const proposed = rows.flatMap((row) => {
    if (row.action !== PROPOSE_ACTION) return []
    const after = PROPOSAL_AFTER.safeParse(row.after)
    return after.success ? [{ row, after: after.data }] : []
  })
  const tasks = proposed.length === 0 ? [] : await db.task.findMany({ where: { id: { in: proposed.map((entry) => entry.after.proposalId) } }, select: { id: true, status: true, assigneeId: true } })
  const taskOf = new Map(tasks.map((task) => [task.id, task]))
  return proposed
    .map(({ row, after }) => {
      const decision = decisions.get(after.proposalId) ?? null
      const task = taskOf.get(after.proposalId) ?? null
      return {
        id: after.proposalId,
        orderId: row.recordId,
        orderLineId: after.orderLineId,
        siteId: after.siteId,
        planVersionId: after.planVersionId,
        sizes: after.sizes.map((entry) => ({ size: entry.size, from: entry.from, to: entry.to })),
        reasonCode: after.reasonCode,
        reason: after.reason,
        message: after.message,
        recipients: after.recipients,
        proposedById: row.actorId,
        proposedAt: row.at,
        state: proposalStateOf(decision?.decision ?? null, (task?.status as ProposalRecord['taskStatus']) ?? null),
        taskStatus: (task?.status as ProposalRecord['taskStatus']) ?? null,
        taskAssigneeId: task?.assigneeId ?? null,
        decision,
      }
    })
    .sort((a, b) => b.proposedAt.getTime() - a.proposedAt.getTime() || (a.id < b.id ? 1 : -1))
}

/** One proposal by its id (its task names the order), or null. */
export async function readProposal(db: Reader, proposalId: string): Promise<ProposalRecord | null> {
  if (!isUuid(proposalId)) return null
  const task = await db.task.findUnique({ where: { id: proposalId }, select: { recordType: true, recordId: true } })
  if (!task || task.recordType !== 'SalesOrder' || !task.recordId) return null
  return (await readProposals(db, [task.recordId])).find((proposal) => proposal.id === proposalId) ?? null
}

// ---- who the customer's message goes to ---------------------------------------------------------------------------------

/** The quote's contact of the order (its buyer), else the customer's ACTIVE ORDERS contacts with an address (by name). */
export async function recipientsOf(db: Reader, order: { readonly partyId: string; readonly quoteVersionId: string | null; readonly language: string }): Promise<{ to: string[]; language: string }> {
  if (order.quoteVersionId) {
    const version = await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { quote: { select: { contactId: true } } } })
    const contactId = version?.quote.contactId ?? null
    const contact = contactId ? await db.partyContact.findUnique({ where: { id: contactId }, select: { email: true, status: true, language: true, erasedAt: true } }) : null
    if (contact?.email && contact.status === 'ACTIVE' && !contact.erasedAt) return { to: [contact.email], language: contact.language ?? order.language }
  }
  const contacts = await db.partyContact.findMany({
    where: { partyId: order.partyId, status: 'ACTIVE', erasedAt: null, email: { not: null }, roles: { has: 'ORDERS' } },
    select: { email: true, language: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 3,
  })
  return { to: contacts.flatMap((contact) => (contact.email ? [contact.email] : [])), language: contacts[0]?.language ?? order.language }
}
