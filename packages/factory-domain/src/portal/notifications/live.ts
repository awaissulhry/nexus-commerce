import { can, type Actor, type Permission } from '../../core/permissions'
import type { EventCatalogue } from '../../events/catalogue'
import { isMoneyField } from '../../events/define'
import type { LiveMessage, LiveView } from '../../events/envelope'
import { PORTAL_HOME_VIEW } from '../tasks/permissions'
// B-W2b-176: the workshop's jobs.
import { PORTAL_JOBS_VIEW } from '../../purchasing/portal-jobs/permissions'
// B-W2b-182: the supplier's ship notices.
import { PORTAL_SHIP_NOTICES_VIEW } from '../../purchasing/ship-notices/permissions'
import { PORTAL_SUPPLIER_DOCUMENTS_VIEW, PORTAL_SUPPLIER_PROFILE_VIEW } from '../../purchasing/portal-profile/permissions'

/**
 * The partner's live channel (B-W2b-167; design portal.frame live "One live channel per partner session, scoped to the
 * party: badges, the task list, record status and promise dates, thread messages"), the pure part. The office's live rule
 * (events/live.ts liveViewFor) says nothing to a partner; an event reaches a partner session only when it is listed here:
 *
 *   permission   the partner permission the viewer needs (can() over the event's company and the viewer's party)
 *   party        the payload field (copied into the live message by the event's own live rule) that names the party: the
 *                message reaches only that party's sessions; an event without it reaches no partner
 *   fields       what of the message's fields the partner receives (never a money field, never more than the event's live
 *                rule copied)
 *
 * A portal step that shows its records live adds its events here (one entry each; a merge point): e.g. a promise date
 * changed, a shipment shipped, a message posted in a shared thread, each with the party in its live fields.
 */

export interface PartnerLiveRule {
  readonly permission: Permission
  readonly party: string
  readonly fields: readonly string[]
}

const tasks = (fields: readonly string[]): PartnerLiveRule => ({ permission: PORTAL_HOME_VIEW, party: 'partyId', fields: ['taskId', 'partyId', 'kind', ...fields] })

export const PARTNER_LIVE_EVENTS: Readonly<Record<string, PartnerLiveRule>> = Object.freeze({
  // B-W2b-167: the task list and the badges; the bell.
  'partner_task.opened': tasks(['recordType', 'recordId']),
  'partner_task.closed': tasks(['status']),
  'partner_task.reopened': tasks([]),
  'partner_task.due_moved': tasks([]),
  'partner_notification.created': { permission: PORTAL_HOME_VIEW, party: 'partyId', fields: ['partyId', 'count'] },
  // B-W2b-176: a workshop's jobs (its answer, our answer to a proposed date, the kit, progress, send-backs): the cards update.
  ...Object.fromEntries(
    ['job_sent', 'job_answered', 'date_decided', 'kit_checked', 'progress_reported', 'return_announced', 'return_cancelled'].map((event) => [
      `subcontract_order.${event}`,
      { permission: PORTAL_JOBS_VIEW, party: 'partyId', fields: ['subcontractOrderId', 'number', 'status', 'partyId'] },
    ]),
  ),
  // B-W2b-182: a supplier's ship notices (sent, changed, cancelled, received by our warehouse, reopened): its list updates.
  ...Object.fromEntries(
    ['sent', 'changed', 'cancelled', 'received', 'reopened'].map((event) => [`ship_notice.${event}`, { permission: PORTAL_SHIP_NOTICES_VIEW, party: 'partyId', fields: ['shipNoticeId', 'number', 'purchaseOrderId', 'status', 'partyId'] }]),
  ),
  // B-W2b-189: our check of a supplier's document, and of its profile change (the page's status and values update).
  'supplier_document.uploaded': { permission: PORTAL_SUPPLIER_DOCUMENTS_VIEW, party: 'partyId', fields: ['fileId', 'partyId', 'recordType', 'recordId', 'category'] },
  'supplier_document.accepted': { permission: PORTAL_SUPPLIER_DOCUMENTS_VIEW, party: 'partyId', fields: ['fileId', 'partyId', 'documentFileId', 'category'] },
  'supplier_document.refused': { permission: PORTAL_SUPPLIER_DOCUMENTS_VIEW, party: 'partyId', fields: ['fileId', 'partyId'] },
  'supplier_profile.change_requested': { permission: PORTAL_SUPPLIER_PROFILE_VIEW, party: 'partyId', fields: ['requestId', 'partyId'] },
  'supplier_profile.change_withdrawn': { permission: PORTAL_SUPPLIER_PROFILE_VIEW, party: 'partyId', fields: ['requestId', 'partyId'] },
  'supplier_profile.change_decided': { permission: PORTAL_SUPPLIER_PROFILE_VIEW, party: 'partyId', fields: ['requestId', 'partyId', 'outcome'] },
})

/**
 * What one partner viewer receives of a live message, or null. Fails closed: another tenant's message, an event this
 * catalogue does not declare or this list does not name, a message without the party or of another party, a viewer without
 * the permission over the event's company: nothing.
 */
export function partnerLiveViewFor(message: LiveMessage, viewer: Actor, catalogue: EventCatalogue): LiveView | null {
  if (viewer.audience !== 'partner' || !viewer.tenantId || !viewer.partyId || message.tenantId !== viewer.tenantId) return null
  if (!catalogue.find(message.type, message.version)?.live) return null
  const rule = Object.hasOwn(PARTNER_LIVE_EVENTS, message.type) ? PARTNER_LIVE_EVENTS[message.type] : undefined
  if (!rule) return null
  if (message.fields[rule.party] !== viewer.partyId) return null
  if (!can(viewer, rule.permission, { companyId: message.companyId, partyId: viewer.partyId })) return null
  const fields: Record<string, unknown> = {}
  for (const key of rule.fields) if (!isMoneyField(key) && Object.hasOwn(message.fields, key)) fields[key] = message.fields[key]
  const { tenantId: _tenant, siteId: _site, ...rest } = message
  return { ...rest, siteId: null, fields }
}
