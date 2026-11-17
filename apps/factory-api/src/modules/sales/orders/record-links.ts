import { z } from 'zod'
import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { COMPLIANCE_GATES, GATE_WORDS, type ComplianceGate } from '@nexus/factory-domain/compliance/requirements/rules'
import { businessDate as businessDateSchema, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { EMAIL_SEND } from '@nexus/factory-domain/auth/permissions/catalogue'
import { PROPOSAL_STATES, proposalWords } from '@nexus/factory-domain/planning/promise-keep/repromise'
import { dayWords } from '@nexus/factory-domain/planning/promise/rules'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { readProposals } from '../../planning/promise-keep/store'
import { officeContextOf } from './access'
import { officeOrder } from './moves'
import type { Reader } from './store'

/**
 * What points at a sales order (B-TH-077; threads plan TH-6, gaps X-G02, ORD-G04, ORD-G09; design O-SAL-ORD-REC.body and
 * .notice, picture 29): GET /sales/orders/:orderId/links (orders.view over the order). One read for the order's record:
 *
 *   complaints  the complaints made against it (Complaint.salesOrderId): number, status, when, the triage — with
 *               quality.complaints.view over each (null: the reader holds no complaint right, the section is not drawn)
 *   returns     its returns (ReturnAuthorisation.salesOrderId): number, status, when — with sales.returns.view over each
 *               (null: the reader holds no return right)
 *   rePromises  planning's re-promise proposals still WAITING for sales (B-W2b-317): the line, the dates per size, the reason,
 *               who proposed; accept and decline go to the planning routes (POST /planning/promises/re-promises/:id/accept |
 *               decline), with orders.manage over the order and never by the person who proposed (`may`); the production
 *               manager reads them only
 *   gates       the compliance gates' refusals that still block the order's work orders and shipments (GateEvent REFUSED,
 *               not overridden, not passed since): the place and the gate's own sentence for every order reader; the event
 *               (to open in Compliance › Gate refusals, where an override is made) only with compliance.certificates.view
 *
 * Wall W27: only what is the order's own customer's — a complaint or a return names the order AND its customer and company
 * (one that names the order but another customer never shows), a work order counts only when every one of its cells is of
 * this order's customer (an older work order that mixes customers never lends its refusals to an order), a shipment is the
 * order's own. Nothing here writes.
 */

const LIMIT = 50
const GATE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))
const day = (date: Date | null): string | null => (date === null ? null : date.toISOString().slice(0, 10))

const person = output({ id: id(), name: z.string() })

export const recordLinksContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      order: output({ id: id(), number: z.string() }),
      complaints: z
        .array(output({ id: id(), number: z.string(), status: z.string(), receivedAt: instant(), category: z.string().nullable(), severity: z.string().nullable(), answerDueOn: businessDateSchema().nullable() }))
        .nullable(),
      returns: z.array(output({ id: id(), number: z.string(), status: z.string(), requestedAt: instant(), closedAt: instant().nullable(), outcomeWanted: z.string().nullable() })).nullable(),
      rePromises: z.array(
        output({
          id: id(),
          state: z.enum(PROPOSAL_STATES),
          line: output({ id: id(), seq: z.number().int(), styleCode: z.string().nullable() }),
          sizes: z.array(output({ size: z.string().nullable(), from: businessDateSchema().nullable(), to: businessDateSchema() })),
          reasonCode: z.string(),
          /** The planner's note (office only; never shown to the customer). */
          reason: z.string().nullable(),
          words: z.string(),
          proposedAt: instant(),
          proposedBy: person.nullable(),
          /** accept / decline: orders.manage over the order and not one's own proposal; tell: also email.send (the customer is told only with the tick). */
          may: output({ accept: z.boolean(), decline: z.boolean(), tell: z.boolean() }),
        }),
      ),
      gates: z.array(
        output({
          /** The refusal, to open in Compliance › Gate refusals (null: the reader has no compliance view right — words only). */
          eventId: id().nullable(),
          gate: z.enum(COMPLIANCE_GATES),
          place: z.string(),
          at: instant(),
          subject: output({ type: z.enum(['WorkOrder', 'Shipment']), id: id(), number: z.string().nullable() }),
          styleCode: z.string().nullable(),
          /** The gate's own sentence (who can fix it, how). */
          reason: z.string(),
        }),
      ),
      asOf: instant(),
    }),
  },
})

/** Has the subject passed this gate since the refusal (compliance/gates events.ts says the same for its feed)? */
async function passedSince(db: Reader, row: { readonly gate: string; readonly subjectId: string; readonly createdAt: Date }): Promise<boolean> {
  switch (row.gate as ComplianceGate) {
    case 'WORK_ORDER_RELEASE': {
      const workOrder = await db.workOrder.findUnique({ where: { id: row.subjectId }, select: { releasedAt: true } })
      return !!workOrder?.releasedAt && workOrder.releasedAt.getTime() >= row.createdAt.getTime()
    }
    case 'LABEL_PRINT':
      return (await db.garmentLabelPrint.count({ where: { workOrderId: row.subjectId, createdAt: { gte: row.createdAt } } })) > 0
    case 'FINAL_RELEASE':
      return (await db.qualityRelease.count({ where: { workOrderId: row.subjectId, releasedAt: { gte: row.createdAt } } })) > 0
    case 'SHIPMENT': {
      const shipment = await db.shipment.findUnique({ where: { id: row.subjectId }, select: { status: true, shippedAt: true } })
      return !!shipment && (shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED') && !!shipment.shippedAt && shipment.shippedAt.getTime() >= row.createdAt.getTime()
    }
    default:
      return false
  }
}

/** GET /sales/orders/:orderId/links — what points at the order (see the module comment). */
export async function orderLinks(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const order = await officeOrder(caller, orderId)
  const now = serverClock.now()
  const today = businessDate(now)
  const own = { salesOrderId: order.id, partyId: order.partyId, companyId: order.companyId }
  return caller.withClient(async (db) => {
    const head = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, number: true } })

    // Complaints and returns: the order's own customer's only (W27), each by its own right.
    const complaints = holds(actor, QUALITY_COMPLAINTS_VIEW)
      ? (
          await db.complaint.findMany({
            where: own,
            select: { id: true, companyId: true, partyId: true, number: true, status: true, receivedAt: true, category: true, severity: true, answerDueOn: true },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            take: LIMIT,
          })
        )
          .filter((row) => can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: row.companyId, partyId: row.partyId }))
          .map((row) => ({ id: row.id, number: row.number, status: row.status, receivedAt: toUtcIso(row.receivedAt), category: row.category, severity: row.severity, answerDueOn: day(row.answerDueOn) }))
      : null
    const returns = holds(actor, SALES_RETURNS_VIEW)
      ? (
          await db.returnAuthorisation.findMany({
            where: own,
            select: { id: true, companyId: true, siteId: true, partyId: true, number: true, status: true, requestedAt: true, closedAt: true, outcomeWanted: true },
            orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
            take: LIMIT,
          })
        )
          .filter((row) => can(actor, SALES_RETURNS_VIEW, { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId }))
          .map((row) => ({ id: row.id, number: row.number, status: row.status, requestedAt: toUtcIso(row.requestedAt), closedAt: iso(row.closedAt), outcomeWanted: row.outcomeWanted }))
      : null

    // Planning's re-promises still waiting for sales: accept or decline with orders.manage, never one's own.
    const waiting = (await readProposals(db, [order.id])).filter((proposal) => proposal.state === 'WAITING')
    const lineIds = [...new Set(waiting.map((proposal) => proposal.orderLineId))]
    const lines = new Map((lineIds.length > 0 ? await db.salesOrderLine.findMany({ where: { id: { in: lineIds }, orderId: order.id }, select: { id: true, seq: true, style: { select: { code: true } } } }) : []).map((line) => [line.id, line]))
    const peopleIds = [...new Set(waiting.map((proposal) => proposal.proposedById))]
    const people = new Map((peopleIds.length > 0 ? await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
    const manages = can(actor, ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId })
    const mails = can(actor, EMAIL_SEND, { companyId: order.companyId, partyId: order.partyId })
    const rePromises = waiting.flatMap((proposal) => {
      const line = lines.get(proposal.orderLineId)
      if (!line) return []
      const decides = manages && proposal.proposedById !== context.actorId
      return [
        {
          id: proposal.id,
          state: proposal.state,
          line: { id: line.id, seq: line.seq, styleCode: line.style?.code ?? null },
          sizes: proposal.sizes,
          reasonCode: proposal.reasonCode,
          reason: proposal.reason,
          words: `Line ${line.seq}: ${proposalWords(proposal.sizes, (date) => dayWords(date, today))}.`,
          proposedAt: toUtcIso(proposal.proposedAt),
          proposedBy: people.has(proposal.proposedById) ? { id: proposal.proposedById, name: people.get(proposal.proposedById)! } : null,
          may: { accept: decides, decline: decides, tell: decides && mails },
        },
      ]
    })

    // The gates' refusals that still block the order's work orders (every cell of this customer) and shipments.
    const orderLineIds = (await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
    const cells = orderLineIds.length > 0 ? await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: orderLineIds } }, select: { workOrderId: true } }) : []
    const touched = [...new Set(cells.map((cell) => cell.workOrderId))]
    const foreign = touched.length > 0 ? await db.workOrderSize.findMany({ where: { workOrderId: { in: touched }, OR: [{ partyId: null }, { partyId: { not: order.partyId } }] }, select: { workOrderId: true }, distinct: ['workOrderId'] }) : []
    const mixed = new Set(foreign.map((cell) => cell.workOrderId))
    const workOrderIds = touched.filter((workOrderId) => !mixed.has(workOrderId))
    const shipments = await db.shipment.findMany({ where: own, select: { id: true, number: true } })
    const workOrders = workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true } }) : []
    const numbers = new Map([...workOrders, ...shipments].map((row) => [row.id, row.number]))
    const subjects = [
      ...(workOrderIds.length > 0 ? [{ subjectType: 'WorkOrder', subjectId: { in: workOrderIds } }] : []),
      ...(shipments.length > 0 ? [{ subjectType: 'Shipment', subjectId: { in: shipments.map((row) => row.id) } }] : []),
    ]
    const refusals =
      subjects.length > 0
        ? await db.gateEvent.findMany({
            where: { outcome: 'REFUSED', companyId: order.companyId, createdAt: { gte: new Date(now.getTime() - GATE_DAYS * DAY_MS) }, OR: subjects },
            select: { id: true, companyId: true, gate: true, subjectType: true, subjectId: true, requirementId: true, styleId: true, reason: true, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 200,
          })
        : []
    const overridden = refusals.length > 0 ? await db.gateEvent.findMany({ where: { outcome: 'OVERRIDDEN', refusedEventId: { in: refusals.map((row) => row.id) }, overrideUntil: { gt: now } }, select: { refusedEventId: true } }) : []
    const lifted = new Set(overridden.map((row) => row.refusedEventId))
    const styleIds = [...new Set(refusals.flatMap((row) => (row.styleId ? [row.styleId] : [])))]
    const styles = new Map((styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
    const opens = can(actor, CERTIFICATES_VIEW, { companyId: order.companyId })
    const seen = new Set<string>()
    const gates = []
    for (const row of refusals) {
      // The newest refusal of one gate, subject and requirement only (an older one of the same is the same block).
      const key = `${row.gate}:${row.subjectType}:${row.subjectId}:${row.requirementId}`
      if (seen.has(key)) continue
      seen.add(key)
      if (lifted.has(row.id) || (await passedSince(db, row))) continue
      const gate = row.gate as ComplianceGate
      gates.push({
        eventId: opens ? row.id : null,
        gate,
        place: GATE_WORDS[gate].place,
        at: toUtcIso(row.createdAt),
        subject: { type: row.subjectType as 'WorkOrder' | 'Shipment', id: row.subjectId, number: numbers.get(row.subjectId) ?? null },
        styleCode: row.styleId ? (styles.get(row.styleId) ?? null) : null,
        reason: row.reason,
      })
    }
    return { order: { id: head.id, number: head.number }, complaints, returns, rePromises, gates, asOf: toUtcIso(now) }
  })
}
