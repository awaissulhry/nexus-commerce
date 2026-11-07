import { z } from 'zod'
import { PARTNER_KINDS } from '@nexus/factory-domain/auth/partners/kinds'
import { defineContract, instant, output } from '@nexus/factory-domain/core/contracts'
import { portalTasksContract } from '../tasks/contract'

/** The partner's Home (B-W2b-167): the first rows of the one task list, the rail's badges, the counts (null: not counted). */
const taskList = portalTasksContract.response[200]

export const homeContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      kind: z.enum(PARTNER_KINDS).nullable(),
      waiting: taskList.shape.items,
      badges: taskList.shape.badges,
      counts: z.array(output({ key: z.string(), area: z.string(), words: output({ it: z.string(), en: z.string() }), value: z.number().int().nullable() })),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})
