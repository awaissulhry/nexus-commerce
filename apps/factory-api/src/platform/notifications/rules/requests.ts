import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as inquiryEvents } from '@nexus/factory-domain/sales-inquiries/events'
import { SALES_INQUIRIES_MANAGE } from '@nexus/factory-domain/sales/inquiries/permissions'
import { officeActorOf } from '../view-follow/rules'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * A new request (B-TH-015; threads plan G14, PR-19): when an inquiry comes in (inquiry.received: typed in the office, by phone
 * or at a fair, made from a mail, sent from the portal), the people who answer requests hear it at once: every active office
 * person who keeps inquiries (sales.inquiries.manage) over the request's company and, when it is a customer's, that customer
 * (a person limited to other customers hears nothing of it: the brand wall, W29), who sees Home, and who is not the one who
 * made it. ASSIGNMENT (the "Assigned to me" row of the preferences matrix: the bell, and the mail or phone the person chose
 * there), never a count of anybody, never what is asked: the request's number only. A request made already given to someone
 * tells that person too (inquiries.assigned speaks only of a later inquiry.changed, so this is their one notice).
 */

const payloadOf = inquiryEvents.find((event) => event.type === 'inquiry.received')!.payload

export const REQUEST_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'inquiries.newRequest',
    events: ['inquiry.received'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf.parse(raw) as { inquiryId: string; number: string; partyId: string | null }
      const inquiry = await context.tx.inquiry.findUnique({ where: { id: payload.inquiryId }, select: { id: true, number: true, companyId: true, partyId: true, createdById: true } })
      if (!inquiry) return []
      const scope = { companyId: inquiry.companyId, ...(inquiry.partyId ? { partyId: inquiry.partyId } : {}) }
      const actorId = (await officeActorOf(context, 'Inquiry', inquiry.id)) ?? inquiry.createdById
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        if (userId === inquiry.createdById || userId === actorId) continue
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, SALES_INQUIRIES_MANAGE, scope)) continue
        drafts.push({ userId, category: 'ASSIGNMENT', record: { type: 'Inquiry', id: inquiry.id, label: inquiry.number }, companyId: inquiry.companyId, anchor: null, messageKey: 'notifications.inquiries.newRequest', params: {}, actorId })
      }
      return drafts
    },
  },
])
