import { defineManifest } from '../../../core/manifest'

/**
 * Customer price lists (B-W2a-19; SAL-165; design sales.pricelists and the record "Price list"): office only (no list
 * price on the floor or on a link). A list belongs to a company or to every company, so each handler checks the list
 * with can() and filters with scopeWhere() (`record`). Reading is pricelists.view, changing pricelists.manage (giving a
 * list to customers also needs parties.manage on each).
 */
export const manifest = defineManifest({
  'GET /sales/price-lists': { audiences: ['office'], permission: 'pricelists.view', scope: 'record' },
  'GET /sales/price-lists/:listId': { audiences: ['office'], permission: 'pricelists.view', scope: 'record' },
  'POST /sales/price-lists': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'PATCH /sales/price-lists/:listId': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'POST /sales/price-lists/:listId/archive': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'POST /sales/price-lists/:listId/reactivate': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'POST /sales/price-lists/:listId/customers': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'POST /sales/price-lists/:listId/customers/remove': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'POST /sales/price-lists/:listId/versions': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'GET /sales/price-lists/:listId/versions/:versionId': { audiences: ['office'], permission: 'pricelists.view', scope: 'record' },
  'PATCH /sales/price-lists/:listId/versions/:versionId': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'DELETE /sales/price-lists/:listId/versions/:versionId': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'PUT /sales/price-lists/:listId/versions/:versionId/entries': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'POST /sales/price-lists/:listId/versions/:versionId/activate': { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' },
  'GET /sales/price-lists/:listId/versions/:versionId/compare': { audiences: ['office'], permission: 'pricelists.view', scope: 'record' },
})
