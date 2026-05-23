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
 *  in the external payload. Extend in D.3; A.3 only fixes the shape. */
export type TransformOp =
  | { type: 'truncate'; max: number }
  | { type: 'titleCase' }
  | { type: 'lowerCase' }
  | { type: 'upperCase' }
  | { type: 'prepend'; value: string }
  | { type: 'append'; value: string }
  | { type: 'replace'; pattern: string; replacement: string }
  | { type: 'default'; value: unknown }

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
  /** Keyed by external-schema field name (Amazon: 'bullet_point_1',
   *  eBay: 'ItemSpecifics.Brand', Shopify: 'metafields.material'). */
  fields: Record<string, FieldMappingRule>
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
  const errors: string[] = []
  const prefix = `fields.${fieldKey}`

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
        if (!isPlainObject(t) || typeof t.type !== 'string' || !VALID_TRANSFORM_TYPES.has(t.type)) {
          errors.push(`${prefix}.transforms[${i}] has invalid type`)
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
  return raw as unknown as MarketplaceSchemaMapping
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

/** Read a single field's mapping rule. Returns null when the field
 *  isn't mapped (or the row is empty). */
export async function getFieldMapping(
  channel: string,
  code: string,
  fieldKey: string,
): Promise<FieldMappingRule | null> {
  const mapping = await getMappingForMarketplace(channel, code)
  return mapping.fields[fieldKey] ?? null
}

/** Upsert one field's rule, preserving every other field already in
 *  the mapping. Throws InvalidMappingError if the rule fails
 *  validation. Atomic on the single row. */
export async function upsertFieldMapping(
  channel: string,
  code: string,
  fieldKey: string,
  rule: FieldMappingRule,
): Promise<MarketplaceSchemaMapping> {
  const ruleErrors = validateFieldRule(fieldKey, rule)
  if (ruleErrors.length > 0) throw new InvalidMappingError(ruleErrors)

  const current = await getMappingForMarketplace(channel, code)
  const next: MarketplaceSchemaMapping = {
    ...current,
    fields: { ...current.fields, [fieldKey]: rule },
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
): Promise<MarketplaceSchemaMapping> {
  const current = await getMappingForMarketplace(channel, code)
  if (!(fieldKey in current.fields)) return current

  const nextFields = { ...current.fields }
  delete nextFields[fieldKey]
  const next: MarketplaceSchemaMapping = { ...current, fields: nextFields }

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
