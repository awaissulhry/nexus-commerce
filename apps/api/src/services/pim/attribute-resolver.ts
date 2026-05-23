/**
 * PIM A.1 — Attribute resolver.
 *
 * Single read-path for "what is the value of attribute K for this
 * (product, variant?, channel?, marketplace?, locale?)". Layers values
 * from master → variant → channel-override → explicit *Override
 * columns, returning per-key provenance so the UI can render
 * inheritance (gray = inherited, bold = own) without a second pass.
 *
 * Pure: takes already-loaded entities, returns merged shape. No DB
 * access here — callers load via Prisma, batch as needed, pass in.
 *
 * Merge precedence, lowest → highest:
 *   1. Parent Product.categoryAttributes        (master truth)
 *   2. Parent Product.localizedContent[locale]
 *   3. Parent Product.localizedContent['en']    (locale fallback)
 *   4. Variant Product own values               (variantAttributes,
 *                                                categoryAttributes,
 *                                                localizedContent)
 *   5. ChannelListing.overrideData              (channel JSONB bag)
 *   6. ChannelListing explicit overrides        (titleOverride,
 *                                                priceOverride, etc.)
 *                                                — respecting the
 *                                                followMasterX flag.
 *
 * For SSOT-tracked fields (title, description, price, quantity,
 * bulletPoints), step 6 only applies when followMasterX === false.
 * When followMasterX === true, the master value from step 1-4 wins.
 */

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/** Origin of a resolved value. UI uses this to style inheritance. */
export type ValueSource =
  | 'master'           // came from parent Product.categoryAttributes
  | 'masterLocale'     // came from parent Product.localizedContent
  | 'masterColumn'     // synthesized from a legacy Product column (A.4 compat layer)
  | 'variant'          // came from variant child Product
  | 'variantLocale'    // came from variant child localizedContent
  | 'channelOverride'  // came from ChannelListing.overrideData
  | 'channelExplicit'  // came from titleOverride / priceOverride / etc.
  | 'default'          // none of the above set a value

/** Per-key resolution result. */
export interface ResolvedValue<T = unknown> {
  value: T | null
  source: ValueSource
  /** The Product/ChannelListing id this value came from. Null when
   *  source is 'default'. Used by error→editor deep linking to route
   *  the operator to the right entity. */
  inheritedFrom: string | null
}

/** Minimal Product shape the resolver needs. Pulled from Prisma but
 *  retyped here so the resolver is independent of generated types. */
export interface ProductLike {
  id: string
  parentId: string | null
  categoryAttributes: Record<string, unknown> | null
  localizedContent: Record<string, Record<string, unknown>> | null
  variantAttributes: Record<string, unknown> | null
  // ── A.4 legacy-column synthesis sources ─────────────────────────
  // Optional because not every loader hydrates them. When `synthesize:
  // true` (default) AND the corresponding JSONB key is missing, the
  // resolver returns these with source='masterColumn'. Removable once
  // all writes populate localizedContent + categoryAttributes.
  name?: string | null
  description?: string | null
  bulletPoints?: string[]
  keywords?: string[]
  brand?: string | null
  manufacturer?: string | null
  basePrice?: number | string | null
}

/** Minimal ChannelListing shape. All explicit-override fields are
 *  optional because not every listing row has every override. */
export interface ChannelListingLike {
  id: string
  overrideData: Record<string, unknown> | null
  // SSOT toggles + override columns (Phase 20):
  followMasterTitle?: boolean
  followMasterDescription?: boolean
  followMasterPrice?: boolean
  followMasterQuantity?: boolean
  followMasterBulletPoints?: boolean
  followMasterImages?: boolean
  titleOverride?: string | null
  descriptionOverride?: string | null
  priceOverride?: number | string | null
  quantityOverride?: number | null
  bulletPointsOverride?: string[]
  // Direct columns (used when SSOT toggles aren't present — legacy):
  title?: string | null
  description?: string | null
  price?: number | string | null
  quantity?: number | null
}

export interface ResolveInput {
  /** The product (or variant child Product) being resolved. */
  product: ProductLike
  /** Optional parent — required when product.parentId is set, ignored
   *  otherwise. Pass null for top-level products. */
  parent: ProductLike | null
  /** Optional channel listing (channel × marketplace). When omitted,
   *  resolution stops at variant level. */
  channelListing?: ChannelListingLike | null
  /** Locale code for localizedContent lookup. Defaults to 'en'. */
  locale?: string
  /** A.4 — Fill in missing keys from legacy Product columns
   *  (name → title, description → description, etc.). Default true.
   *  Only fires for the default locale ('en') so non-en queries don't
   *  receive English text mislabeled as the requested locale. Pass
   *  false to get strict JSONB-only behaviour (useful for "what's
   *  ACTUALLY been authored in JSONB" diagnostics). */
  synthesize?: boolean
}

export type ResolvedAttributes = Record<string, ResolvedValue>

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

const DEFAULT_LOCALE = 'en'

/** Mapping of SSOT-tracked field name → its follow-master flag +
 *  override column. Keeps the special-case logic in one table. */
const SSOT_FIELDS = [
  { key: 'title',        followFlag: 'followMasterTitle',        overrideCol: 'titleOverride',        directCol: 'title' },
  { key: 'description',  followFlag: 'followMasterDescription',  overrideCol: 'descriptionOverride',  directCol: 'description' },
  { key: 'price',        followFlag: 'followMasterPrice',        overrideCol: 'priceOverride',        directCol: 'price' },
  { key: 'quantity',     followFlag: 'followMasterQuantity',     overrideCol: 'quantityOverride',     directCol: 'quantity' },
  { key: 'bulletPoints', followFlag: 'followMasterBulletPoints', overrideCol: 'bulletPointsOverride', directCol: null },
] as const

/** A.4 — legacy Product columns the resolver can synthesize into
 *  attribute keys when the JSONB layers don't supply them. Each entry
 *  is (resolver-key → ProductLike column). Only consulted when
 *  synthesize=true AND the query is for the default locale, so non-en
 *  queries don't receive English text mislabeled. Remove an entry
 *  once 100% of writes for that key go through localizedContent. */
const SYNTHESIS_MAP: Array<{
  resolverKey: string
  column: keyof ProductLike
}> = [
  { resolverKey: 'title',        column: 'name' },
  { resolverKey: 'description',  column: 'description' },
  { resolverKey: 'bulletPoints', column: 'bulletPoints' },
  { resolverKey: 'keywords',     column: 'keywords' },
  { resolverKey: 'brand',        column: 'brand' },
  { resolverKey: 'manufacturer', column: 'manufacturer' },
  { resolverKey: 'basePrice',    column: 'basePrice' },
]

/** Apply a layer of key/values onto the accumulator. A `null` value in
 *  the layer means "explicit null" (still overrides); `undefined`
 *  means "key absent" (no-op). Caller-controlled source/inheritedFrom. */
function applyLayer(
  acc: ResolvedAttributes,
  layer: Record<string, unknown> | null | undefined,
  source: ValueSource,
  inheritedFrom: string | null,
): void {
  if (!layer || typeof layer !== 'object') return
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue
    acc[key] = { value, source, inheritedFrom }
  }
}

/** A.4 — Apply the legacy-column synthesis layer for one Product.
 *  Lowest-precedence layer for that entity; later JSONB layers from
 *  the same entity overwrite it, and a higher-precedence entity
 *  (variant > parent, channel > variant) overwrites it. inheritedFrom
 *  carries "<productId>:<columnName>" so the UI can link back to the
 *  exact field, not just the entity. */
function applySynthesisLayer(
  acc: ResolvedAttributes,
  source: ProductLike,
): void {
  for (const { resolverKey, column } of SYNTHESIS_MAP) {
    const value = (source as unknown as Record<string, unknown>)[column as string]
    if (value === undefined || value === null) continue
    // Empty arrays count as "no data" for synthesis — they'd otherwise
    // mask a real bulletPoints write further up the merge stack.
    if (Array.isArray(value) && value.length === 0) continue
    acc[resolverKey] = {
      value,
      source: 'masterColumn',
      inheritedFrom: `${source.id}:${column as string}`,
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve all attributes for the given (product, variant?, channel?,
 * locale?) tuple.
 *
 * Returns a flat map of attribute-key → {value, source, inheritedFrom}.
 * Keys that aren't set anywhere don't appear in the result; the caller
 * decides whether absence means "not applicable" or "use schema default".
 */
export function resolveAttributes(input: ResolveInput): ResolvedAttributes {
  const {
    product,
    parent,
    channelListing,
    locale = DEFAULT_LOCALE,
    synthesize = true,
  } = input
  const acc: ResolvedAttributes = {}

  // A.4 — Synthesis fires only for the default locale ('en'). Non-en
  // queries that lack their per-locale slot should surface as "missing
  // translation" in the UI, not as English text mislabeled.
  const doSynthesize = synthesize && locale === DEFAULT_LOCALE

  // Layers 1-3 only apply when there's a parent (i.e. resolving a
  // variant child). Top-level products skip straight to layer 4.
  if (parent) {
    // 0. Parent legacy-column synthesis (lowest precedence; any JSONB
    //    layer for the same key in parent or variant overrides it).
    if (doSynthesize) applySynthesisLayer(acc, parent)
    // 1. Parent categoryAttributes
    applyLayer(acc, parent.categoryAttributes, 'master', parent.id)
    // 2. Parent localizedContent[locale]
    applyLayer(acc, parent.localizedContent?.[locale], 'masterLocale', parent.id)
    // 3. Parent localizedContent['en'] (fallback when requested locale
    //    didn't supply this key — applyLayer only writes if key absent
    //    from layer, so we use a *missing-keys-only* merge here).
    if (locale !== DEFAULT_LOCALE) {
      applyLayerFallback(acc, parent.localizedContent?.[DEFAULT_LOCALE], 'masterLocale', parent.id)
    }
  }

  // 4. Variant (or top-level product) own values. Variant-column
  //    synthesis goes first as the lowest-precedence layer FOR THIS
  //    entity — but it still beats every parent layer above, matching
  //    "variant overrides master" semantics.
  if (doSynthesize) applySynthesisLayer(acc, product)
  applyLayer(acc, product.variantAttributes, 'variant', product.id)
  applyLayer(acc, product.categoryAttributes, parent ? 'variant' : 'master', product.id)
  applyLayer(acc, product.localizedContent?.[locale], parent ? 'variantLocale' : 'masterLocale', product.id)
  if (locale !== DEFAULT_LOCALE) {
    applyLayerFallback(acc, product.localizedContent?.[DEFAULT_LOCALE], parent ? 'variantLocale' : 'masterLocale', product.id)
  }

  // 5. Channel-level JSONB bag
  if (channelListing) {
    applyLayer(acc, channelListing.overrideData, 'channelOverride', channelListing.id)

    // 6. Explicit *Override columns. SSOT pattern: follow flag controls
    //    whether the override wins or the master value wins.
    for (const ssot of SSOT_FIELDS) {
      // Default behavior when followFlag isn't set on the row: TRUE
      // (follow master). Mirrors the schema default.
      const follows = (channelListing as unknown as Record<string, unknown>)[ssot.followFlag]
      const followsMaster = follows === undefined ? true : Boolean(follows)
      if (followsMaster) continue

      // Operator broke inheritance: use the override column. Prefer
      // *Override; fall back to the legacy direct column if the
      // *Override field isn't present (covers older rows that never
      // got migrated to the Phase 20 SSOT split).
      const overrideValue = (channelListing as unknown as Record<string, unknown>)[ssot.overrideCol]
      const directValue = ssot.directCol
        ? (channelListing as unknown as Record<string, unknown>)[ssot.directCol]
        : undefined
      const winning = overrideValue !== undefined && overrideValue !== null
        ? overrideValue
        : directValue
      if (winning === undefined) continue
      acc[ssot.key] = { value: winning, source: 'channelExplicit', inheritedFrom: channelListing.id }
    }
  }

  return acc
}

/** Like applyLayer, but only writes keys that aren't already in the
 *  accumulator. Used for locale fallback (en fills gaps that the
 *  requested locale didn't provide). */
function applyLayerFallback(
  acc: ResolvedAttributes,
  layer: Record<string, unknown> | null | undefined,
  source: ValueSource,
  inheritedFrom: string | null,
): void {
  if (!layer || typeof layer !== 'object') return
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue
    if (key in acc) continue
    acc[key] = { value, source, inheritedFrom }
  }
}

/** Convenience wrapper: resolve and return a flat key→value map,
 *  discarding provenance. Use this in publish pipelines / payload
 *  generators where you only need the merged data. */
export function resolveAttributesFlat(input: ResolveInput): Record<string, unknown> {
  const resolved = resolveAttributes(input)
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolved)) {
    flat[k] = v.value
  }
  return flat
}

/** Convenience: return only the keys whose source matches one of the
 *  given origins. Useful for "show me only what this channel overrides". */
export function resolveAttributesBySource(
  input: ResolveInput,
  sources: ValueSource[],
): ResolvedAttributes {
  const resolved = resolveAttributes(input)
  const out: ResolvedAttributes = {}
  const allow = new Set(sources)
  for (const [k, v] of Object.entries(resolved)) {
    if (allow.has(v.source)) out[k] = v
  }
  return out
}
