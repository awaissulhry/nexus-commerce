import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The notification centre's events (B-W2a-20; design home.notifications live "notification.created → '3 new · Show'; the
 * bell count updates at once", shell.frame "the bell … counts refresh at once, no poll").
 *
 *   notification.created   the fan-out of one event made notifications for some people. It names no person and no
 *                          words: a live message reaches everyone who sees Today in the record's company, so it only
 *                          tells each screen to read its OWN bell and list again (GET /notifications/counts).
 *   notification.digest_sent  a person's daily digest went out (the e-mail's id; the deliveries are its rows).
 */
export const events = [
  defineEvent({
    type: 'notification.created',
    context: 'notifications',
    description: 'The fan-out of one event made notifications for some people; their screens read their own bell again.',
    payload: z.strictObject({ sourceEventId: z.uuid(), sourceType: z.string(), count: z.number().int().min(1) }),
    live: { permission: 'home.view', fields: ['sourceType'] },
  }),
  defineEvent({
    type: 'notification.digest_sent',
    context: 'notifications',
    description: "A person's daily digest of notifications was e-mailed (they turned it on).",
    payload: z.strictObject({ userId: z.uuid(), emailOutboundId: z.uuid(), count: z.number().int().min(1) }),
  }),
] as const
