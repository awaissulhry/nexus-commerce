// IM.3 — Shared types for the images workspace.

export interface ProductImage {
  id: string
  productId: string
  url: string
  alt: string | null
  type: string
  sortOrder: number
  publicId: string | null
  createdAt: string
}

export interface ListingImage {
  id: string
  productId: string
  variationId: string | null
  scope: 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
  platform: string | null
  marketplace: string | null
  amazonSlot: string | null
  variantGroupKey: string | null
  variantGroupValue: string | null
  url: string
  filename: string | null
  position: number
  role: string
  width: number | null
  height: number | null
  fileSize: number | null
  mimeType: string | null
  hasWhiteBackground: boolean | null
  sourceProductImageId: string | null
  publishStatus: string
  publishedAt: string | null
  publishError: string | null
  uploadedAt: string
}

export interface VariantSummary {
  id: string
  sku: string
  name: string
  variantAttributes: Record<string, string> | null
  amazonAsin: string | null
  ebayVariationId: string | null
  shopifyVariantId: string | null
}

export interface WorkspaceProduct {
  id: string
  sku: string
  name: string
  productType: string | null
  imageAxisPreference: string | null
  amazonAsin: string | null
  ebayItemId: string | null
  shopifyProductId: string | null
  isParent: boolean
}

export interface AmazonJobSummary {
  id: string
  marketplace: string
  feedId: string | null
  status: string
  skus: unknown
  errorMessage: string | null
  resultSummary: unknown
  submittedAt: string
  completedAt: string | null
}

export interface WorkspaceData {
  product: WorkspaceProduct
  master: ProductImage[]
  listing: ListingImage[]
  variants: VariantSummary[]
  availableAxes: string[]
  amazonJobs: AmazonJobSummary[]
}

export type ChannelTab = 'master' | 'amazon' | 'ebay' | 'shopify'

export interface PendingUpsert {
  _tempId: string            // client-only key for Map
  id?: string                // set = update existing ListingImage
  variationId?: string | null
  scope: 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
  platform?: string | null
  marketplace?: string | null
  amazonSlot?: string | null
  variantGroupKey?: string | null
  variantGroupValue?: string | null
  url: string
  filename?: string | null
  role?: string
  position?: number
  sourceProductImageId?: string | null
  width?: number | null
  height?: number | null
  fileSize?: number | null
  mimeType?: string | null
  hasWhiteBackground?: boolean | null
}
