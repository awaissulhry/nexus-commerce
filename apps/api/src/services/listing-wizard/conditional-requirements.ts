/**
 * ALA Phase 2 — conditional-requirement evaluator (ADVISORY).
 *
 * Amazon product-type schemas express ~50–115 conditional requirements per
 * category in a root-level JSON-Schema `allOf` of `if/then[/else]` rules: e.g.
 * "if parentage_level is child, then child_parent_sku_relationship's parent_sku
 * is required", "if parentage_level is present, then variation_theme is
 * required". Nexus's manifests only read the tiny static top-level `required`
 * array (5–10 fields), so ~90% of Amazon's real requirements are invisible.
 *
 * This evaluator surfaces those as ADVISORY hints — it never flips a hard
 * `required` flag and never blocks a submit (Amazon's VALIDATION_PREVIEW is the
 * authoritative gate). It is deliberately CONSERVATIVE: it understands the
 * common shapes (required / properties / contains / items / value-leaf enum /
 * const / not / anyOf / allOf) and returns no hint for anything it can't
 * confidently evaluate — so a hint is only ever shown when it's almost certainly
 * real. Operates on our FLAT value map (fieldId → string) by seeing through the
 * SP-API array/`contains`/`value` wrappers.
 */

export interface ConditionalHint {
  /** Attribute that becomes (conditionally) required given the current values. */
  field: string
  /** Best-effort description of the trigger, for a "because X = Y" message. */
  because: { field?: string; value?: string }
}

type Tri = true | false | null // null = "couldn't determine" (skip, stay safe)

const nonEmpty = (v: unknown): boolean => v != null && String(v).trim() !== ''

/** 3-valued AND: false wins, then null, else true. */
function and3(parts: Tri[]): Tri {
  if (parts.some((p) => p === false)) return false
  if (parts.some((p) => p === null)) return null
  return true
}
/** 3-valued OR: true wins, then null, else false. */
function or3(parts: Tri[]): Tri {
  if (parts.some((p) => p === true)) return true
  if (parts.some((p) => p === null)) return null
  return false
}

/** Evaluate an attribute-level subschema against a single flat value. */
function evalAttr(sub: any, value: unknown): Tri {
  if (!sub || typeof sub !== 'object') return null
  // See through the SP-API array wrappers (attributes are arrays of {value}).
  if (sub.items) return evalAttr(sub.items, value)
  if (sub.contains) return evalAttr(sub.contains, value)

  const parts: Tri[] = []
  if (sub.properties && typeof sub.properties === 'object' && 'value' in sub.properties) {
    parts.push(evalAttr(sub.properties.value, value))
  }
  if (Array.isArray(sub.required) && sub.required.includes('value')) {
    parts.push(nonEmpty(value) ? true : false)
  }
  if (Array.isArray(sub.enum)) {
    parts.push(sub.enum.map(String).includes(String(value)) ? true : false)
  }
  if (sub.const !== undefined) {
    parts.push(String(value) === String(sub.const) ? true : false)
  }
  if (sub.not) {
    const r = evalAttr(sub.not, value)
    parts.push(r === null ? null : (!r as Tri))
  }
  if (parts.length === 0) {
    // No recognised leaf constraint. If the node ONLY carries structural/benign
    // keys (e.g. {} or {type:'array'}), treat it as a plain presence check. If it
    // carries an unrecognised CONSTRAINT (minItems, pattern, minimum…), we can't
    // evaluate it → return null so the whole rule is skipped (stay safe).
    const BENIGN = new Set(['type', 'title', 'description', 'examples', '$comment', 'items', 'contains', 'properties'])
    const hasUnknownConstraint = Object.keys(sub).some((k) => !BENIGN.has(k))
    if (hasUnknownConstraint) return null
    return nonEmpty(value) ? true : false
  }
  return and3(parts)
}

/** Evaluate a root-level `if` condition against the flat value map. */
function evalCond(node: any, values: Record<string, unknown>): Tri {
  if (!node || typeof node !== 'object') return null
  const parts: Tri[] = []
  if (Array.isArray(node.required)) {
    parts.push(node.required.every((f: string) => nonEmpty(values[f])) ? true : false)
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [attr, sub] of Object.entries(node.properties)) {
      parts.push(evalAttr(sub, values[attr]))
    }
  }
  if (Array.isArray(node.allOf)) parts.push(and3(node.allOf.map((s: any) => evalCond(s, values))))
  if (Array.isArray(node.anyOf)) parts.push(or3(node.anyOf.map((s: any) => evalCond(s, values))))
  if (node.not) {
    const r = evalCond(node.not, values)
    parts.push(r === null ? null : (!r as Tri))
  }
  if (parts.length === 0) return null
  return and3(parts)
}

/** Does this subtree contain a non-empty `required` array anywhere? */
function subtreeHasRequired(node: any): boolean {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node.required) && node.required.length > 0) return true
  return Object.values(node).some((v) => subtreeHasRequired(v))
}

/** Attributes a `then`/`else` branch makes required (top-level + nested). */
function extractRequired(branch: any): string[] {
  const out = new Set<string>()
  if (!branch || typeof branch !== 'object') return []
  if (Array.isArray(branch.required)) branch.required.forEach((f: string) => out.add(f))
  if (branch.properties && typeof branch.properties === 'object') {
    for (const [attr, sub] of Object.entries(branch.properties)) {
      if (subtreeHasRequired(sub)) out.add(attr)
    }
  }
  return [...out]
}

/** Best-effort trigger description for the hint message. */
function describeCondition(ifNode: any): { field?: string; value?: string } {
  if (!ifNode || typeof ifNode !== 'object') return {}
  let field: string | undefined
  let value: string | undefined
  if (ifNode.properties && typeof ifNode.properties === 'object') {
    const attrs = Object.keys(ifNode.properties)
    if (attrs.length) {
      field = attrs[0]
      value = findEnumOrConst(ifNode.properties[attrs[0]])
    }
  }
  if (!field && Array.isArray(ifNode.required) && ifNode.required.length) field = ifNode.required[0]
  return { field, value }
}
function findEnumOrConst(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node.enum) && node.enum.length) return String(node.enum[0])
  if (node.const !== undefined) return String(node.const)
  for (const v of Object.values(node)) {
    const r = findEnumOrConst(v)
    if (r !== undefined) return r
  }
  return undefined
}

/**
 * Given a product-type schema and the current flat values, return the attributes
 * that are CONDITIONALLY required right now (excluding those already statically
 * required). Pure + deterministic.
 */
export function evaluateConditionalRequirements(
  schema: any,
  values: Record<string, unknown>,
): ConditionalHint[] {
  const allOf = Array.isArray(schema?.allOf) ? schema.allOf : []
  const staticRequired = new Set<string>(Array.isArray(schema?.required) ? schema.required : [])
  const hints = new Map<string, ConditionalHint>()

  for (const rule of allOf) {
    if (!rule || typeof rule !== 'object' || !rule.if) continue
    const cond = evalCond(rule.if, values)
    let branch: any = null
    if (cond === true) branch = rule.then
    else if (cond === false && rule.else) branch = rule.else
    if (!branch) continue

    const because = describeCondition(rule.if)
    for (const f of extractRequired(branch)) {
      if (staticRequired.has(f)) continue // already always-required, not conditional
      if (!hints.has(f)) hints.set(f, { field: f, because })
    }
  }
  return [...hints.values()]
}

/**
 * Convenience for the Pre-Flight report: conditionally-required attributes that
 * are currently EMPTY → advisory WARNING issues (never errors; VALIDATION_PREVIEW
 * is the hard gate). `labelOf` maps a field id to a display label when available.
 */
export function conditionalRequirementIssues(
  schema: any,
  values: Record<string, unknown>,
  labelOf: (fieldId: string) => string = (f) => f,
): Array<{ field: string; severity: 'warning'; message: string }> {
  return evaluateConditionalRequirements(schema, values)
    .filter((h) => !nonEmpty(values[h.field]))
    .map((h) => {
      const trigger = h.because.field
        ? ` (required because ${labelOf(h.because.field)}${h.because.value ? ` = ${h.because.value}` : ' is set'})`
        : ''
      return { field: h.field, severity: 'warning' as const, message: `"${labelOf(h.field)}" is likely required${trigger}` }
    })
}
