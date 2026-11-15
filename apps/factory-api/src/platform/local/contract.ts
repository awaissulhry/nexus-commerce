import { z } from 'zod'
import { defineContract, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The local mailbox (B-W2b-F58; FACTORY_ENV=local only, mailbox.ts): the FAKE mail of this tenant, newest first, with its
 * text and the links in it. On every other environment the route does not exist (404).
 */
export const localMailboxContract = defineContract({
  querystring: input({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: {
    200: output({
      messages: z.array(
        output({
          id: z.string(),
          sentAt: instant(),
          templateKey: z.string(),
          from: z.string(),
          to: z.array(z.string()),
          cc: z.array(z.string()),
          bcc: z.array(z.string()),
          subject: z.string(),
          text: z.string(),
          links: z.array(z.string()),
        }),
      ),
    }),
  },
})
