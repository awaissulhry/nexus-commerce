import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EXTRA_RIGHTS } from '@nexus/factory-domain/people/by-customer/rules'

/**
 * owb-of2 step 3 (order workflow, plan.md § 5f "People by customer", § 5h "Give to every customer" / "Take out for every customer…";
 * the Shape FIXED in build/briefs/owb-of2.md — web A of4 codes against it). No price field.
 */

const extra = z.array(z.enum(EXTRA_RIGHTS))
const givenRow = output({ partyId: id(), userId: id(), since: instant(), byName: z.string() })

export const peopleByCustomerContract = defineContract({
  response: {
    200: output({
      people: z.array(output({ userId: id(), name: z.string(), roleWords: z.string(), extra })),
      customers: z.array(output({ partyId: id(), code: z.string(), name: z.string() })),
      given: z.array(givenRow),
      may: output({ write: z.boolean() }),
    }),
  },
})

export const giveToCustomerContract = defineContract({
  params: input({ partyId: id(), userId: id() }),
  body: input({ given: z.boolean() }),
  response: { 200: output({ given: z.array(givenRow) }) },
})

export const everyCustomerContract = defineContract({
  body: input({ userId: id(), given: z.boolean() }),
  response: { 200: output({ given: z.array(givenRow) }) },
})

export const extraRightContract = defineContract({
  params: input({ userId: id() }),
  body: input({ right: z.enum(EXTRA_RIGHTS), on: z.boolean() }),
  response: { 200: output({ person: output({ userId: id(), extra }) }) },
})

export type GivenRowView = z.infer<typeof givenRow>
