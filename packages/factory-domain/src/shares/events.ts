import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SHARE_PERMISSIONS } from './rules'

/**
 * Inviting a partner to one record (B-W2b-200). apps/factory-api's platform/shares emits them; the record's office panels
 * (its Partners tab) refresh on them (partners.shares.view over the event's company). Ids and codes only: never a name, an
 * address or the words. The invited person's posts and uploads are the thread's and the files' own events
 * (thread.message_posted, file.available) and the link's evidence (link.used: POSTED, UPLOADED).
 *
 *   record_share.invited   the office invited a partner's contact (the share, its RECORD_INVITE link, the mail)
 *   record_share.changed   what they may do changed (the office), or "E-mail me" (the invited person)
 *   record_share.revoked   the office revoked it: the share and its link stopped together
 */

const live = (fields: readonly string[]) => ({ permission: 'partners.shares.view', fields }) as const
const about = { shareId: z.uuid(), recordType: z.string(), recordId: z.uuid(), partyId: z.uuid() }
const FIELDS = ['shareId', 'recordType', 'recordId', 'partyId'] as const
const permissions = z.array(z.enum(SHARE_PERMISSIONS)).min(1)

export const events = [
  defineEvent({
    type: 'record_share.invited',
    context: 'shares',
    description: "The office invited a partner's contact to one record by link: what they may do and until when.",
    payload: z.strictObject({ ...about, linkId: z.uuid(), permissions, expiresAt: z.string(), mailed: z.boolean() }),
    live: live([...FIELDS, 'permissions']),
  }),
  defineEvent({
    type: 'record_share.changed',
    context: 'shares',
    description: 'What an invited partner may do on a record changed (the office), or whether they get new messages by e-mail (the partner).',
    payload: z.strictObject({ ...about, permissions, notifyByEmail: z.boolean(), by: z.enum(['OFFICE', 'PARTNER']) }),
    live: live([...FIELDS, 'permissions', 'notifyByEmail', 'by']),
  }),
  defineEvent({
    type: 'record_share.revoked',
    context: 'shares',
    description: 'The office revoked an invitation to a record: the share and its link stopped together.',
    payload: z.strictObject({ ...about, linkId: z.uuid().nullable() }),
    live: live([...FIELDS]),
  }),
] as const
