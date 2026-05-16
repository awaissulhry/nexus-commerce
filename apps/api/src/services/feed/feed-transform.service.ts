/**
 * CE.1 — Feed Transform Engine.
 *
 * Evaluates FeedTransformRule rows against a Product to produce a
 * channel-specific attribute package (Record<field, value>).
 *
 * Rules are first-match-wins per field: the lowest-priority rule that
 * matches the condition for a given field wins; subsequent rules for the
 * same field are skipped.
 *
 * Action types:
 *   set      — replace the current value with a literal string
 *   append   — concatenate value to the end of the source field
 *   prepend  — concatenate value to the start of the source field
 *   template — interpolate {field} placeholders from the product object
 *
 * Condition evaluation reuses getFieldPath + applyOperator from the
 * AutomationRule service (same DSL, no duplication).
 */

import type { PrismaClient, FeedTransformRule } from '@nexus/database'
import { getFieldPath, applyOperator, type Condition, type ConditionOp } from '../automation-rule.service.js'
import { logger } from '../../utils/logger.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface TransformCondition {
  field: string
  op: ConditionOp
  value?: unknown
}

export interface TransformAction {
  type: 'set' | 'append' | 'prepend' | 'template'
  value?: string
  template?: string
}

export interface FieldResult {
  field: string
  value: string
  ruleId: string
  ruleName: string
  actionType: string
  conditionMatched: boolean
}

export interface TransformPackage {
  channel: string
  marketplace: string | null
  fields: FieldResult[]
  /** Resolved field→value map, ready to validate or push to OutboundSyncQueue */
  resolved: Record<string, string>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function interpolateTemplate(template: string, product: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const val = product[key]
    return val != null ? String(val) : ''
  })
}

function resolveSourceValue(field: string, product: Record<string, unknown>): string {
  const val = getFieldPath(product, field)
  return val != null ? String(val) : ''
}

function applyAction(action: TransformAction, product: Record<string, unknown>, field: string): string {
  const source = resolveSourceValue(field, product)
  switch (action.type) {
    case 'set':
      return action.value ?? ''
    case 'append':
      return source + (action.value ?? '')
    case 'prepend':
      return (action.value ?? '') + source
    case 'template':
      return action.template ? interpolateTemplate(action.template, product) : source
    default:
      return source
  }
}

function ruleMatchesCondition(rule: FeedTransformRule, product: Record<string, unknown>): boolean {
  if (rule.condition == null) return true
  const cond = rule.condition as unknown as TransformCondition
  if (!cond.field || !cond.op) return true
  const lhs = getFieldPath(product, cond.field)
  return applyOperator(cond.op as Condition['op'], lhs, cond.value)
}

// ── Main evaluator ─────────────────────────────────────────────────────────

/**
 * Load and evaluate all enabled rules for (channel, marketplace) against
 * the given product. Returns a TransformPackage with resolved field values
 * and per-field audit trail.
 *
 * marketplace=null rules apply to all markets; specific marketplace rules
 * are preferred over null-marketplace rules (specificity ordering via priority).
 */
export async function evaluateRules(
  prisma: PrismaClient,
  product: Record<string, unknown>,
  channel: string,
  marketplace: string | null,
): Promise<TransformPackage> {
  const channelUp = channel.toUpperCase()
  const marketUp = marketplace?.toUpperCase() ?? null

  // Load rules matching this channel (or ALL) and marketplace (or null)
  const rules = await prisma.feedTransformRule.findMany({
    where: {
      enabled: true,
      channel: { in: [channelUp, 'ALL'] },
      OR: [{ marketplace: marketUp }, { marketplace: null }],
    },
    orderBy: [
      { field: 'asc' },
      { priority: 'asc' },
      { createdAt: 'asc' },
    ],
  })

  // Specific marketplace rules outrank null-marketplace rules at same priority
  // by sorting specific before null within same priority bucket
  rules.sort((a, b) => {
    if (a.field !== b.field) return a.field.localeCompare(b.field)
    if (a.priority !== b.priority) return a.priority - b.priority
    // same priority: marketplace-specific beats null
    if (a.marketplace && !b.marketplace) return -1
    if (!a.marketplace && b.marketplace) return 1
    return 0
  })

  const fieldResults: FieldResult[] = []
  const resolved: Record<string, string> = {}
  const settledFields = new Set<string>()

  for (const rule of rules) {
    if (settledFields.has(rule.field)) continue
    const matched = ruleMatchesCondition(rule, product)
    if (!matched) continue

    const action = rule.action as unknown as TransformAction
    const value = applyAction(action, product, rule.field)

    fieldResults.push({
      field: rule.field,
      value,
      ruleId: rule.id,
      ruleName: rule.name,
      actionType: action.type ?? 'set',
      conditionMatched: true,
    })
    resolved[rule.field] = value
    settledFields.add(rule.field)
  }

  return {
    channel: channelUp,
    marketplace: marketUp,
    fields: fieldResults,
    resolved,
  }
}

// ── CRUD helpers ───────────────────────────────────────────────────────────

export async function listRules(
  prisma: PrismaClient,
  filters: { channel?: string; enabled?: boolean } = {},
) {
  const where: Record<string, unknown> = {}
  if (filters.channel) where.channel = filters.channel.toUpperCase()
  if (typeof filters.enabled === 'boolean') where.enabled = filters.enabled
  return prisma.feedTransformRule.findMany({
    where,
    orderBy: [{ field: 'asc' }, { priority: 'asc' }],
  })
}

export async function createRule(
  prisma: PrismaClient,
  data: {
    name: string
    description?: string
    channel: string
    marketplace?: string | null
    field: string
    priority?: number
    enabled?: boolean
    condition?: TransformCondition | null
    action: TransformAction
    createdBy?: string
  },
) {
  return prisma.feedTransformRule.create({
    data: {
      name: data.name,
      description: data.description,
      channel: data.channel.toUpperCase(),
      marketplace: data.marketplace?.toUpperCase() ?? null,
      field: data.field,
      priority: data.priority ?? 100,
      enabled: data.enabled ?? true,
      condition: (data.condition ?? null) as never,
      action: data.action as never,
      createdBy: data.createdBy,
    },
  })
}

export async function updateRule(
  prisma: PrismaClient,
  id: string,
  data: Partial<{
    name: string
    description: string
    channel: string
    marketplace: string | null
    field: string
    priority: number
    enabled: boolean
    condition: TransformCondition | null
    action: TransformAction
  }>,
) {
  const { condition, action, channel, marketplace, ...rest } = data
  return prisma.feedTransformRule.update({
    where: { id },
    data: {
      ...rest,
      ...(channel !== undefined ? { channel: channel.toUpperCase() } : {}),
      ...(marketplace !== undefined ? { marketplace: marketplace?.toUpperCase() ?? null } : {}),
      ...(condition !== undefined ? { condition: (condition ?? null) as never } : {}),
      ...(action !== undefined ? { action: action as never } : {}),
      updatedAt: new Date(),
    },
  })
}

export async function deleteRule(prisma: PrismaClient, id: string) {
  return prisma.feedTransformRule.delete({ where: { id } })
}
