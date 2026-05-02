/**
 * Convert a cached Amazon JSON Schema (the body of a CategorySchema
 * row's `schemaDefinition`) into FieldDefinition[] entries the bulk
 * grid can render.
 *
 * Amazon wraps every field in an array-of-objects for marketplace +
 * language facets, e.g.:
 *
 *   "size": {
 *     "type": "array",
 *     "items": {
 *       "type": "object",
 *       "properties": {
 *         "value":         { "type": "string", "title": "Size" },
 *         "language_tag":  { "$ref": "#/$defs/language_tag" },
 *         "marketplace_id":{ "$ref": "#/$defs/marketplace_id" }
 *       },
 *       "required": ["language_tag", "value"]
 *     }
 *   }
 *
 * For the v1 dynamic registry we flat-map the SIMPLE patterns:
 *   - inner `value` is a string with no enum   → text
 *   - inner `value` is a string with an enum   → select
 *   - inner `value` is number/integer          → number
 *
 * Fields with multiple required object props (e.g. `item_weight` which
 * needs both `value` AND `unit`), nested classification trees (e.g.
 * `ghs`, `battery`), or anything outside the array-wrapped pattern get
 * skipped — they need a richer per-field editor that's out of scope
 * for the bulk grid.
 */

import type { FieldDefinition } from './field-registry.service.js'

export interface SchemaToFieldsInput {
  productType: string
  /** The full JSON Schema body — exactly what we cached on the
   *  CategorySchema.schemaDefinition column. */
  schemaDefinition: unknown
}

export function schemaToFieldDefinitions(
  input: SchemaToFieldsInput,
): FieldDefinition[] {
  const root = input.schemaDefinition as any
  if (!root || typeof root !== 'object') return []

  const properties = (root.properties ?? {}) as Record<string, any>
  const requiredAtRoot = new Set<string>(
    Array.isArray(root.required) ? root.required : [],
  )

  const out: FieldDefinition[] = []

  for (const [name, fieldSchema] of Object.entries(properties)) {
    const flat = flattenAmazonField(name, fieldSchema)
    if (!flat) continue
    out.push({
      id: `attr_${name}`,
      label: flat.label,
      type: flat.type,
      category: 'category',
      productTypes: [input.productType],
      options: flat.options,
      width: defaultWidthForType(flat.type),
      editable: flat.editable,
      required: requiredAtRoot.has(name),
      helpText: flat.helpText,
    })
  }

  return out
}

interface FlatField {
  label: string
  type: 'text' | 'number' | 'select'
  options?: string[]
  editable: boolean
  helpText?: string
}

function flattenAmazonField(name: string, schema: any): FlatField | null {
  if (!schema || typeof schema !== 'object') return null

  // Pattern: top-level wrapper is array; items is object with `value`
  // as the only required property worth editing.
  if (schema.type !== 'array') return null
  const items = schema.items
  if (!items || items.type !== 'object') return null
  const inner = items.properties as Record<string, any> | undefined
  if (!inner || !inner.value) return null

  const innerRequired: string[] = Array.isArray(items.required)
    ? items.required
    : []

  // Fields that need more than `value` to round-trip — like `item_weight`
  // which needs `unit` — don't fit a single editable cell. Skip them.
  // We allow `language_tag` and `marketplace_id` in required because
  // those are facet selectors we resolve from the active marketplace
  // context, not values the user types.
  const SELECTOR_REQUIRED = new Set(['language_tag', 'marketplace_id', 'value'])
  for (const r of innerRequired) {
    if (!SELECTOR_REQUIRED.has(r)) return null
  }

  const valueSchema = inner.value
  const editable = valueSchema.editable !== false
  const helpText =
    valueSchema.description ?? schema.description ?? undefined
  const label = valueSchema.title ?? schema.title ?? humanize(name)

  if (Array.isArray(valueSchema.enum)) {
    const enumNames = Array.isArray(valueSchema.enumNames)
      ? valueSchema.enumNames
      : null
    // Display the human-readable label when present, but keep the raw
    // enum value on the wire so the backend stores Amazon's expected
    // identifier.
    const options = enumNames
      ? valueSchema.enum.map(
          (v: string, i: number) => enumNames[i] ?? String(v),
        )
      : valueSchema.enum.map((v: unknown) => String(v))
    return {
      label,
      type: 'select',
      options,
      editable,
      helpText,
    }
  }

  const t = valueSchema.type
  if (t === 'number' || t === 'integer') {
    return { label, type: 'number', editable, helpText }
  }
  if (t === 'string') {
    return { label, type: 'text', editable, helpText }
  }
  // Object/array values — out of scope for v1.
  return null
}

function humanize(snake: string): string {
  return snake
    .split('_')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(' ')
}

function defaultWidthForType(t: 'text' | 'number' | 'select'): number {
  if (t === 'number') return 100
  if (t === 'select') return 130
  return 160
}
