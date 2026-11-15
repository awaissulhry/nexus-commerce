import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * Alert routes (B-W2b-435; ANA-041): GET|POST /alerts/rules/:id/routes, DELETE /alerts/routes/:routeId — checked by their
 * schemas. The shapes mirror apps/factory-api platform/alerts/routes/contract.ts.
 */

export const ROUTE_SCOPES = ['COMPANY', 'SITE', 'LINE', 'CUSTOMER'] as const
export type RouteScope = (typeof ROUTE_SCOPES)[number]

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const routeSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  scope: z.enum(ROUTE_SCOPES),
  scopeId: z.string(),
  place: z.object({ label: z.string(), code: z.string().nullable() }),
  who: z.object({ kind: z.enum(['ROLE', 'PERSON']), id: z.string(), name: z.string() }),
  createdAt: z.string(),
})
export type AlertRouteView = z.infer<typeof routeSchema>

export const routesSchema = z.object({
  ruleId: z.string(),
  routes: z.array(routeSchema),
  canChange: z.boolean(),
  max: z.number(),
  choices: z
    .object({
      roles: z.array(z.object({ id: z.string(), name: z.string(), key: z.string() })),
      people: z.array(z.object({ id: z.string(), name: z.string() })),
      companies: z.array(ref.extend({ whole: z.boolean(), sites: z.array(ref.extend({ lines: z.array(ref) })) })),
      customers: z.array(ref),
      customersComplete: z.boolean(),
    })
    .nullable(),
})
export type RuleRoutes = z.infer<typeof routesSchema>
export type RouteChoices = NonNullable<RuleRoutes['choices']>

export interface AddRouteBody {
  readonly scope: RouteScope
  readonly scopeId: string
  readonly roleId?: string | null
  readonly userId?: string | null
}

export function getRoutes(api: ApiClient, ruleId: string, signal?: AbortSignal): Promise<RuleRoutes> {
  return api.get(`/alerts/rules/${encodeURIComponent(ruleId)}/routes`, { schema: routesSchema, signal })
}

export async function addRoute(api: ApiClient, ruleId: string, body: AddRouteBody): Promise<AlertRouteView> {
  const answer = await api.post(`/alerts/rules/${encodeURIComponent(ruleId)}/routes`, { body, schema: z.object({ route: routeSchema }), idempotencyKey: newIdempotencyKey() })
  return answer.route
}

export async function removeRoute(api: ApiClient, routeId: string): Promise<void> {
  await api.request('DELETE', `/alerts/routes/${encodeURIComponent(routeId)}`, { schema: z.object({ removed: z.boolean() }), idempotencyKey: newIdempotencyKey() })
}
