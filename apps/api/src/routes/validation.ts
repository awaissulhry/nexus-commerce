/**
 * Validation Schemas
 * Zod schemas for request validation across routes.
 *
 * Pruned 2026-05-09 (L.0b) — pricing-rule, sync-health, and pagination
 * schemas were deleted alongside the dead Express router bundle.
 * Only CreateBulkJobSchema (consumed by bulk-operations.routes.ts)
 * remains. Add back as needed when new Fastify routes adopt them.
 */

import { z } from 'zod'

export const CreateBulkJobSchema = z.object({
  jobName: z.string().min(1, 'Job name is required').max(255),
  actionType: z.enum([
    'PRICING_UPDATE',
    'INVENTORY_UPDATE',
    'STATUS_UPDATE',
    'ATTRIBUTE_UPDATE',
    'LISTING_SYNC',
    'MARKETPLACE_OVERRIDE_UPDATE',
  ]),
  channel: z.string().optional(),
  targetProductIds: z.array(z.string()).optional(),
  targetVariationIds: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  actionPayload: z.record(z.string(), z.any()),
  createdBy: z.string().optional(),
})

export type CreateBulkJobRequest = z.infer<typeof CreateBulkJobSchema>
