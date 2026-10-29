import { z } from 'zod'
import { defineEvent } from '../events/define'
import { NOTICE_KINDS } from './notices'

/**
 * The privacy pack's events (B-W1-36; A2 SCR-086 "Live: worker_notice.acknowledged → counts"), emitted by
 * apps/factory-api's platform/privacy in the commands that make the change. Ids, kinds, numbers and labels only: no
 * person's name, no text of a notice, nothing a person signed.
 *
 *   privacy.notice_published     a notice version came into force; the one it replaced (if any) is superseded. A new
 *                                worker notice holds every worker's scans until they acknowledge it (next sign-in).
 *   privacy.notice_acknowledged  a worker (on the tablet, or a signed paper copy the office recorded) or an office person
 *                                acknowledged a version: the counts on Admin › Privacy & notices.
 *   privacy.dpia_stored          a company's signed DPIA was stored (the floor gate reads it); the earlier one is
 *                                superseded.
 */
export const ACK_CHANNELS = ['DEVICE', 'PAPER', 'OFFICE'] as const

const kind = z.enum(NOTICE_KINDS)

export const events = [
  defineEvent({
    type: 'privacy.notice_published',
    context: 'privacy',
    description: "A version of a company's privacy notice came into force; the version it replaces is superseded.",
    payload: z.strictObject({ noticeId: z.uuid(), companyId: z.uuid(), kind, versionNo: z.number().int().min(1), label: z.string(), supersededId: z.uuid().nullable() }),
    live: { permission: 'privacy.view', fields: ['noticeId', 'kind', 'versionNo'] },
  }),
  defineEvent({
    type: 'privacy.notice_acknowledged',
    context: 'privacy',
    description: 'A worker or an office person acknowledged the version of a privacy notice in force.',
    payload: z.strictObject({ noticeId: z.uuid(), kind, channel: z.enum(ACK_CHANNELS) }),
    live: { permission: 'privacy.view', fields: ['noticeId', 'kind'] },
  }),
  defineEvent({
    type: 'privacy.dpia_stored',
    context: 'privacy',
    description: "A company's signed DPIA was stored; the earlier one is superseded.",
    payload: z.strictObject({ dpiaId: z.uuid(), companyId: z.uuid(), versionNo: z.number().int().min(1), supersededId: z.uuid().nullable() }),
    live: { permission: 'privacy.view', fields: ['dpiaId', 'versionNo'] },
  }),
] as const
