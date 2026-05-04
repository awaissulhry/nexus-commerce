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
   *  optional. Empty in v1 — we only union required fields for now;
   *  Phase F+ may surface a curated optional set. */
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
  }): Promise<FieldManifest> {
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

    const fields: RenderableField[] = []
    for (const fieldId of required) {
      const prop = properties[fieldId]
      if (!prop) continue
      const f = parseProperty(fieldId, prop)
      f.defaultValue = smartDefault(fieldId, opts.product) ?? f.defaultValue
      fields.push(f)
    }

    return {
      channel: 'AMAZON',
      marketplace: opts.marketplace,
      productType: opts.productType,
      schemaVersion: cached.schemaVersion,
      fetchedAt: cached.fetchedAt.toISOString(),
      fields,
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
        })
        perChannel.push({
          channelKey,
          productType,
          fields: manifest.fields,
          schemaVersion: manifest.schemaVersion,
          fetchedAt: manifest.fetchedAt,
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
            requiredFor: [pc.channelKey],
            optionalFor: [],
            notUsedIn: [],
            currentValue:
              baseRaw === undefined || baseRaw === null
                ? undefined
                : (baseRaw as string | number | boolean),
            overrides,
          })
        } else {
          existing.requiredFor.push(pc.channelKey)
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
      channelsMissingSchema: missing,
    }
  }
}

// ── parser ──────────────────────────────────────────────────────

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
