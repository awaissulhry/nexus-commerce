export interface TemplateRow {
  id: string
  badgeText: string
  valueSource: 'productName' | 'color' | 'size' | 'gender' | 'sku' | 'custom'
  customValue: string
  show: boolean
}

export interface TemplateConfig {
  labelSize: { widthMm: number; heightMm: number; preset: string }
  logoUrl: string
  showLogo: boolean
  showSizeBox: boolean
  showListingTitle: boolean
  showCondition: boolean
  condition: string
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
