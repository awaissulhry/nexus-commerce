import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * The customer's catalogue in the portal (apps/factory-api modules/sales/portal-ordering, B-W2b-190; SAL-071; design
 * portal.customer.catalogue, SCR-226): the styles this customer may buy with its prices, the filters' values with their
 * counts, and one style with its colours, the sizes each offers and the price per colour. Prices are decimal strings and
 * come ONLY with the price grain (the API drops them for a role without it: `seesPrices` false). The API's English words
 * (`ppe.words`) are dropped: the page says the PPE category from its code.
 */

export const RANGES = ['ALL', 'OWN_LABEL', 'OPEN_RANGE'] as const
export type RangeFilter = (typeof RANGES)[number]
export const isRange = (value: unknown): value is RangeFilter => typeof value === 'string' && (RANGES as readonly string[]).includes(value)

const colour = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type CatalogueColour = z.infer<typeof colour>

export const styleCardSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.object({ it: z.string().optional(), en: z.string().optional() }).nullable(),
  productType: z.string(),
  season: z.string().nullable(),
  ownLabel: z.boolean(),
  colours: z.array(colour),
  sizes: z.array(z.string()),
  range: z.string(),
  ppe: z.object({ category: z.string(), standard: z.string().nullable(), class: z.string().nullable() }),
  priceFrom: z.string().nullable().optional(),
})
export type StyleCard = z.infer<typeof styleCardSchema>

const facet = z.array(z.object({ value: z.string(), count: z.number() }))
export type Facet = z.infer<typeof facet>

export const catalogueSchema = z.object({
  styles: z.array(styleCardSchema),
  count: z.number(),
  total: z.number(),
  facets: z.object({ categories: facet, seasons: facet, ppe: facet, ownLabel: z.number(), openRange: z.number() }),
  currency: z.string(),
  asOf: z.string(),
  seesPrices: z.boolean(),
})
export type CatalogueRead = z.infer<typeof catalogueSchema>

export interface CatalogueQuery {
  q?: string | null
  category?: string | null
  season?: string | null
  ppe?: string | null
  range?: RangeFilter | null
}

const text = (value: string | null | undefined): string | undefined => (value && value.trim() !== '' ? value.trim() : undefined)

export const fetchCatalogue = (api: ApiClient, query: CatalogueQuery, signal?: AbortSignal): Promise<CatalogueRead> =>
  api.get('/portal/catalogue', {
    query: { q: text(query.q), category: text(query.category), season: text(query.season), ppe: text(query.ppe), range: query.range && query.range !== 'ALL' ? query.range : undefined },
    schema: catalogueSchema,
    signal,
  })

export const styleDetailSchema = z.object({
  style: styleCardSchema.extend({
    description: z.string().nullable(),
    baseSize: z.string().nullable(),
    revision: z.number().nullable(),
    colourways: z.array(colour.extend({ sizes: z.array(z.object({ size: z.string(), offered: z.boolean() })), price: z.string().nullable().optional() })),
  }),
  currency: z.string(),
  asOf: z.string(),
  seesPrices: z.boolean(),
})
export type StyleDetail = z.infer<typeof styleDetailSchema>
export type StyleColourway = StyleDetail['style']['colourways'][number]

export const fetchStyle = (api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleDetail> =>
  api.get(`/portal/catalogue/${encodeURIComponent(styleId)}`, { schema: styleDetailSchema, signal })
