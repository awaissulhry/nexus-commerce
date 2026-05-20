// IR.5.1 — Single source of truth for per-channel image rules.
//
// Both apps/api (validation pipeline + listing wizard) and apps/web
// (QualityChecklist, Amazon matrix per-cell warnings, eBay/Shopify
// limit bars) import from here. Eliminates drift like the eBay 12-vs-24
// mismatch closed in IR.1.1.
//
// What lives here:
//   - PLATFORM_RULES — minImages / maxImages / minDimensionPx /
//     acceptedMimeTypes / recommendedAspect / hardWarnings
//   - validateImageList(images, platform) — pure function returning
//     blocking + warning issues
//   - aspectKindForRatio(w, h) — classifies a ratio into the channel's
//     common buckets ("1:1", "4:3", "4:5", "16:9", "portrait", "landscape")
//
// Vision-based checks (white-background, frame fill %, text overlay,
// watermarks) intentionally stay out of this module — they need a model
// call and land in IR.6.

export type PlatformKey = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'

export interface PlatformRules {
  /** Hard floor — blocks publish when below. */
  minImages: number
  /** Hard ceiling — blocks publish when above. NULL = unlimited. */
  maxImages: number | null
  /** Per-image recommended floor on long edge. Warn if below. */
  minDimensionPx: number
  /** MIME types the channel accepts; warn on others. Empty = any. */
  acceptedMimeTypes: string[]
  /** Channel's preferred aspect ratio for hero/MAIN images. */
  recommendedAspectRatio: number | null
  /** Human label for the recommended ratio ("1:1", "4:3", "4:5"). */
  recommendedAspectLabel: string | null
  /** Tolerance — fractional deviation from recommendedAspect that
   *  still counts as on-target (e.g. 0.05 = ±5%). */
  aspectTolerance: number
  /** Free-text warnings that always show when the channel has images
   *  but can't be auto-checked here (white-bg, no text on image, etc). */
  manualWarnings: string[]
}

export const PLATFORM_RULES: Record<PlatformKey, PlatformRules> = {
  AMAZON: {
    minImages: 1,
    maxImages: 9,
    minDimensionPx: 1000,
    acceptedMimeTypes: ['image/jpeg', 'image/png'],
    recommendedAspectRatio: 1,
    recommendedAspectLabel: '1:1',
    aspectTolerance: 0.05,
    manualWarnings: [
      'Main image must have a pure white background.',
      'Main image should fill at least 85 % of the frame.',
      'No text, logos, or watermarks on the product itself.',
    ],
  },
  EBAY: {
    minImages: 0, // technically optional
    // 24 = PictureDetails gallery max for fixed-price listings.
    // Per-variation VariationSpecificPictureSet is a separate 12-limit.
    maxImages: 24,
    minDimensionPx: 500,
    acceptedMimeTypes: ['image/jpeg', 'image/png'],
    recommendedAspectRatio: 1,
    recommendedAspectLabel: '1:1',
    aspectTolerance: 0.1, // eBay is forgiving
    manualWarnings: [
      'eBay strongly recommends at least 3 images.',
      'No borders, watermarks, or seller-info overlays.',
    ],
  },
  SHOPIFY: {
    minImages: 0,
    maxImages: 250,
    minDimensionPx: 800,
    acceptedMimeTypes: [], // any
    recommendedAspectRatio: 4 / 5, // portrait — Dawn + most themes
    recommendedAspectLabel: '4:5',
    aspectTolerance: 0.08,
    manualWarnings: [],
  },
  WOOCOMMERCE: {
    minImages: 0,
    maxImages: null,
    minDimensionPx: 800,
    acceptedMimeTypes: [],
    recommendedAspectRatio: null,
    recommendedAspectLabel: null,
    aspectTolerance: 0.1,
    manualWarnings: [],
  },
}

// ── Validation ────────────────────────────────────────────────────────

export interface ValidationIssue {
  severity: 'blocking' | 'warning'
  code: string
  message: string
  imageIndex?: number
}

export interface ImageForValidation {
  url: string
  role?: string
  width?: number | null
  height?: number | null
  mimeType?: string | null
}

export interface PlatformValidationResult {
  platform: PlatformKey
  marketplace: string
  imageCount: number
  hasMain: boolean
  blocking: ValidationIssue[]
  warnings: ValidationIssue[]
  status: 'ok' | 'warned' | 'blocked'
}

function ratiosMatch(w: number, h: number, target: number, tolerance: number): boolean {
  if (target <= 0) return true
  const actual = w / h
  return Math.abs(actual - target) / target <= tolerance
}

export function validateImageList(
  images: ImageForValidation[],
  platform: PlatformKey,
  marketplace: string = 'DEFAULT',
): PlatformValidationResult {
  const rules = PLATFORM_RULES[platform] ?? PLATFORM_RULES.AMAZON
  const blocking: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  // Count rules.
  if (images.length < rules.minImages) {
    blocking.push({
      severity: 'blocking',
      code: 'too_few',
      message: `${platform} requires at least ${rules.minImages} image${rules.minImages === 1 ? '' : 's'}; the resolved set has ${images.length}.`,
    })
  }
  if (rules.maxImages !== null && images.length > rules.maxImages) {
    blocking.push({
      severity: 'blocking',
      code: 'too_many',
      message: `${platform} accepts at most ${rules.maxImages} images; the resolved set has ${images.length}.`,
    })
  }

  // Main image — explicit role tag OR first image (Amazon/eBay default).
  const hasMain = images.some((i) => i.role === 'MAIN') || images.length > 0
  if (!hasMain && rules.minImages > 0) {
    blocking.push({
      severity: 'blocking',
      code: 'no_main',
      message: `${platform} needs a main image — none of the resolved set is tagged as the hero.`,
    })
  }

  // Per-image checks — only fire when metadata exists.
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!
    if (
      img.width !== null && img.width !== undefined &&
      img.height !== null && img.height !== undefined
    ) {
      const longEdge = Math.max(img.width, img.height)
      if (longEdge < rules.minDimensionPx) {
        warnings.push({
          severity: 'warning',
          code: 'small_image',
          message: `Image ${i + 1} is ${img.width}×${img.height} px; ${platform} recommends at least ${rules.minDimensionPx} px on the long edge.`,
          imageIndex: i,
        })
      }

      if (
        rules.recommendedAspectRatio !== null &&
        !ratiosMatch(img.width, img.height, rules.recommendedAspectRatio, rules.aspectTolerance)
      ) {
        warnings.push({
          severity: 'warning',
          code: 'aspect_mismatch',
          message: `Image ${i + 1} is ${img.width}×${img.height} (~${(img.width / img.height).toFixed(2)}); ${platform} prefers ${rules.recommendedAspectLabel}.`,
          imageIndex: i,
        })
      }
    }

    if (
      rules.acceptedMimeTypes.length > 0 &&
      img.mimeType &&
      !rules.acceptedMimeTypes.includes(img.mimeType)
    ) {
      warnings.push({
        severity: 'warning',
        code: 'mime_type',
        message: `Image ${i + 1} has unusual MIME type (${img.mimeType}); ${platform} prefers ${rules.acceptedMimeTypes.join(' or ')}.`,
        imageIndex: i,
      })
    }
  }

  // Manual reminders — always shown when the channel has any images.
  if (images.length > 0) {
    for (const msg of rules.manualWarnings) {
      warnings.push({
        severity: 'warning',
        code: 'manual_reminder',
        message: msg,
      })
    }
  }

  const status: PlatformValidationResult['status'] =
    blocking.length > 0 ? 'blocked' : warnings.length > 0 ? 'warned' : 'ok'

  return { platform, marketplace, imageCount: images.length, hasMain, blocking, warnings, status }
}

// ── Convenience helpers used by FE components ───────────────────────

export function isAspectOnTarget(
  width: number | null | undefined,
  height: number | null | undefined,
  platform: PlatformKey,
): boolean | null {
  if (!width || !height) return null
  const rules = PLATFORM_RULES[platform]
  if (rules.recommendedAspectRatio === null) return true
  return ratiosMatch(width, height, rules.recommendedAspectRatio, rules.aspectTolerance)
}

export function isDimensionOnTarget(
  width: number | null | undefined,
  height: number | null | undefined,
  platform: PlatformKey,
): boolean | null {
  if (!width || !height) return null
  const rules = PLATFORM_RULES[platform]
  return Math.max(width, height) >= rules.minDimensionPx
}
