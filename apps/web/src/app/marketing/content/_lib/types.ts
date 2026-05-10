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
  tags: string[]
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
