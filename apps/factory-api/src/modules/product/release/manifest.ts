import { defineManifest } from '../../../core/manifest'

/**
 * The release gate's routes (B-W2b-231; PRD-190, PRD-191, PRD-197, PRD-232; design products.styles `styles.release`, the
 * styles list's completeness column and the side panel). Office only. No new permission: the gate of a revision is a part of
 * its BOM (product.bom.view), what a revision is released for is the release's own decision (product.bom.release: the person
 * who releases plans the scope and releases more of it later), the list's summary and the readers' scope are the style's
 * (product.styles.view). A style belongs to one company or to every company of the tenant, so each handler checks the style's
 * company with can() (`record`). The release itself stays W1's route (POST …/release), which asks the same gate.
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const release = { audiences: ['office'], permission: 'product.bom.release', scope: 'record' } as const
const styles = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/release-gate': view,
  'PUT /product/styles/:styleId/revisions/:revisionId/release-scope': release,
  'GET /product/styles/:styleId/release-scope': styles,
  // The styles list (up to 25 rows at a time): the completeness column and the side panel's compact check.
  'GET /product/release-gate': styles,
})
