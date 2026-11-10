import { defineManifest } from '../../../core/manifest'

/**
 * The colour library (B-W2b-247; PRD-041; design products.colours, SCR-118). Office only. Read with product.styles.view (a
 * colourway picks its colour from the library), kept with product.colours.manage. A colour belongs to one company or to
 * every company of the tenant, so each handler checks the colour's company with can() (`record`). A colour's photo is a
 * file of the colour sent through the files platform (files.upload); its bytes are served here.
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.colours.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/colours/library': view,
  'GET /product/colours/counts': view,
  'POST /product/colours': manage,
  'PATCH /product/colours/:colourId': manage,
  'POST /product/colours/:colourId/archive': manage,
  'POST /product/colours/:colourId/restore': manage,
  // A colour's photo or a branding set's logo or artwork picture (pictures.ts): only one the caller may see.
  'GET /product/colours/pictures/:fileId': view,
})
