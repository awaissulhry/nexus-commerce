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
