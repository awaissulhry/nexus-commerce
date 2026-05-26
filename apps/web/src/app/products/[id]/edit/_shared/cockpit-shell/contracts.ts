// UC.2.1 — Shared cockpit contracts.
//
// The common core both channel cockpits already model independently
// (amazon-cockpit/types.ts ComposedAmazonListing, ebay-cockpit/types.ts
// ComposedListing). Extracting it here lets shared cards (UC.2.2/2.3) and
// the resolution engine (FL.*) read one shape. The two channel types
// structurally satisfy ComposedListingBase today; UC.3/UC.4 make the
// `extends` explicit, and FL.2 collapses the duplicated FieldSource.

import type { ReactNode } from 'react'

export type FieldSource =
  | 'manual' // operator typed it on the listing
  | 'master' // inherited from the product master
  | 'translations' // pulled from LocalesTab for this marketplace
  | 'ai' // AI-suggested (list-wizard / cockpit assistant)
  | 'sibling' // copied from another marketplace's listing
  | 'default' // fallback / nothing set yet
// FL.2 extends this with 'linked' (shares a FieldLinkGroup) and 'locked'
// (identity field pinned to master). Kept out until the engine lands so
// the channel types stay in lockstep with this until then.

export interface ComposedField<T> {
  value: T
  source: FieldSource
}

export interface MarketplaceRef {
  code: string
  name: string
  currency: string
  language: string
  domainUrl: string | null
}

export interface ListingStatusRef {
  isPublished: boolean
  listingStatus: string
  externalListingId: string | null
  publicUrl: string | null
}

export interface VariationSummary {
  axes: string[] // e.g. ["Color", "Size"]
  variantCount: number
  publishedVariantCount: number
}

/** The fields both channels' composed listings share. ComposedAmazonListing
 *  and the eBay ComposedListing are both assignable to this. */
export interface ComposedListingBase {
  title: ComposedField<string>
  description: ComposedField<string>
  price: ComposedField<number | null>
  currency: string
  quantity: ComposedField<number | null>
  primaryImageUrl: ComposedField<string | null>
  galleryUrls: ComposedField<string[]>
  brand: ComposedField<string | null>
  sku: string
  marketplace: MarketplaceRef
  status: ListingStatusRef
  variationSummary: VariationSummary
}

/** Per-channel capability matrix. Drives whether a capability-gated card
 *  renders, and feeds the UC.10 parity doc / admin parity view. */
export interface CockpitCapabilities {
  marketChips: boolean
  publish: boolean
  buyBox: boolean // Amazon
  suppression: boolean // Amazon
  browseNode: boolean // Amazon
  aplusContent: boolean // Amazon
  itemSpecifics: boolean // eBay aspects
  compatibility: boolean // eBay Motors
  versionHistory: boolean // eBay
  applyToSiblings: boolean // eBay
}

export const NO_CAPABILITIES: CockpitCapabilities = {
  marketChips: false,
  publish: false,
  buyBox: false,
  suppression: false,
  browseNode: false,
  aplusContent: false,
  itemSpecifics: false,
  compatibility: false,
  versionHistory: false,
  applyToSiblings: false,
}

/** Descriptor for a cockpit card. A channel composes an ordered array of
 *  these; CockpitCardGrid renders `node` in order. `id` doubles as the
 *  data-jump-target value so the health panel can scroll to it. A card
 *  with a `capability` set is omitted when the channel lacks it. */
export interface CockpitCard {
  id: string
  capability?: keyof CockpitCapabilities
  node: ReactNode
}
