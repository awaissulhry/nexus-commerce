import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { minimumSchema, type Minimum } from '../depth/api'
import type { MinimumPatch } from './model'

/**
 * A minimum order quantity edited in place (B-W2b-380, XF6:03): `PATCH /sales/minimums/:ruleId` with the version read and
 * only the cells changed (its company and subject stay; B-W2b-325's route). Answers the minimum as it is now.
 */
export function updateMinimum(api: ApiClient, minimum: Pick<Minimum, 'id' | 'version'>, patch: MinimumPatch): Promise<Minimum> {
  return api
    .request('PATCH', `/sales/minimums/${encodeURIComponent(minimum.id)}`, { body: { version: minimum.version, ...patch }, schema: z.object({ minimum: minimumSchema }), idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.minimum)
}
