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
 *   notification.view_changed  B-W2b-385 (PLT-151): a saved view one person follows holds other rows than when it was last
 *                          counted for them (how many now and before; what came in and what left when the last ids are
 *                          known). It names the person, so it never travels on a live screen; the fan-out tells them.
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
  // B-W2b-385 (PLT-151): a followed saved view changed for its follower.
  defineEvent({
    type: 'notification.view_changed',
    context: 'notifications',
    description: 'A saved view a person follows holds other rows than when it was last counted for them; they are told.',
    payload: z.strictObject({
      followerId: z.uuid(),
      viewId: z.uuid(),
      userId: z.uuid(),
      count: z.number().int().min(0),
      previousCount: z.number().int().min(0),
      /** Rows that came in and rows that left; null when the last ids were not kept (the first change after a follow). */
      entered: z.number().int().min(0).nullable(),
      left: z.number().int().min(0).nullable(),
      /** True: the view holds more rows than are counted (VIEW_FOLLOW_LIMITS.maxRows). */
      capped: z.boolean(),
    }),
  }),
] as const
