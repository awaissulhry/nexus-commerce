/**
 * W7.3 — Tree-based Conditions DSL.
 *
 * The W4-era engine matches a flat AND-list of Conditions. Operators
 * writing real bulk-ops rules want OR / NOT / nesting:
 *
 *   "fire when (failureRate > 0.2 AND totalItems > 100) OR
 *               (status = 'FAILED' AND retryCount = 0)"
 *
 * This module ships a tree evaluator that's a strict superset of the
 * flat list. The evaluator dispatches on `kind`:
 *
 *   { kind: 'leaf', field, op, value }
 *   { kind: 'and', children: ConditionNode[] }
 *   { kind: 'or',  children: ConditionNode[] }
 *   { kind: 'not', child: ConditionNode }
 *
 * Backwards compatibility: when AutomationRule.conditions is an array
 * of legacy {field, op, value} objects (no `kind`), evaluateTree wraps
 * them in an implicit AND. The flat matcher in the W4 service still
 * works on those rows.
 *
 * Pure functions only. No DB / Prisma — the evaluator runs against
 * already-fetched context bags. Operator-facing rule editor (W7.5)
 * builds the tree client-side and POSTs the JSON to /automation-rules.
 */

import {
  applyOperator,
  getFieldPath,
  type Condition as LegacyCondition,
  type ConditionOp,
} from '../automation-rule.service.js'

// Re-export for callers that want the legacy shape.
export type { ConditionOp }

export interface LeafCondition {
  kind: 'leaf'
  field: string
  op: ConditionOp
  value?: unknown
}

export interface AndNode {
  kind: 'and'
  children: ConditionNode[]
}

export interface OrNode {
  kind: 'or'
  children: ConditionNode[]
}

export interface NotNode {
  kind: 'not'
  child: ConditionNode
}

export type ConditionNode = LeafCondition | AndNode | OrNode | NotNode

/**
 * The persisted JSON shape on AutomationRule.conditions. Either a
 * legacy flat array (W4) or the new tree root.
 */
export type ConditionsPayload = LegacyCondition[] | ConditionNode | null

/**
 * Detect whether a value is a tree root vs a legacy flat list. Empty
 * array, undefined, and null all count as "no conditions" (matches
 * everything).
 */
export function isLegacyFlatList(payload: unknown): payload is LegacyCondition[] {
  return Array.isArray(payload)
}

export function isConditionNode(payload: unknown): payload is ConditionNode {
  if (!payload || typeof payload !== 'object') return false
  const k = (payload as { kind?: unknown }).kind
  return k === 'leaf' || k === 'and' || k === 'or' || k === 'not'
}

/**
 * Evaluate a flat legacy list as an implicit AND of its leaves.
 * Empty list is true (matches the W4 contract verbatim).
 */
function evaluateFlatList(
  list: LegacyCondition[],
  context: unknown,
): boolean {
  for (const c of list) {
    const lhs = getFieldPath(context, c.field)
    if (!applyOperator(c.op, lhs, c.value)) return false
  }
  return true
}

/**
 * Recursive evaluator for the tree shape. Throws on an unknown
 * `kind` so a corrupted DB row surfaces loudly rather than silently
 * matching false (which would look like "rule never fires" forever).
 */
export function evaluateTreeNode(
  node: ConditionNode,
  context: unknown,
): boolean {
  switch (node.kind) {
    case 'leaf': {
      const lhs = getFieldPath(context, node.field)
      return applyOperator(node.op, lhs, node.value)
    }
    case 'and': {
      // Empty children short-circuit true (matches "no conditions"
      // semantics from the legacy flat list).
      if (node.children.length === 0) return true
      for (const c of node.children) {
        if (!evaluateTreeNode(c, context)) return false
      }
      return true
    }
    case 'or': {
      // Empty children short-circuit false (no branch can be true).
      if (node.children.length === 0) return false
      for (const c of node.children) {
        if (evaluateTreeNode(c, context)) return true
      }
      return false
    }
    case 'not': {
      return !evaluateTreeNode(node.child, context)
    }
    default: {
      // Exhaustiveness check
      const _exhaustive: never = node
      throw new Error(
        `Unknown condition node kind: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}

/**
 * Single entry point the engine calls. Accepts either persisted
 * shape; empty / null payload matches everything.
 */
export function evaluateConditions(
  payload: ConditionsPayload,
  context: unknown,
): boolean {
  if (payload === null || payload === undefined) return true
  if (isLegacyFlatList(payload)) {
    return evaluateFlatList(payload, context)
  }
  if (isConditionNode(payload)) {
    return evaluateTreeNode(payload, context)
  }
  // Unknown shape — refuse to silently match-true. A typo'd
  // condition tree should never silently fire actions.
  throw new Error(
    `evaluateConditions: unrecognised payload shape (${typeof payload})`,
  )
}

/**
 * Static validator: walks a tree and reports the first issue it
 * finds. Used by the route layer to reject bad JSON at create time
 * so rules in the DB are always evaluable.
 */
export function validateConditions(payload: ConditionsPayload): {
  ok: boolean
  error?: string
} {
  if (payload === null || payload === undefined) return { ok: true }
  if (isLegacyFlatList(payload)) {
    for (const [i, c] of payload.entries()) {
      if (!c || typeof c !== 'object') {
        return { ok: false, error: `condition[${i}] is not an object` }
      }
      if (typeof c.field !== 'string' || c.field.length === 0) {
        return {
          ok: false,
          error: `condition[${i}].field must be a non-empty string`,
        }
      }
      if (typeof c.op !== 'string' || !KNOWN_OPS.has(c.op)) {
        return {
          ok: false,
          error: `condition[${i}].op '${c.op}' is not a known operator`,
        }
      }
    }
    return { ok: true }
  }
  if (isConditionNode(payload)) {
    return validateNode(payload, '$')
  }
  return { ok: false, error: `payload is neither legacy list nor tree` }
}

const KNOWN_OPS = new Set<string>([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'contains',
  'exists',
])

function validateNode(node: ConditionNode, path: string): {
  ok: boolean
  error?: string
} {
  switch (node.kind) {
    case 'leaf':
      if (typeof node.field !== 'string' || node.field.length === 0) {
        return {
          ok: false,
          error: `${path}.field must be a non-empty string`,
        }
      }
      if (!KNOWN_OPS.has(node.op)) {
        return {
          ok: false,
          error: `${path}.op '${node.op}' is not a known operator`,
        }
      }
      return { ok: true }
    case 'and':
    case 'or':
      if (!Array.isArray(node.children)) {
        return {
          ok: false,
          error: `${path}.children must be an array`,
        }
      }
      for (const [i, c] of node.children.entries()) {
        const r = validateNode(c, `${path}.${node.kind}[${i}]`)
        if (!r.ok) return r
      }
      return { ok: true }
    case 'not':
      if (!node.child) {
        return { ok: false, error: `${path}.child is required for 'not'` }
      }
      return validateNode(node.child, `${path}.not`)
    default: {
      const _exhaustive: never = node
      return {
        ok: false,
        error: `${path} has unknown kind: ${JSON.stringify(_exhaustive)}`,
      }
    }
  }
}
