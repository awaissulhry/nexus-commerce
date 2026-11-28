import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * owb-pd4 step 4.5 — the portal product page's own read beside the catalogue's style read (`fetchStyle`, GET /portal/catalogue/:styleId):
 * "Your orders with it" = the customer's own orders and requests that name the product (GET /portal/sales-orders, `q` = the product's
 * code: the API matches a line's style code or name, ALL states, the person's own organisation only — the brand wall is the API's).
 * The schema keeps only what the page draws: no amount, no price (the API's `netAmount` is left out here whatever the grain).
 */

const words = z.object({ it: z.string(), en: z.string() })
const orderRow = z.object({
  kind: z.enum(['ORDER', 'REQUEST']),
  id: z.string(),
  customerRef: z.string().nullable(),
  subject: z.string().nullable(),
  yourNumber: z.object({ seq: z.number().int(), words }).nullable(),
  orderedOn: z.string().nullable(),
  words,
  pieces: z.object({ ordered: z.number().int(), shipped: z.number().int(), open: z.number().int() }),
})
export type PortalOrderRow = z.infer<typeof orderRow>
const ordersAnswer = z.object({ items: z.array(orderRow), count: z.number().int() })

/** The customer's orders and requests that name this product (at most 6, newest first as the list sorts them). */
export const fetchOrdersWith = (api: ApiClient, code: string, signal?: AbortSignal): Promise<{ items: PortalOrderRow[]; count: number }> =>
  api.get('/portal/sales-orders', { query: { chip: 'ALL', q: code.slice(0, 80), limit: 6 }, schema: ordersAnswer, signal })

// ---- owb-pd5 (step 5.0; pd4s s.3): the product's Sizes for its customer — GET /portal/catalogue/:styleId/sizes (the reach of the
// catalogue's style read: another party's design answers 404; the newest RELEASED revision only; no cost, price, revision or route).
const sizesAnswer = z.object({
  picture: z.object({ fileId: z.string(), url: z.string() }).nullable(),
  mode: z.enum(['SIZES', 'MADE_TO_MEASURE']),
  sizes: z.array(z.string()),
  baseSize: z.string().nullable(),
  points: z.array(z.object({ code: z.string(), name: z.string(), howTo: z.string().nullable(), values: z.record(z.string(), z.number().nullable()) })),
  protectors: z.array(z.object({ zone: z.string(), level: z.enum(['LEVEL_2', 'LEVEL_1', 'NONE']) })),
})
export type PortalProductSizes = z.infer<typeof sizesAnswer>

export const fetchProductSizes = (api: ApiClient, styleId: string, signal?: AbortSignal): Promise<PortalProductSizes> =>
  api.get(`/portal/catalogue/${encodeURIComponent(styleId)}/sizes`, { schema: sizesAnswer, signal })
