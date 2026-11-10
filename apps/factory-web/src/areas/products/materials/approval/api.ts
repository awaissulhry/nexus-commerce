import { z } from 'zod'
import { materialApprovalsView, materialDepthView, type MaterialApprovalsView, type MaterialDepthView } from '@nexus/factory-domain/product/materials-depth/contracts'
import type { MaterialApproval } from '@nexus/factory-domain/product/materials-depth/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Materials in depth (B-W2b-238), the calls of the material record's Properties & grades and Compliance tabs and of the
 * style's Compliance tab, each answer checked against the API's own contract (factory-domain product/materials-depth): the
 * depth of a material (its properties of its kind, its fibres as the label reads them, its approval and what a decision
 * reaches), a decision on the approval at the material's version, and the approvals of the materials a style's revision
 * names. Writes send the version and an idempotency key.
 */

export type { MaterialApprovalsView, MaterialDepthView }

const enc = encodeURIComponent
const depth = z.object({ depth: materialDepthView })

export function readDepth(api: ApiClient, materialId: string): Promise<MaterialDepthView> {
  return api.get(`/product/materials/${enc(materialId)}/depth`, { schema: depth }).then((answer) => answer.depth)
}

export function decideApproval(api: ApiClient, material: { id: string; version: number }, approval: MaterialApproval, note: string | null): Promise<MaterialDepthView> {
  return api
    .request('PUT', `/product/materials/${enc(material.id)}/approval`, { body: { version: material.version, approval, note }, schema: depth, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.depth)
}

const approvals = z.object({ approvals: materialApprovalsView })

export function readStyleApprovals(api: ApiClient, styleId: string, revisionId: string): Promise<MaterialApprovalsView> {
  return api.get(`/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}/material-approvals`, { schema: approvals }).then((answer) => answer.approvals)
}
