import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BOUNCE_KINDS, DELIVERY_STATES, WEBHOOK_SECRET_LIMITS } from '@nexus/factory-domain/mail-depth/rules'
import { RECORD_TYPE } from '@nexus/factory-domain/threads/rules'

/**
 * Delivery status's contracts (B-W2b-394; COL-031; design shell.preview "Per recipient: Queued → Sent → Delivered / Bounced",
 * "Bounced → 'Fix address'"; ML1:01 the FAKE mail account's webhook secret, design admin.connections "Replace the secret").
 * Office only; codes, never words; never an address (the thread's own mail list has them for its readers) nor a secret.
 */

export const messageDeliveryView = output({
  outboundId: id(),
  /** The thread message the mail is (its pill goes there). */
  messageId: id().nullable(),
  state: z.enum(DELIVERY_STATES),
  bounceKind: z.enum(BOUNCE_KINDS).nullable(),
  recipients: z.number().int(),
  queuedAt: instant(),
  sentAt: instant().nullable(),
  deliveredAt: instant().nullable(),
  bouncedAt: instant().nullable(),
  complainedAt: instant().nullable(),
  failedAt: instant().nullable(),
  /** The task its bounce made (the newest), while the reader sees the record. */
  task: output({ id: id(), status: z.enum(['OPEN', 'DONE', 'CANCELLED']) }).nullable(),
})
export type MessageDeliveryView = z.infer<typeof messageDeliveryView>

export const deliveryStatusContract = defineContract({
  querystring: input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() }),
  response: { 200: output({ messages: z.array(messageDeliveryView) }) },
})

export const webhookSecretContract = defineContract({
  params: input({ accountId: id() }),
  body: input({
    /** The account's version as read. */
    version: z.number().int().min(1),
    /** The new secret, write-only (32 to 256 printable characters): the old one stops at once. */
    value: z.string().max(WEBHOOK_SECRET_LIMITS.max + 1),
  }),
  response: {
    200: output({
      accountId: id(),
      replaced: z.boolean(),
      savedAt: instant(),
      /** The last four characters ("Saved · ends in …4F2A"); the value is never answered. */
      endsIn: z.string(),
      version: z.number().int(),
    }),
  },
})
