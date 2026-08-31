// PH.3 — graph context.
import type { GraphLoaders } from './loaders.js'

// Mercurius types every resolver's context as MercuriusContext. Declaring the
// loaders ON that interface makes the real context type carry them, so
// resolvers can be typed honestly instead of casting at each call site — a
// cast here would be load-bearing and silent the moment the shape changed.
declare module 'mercurius' {
  interface MercuriusContext {
    loaders: GraphLoaders
  }
}

export interface GraphContext {
  loaders: GraphLoaders
}

/** A ProductReadCache row as the root resolvers hand it to field resolvers. */
export interface ProductSource {
  id: string
  sku: string
  name: string
  brand: string | null
  status: string
  productType: string | null
  fulfillmentMethod: string | null
  asin: string | null
  imageUrl: string | null
  basePrice: unknown
  isParent: boolean
  parentId: string | null
  familyJson: unknown
  workflowStageJson: unknown
  cacheRefreshedAt: Date
}

/** Cap on a batched product query. Stated, not silent. */
export const MAX_PRODUCTS = 100
