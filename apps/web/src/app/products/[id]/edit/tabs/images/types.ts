// IM.3 — Shared types for the images workspace.

export interface ProductImage {
  id: string
  productId: string
  url: string
  alt: string | null
  type: string
  sortOrder: number
  publicId: string | null
  // IR.2 — asset metadata, NULL on legacy rows pre-backfill.
  width: number | null
  height: number | null
  mimeType: string | null
  fileSize: number | null
  // IE.1 — upload-dedup hashes, NULL on rows from before IE.1 ships
  // or until the IE.2 backfill hydrates them.
  contentHash: string | null
  perceptualHash: string | null
  // IR.4 — Self-FK to the source ProductImage when this row was created
  // by the in-app editor (crop / rotate / flip). NULL for originals.
  derivedFromImageId: string | null
  // IR.6 — Gemini Vision analysis results. All NULL until /analyze runs.
  aiAnalyzedAt: string | null
  aiHasWhiteBackground: boolean | null
  aiFrameFillPct: number | null
  aiHasTextOverlay: boolean | null
  aiOffCenterScore: number | null
  aiNotes: { rationale?: string; error?: string; model?: string } | null
  // PG.4 — operator-curated hero flag. When true, this row wins the
  // /products catalog thumbnail picker over type=MAIN + sortOrder.
  // At most one row per product is allowed (DB partial unique index).
  isPrimary: boolean
  // MM.1 — media type + video fields (IMAGE on all legacy rows).
  mediaType: string
  posterUrl: string | null
  durationSec: number | null
  sourceAssetId: string | null
  createdAt: string
  // PB.3d — surfaced for the eBay/Shopify stale-detection banner.
  // The workspace endpoint already returns it; previously not typed.
  updatedAt: string
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
  // IE.6 — per-row alt-text override; NULL inherits from master.
  altOverride: string | null
  // BE.1 — bulk-edit lock; locked images are skipped by bulk Delete/Clear.
  locked: boolean
  // MM.1 — media type + video fields (IMAGE on all legacy rows).
  mediaType: string
  posterUrl: string | null
  durationSec: number | null
  sourceAssetId: string | null
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
  // IE.7 — surfaced so MasterPanel can pre-scope the DAM picker to
  // "same brand" / "same product type" assets.
  brand: string | null
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

export interface ChannelLiveImage {
  id: string
  productId: string
  channel: string         // 'AMAZON' | 'EBAY' | 'SHOPIFY'
  marketplace: string | null
  externalSku: string | null
  asin: string | null
  slot: string | null     // 'MAIN' | 'PT01'..'PT08' | 'SWCH' (Amazon) or position-as-string
  url: string
  width: number | null
  height: number | null
  sortOrder: number
  etag: string | null
  fetchedAt: string
}

export interface WorkspaceData {
  product: WorkspaceProduct
  master: ProductImage[]
  listing: ListingImage[]
  variants: VariantSummary[]
  availableAxes: string[]
  // EFX P5 — distinct value count per axis (keyed by the display name in
  // availableAxes). Lets pickers annotate single-valued axes, which publish
  // as a shared gallery on eBay. Optional: older API responses omit it.
  axisValueCounts?: Record<string, number>
  // EAC Layer A (additive) — theme-authoritative axes (declared-order,
  // synonym+fingerprint-deduped, ghosts removed) + operator-facing warnings.
  // Optional: older API responses omit them, and the drawer falls back to
  // availableAxes / observed variant values.
  resolvedAxes?: Array<{ name: string; key: string; values: string[] }>
  resolvedAxisWarnings?: string[]
  resolvedAxisSuppressed?: string[]
  amazonJobs: AmazonJobSummary[]
  // IR.7.2 — Map productImage.id → DigitalAsset.id for rows mirrored in
  // the DAM library. Empty when no master image has been pushed yet.
  damLinks: Record<string, string>
  // MM.8 — productImage.ids whose linked DAM asset URL drifted from the product.
  damDrift?: string[]
  // IE.4 — read-replica of what each channel is currently serving.
  // Empty until the operator triggers a refresh; populated again by
  // IE.4b's cron once that lands.
  channelLiveImages: ChannelLiveImage[]
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
  // IE.6 — per-row alt-text override (NULL inherits from master).
  altOverride?: string | null
}
