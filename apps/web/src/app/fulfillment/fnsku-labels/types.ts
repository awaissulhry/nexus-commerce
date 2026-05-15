export interface TemplateRow {
  id: string
  badgeText: string
  valueSource: 'productName' | 'color' | 'size' | 'gender' | 'sku' | 'custom'
  customValue: string
  show: boolean
  fontScale: number                                        // 0.5–2.0, default 1.0
  textTransform: 'uppercase' | 'none' | 'capitalize'      // default 'uppercase'
  boldValue: boolean                                       // default true
}

export interface TemplateConfig {
  // Label dimensions
  labelSize: { widthMm: number; heightMm: number; preset: string }

  // Layout
  columnSplitPct: number       // right column width % (15–55, default 38)
  paddingMm: number            // internal padding mm (0–5, default 2)
  showColumnDivider: boolean   // default true

  // Logo
  logoUrl: string
  showLogo: boolean

  // Size box (top-right)
  showSizeBox: boolean
  sizeBoxLabel: string         // default 'SIZE' — can be 'TAGLIA', 'GR.', etc.

  // Barcode
  barcodeHeightPct: number     // barcode height % of label height (10–55, default 32)

  // Listing info (below barcode)
  showListingTitle: boolean
  listingTitleLines: number    // 1–4, default 2
  showCondition: boolean
  condition: string

  // Typography
  fontFamily: string           // 'Arial' | 'Helvetica Neue' | 'monospace' | 'Georgia'
  badgeFontScale: number       // 0.5–2.0, default 1.0
  valueFontScale: number       // 0.5–2.0, default 1.0

  // Field rows
  rows: TemplateRow[]
}

export interface LabelItem {
  sku: string
  fnsku: string
  quantity: number
  productName: string | null
  listingTitle: string | null
  variationAttributes: Record<string, string>
  imageUrl: string | null
  fnskuLoading?: boolean
  fnskuError?: string
}

export interface SavedTemplate {
  id: string
  name: string
  isDefault: boolean
  config: TemplateConfig
}
