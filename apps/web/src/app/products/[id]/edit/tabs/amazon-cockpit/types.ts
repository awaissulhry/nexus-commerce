// AC.1 — Amazon Listing Cockpit shared types.
//
// Mirrors ebay-cockpit/types.ts but the ComposedListing here folds in
// Amazon-specific fields that the eBay cockpit doesn't carry:
//
//   - bullets (Amazon's 5-bullet block, separate from description)
//   - asin / productType / browseNodeId (catalogue identifiers)
//   - variationTheme (e.g. SizeColor — the parent/child join)
//   - gtin (UPC/EAN, often suppression-blocking when missing)
//   - fulfillmentChannel (FBA / FBM)
//   - aplusSummary (count + approval state — fills in AC.8)
//
// FieldSource matches eBay's shape so a future Field Source System
// (sibling to EC.2) can be lifted into a shared module without
// re-typing either side.

export type FieldSource =
  | 'manual'        // operator typed it on the listing
  | 'master'        // inherited from the product master
  | 'translations'  // pulled from LocalesTab for this marketplace
  | 'ai'            // AI-suggested (list-wizard / cockpit assistant)
  | 'sibling'       // copied from another marketplace's listing
  | 'default'       // fallback / nothing set yet

export interface ComposedField<T> {
  value: T
  source: FieldSource
}

export interface ComposedAmazonListing {
  title: ComposedField<string>
  description: ComposedField<string>
  bullets: ComposedField<string[]>
  price: ComposedField<number | null>
  currency: string
  quantity: ComposedField<number | null>
  primaryImageUrl: ComposedField<string | null>
  galleryUrls: ComposedField<string[]>
  // Amazon catalogue identifiers.
  asin: ComposedField<string | null>
  gtin: ComposedField<string | null>
  productType: ComposedField<string | null>      // e.g. "OUTERWEAR"
  browseNodeId: ComposedField<string | null>     // resolved by AC.7
  variationTheme: ComposedField<string | null>   // e.g. "SizeColor"
  brand: ComposedField<string | null>
  fulfillmentChannel: ComposedField<'FBA' | 'FBM' | null>
  conditionType: ComposedField<string>           // "new_new" etc.
  sku: string
  marketplace: {
    code: string
    name: string
    currency: string
    language: string
    domainUrl: string | null
  }
  status: {
    isPublished: boolean
    listingStatus: string
    externalListingId: string | null    // ASIN, when assigned
    publicUrl: string | null
  }
  variationSummary: {
    axes: string[]            // e.g. ["Color", "Size"]
    variantCount: number
    publishedVariantCount: number
  }
  // AC.8 fills this in; AC.1 emits zero/null placeholders.
  aplusSummary: {
    moduleCount: number
    brandStoryAttached: boolean
    approvalStatus: 'NONE' | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
  }
  // AC.4 computes a real score; AC.1 just exposes counters.
  healthHints: {
    masterIsNewer: boolean
    titleLength: number
    descriptionLength: number
    bulletCount: number
    imageCount: number
    hasGtin: boolean
    hasBrand: boolean
    hasProductType: boolean
  }
}

export type CockpitMode = 'cockpit' | 'classic'
