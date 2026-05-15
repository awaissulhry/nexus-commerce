export interface TemplateRow {
  id: string
  badgeText: string
  valueSource: 'productName' | 'color' | 'size' | 'gender' | 'sku' | 'asin' | 'custom'
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
  barcodeWidthPct: number      // barcode width % of right-col inner width (20–100, default 100)

  // Listing info (below barcode)
  showListingTitle: boolean
  listingTitleLines: number    // 1–4, default 2
  showCondition: boolean
  condition: string

  // Typography
  fontFamily: string           // 'Helvetica' | 'Courier' | 'Times-Roman'
  badgeFontScale: number       // 0.5–2.0, default 1.0
  valueFontScale: number       // 0.5–2.0, default 1.0

  // Label border
  labelRadiusMm?: number       // outer label corner radius in mm (0–12, default 5)

  // Fine-grained right-column scale factors (0.5–2.0, default 1.0)
  sizeValueScale?: number      // SIZE number font scale
  sizeHeaderScale?: number     // SIZE header strip font scale
  fnskuTextScale?: number      // FNSKU alphanumeric text scale
  listingTitleScale?: number   // Listing title font scale
  conditionScale?: number      // Condition text scale

  // Title truncation
  titleTruncationMode?: 'lines' | 'smart'  // default 'lines'
  titleFirstWords?: number     // smart mode: first N words (default 5)
  titleLastWords?: number      // smart mode: last N words (default 4)

  // Left-column fine-grained
  logoHeightPct?: number       // Logo area height as % of label height (10–40, default 22)

  // Sheet layout (A4 mode)
  sheetCols?: number        // override auto-calculated columns (blank = auto)
  sheetMarginMm?: number    // sheet edge margin mm (default 5)
  sheetGapMm?: number       // gap between labels mm (default 2)

  // Field rows
  rows: TemplateRow[]
}

export interface LabelItem {
  sku: string
  fnsku: string
  asin?: string | null
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
