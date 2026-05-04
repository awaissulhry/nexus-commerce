/**
 * Step 4 — Required Attributes form-renderer backing service.
 *
 * Amazon's productTypeDefinitions schema is a full JSON Schema (50–
 * 500KB per productType) where each editable field follows a specific
 * "wrapped array" pattern:
 *
 *     properties.<field_id> = {
 *       type: "array",
 *       items: {
 *         type: "object",
 *         properties: {
 *           value: { type: "string", ... },
 *           marketplace_id: { ... },
 *           language_tag: { ... }      // sometimes
 *         },
 *         required: ["value", ...]
 *       }
 *     }
 *
 * The user-editable bit lives at `items.properties.value`; the
 * surrounding wrapper carries marketplace + language metadata that we
 * fill in automatically at save time.
 *
 * This parser walks the schema, picks out the required fields, flattens
 * each to a frontend-friendly `RenderableField` shape, and pre-fills a
 * smart default sourced from the master product where possible. The
 * frontend renders inputs from this manifest without ever touching the
 * raw schema.
 *
 * Anything we don't yet know how to render (deeply nested objects,
 * arrays of free-form objects) is returned with kind='unsupported' so
 * the UI can show a graceful placeholder rather than crash. v1 covers
 * 80–90% of typical Amazon required fields.
 */

import type { PrismaClient } from '@nexus/database'
import { CategorySchemaService } from '../categories/schema-sync.service.js'

export type FieldKind =
  | 'text'
  | 'longtext'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'unsupported'

export interface RenderableField {
  id: string
  label: string
  description?: string
  kind: FieldKind
  required: boolean
  /** Wrapped vs. flat — affects how the frontend writes the value
   *  back. The frontend doesn't need to construct the wrapper itself;
   *  it just sends a plain string/number and the wrapping is applied
   *  at submit time. We expose `wrapped` so the UI can display a
   *  "Marketplace IT" sub-label when appropriate. */
  wrapped: boolean
  /** Allowed values when kind === 'enum'. */
  options?: Array<{ value: string; label: string }>
  /** Hint sourced from the master product. The UI shows this as a
   *  pre-filled placeholder; the user can confirm or override. */
  defaultValue?: string | number | boolean
  /** Free-text examples from the schema, displayed as a hint below
   *  the input. */
  examples?: string[]
  /** Length constraints for string fields. */
  maxLength?: number
  minLength?: number
  /** Human reason this field couldn't be rendered. Populated when
   *  kind === 'unsupported'. */
  unsupportedReason?: string
}

export interface FieldManifest {
  channel: string
  marketplace: string
  productType: string
  schemaVersion: string
  fetchedAt: string
  fields: RenderableField[]
}

/**
 * Phase D — multi-channel union of a single field across every
 * selected (channel, marketplace) the wizard is targeting. The
 * frontend renders one row per `id` with chips showing where the
 * field is required vs optional vs absent, plus the base value
 * + per-channel overrides.
 */
export interface UnionField extends RenderableField {
  /** Channel keys ("PLATFORM:MARKET") where this field is required. */
  requiredFor: string[]
  /** Channel keys where this field appears in the schema but is
   *  optional. K.5 ships a curated common-optional list; the full
   *  optional set lives behind the "Show all fields" toggle. */
  optionalFor: string[]
  /** Channel keys where this field doesn't appear in the schema at
   *  all (e.g. an Amazon-required attribute on an eBay-only listing). */
  notUsedIn: string[]
  /** Current base value from wizardState.attributes. Already typed
   *  to the field's `kind`. */
  currentValue?: string | number | boolean
  /** Per-channel overrides keyed by channel key. Falsy values
   *  treated as "no override" — the base value applies. */
  overrides: Record<string, string | number | boolean>
  /** TRUE when the underlying schema metadata diverges across
   *  channels (different enum sets, different maxLength). Frontend
   *  surfaces this so the user knows the merged shape may not fit
   *  every channel verbatim. */
  divergent?: boolean
  /** K.4: TRUE when this field can hold per-variant values (size,
   *  color, dimensions, weight, gtin). FALSE for product-level-only
   *  fields like brand, manufacturer, item_name. The frontend uses
   *  this to decide whether to show the per-variant override grid. */
  variantEligible: boolean
}

export interface UnionManifest {
  channels: Array<{ platform: string; marketplace: string; productType: string }>
  schemaVersionByChannel: Record<string, string>
  fetchedAtByChannel: Record<string, string>
  fields: UnionField[]
  /** Channel keys we couldn't fetch a schema for (no productType set
   *  yet, or fetch failed). Surfaced so the UI can flag that the
   *  union is incomplete pending those channels. */
  channelsMissingSchema: Array<{
    channelKey: string
    reason: 'no_product_type' | 'fetch_failed' | 'unsupported_channel'
    detail?: string
  }>
  /** K.4: variation children for the master product (parents only).
   *  Lets the UI render per-variant override columns alongside the
   *  per-channel ones without a second fetch. Empty when the master
   *  is a single-product (no variations). */
  variations: Array<{
    id: string
    sku: string
    attributes: Record<string, string>
  }>
  /** K.5: total count of optional fields available across the
   *  selected channels. Lets the UI surface a "Show all (N more)"
   *  badge without having to fetch the full set. */
  optionalFieldCount: number
  /** K.5: TRUE when the manifest already contains the full optional
   *  surface — the UI hides the toggle in that case. */
  includesAllOptional: boolean
}

interface MasterProduct {
  name: string
  brand?: string | null
  description?: string | null
  productType?: string | null
}

const MAX_OPTIONS = 200 // cap enums so the response stays small

export class SchemaParserService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly schemas: CategorySchemaService,
  ) {}

  async getRequiredFields(opts: {
    channel: string
    marketplace: string
    productType: string
    product: MasterProduct
    /** K.5: when true, walks every field in `properties` (required +
     *  optional). Default false → only required fields. The
     *  optional-by-default surface still includes a curated common-
     *  optional set (item_name, manufacturer, etc.) regardless of
     *  this flag, so the wizard's defaults stay useful. */
    includeAllOptional?: boolean
  }): Promise<FieldManifest & { optionalFieldIds: string[] }> {
    const channel = opts.channel.toUpperCase()
    if (channel !== 'AMAZON') {
      throw new Error(
        `Required-fields parsing is only implemented for Amazon (got ${channel}).`,
      )
    }

    const cached = await this.schemas.getSchema({
      channel: 'AMAZON',
      marketplace: opts.marketplace,
      productType: opts.productType,
    })

    const def = (cached.schemaDefinition ?? {}) as Record<string, any>
    const properties = (def.properties ?? {}) as Record<string, any>
    const required = Array.isArray(def.required) ? (def.required as string[]) : []

    const requiredSet = new Set(required)
    const fields: RenderableField[] = []

    for (const fieldId of required) {
      const prop = properties[fieldId]
      if (!prop) continue
      const f = parseProperty(fieldId, prop)
      f.defaultValue = smartDefault(fieldId, opts.product) ?? f.defaultValue
      fields.push(f)
    }

    // Curated common-optional set — always surfaced because most
    // sellers want these even when Amazon doesn't enforce them.
    const COMMON_OPTIONAL = [
      'item_name',
      'brand',
      'manufacturer',
      'product_description',
      'bullet_point',
      'generic_keyword',
      'item_type_keyword',
      'target_audience_keyword',
      'country_of_origin',
      'manufacturer_part_number',
      'model_number',
      'item_weight',
      'item_dimensions',
      'package_dimensions',
      'package_weight',
    ]
    for (const fieldId of COMMON_OPTIONAL) {
      if (requiredSet.has(fieldId)) continue
      const prop = properties[fieldId]
      if (!prop) continue
      const f = parseProperty(fieldId, prop)
      f.required = false
      f.defaultValue = smartDefault(fieldId, opts.product) ?? f.defaultValue
      fields.push(f)
    }

    // The full optional list — only walked when includeAllOptional is
    // true, since productType schemas can have 200-400 fields and
    // shipping all of them in the default response is wasteful.
    if (opts.includeAllOptional) {
      const seen = new Set(fields.map((f) => f.id))
      for (const fieldId of Object.keys(properties)) {
        if (seen.has(fieldId)) continue
        const prop = properties[fieldId]
        const f = parseProperty(fieldId, prop)
        f.required = false
        fields.push(f)
      }
    }

    // optionalFieldIds — every field in `properties` minus the
    // required ones. The frontend uses this to surface a count for
    // the "Show all fields" toggle even when includeAllOptional is
    // false.
    const optionalFieldIds = Object.keys(properties).filter(
      (id) => !requiredSet.has(id),
    )

    return {
      channel: 'AMAZON',
      marketplace: opts.marketplace,
      productType: opts.productType,
      schemaVersion: cached.schemaVersion,
      fetchedAt: cached.fetchedAt.toISOString(),
      fields,
      optionalFieldIds,
    }
  }

  /**
   * Phase D — union the required-field manifest across every selected
   * (channel, marketplace) for the wizard. Only Amazon channels
   * contribute fields today (eBay is Phase 2A; Shopify/Woo don't have
   * a CategorySchema pipeline). Channels we can't fetch a schema for
   * are surfaced in `channelsMissingSchema` so the UI can flag them.
   */
  async getMultiChannelRequiredFields(opts: {
    channels: Array<{ platform: string; marketplace: string }>
    /** Per-channel productType. Map key is "PLATFORM:MARKET". Channels
     *  with no entry default to `fallbackProductType` if provided. */
    productTypeByChannel: Record<string, string | undefined>
    fallbackProductType?: string
    product: MasterProduct
    /** Base values from wizardState.attributes, used to populate
     *  `currentValue` per field. */
    baseAttributes: Record<string, unknown>
    /** Per-channel overrides: channelKey → fieldId → value. */
    overridesByChannel: Record<string, Record<string, unknown>>
    /** K.4 — productId for loading variation children. */
    productId: string
    /** K.5 — when true, walks every property in each channel's schema
     *  rather than just required + curated common-optional. */
    includeAllOptional?: boolean
  }): Promise<UnionManifest> {
    const channels = opts.channels.map((c) => ({
      ...c,
      platform: c.platform.toUpperCase(),
      marketplace: c.marketplace.toUpperCase(),
    }))

    // Per-channel schema fetch — we only know how to handle Amazon
    // for now. Build a list of (channelKey, parsed required-field
    // manifest) tuples for the union pass below.
    const perChannel: Array<{
      channelKey: string
      productType: string
      fields: RenderableField[]
      schemaVersion: string
      fetchedAt: string
      optionalFieldIds: string[]
    }> = []
    const missing: UnionManifest['channelsMissingSchema'] = []

    for (const c of channels) {
      const channelKey = `${c.platform}:${c.marketplace}`
      if (c.platform !== 'AMAZON') {
        missing.push({
          channelKey,
          reason: 'unsupported_channel',
          detail: `Schema for ${c.platform} not yet wired`,
        })
        continue
      }
      const productType =
        opts.productTypeByChannel[channelKey] ??
        opts.fallbackProductType ??
        ''
      if (!productType) {
        missing.push({ channelKey, reason: 'no_product_type' })
        continue
      }
      try {
        const manifest = await this.getRequiredFields({
          channel: 'AMAZON',
          marketplace: c.marketplace,
          productType,
          product: opts.product,
          includeAllOptional: opts.includeAllOptional,
        })
        perChannel.push({
          channelKey,
          productType,
          fields: manifest.fields,
          schemaVersion: manifest.schemaVersion,
          fetchedAt: manifest.fetchedAt,
          optionalFieldIds: manifest.optionalFieldIds,
        })
      } catch (err) {
        missing.push({
          channelKey,
          reason: 'fetch_failed',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Union pass: for each unique field id seen across channels,
    // collect requiredFor + notUsedIn membership and pick a canonical
    // metadata source (first channel where it appeared). Mark
    // divergence when the metadata differs.
    const byId = new Map<string, UnionField>()
    const allChannelKeys = channels.map(
      (c) => `${c.platform}:${c.marketplace}`,
    )

    for (const pc of perChannel) {
      for (const f of pc.fields) {
        const existing = byId.get(f.id)
        // RenderableField.required tells us whether THIS channel
        // required this field. The union categorises per-channel.
        const isRequiredHere = !!f.required
        if (!existing) {
          const baseRaw = opts.baseAttributes[f.id]
          const overrides: Record<string, string | number | boolean> = {}
          for (const [chKey, ovrSlice] of Object.entries(
            opts.overridesByChannel,
          )) {
            const v = ovrSlice?.[f.id]
            if (v !== undefined && v !== null) {
              overrides[chKey] = v as string | number | boolean
            }
          }
          byId.set(f.id, {
            ...f,
            required: isRequiredHere,
            requiredFor: isRequiredHere ? [pc.channelKey] : [],
            optionalFor: isRequiredHere ? [] : [pc.channelKey],
            notUsedIn: [],
            currentValue:
              baseRaw === undefined || baseRaw === null
                ? undefined
                : (baseRaw as string | number | boolean),
            overrides,
            variantEligible: isVariantEligible(f.id),
          })
        } else {
          if (isRequiredHere) {
            if (!existing.requiredFor.includes(pc.channelKey)) {
              existing.requiredFor.push(pc.channelKey)
            }
            // If this channel is required and the field was previously
            // listed as optional in the same channel's pass, drop the
            // optional entry.
            existing.optionalFor = existing.optionalFor.filter(
              (k) => k !== pc.channelKey,
            )
          } else if (!existing.requiredFor.includes(pc.channelKey)) {
            if (!existing.optionalFor.includes(pc.channelKey)) {
              existing.optionalFor.push(pc.channelKey)
            }
          }
          // Detect divergent metadata: enum sets, maxLength.
          if (!existing.divergent) {
            if (
              (f.maxLength ?? null) !== (existing.maxLength ?? null) ||
              (f.kind === 'enum' &&
                JSON.stringify(f.options) !==
                  JSON.stringify(existing.options))
            ) {
              existing.divergent = true
              // Keep the more-restrictive maxLength when divergent.
              if (
                typeof f.maxLength === 'number' &&
                (typeof existing.maxLength !== 'number' ||
                  f.maxLength < existing.maxLength)
              ) {
                existing.maxLength = f.maxLength
              }
            }
          }
        }
      }
    }

    // Compute notUsedIn = (all channels) − (requiredFor) − (perChannel
    // we couldn't fetch). Channels without a schema can't claim a
    // field is "not used"; they're just unknown.
    const fetchedKeys = new Set(perChannel.map((p) => p.channelKey))
    for (const field of byId.values()) {
      const requiredSet = new Set(field.requiredFor)
      field.notUsedIn = allChannelKeys.filter(
        (k) => fetchedKeys.has(k) && !requiredSet.has(k),
      )
    }

    const fieldsArr = Array.from(byId.values())

    // K.4 — load variation children once for the per-variant override
    // grid. Lower-cases attribute keys to match the way the variations
    // service surfaces them so the frontend's lookups line up.
    const variationRows = await this.prisma.productVariation.findMany({
      where: { productId: opts.productId },
      select: { id: true, sku: true, variationAttributes: true },
    })
    const variations = variationRows.map((v) => {
      const raw = (v.variationAttributes ?? {}) as Record<string, unknown>
      const attrs: Record<string, string> = {}
      for (const [k, val] of Object.entries(raw)) {
        if (typeof val === 'string') attrs[k.toLowerCase()] = val
        else if (typeof val === 'number' || typeof val === 'boolean')
          attrs[k.toLowerCase()] = String(val)
      }
      return { id: v.id, sku: v.sku, attributes: attrs }
    })

    return {
      channels: channels.map((c) => {
        const key = `${c.platform}:${c.marketplace}`
        return {
          platform: c.platform,
          marketplace: c.marketplace,
          productType:
            opts.productTypeByChannel[key] ?? opts.fallbackProductType ?? '',
        }
      }),
      schemaVersionByChannel: Object.fromEntries(
        perChannel.map((p) => [p.channelKey, p.schemaVersion]),
      ),
      fetchedAtByChannel: Object.fromEntries(
        perChannel.map((p) => [p.channelKey, p.fetchedAt]),
      ),
      fields: fieldsArr,
      variations,
      optionalFieldCount: (() => {
        const seen = new Set<string>()
        for (const pc of perChannel) {
          for (const id of pc.optionalFieldIds) seen.add(id)
        }
        return seen.size
      })(),
      includesAllOptional: !!opts.includeAllOptional,
      channelsMissingSchema: missing,
    }
  }
}

// ── parser ──────────────────────────────────────────────────────

/**
 * K.4 — fields that Amazon accepts at the variant level. The list
 * is curated rather than schema-derived because the schema doesn't
 * encode "varies by variant" cleanly across productTypes; this map
 * captures the common cases and matches what the variation themes
 * in product-types.constants.ts can drive.
 *
 * Anything not in this set is product-level: setting it once at the
 * parent fans out to every child via the variation_theme. Trying
 * to vary `brand` per variant on Amazon, for instance, would be
 * rejected.
 */
const VARIANT_ELIGIBLE_FIELDS = new Set([
  'size',
  'size_name',
  'apparel_size',
  'color',
  'color_name',
  'pattern_name',
  'style',
  'style_name',
  'material_type',
  'material',
  'fabric_type',
  'item_dimensions',
  'package_dimensions',
  'item_weight',
  'package_weight',
  'externally_assigned_product_identifier',
  'gtin',
  'upc',
  'ean',
  'merchant_suggested_asin',
  'list_price',
  'purchasable_offer',
])

function isVariantEligible(fieldId: string): boolean {
  const id = fieldId.toLowerCase()
  if (VARIANT_ELIGIBLE_FIELDS.has(id)) return true
  // Heuristic suffixes — many Amazon attributes use _value /
  // _unit / _type variants that vary alongside their parent (e.g.
  // size_value, color_value).
  for (const root of VARIANT_ELIGIBLE_FIELDS) {
    if (id.startsWith(root + '_')) return true
  }
  return false
}

function parseProperty(fieldId: string, prop: any): RenderableField {
  const label =
    pickString(prop?.title) ??
    humanise(fieldId)
  const description = pickString(prop?.description)
  const examples = Array.isArray(prop?.examples)
    ? prop.examples.filter((e: unknown) => typeof e === 'string').slice(0, 3)
    : undefined

  // Amazon's wrapped pattern: array → object → properties.value
  if (
    prop?.type === 'array' &&
    prop?.items?.type === 'object' &&
    prop?.items?.properties?.value
  ) {
    const valueProp = prop.items.properties.value
    const inner = parseLeaf(valueProp)
    return {
      id: fieldId,
      label,
      description,
      kind: inner.kind,
      required: true,
      wrapped: true,
      options: inner.options,
      examples,
      maxLength: inner.maxLength,
      minLength: inner.minLength,
      ...(inner.unsupportedReason
        ? { unsupportedReason: inner.unsupportedReason }
        : {}),
    }
  }

  // Plain leaf at the top level (rare in Amazon, common elsewhere).
  if (
    prop?.type === 'string' ||
    prop?.type === 'number' ||
    prop?.type === 'integer' ||
    prop?.type === 'boolean' ||
    Array.isArray(prop?.enum)
  ) {
    const inner = parseLeaf(prop)
    return {
      id: fieldId,
      label,
      description,
      kind: inner.kind,
      required: true,
      wrapped: false,
      options: inner.options,
      examples,
      maxLength: inner.maxLength,
      minLength: inner.minLength,
      ...(inner.unsupportedReason
        ? { unsupportedReason: inner.unsupportedReason }
        : {}),
    }
  }

  return {
    id: fieldId,
    label,
    description,
    kind: 'unsupported',
    required: true,
    wrapped: false,
    examples,
    unsupportedReason: 'Complex shape — not yet renderable',
  }
}

interface LeafParse {
  kind: FieldKind
  options?: Array<{ value: string; label: string }>
  maxLength?: number
  minLength?: number
  unsupportedReason?: string
}

function parseLeaf(prop: any): LeafParse {
  const enums: unknown[] | undefined = Array.isArray(prop?.enum)
    ? prop.enum
    : undefined
  if (enums && enums.length > 0) {
    const enumNames: string[] | undefined = Array.isArray(prop?.enumNames)
      ? prop.enumNames
      : undefined
    const options = enums.slice(0, MAX_OPTIONS).map((v, i) => ({
      value: String(v),
      label: enumNames?.[i] ?? String(v),
    }))
    return { kind: 'enum', options }
  }

  if (prop?.type === 'boolean') {
    return { kind: 'boolean' }
  }

  if (prop?.type === 'number' || prop?.type === 'integer') {
    return { kind: 'number' }
  }

  if (prop?.type === 'string') {
    const maxLength = typeof prop?.maxLength === 'number' ? prop.maxLength : undefined
    const minLength = typeof prop?.minLength === 'number' ? prop.minLength : undefined
    // Anything > 200 chars gets a textarea.
    const kind: FieldKind = maxLength && maxLength > 200 ? 'longtext' : 'text'
    return { kind, maxLength, minLength }
  }

  return {
    kind: 'unsupported',
    unsupportedReason: `Unknown leaf type: ${prop?.type ?? 'undefined'}`,
  }
}

// ── smart defaults from master product ──────────────────────────

function smartDefault(
  fieldId: string,
  product: MasterProduct,
): string | undefined {
  // Amazon field-id conventions are stable across productTypes.
  const id = fieldId.toLowerCase()
  if (id === 'item_name' || id === 'title' || id === 'product_title') {
    return product.name?.trim() || undefined
  }
  if (id === 'brand' || id === 'brand_name') {
    return product.brand?.trim() || undefined
  }
  if (id === 'manufacturer') {
    return product.brand?.trim() || undefined
  }
  if (id === 'product_description' || id === 'description') {
    return product.description?.trim() || undefined
  }
  return undefined
}

// ── helpers ─────────────────────────────────────────────────────

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function humanise(fieldId: string): string {
  return fieldId
    .split(/[_\s]+/)
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join(' ')
}
