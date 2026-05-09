/**
 * Validation Schemas
 * Zod schemas for request validation across routes.
 *
 * Pruned 2026-05-09 (L.0b) — pricing-rule, sync-health, and pagination
 * schemas were deleted alongside the dead Express router bundle.
 * Only CreateBulkJobSchema (consumed by bulk-operations.routes.ts)
 * remains. Add back as needed when new Fastify routes adopt them.
 *
 * W1.2 (2026-05-09) — actionType enum is now sourced from the canonical
 * BulkActionType union in bulk-action.service.ts so this Zod schema
 * cannot drift away from runtime expectations.
 */

import { z } from 'zod'
import {
  KNOWN_BULK_ACTION_TYPES,
  type BulkActionType,
} from '../services/bulk-action.service.js'

// Cast preserves the BulkActionType literal union through the Zod
// schema so `infer<typeof CreateBulkJobSchema>['actionType']` is the
// real union (not just `string`) — keeps callers like
// bulkActionService.createJob type-safe end-to-end.
const ACTION_TYPE_TUPLE = Array.from(KNOWN_BULK_ACTION_TYPES) as [
  BulkActionType,
  ...BulkActionType[],
]

export const CreateBulkJobSchema = z.object({
  jobName: z.string().min(1, 'Job name is required').max(255),
  actionType: z.enum(ACTION_TYPE_TUPLE),
  channel: z.string().optional(),
  targetProductIds: z.array(z.string()).optional(),
  targetVariationIds: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  actionPayload: z.record(z.string(), z.any()),
  createdBy: z.string().optional(),
})

export type CreateBulkJobRequest = z.infer<typeof CreateBulkJobSchema>
