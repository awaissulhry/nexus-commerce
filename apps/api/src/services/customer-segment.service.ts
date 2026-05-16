/**
 * CI.2 — Customer Segment service.
 *
 * Evaluates named cohort conditions against the Customer table. The
 * condition DSL reuses the same operators as AutomationRule (getFieldPath,
 * applyOperator) but maps to Prisma WHERE clauses for performance — rather
 * than loading all customers and filtering in JS, most conditions are
 * translated to indexed DB predicates.
 *
 * Supported condition fields:
 *   totalSpentCents   — BigInt (comparison ops: gt/gte/lt/lte/eq)
 *   totalOrders       — Int
 *   riskFlag          — String (eq/ne/in/exists)
 *   fiscalKind        — String (eq/ne/in)
 *   rfmLabel          — String (eq/ne/in)
 *   rfmScore          — String (eq/ne/contains)
 *   lastOrderAt       — DateTime as { daysAgo: N } in value
 *   firstOrderAt      — DateTime as { daysAgo: N } in value
 *   tags              — String array (contains op → has)
 *
 * Date fields accept a special value shape: { daysAgo: 30 } means
 * "within the last 30 days". This avoids storing absolute dates in the
 * DSL (which would require constant updates).
 */

import type { PrismaClient } from '@nexus/database'
import { logger } from '../utils/logger.js'

export interface SegmentCondition {
  field: string
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists'
  value?: unknown
}

// ── Condition → Prisma WHERE ───────────────────────────────────────────────

function resolveDate(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'daysAgo' in value) {
    const d = new Date()
    d.setDate(d.getDate() - Number((value as { daysAgo: number }).daysAgo))
    return d
  }
  if (typeof value === 'string') return new Date(value)
  return null
}

function conditionToWhere(cond: SegmentCondition): Record<string, unknown> | null {
  const { field, op, value } = cond

  // Date fields
  if (field === 'lastOrderAt' || field === 'firstOrderAt') {
    const date = resolveDate(value)
    if (!date) return null
    const dbOp = op === 'gte' || op === 'gt' ? 'gte'
      : op === 'lte' || op === 'lt' ? 'lte'
        : op === 'eq' ? 'equals'
          : null
    if (!dbOp) return null
    return { [field]: { [dbOp]: date } }
  }

  // Tags (string array)
  if (field === 'tags') {
    if (op === 'contains' || op === 'eq') return { tags: { has: String(value) } }
    if (op === 'in' && Array.isArray(value)) return { tags: { hasSome: value as string[] } }
    return null
  }

  // Numeric fields
  if (field === 'totalSpentCents' || field === 'totalOrders') {
    const numVal = Number(value)
    if (isNaN(numVal)) return null
    switch (op) {
      case 'gt': return { [field]: { gt: field === 'totalSpentCents' ? BigInt(numVal) : numVal } }
      case 'gte': return { [field]: { gte: field === 'totalSpentCents' ? BigInt(numVal) : numVal } }
      case 'lt': return { [field]: { lt: field === 'totalSpentCents' ? BigInt(numVal) : numVal } }
      case 'lte': return { [field]: { lte: field === 'totalSpentCents' ? BigInt(numVal) : numVal } }
      case 'eq': return { [field]: field === 'totalSpentCents' ? BigInt(numVal) : numVal }
      case 'ne': return { NOT: { [field]: field === 'totalSpentCents' ? BigInt(numVal) : numVal } }
    }
  }

  // String fields: riskFlag, fiscalKind, rfmLabel, rfmScore
  if (['riskFlag', 'fiscalKind', 'rfmLabel', 'rfmScore'].includes(field)) {
    switch (op) {
      case 'eq': return { [field]: String(value) }
      case 'ne': return { NOT: { [field]: String(value) } }
      case 'in': return { [field]: { in: Array.isArray(value) ? value as string[] : [String(value)] } }
      case 'contains': return { [field]: { contains: String(value) } }
      case 'exists': return { [field]: { not: null } }
    }
  }

  return null
}

function buildWhere(conditions: SegmentCondition[]): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = []
  for (const cond of conditions) {
    const w = conditionToWhere(cond)
    if (w) clauses.push(w)
  }
  return clauses.length > 0 ? { AND: clauses } : {}
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function evaluateSegment(
  prisma: PrismaClient,
  conditions: SegmentCondition[],
  opts: { limit?: number } = {},
): Promise<{ count: number; sampleIds: string[] }> {
  const where = buildWhere(conditions)
  const [count, sample] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      select: { id: true },
      take: opts.limit ?? 5,
      orderBy: { lastOrderAt: 'desc' },
    }),
  ])
  return { count, sampleIds: sample.map((c) => c.id) }
}

export async function listCustomersInSegment(
  prisma: PrismaClient,
  conditions: SegmentCondition[],
  opts: { limit?: number; offset?: number } = {},
) {
  const where = buildWhere(conditions)
  return prisma.customer.findMany({
    where,
    select: {
      id: true,
      email: true,
      name: true,
      totalOrders: true,
      totalSpentCents: true,
      lastOrderAt: true,
      rfmLabel: true,
      fiscalKind: true,
      tags: true,
    },
    take: opts.limit ?? 50,
    skip: opts.offset ?? 0,
    orderBy: { totalSpentCents: 'desc' },
  })
}

export async function recountAllSegments(prisma: PrismaClient): Promise<{ recounted: number }> {
  const segments = await prisma.customerSegment.findMany({
    select: { id: true, conditions: true },
  })

  let recounted = 0
  for (const seg of segments) {
    try {
      const conditions = seg.conditions as unknown as SegmentCondition[]
      const { count } = await evaluateSegment(prisma, conditions)
      await prisma.customerSegment.update({
        where: { id: seg.id },
        data: { customerCount: count, lastCountedAt: new Date() },
      })
      recounted++
    } catch (err) {
      logger.warn('segment-recount: segment failed', {
        segmentId: seg.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { recounted }
}
