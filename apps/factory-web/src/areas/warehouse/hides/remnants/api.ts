import { z } from 'zod'
import { AREA_UOMS } from '@nexus/factory-domain/inventory/hides/area'
import { REMNANT_STATES } from '@nexus/factory-domain/inventory/remnants/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The remnant pieces (B-W2b-131 on B-W2b-100's API; SCM-254; design warehouse.hides tile "Remnants (pieces · m², W2b)" and
 * the Remnants view): tagged offcuts (RM-…) one by one, pieces beside area.
 *   GET /inventory/remnants              a site's pieces (state default IN_STOCK, `all`), totals per unit for the whole
 *                                        selection, the smallest piece kept (inventory.stock.view)
 *   GET /inventory/remnants/:remnantId   one piece and its history (TAGGED, STATE, MOVED; an office person by name, a floor
 *                                        action by its audience only)
 * The API's English (`words`, `cause` sentences) is never drawn: the screen says the codes in its words.
 */

const clean = (query: Record<string, string | number | null | undefined>) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))
const areaUom = z.enum(AREA_UOMS)
const figure = z.object({ uom: areaUom, quantity: z.string(), other: z.object({ uom: areaUom, quantity: z.string() }) })

const remnantSchema = z.object({
  id: z.string(),
  code: z.string(),
  state: z.enum(REMNANT_STATES),
  area: figure,
  baseArea: z.string(),
  baseUom: z.string(),
  grade: z.string().nullable(),
  hide: z.object({ id: z.string(), code: z.string(), state: z.string() }),
  lot: z.object({ id: z.string(), code: z.string(), dyeBatch: z.string().nullable() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  shade: z.string().nullable(),
  outOfShade: z.boolean(),
  location: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  move: z.object({ id: z.string(), reason: z.string(), workOrderNumber: z.string().nullable(), occurredAt: z.string() }),
  note: z.string().nullable(),
  createdAt: z.string(),
})
export type RemnantRow = z.infer<typeof remnantSchema>

const listSchema = z.object({
  rows: z.array(remnantSchema),
  nextCursor: z.string().nullable(),
  totals: z.array(z.object({ uom: areaUom, pieces: z.number(), area: z.string() })),
  minimum: z.object({ area: z.string(), uom: areaUom, setting: z.boolean() }),
})
export type RemnantsPage = z.infer<typeof listSchema>

export interface RemnantQuery {
  siteId: string | null
  itemId?: string | null
  lotId?: string | null
  q?: string | null
  cursor?: string | null
  limit?: number
}
export const listRemnants = (api: ApiClient, query: RemnantQuery, signal?: AbortSignal) =>
  api.get('/inventory/remnants', { query: clean({ siteId: query.siteId, itemId: query.itemId, lotId: query.lotId, q: query.q?.trim() || null, cursor: query.cursor, limit: query.limit ?? 50 }), schema: listSchema, signal })

const historySchema = z.object({ at: z.string(), action: z.enum(['TAGGED', 'STATE', 'MOVED']), from: z.string().nullable(), to: z.string().nullable(), by: z.string().nullable(), audience: z.string() })
const recordSchema = z.object({ remnant: remnantSchema, minimum: z.object({ baseArea: z.string(), setting: z.boolean() }).nullable(), history: z.array(historySchema) })
export type RemnantRecord = z.infer<typeof recordSchema>
export const remnantRecord = (api: ApiClient, remnantId: string, signal?: AbortSignal) => api.get(`/inventory/remnants/${encodeURIComponent(remnantId)}`, { schema: recordSchema, signal })
