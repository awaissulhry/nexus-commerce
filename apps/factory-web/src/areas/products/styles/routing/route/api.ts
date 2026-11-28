import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * owb-pd6 step 6.1 (S4; design plan § 5u, § 5v; brief owb-pd-server.md § Shape "pd2") — the Route tab's own read of a revision's
 * routing, with THIS web's own zod: only the fields the tab draws, every new one optional, so the tab works before and after the
 * server's routes wave (pd2) lands. `GET …/routing` answers today's routing plus `steps[i].department`, `rules` and `routes` (the
 * model and customer routes of the revision). The record's own read (styles/api.ts getRouting, the domain contract) still feeds
 * the depth under "More"; this read feeds the route face and the builder.
 *
 * Every write sends the version it was made on and an idempotency key; a refusal comes back as an ApiError (lib/api/errors.ts).
 */

const enc = encodeURIComponent
export const revisionPath = (styleId: string, revisionId: string): string => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}`
export const writeKey = (): { idempotencyKey: string } => ({ idempotencyKey: newIdempotencyKey() })

/** A route's rules as the server checks them (D/product/routing/rules.ts routeProblems): codes, read as text so a new code never breaks a page. */
const routeRules = z.object({ errors: z.array(z.string()).default([]), warnings: z.array(z.string()).default([]) })
export type RouteRules = z.infer<typeof routeRules>
export const NO_RULES: RouteRules = Object.freeze({ errors: [], warnings: [] }) as RouteRules

/** One step of a model or customer route (or of a ready-made route, a line's route). */
export const routeStep = z.object({
  stepId: z.string().optional(),
  departmentId: z.string(),
  number: z.number().int(),
  minutes: z.string().nullable().optional(),
})
export type RouteStep = z.infer<typeof routeStep>

const party = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type RouteParty = z.infer<typeof party>

/** A model route (sales picks it on an order line) or a customer route (used by itself on that customer's orders). */
export const styleRoute = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['MODEL', 'CUSTOMER']),
  party: party.nullable().optional(),
  steps: z.array(routeStep),
  rules: routeRules.optional(),
  version: z.number().int(),
})
export type StyleRouteView = z.infer<typeof styleRoute>

/** A step of the product route: a routing step of the revision and its department (null: an old step the server could not place). */
const productStep = z.object({
  id: z.string(),
  seq: z.number().int(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.string(),
  standardMinutes: z.string(),
  department: z.object({ id: z.string(), number: z.number().int() }).nullable().optional(),
})
export type ProductStep = z.infer<typeof productStep>

export const routeRouting = z.object({
  revision: z.object({ id: z.string(), revision: z.number().int(), status: z.string(), version: z.number().int() }),
  /** A DRAFT revision of a style that is not archived. */
  editable: z.boolean(),
  steps: z.array(productStep),
  rules: routeRules.optional(),
  routes: z.array(styleRoute).optional(),
})
export type RouteRouting = z.infer<typeof routeRouting>
export const oneRouteRouting = z.object({ routing: routeRouting })

/** The revision's routing as the Route tab reads it. */
export function readRoute(api: ApiClient, styleId: string, revisionId: string, signal?: AbortSignal): Promise<RouteRouting> {
  return api.get(`${revisionPath(styleId, revisionId)}/routing`, { schema: oneRouteRouting, signal }).then((answer) => answer.routing)
}

/** Take a model or customer route out of a DRAFT revision (product.routing.manage). */
export function deleteStyleRoute(api: ApiClient, styleId: string, revisionId: string, route: { id: string; version: number }): Promise<unknown> {
  return api.request('DELETE', `${revisionPath(styleId, revisionId)}/routes/${enc(route.id)}`, { query: { version: route.version }, ...writeKey() })
}
