// EC.1 — Listing Cockpit shared types.
//
// Provenance here is a thin stub. EC.2 (Field Source System) replaces
// `source: string` with the full state machine including manual lock,
// per-field history, AI confidence, and a diff-then-apply switcher.

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

export interface ComposedListing {
  title: ComposedField<string>
  description: ComposedField<string>
  htmlDescription: ComposedField<string | null>
  price: ComposedField<number | null>
  currency: string
  quantity: ComposedField<number | null>
  primaryImageUrl: ComposedField<string | null>
  galleryUrls: ComposedField<string[]>
  conditionLabel: ComposedField<string>
  categoryId: ComposedField<string | null>
  categoryLabel: ComposedField<string | null>
  brand: ComposedField<string | null>
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
    externalListingId: string | null
    publicUrl: string | null
  }
  variationSummary: {
    axes: string[]            // e.g. ["Color", "Size"]
    variantCount: number      // total child variants
    publishedVariantCount: number
  }
  // EC.9 will compute a real score; EC.1 just exposes counters the
  // preview band can render as placeholders.
  healthHints: {
    masterIsNewer: boolean
    titleLength: number
    descriptionLength: number
  }
}

export type CockpitMode = 'cockpit' | 'classic'
