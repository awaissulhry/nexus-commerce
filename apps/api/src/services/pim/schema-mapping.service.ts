/**
 * PIM A.3 — Marketplace schema-mapping service.
 *
 * Reads + writes Marketplace.schemaMapping JSONB. This is the
 * substrate the Phase D mapping canvas builds on:
 *   - D.1 fetches the live API schema (SP-API getDefinitionsProductType,
 *     eBay GetCategorySpecifics, Shopify metafield schema) and seeds
 *     mapping entries via upsertFieldMapping().
 *   - D.2 surfaces a drag-drop UI on top of getMapping / setMapping.
 *   - D.5 hooks payload generators into resolveFieldMapping() at
 *     publish time.
 *
 * A.3 ships only the typed substrate — no payload generation, no
 * live schema fetch, no UI. Validates input shape on write so the
 * column can't drift into invalid states.
 */

import prisma from '../../db.js'

// ────────────────────────────────────────────────────────────────────
// Schema (locked)
// ────────────────────────────────────────────────────────────────────

/** Operations a transform can apply to a source value before it lands
 *  in the external payload, composed left→right. The string ops (A.3) are
 *  pure; FM.3 adds value/format ops. valueMap + sizeScale resolve through
 *  the FM.4 lookup context; `translate` is a deferred MARKER — it never
 *  mutates the value inline, it flags the field so the FM.5 executor fills
 *  the AI translation. */
export type TransformOp =
  | { type: 'truncate'; max: number }
  | { type: 'titleCase' }
  | { type: 'lowerCase' }
  | { type: 'upperCase' }
  | { type: 'prepend'; value: string }
  | { type: 'append'; value: string }
  | { type: 'replace'; pattern: string; replacement: string }
  | { type: 'default'; value: unknown }
  // ── FM.3: data-backed + format ops ──────────────────────────────────
  /** Map a canonical value → channel/market value via FM.4's
   *  FieldValueMap (e.g. "Rosso" → "Red"). onMiss: keep (default) | null
   *  | flag. No-op + warning until the FM.4 lookup context is wired. */
  | { type: 'valueMap'; attribute: string; onMiss?: 'keep' | 'null' | 'flag' }
  /** Convert a size across systems via FM.4's SizeScaleMap (e.g. EU 52 →
   *  UK "L"). onMiss: keep (default) | null | flag. */
  | { type: 'sizeScale'; scale: string; from: string; to: string; onMiss?: 'keep' | 'null' | 'flag' }
  /** Pure unit conversion — weight (kg/g/lb/oz) or length (mm/cm/m/in/ft). */
  | { type: 'unit'; from: string; to: string }
  /** Format a number with locale separators (e.g. 5.5 → "5,5"). */
  | { type: 'numberFormat'; decimals?: number; decimalSep?: string; thousandsSep?: string }
  /** Interpolate {{attr}} placeholders from the resolved attributes
   *  (e.g. "{{brand}} {{name}}"). */
  | { type: 'template'; expr: string }
  /** Enforce the channel field's max length — op.max, else the manifest
   *  maxLength from context. mode: truncate (default) | flag. */
  | { type: 'channelLimit'; max?: number; mode?: 'truncate' | 'flag' }
  /** MARKER — flag this field for AI translation to the target market
   *  language. Never mutates the value here (FM.5 executor fills it). */
  | { type: 'translate' }

/** Mapping rule for a single field on this marketplace's external
 *  schema (e.g., Amazon's `bullet_point_1`). */
export interface FieldMappingRule {
  /** Dotted path into the resolved PIM attributes. May use `{locale}`
   *  as a placeholder substituted at resolve time. */
  source: string
  /** Fallback path used when the primary source resolves to
   *  null/undefined. Optional. */
  fallback?: string
  /** Ordered list of transforms applied to the source value. Empty/
   *  omitted = no transform. */
  transforms?: TransformOp[]
  /** When true, payload generation MUST find a non-null value here or
   *  the publish is rejected. */
  required?: boolean
  /** Free-form note shown in the mapping canvas (why this rule exists,
   *  who authored it, related ticket, etc.). */
  notes?: string
}

/** Top-level shape of Marketplace.schemaMapping. */
export interface MarketplaceSchemaMapping {
  version: number
  /** Type-agnostic DEFAULT rules, keyed by external-schema field name
   *  (Amazon: 'bullet_point_1', eBay: 'ItemSpecifics.Brand', Shopify:
   *  'metafields.material'). Applies to every productType unless a more
   *  specific byProductType overlay redefines the same field key. */
  fields: Record<string, FieldMappingRule>
  /** FM.1 — per-productType rule overlays. Keyed by Amazon productType /
   *  eBay category key, then by external-schema field name. A rule here
   *  OVERRIDES the same field in `fields` for that productType only
   *  (resolved via getRulesFor / getResolvedRules). Optional in the type
   *  so legacy rows (pre-FM.1) type-check; emptyMapping()/parseMapping()
   *  always normalize it to a present object at runtime. */
  byProductType?: Record<string, Record<string, FieldMappingRule>>
  /** ISO timestamp of the last D.1 live-schema sync against this
   *  marketplace, or null when never synced. */
  lastSyncedAt: string | null
  /** Opaque snapshot id from the upstream API (e.g., SP-API schema
   *  version) so we know when the operator's mapping is stale. */
  schemaSnapshotVersion: string | null
}

/** Canonical empty mapping. Use whenever a Marketplace row has the
 *  column default '{}' — never hand out the raw empty object. */
export function emptyMapping(): MarketplaceSchemaMapping {
  return {
    version: 1,
    fields: {},
    byProductType: {},
    lastSyncedAt: null,
    schemaSnapshotVersion: null,
  }
}

// ────────────────────────────────────────────────────────────────────
// Runtime validation
// ────────────────────────────────────────────────────────────────────

const VALID_TRANSFORM_TYPES = new Set([
  'truncate',
  'titleCase',
  'lowerCase',
  'upperCase',
  'prepend',
  'append',
  'replace',
  'default',
  // FM.3
  'valueMap',
  'sizeScale',
  'unit',
  'numberFormat',
  'template',
  'channelLimit',
  'translate',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a raw value against the mapping shape. Returns an array of
 *  human-readable errors; empty array = valid. Caller decides whether
 *  to throw, log, or surface to a user. */
export function validateMapping(input: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(input)) {
    return ['mapping must be an object']
  }

  // version: number
  if (typeof input.version !== 'number') {
    errors.push('mapping.version must be a number')
  }

  // fields: object
  if (!isPlainObject(input.fields)) {
    errors.push('mapping.fields must be an object')
  } else {
    for (const [fieldKey, rule] of Object.entries(input.fields)) {
      errors.push(...validateFieldRule(fieldKey, rule))
    }
  }

  // byProductType: optional per-type overlay (FM.1). Validate only when
  // present so legacy rows without it stay valid.
  if (input.byProductType !== undefined) {
    if (!isPlainObject(input.byProductType)) {
      errors.push('mapping.byProductType must be an object')
    } else {
      for (const [productType, bucket] of Object.entries(input.byProductType)) {
        if (!isPlainObject(bucket)) {
          errors.push(`mapping.byProductType.${productType} must be an object`)
          continue
        }
        for (const [fieldKey, rule] of Object.entries(bucket)) {
          errors.push(...validateRuleShape(rule, `byProductType.${productType}.${fieldKey}`))
        }
      }
    }
  }

  // lastSyncedAt: string | null
  if (input.lastSyncedAt !== null && typeof input.lastSyncedAt !== 'string') {
    errors.push('mapping.lastSyncedAt must be string or null')
  }

  // schemaSnapshotVersion: string | null
  if (input.schemaSnapshotVersion !== null && typeof input.schemaSnapshotVersion !== 'string') {
    errors.push('mapping.schemaSnapshotVersion must be string or null')
  }

  return errors
}

/** Validate one field-rule entry. Returned errors are prefixed with the
 *  field key so the caller can locate them. */
export function validateFieldRule(fieldKey: string, rule: unknown): string[] {
  return validateRuleShape(rule, `fields.${fieldKey}`)
}

/** Validate one field-rule entry under a caller-supplied path prefix
 *  (e.g. `fields.title` or `byProductType.OUTERWEAR.material`) so error
 *  messages locate the rule regardless of which bucket it lives in. */
function validateRuleShape(rule: unknown, prefix: string): string[] {
  const errors: string[] = []

  if (!isPlainObject(rule)) {
    return [`${prefix} must be an object`]
  }

  if (typeof rule.source !== 'string' || rule.source.length === 0) {
    errors.push(`${prefix}.source must be a non-empty string`)
  }
  if (rule.fallback !== undefined && typeof rule.fallback !== 'string') {
    errors.push(`${prefix}.fallback must be a string when present`)
  }
  if (rule.required !== undefined && typeof rule.required !== 'boolean') {
    errors.push(`${prefix}.required must be boolean when present`)
  }
  if (rule.notes !== undefined && typeof rule.notes !== 'string') {
    errors.push(`${prefix}.notes must be a string when present`)
  }
  if (rule.transforms !== undefined) {
    if (!Array.isArray(rule.transforms)) {
      errors.push(`${prefix}.transforms must be an array when present`)
    } else {
      rule.transforms.forEach((t, i) => {
        const tp = `${prefix}.transforms[${i}]`
        if (!isPlainObject(t) || typeof t.type !== 'string' || !VALID_TRANSFORM_TYPES.has(t.type)) {
          errors.push(`${tp} has invalid type`)
          return
        }
        // FM.3 — required fields for the data-backed / format ops. The
        // A.3 string ops stay permissive (matches prior behaviour).
        const tt = t as Record<string, unknown>
        const needStr = (k: string) => {
          if (typeof tt[k] !== 'string' || (tt[k] as string).length === 0) {
            errors.push(`${tp}.${k} must be a non-empty string`)
          }
        }
        switch (t.type) {
          case 'valueMap':
            needStr('attribute')
            break
          case 'sizeScale':
            needStr('scale')
            needStr('from')
            needStr('to')
            break
          case 'unit':
            needStr('from')
            needStr('to')
            break
          case 'template':
            needStr('expr')
            break
        }
      })
    }
  }

  return errors
}

/** Parse a raw JSONB value into a typed mapping. Returns the empty
 *  mapping when input is missing/invalid (callers downstream don't
 *  need to null-check). Pair with validateMapping() before writes. */
export function parseMapping(raw: unknown): MarketplaceSchemaMapping {
  if (!isPlainObject(raw)) return emptyMapping()
  const errors = validateMapping(raw)
  if (errors.length > 0) return emptyMapping()
  const m = raw as unknown as MarketplaceSchemaMapping
  // FM.1 — normalize the optional overlay so every downstream caller can
  // rely on mapping.byProductType being a present object.
  return {
    ...m,
    byProductType: isPlainObject(m.byProductType) ? m.byProductType : {},
  }
}

// ────────────────────────────────────────────────────────────────────
// Rule resolution (FM.1)
// ────────────────────────────────────────────────────────────────────

/** Resolve the effective rule set for a productType: the type-agnostic
 *  default bucket (`fields`) overlaid with the productType-specific
 *  bucket (more specific wins per field key). Passing no productType — or
 *  one with no overlay — returns just the defaults, i.e. the pre-FM.1
 *  behaviour. Pure: operates on an already-loaded mapping. */
export function getRulesFor(
  mapping: MarketplaceSchemaMapping,
  productType?: string | null,
): Record<string, FieldMappingRule> {
  const base = mapping.fields ?? {}
  const overlay = productType ? mapping.byProductType?.[productType] : undefined
  return overlay ? { ...base, ...overlay } : { ...base }
}

// ────────────────────────────────────────────────────────────────────
// DB accessors
// ────────────────────────────────────────────────────────────────────

/** Custom error so callers can distinguish "marketplace not found"
 *  from generic DB failures. */
export class MarketplaceNotFoundError extends Error {
  constructor(channel: string, code: string) {
    super(`Marketplace not found: channel=${channel} code=${code}`)
    this.name = 'MarketplaceNotFoundError'
  }
}

/** Custom error thrown when a write would produce an invalid shape. */
export class InvalidMappingError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`Invalid mapping: ${errors.join('; ')}`)
    this.name = 'InvalidMappingError'
    this.errors = errors
  }
}

/** Read + parse the mapping for one marketplace. Returns the empty
 *  mapping if the column holds the default '{}' or invalid data. */
export async function getMappingForMarketplace(
  channel: string,
  code: string,
): Promise<MarketplaceSchemaMapping> {
  const row = await prisma.marketplace.findUnique({
    where: { channel_code: { channel, code } },
    select: { schemaMapping: true },
  })
  if (!row) throw new MarketplaceNotFoundError(channel, code)
  return parseMapping(row.schemaMapping)
}

/** DB convenience: load a marketplace's mapping and resolve the effective
 *  rule set for a productType (default bucket overlaid with the type
 *  overlay). This is the accessor publish / preview / cascade / sync
 *  should use so productType specificity is honoured everywhere. */
export async function getResolvedRules(
  channel: string,
  code: string,
  productType?: string | null,
): Promise<Record<string, FieldMappingRule>> {
  const mapping = await getMappingForMarketplace(channel, code)
  return getRulesFor(mapping, productType)
}

/** Read a single field's effective rule for an optional productType.
 *  Returns null when the field isn't mapped in either the type overlay
 *  or the default bucket. */
export async function getFieldMapping(
  channel: string,
  code: string,
  fieldKey: string,
  productType?: string | null,
): Promise<FieldMappingRule | null> {
  const rules = await getResolvedRules(channel, code, productType)
  return rules[fieldKey] ?? null
}

/** Upsert one field's rule, preserving every other field already in
 *  the mapping. Throws InvalidMappingError if the rule fails
 *  validation. Atomic on the single row. */
export async function upsertFieldMapping(
  channel: string,
  code: string,
  fieldKey: string,
  rule: FieldMappingRule,
  productType?: string | null,
): Promise<MarketplaceSchemaMapping> {
  const ruleErrors = validateFieldRule(fieldKey, rule)
  if (ruleErrors.length > 0) throw new InvalidMappingError(ruleErrors)

  const current = await getMappingForMarketplace(channel, code)
  let next: MarketplaceSchemaMapping
  if (productType) {
    // FM.1 — write into the per-productType overlay, preserving the
    // default bucket and every other type's overlay.
    const byProductType = current.byProductType ?? {}
    const bucket = { ...(byProductType[productType] ?? {}), [fieldKey]: rule }
    next = { ...current, byProductType: { ...byProductType, [productType]: bucket } }
  } else {
    next = { ...current, fields: { ...current.fields, [fieldKey]: rule } }
  }

  await prisma.marketplace.update({
    where: { channel_code: { channel, code } },
    data: { schemaMapping: next as unknown as object },
  })
  return next
}

/** Remove one field's mapping rule. No-op if the field wasn't mapped.
 *  Returns the post-removal mapping. */
export async function removeFieldMapping(
  channel: string,
  code: string,
  fieldKey: string,
  productType?: string | null,
): Promise<MarketplaceSchemaMapping> {
  const current = await getMappingForMarketplace(channel, code)

  let next: MarketplaceSchemaMapping
  if (productType) {
    const byProductType = current.byProductType ?? {}
    const bucket = byProductType[productType]
    if (!bucket || !(fieldKey in bucket)) return current
    const nextBucket = { ...bucket }
    delete nextBucket[fieldKey]
    const nextByProductType = { ...byProductType }
    if (Object.keys(nextBucket).length === 0) {
      // Drop the overlay key entirely when its last rule is removed so
      // empty buckets don't accumulate in the column.
      delete nextByProductType[productType]
    } else {
      nextByProductType[productType] = nextBucket
    }
    next = { ...current, byProductType: nextByProductType }
  } else {
    if (!(fieldKey in current.fields)) return current
    const nextFields = { ...current.fields }
    delete nextFields[fieldKey]
    next = { ...current, fields: nextFields }
  }

  await prisma.marketplace.update({
    where: { channel_code: { channel, code } },
    data: { schemaMapping: next as unknown as object },
  })
  return next
}

/** Update the sync metadata after a D.1 live-schema fetch. Doesn't
 *  alter `fields` — only the metadata that operators can use to spot
 *  stale mappings. */
export async function recordSchemaSync(
  channel: string,
  code: string,
  snapshotVersion: string,
): Promise<MarketplaceSchemaMapping> {
  const current = await getMappingForMarketplace(channel, code)
  const next: MarketplaceSchemaMapping = {
    ...current,
    lastSyncedAt: new Date().toISOString(),
    schemaSnapshotVersion: snapshotVersion,
  }
  await prisma.marketplace.update({
    where: { channel_code: { channel, code } },
    data: { schemaMapping: next as unknown as object },
  })
  return next
}
