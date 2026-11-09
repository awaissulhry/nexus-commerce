import { holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as linkEvents } from '@nexus/factory-domain/links/events'
import type { Draft, FanOutRule, RuleContext } from '../notifications/fan-out'
import { recordLabelOf } from '../threads/labels'

/**
 * Who is told when the holder of a dead link with no renewer asks for a new one (B-W2b-F17; Owner answer 11-09 = B;
 * links/renew tellLinkMaker), quiet as every rule of the fan-out:
 *
 *   link.renewal_asked   SYSTEM to the person who MADE the link, while they are an active office person who reaches Home
 *                        (the bell): "The link you sent for SO-0042 no longer opens: its holder asks for a new one", with
 *                        the reader's note when they wrote one. The record is the link's (an approval request's: the record
 *                        it asks about). Whether to send a new link is theirs; nothing was sent.
 */

const askedSchema = linkEvents.find((event) => event.type === 'link.renewal_asked')!.payload

/** The record the office opens: the link's, or for an approval request the record it asks about. */
async function recordOf(context: RuleContext, recordType: string, recordId: string): Promise<{ type: string; id: string; companyId: string | null } | null> {
  if (recordType !== 'ApprovalRequest') return { type: recordType, id: recordId, companyId: null }
  const request = await context.tx.approvalRequest.findUnique({ where: { id: recordId }, select: { recordType: true, recordId: true, companyId: true } })
  return request ? { type: request.recordType, id: request.recordId, companyId: request.companyId } : null
}

export const LINK_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'links.renewalAsked',
    events: ['link.renewal_asked'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = askedSchema.parse(raw) as { linkId: string; recordType: string; recordId: string; makerId: string; note: string | null }
      const reader = await context.reader(payload.makerId)
      if (!reader || !holds(reader.actor, HOME_VIEW)) return []
      const link = await context.tx.oneOffLink.findUnique({ where: { id: payload.linkId }, select: { companyId: true } })
      const record = await recordOf(context, payload.recordType, payload.recordId)
      if (!link || !record) return []
      const label = (await recordLabelOf(context.tx, record.type, record.id)) ?? `${record.type} ${record.id.slice(-6)}`
      return [
        {
          userId: payload.makerId,
          category: 'SYSTEM',
          record: { type: record.type, id: record.id, label },
          companyId: record.companyId ?? link.companyId,
          anchor: `link:${payload.linkId}`,
          messageKey: payload.note ? 'notifications.links.renewAskedNote' : 'notifications.links.renewAsked',
          params: { ...(payload.note ? { title: payload.note } : {}), linkId: payload.linkId },
          actorId: null,
        },
      ]
    },
  },
])
