import { defineManifest } from '../../../core/manifest'

/**
 * A style's pictures, the styles' gallery and the pattern files (B-W2b-236; PRD-016, PRD-218; design products.styles
 * sec:styles.gallery, rec:Style › Overview › Sketches and pictures, › Files & patterns › pattern files). Office only.
 * Pictures are the style's (product.styles.view | manage, as its details); pattern files are a part of a revision, as its
 * BOM, pattern pieces and measurement spec (product.bom.view | manage). A style belongs to one company or to every company
 * of the tenant, so each handler checks the style's company with can() (`record`). No files right is asked of the person
 * here: the files are named by the module and shown through the tenant's system holding files.read over the style's company
 * (the upload itself is the files platform's, files.upload).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const
const specView = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const specManage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/pictures': view,
  'POST /product/styles/:styleId/pictures': manage,
  'PATCH /product/styles/:styleId/pictures/:pictureId': manage,
  'POST /product/styles/:styleId/pictures/:pictureId/main': manage,
  'PUT /product/styles/:styleId/pictures/order': manage,
  'DELETE /product/styles/:styleId/pictures/:pictureId': manage,
  // The styles list's Gallery view: the main picture of each style on screen.
  'POST /product/pictures/looks': view,
  // A picture's bytes (bytes.ts): only a style's picture the caller may see.
  'GET /product/pictures/:fileId': view,
  'GET /product/styles/:styleId/revisions/:revisionId/pattern-files': specView,
  'POST /product/styles/:styleId/revisions/:revisionId/pattern-files': specManage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/pattern-files/:patternFileId': specManage,
  'PUT /product/styles/:styleId/revisions/:revisionId/pattern-files/:patternFileId/file': specManage,
  // The list's selection (Owner rule 2026-10-29): several pattern files removed at once.
  'POST /product/styles/:styleId/revisions/:revisionId/pattern-files/remove': specManage,
  'GET /product/styles/:styleId/revisions/:revisionId/pattern-files/:patternFileId/download': specView,
})
