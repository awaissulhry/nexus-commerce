import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { SUGGESTION_REASONS } from '@nexus/factory-domain/inventory/putaway/rules'
import { handView, moveContract } from '../bin-moves/contract'
import { taskView } from '../tasks/contract'

/** Put away by scan (B-W2b-292; SCM-202): "In your hands" with the suggested place; the put-away is the move's own body. */
export const scanContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(80) }),
  response: {
    200: output({
      hand: handView,
      /** Where it is taken from (the dock or the quarantine place it waits in, else where it lies), and where to put it. */
      from: output({ locationId: id(), code: z.string() }).nullable(),
      /** QUALITY: not released, to the site's quality place; DEFAULT: the site's put-away default for its kind; SAME_LOT: where the lot lies. */
      suggestion: output({ location: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }), why: z.enum(SUGGESTION_REASONS) }).nullable(),
      tasks: z.array(taskView),
    }),
  },
})

export const putAwayContract = moveContract
