/**
 * IE.6 — Resolve a ListingImage to its effective (url, alt) pair.
 *
 * Single source of truth: when a ListingImage references a master
 * via sourceProductImageId, the master is the authority for both
 * the URL and the alt text. The publisher, cascade-republisher,
 * and any other reader uses this helper instead of reading
 * ListingImage.url / .alt directly, so a master re-upload
 * propagates to every dependent channel row without per-row
 * backfill.
 *
 * altOverride wins when present — that's how an operator scopes a
 * variant-specific alt without uploading a separate image.
 *
 * Fallback order:
 *   url: master.url → li.url
 *   alt: li.altOverride → master.alt → null
 *
 * If sourceProductImageId is set but the master row is missing
 * (deleted out of band), the helper falls back to li.url + null
 * alt so the caller doesn't get a hard failure. Orphan detection
 * lives elsewhere (IE.5 drift surface).
 */

export interface ListingImageLike {
  url: string | null
  altOverride?: string | null
  sourceProductImageId?: string | null
}

export interface MasterImageLike {
  id: string
  url: string
  alt: string | null
}

export interface EffectiveListingImage {
  url: string
  alt: string | null
  /** Where the URL came from — useful for telemetry + drift detection. */
  urlSource: 'master' | 'self' | 'unknown'
}

export function resolveEffectiveListingImage(
  li: ListingImageLike,
  masterById: Map<string, MasterImageLike> | Record<string, MasterImageLike | undefined>,
): EffectiveListingImage {
  const lookup = (id: string): MasterImageLike | undefined =>
    masterById instanceof Map ? masterById.get(id) : masterById[id]

  const master = li.sourceProductImageId ? lookup(li.sourceProductImageId) : undefined

  if (master) {
    return {
      url: master.url,
      alt: li.altOverride ?? master.alt ?? null,
      urlSource: 'master',
    }
  }
  if (li.url) {
    return {
      url: li.url,
      alt: li.altOverride ?? null,
      urlSource: 'self',
    }
  }
  // Pathological — no source, no url. Caller should treat as missing.
  return { url: '', alt: li.altOverride ?? null, urlSource: 'unknown' }
}

/**
 * Convenience for callers holding a list of masters.
 * Builds the index once + applies to every ListingImage.
 */
export function buildMasterIndex(
  masters: MasterImageLike[],
): Map<string, MasterImageLike> {
  const out = new Map<string, MasterImageLike>()
  for (const m of masters) out.set(m.id, m)
  return out
}
