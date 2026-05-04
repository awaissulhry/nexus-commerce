/**
 * Phase F — per-platform image validation rules.
 *
 * Honest about scope: we only validate what we can see from the
 * resolved image set's metadata (count, dimensions when stored,
 * mime type). White-background and "no text on image" checks would
 * need either a vision model or canvas-pixel inspection — we surface
 * them as warnings ("verify manually") rather than hard-validating.
 *
 * The wizard treats Amazon as the only platform with hard
 * requirements (≥1 image, ≤9 images). eBay/Shopify/Woo are warnings
 * only — they accept listings without images technically, even though
 * conversion suffers.
 *
 * The dedicated image-manager page (separate from the wizard) will
 * extend this with proper dimension fetching + the visual checks.
 */

import type { ResolvedImage } from './image-resolution.service.js'

export interface ValidationIssue {
  severity: 'blocking' | 'warning'
  code: string
  message: string
  /** Index into the resolved image array, when the issue is per-image. */
  imageIndex?: number
}

export interface PlatformValidationResult {
  platform: string
  marketplace: string
  imageCount: number
  hasMain: boolean
  blocking: ValidationIssue[]
  warnings: ValidationIssue[]
  /** Net status: 'ok' (no blocking + no warnings) | 'warned' | 'blocked'. */
  status: 'ok' | 'warned' | 'blocked'
}

interface PlatformRules {
  minImages: number
  maxImages: number | null
  minDimensionPx?: number
  acceptedMimeTypes?: string[]
  warnings?: string[]
}

const PLATFORM_RULES: Record<string, PlatformRules> = {
  AMAZON: {
    minImages: 1,
    maxImages: 9,
    minDimensionPx: 1000,
    acceptedMimeTypes: ['image/jpeg', 'image/png'],
    warnings: [
      'Main image must have a pure white background — verify manually before publishing.',
      'Main image should fill at least 85% of the frame.',
    ],
  },
  EBAY: {
    minImages: 0, // technically optional but conversion suffers
    maxImages: 12,
    minDimensionPx: 500,
    warnings: [
      'eBay strongly recommends at least 3 images for buyer trust.',
    ],
  },
  SHOPIFY: {
    minImages: 0,
    maxImages: 250,
    minDimensionPx: 800,
  },
  WOOCOMMERCE: {
    minImages: 0,
    maxImages: null,
    minDimensionPx: 800,
  },
}

export function validateForPlatform(
  images: ResolvedImage[],
  platform: string,
  marketplace: string,
): PlatformValidationResult {
  const rules = PLATFORM_RULES[platform.toUpperCase()] ?? PLATFORM_RULES.AMAZON!

  const blocking: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (images.length < rules.minImages) {
    blocking.push({
      severity: 'blocking',
      code: 'too_few',
      message: `${platform} requires at least ${rules.minImages} image${
        rules.minImages === 1 ? '' : 's'
      }; resolved set has ${images.length}.`,
    })
  }
  if (rules.maxImages !== null && images.length > rules.maxImages) {
    blocking.push({
      severity: 'blocking',
      code: 'too_many',
      message: `${platform} accepts at most ${rules.maxImages} images; resolved set has ${images.length}.`,
    })
  }

  const hasMain = images.some((i) => i.role === 'MAIN') || images.length > 0
  // The first resolved image is treated as the main listing image
  // when nothing's explicitly tagged MAIN — Amazon/eBay both default
  // to "first image is hero".
  if (!hasMain && rules.minImages > 0) {
    blocking.push({
      severity: 'blocking',
      code: 'no_main',
      message: `${platform} needs a main image — none of the resolved set is tagged as the hero.`,
    })
  }

  // Per-image checks — only fire when we have the metadata stored.
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!
    if (
      typeof rules.minDimensionPx === 'number' &&
      img.width !== null &&
      img.height !== null &&
      (img.width < rules.minDimensionPx || img.height < rules.minDimensionPx)
    ) {
      warnings.push({
        severity: 'warning',
        code: 'small_image',
        message: `Image ${i + 1} is ${img.width}×${img.height}px; ${platform} recommends at least ${rules.minDimensionPx}px on the long edge.`,
        imageIndex: i,
      })
    }
    if (
      Array.isArray(rules.acceptedMimeTypes) &&
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

  // Generic platform warnings (white-bg reminder etc.) — always shown
  // when the platform has any.
  if (Array.isArray(rules.warnings) && images.length > 0) {
    for (const msg of rules.warnings) {
      warnings.push({
        severity: 'warning',
        code: 'platform_reminder',
        message: msg,
      })
    }
  }

  const status: PlatformValidationResult['status'] =
    blocking.length > 0 ? 'blocked' : warnings.length > 0 ? 'warned' : 'ok'

  return {
    platform,
    marketplace,
    imageCount: images.length,
    hasMain,
    blocking,
    warnings,
    status,
  }
}
