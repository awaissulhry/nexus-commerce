import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { events as fileEvents } from '@nexus/factory-domain/files/events'
import { dayOf } from '@nexus/factory-domain/files/expiry/rules'
import { recordWords } from '@nexus/factory-domain/files/required/rules'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import type { Draft, FanOutRule, RuleContext } from '../../notifications/fan-out'
import { followersOf } from '../../threads/followers'

/**
 * Who is told that a document stops being valid soon (B-W2b-177, COL-049; the plan: "a scheduler job reminds the record's
 * owner"), quiet as every rule of the fan-out:
 *
 *   file.expiry_due   SYSTEM to the record's owner of the document: who added the version in force (else who added the
 *                     series' first version), and the record's followers — each only while they reach Home and may read
 *                     the file's company's files. "LWG certificate.pdf on SUP-0042 expires on 27/11/2026". Nobody when the
 *                     document was replaced or its date moved meanwhile (the event is about that date only).
 *
 * The partner hears through its own request (./remind.ts opens it; B-W2b-167 mails and reminds it).
 */

const dueSchema = fileEvents.find((event) => event.type === 'file.expiry_due')!.payload

/** A day as people read it in the factory: 27/11/2026. */
export const dayWords = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`

export const EXPIRY_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'files.expiryDue',
    events: ['file.expiry_due'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = dueSchema.parse(raw) as { fileId: string; recordType: string; recordId: string; expiresOn: string; daysLeft: number; window: 30 | 7 }
      const file = await context.tx.storedFile.findUnique({
        where: { id: payload.fileId },
        select: { companyId: true, createdById: true, seriesId: true, status: true, supersededAt: true, expiresOn: true, originalName: true },
      })
      if (!file || file.status !== 'AVAILABLE' || file.supersededAt !== null || file.expiresOn === null || dayOf(file.expiresOn) !== payload.expiresOn) return []
      const first = file.createdById === null && file.seriesId !== null ? await context.tx.storedFile.findUnique({ where: { id: file.seriesId }, select: { createdById: true } }) : null
      const owner = file.createdById ?? first?.createdById ?? null
      const candidates = [...new Set([...(owner ? [owner] : []), ...(await followersOf(context.tx, { type: payload.recordType, id: payload.recordId }))])]
      const entry = await context.tx.searchEntry.findFirst({ where: { recordType: payload.recordType, recordId: payload.recordId }, select: { number: true, title: true } })
      const label = entry?.number ?? entry?.title ?? recordWords(payload.recordType)
      const drafts: Draft[] = []
      for (const userId of candidates) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, FILES_READ, { companyId: file.companyId })) continue
        drafts.push({
          userId,
          category: 'SYSTEM',
          record: { type: payload.recordType, id: payload.recordId, label },
          companyId: file.companyId,
          anchor: `file:${payload.fileId}`,
          messageKey: 'notifications.files.expiryDue',
          params: { title: dayWords(payload.expiresOn), kindLabel: file.originalName, expiresOn: payload.expiresOn, daysLeft: payload.daysLeft, window: payload.window },
          actorId: null,
        })
      }
      return drafts
    },
  },
])
