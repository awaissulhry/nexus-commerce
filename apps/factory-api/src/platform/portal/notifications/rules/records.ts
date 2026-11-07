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
import type { PartnerReader } from '../../tasks/people'
import type { PartnerDraft, PartnerRule } from './types'

/**
 * News of a partner's records from the W1/W2a modules' own events (B-W2b-167, PLT-148; design portal.frame Notifications,
 * E-mail settings topics "orders confirmed, dates changed, shipped, invoices, claims, documents ready, messages"):
 *
 *   purchase_order.sent         ORDERS    "New purchase order PO-…"            to the supplier's people
 *   sales_order.created         ORDERS    "Your order SO-… is confirmed"       to the customer's people
 *   sales_order.promise_changed DATES     "The delivery date of SO-… changed (by 12 Dec)"
 *   shipment.status_changed     SHIPPED   "SH-… has shipped" (to SHIPPED only)
 *   invoice.issued              INVOICES  "Invoice FT-… was issued"            only to people whose role sees prices
 *   supplier_claim.sent         CLAIMS    "New claim SC-…"                     to the supplier's people
 *   thread.message_posted       MESSAGES  "New message from <Company> on …"   our OUTBOUND message to the partner, to the
 *                                         people who read the record's shared thread (threads.read)
 * Each to the record's party's readers (portal ON, active, roles reaching the record's company) who hold portal.home.view.
 * The portal pages of these records come later (B-W2b-174…): a step that adds a page may narrow its record's rule to the
 * roles that open it.
 */

const payload = <T>(list: readonly { type: string; payload: { parse(raw: unknown): unknown } }[], type: string, raw: unknown): T => list.find((event) => event.type === type)!.payload.parse(raw) as T

const home = (draft: { companyId: string; partyId: string }) => (reader: PartnerReader) => can(reader.actor, PORTAL_HOME_VIEW, { companyId: draft.companyId, partyId: draft.partyId })
const withPrice = (draft: { companyId: string; partyId: string }) => (reader: PartnerReader) => home(draft)(reader) && heldGrains(reader.actor).has('price')

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
      const order = await context.tx.salesOrder.findUnique({ where: { id: event.orderId }, select: { id: true, number: true, companyId: true, partyId: true } })
      if (!order) return []
      return [draft({ partyId: order.partyId, companyId: order.companyId, record: { type: 'SalesOrder', id: order.id, label: order.number }, messageKey: 'portal.order.confirmed', params: {}, anchor: null })]
    },
  },
  {
    name: 'portalNews.promiseChanged',
    events: ['sales_order.promise_changed'],
    async drafts(context, raw) {
      const event = payload<{ orderId: string; promiseDate: string }>(salesEvents, 'sales_order.promise_changed', raw)
      const order = await context.tx.salesOrder.findUnique({ where: { id: event.orderId }, select: { id: true, number: true, companyId: true, partyId: true } })
      if (!order) return []
      // The new date at noon Rome time: the sentence's "(by 12 Dec)" is a day.
      return [draft({ partyId: order.partyId, companyId: order.companyId, record: { type: 'SalesOrder', id: order.id, label: order.number }, messageKey: 'portal.order.dates_changed', params: { dueAt: `${event.promiseDate}T11:00:00.000Z` }, anchor: null })]
    },
  },
  {
    name: 'portalNews.shipped',
    events: ['shipment.status_changed'],
    async drafts(context, raw) {
      const event = payload<{ shipmentId: string; to: string }>(shippingEvents, 'shipment.status_changed', raw)
      if (event.to !== 'SHIPPED') return []
      const shipment = await context.tx.shipment.findUnique({ where: { id: event.shipmentId }, select: { id: true, number: true, companyId: true, partyId: true } })
      if (!shipment) return []
      return [draft({ partyId: shipment.partyId, companyId: shipment.companyId, record: { type: 'Shipment', id: shipment.id, label: shipment.number }, messageKey: 'portal.shipment.shipped', params: {}, anchor: null })]
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
      const event = payload<{ threadId: string; messageId: string; recordType: string; recordId: string; direction: string; audience: string }>(threadEvents, 'thread.message_posted', raw)
      if (event.direction !== 'OUTBOUND' || event.audience !== 'PARTNER') return []
      const thread = await context.tx.thread.findUnique({ where: { id: event.threadId }, select: { companyId: true, partyId: true, recordType: true, recordId: true } })
      if (!thread?.partyId || !thread.companyId) return []
      const label = (await recordLabelOf(context.tx, thread.recordType, thread.recordId)) ?? thread.recordType
      const place = { companyId: thread.companyId, partyId: thread.partyId }
      return [
        {
          partyId: thread.partyId,
          companyId: thread.companyId,
          record: { type: thread.recordType, id: thread.recordId, label },
          messageKey: 'portal.message.posted',
          params: {},
          anchor: `message:${event.messageId}`,
          forReader: (reader) => home(place)(reader) && can(reader.actor, THREADS_READ, place),
        },
      ]
    },
  },
])
