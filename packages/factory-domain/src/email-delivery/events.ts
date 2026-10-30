import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SUPPRESSION_REASONS } from '../email/rules'

/**
 * The delivery log's events (B-W2a-41; PLT-149). apps/factory-api's platform/email-out/delivery emits them; none
 * carries an address:
 *   email.address_unblocked  a person unblocked an address: mail may go to it again. The delivery log refreshes for
 *                            the people who read it.
 */
export const events = [
  defineEvent({
    type: 'email.address_unblocked',
    context: 'email-delivery',
    description: 'A person unblocked an address that had bounced, complained or been stopped.',
    payload: z.strictObject({
      suppressionId: z.uuid(),
      /** Why it had been blocked. */
      reason: z.enum(SUPPRESSION_REASONS),
    }),
    live: { permission: 'email.delivery.view', fields: ['suppressionId'] },
  }),
] as const
