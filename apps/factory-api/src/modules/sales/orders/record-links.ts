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
// B-OP-043 (order page N6, lines-derived): an order's shipments through their lines.
import { shipmentsOfOrderWhere } from '../../shipping/shipments/orders-of'
// B-SC-005 (stage control B, the red notice in plain words): what a phrase key prints, to say a refusal without its code.
import { approvedTexts } from '../../compliance/phrases/store'

/**
 * What points at a sales order (B-TH-077; threads plan TH-6, gaps X-G02, ORD-G04, ORD-G09; design O-SAL-ORD-REC.body and
 * .notice, picture 29): GET /sales/orders/:orderId/links (orders.view over the order). One read for the order's record:
 *
 *   complaints  the complaints made against it (Complaint.salesOrderId): number, status, when, the triage — with
 *               quality.complaints.view over each (null: the reader holds no complaint right, the section is not drawn).
 *               B-OS-004: also those about one of its shipments only (Complaint.shipmentId), each naming its shipment
 *   returns     its returns (ReturnAuthorisation.salesOrderId): number, status, when — with sales.returns.view over each
 *               (null: the reader holds no return right). B-OS-004: also a return whose lines are of this order's lines (one
 *               across two orders shows on both), with its pieces of this order and its replacement order; `truncated` says
 *               when a list stopped at 50
 *   rePromises  planning's re-promise proposals still WAITING for sales (B-W2b-317): the line, the dates per size, the reason,
 *               who proposed; accept and decline go to the planning routes (POST /planning/promises/re-promises/:id/accept |
 *               decline), with orders.manage over the order and never by the person who proposed (`may`); the production
 *               manager reads them only
 *   gates       the compliance gates' refusals that still block the order's work orders and shipments (GateEvent REFUSED,
 *               not overridden, not passed since): the place and the gate's own sentence for every order reader; the event
 *               (to open in Compliance › Gate refusals, where an override is made) only with compliance.certificates.view.
 *               B-SC-005: the sentence in plain words, never a code — an older stored sentence that quotes its phrase key
 *               ('the warning "warning.class-a" has no approved German words', explanation.phrase) says the phrase's own
 *               words in its place (sayPhraseWords), else drops the quoted key; nothing stored is changed
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
        .array(
          output({
            id: id(),
            number: z.string(),
            status: z.string(),
            receivedAt: instant(),
            category: z.string().nullable(),
            severity: z.string().nullable(),
            answerDueOn: businessDateSchema().nullable(),
            /** B-OS-004: the shipment it is about (one of the order's), when it names one. */
            shipment: output({ id: id(), number: z.string() }).nullable(),
          }),
        )
        .nullable(),
      returns: z
        .array(
          output({
            id: id(),
            number: z.string(),
            status: z.string(),
            requestedAt: instant(),
            closedAt: instant().nullable(),
            outcomeWanted: z.string().nullable(),
            // ── B-OS-004: its pieces of THIS order's lines (a return across two orders shows on both, each with its own), and the
            // replacement order made for it. A return line names no shipment: which shipment the pieces came from is not known. ──
            pieces: z.number().int(),
            replacementOrder: output({ id: id(), number: z.string() }).nullable(),
          }),
        )
        .nullable(),
      /** B-OS-004 (H4-B3): a list stopped at 50 rows while more exist ("N more ›": its own page lists them all). */
      truncated: output({ complaints: z.boolean(), returns: z.boolean() }),
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

// ── B-SC-005 (stage control B: the red notice in plain words) ──
/**
 * The phrase key a refusal's facts name (`explanation.phrase`) when its stored sentence quotes that very key — an older sentence,
 * written before the gate named a warning by its words (seed fix F-OP-313). null: nothing to say again.
 */
export function quotedPhraseKeyOf(reason: string, explanation: unknown): string | null {
  const facts = explanation !== null && typeof explanation === 'object' && !Array.isArray(explanation) ? (explanation as Record<string, unknown>) : null
  const key = typeof facts?.phrase === 'string' ? facts.phrase.trim() : ''
  return key !== '' && reason.includes(`"${key}"`) ? key : null
}

/** The sentence with its quoted phrase key said in the phrase's own words — with none found, the quoted key dropped. Never a code. */
export function sayPhraseWords(reason: string, key: string, words: string | null): string {
  const quoted = `"${key}"`
  const text = words?.trim() ?? ''
  if (text !== '') return reason.split(quoted).join(`"${text}"`)
  return reason.split(` ${quoted}`).join('').split(quoted).join('')
}

/** A refusal's sentence as the order page says it (B-SC-005). */
function plainReasonOf(reason: string, explanation: unknown, words: ReadonlyMap<string, string>): string {
  const key = quotedPhraseKeyOf(reason, explanation)
  return key === null ? reason : sayPhraseWords(reason, key, words.get(key) ?? null)
}

/** What each key prints in English (the approved words: the source or its approved translation), else its source words; once. */
async function phraseWordsOf(db: Reader, keys: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const words = new Map<string, string>()
  if (keys.length === 0) return words
  for (const row of await approvedTexts(db, keys, ['en'])) if (row.text && row.text.trim() !== '') words.set(row.key, row.text)
  const missing = keys.filter((key) => !words.has(key))
  if (missing.length > 0) {
    for (const row of await db.phrase.findMany({ where: { key: { in: missing } }, select: { key: true, sourceText: true } })) if (row.sourceText.trim() !== '') words.set(row.key, row.sourceText)
  }
  return words
}
// ── end B-SC-005 ──

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
    return caller.withClient(async (db) => {
    const head = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, number: true } })

    // ── B-OS-004 (order shipments tab; H4-B1, H4-B2, H4-B3): the order's lines and shipments first (all of its customer and company:
    // W27) — a complaint about one of its shipments and a return of its lines show too; a list says when it stopped at LIMIT ──
    const orderLineIds = (await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
    // B-OP-043 (order page N6): the shipments made for it or carrying its garments (all of its customer and company).
    const shipments = await db.shipment.findMany({ where: { ...shipmentsOfOrderWhere(order.id), partyId: order.partyId, companyId: order.companyId }, select: { id: true, number: true } })
    const shipmentNumbers = new Map(shipments.map((row) => [row.id, row.number]))
    const truncated = { complaints: false, returns: false }
    // ── end B-OS-004 ──

    // Complaints and returns: the order's own customer's only (W27), each by its own right.
    const complaints = holds(actor, QUALITY_COMPLAINTS_VIEW)
      ? await (async () => {
          const rows = await db.complaint.findMany({
            // B-OS-004 (H4-B1): also those about one of its shipments only (Complaint.shipmentId), still of its own customer and company.
            where: { partyId: order.partyId, companyId: order.companyId, OR: [{ salesOrderId: order.id }, ...(shipments.length > 0 ? [{ shipmentId: { in: shipments.map((row) => row.id) } }] : [])] },
            select: { id: true, companyId: true, partyId: true, number: true, status: true, receivedAt: true, category: true, severity: true, answerDueOn: true, /* B-OS-004 */ shipmentId: true },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            take: LIMIT + 1, // B-OS-004 (H4-B3): one more says there are more
          })
          truncated.complaints = rows.length > LIMIT
          return rows
            .slice(0, LIMIT)
            .filter((row) => can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: row.companyId, partyId: row.partyId }))
            .map((row) => ({
              id: row.id,
              number: row.number,
              status: row.status,
              receivedAt: toUtcIso(row.receivedAt),
              category: row.category,
              severity: row.severity,
              answerDueOn: day(row.answerDueOn),
              shipment: row.shipmentId && shipmentNumbers.has(row.shipmentId) ? { id: row.shipmentId, number: shipmentNumbers.get(row.shipmentId)! } : null, // B-OS-004
            }))
        })()
      : null
    const returns = holds(actor, SALES_RETURNS_VIEW)
      ? await (async () => {
          const rows = await db.returnAuthorisation.findMany({
            // B-OS-004 (H4-B2): also a return naming another order (or none) whose lines are of this order's lines.
            where: { partyId: order.partyId, companyId: order.companyId, OR: [{ salesOrderId: order.id }, ...(orderLineIds.length > 0 ? [{ lines: { some: { salesOrderLineId: { in: orderLineIds } } } }] : [])] },
            select: { id: true, companyId: true, siteId: true, partyId: true, number: true, status: true, requestedAt: true, closedAt: true, outcomeWanted: true, /* B-OS-004 */ replacementOrderId: true },
            orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
            take: LIMIT + 1, // B-OS-004 (H4-B3)
          })
          truncated.returns = rows.length > LIMIT
          const visible = rows.slice(0, LIMIT).filter((row) => can(actor, SALES_RETURNS_VIEW, { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId }))
          // B-OS-004: each return's pieces of THIS order's lines (one read), and its replacement order's number (one read).
          const pieces =
            visible.length > 0 && orderLineIds.length > 0
              ? new Map((await db.returnLine.groupBy({ by: ['returnId'], where: { returnId: { in: visible.map((row) => row.id) }, salesOrderLineId: { in: orderLineIds } }, _sum: { quantity: true } })).map((row) => [row.returnId, row._sum.quantity ?? 0]))
              : new Map<string, number>()
          const replacementIds = [...new Set(visible.flatMap((row) => (row.replacementOrderId ? [row.replacementOrderId] : [])))]
          const replacements = new Map((replacementIds.length > 0 ? await db.salesOrder.findMany({ where: { id: { in: replacementIds }, partyId: order.partyId }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
          return visible.map((row) => ({
            id: row.id,
            number: row.number,
            status: row.status,
            requestedAt: toUtcIso(row.requestedAt),
            closedAt: iso(row.closedAt),
            outcomeWanted: row.outcomeWanted,
            // ── B-OS-004 ──
            pieces: pieces.get(row.id) ?? 0,
            replacementOrder: row.replacementOrderId && replacements.has(row.replacementOrderId) ? { id: row.replacementOrderId, number: replacements.get(row.replacementOrderId)! } : null,
            // ── end B-OS-004 ──
          }))
        })()
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

    // The gates' refusals that still block the order's work orders (every cell of this customer) and shipments (B-OS-004: the
    // order's lines and shipments read above).
    const cells = orderLineIds.length > 0 ? await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: orderLineIds } }, select: { workOrderId: true } }) : []
    const touched = [...new Set(cells.map((cell) => cell.workOrderId))]
    const foreign = touched.length > 0 ? await db.workOrderSize.findMany({ where: { workOrderId: { in: touched }, OR: [{ partyId: null }, { partyId: { not: order.partyId } }] }, select: { workOrderId: true }, distinct: ['workOrderId'] }) : []
    const mixed = new Set(foreign.map((cell) => cell.workOrderId))
    const workOrderIds = touched.filter((workOrderId) => !mixed.has(workOrderId))
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
            select: { id: true, companyId: true, gate: true, subjectType: true, subjectId: true, requirementId: true, styleId: true, reason: true, explanation: true /* B-SC-005 */, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 200,
          })
        : []
    const overridden = refusals.length > 0 ? await db.gateEvent.findMany({ where: { outcome: 'OVERRIDDEN', refusedEventId: { in: refusals.map((row) => row.id) }, overrideUntil: { gt: now } }, select: { refusedEventId: true } }) : []
    const lifted = new Set(overridden.map((row) => row.refusedEventId))
    const styleIds = [...new Set(refusals.flatMap((row) => (row.styleId ? [row.styleId] : [])))]
    const styles = new Map((styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
    const opens = can(actor, CERTIFICATES_VIEW, { companyId: order.companyId })
    // B-SC-005: the phrase keys older sentences quote, read once.
    const phraseWords = await phraseWordsOf(db, [...new Set(refusals.flatMap((row) => quotedPhraseKeyOf(row.reason, row.explanation) ?? []))])
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
        // B-SC-005: in plain words — a quoted phrase key says the phrase's words (or goes).
        reason: plainReasonOf(row.reason, row.explanation, phraseWords),
      })
    }
    return { order: { id: head.id, number: head.number }, complaints, returns, /* B-OS-004 */ truncated, rePromises, gates, asOf: toUtcIso(now) }
  })
}
