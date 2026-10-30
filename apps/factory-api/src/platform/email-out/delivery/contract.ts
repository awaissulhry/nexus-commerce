import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DELIVERY_STATES, UNBLOCK_REASON_MAX, UNBLOCK_REASON_MIN } from '@nexus/factory-domain/email-delivery/rules'
import { OUTBOUND_STATUSES, SUPPRESSION_REASONS } from '@nexus/factory-domain/email/rules'

/**
 * The mail delivery log and the blocked addresses (B-W2a-41; PLT-149; design admin.connections "Delivery log and
 * blocked addresses"). Office only. Never a body, a subject, SES's message id, a reply address or a link: what a mail
 * is about is its record (a link to it), what it carried is said in words ("a document link"). Addresses are masked
 * (`a•••@cliente.example`) unless the reader holds email.manage over the mail's company (`fullAddresses`).
 */

const recordRef = output({
  type: z.string(),
  id: id(),
  /** The record's number or code as a chip shows it; null when the reader may not see it (or it is a person). */
  label: z.string().nullable(),
})

export const deliveryView = output({
  id: id(),
  companyId: id(),
  /** RECORD: mail on a record's thread; SIGN_IN: an invitation or a password reset; DIGEST: the notification digest. */
  kind: z.enum(['RECORD', 'SIGN_IN', 'DIGEST']),
  templateKey: z.string(),
  record: recordRef.nullable(),
  /** The recipients (to, cc; never bcc), masked unless `fullAddresses`. */
  to: z.array(z.string()),
  recipients: z.number().int(),
  fullAddresses: z.boolean(),
  state: z.enum(DELIVERY_STATES),
  status: z.enum(OUTBOUND_STATUSES),
  /** When it reached its state. */
  at: instant(),
  queuedAt: instant(),
  attempts: z.number().int(),
  /** The last failure, or what the bounce or complaint said (never an address). */
  problem: z.string().nullable(),
  /** The mail carried a one-off link (a document link, the deposit page, a quote to accept): its purpose. */
  link: z.string().nullable(),
  /** Notifications the digest carried (DIGEST only). */
  notifications: z.number().int().nullable(),
})
export type DeliveryView = z.infer<typeof deliveryView>

const stateCounts = output(Object.fromEntries(DELIVERY_STATES.map((state) => [state, z.number().int()])) as Record<(typeof DELIVERY_STATES)[number], z.ZodNumber>)

export const listDeliveryContract = defineContract({
  querystring: input({
    state: z.enum(DELIVERY_STATES).optional(),
    /** Mail about one record. */
    recordType: z.string().regex(/^[A-Z][A-Za-z]{1,63}$/).optional(),
    recordId: id().optional(),
    /** Only mail of invoices (the record type Invoice) or mail that carried a one-off link. */
    about: z.enum(['INVOICES', 'LINKS']).optional(),
    companyId: id().optional(),
    /** Reached its state on or after / before (ISO instants). */
    from: instant().optional(),
    to: instant().optional(),
    /** Older than this mail (paging, newest first). */
    before: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: {
    200: output({
      mails: z.array(deliveryView),
      nextBefore: id().nullable(),
      /** Per state, the last 30 days, in the reader's companies. */
      counts: stateCounts,
      /** Addresses blocked now (tenant-wide). */
      blocked: z.number().int(),
    }),
  },
})

export const blockedView = output({
  id: id(),
  /** Masked unless `fullAddress`. */
  address: z.string(),
  fullAddress: z.boolean(),
  reason: z.enum(SUPPRESSION_REASONS),
  /** What the provider said (`Permanent/General`, `abuse`) or why a person stopped it. */
  detail: z.string().nullable(),
  /** When it was blocked. */
  at: instant(),
  /** The mail whose bounce or complaint blocked it, when the reader may see that mail. */
  mail: output({ id: id(), companyId: id(), record: recordRef.nullable() }).nullable(),
  /** Unblocked: when, by whom (a user id) and why; null while blocked. */
  unblocked: output({ at: instant(), byId: id().nullable(), reason: z.string().nullable() }).nullable(),
  version: z.number().int(),
})
export type BlockedView = z.infer<typeof blockedView>

export const listBlockedContract = defineContract({
  querystring: input({
    /** BLOCKED (default): mail is refused to these now; UNBLOCKED: lifted by a person, kept as a record. */
    state: z.enum(['BLOCKED', 'UNBLOCKED']).optional(),
    reason: z.enum(SUPPRESSION_REASONS).optional(),
    before: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: { 200: output({ addresses: z.array(blockedView), nextBefore: id().nullable(), canUnblock: z.boolean() }) },
})

export const unblockContract = defineContract({
  params: input({ suppressionId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(UNBLOCK_REASON_MIN).max(UNBLOCK_REASON_MAX) }),
  response: { 200: output({ address: blockedView }) },
})
