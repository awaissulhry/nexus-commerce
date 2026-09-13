import { VARIATION_RULE_KEY } from '../variation-rule-store.js'
import { InvalidMappingError, validateMapping, type MarketplaceSchemaMapping, type FieldMappingRule } from '../schema-mapping.service.js'
import { exprDependenciesDeep, renameRuleCalls } from './expr.js'

export type ExpressionChange = { name: string; expr: string | null; previousName?: string }
export type CategoryChange = { expectedTaxonomySnapshotId?: string; categoryId: string; channelCategoryId: string | null; channelCategoryPath?: string | null; browseNodeId?: string | null }

/** Atomic rename + edit. Includes calls in OTHER named expressions, not only field transforms. */
export function expressionDraft(before: MarketplaceSchemaMapping, change: ExpressionChange): MarketplaceSchemaMapping {
  if (typeof change.name !== 'string' || (change.expr !== null && typeof change.expr !== 'string') || (change.previousName !== undefined && typeof change.previousName !== 'string')) throw new InvalidMappingError(['Choose a rule name and formula text, or explicitly remove the rule'])
  const name = change.name?.trim()
  if (!name || name.length > 200) throw new InvalidMappingError(['Choose a business-rule name of 1–200 characters'])
  const after = structuredClone(before)
  const expressions = after.expressions ??= {}
  const from = change.previousName
  if (from && from !== name) {
    if (!(from in expressions)) throw new InvalidMappingError([`No business rule named “${from}”`])
    if (name in expressions) throw new InvalidMappingError([`A business rule named “${name}” already exists`])
    const rewrite = (expr: string) => renameRuleCalls(expr, from, name)
    for (const key of Object.keys(expressions)) expressions[key] = rewrite(expressions[key])
    expressions[name] = expressions[from]; delete expressions[from]
    for (const bucket of [after.fields, ...Object.values(after.byProductType ?? {})]) {
      for (const rule of Object.values(bucket)) for (const transform of rule.transforms ?? []) {
        if (transform.type !== 'expr') continue
        if (transform.ref === from) transform.ref = name
        if (transform.expr) transform.expr = rewrite(transform.expr)
      }
    }
    if (change.expr !== null) change = { ...change, expr: rewrite(change.expr) }
  }
  if (change.expr === null) delete expressions[name]
  else expressions[name] = change.expr.trim()
  validateReviewMapping(after)
  return after
}

/** Missing references/cycles are errors even for optional fields and unused named formulas. */
export function validateReviewMapping(mapping: MarketplaceSchemaMapping) {
  const errors = validateMapping(mapping)
  const expressions = mapping.expressions ?? {}
  const check = (body: string, label: string) => {
    const deps = exprDependenciesDeep(body, expressions)
    if (!deps) return
    if (deps.cycle) errors.push(`${label}: circular reference ${deps.cycle.join(' → ')}`)
    for (const ref of deps.rules) if (!(ref in expressions)) errors.push(`${label}: missing business rule “${ref}”`)
  }
  for (const [name, body] of Object.entries(expressions)) check(body, name)
  for (const bucket of [mapping.fields, ...Object.values(mapping.byProductType ?? {})]) {
    for (const [field, rule] of Object.entries(bucket)) for (const op of rule.transforms ?? []) {
      if (op.type !== 'expr') continue
      if (op.ref && !(op.ref in expressions)) errors.push(`${field}: missing business rule “${op.ref}”`)
      if (op.expr) check(op.expr, field)
    }
  }
  if (errors.length) throw new InvalidMappingError([...new Set(errors)])
}

export function allMappingFields(...mappings: MarketplaceSchemaMapping[]): string[] {
  // VT.1b / R-VT-2 — `variations` inside a category bucket is the variation RULE, not a field. Without this skip a
  // restore or an expression review lists it as a field whose rule is `null`, i.e. a phantom "remove variations"
  // change row in the review — and `changedFields` below would ask the activation to delete it.
  return [...new Set(mappings.flatMap(m => [m.fields, ...Object.values(m.byProductType ?? {})]
    .flatMap(b => Object.keys(b).filter(key => key !== VARIATION_RULE_KEY))))].sort()
}

export function changedFields(before: MarketplaceSchemaMapping, after: MarketplaceSchemaMapping): Array<{ fieldKey: string; rule: FieldMappingRule | null }> {
  return allMappingFields(before, after).map(fieldKey => ({ fieldKey, rule: after.fields[fieldKey] ?? null }))
}
