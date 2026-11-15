import { z } from 'zod'
import { ROUTE_SCOPES } from '@nexus/factory-domain/alert-routes/rules'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Alert routes' contracts (B-W2b-435; ANA-041; design home.alerts › Rules "goes to (role and place)"). A place's and a person's
 * names are data; the scope and whom-kind are codes the web says.
 */

const scope = z.enum(ROUTE_SCOPES)
const ref = output({ id: id(), code: z.string(), name: z.string() })

const routeView = output({
  id: id(),
  ruleId: id(),
  scope,
  scopeId: id(),
  place: output({ label: z.string(), code: z.string().nullable() }),
  who: output({ kind: z.enum(['ROLE', 'PERSON']), id: id(), name: z.string() }),
  createdAt: instant(),
})

export const listRoutesContract = defineContract({
  params: input({ id: id() }),
  response: {
    200: output({
      ruleId: id(),
      routes: z.array(routeView),
      canChange: z.boolean(),
      max: z.number().int(),
      /** What a route may name, inside the rule's place (only for a person who may change the rule). */
      choices: output({
        roles: z.array(output({ id: id(), name: z.string(), key: z.string() })),
        people: z.array(output({ id: id(), name: z.string() })),
        companies: z.array(output({ ...ref.shape, whole: z.boolean(), sites: z.array(output({ ...ref.shape, lines: z.array(ref) })) })),
        customers: z.array(ref),
        customersComplete: z.boolean(),
      }).nullable(),
    }),
  },
})

export const addRouteContract = defineContract({
  params: input({ id: id() }),
  body: input({ scope, scopeId: id(), roleId: id().nullable().optional(), userId: id().nullable().optional() }),
  response: { 201: output({ route: routeView }) },
})

export const removeRouteContract = defineContract({
  params: input({ routeId: id() }),
  response: { 200: output({ removed: z.boolean() }) },
})
