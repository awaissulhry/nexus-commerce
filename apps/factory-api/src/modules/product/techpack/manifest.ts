import { defineManifest } from '../../../core/manifest'

/**
 * The tech pack's routes (B-W2b-230; PRD-130, PRD-131, PRD-133, PRD-134, PRD-136, PRD-138, PRD-147; design products.styles
 * `style.techpack`). Office only. The live tech pack and its stored versions are parts of the revision's BOM (product.bom.view;
 * the construction section also asks product.routing.view, the protection and compliance sections compliance.certificates.view,
 * in the handler); making a PDF is product.techpacks.make (a document made to go outside); a scanned QR is the style's
 * (product.styles.view). A style belongs to one company or to every company of the tenant, so each handler checks the style's
 * company with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/tech-pack': view,
  'POST /product/styles/:styleId/revisions/:revisionId/tech-pack/pdf': { audiences: ['office'], permission: 'product.techpacks.make', scope: 'record' },
  'GET /product/styles/:styleId/revisions/:revisionId/tech-pack/versions': view,
  'GET /product/styles/:styleId/revisions/:revisionId/tech-pack/versions/:documentId/pdf': view,
  'GET /product/tech-packs/scan/:code': { audiences: ['office'], permission: 'product.styles.view', scope: 'record' },
})
