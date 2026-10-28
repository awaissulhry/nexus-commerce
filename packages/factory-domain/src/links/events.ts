import { z } from 'zod'
import { defineEvent } from '../events/define'
import { LINK_ACTIONS, LINK_PURPOSES } from './purposes'
import { LINKS_VIEW } from './permissions'

/**
 * The one-off links' events (plan A1 §3.4, §3.10; feature SAL-099 "every open is logged"). Every open and answer of a
 * link emits `link.used` in the command that writes its evidence row, so the office screens of the record (the quote,
 * the purchase order) refresh live: "opened by the customer", "confirmed by the supplier". The module that owns the
 * record emits its own business event for an answer (quote.accepted, …).
 */
export const events = [
  defineEvent({
    type: 'link.used',
    context: 'links',
    description: 'A one-off link was opened or answered by the party it was made for.',
    payload: z.strictObject({
      linkId: z.uuid(),
      purpose: z.enum(LINK_PURPOSES),
      action: z.enum(LINK_ACTIONS),
      recordType: z.string(),
      recordId: z.uuid(),
      /** The use counted against the link's limit. */
      counted: z.boolean(),
    }),
    live: { permission: LINKS_VIEW, fields: ['linkId', 'purpose', 'action', 'recordType', 'recordId'] },
  }),
] as const
