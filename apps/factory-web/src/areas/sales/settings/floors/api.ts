import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Sales settings › Quote approval rules › Margin floor % per role (B-W2b-343 on B-W2b-330's GET / PUT
 * /sales/settings/margin-floors, SAL-189): the floors are the margin grain — ABSENT without it. A row's `version` guards
 * its floors; lowering one (or adding one under the row's floor) asks a fresh step-up (403 `stepUp`).
 */

const floorsRow = z.object({ id: z.string(), companyId: z.string().nullable(), floors: z.record(z.string(), z.string()).nullable().optional(), version: z.number(), updatedAt: z.string() })
export type FloorsRow = z.infer<typeof floorsRow>

const floorsSchema = z.object({
  tenant: floorsRow.nullable(),
  company: floorsRow.nullable(),
  inForce: z.object({ floors: z.record(z.string(), z.string()).nullable().optional(), from: z.enum(['COMPANY', 'TENANT']).nullable(), companyFloorPct: z.string().optional() }),
  roles: z.array(z.object({ key: z.string(), name: z.string() })),
})
export type MarginFloors = z.infer<typeof floorsSchema>

/** The floors of the group's row and (with `companyId`) the company's, the floors in force, the office roles. */
export function readFloors(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<MarginFloors> {
  return api.get('/sales/settings/margin-floors', { query: { companyId: companyId ?? undefined }, schema: floorsSchema, signal })
}

/** One row's floors (null: no role's own floor), at its version. */
export function saveFloors(api: ApiClient, body: { companyId: string | null; version: number; floors: Record<string, string> | null }) {
  return api.request('PUT', '/sales/settings/margin-floors', {
    body: { ...(body.companyId ? { companyId: body.companyId } : {}), version: body.version, floors: body.floors },
    schema: z.object({ settings: floorsRow }),
    idempotencyKey: newIdempotencyKey(),
  })
}
