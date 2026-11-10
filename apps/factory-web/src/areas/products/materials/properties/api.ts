import { z } from 'zod'
import { materialDepthView, type MaterialDepthView } from '@nexus/factory-domain/product/materials-depth/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/** B-W2b-238: the typed properties of a material's kind, all at once, at the material's version (PUT …/properties). */
export function setProperties(api: ApiClient, material: { id: string; version: number }, properties: Record<string, string | boolean> | null): Promise<MaterialDepthView> {
  return api
    .request('PUT', `/product/materials/${encodeURIComponent(material.id)}/properties`, { body: { version: material.version, properties }, schema: z.object({ depth: materialDepthView }), idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.depth)
}
