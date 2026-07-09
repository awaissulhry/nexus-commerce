/**
 * EFX P5 — pure axis logic for the eBay images workspace + inventory publish.
 *
 * Extracted so vitest can exercise the axis-picker derivation, the
 * publish-time axis resolution (incl. the explicit '__shared__' request),
 * and the 12-image clamp without loading prisma or the push service.
 *
 * Run: npx vitest run src/services/images/ebay-image-axis.pure.vitest.test.ts
 */
import { axisSynonymKey } from '../ebay-theme-axes.js'

/**
 * Wire value for "one shared gallery (no per-variant images)".
 * The modal sends it as `activeAxis`, PATCH …/images-workspace/axis persists
 * it as `Product.imageAxisPreference`, and the publish service treats it as an
 * explicit shared-gallery request (omit aspectsImageVariesBy, listing-level
 * imageUrls only). It intentionally never collides with a real aspect name.
 */
export const SHARED_GALLERY_AXIS = '__shared__'

/**
 * eBay's REAL image limit for the variation-group publish path.
 *
 * Per eBay's Inventory API "Managing images" doc
 * (developer.ebay.com/api-docs/sell/static/inventory/managing-image-media.html):
 * "For multiple-variation listings, a maximum of 12 pictures may be used per
 * variation." The Trading API's VariationSpecificPictureSet carries the same
 * 12-picture cap. Single-SKU listings allow up to 24 pictures, but everything
 * this module feeds (per-axis-value curated sets, per-SKU overrides, the
 * group-level "cover & common" gallery our push slices to 12) publishes
 * through inventory_item_group — so 12 is the honest ceiling.
 */
export const EBAY_VARIATION_IMAGE_MAX = 12

// ── Workspace axis derivation (GET …/images-workspace availableAxes) ────────

export interface WorkspaceAxisVariant {
  variantAttributes?: Record<string, unknown> | null
  /** Raw Product.categoryAttributes JSON — `.variations` is read when present. */
  categoryAttributes?: unknown
}

export interface WorkspaceAxes {
  /** Synonym-deduped display names (first-seen casing), sorted A→Z. */
  availableAxes: string[]
  /** Display name → distinct value count (case-insensitive), additive field. */
  axisValueCounts: Record<string, number>
}

/**
 * Union of child `variantAttributes` keys AND child
 * `categoryAttributes.variations` keys, collapsed per synonym dimension
 * (Colore ≡ Color ≡ colour name → one entry) with the FIRST-seen casing kept
 * as the display name. Value counts let the picker annotate single-valued
 * axes ("1 value — publishes as shared gallery").
 *
 * Before EFX P5 only variantAttributes keys were considered, so axes living
 * exclusively in categoryAttributes.variations (legacy bulk-create products,
 * custom axes like "Tipo di prodotto") never reached the picker.
 */
export function deriveWorkspaceAxes(variants: WorkspaceAxisVariant[]): WorkspaceAxes {
  const bySyn = new Map<string, { display: string; values: Set<string> }>()

  const collect = (attrs: unknown) => {
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return
    for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
      const name = k.trim()
      if (!name) continue
      const syn = axisSynonymKey(name)
      let entry = bySyn.get(syn)
      if (!entry) {
        entry = { display: name, values: new Set<string>() }
        bySyn.set(syn, entry)
      }
      if (typeof v === 'string' || typeof v === 'number') {
        const val = String(v).trim().toLowerCase()
        if (val) entry.values.add(val)
      }
    }
  }

  for (const variant of variants) {
    collect(variant.variantAttributes)
    const cat = variant.categoryAttributes
    if (cat && typeof cat === 'object' && !Array.isArray(cat)) {
      collect((cat as Record<string, unknown>).variations)
    }
  }

  const entries = [...bySyn.values()].sort((a, b) => a.display.localeCompare(b.display))
  const axisValueCounts: Record<string, number> = {}
  for (const e of entries) axisValueCounts[e.display] = e.values.size
  return { availableAxes: entries.map((e) => e.display), axisValueCounts }
}

// ── Publish-time picture-axis resolution ─────────────────────────────────────

export interface FamilyAxisInfo {
  /** Display-cased aspect name as it appears on the family's rows. */
  label: string
  /** Distinct values (already lowercased by the caller). */
  values: Set<string>
}

export interface ImageAxisResolution {
  /** What was asked for: activeAxis → imageAxisPreference → 'Color'. */
  requestedAxis: string
  /**
   * The axis curated sets are matched by / pictures vary by.
   * null ⇔ explicit shared-gallery request (no axis at all).
   */
  pictureAxis: string | null
  /** The axes the family REALLY varies by (>1 distinct value). */
  realAxes: string[]
  /** Publish with ONE listing-level gallery (aspectsImageVariesBy omitted). */
  sharedGallery: boolean
  /** The operator explicitly asked for the shared gallery ('__shared__'). */
  explicitShared: boolean
}

/**
 * FFP.7/15/16 resolution rules, extracted verbatim + the EFX P5
 * '__shared__' branch:
 *   • requested = activeAxis → stored preference → 'Color'
 *   • '__shared__'           → explicit shared gallery, pictureAxis = null
 *   • matches a multi-value axis  → vary by it (operator intent wins,
 *     even for Size)
 *   • matches a single-value axis → shared gallery (curated rows under that
 *     axis still fold into the listing gallery via pictureAxis)
 *   • matches nothing → fall back to the first non-size multi-value axis;
 *     with no eligible fallback → shared gallery
 */
export function resolveImagePictureAxis(
  axisInfo: FamilyAxisInfo[],
  activeAxis?: string | null,
  imageAxisPreference?: string | null,
): ImageAxisResolution {
  const requestedAxis = (activeAxis ?? '').trim() || (imageAxisPreference ?? '').trim() || 'Color'
  const multiAxes = axisInfo.filter((a) => a.values.size > 1).map((a) => a.label)

  if (requestedAxis === SHARED_GALLERY_AXIS) {
    return { requestedAxis, pictureAxis: null, realAxes: multiAxes, sharedGallery: true, explicitShared: true }
  }

  const matchedMulti = multiAxes.find((a) => axisSynonymKey(a) === axisSynonymKey(requestedAxis))
  const matchedAny = axisInfo.find((a) => axisSynonymKey(a.label) === axisSynonymKey(requestedAxis))
  // FFP.16 — the FALLBACK may never pick a size-like axis (per-size picture
  // sets make the PDP gallery swap as the buyer clicks sizes). An EXPLICIT
  // size pick on a family that truly varies by size is honored via matchedMulti.
  const sizeLike = (label: string) => axisSynonymKey(label) === axisSynonymKey('Size')
  const fallbackAxis = multiAxes.find((a) => !sizeLike(a))
  const sharedGallery = !matchedMulti && (!!matchedAny || !fallbackAxis)
  const pictureAxis = matchedMulti
    ?? (matchedAny ? matchedAny.label : (fallbackAxis ?? requestedAxis))

  return { requestedAxis, pictureAxis, realAxes: multiAxes, sharedGallery, explicitShared: false }
}

// ── 12-image clamp (never silent) ────────────────────────────────────────────

/**
 * Clamp every set in `sets` to `max` URLs IN PLACE. Returns one human-readable
 * warning per truncated set so the caller can surface the drop to the operator
 * (eBay would otherwise silently ignore the extra pictures — or reject the
 * item — with no feedback).
 */
export function clampImageSets(
  sets: Map<string, string[]>,
  max: number,
  describe: (key: string) => string,
): string[] {
  const warnings: string[] = []
  for (const [key, urls] of sets) {
    if (urls.length > max) {
      warnings.push(
        `${describe(key)}: ${urls.length} images curated — only the first ${max} were sent (eBay allows ${max} pictures per variation)`,
      )
      sets.set(key, urls.slice(0, max))
    }
  }
  return warnings
}
