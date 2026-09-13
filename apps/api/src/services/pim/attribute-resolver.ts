/** Factual attributes keep the parent/variant/channel cascade.
 * Localizable content is overlaid once by resolveContent (pin → language → source → computed).
 * The legacy Product JSON and outbound attribute bags never supply content values.
 */

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/** Origin of a resolved value. UI uses this to style inheritance. */
import { ALLOWED_MASTER_FIELDS } from './master-field-gate.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'
import { resolveContentAttributes } from './content-read.js'
import type { Coordinate, ResolvedContent } from './content-resolver.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

export type ValueSource =
  | 'master'           // came from parent Product.categoryAttributes
  | 'masterLocale'     // shared ProductTranslation row
  | 'masterColumn'     // synthesized from a legacy Product column (A.4 compat layer)
  | 'variant'          // came from variant child Product
  | 'variantLocale'    // variant ProductTranslation row
  | 'channelOverride'  // came from ChannelListing.overrideData
  | 'channelSnapshot' // a following legacy listing value; drift, never an operator pin
  | 'channelExplicit'  // came from titleOverride / priceOverride / etc.
  | 'default'          // none of the above set a value

/** Per-key resolution result. */
export interface ResolvedValue<T = unknown> {
  content?: ResolvedContent
  value: T | null
  source: ValueSource
  /** The Product/ChannelListing id this value came from. Null when
   *  source is 'default'. Used by error→editor deep linking to route
   *  the operator to the right entity. */
  inheritedFrom: string | null
  language?: string
  requested?: string
  tier?: ResolvedContent['tier']
  follows?: boolean
  drift?: boolean
  contentProvenance?: ResolvedContent['provenance']
  warnings?: string[]
  requestedLocale?: string
  effectiveLocale?: string
  translationState?: 'current' | 'fallback' | 'draft' | 'reviewed' | 'outdated' | 'missing'
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
  translations?: Array<Record<string, unknown>>
  name?: string | null
  description?: string | null
  bulletPoints?: string[]
  keywords?: string[]
  brand?: string | null
  manufacturer?: string | null
  countryOfOrigin?: string | null
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
  coordinate?: Coordinate
  marketLanguages?: readonly string[]
  localizableKeys?: string[]
  /** The product (or variant child Product) being resolved. */
  product: ProductLike
  /** Optional parent — required when product.parentId is set, ignored
   *  otherwise. Pass null for top-level products. */
  parent: ProductLike | null
  /** Optional channel listing (channel × marketplace). When omitted,
   *  resolution stops at variant level. */
  channelListing?: ChannelListingLike | null
  /** Requested language; defaults to PRIMARY_CONTENT_LOCALE. */
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
  locale?: string,
): void {
  if (!layer || typeof layer !== 'object') return
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue
    if (locale && key.startsWith('_')) continue
    acc[key] = { value, source, inheritedFrom, ...(locale ? { requestedLocale: locale, effectiveLocale: locale, translationState: 'current' as const } : {}) }
  }
}

/** Legacy variation labels remain addressable while supplying the canonical Master axes.
 * An explicit canonical value wins. Conflicting aliases never choose a value by key order. */
function applyVariantLayer(acc: ResolvedAttributes, product: ProductLike): void {
  const variations = product.categoryAttributes?.variations
  const bag = { ...(product.variantAttributes && typeof product.variantAttributes === 'object' ? product.variantAttributes : {}),
    ...(variations && typeof variations === 'object' && !Array.isArray(variations) ? variations : {}) }
  applyLayer(acc, bag, 'variant', product.id)
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return
  // Legacy "Body Type" is not a stable identity: imports also use it for gender.
  for (const axis of ['color', 'size', 'style']) {
    if (Object.prototype.hasOwnProperty.call(bag, axis) && bag[axis] !== undefined) continue
    const matches = Object.entries(bag).filter(([key, value]) => canonicalVariantAxis(key) === axis && value !== undefined)
    if (!matches.length) continue
    const conflict = new Set(matches.map(([, value]) => JSON.stringify(value))).size > 1
    acc[axis] = { value: conflict ? null : matches[0][1], source: 'variant', inheritedFrom: product.id,
      ...(conflict ? { warnings: [`Conflicting variant attributes supply ${axis}: ${matches.map(([key]) => key).join(', ')}. Set the canonical ${axis} attribute to resolve the conflict.`] } : {}) }
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
  locale: string,
): void {
  for (const { resolverKey, column } of SYNTHESIS_MAP) {
    const value = (source as unknown as Record<string, unknown>)[column as string]
    if (value === undefined || value === null || value === '') continue
    // Empty arrays count as "no data" for synthesis — they'd otherwise
    // mask a real bulletPoints write further up the merge stack.
    if (Array.isArray(value) && value.length === 0) continue
    acc[resolverKey] = {
      value,
      source: 'masterColumn',
      inheritedFrom: `${source.id}:${column as string}`,
      ...(['title', 'description', 'bulletPoints', 'keywords'].includes(resolverKey)
        ? { requestedLocale: locale, effectiveLocale: PRIMARY_CONTENT_LOCALE, translationState: locale === PRIMARY_CONTENT_LOCALE ? 'current' as const : 'fallback' as const } : {}),
    }
  }
}

/** Shared native facts have no content locale. Their canonical column wins over legacy aliases. */
function applyCanonicalFacts(acc: ResolvedAttributes, product: ProductLike): void {
  for (const key of ALLOWED_MASTER_FIELDS) {
    if (['description', 'bulletPoints', 'keywords'].includes(key)) continue
    let value = (product as unknown as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0) continue
    // Prisma decimal columns must remain numeric in in-process validation, before JSON serialization.
    if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') value = (value as { toNumber(): number }).toNumber()
    acc[key] = { value, source: 'masterColumn', inheritedFrom: product.id }
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
  const { product, parent, channelListing, synthesize = true } = input
  const locale = normalizeLanguage(input.locale ?? PRIMARY_CONTENT_LOCALE)
  const acc: ResolvedAttributes = {}
  // Language-independent facts retain their established parent/variant/override rules.
  for (const owner of [parent, product]) {
    if (!owner) continue
    if (synthesize) applySynthesisLayer(acc, owner, locale)
    if (owner === product) applyVariantLayer(acc, product)
    applyLayer(acc, owner.categoryAttributes, owner === product && parent ? 'variant' : 'master', owner.id)
    if (synthesize) applyCanonicalFacts(acc, owner)
    if (owner.countryOfOrigin) applyLayer(acc, { countryOfOrigin: owner.countryOfOrigin, country_of_origin: owner.countryOfOrigin }, 'masterColumn', owner.id)
  }
  if (synthesize) {
    const origin = acc.countryOfOrigin ?? acc.country_of_origin
    if (origin) { acc.countryOfOrigin = origin; acc.country_of_origin = origin }
  }
  if (channelListing) {
    applyLayer(acc, channelListing.overrideData, 'channelOverride', channelListing.id)
    for (const ssot of SSOT_FIELDS.filter(field => ['price', 'quantity'].includes(field.key))) {
      if ((channelListing as any)[ssot.followFlag] !== false) continue
      const value = (channelListing as any)[ssot.overrideCol] ?? (ssot.directCol ? (channelListing as any)[ssot.directCol] : undefined)
      if (value !== undefined) acc[ssot.key] = { value, source: 'channelExplicit', inheritedFrom: channelListing.id }
    }
  }
  // Text has exactly one cascade. It overwrites any historical untagged text aliases in fact bags.
  Object.assign(acc, resolveContentAttributes({ product, parent, listing: channelListing, coordinate: input.coordinate,
    languages: input.marketLanguages, requested: locale, localizableKeys: input.localizableKeys }))
  return acc
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
