import { defineRoutes } from '../../../core/manifest'
import { compareVersions } from './compare'
import { compareVersionsContract, floorNewerSpecContract, listVersionsContract, styleDriftContract, workOrderSpecContract } from './contract'
import { floorNewerSpec, styleDrift, workOrderSpec } from './drift'
import { listVersions } from './list'
import { manifest } from './manifest'

/**
 * Spec versions (product module, B-W2b-220; features PRD-085 BOM versions and compare, PRD-166 spec versions, PRD-167
 * released data is locked, PRD-168 compare any two versions, PRD-194 the spec drift warning, PRD-195 the spec-changed
 * banner; follow-up VS1:01 the pattern pieces in the compare): a style's revisions with who, when, why and what is locked;
 * two revisions compared part by part as VersionCompare's sections (BOM, routing and minutes, measurement spec, protectors,
 * pattern pieces, the revision's label and output; the cost for the cost grain); open quotes and orders on another
 * revision than the one in force; a work order's spec against the one in force (the banner, the decision, the drift of its
 * order lines at release) and the tablet's banner. Reads only. The lock itself: ./lock.ts (assertRevisionOpen for a write
 * path, the database's refusal in words) and core/errors (a locked revision's database refusal is a 409, never a 500).
 */
export default defineRoutes('product.versions', manifest, async (app) => {
  app.get('/product/styles/:styleId/versions', { schema: listVersionsContract }, async (request) => ({ versions: await listVersions(request, request.params.styleId) }))

  app.get('/product/styles/:styleId/versions/compare', { schema: compareVersionsContract }, async (request) => ({
    compare: await compareVersions(request, request.params.styleId, request.query),
  }))

  app.get('/product/styles/:styleId/versions/drift', { schema: styleDriftContract }, async (request) => ({ drift: await styleDrift(request, request.params.styleId) }))

  app.get('/production/work-orders/:workOrderId/spec/versions', { schema: workOrderSpecContract }, async (request) => ({ spec: await workOrderSpec(request, request.params.workOrderId) }))

  app.get('/production/work-orders/:workOrderId/spec/newer', { schema: floorNewerSpecContract }, async (request) => ({ spec: await floorNewerSpec(request, request.params.workOrderId) }))
})
