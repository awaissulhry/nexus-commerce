/**
 * W7.4 — Bulk-ops AutomationRule CRUD routes.
 *
 * /api/bulk-automation-rules — scoped to domain='bulk-operations'.
 * Distinct from the /api/replenishment/automation-rules surface
 * (fulfillment.routes.ts) because:
 *   - the W7.5 visual builder lives at /bulk-operations/automation
 *     and shouldn't fan into a domain-mixed list
 *   - bulk-ops rules carry a different valid trigger set
 *     (BULK_OPS_TRIGGERS) — the create / update path validates
 *     against that whitelist
 *
 * The two surfaces share AutomationRule + AutomationRuleExecution
 * tables — `domain` is the discriminator. The W4 evaluator already
 * filters by domain so a bulk-ops rule never fires on the
 * replenishment cron and vice versa.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  BULK_OPS_TRIGGERS,
  BULK_OPS_ACTION_TYPES,
} from '../services/automation/bulk-ops-actions.js'
import {
  validateConditions,
  type ConditionsPayload,
} from '../services/automation/conditions-tree.js'
import {
  evaluateRule,
} from '../services/automation-rule.service.js'

const DOMAIN = 'bulk-operations'

const TRIGGER_SET = new Set<string>(BULK_OPS_TRIGGERS)
const ACTION_SET = new Set<string>(BULK_OPS_ACTION_TYPES)

interface CreateBody {
  name?: string
  description?: string | null
  trigger?: string
  conditions?: unknown
  actions?: unknown
  enabled?: boolean
  dryRun?: boolean
  maxExecutionsPerDay?: number | null
  maxValueCentsEur?: number | null
  createdBy?: string | null
}

interface DryRunBody {
  trigger?: string
  conditions?: unknown
  actions?: unknown
  context?: Record<string, unknown>
}

function validateActions(actions: unknown): { ok: boolean; error?: string } {
  if (actions === null || actions === undefined) return { ok: true }
  if (!Array.isArray(actions)) {
    return { ok: false, error: 'actions must be an array' }
  }
  for (const [i, a] of actions.entries()) {
    if (!a || typeof a !== 'object') {
      return { ok: false, error: `actions[${i}] must be an object` }
    }
    const type = (a as { type?: unknown }).type
    if (typeof type !== 'string') {
      return { ok: false, error: `actions[${i}].type must be a string` }
    }
    // Allow `notify` / `log_only` from the W4 base set + the W7.1
    // bulk-ops handlers. Any other type is a typo or stale rule.
    const isBuiltin = type === 'notify' || type === 'log_only'
    if (!isBuiltin && !ACTION_SET.has(type)) {
      return {
        ok: false,
        error: `actions[${i}].type '${type}' is not a known bulk-ops action type`,
      }
    }
  }
  return { ok: true }
}

const bulkAutomationRulesRoutes: FastifyPluginAsync = async (fastify) => {
  /** GET /api/bulk-automation-rules */
  fastify.get<{
    Querystring: { enabled?: string; trigger?: string; limit?: string }
  }>('/bulk-automation-rules', async (request, reply) => {
    try {
      const q = request.query
      const where: any = { domain: DOMAIN }
      if (q.enabled === 'true') where.enabled = true
      if (q.enabled === 'false') where.enabled = false
      if (q.trigger) where.trigger = q.trigger
      const rules = await prisma.automationRule.findMany({
        where,
        orderBy: [{ enabled: 'desc' }, { updatedAt: 'desc' }],
        take: Math.min(Math.max(q.limit ? Number(q.limit) : 100, 1), 500),
      })
      return reply.send({ success: true, rules })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /** GET /api/bulk-automation-rules/:id */
  fastify.get<{ Params: { id: string } }>(
    '/bulk-automation-rules/:id',
    async (request, reply) => {
      const rule = await prisma.automationRule.findUnique({
        where: { id: request.params.id },
      })
      if (!rule || rule.domain !== DOMAIN) {
        return reply
          .code(404)
          .send({ success: false, error: 'Rule not found' })
      }
      return reply.send({ success: true, rule })
    },
  )

  /** POST /api/bulk-automation-rules */
  fastify.post<{ Body: CreateBody }>(
    '/bulk-automation-rules',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.name || !body.name.trim()) {
        return reply
          .code(400)
          .send({ success: false, error: 'name is required' })
      }
      if (!body.trigger || !TRIGGER_SET.has(body.trigger)) {
        return reply.code(400).send({
          success: false,
          error: `trigger must be one of: ${Array.from(TRIGGER_SET).join(', ')}`,
        })
      }
      const condCheck = validateConditions(
        (body.conditions ?? null) as ConditionsPayload,
      )
      if (!condCheck.ok) {
        return reply
          .code(400)
          .send({ success: false, error: `conditions: ${condCheck.error}` })
      }
      const actCheck = validateActions(body.actions ?? [])
      if (!actCheck.ok) {
        return reply
          .code(400)
          .send({ success: false, error: actCheck.error })
      }
      try {
        const rule = await prisma.automationRule.create({
          data: {
            name: body.name.trim(),
            description: body.description ?? null,
            domain: DOMAIN,
            trigger: body.trigger,
            conditions: (body.conditions ?? []) as never,
            actions: (body.actions ?? []) as never,
            enabled: body.enabled ?? false,
            dryRun: body.dryRun ?? true,
            maxExecutionsPerDay:
              body.maxExecutionsPerDay === null
                ? null
                : (body.maxExecutionsPerDay ?? 100),
            maxValueCentsEur: body.maxValueCentsEur ?? null,
            createdBy: body.createdBy ?? null,
          },
        })
        return reply.code(201).send({ success: true, rule })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /** PATCH /api/bulk-automation-rules/:id */
  fastify.patch<{
    Params: { id: string }
    Body: Partial<CreateBody>
  }>('/bulk-automation-rules/:id', async (request, reply) => {
    const { id } = request.params
    const existing = await prisma.automationRule.findUnique({ where: { id } })
    if (!existing || existing.domain !== DOMAIN) {
      return reply.code(404).send({ success: false, error: 'Rule not found' })
    }
    const body = request.body ?? {}
    if (body.trigger !== undefined && !TRIGGER_SET.has(body.trigger)) {
      return reply.code(400).send({
        success: false,
        error: `trigger must be one of: ${Array.from(TRIGGER_SET).join(', ')}`,
      })
    }
    if (body.conditions !== undefined) {
      const r = validateConditions(body.conditions as ConditionsPayload)
      if (!r.ok) {
        return reply
          .code(400)
          .send({ success: false, error: `conditions: ${r.error}` })
      }
    }
    if (body.actions !== undefined) {
      const r = validateActions(body.actions)
      if (!r.ok) {
        return reply.code(400).send({ success: false, error: r.error })
      }
    }
    const data: any = {}
    if (body.name !== undefined) data.name = body.name.trim()
    if (body.description !== undefined) data.description = body.description
    if (body.trigger !== undefined) data.trigger = body.trigger
    if (body.conditions !== undefined) data.conditions = body.conditions
    if (body.actions !== undefined) data.actions = body.actions
    if (body.enabled !== undefined) data.enabled = body.enabled
    if (body.dryRun !== undefined) data.dryRun = body.dryRun
    if (body.maxExecutionsPerDay !== undefined)
      data.maxExecutionsPerDay = body.maxExecutionsPerDay
    if (body.maxValueCentsEur !== undefined)
      data.maxValueCentsEur = body.maxValueCentsEur
    const rule = await prisma.automationRule.update({ where: { id }, data })
    return reply.send({ success: true, rule })
  })

  /** DELETE /api/bulk-automation-rules/:id */
  fastify.delete<{ Params: { id: string } }>(
    '/bulk-automation-rules/:id',
    async (request, reply) => {
      const existing = await prisma.automationRule.findUnique({
        where: { id: request.params.id },
      })
      if (!existing || existing.domain !== DOMAIN) {
        return reply
          .code(404)
          .send({ success: false, error: 'Rule not found' })
      }
      await prisma.automationRule.delete({ where: { id: request.params.id } })
      return reply.send({ success: true })
    },
  )

  /**
   * POST /api/bulk-automation-rules/:id/dry-run
   *
   * W7.6 dry-run: evaluate the rule against a caller-supplied
   * context, with forceDryRun=true so any matching action runs in
   * preview mode (returns substitutedPayload / wouldPause counts /
   * etc. instead of writing).
   */
  fastify.post<{
    Params: { id: string }
    Body: { context?: Record<string, unknown> }
  }>('/bulk-automation-rules/:id/dry-run', async (request, reply) => {
    const existing = await prisma.automationRule.findUnique({
      where: { id: request.params.id },
    })
    if (!existing || existing.domain !== DOMAIN) {
      return reply.code(404).send({ success: false, error: 'Rule not found' })
    }
    try {
      const result = await evaluateRule({
        ruleId: request.params.id,
        context: request.body?.context ?? {},
        forceDryRun: true,
      })
      return reply.send({ success: true, result })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(
        `[bulk-automation-rules] dry-run failed for ${request.params.id}: ${msg}`,
      )
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /**
   * GET /api/bulk-automation-rules/:id/executions
   *
   * List AutomationRuleExecution rows for a bulk-ops rule, newest
   * first. Powers the W7.8 history surface — operators drill into a
   * rule and see what fired, when, in what mode, with what outcome.
   */
  fastify.get<{
    Params: { id: string }
    Querystring: { status?: string; limit?: string }
  }>(
    '/bulk-automation-rules/:id/executions',
    async (request, reply) => {
      const rule = await prisma.automationRule.findUnique({
        where: { id: request.params.id },
        select: { domain: true },
      })
      if (!rule || rule.domain !== DOMAIN) {
        return reply
          .code(404)
          .send({ success: false, error: 'Rule not found' })
      }
      const where: any = { ruleId: request.params.id }
      if (request.query.status) where.status = request.query.status
      const executions = await prisma.automationRuleExecution.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: Math.min(
          Math.max(request.query.limit ? Number(request.query.limit) : 100, 1),
          500,
        ),
      })
      return reply.send({ success: true, executions })
    },
  )

  /**
   * POST /api/bulk-automation-rules/dry-run-inline
   *
   * Evaluate an unsaved rule shape against a context. Used by the
   * visual builder so operators see what their rule WOULD do before
   * saving. No DB row gets created or updated.
   */
  fastify.post<{ Body: DryRunBody }>(
    '/bulk-automation-rules/dry-run-inline',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.trigger || !TRIGGER_SET.has(body.trigger)) {
        return reply.code(400).send({
          success: false,
          error: `trigger must be one of: ${Array.from(TRIGGER_SET).join(', ')}`,
        })
      }
      const condCheck = validateConditions(
        (body.conditions ?? null) as ConditionsPayload,
      )
      if (!condCheck.ok) {
        return reply
          .code(400)
          .send({ success: false, error: `conditions: ${condCheck.error}` })
      }
      const actCheck = validateActions(body.actions ?? [])
      if (!actCheck.ok) {
        return reply
          .code(400)
          .send({ success: false, error: actCheck.error })
      }
      try {
        const { evaluateConditions } = await import(
          '../services/automation/conditions-tree.js'
        )
        const matched = evaluateConditions(
          (body.conditions ?? null) as ConditionsPayload,
          body.context ?? {},
        )
        return reply.send({
          success: true,
          matched,
          // We don't actually fire the actions here — the visual
          // builder uses this to preview "would this rule match my
          // sample context?" before saving. The :id/dry-run path
          // above is the one that fires actions in preview mode.
          actionsPreview: matched
            ? Array.isArray(body.actions)
              ? body.actions
              : []
            : [],
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return reply.code(400).send({ success: false, error: msg })
      }
    },
  )
}

export default bulkAutomationRulesRoutes
