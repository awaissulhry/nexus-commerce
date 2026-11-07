import { can, type Actor, type Permission } from '../../core/permissions'
import type { EventCatalogue } from '../../events/catalogue'
import { isMoneyField } from '../../events/define'
import type { LiveMessage, LiveView } from '../../events/envelope'
import { PORTAL_HOME_VIEW } from '../tasks/permissions'

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
