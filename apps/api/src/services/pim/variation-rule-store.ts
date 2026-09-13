/**
 * VT.1b / R-VT-2 — the STORED shape of a variation rule, and its validator.
 *
 * VX §11.1 / M2 puts a per-category variation rule inside the marketplace mapping document. VT.3 measured what that
 * cost as designed (2026-09-13, ledger): storing it at `byProductType.<CATEGORY>.variations` made `validateMapping`
 * answer `byProductType.AUTO_ACCESSORY.variations.source must be a string` — because that bucket is typed
 * `Record<string, FieldMappingRule>` — and `parseMapping` returns `emptyMapping()` on ANY validation error, so the
 * marketplace lost every rule it had: `mappingVersion 12 → 1`, mapped `65 → 57`, coverage `100 → 88`, with a 200.
 *
 * This module is a LEAF (it imports nothing) so `schema-mapping.service.ts` can validate the shape without depending
 * on the variation resolver, and the resolver can consume it without depending on the mapping engine.
 *
 * Placement, decided by R-VT-2 (c): the validator recognises the rule at BOTH addresses.
 *  - `variationsByProductType[<category>]` and `variations` at the TOP LEVEL are the canonical homes, and the ones
 *    the write path uses. Nothing that iterates a field-rule bucket can ever see them.
 *  - `byProductType[<category>].variations` is recognised too, because a document written that way already exists in
 *    the wild (VT.3 wrote and restored one) and must validate cleanly rather than zero a marketplace. `getRulesFor`
 *    skips the reserved key so such a rule is never resolved as though it were a field rule.
 */

/** The reserved key inside a per-category field-rule bucket. Never a field name. */
export const VARIATION_RULE_KEY = 'variations'

export type CollisionResolverKind = 'split' | 'fold' | 'exclude'
export type ListingSplitMode = 'one' | 'per-axis'

/**
 * What the mapping document stores for one coordinate's variation rule — the mirror of the web contract's
 * `VariationRuleWrite['rule']` (`apps/web/src/app/channels/mapping/_shared/contracts.ts`), plus the three
 * server-stamped provenance fields. One shape, two ends of the wire.
 */
export interface StoredVariationRule {
  /** AMAZON only: the product type's enum value. `null` = the channel derives it. */
  theme: string | null
  axes: Array<{ axisKey: string; target: string | null; order: number; included: boolean }>
  collisions: { resolver: CollisionResolverKind; foldInto: string | null; foldSeparator: string }
  split: { mode: ListingSplitMode; axisKey: string | null }
  /** Server-stamped. What the cell's `Follows rule <label>` prints. */
  label?: string
  updatedAt?: string
  updatedBy?: string | null
}

const RESOLVERS: ReadonlySet<string> = new Set<CollisionResolverKind>(['split', 'fold', 'exclude'])
const SPLIT_MODES: ReadonlySet<string> = new Set<ListingSplitMode>(['one', 'per-axis'])

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Shape-check one stored variation rule. Returns human-readable errors prefixed with `path`, empty when valid —
 * the same contract `validateFieldRule` follows, so the mapping validator can concatenate them.
 *
 * 🔴 Every error names the offending KEY. R-VT-2 (b) requires the write path to refuse with 400 naming it, and a
 * refusal an operator cannot locate is the reason VT.3's collapse took a database read to explain.
 */
export function validateStoredVariationRule(raw: unknown, path: string): string[] {
  const errors: string[] = []
  if (!isPlainObject(raw)) return [`${path} must be an object`]

  if (!('theme' in raw)) errors.push(`${path}.theme is required (null when the channel derives it)`)
  else if (raw.theme !== null && typeof raw.theme !== 'string') errors.push(`${path}.theme must be a string or null`)

  if (!Array.isArray(raw.axes)) errors.push(`${path}.axes must be an array`)
  else {
    if (raw.axes.length > 20) errors.push(`${path}.axes takes at most 20 axes`)
    const seen = new Set<string>()
    raw.axes.forEach((axis, index) => {
      const at = `${path}.axes[${index}]`
      if (!isPlainObject(axis)) { errors.push(`${at} must be an object`); return }
      if (typeof axis.axisKey !== 'string' || !axis.axisKey.trim()) errors.push(`${at}.axisKey must be a non-empty string`)
      else if (seen.has(axis.axisKey)) errors.push(`${at}.axisKey "${axis.axisKey}" appears twice`)
      else seen.add(axis.axisKey)
      if (axis.target !== null && typeof axis.target !== 'string') errors.push(`${at}.target must be a string or null`)
      if (typeof axis.order !== 'number' || !Number.isInteger(axis.order) || axis.order < 0) errors.push(`${at}.order must be a whole number`)
      if (typeof axis.included !== 'boolean') errors.push(`${at}.included must be true or false`)
    })
  }

  if (!isPlainObject(raw.collisions)) errors.push(`${path}.collisions must be an object`)
  else {
    const c = raw.collisions
    if (typeof c.resolver !== 'string' || !RESOLVERS.has(c.resolver)) {
      errors.push(`${path}.collisions.resolver must be one of split, fold, exclude`)
    }
    if (c.foldInto !== null && typeof c.foldInto !== 'string') errors.push(`${path}.collisions.foldInto must be a string or null`)
    if (typeof c.foldSeparator !== 'string') errors.push(`${path}.collisions.foldSeparator must be a string`)
    // A `fold` with nothing to fold INTO cannot run — refused here rather than at publish time.
    if (c.resolver === 'fold' && (c.foldInto === null || c.foldInto === undefined || String(c.foldInto).trim() === '')) {
      errors.push(`${path}.collisions.foldInto is required when the resolver is fold`)
    }
  }

  if (!isPlainObject(raw.split)) errors.push(`${path}.split must be an object`)
  else {
    if (typeof raw.split.mode !== 'string' || !SPLIT_MODES.has(raw.split.mode)) {
      errors.push(`${path}.split.mode must be one of one, per-axis`)
    }
    if (raw.split.axisKey !== null && typeof raw.split.axisKey !== 'string') errors.push(`${path}.split.axisKey must be a string or null`)
    if (raw.split.mode === 'per-axis' && (raw.split.axisKey === null || String(raw.split.axisKey ?? '').trim() === '')) {
      errors.push(`${path}.split.axisKey is required when the split mode is per-axis`)
    }
  }

  if (raw.label !== undefined && (typeof raw.label !== 'string' || !raw.label.trim())) errors.push(`${path}.label must be a non-empty string`)
  if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'string') errors.push(`${path}.updatedAt must be a string`)
  if (raw.updatedBy !== undefined && raw.updatedBy !== null && typeof raw.updatedBy !== 'string') errors.push(`${path}.updatedBy must be a string or null`)
  return errors
}

/**
 * A cheap discriminator for the READ path: does this value LOOK like a variation rule rather than a field rule?
 *
 * Used only to decide which vocabulary a warning should speak; never to accept a rule. A field rule always carries a
 * `source`, and a variation rule never does — measured on both real shapes.
 */
export function looksLikeVariationRule(raw: unknown): boolean {
  return isPlainObject(raw) && !('source' in raw) && ('axes' in raw || 'theme' in raw || 'collisions' in raw)
}
