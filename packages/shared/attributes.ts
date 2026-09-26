/**
 * The attribute contract — ONE vocabulary for the API, the web client and import/export.
 *
 * `docs/attributes/PLAN.md` §4 (P1). Before this module the same ideas had several spellings: a closed option list was
 * `mode: 'strict'` (channel specs), `enumMode: 'strict'` (flat-file registry), `selectionOnly: true` (Amazon flat file)
 * and `aspectMode: 'SELECTION_ONLY'` (eBay). Channel vocabularies are converted to these names at the edge
 * (`optionModeFrom`); inside Nexus only these names exist.
 *
 * Pure: no I/O, no framework imports, safe for the browser.
 */
import { z } from 'zod'

export type AttributeChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'

/**
 * `scalar`  — one value.
 * `list`    — an ordered array of values.
 * `measure` — a `{ value, unit }` pair.
 * A compound channel attribute is flattened to one field per leaf (`closure__type`); it is not a shape.
 */
export type AttributeShape = 'scalar' | 'list' | 'measure'
export const ATTRIBUTE_SHAPES: readonly AttributeShape[] = ['scalar', 'list', 'measure']

/** The kind of ONE value (a list member, or a measure's number). */
export type AttributeLeafKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'

/**
 * `strict` — only the listed options are valid for the owner of the list (the channel, or the business when it chose so).
 * `open`   — the options are suggestions; any value of the right kind is valid.
 */
export type OptionMode = 'strict' | 'open'

/** Derived from the channel, never invented. `bestPractice` is eBay's "recommended"; it is not a requirement. */
export type AttributeRequirement = 'required' | 'requiredIfRelevant' | 'bestPractice' | 'optional'

export interface Cardinality {
  /** The minimum count when the field is present at all. Not a requirement signal. */
  min: number
  /** `null` = no upper bound. */
  max: number | null
}

export interface MeasureValue {
  value: number | null
  unit: string | null
}

/** A stored attribute value. `null` = cleared. Structured records (`recordFields`) are arrays of objects. */
export type AttributeValue = string | number | boolean | null | string[] | number[] | MeasureValue | Record<string, unknown>[]

/**
 * Convert any channel's or legacy module's spelling of "closed list / open list" into `OptionMode`.
 * Returns `undefined` when the input says nothing, so a caller can apply its own default.
 *
 *   'strict' | 'open'                   (Nexus, flat-file registry `enumMode`)
 *   'SELECTION_ONLY' | 'FREE_TEXT'      (eBay `aspectMode`)
 *   true | false                        (Amazon flat-file `selectionOnly`)
 */
export function optionModeFrom(input: unknown): OptionMode | undefined {
  if (input === true) return 'strict'
  if (input === false) return 'open'
  if (typeof input !== 'string') return undefined
  switch (input.trim().toUpperCase()) {
    case 'STRICT':
    case 'SELECTION_ONLY':
      return 'strict'
    case 'OPEN':
    case 'FREE_TEXT':
      return 'open'
    default:
      return undefined
  }
}

// ────────────────────────────────────────────────────────────────────
// The rules a business sets on its own attribute (`CustomAttribute.validation`)
// ────────────────────────────────────────────────────────────────────

const finite = z.number().finite()

export const recordFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(['text', 'number', 'boolean', 'select']),
  required: z.boolean().optional(),
  min: finite.optional(),
  max: finite.optional(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() }).passthrough()).optional(),
}).passthrough()

/**
 * The typed form of `CustomAttribute.validation`. Every key is optional and unknown keys are KEPT (`passthrough`):
 * a saved definition may carry keys this version does not know, and parsing must never drop them.
 * The key names are the ones `coerceForShape` (apps/api/src/services/pim/sheet-values.ts) already enforces.
 */
export const attributeRulesSchema = z.object({
  shape: z.enum(['scalar', 'list', 'measure']).optional(),
  /** Absent = `open`: a business attribute accepts any value of its kind unless the business made it strict. */
  optionMode: z.enum(['strict', 'open']).optional(),
  unitOptions: z.array(z.string()).optional(),
  minLength: finite.int().nonnegative().optional(),
  maxLength: finite.int().positive().optional(),
  pattern: z.string().optional(),
  minimum: finite.optional(),
  maximum: finite.optional(),
  /** Older spellings of minimum/maximum, still read. */
  min: finite.optional(),
  max: finite.optional(),
  exclusiveMinimum: finite.optional(),
  exclusiveMaximum: finite.optional(),
  multipleOf: finite.positive().optional(),
  minItems: finite.int().nonnegative().optional(),
  maxItems: finite.int().positive().optional(),
  uniqueItems: z.boolean().optional(),
  recordFields: z.array(recordFieldSchema).optional(),
  uniqueBy: z.string().optional(),
  sum: z.object({ field: z.string(), total: finite }).optional(),
  /** Per-language labels: `{ it: 'Colletto', de: 'Kragen' }`. */
  labels: z.record(z.string(), z.string()).optional(),
}).passthrough()

export type AttributeRules = z.infer<typeof attributeRulesSchema>

export type AttributeRulesResult = { ok: true; rules: AttributeRules } | { ok: false; errors: string[] }

/** Parse a stored or submitted `validation` object. `null`/`undefined` = no rules. */
export function parseAttributeRules(input: unknown): AttributeRulesResult {
  if (input === null || input === undefined) return { ok: true, rules: {} }
  const parsed = attributeRulesSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'validation'}: ${issue.message}`) }
  }
  const rules = parsed.data
  const errors: string[] = []
  const lo = rules.minimum ?? rules.min
  const hi = rules.maximum ?? rules.max
  if (lo !== undefined && hi !== undefined && lo > hi) errors.push('minimum is greater than maximum')
  if (rules.minLength !== undefined && rules.maxLength !== undefined && rules.minLength > rules.maxLength) errors.push('minLength is greater than maxLength')
  if (rules.minItems !== undefined && rules.maxItems !== undefined && rules.minItems > rules.maxItems) errors.push('minItems is greater than maxItems')
  if (rules.pattern !== undefined) {
    try { new RegExp(rules.pattern, 'u') } catch { errors.push('pattern is not a valid regular expression') }
  }
  if (rules.shape === 'measure' && rules.unitOptions !== undefined && rules.unitOptions.length === 0) errors.push('a measure needs at least one unit option')
  return errors.length ? { ok: false, errors } : { ok: true, rules }
}

/** The shape a business attribute stores, from its type and rules (the one rule `family-sheet-schema.ts` applies). */
export function attributeShapeOf(type: string, rules: Pick<AttributeRules, 'shape'> | null | undefined): AttributeShape {
  if (rules?.shape === 'measure') return 'measure'
  if (type === 'multiselect' || rules?.shape === 'list') return 'list'
  return 'scalar'
}

// ────────────────────────────────────────────────────────────────────
// Issue codes — what is wrong with a value, and whether it may be saved
// ────────────────────────────────────────────────────────────────────

/**
 * `shape`          — the value cannot be stored in this field's shape or kind (text in a number, unknown unit, a list
 *                    sent to a single-value field). Always refused: storing it would corrupt the field.
 * `rule`           — breaks a rule the BUSINESS set on its own attribute (length, pattern, bounds, item count).
 * `channel-limit`  — breaks a channel's hard limit (character cap, byte cap, slot count).
 * `off-list`       — not one of the channel's values on a STRICT channel list. The value is saved; the channel is
 *                    flagged, and that listing's publish is held until it is mapped or changed (PLAN §4.4).
 * `value-map-miss` — a value map exists for the field but has no row for this value.
 * `required`       — a required field is empty for this destination.
 */
export type AttributeIssueCode = 'shape' | 'rule' | 'channel-limit' | 'off-list' | 'value-map-miss' | 'required'

/** The save rule (PLAN §4.4): only these codes stop a value from being stored. The rest are flags. */
const BLOCKS_SAVE: ReadonlySet<AttributeIssueCode> = new Set(['shape', 'rule', 'channel-limit'])

export function issueBlocksSave(code: AttributeIssueCode): boolean {
  return BLOCKS_SAVE.has(code)
}
