import { workspaceKey } from '@nexus/database/workspace-context'
import { validatePresentationRule } from './mapping/presentation-rules.js'
import { mappingToken, MappingConflict } from './mapping/revision-token.js'
import { Prisma } from '@prisma/client'
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
import { validateExpr } from './mapping/expr.js'

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
  /** PES.6 — the formula engine. Computes the value from an expression over the
   *  resolved attributes (`if(isblank($itemasin),"ean","upc")`, `$brand + " " + $name`,
   *  `round(margin($cost,20),2)`). Exactly one of `expr` (inline) or `ref` (a saved
   *  business rule from `MarketplaceSchemaMapping.expressions`). It IGNORES the incoming
   *  value — an expression field usually has an empty `source`. Grammar + function list:
   *  services/pim/mapping/expr.ts. */
  | { type: 'expr'; expr?: string; ref?: string }

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
  /** Versioned eBay presentation defaults; evaluated per destination, never materialized as overrides. */
  presentationRules?: import('./mapping/presentation-rules.js').PresentationRule[]
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
  /** PES.6 — named business rules for this marketplace: name → expression body.
   *  Rithum's model exactly: a formula is authored ONCE ("SE_AS_Price - 20% Margin"),
   *  referenced by many fields through `{type:'expr', ref:'<name>'}` or `rule("<name>")`,
   *  and the editor shows the NAME in the cell with the body on hover. Lives inside
   *  schemaMapping (not its own table) so it inherits the MappingRevision history and
   *  rollback that the whole mapping already has. Optional so pre-PES.6 rows type-check;
   *  emptyMapping()/parseMapping() always normalize it to a present object. */
  expressions?: Record<string, string>
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
    expressions: {},
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
  // PES.6
  'expr',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a raw value against the mapping shape. Returns an array of
 *  human-readable errors; empty array = valid. Caller decides whether
 *  to throw, log, or surface to a user. */
export function validateMapping(
  input: unknown,
  opts: {
    /**
     * Syntax-check every `expressions` body. TRUE on the WRITE path, where a formula that cannot
     * parse must be refused before it reaches publish.
     *
     * FALSE on the READ path, and the difference is not cosmetic: `parseMapping` discards the
     * WHOLE mapping when validation returns anything, so making a body syntax error fatal there
     * meant one malformed expression silently zeroed an entire marketplace — every field on it
     * would read as unmapped, with no error anywhere. A broken formula must degrade to "that
     * formula is broken" (reported per-expression by `exprDependencies`/`parseError`), never to
     * "this marketplace has no mapping".
     */
    checkExpressions?: boolean
  } = {},
): string[] {
  const checkExpressions = opts.checkExpressions !== false
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

  // PES.6 — expressions: optional name → formula body. Validate only when present so
  // pre-PES.6 rows stay valid, and syntax-check every body so a broken business rule
  // cannot be saved (it would break every field that references it).
  if (input.expressions !== undefined) {
    if (!isPlainObject(input.expressions)) {
      errors.push('mapping.expressions must be an object')
    } else {
      for (const [name, body] of Object.entries(input.expressions)) {
        if (typeof body !== 'string' || body.trim() === '') {
          errors.push(`mapping.expressions.${name} must be a non-empty string`)
          continue
        }
        if (!checkExpressions) continue
        const bad = validateExpr(body)
        if (bad) errors.push(`mapping.expressions.${name} — ${bad.message} (at character ${bad.pos + 1})`)
      }
    }
  }

  if (checkExpressions && input.presentationRules !== undefined) {
    if (!Array.isArray(input.presentationRules) || input.presentationRules.length > 500) errors.push('Use at most 500 presentation rules per market')
    else {
      const ids = new Set<string>()
      for (const rule of input.presentationRules) {
        errors.push(...validatePresentationRule(rule))
        if (ids.has(rule?.id)) errors.push(`Duplicate presentation rule ID: ${rule.id}`)
        ids.add(rule?.id)
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

  // PES.6 — a rule may have an EMPTY source when a transform produces the value on its
  // own: a constant (`default`), a template, or an `expr` formula. Every rule that was
  // valid before this relaxation is still valid; it only stops rejecting the constant and
  // expression kinds the mapping editor now authors.
  const producesOwnValue =
    Array.isArray(rule.transforms) &&
    rule.transforms.some(
      (t) => isPlainObject(t) && (t.type === 'default' || t.type === 'template' || t.type === 'expr'),
    )
  if (typeof rule.source !== 'string') {
    errors.push(`${prefix}.source must be a string`)
  } else if (rule.source.length === 0 && !producesOwnValue) {
    errors.push(
      `${prefix}.source must be a non-empty string unless the rule has a default, template or expr transform`,
    )
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
          case 'expr': {
            // Exactly one of `expr` (inline body) or `ref` (a saved business rule).
            const hasExpr = typeof tt.expr === 'string' && (tt.expr as string).trim().length > 0
            const hasRef = typeof tt.ref === 'string' && (tt.ref as string).trim().length > 0
            if (hasExpr === hasRef) {
              errors.push(`${tp} needs exactly one of "expr" (a formula) or "ref" (a business rule name)`)
              break
            }
            if (hasExpr) {
              // Syntax-check on WRITE. A formula that cannot parse must never reach the
              // publish path, where its only symptom would be an empty field.
              const bad = validateExpr(tt.expr as string)
              if (bad) errors.push(`${tp}.expr — ${bad.message} (at character ${bad.pos + 1})`)
            }
            break
          }
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
  // Shape only. A broken expression BODY is reported per-expression by the read routes; it must
  // not cost the marketplace its entire rule set (see validateMapping's `checkExpressions`).
  const errors = validateMapping(raw, { checkExpressions: false })
  if (errors.length > 0) return emptyMapping()
  const m = raw as unknown as MarketplaceSchemaMapping
  // FM.1 — normalize the optional overlay so every downstream caller can
  // rely on mapping.byProductType being a present object.
  return {
    ...m,
    byProductType: isPlainObject(m.byProductType) ? m.byProductType : {},
    // PES.6 — same normalisation as byProductType: downstream never null-checks.
    expressions: isPlainObject(m.expressions) ? m.expressions : {},
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
    where: { channel_code: workspaceKey({ channel, code }) },
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

/** Every mapping writer compares the snapshot it read, then commits its history with the change.
 * A schema refresh, formula save, clone and field edit cannot erase one another's changes. */
export async function persistMapping(channel: string, code: string, current: MarketplaceSchemaMapping, next: MarketplaceSchemaMapping, expectedToken?: string, audit?: { userId: string | null; impactJobId: string; validateInputs?: (tx: Prisma.TransactionClient) => Promise<void>; applyRelated?: (tx: Prisma.TransactionClient) => Promise<void> }): Promise<void> {
  if (expectedToken && expectedToken !== mappingToken(current)) throw new MappingConflict()
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(async tx => {
        if (audit) {
          await audit.validateInputs?.(tx)
          const claim = await tx.bulkOperation.updateMany({ where: { id: audit.impactJobId, userId: audit.userId, status: 'MAPPING_REVIEW', expiresAt: { gt: new Date() } },
            data: { status: 'MAPPING_APPLIED', completedAt: new Date() } })
          if (claim.count !== 1) throw new MappingConflict('This review was already applied or expired. Reload its current status.')
        }
        const row = await tx.marketplace.findUnique({ where: { channel_code: workspaceKey({ channel, code }) }, select: { schemaMapping: true } })
        if (!row) throw new MarketplaceNotFoundError(channel, code)
        if (mappingToken(parseMapping(row.schemaMapping)) !== mappingToken(current)) throw new MappingConflict()
        next.version = current.version + 1
        const changed = await tx.marketplace.updateMany({
          where: { channel, code, schemaMapping: { equals: row.schemaMapping === null ? Prisma.DbNull : row.schemaMapping } },
          data: { schemaMapping: next as unknown as Prisma.InputJsonValue },
        })
        if (changed.count !== 1) throw new MappingConflict()
        await audit?.applyRelated?.(tx)
        const last = await tx.mappingRevision.findFirst({ where: { channel, code }, orderBy: { version: 'desc' }, select: { version: true } })
        await tx.mappingRevision.create({ data: { channel, code, version: (last?.version ?? 0) + 1,
          snapshot: current as unknown as Prisma.InputJsonValue, reason: audit ? `Standing rule activated from impact review ${audit.impactJobId}` : 'Mapping change; stored product facts and listing overrides preserved' } })
      }, { isolationLevel: 'Serializable', timeout: 60_000 })
      return
    } catch (error) {
      // A serialization conflict rolls the whole transaction back. Repeat every
      // input/revision check; never retry a stale snapshot or validation refusal.
      if (attempt < 2 && (error as { code?: string }).code === 'P2034') continue
      throw error
    }
  }
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
  expectedToken?: string,
): Promise<MarketplaceSchemaMapping> {
  const ruleErrors = validateFieldRule(fieldKey, rule)
  if (ruleErrors.length > 0) throw new InvalidMappingError(ruleErrors)

  const current = await getMappingForMarketplace(channel, code)
  if (expectedToken && expectedToken !== mappingToken(current)) throw new MappingConflict()
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

  await persistMapping(channel, code, current, next, expectedToken)
  return next
}

/** BM.1 — Pure: merge N rules into a mapping (default bucket or productType
 *  overlay), preserving every other field/type. Exposed for unit tests. */
export function mergeRulesIntoMapping(
  current: MarketplaceSchemaMapping,
  rules: Array<{ fieldKey: string; rule: FieldMappingRule }>,
  productType?: string | null,
): MarketplaceSchemaMapping {
  if (productType) {
    const byProductType = current.byProductType ?? {}
    const bucket = { ...(byProductType[productType] ?? {}) }
    for (const { fieldKey, rule } of rules) bucket[fieldKey] = rule
    return { ...current, byProductType: { ...byProductType, [productType]: bucket } }
  }
  const fields = { ...current.fields }
  for (const { fieldKey, rule } of rules) fields[fieldKey] = rule
  return { ...current, fields }
}

/** BM.1 — Pure: remove N fieldKeys from a mapping bucket. */
export function removeRulesFromMapping(
  current: MarketplaceSchemaMapping,
  fieldKeys: string[],
  productType?: string | null,
): MarketplaceSchemaMapping {
  const drop = new Set(fieldKeys)
  if (productType) {
    const byProductType = current.byProductType ?? {}
    const bucket = { ...(byProductType[productType] ?? {}) }
    for (const k of drop) delete bucket[k]
    return { ...current, byProductType: { ...byProductType, [productType]: bucket } }
  }
  const fields = { ...current.fields }
  for (const k of drop) delete fields[k]
  return { ...current, fields }
}

/** BM.1 — Upsert N field rules in ONE row update (one revision). Validates
 *  all upfront; throws InvalidMappingError naming every offending field. */
export async function bulkUpsertFieldMappings(
  channel: string,
  code: string,
  rules: Array<{ fieldKey: string; rule: FieldMappingRule }>,
  productType?: string | null,
): Promise<{ count: number; mapping: MarketplaceSchemaMapping }> {
  const errors: string[] = []
  for (const { fieldKey, rule } of rules) errors.push(...validateFieldRule(fieldKey, rule))
  if (errors.length > 0) throw new InvalidMappingError(errors)

  const current = await getMappingForMarketplace(channel, code)
  const next = mergeRulesIntoMapping(current, rules, productType)
  await persistMapping(channel, code, current, next)
  return { count: rules.length, mapping: next }
}

/** BM.1 — Remove N field rules in one row update. */
export async function bulkRemoveFieldMappings(
  channel: string,
  code: string,
  fieldKeys: string[],
  productType?: string | null,
): Promise<{ count: number; mapping: MarketplaceSchemaMapping }> {
  const current = await getMappingForMarketplace(channel, code)
  const next = removeRulesFromMapping(current, fieldKeys, productType)
  await persistMapping(channel, code, current, next)
  return { count: fieldKeys.length, mapping: next }
}

const CLONE_TEXT_FIELD_RE = /title|name|description|bullet|keyword|feature|search_term|caption/i

/** BM.4 — Pure: build the rules to clone into a target, filtered to the
 *  target's field catalog, optionally adding a `translate` transform to text
 *  fields (for cross-language markets). */
export function buildClonedRules(
  sourceRules: Record<string, FieldMappingRule>,
  targetFieldKeys: Set<string>,
  addTranslate: boolean,
): { rules: Array<{ fieldKey: string; rule: FieldMappingRule }>; skipped: number } {
  const rules: Array<{ fieldKey: string; rule: FieldMappingRule }> = []
  let skipped = 0
  for (const [fieldKey, rule] of Object.entries(sourceRules)) {
    if (!targetFieldKeys.has(fieldKey)) {
      skipped++
      continue
    }
    let r = rule
    if (addTranslate && CLONE_TEXT_FIELD_RE.test(fieldKey)) {
      const transforms = Array.isArray(rule.transforms) ? rule.transforms : []
      if (!transforms.some((t) => t.type === 'translate')) {
        r = { ...rule, transforms: [...transforms, { type: 'translate' }] }
      }
    }
    rules.push({ fieldKey, rule: r })
  }
  return { rules, skipped }
}

/** BM.4 — Clone one coordinate's resolved rules to one or more targets,
 *  filtered to each target's ChannelSchema (skips fields a market lacks). */
export async function cloneMapping(input: {
  from: { channel: string; code: string }
  targets: Array<{ channel: string; code: string }>
  productType?: string | null
  addTranslate?: boolean
}): Promise<{ results: Array<{ channel: string; code: string; cloned: number; skipped: number; error?: string }> }> {
  const sourceRules = await getResolvedRules(input.from.channel, input.from.code, input.productType ?? undefined)
  const results: Array<{ channel: string; code: string; cloned: number; skipped: number; error?: string }> = []
  for (const t of input.targets) {
    try {
      const fields = await prisma.channelSchema.findMany({
        where: { channel: t.channel, OR: [{ marketplace: t.code }, { marketplace: null }] },
        select: { fieldKey: true },
      })
      const { rules, skipped } = buildClonedRules(sourceRules, new Set(fields.map((f) => f.fieldKey)), !!input.addTranslate)
      if (rules.length > 0) await bulkUpsertFieldMappings(t.channel, t.code, rules, input.productType ?? undefined)
      results.push({ channel: t.channel, code: t.code, cloned: rules.length, skipped })
    } catch (e) {
      results.push({ channel: t.channel, code: t.code, cloned: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { results }
}

/** Remove one field's mapping rule. No-op if the field wasn't mapped.
 *  Returns the post-removal mapping. */
export async function removeFieldMapping(
  channel: string,
  code: string,
  fieldKey: string,
  productType?: string | null,
  expectedToken?: string,
): Promise<MarketplaceSchemaMapping> {
  const current = await getMappingForMarketplace(channel, code)
  if (expectedToken && expectedToken !== mappingToken(current)) throw new MappingConflict()

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

  await persistMapping(channel, code, current, next, expectedToken)
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
  await persistMapping(channel, code, current, next)
  return next
}

// ────────────────────────────────────────────────────────────────────
// PES.6 — named business rules (`expressions`)
// ────────────────────────────────────────────────────────────────────

/** Where a business rule is referenced from — so the editor can show usage and the
 *  delete path can refuse to orphan a field. */
export interface ExpressionUsage {
  /** null = the type-agnostic default bucket, otherwise the productType overlay. */
  productType: string | null
  fieldKey: string
  /** 'ref' = a `{type:'expr', ref}` transform, 'call' = a `rule("name")` inside a formula. */
  via: 'ref' | 'call'
}

/** Every reference to `name` across the default bucket and every productType overlay. */
export function findExpressionUsage(
  mapping: MarketplaceSchemaMapping,
  name: string,
): ExpressionUsage[] {
  const out: ExpressionUsage[] = []
  const scan = (bucket: Record<string, FieldMappingRule>, productType: string | null) => {
    for (const [fieldKey, rule] of Object.entries(bucket ?? {})) {
      for (const t of rule?.transforms ?? []) {
        if (t.type !== 'expr') continue
        if (t.ref === name) out.push({ productType, fieldKey, via: 'ref' })
        // A formula can also call it: rule("name"). Cheap literal scan — the parser's
        // dependency walk is used by the editor; this only needs to be safe.
        else if (typeof t.expr === 'string' && exprCallsRule(t.expr, name)) {
          out.push({ productType, fieldKey, via: 'call' })
        }
      }
    }
  }
  scan(mapping.fields ?? {}, null)
  for (const [pt, bucket] of Object.entries(mapping.byProductType ?? {})) scan(bucket, pt)
  return out
}

/** `rule("name")` / `rule('name')`, whitespace-tolerant. */
function exprCallsRule(expr: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`rule\\s*\\(\\s*["']${escaped}["']\\s*\\)`, 'i').test(expr)
}

/** Create or replace one business rule. Validates the body before it can be stored. */
export async function upsertExpression(
  channel: string,
  code: string,
  name: string,
  body: string,
): Promise<MarketplaceSchemaMapping> {
  const trimmed = name.trim()
  if (!trimmed) throw new InvalidMappingError(['expression name must not be empty'])
  const bad = validateExpr(body)
  if (bad) throw new InvalidMappingError([`${bad.message} (at character ${bad.pos + 1})`])

  const current = await getMappingForMarketplace(channel, code)
  const next: MarketplaceSchemaMapping = {
    ...current,
    expressions: { ...(current.expressions ?? {}), [trimmed]: body },
  }
  await persistMapping(channel, code, current, next)
  return next
}

/** Delete a business rule. Refuses while anything still references it — an orphaned
 *  `ref` resolves to nothing, and a field that silently stops producing a value is
 *  exactly the failure this editor exists to prevent. Pass `force` to override. */
export async function removeExpression(
  channel: string,
  code: string,
  name: string,
  force = false,
): Promise<{ mapping: MarketplaceSchemaMapping; removed: boolean; usage: ExpressionUsage[] }> {
  const current = await getMappingForMarketplace(channel, code)
  const usage = findExpressionUsage(current, name)
  if (usage.length > 0 && !force) {
    return { mapping: current, removed: false, usage }
  }
  const expressions = { ...(current.expressions ?? {}) }
  delete expressions[name]
  const next: MarketplaceSchemaMapping = { ...current, expressions }
  await persistMapping(channel, code, current, next)
  return { mapping: next, removed: true, usage }
}

/** Rename a business rule, rewriting every `ref` and `rule("…")` that points at it. */
export async function renameExpression(
  channel: string,
  code: string,
  from: string,
  to: string,
): Promise<MarketplaceSchemaMapping> {
  const target = to.trim()
  if (!target) throw new InvalidMappingError(['expression name must not be empty'])
  const current = await getMappingForMarketplace(channel, code)
  const body = current.expressions?.[from]
  if (body === undefined) throw new InvalidMappingError([`no business rule named "${from}"`])

  if (target !== from && current.expressions?.[target] !== undefined) throw new InvalidMappingError([`A business rule named "${target}" already exists`])
  const expressions = { ...(current.expressions ?? {}) }
  delete expressions[from]
  expressions[target] = body

  const rewriteBucket = (bucket: Record<string, FieldMappingRule>) => {
    const out: Record<string, FieldMappingRule> = {}
    for (const [fieldKey, rule] of Object.entries(bucket ?? {})) {
      out[fieldKey] = {
        ...rule,
        transforms: (rule.transforms ?? []).map((t) => {
          if (t.type !== 'expr') return t
          const next = { ...t } as Extract<TransformOp, { type: 'expr' }>
          if (next.ref === from) next.ref = target
          if (typeof next.expr === 'string' && exprCallsRule(next.expr, from)) {
            const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            next.expr = next.expr.replace(
              new RegExp(`(rule\\s*\\(\\s*)(["'])${escaped}\\2(\\s*\\))`, 'gi'),
              `$1$2${target}$2$3`,
            )
          }
          return next
        }),
      }
    }
    return out
  }

  const next: MarketplaceSchemaMapping = {
    ...current,
    expressions,
    fields: rewriteBucket(current.fields ?? {}),
    byProductType: Object.fromEntries(
      Object.entries(current.byProductType ?? {}).map(([pt, bucket]) => [pt, rewriteBucket(bucket)]),
    ),
  }
  await persistMapping(channel, code, current, next)
  return next
}
