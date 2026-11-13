import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { holds } from '@nexus/factory-domain/core/permissions'
import { events as notificationEvents } from '@nexus/factory-domain/notifications/events'
import { followersOf } from '../../threads/followers'
import { recordLabelOf } from '../../threads/labels'
import { mayOnThread, resolveRecord } from '../../threads/records'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * Following, in depth (B-W2b-385; PLT-151 "Follow a record or a saved view: told when it changes or when an item enters or
 * leaves the view"):
 *
 *   notification.view_changed   FOLLOWING to the person whose followed saved view holds other rows (evaluate.ts): how many now,
 *                               what came in and what left when known; while they still follow it and reach Home
 *   a record's status or stage  FOLLOWING to the record's followers who did not mute it and may read it (W2a's followers got its
 *                               messages only): one sentence "<record>, which you follow, changed"; never the person who changed
 *                               it (the request's office actor, read from its audit row)
 *
 * The record changes are the moves a follower waits for (RECORD_CHANGES): a status or a stage, a quote or a purchase order
 * answered, an inquiry closed. A change that always comes with a message on the record's thread (a quote or an order sent) is
 * left out: its message tells the followers already.
 */

const viewPayload = notificationEvents.find((event) => event.type === 'notification.view_changed')!.payload

/** The record events a follower is told about: the record type and the payload key naming the record. */
export const RECORD_CHANGES: Readonly<Record<string, { readonly type: string; readonly key: string }>> = Object.freeze({
  'sales_order.status_changed': { type: 'SalesOrder', key: 'orderId' },
  'sales_order.promise_changed': { type: 'SalesOrder', key: 'orderId' },
  'workorder.status_changed': { type: 'WorkOrder', key: 'workOrderId' },
  'shipment.status_changed': { type: 'Shipment', key: 'shipmentId' },
  'return.status_changed': { type: 'ReturnAuthorisation', key: 'returnId' },
  'complaint.status_changed': { type: 'Complaint', key: 'complaintId' },
  'service_case.status_changed': { type: 'ServiceCase', key: 'caseId' },
  'safety_report.status_changed': { type: 'ProductSafetyReport', key: 'reportId' },
  'ncr.stage_changed': { type: 'Nonconformance', key: 'ncrId' },
  'quote.accepted': { type: 'Quote', key: 'quoteId' },
  'quote.declined': { type: 'Quote', key: 'quoteId' },
  'quote.expired': { type: 'Quote', key: 'quoteId' },
  'quote.cancelled': { type: 'Quote', key: 'quoteId' },
  'purchase_order.confirmed': { type: 'PurchaseOrder', key: 'purchaseOrderId' },
  'purchase_order.declined': { type: 'PurchaseOrder', key: 'purchaseOrderId' },
  'purchase_order.changes_proposed': { type: 'PurchaseOrder', key: 'purchaseOrderId' },
  'purchase_order.cancelled': { type: 'PurchaseOrder', key: 'purchaseOrderId' },
  'inquiry.closed': { type: 'Inquiry', key: 'inquiryId' },
})

/** The office person whose request made an event about a record (its audit row), or null (the system, the floor, a partner). */
export async function officeActorOf(context: RuleContext, recordType: string, recordId: string): Promise<string | null> {
  const correlationId = context.event?.correlationId
  if (!correlationId) return null
  const row = await context.tx.auditLog.findFirst({ where: { recordType, recordId, requestId: correlationId, audience: 'OFFICE' }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { actorId: true } })
  return row?.actorId ?? null
}

export const FOLLOWING_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'following.view',
    events: ['notification.view_changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = viewPayload.parse(raw)
      const follow = await context.tx.viewFollower.findUnique({ where: { id: payload.followerId }, select: { userId: true, view: { select: { id: true, name: true, companyId: true } } } })
      // Unfollowed (or the view deleted) meanwhile: nothing to tell.
      if (!follow || follow.userId !== payload.userId) return []
      const reader = await context.reader(payload.userId)
      if (!reader || !holds(reader.actor, HOME_VIEW)) return []
      const counts = payload.entered !== null && payload.left !== null
      return [
        {
          userId: payload.userId,
          category: 'FOLLOWING',
          record: { type: 'SavedView', id: follow.view.id, label: follow.view.name },
          companyId: follow.view.companyId,
          anchor: null,
          messageKey: counts ? 'notifications.following.view' : 'notifications.following.viewCount',
          params: { count: payload.count, previousCount: payload.previousCount, capped: payload.capped, ...(counts ? { entered: payload.entered, left: payload.left } : {}) },
          actorId: null,
        },
      ]
    },
  },
  {
    name: 'following.recordChanged',
    events: Object.keys(RECORD_CHANGES),
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const type = context.event?.type
      const change = type ? RECORD_CHANGES[type] : undefined
      const recordId = change ? (raw as Record<string, unknown> | null)?.[change.key] : undefined
      if (!change || typeof recordId !== 'string') return []
      const followers = await followersOf(context.tx, { type: change.type, id: recordId })
      if (followers.length === 0) return []
      const scope = await resolveRecord(context.tx, change.type, recordId)
      const label = scope ? await recordLabelOf(context.tx, change.type, recordId) : null
      if (!scope || label === null) return []
      const actorId = await officeActorOf(context, change.type, recordId)
      const drafts: Draft[] = []
      for (const userId of followers) {
        if (userId === actorId) continue
        const reader = await context.reader(userId)
        if (!reader || !mayOnThread(reader.actor, THREADS_READ, change.type, scope)) continue
        drafts.push({ userId, category: 'FOLLOWING', record: { type: change.type, id: recordId, label }, companyId: scope.companyId, anchor: null, messageKey: 'notifications.following.changed', params: { change: type! }, actorId })
      }
      return drafts
    },
  },
])
