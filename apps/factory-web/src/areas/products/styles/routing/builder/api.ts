import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { oneRouteRouting, revisionPath, routeStep, writeKey, type RouteRouting } from '../route/api'

/**
 * owb-pd6 step 6.2 (S4; brief owb-pd-server.md § Shape "pd2") — the route builder's calls, with this web's own zod: the product
 * route's atomic save (one command under the revision's version; a kept step keeps its `stepId`, so its depth survives), the model
 * and customer routes, the ready-made routes (closed = gone from "Start from a copy", kept, never deleted: S4 settle 8), the routes
 * of other products for "Start from a copy", and the customers a route may be only for. Every write: its version and an
 * idempotency key. A line's exception route is the line's own call (line/api.ts).
 */

/** A step as the builder sends it (a ready-made, model, customer or line route): its department and, when typed, its minutes. */
export interface StepOut {
  readonly departmentId: string
  readonly minutes?: string
}
/** A step of the product route: a kept step names its `stepId`. */
export interface ProductStepOut extends StepOut {
  readonly stepId?: string
}

/** `PUT …/routing/steps` — the product route, whole, in one command (product.routing.manage, DRAFT only); answers the routing. */
export function saveProductRoute(api: ApiClient, styleId: string, revisionId: string, body: { version: number; steps: readonly ProductStepOut[] }): Promise<RouteRouting> {
  return api.request('PUT', `${revisionPath(styleId, revisionId)}/routing/steps`, { body, schema: oneRouteRouting, ...writeKey() }).then((answer) => answer.routing)
}

export interface RouteBody {
  readonly name: string
  readonly kind: 'MODEL' | 'CUSTOMER'
  readonly partyId: string | null
  readonly steps: readonly StepOut[]
}

/** What a new route's answer may name: its id, so the tab shows it at once (an answer without it is read again). */
const madeRoute = z.object({ route: z.object({ id: z.string() }).passthrough().optional() }).passthrough()

/** `POST …/routes` — a new model or customer route on the DRAFT revision; answers the new route's id when the server gives it. */
export function createStyleRoute(api: ApiClient, styleId: string, revisionId: string, body: RouteBody): Promise<string | null> {
  // No schema on the call: a saved route is never reported as a failure because its answer has another shape.
  return api.post(`${revisionPath(styleId, revisionId)}/routes`, { body, ...writeKey() }).then((answer) => {
    const read = madeRoute.safeParse(answer)
    return read.success ? (read.data.route?.id ?? null) : null
  })
}

/** `PUT …/routes/:routeId` — the whole route, under its version. */
export function updateStyleRoute(api: ApiClient, styleId: string, revisionId: string, routeId: string, body: RouteBody & { version: number }): Promise<unknown> {
  return api.request('PUT', `${revisionPath(styleId, revisionId)}/routes/${encodeURIComponent(routeId)}`, { body, ...writeKey() })
}

// ---- ready-made routes -------------------------------------------------------------------------------------------------------

const template = z.object({ id: z.string(), name: z.string(), steps: z.array(routeStep), status: z.enum(['OPEN', 'CLOSED']), version: z.number().int() })
export type RouteTemplate = z.infer<typeof template>
const templates = z.object({ templates: z.array(template) })

/** `GET /product/route-templates?status=ALL` — the open ones ("Start from a copy") and the closed ones ("Open again"). */
export function readTemplates(api: ApiClient, signal?: AbortSignal): Promise<RouteTemplate[]> {
  return api.get('/product/route-templates', { query: { status: 'ALL' }, schema: templates, signal }).then((answer) => answer.templates)
}

/** `POST /product/route-templates` — "Save as ready-made": a name and the route's steps; every product can copy it. */
export function createTemplate(api: ApiClient, body: { name: string; steps: readonly StepOut[] }): Promise<unknown> {
  return api.post('/product/route-templates', { body, ...writeKey() })
}

/** `POST /product/route-templates/:id/close|open` — out of "Start from a copy" (kept), or back in it. */
export function setTemplateOpen(api: ApiClient, entry: { id: string; version: number }, open: boolean): Promise<unknown> {
  return api.post(`/product/route-templates/${encodeURIComponent(entry.id)}/${open ? 'open' : 'close'}`, { body: { version: entry.version }, ...writeKey() })
}

// ---- the routes of other products ("Start from a copy") -----------------------------------------------------------------------

const source = z.object({
  styleId: z.string(),
  code: z.string(),
  name: z.string(),
  revision: z.number().int(),
  product: z.array(routeStep),
  routes: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['MODEL', 'CUSTOMER']), steps: z.array(routeStep) })).default([]),
})
export type RouteSource = z.infer<typeof source>
const sources = z.object({ products: z.array(source) })

/** `GET /product/route-sources?q=` — at most 50 products the person reaches, with their product route and their other routes. */
export function readRouteSources(api: ApiClient, q: string, signal?: AbortSignal): Promise<RouteSource[]> {
  return api.get('/product/route-sources', { query: { q: q.trim() || undefined }, schema: sources, signal }).then((answer) => answer.products)
}

// ---- the customers a route may be only for --------------------------------------------------------------------------------------

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable().optional() })

/** The active customers of the company (parties.view), as "CODE · Name". */
export function readCustomers(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<{ id: string; code: string; name: string }[]> {
  return api
    .get('/parties', { query: { role: 'CUSTOMER,BRAND', status: 'ACTIVE', companyId: companyId ?? undefined, limit: 200 }, schema: z.object({ parties: z.array(partyOption) }), signal })
    .then((answer) => answer.parties.map((party) => ({ id: party.id, code: party.code, name: party.tradeName?.trim() || party.legalName })))
}
