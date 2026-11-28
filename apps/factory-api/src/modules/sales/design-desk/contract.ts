import { z } from 'zod'
import { defineContract, id, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * owb-of2 step 4 (order workflow, plan.md § 5f "Design desk", § 5zk/§ 5zl; the Shape FIXED in build/briefs/owb-of2.md — web B of7 codes
 * against it): the Factory designer's first page. No price field, ever.
 */

const picture = output({ fileId: id(), contentType: z.string(), small: z.boolean() })

export const designDeskContract = defineContract({
  response: {
    200: output({
      asked: z.array(
        output({
          kind: z.enum(['ORDER', 'REQUEST']),
          id: id(),
          number: z.string().nullable(),
          subject: z.string().nullable(),
          party: output({ code: z.string(), name: z.string() }),
          why: z.enum(['HELP_ASKED', 'GIVEN', 'ON_IT', 'CONFIRMED']),
          since: instant(),
          picture: picture.nullable(),
        }),
      ),
      approvals: z.array(output({ approvalId: id(), orderId: id(), number: z.string(), subject: z.string().nullable(), kind: z.enum(['PROOF', 'ARTWORK']), sentAt: instant(), state: z.string() })),
      /** "n of m placed" per confirmed order — null until S3's placement read is on main (the web says one quiet line). */
      codes: z.array(output({ orderId: id(), number: z.string(), subject: z.string().nullable(), placed: z.number().int(), pages: z.number().int() })).nullable(),
      floor: z.array(output({ callId: id(), orderNumber: z.string().nullable(), what: z.string(), since: instant(), state: z.enum(['ASKED', 'TAKEN']) })),
    }),
  },
})

export type DesignDeskView = z.infer<(typeof designDeskContract.response)[200]>
