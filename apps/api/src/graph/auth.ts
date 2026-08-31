// PH.3 — field-level authorisation decisions.
//
// A single /graphql route has ONE route identity, so route-keyed RBAC — which
// is what this platform uses everywhere else — can express exactly one
// permission for every possible query. It cannot tell "read a product name"
// from "read its cost price". That is the standard GraphQL authorisation
// problem, and the answer is that every field needs its own decision.
//
// This registry IS that decision, written down. `scripts/check-graph-contract.mjs`
// fails a push when a schema field has no entry — so a field cannot be added
// without someone stating how it is protected. Silence is the failure mode
// this exists to remove: an unlisted field would simply be served.
//
// Two decisions are available today:
//
//   'session'           Covered by the route permission on /graphql
//                       (products.view). Ordinary catalog/stock/channel data.
//
//   'financial-filter'  Additionally stripped by financialFilterHook, the
//                       preSerialization filter that guards every REST
//                       response. VERIFIED to fire on mercurius replies and to
//                       discriminate — not assumed. See graph.vitest.test.ts.
//
// A field needing something else (a distinct permission) must extend this
// union rather than being filed under 'session'.

export type FieldAuth = 'session' | 'financial-filter'

export const FIELD_AUTH: Record<string, FieldAuth> = {
  'Query.product': 'session',
  'Query.products': 'session',

  'Product.id': 'session',
  'Product.sku': 'session',
  'Product.name': 'session',
  'Product.brand': 'session',
  'Product.status': 'session',
  'Product.productType': 'session',
  'Product.fulfillmentMethod': 'session',
  'Product.asin': 'session',
  'Product.imageUrl': 'session',
  'Product.basePrice': 'session',
  // The only restricted field in the graph today. In RESTRICTED_FIELDS, so the
  // preSerialization filter strips it for callers without the permission.
  'Product.costPrice': 'financial-filter',
  'Product.isParent': 'session',
  'Product.parentId': 'session',
  'Product.family': 'session',
  'Product.workflowStage': 'session',
  'Product.cacheRefreshedAt': 'session',
  'Product.inventory': 'session',
  'Product.channels': 'session',

  'Family.id': 'session',
  'Family.code': 'session',
  'Family.label': 'session',

  'WorkflowStage.id': 'session',
  'WorkflowStage.code': 'session',
  'WorkflowStage.label': 'session',

  'Inventory.poolTotal': 'session',
  'Inventory.reservedTotal': 'session',
  'Inventory.availableTotal': 'session',
  'Inventory.locations': 'session',

  'StockAtLocation.locationId': 'session',
  'StockAtLocation.code': 'session',
  'StockAtLocation.type': 'session',
  'StockAtLocation.quantity': 'session',
  'StockAtLocation.reserved': 'session',
  'StockAtLocation.available': 'session',

  'ChannelListing.id': 'session',
  'ChannelListing.channel': 'session',
  'ChannelListing.marketplace': 'session',
  'ChannelListing.listingStatus': 'session',
  'ChannelListing.quantity': 'session',
  'ChannelListing.fulfillmentMethod': 'session',
  'ChannelListing.syncPaused': 'session',
}
