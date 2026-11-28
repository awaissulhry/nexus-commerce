import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'

/**
 * owb-pd4s s.3 (S4 products; design order-workflow-2026-11-25 § 5q "Customer": the size table of the range, how to measure, the
 * protectors — nothing to type): the customer's product Sizes in its portal catalogue. The shape is FIXED (web A's
 * portal/customer/catalogue/product/api.ts codes against it). No cost, no price, no revision, no route, no worker, no material.
 */

export const PROTECTOR_ZONE_LEVELS = ['LEVEL_2', 'LEVEL_1', 'NONE'] as const

export const catalogueSizesView = output({
  /** The product's main picture: its small preview (~320 px, the stripped copy), presigned for 60 seconds; null: none it may see. */
  picture: output({ fileId: id(), url: z.string() }).nullable(),
  /** SIZES: a range of sizes with a size table; MADE_TO_MEASURE: cut to each rider's measurements (no range). */
  mode: z.enum(['SIZES', 'MADE_TO_MEASURE']),
  /** The range, in its order. */
  sizes: z.array(z.string()),
  baseSize: z.string().nullable(),
  /** The size table of the newest RELEASED revision: one row per point, its value per size in millimetres (null: none). */
  points: z.array(output({ code: z.string(), name: z.string(), howTo: z.string().nullable(), values: z.record(z.string(), z.number().nullable()) })),
  /** Each protector zone of the product with its level (EN 1621): placed ones, and the usual zones of its kind with NONE. */
  protectors: z.array(output({ zone: z.string(), level: z.enum(PROTECTOR_ZONE_LEVELS) })),
})
export type CatalogueSizesView = z.infer<typeof catalogueSizesView>

/** GET /portal/catalogue/:styleId/sizes (the customer's portal session). */
export const catalogueSizesContract = defineContract({
  params: input({ styleId: z.string().min(1).max(64) }),
  response: { 200: catalogueSizesView },
})
