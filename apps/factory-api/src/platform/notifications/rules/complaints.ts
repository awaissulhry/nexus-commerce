import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { QUALITY_COMPLAINTS_ACKNOWLEDGE, QUALITY_COMPLAINTS_MANAGE } from '@nexus/factory-domain/quality/complaints/permissions'
import { events as qualityEvents } from '@nexus/factory-domain/quality/events'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * A safety complaint's alert (B-W2a-65; QHS-115, Reg. (EU) 2016/425 art. 8(4); design quality.complaints "This alerts the
 * owner and quality now"), quiet but at once:
 *   complaint.safety_raised   ALERT to every office person who may acknowledge it (the owner: quality.complaints.acknowledge)
 *                             or follows complaints up (quality: quality.complaints.manage) over the complaint's company
 *                             and customer, and reaches Home (home.view); never the person who raised it. The sentence
 *                             notifications.complaint.safety ({title}: the customer's first words); it opens the record.
 * Nothing is mailed here (the person's digest carries ALERT notifications, off by default); nothing reaches the customer
 * or an authority.
 */

const payloadOf = (type: string) => qualityEvents.find((event) => event.type === type)!.payload

const TITLE_MAX = 80

export const COMPLAINT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'quality.complaintSafetyRaised',
    events: ['complaint.safety_raised'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('complaint.safety_raised').parse(raw) as unknown as { complaintId: string; number: string; raisedById: string | null }
      const complaint = await context.tx.complaint.findUnique({ where: { id: payload.complaintId }, select: { companyId: true, partyId: true, description: true, safetyAcknowledgedAt: true, status: true } })
      // Acknowledged or closed meanwhile: nothing to tell.
      if (!complaint || complaint.safetyAcknowledgedAt !== null || complaint.status === 'CLOSED') return []
      const scope = { companyId: complaint.companyId, partyId: complaint.partyId }
      const words = (complaint.description.trim().split(/\r?\n/)[0] ?? '').slice(0, TITLE_MAX)
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW)) continue
        if (!can(reader.actor, QUALITY_COMPLAINTS_ACKNOWLEDGE, scope) && !can(reader.actor, QUALITY_COMPLAINTS_MANAGE, scope)) continue
        drafts.push({
          userId,
          category: 'ALERT',
          record: { type: 'Complaint', id: payload.complaintId, label: payload.number },
          companyId: complaint.companyId,
          anchor: null,
          messageKey: 'notifications.complaint.safety',
          params: { title: words, complaintId: payload.complaintId },
          actorId: payload.raisedById,
        })
      }
      return drafts
    },
  },
])
