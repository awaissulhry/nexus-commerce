/**
 * PIM A.2 — Resolver shadow-compare.
 *
 * Runs alongside legacy read paths to validate that
 * resolveAttributes() produces the same merged values that direct-
 * column reads do, for real production data shapes. Logs mismatches
 * as structured warnings; never alters the response.
 *
 * Activation: env flag PIM_RESOLVER_SHADOW=true. Off by default; when
 * off, the entry point is a noop and adds zero overhead.
 *
 * Compare contract (what we validate):
 *   1. categoryAttributes keys merge correctly from master → variant.
 *   2. localizedContent[locale] resolves with locale → en fallback.
 *   3. SSOT fields (title/description/price/quantity/bulletPoints)
 *      respect followMasterX: when true, return master/locale value;
 *      when false, return *Override (or legacy direct column).
 *
 * Three mismatch categories track real bugs vs expected "empty data":
 *   - both_present_differ:        resolver and legacy both returned
 *                                 a value but they differ. ACTUAL BUG.
 *   - resolver_absent_legacy_present:  data not yet in JSONB
 *                                 (localizedContent empty). EXPECTED
 *                                 until A.4 backfill runs; tracked so
 *                                 we know when to schedule that work.
 *   - resolver_present_legacy_absent:  resolver synthesised something
 *                                 from JSONB the legacy path doesn't
 *                                 know about. Worth investigating.
 */

import {
  resolveAttributes,
  type ProductLike,
  type ChannelListingLike,
  type ResolvedValue,
} from './attribute-resolver.js'

// ────────────────────────────────────────────────────────────────────
// Types + buffer
// ────────────────────────────────────────────────────────────────────

export type MismatchCategory =
  | 'both_present_differ'
  | 'resolver_absent_legacy_present'
  | 'resolver_present_legacy_absent'

export interface Mismatch {
  productId: string
  channelListingId: string | null
  key: string
  resolverValue: unknown
  legacyValue: unknown
  resolverSource: ResolvedValue['source'] | null
  category: MismatchCategory
  at: string
}

const BUFFER_CAP = 500
const buffer: Mismatch[] = []

export function recordMismatch(m: Mismatch): void {
  buffer.push(m)
  if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP)
}

export interface ShadowStats {
  totalMismatches: number
  byCategory: Record<MismatchCategory, number>
  byKey: Record<string, number>
  byChannelListingId: Record<string, number>
  recent: Mismatch[]
}

export function getShadowStats(recentN: number = 20): ShadowStats {
  const byCategory: Record<MismatchCategory, number> = {
    both_present_differ: 0,
    resolver_absent_legacy_present: 0,
    resolver_present_legacy_absent: 0,
  }
  const byKey: Record<string, number> = {}
  const byChannelListingId: Record<string, number> = {}

  for (const m of buffer) {
    byCategory[m.category]++
    byKey[m.key] = (byKey[m.key] ?? 0) + 1
    if (m.channelListingId) {
      byChannelListingId[m.channelListingId] =
        (byChannelListingId[m.channelListingId] ?? 0) + 1
    }
  }

  return {
    totalMismatches: buffer.length,
    byCategory,
    byKey,
    byChannelListingId,
    recent: buffer.slice(-recentN),
  }
}

export function resetShadowBuffer(): void {
  buffer.length = 0
}

// ────────────────────────────────────────────────────────────────────
// Activation flag
// ────────────────────────────────────────────────────────────────────

export function isShadowEnabled(): boolean {
  return process.env.PIM_RESOLVER_SHADOW === 'true'
}

// ────────────────────────────────────────────────────────────────────
// Value equality (loose: number/Decimal/string-number all comparable)
// ────────────────────────────────────────────────────────────────────

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false

  // Numeric loose-equality — covers Prisma Decimal vs number vs numeric
  // string. The legacy path coerces with Number(); resolver may pass
  // through whichever shape was stored.
  const aNum = typeof a === 'number' ? a : Number(a)
  const bNum = typeof b === 'number' ? b : Number(b)
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum) && (typeof a === 'number' || typeof b === 'number')) {
    return aNum === bNum
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]))
  }
  return false
}

function classify(resolverValue: unknown, legacyValue: unknown): MismatchCategory | null {
  const rPresent = resolverValue !== undefined && resolverValue !== null
  const lPresent = legacyValue !== undefined && legacyValue !== null
  if (!rPresent && !lPresent) return null
  if (rPresent && !lPresent) return 'resolver_present_legacy_absent'
  if (!rPresent && lPresent) return 'resolver_absent_legacy_present'
  if (valuesEqual(resolverValue, legacyValue)) return null
  return 'both_present_differ'
}

// ────────────────────────────────────────────────────────────────────
// Compare engines
// ────────────────────────────────────────────────────────────────────

/** Legacy read path → key/value expectations for SSOT fields. The
 *  resolver should match these. */
interface SsotExpectation {
  key: 'title' | 'description' | 'price' | 'quantity' | 'bulletPoints'
  /** What the legacy code returns for this field, given the entities. */
  legacyValue: unknown
}

function ssotExpectations(
  cl: ChannelListingLike,
  product: ProductLike,
  parent: ProductLike | null,
): SsotExpectation[] {
  // parent/product reserved for future SSOT cases that consult the
  // master layer (e.g., comparing localizedContent[locale].title).
  void parent
  void product

  const all: SsotExpectation[] = [
    {
      key: 'title',
      legacyValue: cl.followMasterTitle === false
        ? (cl.titleOverride ?? cl.title ?? null)
        : null, // legacy "master" title isn't in resolver scope yet — it lives in Product.name
    },
    {
      key: 'description',
      legacyValue: cl.followMasterDescription === false
        ? (cl.descriptionOverride ?? cl.description ?? null)
        : null,
    },
    {
      key: 'price',
      legacyValue: cl.followMasterPrice === false
        ? (cl.priceOverride ?? cl.price ?? null)
        : null,
    },
    {
      key: 'quantity',
      legacyValue: cl.followMasterQuantity === false
        ? (cl.quantityOverride ?? cl.quantity ?? null)
        : null,
    },
    {
      key: 'bulletPoints',
      legacyValue: cl.followMasterBulletPoints === false
        ? (cl.bulletPointsOverride ?? null)
        : null,
    },
  ]

  // We only compare when legacy expects an override (i.e., followMasterX === false).
  // When followMasterX === true, the legacy path falls through to master columns
  // (Product.name, Product.basePrice) which aren't in resolver scope yet — A.4
  // wires those in once localizedContent is backfilled. Suppressing those cases
  // here keeps the noise floor low while we ship A.2.
  return all.filter((e) => e.legacyValue !== null)
}

export interface ShadowCompareInput {
  product: ProductLike
  parent: ProductLike | null
  channelListings: ChannelListingLike[]
  locale?: string
  logger?: { warn: (obj: object, msg?: string) => void }
}

/**
 * Run the shadow compare for a product detail load. Mismatches go to
 * the buffer + the logger; the function returns the count of issues
 * recorded for this call (useful for callers that want to surface
 * "shadow-detected N issues" telemetry).
 */
/** A.4 — Keys the resolver synthesizes from legacy Product columns, and
 *  the legacy-column name that drives the expectation. Used by the
 *  shadow to validate synthesis against direct column reads. The
 *  expectation respects variant→parent precedence: if a variant has
 *  the column set, that wins; otherwise the parent's column does. */
const SYNTHESIZED_KEYS: Array<{
  resolverKey: string
  legacyCol:
    | 'name'
    | 'description'
    | 'bulletPoints'
    | 'keywords'
    | 'brand'
    | 'manufacturer'
    | 'basePrice'
}> = [
  { resolverKey: 'title',        legacyCol: 'name' },
  { resolverKey: 'description',  legacyCol: 'description' },
  { resolverKey: 'bulletPoints', legacyCol: 'bulletPoints' },
  { resolverKey: 'keywords',     legacyCol: 'keywords' },
  { resolverKey: 'brand',        legacyCol: 'brand' },
  { resolverKey: 'manufacturer', legacyCol: 'manufacturer' },
  { resolverKey: 'basePrice',    legacyCol: 'basePrice' },
]

/** Pick the legacy-column value that "wins" between variant and parent:
 *  variant value if non-empty, else parent value. Empty arrays count as
 *  absent so a variant with `bulletPoints: []` falls back to parent. */
function pickInheritedColumn(
  product: ProductLike,
  parent: ProductLike | null,
  col: string,
): unknown {
  const own = (product as unknown as Record<string, unknown>)[col]
  const ownPresent = own !== undefined && own !== null
    && !(Array.isArray(own) && own.length === 0)
  if (ownPresent) return own
  if (!parent) return null
  return (parent as unknown as Record<string, unknown>)[col]
}

export function shadowCompareProductRead(input: ShadowCompareInput): number {
  const { product, parent, channelListings, locale = 'en', logger } = input
  let recorded = 0

  // 1. Compare categoryAttributes keys (master + variant). For each
  //    key present in either layer, the resolver must return either
  //    the variant value (if set) or the parent value (if inheriting).
  const allCategoryKeys = new Set<string>([
    ...Object.keys(parent?.categoryAttributes ?? {}),
    ...Object.keys(product.categoryAttributes ?? {}),
  ])

  const productLevel = resolveAttributes({ product, parent, locale })

  for (const key of allCategoryKeys) {
    const ownValue = (product.categoryAttributes ?? {})[key]
    const parentValue = (parent?.categoryAttributes ?? {})[key]
    // Expected: variant value if set, else parent value.
    const expected = ownValue !== undefined ? ownValue : parentValue
    const resolved = productLevel[key]?.value

    const cat = classify(resolved, expected)
    if (!cat) continue

    const m: Mismatch = {
      productId: product.id,
      channelListingId: null,
      key,
      resolverValue: resolved,
      legacyValue: expected,
      resolverSource: productLevel[key]?.source ?? null,
      category: cat,
      at: new Date().toISOString(),
    }
    recordMismatch(m)
    logger?.warn(
      {
        productId: m.productId,
        key: m.key,
        resolver: m.resolverValue,
        legacy: m.legacyValue,
        source: m.resolverSource,
        category: m.category,
      },
      'pim-resolver-shadow-mismatch',
    )
    recorded++
  }

  // 1b. A.4 — Compare synthesized keys (title/description/bullet-
  //     Points/etc.) against the corresponding legacy columns.
  //     Synthesis fires only at the default locale ('en'); for other
  //     locales the resolver returns nothing for these keys and the
  //     legacy column is the "if you fell back to en, this is what
  //     you'd see" reference. We skip the compare for non-en locales
  //     since the resolver intentionally doesn't synthesize there.
  if (locale === 'en') {
    for (const { resolverKey, legacyCol } of SYNTHESIZED_KEYS) {
      const expected = pickInheritedColumn(product, parent, legacyCol)
      const resolved = productLevel[resolverKey]?.value
      const cat = classify(resolved, expected)
      if (!cat) continue

      const m: Mismatch = {
        productId: product.id,
        channelListingId: null,
        key: resolverKey,
        resolverValue: resolved,
        legacyValue: expected,
        resolverSource: productLevel[resolverKey]?.source ?? null,
        category: cat,
        at: new Date().toISOString(),
      }
      recordMismatch(m)
      logger?.warn(
        {
          productId: m.productId,
          key: m.key,
          resolver: m.resolverValue,
          legacy: m.legacyValue,
          source: m.resolverSource,
          category: m.category,
        },
        'pim-resolver-shadow-mismatch',
      )
      recorded++
    }
  }

  // 2. Compare SSOT fields per channel listing.
  for (const cl of channelListings) {
    const chanLevel = resolveAttributes({ product, parent, channelListing: cl, locale })
    for (const exp of ssotExpectations(cl, product, parent)) {
      const resolved = chanLevel[exp.key]?.value
      const cat = classify(resolved, exp.legacyValue)
      if (!cat) continue

      const m: Mismatch = {
        productId: product.id,
        channelListingId: cl.id,
        key: exp.key,
        resolverValue: resolved,
        legacyValue: exp.legacyValue,
        resolverSource: chanLevel[exp.key]?.source ?? null,
        category: cat,
        at: new Date().toISOString(),
      }
      recordMismatch(m)
      logger?.warn(
        {
          productId: m.productId,
          channelListingId: m.channelListingId,
          key: m.key,
          resolver: m.resolverValue,
          legacy: m.legacyValue,
          source: m.resolverSource,
          category: m.category,
        },
        'pim-resolver-shadow-mismatch',
      )
      recorded++
    }
  }

  return recorded
}
