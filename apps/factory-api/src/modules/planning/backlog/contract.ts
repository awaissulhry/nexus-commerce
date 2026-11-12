import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PRIORITY_LEVELS, RANK_BATCH_MAX, RANK_MAX, RANK_MIN } from '@nexus/factory-domain/planning/backlog/rank'

/**
 * The backlog ranked (B-W2b-317; PLN-177): a company's open sales orders in the order planning serves them. No money, no
 * person.
 */

const backlogView = output({
  company: output({ id: id(), code: z.string(), name: z.string() }),
  today: businessDate(),
  asOf: instant(),
  /** How the backlog is ordered, in words. */
  rule: z.string(),
  counts: output({ open: z.number().int(), ranked: z.number().int() }),
  complete: z.boolean(),
  may: output({ rank: z.boolean() }),
  orders: z.array(
    output({
      id: id(),
      number: z.string(),
      status: z.string(),
      customer: output({ id: id(), code: z.string(), name: z.string() }),
      priorityLevel: z.enum(PRIORITY_LEVELS),
      priority: z.number().int(),
      /** The planner's rank (null: by the rule). */
      rank: z.number().int().nullable(),
      /** Its place in the backlog (1 first), and by the rule alone. */
      position: z.number().int(),
      rulePosition: z.number().int(),
      /** The earliest promise of its open lines. */
      promise: businessDate().nullable(),
      orderDate: businessDate(),
      lines: z.number().int(),
      pieces: z.number().int(),
      why: z.string(),
    }),
  ),
})

export const backlogContract = defineContract({
  querystring: input({ companyId: id(), siteId: id().optional(), q: z.string().trim().max(100).optional() }),
  response: { 200: backlogView },
})

const rank = z.number().int().min(RANK_MIN).max(RANK_MAX).nullable()

export const ranksContract = defineContract({
  body: input({
    companyId: id(),
    ranks: z
      .array(
        input({
          orderId: id(),
          /** The rank read (null: by the rule): another one now means someone ranked it since (409). */
          from: rank,
          /** The new rank (null: back to the rule). */
          to: rank,
        }),
      )
      .min(1)
      .max(RANK_BATCH_MAX),
  }),
  response: { 200: output({ changed: z.number().int(), replayed: z.boolean(), backlog: backlogView }) },
})

export const rankByRuleContract = defineContract({
  body: input({ companyId: id(), apply: z.boolean() }),
  response: {
    200: output({
      applied: z.boolean(),
      changed: z.number().int(),
      ranks: z.array(output({ id: id(), number: z.string(), from: z.number().int().nullable(), to: z.number().int() })),
      replayed: z.boolean(),
      backlog: backlogView.nullable(),
    }),
  },
})
