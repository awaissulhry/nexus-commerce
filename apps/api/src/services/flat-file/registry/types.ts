// FF1.1 — Flat-file v2 shared field registry types.
// These types are the authoritative contract for the export engine.
// Generated from FF0-FIELD-CENSUS §2 (Product) and §3 (ChannelListing).

export type FieldClass = 'IDENTITY' | 'EDITABLE' | 'READONLY_SYNCED' | 'DERIVED' | 'SYSTEM'
export type FieldScope = 'SHARED' | 'MARKET_SCOPED'
export type FieldKind = 'text' | 'longtext' | 'number' | 'decimal' | 'date' | 'enum' | 'boolean' | 'array'

export interface FieldDefinition {
  id: string                     // canonical column id, e.g. 'base_price' (no @MKT suffix here)
  label: string
  kind: FieldKind
  cls: FieldClass
  scope: FieldScope
  channel?: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ALL'
  source: { model: 'Product' | 'ChannelListing'; column: string }  // where the value comes from
  forcedText?: boolean           // identifiers → numFmt '@'
  decimals?: number              // for kind 'decimal' (e.g. 2)
  enumOptions?: string[]
  enumMode?: 'open' | 'strict'
  maxLength?: number
  maxUtf8ByteLength?: number
  arrayDelimiter?: string        // for kind 'array' (default ' | ')
  followMaster?: {               // FFD10-A: governed per-market field
    followColumn: string         // e.g. 'followMasterPrice'
    overrideColumn: string       // e.g. 'priceOverride'
    masterCacheColumn: string    // e.g. 'masterPrice'
  }
  width?: number                 // presentation hint only (grid overlay lives elsewhere)
}

export interface SheetDefinition {
  name: 'Products' | 'Amazon' | 'eBay' | 'Shopify' | 'Images'
  channel?: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  sharedFields: FieldDefinition[]     // no @MKT suffix
  marketFields: FieldDefinition[]     // expanded to field@MKT per discovered market
}

export interface WorkbookModel {
  markets: Record<'AMAZON' | 'EBAY' | 'SHOPIFY', string[]>
  sheets: SheetDefinition[]
}
