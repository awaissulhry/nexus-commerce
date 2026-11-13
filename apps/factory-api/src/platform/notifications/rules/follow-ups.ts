import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as purchaseRequestEvents } from '@nexus/factory-domain/purchase-requests/events'
import { events as inquiryEvents } from '@nexus/factory-domain/sales-inquiries/events'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { SALES_SAFETY_MANAGE } from '@nexus/factory-domain/sales/safety-reports/permissions'
import { events as safetyReportEvents } from '@nexus/factory-domain/safety-reports/events'
import { officeActorOf } from '../view-follow/rules'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * Notifications the earlier steps asked for (B-W2b-385; follow-ups NT1:01-03):
 *
 *   purchase_requests.status_changed   NT1:01 (B-W2b-332): the person who asked to buy hears what became of it — put on a
 *                                      purchase order (CONVERTED, with the order's number), refused by the buyer (OPEN →
 *                                      REJECTED). A refusal or a yes of the request's approval is the approval engine's own
 *                                      notice (approval.decided, B-W2b-307), and its approvers hear approval.requested: not
 *                                      told twice here.
 *   inquiry.changed (ASSIGNED)         NT1:02 (B-W2b-322): the person an inquiry was given to (not when they took it
 *                                      themselves), while they may still see inquiries of its company.
 *   safety_report.received             NT1:03 (B-W2b-351): the people who assess product-safety reports (sales.safety.manage
 *                                      over the report's company: quality, the product-safety role) hear at once (ALERT); with
 *                                      an accident logged the sentence says so. Never the reporter's words or their injury.
 */

const payloadOf = (list: readonly { readonly type: string; readonly payload: { parse(value: unknown): unknown } }[], type: string) => list.find((event) => event.type === type)!.payload

export const FOLLOW_UP_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'purchasing.requestAnswered',
    events: ['purchase_requests.status_changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(purchaseRequestEvents, 'purchase_requests.status_changed').parse(raw) as { purchaseRequestId: string; from: string; to: string; purchaseOrderId: string | null; requestedById: string }
      const ordered = payload.to === 'CONVERTED'
      const refused = payload.to === 'REJECTED' && payload.from === 'OPEN'
      if (!ordered && !refused) return []
      const request = await context.tx.purchaseRequest.findUnique({ where: { id: payload.purchaseRequestId }, select: { id: true, companyId: true, status: true, description: true, rejectedById: true, convertedById: true, item: { select: { code: true } } } })
      if (!request || request.status !== payload.to) return []
      const reader = await context.reader(payload.requestedById)
      if (!reader || !holds(reader.actor, HOME_VIEW)) return []
      const order = ordered && payload.purchaseOrderId ? await context.tx.purchaseOrder.findUnique({ where: { id: payload.purchaseOrderId }, select: { number: true } }) : null
      const actorId = ordered ? request.convertedById : request.rejectedById
      const label = request.item?.code ?? (request.description ?? '').slice(0, 60)
      return [
        {
          userId: payload.requestedById,
          category: 'APPROVAL',
          record: { type: 'PurchaseRequest', id: request.id, label: label || 'Request to buy' },
          companyId: request.companyId,
          anchor: null,
          messageKey: ordered ? 'notifications.purchasing.requestOrdered' : 'notifications.purchasing.requestRefused',
          params: ordered ? { title: order?.number ?? '', purchaseOrderId: payload.purchaseOrderId } : { actorId },
          actorId,
        },
      ]
    },
  },
  {
    name: 'inquiries.assigned',
    events: ['inquiry.changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(inquiryEvents, 'inquiry.changed').parse(raw) as { inquiryId: string; number: string; change: string; assigneeId: string | null }
      if (payload.change !== 'ASSIGNED' || payload.assigneeId === null) return []
      const inquiry = await context.tx.inquiry.findUnique({ where: { id: payload.inquiryId }, select: { id: true, number: true, companyId: true, assigneeId: true } })
      // Given to someone else (or taken off) meanwhile: nothing to tell.
      if (!inquiry || inquiry.assigneeId !== payload.assigneeId) return []
      const reader = await context.reader(payload.assigneeId)
      if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, SALES_INQUIRIES_VIEW, { companyId: inquiry.companyId })) return []
      const actorId = await officeActorOf(context, 'Inquiry', inquiry.id)
      return [{ userId: payload.assigneeId, category: 'ASSIGNMENT', record: { type: 'Inquiry', id: inquiry.id, label: inquiry.number }, companyId: inquiry.companyId, anchor: null, messageKey: 'notifications.inquiries.assigned', params: { actorId }, actorId }]
    },
  },
  {
    name: 'safety.productReport',
    events: ['safety_report.received'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(safetyReportEvents, 'safety_report.received').parse(raw) as { reportId: string; number: string; accidentLogged: boolean }
      const report = await context.tx.productSafetyReport.findUnique({ where: { id: payload.reportId }, select: { id: true, number: true, companyId: true } })
      if (!report) return []
      const actorId = await officeActorOf(context, 'ProductSafetyReport', report.id)
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, SALES_SAFETY_MANAGE, { companyId: report.companyId })) continue
        drafts.push({ userId, category: 'ALERT', record: { type: 'ProductSafetyReport', id: report.id, label: report.number }, companyId: report.companyId, anchor: null, messageKey: payload.accidentLogged ? 'notifications.safety.productAccident' : 'notifications.safety.productReport', params: {}, actorId })
      }
      return drafts
    },
  },
])
