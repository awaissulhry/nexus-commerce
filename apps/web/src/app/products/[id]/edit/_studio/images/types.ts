/**
 * PES.7 — the images tab's OWN wire types.
 *
 * Written from the API's responses (`routes/images/images-workspace.routes.ts`,
 * `product-images-crud.routes.ts`), not from the old tab's `tabs/images/types.ts`: the programme
 * builds from scratch (layout doc §2.10), so the old tree is read as specification and never
 * imported. Same fields on the wire, because the wire is the server's — a different shape here
 * would be a second definition of the same fact.
 *
 * Only what this tab RENDERS is declared. A field the server sends and no surface shows is not
 * typed, so the type stays a statement about the UI rather than a copy of the schema — with four
 * deliberate exceptions marked ⚠ below, which the old tab fetched and silently dropped.
 */

/* ── media ───────────────────────────────────────────────────────────────────────────────── */

export type MediaKind = 'IMAGE' | 'VIDEO'

/**
 * How Nexus classifies a master asset. Drives default channel placement.
 *
 * These five are exactly what the API accepts (`VALID_TYPES` in
 * `product-images-crud.routes.ts`) — a sixth value here would let the type picker offer something
 * the server answers with `INVALID_TYPE`. The open-ended arm covers legacy rows stored before the
 * set was fixed, which must still RENDER even though they cannot be re-selected.
 */
export const MASTER_IMAGE_TYPES = ['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'] as const
export type MasterImageType = (typeof MASTER_IMAGE_TYPES)[number] | (string & {})

/** A row of the master gallery — the product's own stored truth, before any channel layer. */
export interface MasterAsset {
  id: string
  productId: string
  url: string
  alt: string | null
  type: MasterImageType
  sortOrder: number
  /** Cloudinary public id when the asset came through the upload pipeline. */
  publicId: string | null

  /** Intrinsic asset metadata. NULL on rows predating the backfill — render as unknown, never 0. */
  width: number | null
  height: number | null
  mimeType: string | null
  fileSize: number | null

  /** Upload-dedup hashes. NULL until the backfill hydrates them. */
  contentHash: string | null
  perceptualHash: string | null

  /** Set when this row was produced by the in-app editor (crop/rotate/flip) from another row. */
  derivedFromImageId: string | null

  /** Operator-curated hero. At most one per product (DB partial unique index). */
  isPrimary: boolean

  /** Vision analysis. Every field NULL until analysis has run — absence is not a failing score. */
  aiAnalyzedAt: string | null
  aiHasWhiteBackground: boolean | null
  aiFrameFillPct: number | null
  aiHasTextOverlay: boolean | null
  aiOffCenterScore: number | null
  aiNotes: { rationale?: string; error?: string; model?: string } | null

  /** IMAGE on every legacy row; VIDEO rows carry the three fields below. */
  mediaType: MediaKind
  posterUrl: string | null
  durationSec: number | null
  sourceAssetId: string | null

  createdAt: string
  updatedAt: string
}

/* ── the channel layer ───────────────────────────────────────────────────────────────────── */

export type ListingScope = 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
export type PublishState = 'DRAFT' | 'PUBLISHED' | 'OUTDATED' | 'ERROR' | (string & {})

/**
 * 🔴 The ONE place a publish state is compared to `'PUBLISHED'`.
 *
 * `PublishState` is deliberately an OPEN union — `| (string & {})` — so a status the server adds
 * tomorrow survives the parse instead of being coerced into a state it is not (the degrade-don't-
 * drop rule). The cost is that TypeScript checks nothing about the literal: `=== 'PUBLISHD'`
 * compiles just as happily as `=== 'PUBLISHED'`, and the three call sites this replaces were each
 * one typo away from silently deciding no row was ever live.
 *
 * Closing the union would buy the check and lose the degrade, so the comparison is centralised
 * instead: one spelling, in one place, wrong in every site or right in every site.
 */
export function isPublished(state: PublishState | string | null | undefined): boolean {
  return state === 'PUBLISHED'
}

/** A sparse override: one picture placed at one coordinate of one channel. */
export interface ListingAsset {
  id: string
  productId: string
  /** The child Product this row belongs to; null = the family-level row. */
  variationId: string | null
  scope: ListingScope
  platform: string | null
  marketplace: string | null
  /** Amazon slot code (MAIN · PT01… · PS01… · SWCH); null off Amazon. */
  amazonSlot: string | null
  /** The axis this row is bucketed under (e.g. Colore=Giallo); null = the shared bucket. */
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
  /** The master row this was placed from, when it was placed from one. */
  sourceProductImageId: string | null
  publishStatus: PublishState
  publishedAt: string | null
  publishError: string | null
  uploadedAt: string
  /** Per-row alt override; NULL inherits the master's. */
  altOverride: string | null
  /** Locked rows are skipped by bulk clear/delete. */
  locked: boolean
  mediaType: MediaKind
  posterUrl: string | null
  durationSec: number | null
  sourceAssetId: string | null
}

/* ── supporting shapes ───────────────────────────────────────────────────────────────────── */

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
  brand: string | null
  productType: string | null
  imageAxisPreference: string | null
  amazonAsin: string | null
  ebayItemId: string | null
  shopifyProductId: string | null
  isParent: boolean
}

/**
 * ⚠ The server DISCOVERS the writable image slots for this (marketplace, productType) from
 * Amazon's cached product-type schema — uncapping past PT08 where the type allows it and
 * surfacing the Product-Safety (GPSR) locators that matter for EU PPE. The previous tab fetched
 * this and rendered a hardcoded list instead (inventory §4 finding B). This tab renders THIS.
 */
export interface AmazonSlotDef {
  slot: string
  attribute: string
  kind: 'MAIN' | 'OTHER' | 'SWATCH' | 'SAFETY' | 'NAMED'
  order: number
  /** False when the schema marks the locator Seller-Central-only. */
  writable: boolean
}

/** ⚠ The theme-authoritative axis catalog: declared order, synonym-deduped, ghost axes removed. */
export interface ResolvedAxis {
  name: string
  key: string
  values: string[]
}

/** What a channel is serving right now, read back from its own API. */
export interface ChannelLiveAsset {
  id: string
  productId: string
  channel: string
  marketplace: string | null
  externalSku: string | null
  asin: string | null
  slot: string | null
  url: string
  width: number | null
  height: number | null
  sortOrder: number
  etag: string | null
  fetchedAt: string
}

/** `GET /api/products/:id/images-workspace` — one payload, everything the tab renders. */
export interface ImageWorkspace {
  product: WorkspaceProduct
  master: MasterAsset[]
  listing: ListingAsset[]
  variants: VariantSummary[]

  /** The raw observed axis names. Prefer `resolvedAxes` where present. */
  availableAxes: string[]
  /** ⚠ distinct value count per axis — a single-valued axis publishes as one shared gallery. */
  axisValueCounts?: Record<string, number>
  /** ⚠ authoritative axes; falls back to `availableAxes` when the server omits it. */
  resolvedAxes?: ResolvedAxis[]
  /** Operator-facing warnings from axis resolution. Warn, never block. */
  resolvedAxisWarnings?: string[]
  /** ⚠ axes the resolver removed as ghosts, named so their absence is explained. */
  resolvedAxisSuppressed?: string[]

  /** ⚠ the real slot set. Absent on older API responses. */
  amazonSlotTaxonomy?: AmazonSlotDef[]
  /**
   * 🔴 WHICH set those slots are — Amazon's schema, or the legacy fallback.
   *
   * The array cannot say on its own: a fallback is also a non-empty list, so inferring
   * "slots exist, therefore the schema answered" presents the legacy ten as authoritative. Absent
   * on older API responses, which is itself a third state — unknown.
   */
  amazonSlotTaxonomySource?: 'schema' | 'fallback'

  /** productImage.id → DigitalAsset.id for rows mirrored into the DAM library. */
  damLinks: Record<string, string>
  /** productImage.ids whose linked DAM asset URL has drifted from the product's. */
  damDrift?: string[]

  channelLiveImages: ChannelLiveAsset[]
  amazonJobs: Array<{
    id: string
    marketplace: string
    feedId: string | null
    status: string
    errorMessage: string | null
    submittedAt: string
    completedAt: string | null
  }>
}

/* ── what the write routes actually answer ───────────────────────────────────────────────── */

/**
 * 🔴 These shapes are transcribed from the routes, not assumed — and they are NOT uniform.
 *
 * `POST /images/import-from-dam` NESTS the row under `image` and adds `reused`; `POST /images`
 * returns the row at the TOP level. Assuming the uniform shape cost a real bug: the DAM import
 * succeeded on the server while the UI silently ignored it, because the code read `data.id` on a
 * payload whose id lives at `data.image.id`. The write landed and the screen said nothing.
 */
export interface ImportFromDamResponse {
  ok: boolean
  image: MasterAsset
  /** True when the product already had this asset — the route is idempotent per (product, publicId). */
  reused: boolean
}

/** `POST /images` — the row itself. `reused: 'exact'` on a byte-identical re-upload (200, not 201). */
export type UploadImageResponse = MasterAsset & { reused?: 'exact' }

/** `POST /videos` — same convention as the image upload. */
export type UploadVideoResponse = MasterAsset & { reused?: 'exact' }

/**
 * `POST /images/:imageId/push-to-dam` — the FOURTH distinct shape in that route file, and the one
 * most likely to be misread: `asset` here is the **DigitalAsset**, not the `MasterAsset` that was
 * pushed. Reading it as the image would put a library id where a picture id belongs.
 *
 * 🔴 `created` is the whole honesty of this surface. The route is idempotent on the Cloudinary
 * `publicId`, so pushing a picture the library already holds answers 200 with `created: false` and
 * makes nothing. A surface that says "Added" either way tells the operator it did work it did not do.
 */
export interface PushToDamResponse {
  ok: boolean
  /** The DigitalAsset — reused when `created` is false. */
  asset: { id: string; label?: string | null }
  /** The AssetUsage scoping it to this product. */
  usage: { id: string }
  /** False when the library already had this picture and the route reused the existing rows. */
  created: boolean
}

/** The aspect ratios Imagen accepts — the API rejects anything else with `INVALID_ASPECT_RATIO`. */
export const LIFESTYLE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const
export type LifestyleAspectRatio = (typeof LIFESTYLE_ASPECT_RATIOS)[number]

/** The prompt bounds the route enforces. Checked here so a 400 never has to teach the rule. */
export const LIFESTYLE_PROMPT_MIN = 10
export const LIFESTYLE_PROMPT_MAX = 2000

/**
 * `POST /images/generate-lifestyle` — NESTS the row under `image`, like `import-from-dam` and
 * unlike the uploads. See the note above; this is the third distinct shape in one route file.
 */
export interface GenerateLifestyleResponse {
  ok: boolean
  image: MasterAsset
  /** What Imagen was actually given — it may differ from what was typed. */
  prompt: string
  aspectRatio: LifestyleAspectRatio
}

