import { defineManifest } from '../../../core/manifest'

/**
 * The style library's routes (A2 SCR-040 "Styles", SCR-041 "Style › Overview & variants", SCR-049 "Libraries", size
 * scales tab). Office only: the floor reads the styles it makes through its work orders (later steps), never this
 * library. A style or a scale belongs to one company or to every company of the tenant, so each handler checks it with
 * can() and filters the lists with scopeWhere() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles': view,
  'GET /product/styles/:styleId': view,
  'POST /product/styles': manage,
  'PATCH /product/styles/:styleId': manage,
  'POST /product/styles/:styleId/archive': manage,
  'POST /product/styles/:styleId/reactivate': manage,
  'POST /product/styles/:styleId/colourways': manage,
  'PATCH /product/styles/:styleId/colourways/:colourwayId': manage,
  'POST /product/styles/:styleId/skus/generate': manage,
  'PATCH /product/styles/:styleId/skus/:skuId': manage,
  'GET /product/styles/:styleId/revisions': view,
  'POST /product/styles/:styleId/revisions': manage,
  'GET /product/size-scales': view,
  'GET /product/size-scales/:scaleId': view,
  'POST /product/size-scales': manage,
  'PATCH /product/size-scales/:scaleId': manage,
  'POST /product/size-scales/:scaleId/sizes': manage,
  'PUT /product/size-scales/:scaleId/order': manage,
  'PATCH /product/size-scales/:scaleId/sizes/:sizeId': manage,
  'POST /product/size-scales/:scaleId/archive': manage,
  'POST /product/size-scales/:scaleId/reactivate': manage,
})
