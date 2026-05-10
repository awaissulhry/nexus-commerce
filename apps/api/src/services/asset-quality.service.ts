/**
 * MC.3.4 — per-asset quality checks.
 *
 * Runs at upload time against the dimensions Cloudinary returns and
 * persists structured warnings into DigitalAsset.metadata.qualityWarnings.
 * The detail drawer renders them as a badge so the operator sees
 * what'll fail per-channel without needing to attach + re-publish
 * to find out.
 *
 * Distinction from validation.service.ts (Phase F):
 *   - validation.service.ts validates a *resolved set* per channel
 *     publication — the right hook for "are we OK to publish to
 *     Amazon today?"
 *   - asset-quality.service.ts validates a *single asset* at upload
 *     time — the right hook for "should the operator know this
 *     image won't pass Amazon thresholds?"
 *
 * Both use the same minimum-dimension thresholds; we hardcode the
 * minimum here to avoid coupling the upload path to ResolvedImage.
 */

export interface QualityWarning {
  code: string
  channel: string | null
  message: string
}

export interface QualityCheckInput {
  width: number | null
  height: number | null
  mimeType: string
  sizeBytes: number
}

const CHANNEL_MIN_DIMENSION_PX: Record<string, number> = {
  AMAZON: 1000,
  EBAY: 500,
  SHOPIFY: 800,
  WOOCOMMERCE: 800,
}

const AMAZON_MIME_OK = new Set(['image/jpeg', 'image/png'])

// Aspect ratios outside this band are unusable for product imagery on
// most marketplaces — square / 4:3 / 3:4 all sit comfortably inside.
// Anything thinner than 1:3 (banner) or wider than 3:1 (panorama)
// almost certainly isn't a usable hero image.
const ASPECT_MIN = 1 / 3
const ASPECT_MAX = 3

export function checkAssetQuality(
  input: QualityCheckInput,
): QualityWarning[] {
  const warnings: QualityWarning[] = []

  const { width, height, mimeType, sizeBytes } = input

  // Per-channel minimum-dimension warnings.
  if (typeof width === 'number' && typeof height === 'number') {
    const longEdge = Math.max(width, height)
    for (const [channel, minPx] of Object.entries(CHANNEL_MIN_DIMENSION_PX)) {
      if (longEdge < minPx) {
        warnings.push({
          code: 'below_channel_minimum',
          channel,
          message: `${width}×${height}px is below ${channel}'s ${minPx}px minimum on the long edge.`,
        })
      }
    }

    // Aspect-ratio sanity. Channel-agnostic.
    const aspect = width / height
    if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) {
      warnings.push({
        code: 'extreme_aspect_ratio',
        channel: null,
        message: `Aspect ratio ${aspect.toFixed(2)}:1 is unusual for product imagery — verify the asset is intentional.`,
      })
    }
  } else {
    warnings.push({
      code: 'missing_dimensions',
      channel: null,
      message: 'Storage did not return image dimensions; channel-min checks were skipped.',
    })
  }

  // Mime-type warnings. Amazon rejects WebP/GIF/AVIF on the hero;
  // the others accept anything image/*.
  if (!AMAZON_MIME_OK.has(mimeType)) {
    warnings.push({
      code: 'amazon_mime_type',
      channel: 'AMAZON',
      message: `${mimeType} is not accepted by Amazon — convert to JPEG or PNG before publishing.`,
    })
  }

  // Suspicious file size — likely either a screenshot at low quality
  // or a print-resolution master that's heavier than channels accept.
  if (sizeBytes > 10 * 1024 * 1024) {
    warnings.push({
      code: 'oversized',
      channel: null,
      message: `File is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB — many channels reject anything over 10 MB; consider compressing.`,
    })
  }
  if (sizeBytes < 20 * 1024) {
    warnings.push({
      code: 'undersized',
      channel: null,
      message: `File is ${Math.round(sizeBytes / 1024)} KB — likely a thumbnail or low-quality export. Re-export at a higher resolution.`,
    })
  }

  return warnings
}
