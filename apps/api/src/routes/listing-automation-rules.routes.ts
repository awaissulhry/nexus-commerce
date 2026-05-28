/**
 * OL.D — Listings-domain AutomationRule CRUD routes.
 *
 * /api/listing-automation-rules — scoped to domain='listings'. Mirrors
 * the bulk-ops surface (bulk-automation-rules.routes.ts) but with the
 * listings trigger/action whitelist. Shares the AutomationRule +
 * AutomationRuleExecution tables; `domain` is the discriminator, so the
 * listing-automation-evaluator cron only ever fires these rules.
 *
 * The side-effect import below registers the listings action handlers on
 * the shared engine the first time these routes load.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { validateConditions, type ConditionsPayload } from '../services/automation/conditions-tree.js'
import { evaluateRule } from '../services/automation-rule.service.js'
import { LISTING_TRIGGERS, LISTING_ACTION_TYPES } from '../services/listing-automation/triggers.js'
import '../services/listing-automation/action-handlers.js' // side-effect: register handlers

const DOMAIN = 'listings'
const TRIGGER_SET = new Set<string>(LISTING_TRIGGERS)
const ACTION_SET = new Set<string>(LISTING_ACTION_TYPES)

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

function validateActions(actions: unknown): { ok: boolean; error?: string } {
  if (actions === null || actions === undefined) return { ok: true }
  if (!Array.isArray(actions)) return { ok: false, error: 'actions must be an array' }
  for (const [i, a] of actions.entries()) {
    if (!a || typeof a !== 'object') return { ok: false, error: `actions[${i}] must be an object` }
    const type = (a as { type?: unknown }).type
    if (typeof type !== 'string') return { ok: false, error: `actions[${i}].type must be a string` }
    const isBuiltin = type === 'notify' || type === 'log_only'
    if (!isBuiltin && !ACTION_SET.has(type)) {
      return { ok: false, error: `actions[${i}].type '${type}' is not a known listings action type` }
    }
  }
  return { ok: true }
}

const listingAutomationRulesRoutes: FastifyPluginAsync = async (fastify) => {
  /** GET /api/listing-automation-rules */
  fastify.get<{ Querystring: { enabled?: string; trigger?: string; limit?: string } }>(
    '/listing-automation-rules',
    async (request, reply) => {
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
        return reply.send({ success: true, rules, triggers: LISTING_TRIGGERS, actionTypes: LISTING_ACTION_TYPES })
      } catch (e) {
        return reply.code(500).send({ success: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  )

  /** GET /api/listing-automation-rules/:id */
  fastify.get<{ Params: { id: string } }>('/listing-automation-rules/:id', async (request, reply) => {
    const rule = await prisma.automationRule.findUnique({ where: { id: request.params.id } })
    if (!rule || rule.domain !== DOMAIN) return reply.code(404).send({ success: false, error: 'Rule not found' })
    return reply.send({ success: true, rule })
  })

  /** POST /api/listing-automation-rules */
  fastify.post<{ Body: CreateBody }>('/listing-automation-rules', async (request, reply) => {
    const body = request.body ?? {}
    if (!body.name || !body.name.trim()) return reply.code(400).send({ success: false, error: 'name is required' })
    if (!body.trigger || !TRIGGER_SET.has(body.trigger)) {
      return reply.code(400).send({ success: false, error: `trigger must be one of: ${Array.from(TRIGGER_SET).join(', ')}` })
    }
    const condCheck = validateConditions((body.conditions ?? null) as ConditionsPayload)
    if (!condCheck.ok) return reply.code(400).send({ success: false, error: `conditions: ${condCheck.error}` })
    const actCheck = validateActions(body.actions ?? [])
    if (!actCheck.ok) return reply.code(400).send({ success: false, error: actCheck.error })
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
          maxExecutionsPerDay: body.maxExecutionsPerDay === null ? null : (body.maxExecutionsPerDay ?? 100),
          maxValueCentsEur: body.maxValueCentsEur ?? null,
          createdBy: body.createdBy ?? null,
        },
      })
      return reply.code(201).send({ success: true, rule })
    } catch (e) {
      return reply.code(500).send({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  /** PATCH /api/listing-automation-rules/:id */
  fastify.patch<{ Params: { id: string }; Body: Partial<CreateBody> }>(
    '/listing-automation-rules/:id',
    async (request, reply) => {
      const { id } = request.params
      const existing = await prisma.automationRule.findUnique({ where: { id } })
      if (!existing || existing.domain !== DOMAIN) return reply.code(404).send({ success: false, error: 'Rule not found' })
      const body = request.body ?? {}
      if (body.trigger !== undefined && !TRIGGER_SET.has(body.trigger)) {
        return reply.code(400).send({ success: false, error: `trigger must be one of: ${Array.from(TRIGGER_SET).join(', ')}` })
      }
      if (body.conditions !== undefined) {
        const r = validateConditions(body.conditions as ConditionsPayload)
        if (!r.ok) return reply.code(400).send({ success: false, error: `conditions: ${r.error}` })
      }
      if (body.actions !== undefined) {
        const r = validateActions(body.actions)
        if (!r.ok) return reply.code(400).send({ success: false, error: r.error })
      }
      const data: any = {}
      if (body.name !== undefined) data.name = body.name.trim()
      if (body.description !== undefined) data.description = body.description
      if (body.trigger !== undefined) data.trigger = body.trigger
      if (body.conditions !== undefined) data.conditions = body.conditions
      if (body.actions !== undefined) data.actions = body.actions
      if (body.enabled !== undefined) data.enabled = body.enabled
      if (body.dryRun !== undefined) data.dryRun = body.dryRun
      if (body.maxExecutionsPerDay !== undefined) data.maxExecutionsPerDay = body.maxExecutionsPerDay
      if (body.maxValueCentsEur !== undefined) data.maxValueCentsEur = body.maxValueCentsEur
      const rule = await prisma.automationRule.update({ where: { id }, data })
      return reply.send({ success: true, rule })
    },
  )

  /** DELETE /api/listing-automation-rules/:id */
  fastify.delete<{ Params: { id: string } }>('/listing-automation-rules/:id', async (request, reply) => {
    const existing = await prisma.automationRule.findUnique({ where: { id: request.params.id } })
    if (!existing || existing.domain !== DOMAIN) return reply.code(404).send({ success: false, error: 'Rule not found' })
    await prisma.automationRule.delete({ where: { id: request.params.id } })
    return reply.send({ success: true })
  })

  /** POST /api/listing-automation-rules/:id/dry-run — preview against a context. */
  fastify.post<{ Params: { id: string }; Body: { context?: Record<string, unknown> } }>(
    '/listing-automation-rules/:id/dry-run',
    async (request, reply) => {
      const existing = await prisma.automationRule.findUnique({ where: { id: request.params.id } })
      if (!existing || existing.domain !== DOMAIN) return reply.code(404).send({ success: false, error: 'Rule not found' })
      try {
        const result = await evaluateRule({ ruleId: request.params.id, context: request.body?.context ?? {}, forceDryRun: true })
        return reply.send({ success: true, result })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logger.error(`[listing-automation-rules] dry-run failed for ${request.params.id}: ${msg}`)
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /** GET /api/listing-automation-rules/:id/executions — audit history. */
  fastify.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
    '/listing-automation-rules/:id/executions',
    async (request, reply) => {
      const rule = await prisma.automationRule.findUnique({ where: { id: request.params.id }, select: { domain: true } })
      if (!rule || rule.domain !== DOMAIN) return reply.code(404).send({ success: false, error: 'Rule not found' })
      const where: any = { ruleId: request.params.id }
      if (request.query.status) where.status = request.query.status
      const executions = await prisma.automationRuleExecution.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: Math.min(Math.max(request.query.limit ? Number(request.query.limit) : 100, 1), 500),
      })
      return reply.send({ success: true, executions })
    },
  )
}

export default listingAutomationRulesRoutes
