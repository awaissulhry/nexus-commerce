import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { GRAINS, roleSchema } from '../../shared/api'
import type { RoleReview } from './model'

/**
 * Change role, archive and restore (B-W2b-413 on B-W2b-404's API; PLT-031), roles.manage: the review of a change before it is
 * saved (`POST /auth/roles/:id/review`, no write), the save at the version read (`PATCH /auth/roles/:id`: a fresh code only
 * when it raises rights or changes two-factor), and a custom role archived (with a reason; its live assignments end) or
 * restored. Refusals travel as codes in their paths (model.ts says them).
 */

const grain = z.enum(GRAINS)
const reviewSchema: z.ZodType<RoleReview> = z.object({
  version: z.number(),
  permissionsAdded: z.array(z.string()),
  permissionsRemoved: z.array(z.string()),
  grainsAdded: z.array(grain),
  grainsRemoved: z.array(grain),
  requireMfa: z.object({ before: z.boolean(), after: z.boolean() }),
  raises: z.boolean(),
  asksFreshCode: z.boolean(),
  holders: z.number(),
  refusals: z.array(z.object({ path: z.string(), message: z.string() })),
})

export interface RoleChange {
  permissions: string[]
  grains: string[]
  requireMfa?: boolean
}

export const reviewRole = (api: ApiClient, roleId: string, change: RoleChange) => api.post(`/auth/roles/${encodeURIComponent(roleId)}/review`, { body: change, schema: reviewSchema })

export const saveRole = (api: ApiClient, roleId: string, body: RoleChange & { version: number }) =>
  api.request('PATCH', `/auth/roles/${encodeURIComponent(roleId)}`, { body, schema: roleSchema, idempotencyKey: newIdempotencyKey() })

export const archiveRole = (api: ApiClient, roleId: string, body: { version: number; reason: string }) =>
  api.post(`/auth/roles/${encodeURIComponent(roleId)}/archive`, { body, schema: roleSchema, idempotencyKey: newIdempotencyKey() })

export const restoreRole = (api: ApiClient, roleId: string, body: { version: number }) =>
  api.post(`/auth/roles/${encodeURIComponent(roleId)}/restore`, { body, schema: roleSchema, idempotencyKey: newIdempotencyKey() })
