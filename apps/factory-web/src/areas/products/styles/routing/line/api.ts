import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { routeStep, writeKey } from '../route/api'
import type { StepOut } from '../builder/api'

/**
 * owb-pd6 step 6.4 (S4; design plan § 5v, § 5z; brief owb-pd-server.md § Shape "pd2") — the order's "Route of each line": each line's
 * route as `routeOfLine()` resolves it (line exception → picked model → order structure → customer route → structure rule → the
 * product's route), where it comes from, the model routes sales may pick, and the production manager's exception. The server says
 * who may do what (`may`) and whether the basket cards are printed (`frozen`: every route of the order is fixed). Office only: the
 * customer never reaches these routes. This web's own zod (a new source word never breaks the part: read as text).
 */

const enc = encodeURIComponent

const lineRoute = z.object({
  lineId: z.string(),
  seq: z.number().int(),
  product: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  /** REVISION · MODEL · CUSTOMER · STRUCTURE · RULE · EXCEPTION (S4 + S3; read as text). */
  source: z.string(),
  routeName: z.string().nullable().optional(),
  steps: z.array(routeStep),
  choices: z.array(z.object({ routeId: z.string(), name: z.string() })).default([]),
  pickedRouteId: z.string().nullable().optional(),
  exception: z.object({ reason: z.string(), by: z.string().nullable().optional(), at: z.string() }).nullable().optional(),
  version: z.number().int().nullable().optional(),
})
export type LineRoute = z.infer<typeof lineRoute>

export const lineRoutesAnswer = z.object({
  /** An OrderPrint FIRST exists: "Fixed at the print of the basket cards". */
  frozen: z.boolean(),
  may: z.object({ pick: z.boolean(), exception: z.boolean() }),
  lines: z.array(lineRoute),
})
export type LineRoutes = z.infer<typeof lineRoutesAnswer>

const orderPath = (orderId: string) => `/sales/orders/${enc(orderId)}`
const linePath = (orderId: string, lineId: string) => `${orderPath(orderId)}/lines/${enc(lineId)}`

/** `GET /sales/orders/:orderId/line-routes` (orders.view, or orders.view.own on an order the person is on; brand wall). */
export function readLineRoutes(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<LineRoutes> {
  return api.get(`${orderPath(orderId)}/line-routes`, { schema: lineRoutesAnswer, signal })
}

/** `PUT …/lines/:lineId/route { version?, routeId }` — sales picks a model route (null: back to the normal route). orders.manage. */
export function pickLineRoute(api: ApiClient, orderId: string, line: Pick<LineRoute, 'lineId' | 'version'>, routeId: string | null): Promise<unknown> {
  return api.request('PUT', `${linePath(orderId, line.lineId)}/route`, { body: { ...(line.version != null ? { version: line.version } : {}), routeId }, ...writeKey() })
}

/** `PUT …/lines/:lineId/route-exception { version?, steps, reason }` — only the production manager (product.routing.manage). */
export function putLineException(api: ApiClient, orderId: string, lineId: string, body: { version?: number; steps: readonly StepOut[]; reason: string }): Promise<unknown> {
  return api.request('PUT', `${linePath(orderId, lineId)}/route-exception`, { body, ...writeKey() })
}

/** `DELETE …/lines/:lineId/route-exception?version=` — "Back to the normal route". */
export function dropLineException(api: ApiClient, orderId: string, line: Pick<LineRoute, 'lineId' | 'version'>): Promise<unknown> {
  return api.request('DELETE', `${linePath(orderId, line.lineId)}/route-exception`, { query: { version: line.version ?? undefined }, ...writeKey() })
}
