import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { MAX_ORDER_TEAMS, ORDER_TEAM_MODES, TEAM_MARKS } from '@nexus/factory-domain/production/order-teams/rules'
import { PICTURE_KINDS } from '@nexus/factory-domain/people/teams/picture'

/**
 * Teams own the work (owb-ss5 step 5.1; build/briefs/owb-ss5.md § Shape — FIXED: web B codes against it). Office only. A team's
 * figure (baskets in work, missing today, late, an order's baskets in its column) is null for a team smaller than its company's
 * smallest group (people settings `minimumGroupSize`): never a figure about one person. The customer is named by its CODE.
 */

export const pictureOut = output({ kind: z.enum(PICTURE_KINDS), icon: z.string().nullable(), colour: z.string().nullable(), letters: z.string() })

export const teamFaceOut = output({
  id: id(),
  name: z.string(),
  picture: pictureOut,
  leader: output({ employeeId: id(), name: z.string() }).nullable(),
  people: z.number().int().nullable(),
})

const factsOut = output({
  inWork: z.number().int().nullable(),
  maxBaskets: z.number().int().nullable(),
  workedForCustomer: z.boolean(),
  takesNewOrders: z.boolean(),
  overLimit: z.boolean(),
  missingToday: z.number().int().nullable(),
  late: z.number().int().nullable(),
})

export const orderTeamsOut = output({
  orderId: id(),
  version: z.number().int(),
  printed: z.boolean(),
  mode: z.enum(ORDER_TEAM_MODES),
  plannedBaskets: z.number().int(),
  rows: z.array(output({ team: teamFaceOut, inCharge: z.boolean(), basketShare: z.number().int().nullable(), givenBy: z.enum(['USER', 'RULE']), facts: factsOut })),
  may: output({ give: z.boolean(), ask: z.boolean() }),
})

export const orderTeamsContract = defineContract({
  params: input({ orderId: id() }),
  response: { 200: orderTeamsOut },
})

export const putOrderTeamsContract = defineContract({
  params: input({ orderId: id() }),
  body: input({
    version: z.number().int().min(1),
    rows: z.array(input({ teamId: id(), inCharge: z.boolean(), basketShare: z.number().int().min(1).nullable() })).max(MAX_ORDER_TEAMS),
    why: z.string().trim().min(1).max(500).optional(),
  }),
  response: { 200: orderTeamsOut },
})

export const teamAskContract = defineContract({
  params: input({ orderId: id() }),
  body: input({ why: z.string().trim().min(3).max(500) }),
  response: { 200: output({ taskId: id() }), 201: output({ taskId: id() }) },
})

export const teamsBoardContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      columns: z.array(
        output({
          /** null: "No team yet". */
          team: teamFaceOut.nullable(),
          load: output({ inWork: z.number().int().nullable(), maxBaskets: z.number().int().nullable() }),
          /** Mark codes (TEAM_MARKS); the words are the web's. */
          marks: z.array(z.enum(TEAM_MARKS)),
          orders: z.array(output({ orderId: id(), number: z.string(), customerCode: z.string(), baskets: z.number().int().nullable(), inCharge: z.boolean(), due: businessDate().nullable(), late: z.boolean() })),
        }),
      ),
      teams: z.array(teamFaceOut.extend({ takesNewOrders: z.boolean() })),
    }),
  },
})
