import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { can } from '@nexus/factory-domain/core/permissions'
import { events as invoicingEvents } from '@nexus/factory-domain/invoicing/events'
import { PORTAL_HOME_VIEW } from '@nexus/factory-domain/portal/tasks/permissions'
import { events as purchasingEvents } from '@nexus/factory-domain/purchasing/events'
import { events as salesEvents } from '@nexus/factory-domain/sales/events'
import { events as shippingEvents } from '@nexus/factory-domain/shipping/events'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { recordLabelOf } from '../../../threads/labels'
// B-TH-045: a company-less thread is news only for a record the customer opens in its portal.
import { partnerViewOf } from '../../../search/partner/views'
import type { CommandTx } from '../../../../core/command'
import type { PartnerReader } from '../../tasks/people'
import type { PartnerDraft, PartnerRule, PartnerRuleContext } from './types'
import { events as emailEvents } from '@nexus/factory-domain/email/events' // B-TH-048
// B-TH-068: a project's news to its members only; a member added is told.
import { events as projectEvents } from '@nexus/factory-domain/projects/events'
import { PORTAL_PROJECTS_VIEW } from '@nexus/factory-domain/projects/permissions'
// th2-backend step 7 (§0.5): a customer's order, quote or request by its own number, never the office's series.
import { customerRefOf, type CustomerNumberKind } from '@nexus/factory-domain/sales/customer-numbers'

/**
 * News of a partner's records from the W1/W2a modules' own events (B-W2b-167, PLT-148; design portal.frame Notifications,
 * E-mail settings topics "orders confirmed, dates changed, shipped, invoices, claims, documents ready, messages"):
 *
 *   purchase_order.sent         ORDERS    "New purchase order PO-…"            to the supplier's people
 *   sales_order.created         ORDERS    "Your order SO-… is confirmed"       to the customer's people; B-TH-006: an order
 *                                         made waiting for our yes (PENDING_APPROVAL) is "received, waiting for our approval"
 *   sales_order.status_changed  ORDERS    "Your order SO-… is confirmed"       B-TH-006: when a waiting order is let go on
 *                                         (PENDING_APPROVAL → CONFIRMED)
 *   sales_order.promise_changed DATES     "The delivery date of SO-… changed (by 12 Dec)"
 *   shipment.status_changed     SHIPPED   "A delivery of your order 12 has shipped" (to SHIPPED only; th3b follow-up 5: the
 *                                         customer's own order number, never the office's SH-… series)
 *   invoice.issued              INVOICES  "Invoice FT-… was issued"            only to people whose role sees prices
 *   supplier_claim.sent         CLAIMS    "New claim SC-…"                     to the supplier's people
 *   thread.message_posted       MESSAGES  "New message from <Company> on …"   our OUTBOUND message to the partner, to the
 *                                         people who read the record's shared thread (threads.read); B-TH-045: also on a
 *                                         thread with no company (the account conversation), and a batch is one bell item;
 *                                         B-TH-048: a mail from the thread's composer only when it leaves its undo window
 *                                         (email.status_changed SENT or FAILED), never one taken back
 * Each to the record's party's readers (portal ON, active, roles reaching the record's company) who hold portal.home.view.
 * The portal pages of these records come later (B-W2b-174…): a step that adds a page may narrow its record's rule to the
 * roles that open it.
 */

/** B-TH-045: the most companies of a tenant a company-less thread's news is drafted for (a tenant has a handful). */
const MAX_COMPANIES = 50

const payload = <T>(list: readonly { type: string; payload: { parse(raw: unknown): unknown } }[], type: string, raw: unknown): T => list.find((event) => event.type === type)!.payload.parse(raw) as T

const home = (draft: { companyId: string; partyId: string }) => (reader: PartnerReader) => can(reader.actor, PORTAL_HOME_VIEW, { companyId: draft.companyId, partyId: draft.partyId })
const withPrice = (draft: { companyId: string; partyId: string }) => (reader: PartnerReader) => home(draft)(reader) && heldGrains(reader.actor).has('price')

// ── B-TH-006 ──
/**
 * Whether the order was made waiting for our yes (PENDING_APPROVAL). Nothing moves INTO PENDING_APPROVAL later (B-W2b-281's
 * guard): an order waits only from its making, and the order's own audit rows say so — the making's `after.status`, and every
 * move out of it (the yes, the credit let go, the measures checked, the cancel) has `before.status` PENDING_APPROVAL.
 */
async function madeWaiting(tx: CommandTx, order: { readonly id: string; readonly status: string }): Promise<boolean> {
  if (order.status === 'PENDING_APPROVAL') return true
  const waited = await tx.auditLog.findFirst({
    where: { recordType: 'SalesOrder', recordId: order.id, OR: [{ after: { path: ['status'], equals: 'PENDING_APPROVAL' } }, { before: { path: ['status'], equals: 'PENDING_APPROVAL' } }] },
    select: { id: true },
  })
  return waited !== null
}
// ── end B-TH-006 ──

// ── th2-backend step 7 (threads plan §0.5): what a customer's notice names — its own number ("#12" on the chip, "your order 12" in
// the sentence through params.yourKind / yourSeq), never SO-…, QT-… or INQ-…. A supplier's or another record keeps its label.
const CUSTOMER_KINDS: Readonly<Record<string, CustomerNumberKind>> = Object.freeze({ SalesOrder: 'ORDER', Quote: 'QUOTE', Inquiry: 'REQUEST' })

/** The customer's own number of an order (the chip and the sentence's params). */
export function orderNamed(order: { readonly id: string; readonly customerSeq: number | null }) {
  return { record: { type: 'SalesOrder', id: order.id, label: customerRefOf('ORDER', order.customerSeq) ?? '—' }, params: { yourKind: 'ORDER', yourSeq: order.customerSeq } }
}

/** A record of a customer by its own number (SalesOrder, Quote, Inquiry), read in the fan-out's scope; null: not one of those. */
async function customerNamed(tx: CommandTx, recordType: string, recordId: string): Promise<{ label: string; params: Record<string, string | number | null> } | null> {
  const kind = CUSTOMER_KINDS[recordType]
  if (!kind) return null
  const row =
    recordType === 'SalesOrder'
      ? await tx.salesOrder.findUnique({ where: { id: recordId }, select: { customerSeq: true } })
      : recordType === 'Quote'
        ? await tx.quote.findUnique({ where: { id: recordId }, select: { customerSeq: true } })
        : await tx.inquiry.findUnique({ where: { id: recordId }, select: { customerSeq: true } })
  return { label: customerRefOf(kind, row?.customerSeq ?? null) ?? '—', params: { yourKind: kind, yourSeq: row?.customerSeq ?? null } }
}
// ── end th2-backend step 7 ──

function draft(input: Omit<PartnerDraft, 'forReader'>, forReader: (draft: { companyId: string; partyId: string }) => (reader: PartnerReader) => boolean = home): PartnerDraft {
  return { ...input, forReader: forReader(input) }
}

export const RECORD_RULES: readonly PartnerRule[] = Object.freeze([
  {
    name: 'portalNews.purchaseOrderSent',
    events: ['purchase_order.sent'],
    async drafts(context, raw) {
      const event = payload<{ purchaseOrderId: string; number: string; revision: number }>(purchasingEvents, 'purchase_order.sent', raw)
      const order = await context.tx.purchaseOrder.findUnique({ where: { id: event.purchaseOrderId }, select: { id: true, number: true, companyId: true, partyId: true } })
      if (!order) return []
      return [draft({ partyId: order.partyId, companyId: order.companyId, record: { type: 'PurchaseOrder', id: order.id, label: order.number }, messageKey: 'portal.order.sent', params: { revision: event.revision }, anchor: null })]
    },
  },
  {
    name: 'portalNews.salesOrderConfirmed',
    events: ['sales_order.created'],
    async drafts(context, raw) {
      const event = payload<{ orderId: string }>(salesEvents, 'sales_order.created', raw)
      const order = await context.tx.salesOrder.findUnique({ where: { id: event.orderId }, select: { id: true, number: true, companyId: true, partyId: true, status: true, customerSeq: true } })
      if (!order) return []
      // ── B-TH-006 (L2-G06): "confirmed" only for an order made confirmed. One made waiting for our yes is received; its
      // confirmed news follows the yes (the rule below). Decided by how the order was MADE, not by its state when the worker
      // reads it: a yes given before this event is handled sends the confirmed news once, from its own event.
      if (await madeWaiting(context.tx, order)) {
        if (order.status === 'CANCELLED') return []
        return [draft({ partyId: order.partyId, companyId: order.companyId, ...orderNamed(order), messageKey: 'portal.order.received', anchor: null })]
      }
      // ── end B-TH-006 ──
      return [draft({ partyId: order.partyId, companyId: order.companyId, ...orderNamed(order), messageKey: 'portal.order.confirmed', anchor: null })]
    },
  },
  // ── B-TH-006 (L2-G06): the yes on a waiting order (credit, a SALES_ORDER rule, measures checked) is the confirmed news. ──
  {
    name: 'portalNews.salesOrderApproved',
    events: ['sales_order.status_changed'],
    async drafts(context, raw) {
      const event = payload<{ orderId: string; from: string; to: string }>(salesEvents, 'sales_order.status_changed', raw)
      if (event.from !== 'PENDING_APPROVAL' || event.to !== 'CONFIRMED') return []
      // The party from the record, never from the event (W06).
      const order = await context.tx.salesOrder.findUnique({ where: { id: event.orderId }, select: { id: true, number: true, companyId: true, partyId: true, customerSeq: true } })
      if (!order) return []
      return [draft({ partyId: order.partyId, companyId: order.companyId, ...orderNamed(order), messageKey: 'portal.order.confirmed', anchor: null })]
    },
  },
  // ── end B-TH-006 ──
  {
    name: 'portalNews.promiseChanged',
    events: ['sales_order.promise_changed'],
    async drafts(context, raw) {
      const event = payload<{ orderId: string; promiseDate: string }>(salesEvents, 'sales_order.promise_changed', raw)
      const order = await context.tx.salesOrder.findUnique({ where: { id: event.orderId }, select: { id: true, number: true, companyId: true, partyId: true, customerSeq: true } })
      if (!order) return []
      // The new date at noon Rome time: the sentence's "(by 12 Dec)" is a day.
      const named = orderNamed(order)
      return [draft({ partyId: order.partyId, companyId: order.companyId, record: named.record, messageKey: 'portal.order.dates_changed', params: { ...named.params, dueAt: `${event.promiseDate}T11:00:00.000Z` }, anchor: null })]
    },
  },
  {
    name: 'portalNews.shipped',
    events: ['shipment.status_changed'],
    async drafts(context, raw) {
      const event = payload<{ shipmentId: string; to: string }>(shippingEvents, 'shipment.status_changed', raw)
      if (event.to !== 'SHIPPED') return []
      // ── th3b follow-up 5 (threads plan §0.5, counts do not leak): the customer reads its own order's number ("A delivery of your
      // order 12 has shipped", chip "#12"), never the office's shipment series (SH-…); the link stays the shipment's.
      const shipment = await context.tx.shipment.findUnique({ where: { id: event.shipmentId }, select: { id: true, companyId: true, partyId: true, salesOrder: { select: { id: true, customerSeq: true } } } })
      if (!shipment) return []
      const named = orderNamed(shipment.salesOrder)
      return [draft({ partyId: shipment.partyId, companyId: shipment.companyId, record: { type: 'Shipment', id: shipment.id, label: named.record.label }, messageKey: 'portal.shipment.shipped', params: named.params, anchor: null })]
      // ── end th3b follow-up 5
    },
  },
  {
    name: 'portalNews.invoiceIssued',
    events: ['invoice.issued'],
    async drafts(context, raw) {
      const event = payload<{ invoiceId: string; number: string; partyId: string }>(invoicingEvents, 'invoice.issued', raw)
      const invoice = await context.tx.invoice.findUnique({ where: { id: event.invoiceId }, select: { id: true, companyId: true, partyId: true } })
      if (!invoice || !invoice.partyId) return []
      return [draft({ partyId: invoice.partyId, companyId: invoice.companyId, record: { type: 'Invoice', id: invoice.id, label: event.number }, messageKey: 'portal.invoice.issued', params: {}, anchor: null }, withPrice)]
    },
  },
  {
    name: 'portalNews.claimSent',
    events: ['supplier_claim.sent'],
    async drafts(context, raw) {
      const event = payload<{ supplierClaimId: string }>(purchasingEvents, 'supplier_claim.sent', raw)
      const claim = await context.tx.supplierClaim.findUnique({ where: { id: event.supplierClaimId }, select: { id: true, number: true, companyId: true, partyId: true } })
      if (!claim) return []
      return [draft({ partyId: claim.partyId, companyId: claim.companyId, record: { type: 'SupplierClaim', id: claim.id, label: claim.number }, messageKey: 'portal.claim.sent', params: {}, anchor: null })]
    },
  },
  {
    name: 'portalNews.messagePosted',
    events: ['thread.message_posted'],
    async drafts(context, raw) {
      const event = payload<{ threadId: string; messageId: string; recordType: string; recordId: string; direction: string; audience: string; batchId?: string }>(threadEvents, 'thread.message_posted', raw)
      if (event.direction !== 'OUTBOUND' || event.audience !== 'PARTNER') return []
      // B-TH-048: a mail that waits in its undo window is news only once it leaves (portalNews.mailLeft): never one taken back.
      if (await windowedMail(context.tx, event.messageId)) return []
      return messageDrafts(context, event)
    },
  },
  // ── B-TH-048 (undo send, threads plan TH-3): the news of our mail from a thread's composer comes when it leaves its 10 seconds
  // (sent, or failed: its message is no longer held, so the customer reads it in its portal); a mail taken back never tells anyone.
  {
    name: 'portalNews.mailLeft',
    events: ['email.status_changed'],
    async drafts(context, raw) {
      const event = payload<{ outboundId: string; status: string }>(emailEvents, 'email.status_changed', raw)
      if (event.status !== 'SENT' && event.status !== 'FAILED') return []
      const mail = await context.tx.emailOutbound.findUnique({ where: { id: event.outboundId }, select: { threadId: true, messageId: true, sendAfter: true } })
      if (!mail?.threadId || !mail.messageId || mail.sendAfter === null) return []
      const message = await context.tx.message.findUnique({ where: { id: mail.messageId }, select: { direction: true, audience: true, held: true } })
      if (!message || message.direction !== 'OUTBOUND' || message.audience !== 'PARTNER' || message.held) return []
      return messageDrafts(context, { threadId: mail.threadId, messageId: mail.messageId })
    },
  },
  // ── end B-TH-048
  // ── B-TH-068 (PROJ.members-F04, F07): a portal person the office added to a project of their company is told so, in their portal
  // and by their mail setting — that person only (never their colleagues: a project is per member).
  {
    name: 'portalNews.projectAdded',
    events: ['project.person_added'],
    async drafts(context, raw) {
      const event = payload<{ projectId: string; userId: string; outside: boolean }>(projectEvents, 'project.person_added', raw)
      if (!event.outside) return []
      const project = await context.tx.project.findUnique({ where: { id: event.projectId }, select: { id: true, companyId: true, partyId: true, name: true, status: true } })
      if (!project?.partyId || project.status === 'CLOSED') return []
      const scope = { companyId: project.companyId, partyId: project.partyId }
      return [
        draft(
          // fix-portal-numbers-1 (B-TH-303, as B-TH-253's Messages card): the project by its name, never the office's project series.
          { partyId: project.partyId, companyId: project.companyId, record: { type: 'Project', id: project.id, label: project.name }, messageKey: 'portal.project.added', params: {}, anchor: null },
          (target) => (reader) => home(target)(reader) && reader.personId === event.userId && can(reader.actor, PORTAL_PROJECTS_VIEW, scope),
        ),
      ]
    },
  },
  // ── end B-TH-068
])

// ── B-TH-048: the mail of a message that waited in an undo window (sendAfter), if any.
async function windowedMail(tx: CommandTx, messageId: string): Promise<boolean> {
  return (await tx.emailOutbound.findFirst({ where: { messageId, sendAfter: { not: null } }, select: { id: true } })) !== null
}

/** The news of our OUTBOUND shared message to the thread's party (portalNews.messagePosted; B-TH-048's portalNews.mailLeft). */
async function messageDrafts(context: PartnerRuleContext, event: { readonly threadId: string; readonly messageId: string; readonly batchId?: string }): Promise<readonly PartnerDraft[]> {
  const thread = await context.tx.thread.findUnique({ where: { id: event.threadId }, select: { companyId: true, partyId: true, recordType: true, recordId: true } })
  if (!thread?.partyId) return []
  const partyId = thread.partyId
  // th2-backend step 7: a customer's order, quote or request by its own number; any other record by its label.
  const named = await customerNamed(context.tx, thread.recordType, thread.recordId)
  const label = named?.label ?? (await recordLabelOf(context.tx, thread.recordType, thread.recordId)) ?? thread.recordType
  // ── B-TH-045 (threads plan TH-3, thread-G04): a thread with no company — the account conversation of a customer every company
  // serves (its Party record is tenant-wide) — tells the party's people too: one draft per company whose portal they may use (the
  // fan-out tells each person once, under the first). The party is the thread's, never the event's (W06).
  // Only a record the customer opens in its portal (its partner view: the account itself): a company-less thread of a record with
  // no portal page (a rider's measurements) stays news for the office alone.
  if (!thread.companyId && !partnerViewOf(thread.recordType)) return []
  const companies = thread.companyId ? [thread.companyId] : (await context.tx.company.findMany({ orderBy: { id: 'asc' }, take: MAX_COMPANIES, select: { id: true } })).map((row) => row.id)
  const threadScope = { companyId: thread.companyId, partyId }
  // ── B-TH-068 (threads plan TH-5, PROJ-G06; wall W06): a project's news reaches only its MEMBERS — the portal people of its outside
  // company the office added one by one (and who did not mute it), who may see projects in their portal; never every reader of
  // the party. The party wall stays the database's: the thread's party is the project's own.
  const members = thread.recordType === 'Project' ? await projectMembers(context.tx, thread.recordId, partyId) : null
  // ── end B-TH-068
  return companies.map((companyId) => ({
    partyId,
    companyId,
    record: { type: thread.recordType, id: thread.recordId, label },
    messageKey: 'portal.message.posted' as const,
    params: named?.params ?? {},
    anchor: `message:${event.messageId}`,
    // A batch of ours (one answer to several records of the customer) is one bell item.
    batchId: event.batchId ?? null,
    forReader: (reader: PartnerReader) =>
      home({ companyId, partyId })(reader) && can(reader.actor, THREADS_READ, threadScope) && (members === null || (members.has(reader.personId) && can(reader.actor, PORTAL_PROJECTS_VIEW, threadScope))), // B-TH-068
  }))
  // ── end B-TH-045
}

// ── B-TH-068: a project's portal members (their rows name the project's party), muted ones left out.
async function projectMembers(tx: CommandTx, projectId: string, partyId: string): Promise<Set<string>> {
  const rows = await tx.recordFollower.findMany({ where: { recordType: 'Project', recordId: projectId, partyId, muted: false }, select: { userId: true } })
  return new Set(rows.map((row) => row.userId))
}
