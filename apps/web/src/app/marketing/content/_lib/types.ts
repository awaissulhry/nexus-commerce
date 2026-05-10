// MC.1.1 / MC.1.2 — DAM hub shared types. Mirrors the
// GET /api/assets/overview and /api/assets/library responses so
// server fetches and client renders agree on shape without exporting
// Prisma types into the web bundle.

export interface OverviewPayload {
  totalAssets: number
  productImageCount: number
  videoCount: number
  byType: Record<string, number>
  storageBytes: number
  /// MC.13.1 — workspace storage quota. null fields mean "no cap set"
  /// for that tier; surface only the warning band when softCap or
  /// 100%-block when hardCap is hit.
  storageQuota?: {
    hardCapBytes: number | null
    softCapBytes: number | null
    usagePercent: number | null
    atSoftCap: boolean
    atHardCap: boolean
  }
  inUseCount: number
  orphanedCount: number
  needsAttention: {
    missingAltImages: number
  }
}

export type AssetSource = 'digital_asset' | 'product_image'

export interface LibraryItem {
  id: string
  source: AssetSource
  url: string
  label: string
  type: string
  mimeType: string | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  createdAt: string
  usageCount: number
  productId: string | null
  productSku: string | null
  productName: string | null
  role: string | null
  /// MC.3.4 — true when the asset has any quality warnings persisted.
  /// Lets the card render a badge without fetching the full detail.
  hasQualityWarnings?: boolean
}

export interface LibraryResponse {
  items: LibraryItem[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
}

// MC.1.5 — full asset detail for the drawer.

export interface AssetUsage {
  id: string
  scope: string
  role: string
  sortOrder: number
  productId: string | null
  productSku: string | null
  productName: string | null
}

export interface AssetTagRef {
  id: string
  name: string
  color: string | null
}

export interface QualityWarning {
  code: string
  channel: string | null
  message: string
}

export interface ChannelVariant {
  id: string
  channel: string
  label: string
  width: number
  height: number
  cropMode: 'fit' | 'fill' | 'pad'
  url: string | null
  notes: string | null
}

export interface AssetDetail {
  id: string
  source: AssetSource
  url: string
  label: string
  code: string | null
  type: string
  mimeType: string | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  alt: string | null
  caption: string | null
  /// Operator-set tags via the AssetTag join table (MC.2.1).
  /// Persistent + filterable from the sidebar.
  assetTags: AssetTagRef[]
  /// Free-text tags from DigitalAsset.metadata.tags. Typically AI-
  /// suggested; promoted to assetTags via the picker.
  tags: string[]
  /// MC.3.4 — quality warnings persisted at upload time.
  qualityWarnings: QualityWarning[]
  /// MC.6.1 — per-channel variant URLs (Amazon hero/standard/thumb,
  /// eBay zoom/standard/thumb, Shopify product/grid/cart, Instagram
  /// feed/story/portrait, OG card). Built from the Cloudinary master
  /// via on-demand transformations.
  channelVariants: ChannelVariant[]
  originalFilename: string | null
  storageProvider: string
  storageId: string | null
  createdAt: string
  updatedAt: string
  usages: AssetUsage[]
}

export interface AssetDetailResponse {
  detail: AssetDetail
}
