import { z } from 'zod'
import { massApplyView, massPreviewView, type MassApplyView, type MassPreviewView } from '@nexus/factory-domain/costing/mass-update/contracts'
import { materialRow, type MaterialRow } from '@nexus/factory-domain/product/materials/contracts'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The mass cost update's calls (B-W2b-430 on B-W2b-423's routes; design finance.costing pop:mass): find a material (Products'
 * list: product.materials.view), the preview of one or more new standard prices (costing.view + the cost grain: the series
 * recomputed, the drafts that would be made, the effect on price lists and open order lines) and the apply with the preview's
 * hash (costing.massUpdate.apply + a fresh code: new DRAFT versions, never an approved one). Answers checked against the API's
 * own contracts; the API's English words are not drawn.
 */

export type { MassApplyView, MassPreviewView, MaterialRow }
export type MassChange = { itemId: string; newPrice: string }

const materialPage = z.object({ materials: z.array(materialRow) })

/** Active materials matching a search (code or name), at most 20. */
export async function findMaterials(api: ApiClient, q: string, signal?: AbortSignal): Promise<MaterialRow[]> {
  return (await api.get('/product/materials', { query: { q: q.trim() || undefined, status: 'ACTIVE', limit: 20 }, schema: materialPage, signal })).materials
}

export function previewMassUpdate(api: ApiClient, changes: readonly MassChange[], signal?: AbortSignal): Promise<MassPreviewView> {
  return api.post('/costing/mass-updates/preview', { body: { changes }, schema: massPreviewView, signal })
}

export function applyMassUpdate(api: ApiClient, body: { changes: readonly MassChange[]; previewHash: string; leaveOutMissing?: boolean; note?: string }, idempotencyKey: string): Promise<MassApplyView> {
  return api.post('/costing/mass-updates/apply', { body, schema: massApplyView, idempotencyKey })
}
