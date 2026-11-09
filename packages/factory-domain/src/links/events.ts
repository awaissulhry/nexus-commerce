import { z } from 'zod'
import { defineEvent } from '../events/define'
import { LINK_ACTIONS, LINK_PURPOSES } from './purposes'
import { LINKS_VIEW } from './permissions'
import { LINK_RENEW_NOTE_MAX } from './renew'

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
  // B-W2b-163: "Ask for a new link" (links/renew) made a new link for a dead one, sent to the address on file: the
  // record's link list shows it at once. A module that renews its own links (shipping, purchasing) emits its own event.
  defineEvent({
    type: 'link.renewed',
    context: 'links',
    description: 'A new link replaced a dead one at its holder\'s request; it went to the address the old one was sent to.',
    payload: z.strictObject({
      linkId: z.uuid(),
      /** The dead link it replaces. */
      renewalOfId: z.uuid(),
      purpose: z.enum(LINK_PURPOSES),
      recordType: z.string(),
      recordId: z.uuid(),
    }),
    live: { permission: LINKS_VIEW, fields: ['linkId', 'renewalOfId', 'purpose', 'recordType', 'recordId'] },
  }),
  // B-W2b-F17: "Ask for a new link" on a dead link with no renewer told the person who made it (links/renew): the fan-out
  // puts it on their bell with the record and the reader's note. No new link was made.
  defineEvent({
    type: 'link.renewal_asked',
    context: 'links',
    description: 'The holder of a dead link whose kind has no renewer asked for a new one: the person who made the link is told.',
    payload: z.strictObject({
      /** The dead link. */
      linkId: z.uuid(),
      purpose: z.enum(LINK_PURPOSES),
      recordType: z.string(),
      recordId: z.uuid(),
      /** The office person who made the link: the one told. */
      makerId: z.uuid(),
      /** The reader's own words to that person, if any (never on a live screen). */
      note: z.string().max(LINK_RENEW_NOTE_MAX).nullable(),
    }),
    live: { permission: LINKS_VIEW, fields: ['linkId', 'purpose', 'recordType', 'recordId'] },
  }),
] as const
