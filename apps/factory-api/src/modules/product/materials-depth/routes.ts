import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { materialApprovals } from './approvals'
import { decideApprovalContract, materialApprovalsContract, readDepthContract, setPropertiesContract, whereUsedContract } from './contract'
import { decideApproval, readDepth, setProperties } from './depth'
import { manifest } from './manifest'
import { materialWhereUsed } from './where-used'

/**
 * Materials in depth (B-W2b-238): the properties of a material's kind and its fibres as the label reads them (PRD-029,
 * PRD-033), its approval for use (PRD-035), where it is used (PRD-036), and the approvals of the materials a style's
 * revision names (the style's Compliance tab). The list's Approval and Used in columns and its "Not used in any BOM"
 * filter are W1's list route reading ./where-used.ts (usageCounts, usedFilter).
 */
export default defineRoutes('product.materials-depth', manifest, async (app) => {
  app.get('/product/materials/:materialId/depth', { schema: readDepthContract }, async (request) => ({ depth: await readDepth(request, request.params.materialId) }))
  app.get('/product/materials/:materialId/where-used', { schema: whereUsedContract }, async (request) => ({ whereUsed: await materialWhereUsed(request, request.params.materialId, request.query) }))
  app.put('/product/materials/:materialId/properties', { schema: setPropertiesContract }, async (request) => ({
    depth: await setProperties(request, request.params.materialId, request.body, idempotencyKeyFrom(request)),
  }))
  app.put('/product/materials/:materialId/approval', { schema: decideApprovalContract }, async (request) => ({
    depth: await decideApproval(request, request.params.materialId, request.body, idempotencyKeyFrom(request)),
  }))
  app.get('/product/styles/:styleId/revisions/:revisionId/material-approvals', { schema: materialApprovalsContract }, async (request) => ({
    approvals: await materialApprovals(request, request.params.styleId, request.params.revisionId),
  }))
})
