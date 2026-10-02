/**
 * MCP full control 08 S5 — the pricing rule and repricer status reads, out of the routes, so the pricing pages and Claude's pricing tools read the same
 * thing. Each function is the body of its route, moved as it was (pricing-read.vitest.test.ts holds the routes'
 * answers): the route keeps its error handling and returns what the function returns.
 *
 *   listActivePricingRules        GET /api/pricing-rules
 *   listPricingRulesForVariation  GET /api/pricing-rules/variation/:variationId
 *   readRepricerStatus            GET /api/pricing/repricer-status
 *   createPricingRule             POST /api/pricing-rules                (08 S12)
 *   updatePricingRule             PUT /api/pricing-rules/:id
 *   deactivatePricingRule         DELETE /api/pricing-rules/:id           (soft: isActive = false)
 * A refusal is a PricingRuleError carrying the status and the sentence the route answers with.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'

/** GET /api/pricing-rules — the active pricing rules, by priority. */
export async function listActivePricingRules() {
  const rules = await prisma.pricingRule.findMany({
    where: { isActive: true },
    orderBy: { priority: 'asc' },
  })
  return rules
}

/** GET /api/pricing-rules/variation/:variationId — the active rules linked to one variation. */
export async function listPricingRulesForVariation(variationId: string) {
  const links = await prisma.pricingRuleVariation.findMany({
    where: { variationId },
    include: { rule: true },
    orderBy: { rule: { priority: 'asc' } },
  })
  // Filter out inactive rules (link can outlive deactivation).
  return links.map((l) => l.rule).filter((r) => r.isActive)
}

/** GET /api/pricing/repricer-status — the repricer switches this process sees, and its latest five ticks. */
export async function readRepricerStatus() {
  const recent = await prisma.auditLog.findMany({
    where: { entityType: 'RepricerRun' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      entityId: true,
      action: true,
      after: true,
      createdAt: true,
    },
  })
  // Server can't reliably read the env vars on the client without
  // exposing them, but it CAN tell the client what state THIS process
  // sees — and that's what matters for "is the cron firing?".
  const liveMode = process.env.NEXUS_REPRICER_LIVE === '1'
  const cronEnabled = process.env.NEXUS_ENABLE_PRICING_CRON === '1'
  const thresholdPct = Math.max(
    0,
    Number(process.env.NEXUS_REPRICER_THRESHOLD_PCT ?? '1'),
  )
  return {
    config: { cronEnabled, liveMode, thresholdPct },
    ticks: recent.map((r) => {
      const after = (r.after ?? {}) as any
      return {
        runId: r.entityId,
        action: r.action,
        occurredAt: r.createdAt,
        liveMode: after.liveMode ?? false,
        snapshotsScanned: after.snapshotsScanned ?? 0,
        enqueued: after.enqueued ?? 0,
        dryRunWouldEnqueue: after.dryRunWouldEnqueue ?? 0,
        skippedSubThreshold: after.skippedSubThreshold ?? 0,
        durationMs: after.durationMs ?? 0,
      }
    }),
  }
}

// ── 08 S12 — the writes ─────────────────────────────────────────────────────────────────────────────────

export const PRICING_RULE_TYPES = ['MATCH_LOW', 'PERCENTAGE_BELOW', 'COST_PLUS_MARGIN', 'FIXED_PRICE', 'DYNAMIC_MARGIN'] as const
const VALID_TYPES = new Set<string>(PRICING_RULE_TYPES)

export class PricingRuleError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message)
    this.name = 'PricingRuleError'
  }
}

export interface PricingRuleInput {
  name?: string
  type?: string
  description?: string
  priority?: number
  minMarginPercent?: number | null
  maxMarginPercent?: number | null
  parameters?: Record<string, unknown>
  productIds?: string[]
  variationIds?: string[]
  isActive?: boolean
}

/** Create a rule (and its product / variation links) with its audit row, in one transaction. */
export async function createPricingRule(body: PricingRuleInput) {
  if (!body.name || typeof body.name !== 'string') throw new PricingRuleError(400, 'name is required')
  if (!body.type || !VALID_TYPES.has(body.type)) {
    throw new PricingRuleError(400, `type must be one of ${[...VALID_TYPES].join(', ')}`)
  }
  const priority = Number.isFinite(body.priority) ? Number(body.priority) : 100
  // D.3 — Wrap rule create + AuditLog write in one transaction so the
  // audit row never desyncs from the catalog state. Same pattern
  // MasterPriceService uses for basePrice mutations.
  return prisma.$transaction(async (tx) => {
    const created = await tx.pricingRule.create({
      data: {
        name: body.name!,
        type: body.type!,
        description: body.description ?? null,
        priority,
        minMarginPercent:
          body.minMarginPercent != null
            ? new Prisma.Decimal(body.minMarginPercent)
            : null,
        maxMarginPercent:
          body.maxMarginPercent != null
            ? new Prisma.Decimal(body.maxMarginPercent)
            : null,
        parameters: (body.parameters ?? {}) as Prisma.InputJsonValue,
        isActive: true,
        products:
          body.productIds && body.productIds.length > 0
            ? {
                create: body.productIds.map((productId) => ({ productId })),
              }
            : undefined,
        variations:
          body.variationIds && body.variationIds.length > 0
            ? {
                create: body.variationIds.map((variationId) => ({
                  variationId,
                })),
              }
            : undefined,
      },
    })
    await tx.auditLog.create({
      data: {
        entityType: 'PricingRule',
        entityId: created.id,
        action: 'create',
        before: null as never,
        // Slim after — only the operator-meaningful fields, not full
        // join-row dumps. Schema notes the table balloons otherwise.
        after: {
          name: created.name,
          type: created.type,
          priority: created.priority,
          minMarginPercent: created.minMarginPercent?.toString() ?? null,
          maxMarginPercent: created.maxMarginPercent?.toString() ?? null,
          parameters: created.parameters,
        },
        metadata: {
          productCount: body.productIds?.length ?? 0,
          variationCount: body.variationIds?.length ?? 0,
        },
      },
    })
    return created
  })
}

/** Update a rule's fields (partial), with before and after on its audit row, in one transaction. */
export async function updatePricingRule(id: string, body: PricingRuleInput) {
  const data: Prisma.PricingRuleUpdateInput = {}
  if (body.name !== undefined) data.name = body.name
  if (body.type !== undefined) {
    if (!VALID_TYPES.has(body.type)) {
      throw new PricingRuleError(400, `type must be one of ${[...VALID_TYPES].join(', ')}`)
    }
    data.type = body.type
  }
  if (body.description !== undefined) data.description = body.description
  if (body.priority !== undefined && Number.isFinite(body.priority)) {
    data.priority = Number(body.priority)
  }
  if (body.minMarginPercent !== undefined) {
    data.minMarginPercent =
      body.minMarginPercent == null
        ? null
        : new Prisma.Decimal(body.minMarginPercent)
  }
  if (body.maxMarginPercent !== undefined) {
    data.maxMarginPercent =
      body.maxMarginPercent == null
        ? null
        : new Prisma.Decimal(body.maxMarginPercent)
  }
  if (body.parameters !== undefined) {
    data.parameters = body.parameters as Prisma.InputJsonValue
  }
  if (body.isActive !== undefined) data.isActive = body.isActive

  // D.3 — capture before snapshot + write audit row in same tx.
  return prisma.$transaction(async (tx) => {
    const before = await tx.pricingRule.findUnique({ where: { id } })
    if (!before) throw new PricingRuleError(404, 'rule not found')
    const updated = await tx.pricingRule.update({ where: { id }, data })
    await tx.auditLog.create({
      data: {
        entityType: 'PricingRule',
        entityId: updated.id,
        action: 'update',
        before: {
          name: before.name,
          type: before.type,
          priority: before.priority,
          minMarginPercent: before.minMarginPercent?.toString() ?? null,
          maxMarginPercent: before.maxMarginPercent?.toString() ?? null,
          parameters: before.parameters,
          isActive: before.isActive,
        } as Prisma.InputJsonValue,
        after: {
          name: updated.name,
          type: updated.type,
          priority: updated.priority,
          minMarginPercent: updated.minMarginPercent?.toString() ?? null,
          maxMarginPercent: updated.maxMarginPercent?.toString() ?? null,
          parameters: updated.parameters,
          isActive: updated.isActive,
        } as Prisma.InputJsonValue,
      },
    })
    return updated
  })
}

/**
 * Soft delete: flip isActive=false. Preserves the audit trail (the engine's PRICING_RULE source path filters by
 * isActive=true so a deactivated rule has no functional effect, just an archive entry).
 */
export async function deactivatePricingRule(id: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.pricingRule.findUnique({ where: { id } })
    if (!before) throw new PricingRuleError(404, 'rule not found')
    const updated = await tx.pricingRule.update({ where: { id }, data: { isActive: false } })
    await tx.auditLog.create({
      data: {
        entityType: 'PricingRule',
        entityId: updated.id,
        action: 'delete',
        before: { isActive: before.isActive },
        after: { isActive: false },
        metadata: { soft: true, ruleName: before.name },
      },
    })
    return updated
  })
}

