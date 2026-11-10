import { z } from 'zod'
import { materialWhereUsedView, type MaterialWhereUsedView } from '@nexus/factory-domain/product/materials-depth/contracts'
import type { ApiClient } from '../../../../lib/api/client'

export type { MaterialWhereUsedView }

/** B-W2b-238: where a material is used (every BOM line, revision and open work order), optionally of one of its colours. */
export function readWhereUsed(api: ApiClient, materialId: string, itemColourId: string | null): Promise<MaterialWhereUsedView> {
  return api
    .get(`/product/materials/${encodeURIComponent(materialId)}/where-used`, { query: { itemColourId: itemColourId ?? undefined }, schema: z.object({ whereUsed: materialWhereUsedView }) })
    .then((answer) => answer.whereUsed)
}
