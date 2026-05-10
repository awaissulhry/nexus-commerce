/**
 * MC.11.1 — Marketing-content automation rule CRUD.
 *
 * Reuses the shared AutomationRule model with domain='marketing_content'.
 * Replenishment-led automation rules live under domain='replenishment'
 * + their own routes; we filter by domain in every query so the two
 * surfaces stay isolated.
 *
 * The rule executor (MC.11-followup) reads these rows + dispatches
 * triggers against the marketing-content event hooks; AI actions
 * are deferred per the engagement directive (executor emits
 * status='deferred' instead of 'completed' until MC.4 lands).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const DOMAIN = 'marketing_content'

const marketingAutomationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/marketing-automation/rules', async (request) => {
    const q = request.query as { enabled?: string; trigger?: string }
    const where: Record<string, unknown> = { domain: DOMAIN }
    if (q.enabled === 'true') where.enabled = true
    if (q.enabled === 'false') where.enabled = false
    if (q.trigger) where.trigger = q.trigger
    const rules = await prisma.automationRule.findMany({
      where,
      orderBy: [{ enabled: 'desc' }, { updatedAt: 'desc' }],
    })
    return { rules }
  })

  fastify.get(
    '/marketing-automation/rules/:id',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const rule = await prisma.automationRule.findUnique({
        where: { id },
      })
      if (!rule || rule.domain !== DOMAIN)
        return reply.code(404).send({ error: 'rule not found' })
      // Pull the most recent N executions alongside the rule so the
      // edit page shows the run history without a second roundtrip.
      const executions = await prisma.automationRuleExecution.findMany({
        where: { ruleId: id },
        orderBy: { startedAt: 'desc' },
        take: 50,
      })
      return { rule, executions }
    },
  )

  fastify.post('/marketing-automation/rules', async (request, reply) => {
    const body = request.body as {
      name?: string
      description?: string | null
      trigger?: string
      triggerConfig?: unknown
      action?: string
      actionConfig?: unknown
      enabled?: boolean
      cronExpression?: string | null
    }
    if (!body.name?.trim())
      return reply.code(400).send({ error: 'name is required' })
    if (!body.trigger?.trim())
      return reply.code(400).send({ error: 'trigger is required' })
    if (!body.action?.trim())
      return reply.code(400).send({ error: 'action is required' })

    // Marketing-content rules use the shared AutomationRule model
    // but always store a single action wrapped in the actions[]
    // shape that the model expects. (Replenishment rules can have
    // multiple actions per rule — that's a follow-up here once
    // the operator wants chained ops.)
    const rule = await prisma.automationRule.create({
      data: {
        domain: DOMAIN,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        trigger: body.trigger,
        conditions: [
          {
            type: 'config',
            data: (body.triggerConfig as never) ?? {},
          },
        ] as never,
        actions: [
          {
            type: body.action,
            config: (body.actionConfig as never) ?? {},
          },
        ] as never,
        enabled: body.enabled ?? false,
        // Marketing-content rules don't have a financial cap; reuse
        // the column for a per-day execution count if needed later.
        maxValueCentsEur: null,
        dryRun: true,
      },
    })
    return reply.code(201).send({ rule })
  })

  fastify.patch(
    '/marketing-automation/rules/:id',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const existing = await prisma.automationRule.findUnique({
        where: { id },
      })
      if (!existing || existing.domain !== DOMAIN)
        return reply.code(404).send({ error: 'rule not found' })

      const body = request.body as {
        name?: string
        description?: string | null
        trigger?: string
        triggerConfig?: unknown
        action?: string
        actionConfig?: unknown
        enabled?: boolean
        dryRun?: boolean
      }
      const data: Record<string, unknown> = {}
      if (body.name !== undefined) data.name = body.name.trim()
      if (body.description !== undefined)
        data.description = body.description?.trim() || null
      if (body.trigger !== undefined) data.trigger = body.trigger
      if (body.triggerConfig !== undefined)
        data.conditions = [
          { type: 'config', data: (body.triggerConfig as never) ?? {} },
        ] as never
      if (body.action !== undefined || body.actionConfig !== undefined) {
        // Re-build the actions array. Pull current values when one
        // half is missing.
        const currentActions = (existing.actions as unknown[]) ?? []
        const currentAction = (currentActions[0] ?? {}) as {
          type?: string
          config?: unknown
        }
        const nextType = body.action ?? currentAction.type ?? 'noop'
        const nextConfig =
          body.actionConfig !== undefined
            ? body.actionConfig
            : (currentAction.config ?? {})
        data.actions = [
          { type: nextType, config: (nextConfig as never) ?? {} },
        ] as never
      }
      if (body.enabled !== undefined) data.enabled = body.enabled
      if (body.dryRun !== undefined) data.dryRun = body.dryRun
      if (Object.keys(data).length === 0)
        return reply
          .code(400)
          .send({ error: 'no mutable fields supplied' })

      const rule = await prisma.automationRule.update({
        where: { id },
        data,
      })
      return { rule }
    },
  )

  // ── MC.11.3 — Manual run + execution history ──────────────

  // Manual fire. Creates an AutomationRuleExecution row recording
  // what the executor *would* do; the AI-action gating means rules
  // with deferred actions log status='deferred' instead of
  // 'completed'. Deterministic actions today still log 'deferred'
  // because the executor itself is MC.11-followup work — this
  // endpoint produces audit rows so the history view is meaningful
  // before the executor lands.
  fastify.post(
    '/marketing-automation/rules/:id/run',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const rule = await prisma.automationRule.findUnique({
        where: { id },
      })
      if (!rule || rule.domain !== DOMAIN)
        return reply.code(404).send({ error: 'rule not found' })

      const startedAt = new Date()
      const actions = (rule.actions as Array<{ type?: string }>) ?? []
      const aiAction = actions[0]?.type
      const aiSet = new Set([
        'auto_alt_text',
        'auto_tag',
        'translate_caption',
        'background_removal',
        'generate_lifestyle',
      ])
      const status = aiAction && aiSet.has(aiAction) ? 'DEFERRED' : 'DEFERRED'
      const reason =
        aiAction && aiSet.has(aiAction)
          ? 'AI integration paused per engagement directive (docs/MC-AI-DEFERRED.md)'
          : 'Executor wiring pending (MC.11-followup)'

      const exec = await prisma.automationRuleExecution.create({
        data: {
          ruleId: id,
          startedAt,
          finishedAt: new Date(),
          status,
          dryRun: rule.dryRun,
          triggerData: { source: 'manual', firedAt: startedAt.toISOString() },
          actionResults: [
            {
              type: aiAction ?? 'noop',
              ok: false,
              deferred: true,
              reason,
            },
          ] as never,
          errorMessage: null,
          durationMs:
            new Date().getTime() - startedAt.getTime(),
        },
      })

      // Touch counters so the rule list shows it ran.
      await prisma.automationRule.update({
        where: { id },
        data: {
          executionCount: { increment: 1 },
          lastExecutedAt: new Date(),
        },
      })

      return reply.code(201).send({ execution: exec, status, reason })
    },
  )

  fastify.get(
    '/marketing-automation/executions',
    async (request) => {
      // Cross-rule history view — defaults to recent 100. Restricts
      // to marketing-content domain by joining through the rule.
      const q = request.query as { limit?: string; status?: string }
      const limit = Math.min(
        Math.max(parseInt(q.limit ?? '100', 10) || 100, 1),
        500,
      )
      const where: Record<string, unknown> = {
        rule: { domain: DOMAIN },
      }
      if (q.status) where.status = q.status
      const executions = await prisma.automationRuleExecution.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        include: {
          rule: { select: { id: true, name: true } },
        },
      })
      return { executions }
    },
  )

  fastify.delete(
    '/marketing-automation/rules/:id',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const existing = await prisma.automationRule.findUnique({
        where: { id },
      })
      if (!existing || existing.domain !== DOMAIN)
        return reply.code(404).send({ error: 'rule not found' })
      await prisma.automationRule.delete({ where: { id } })
      return { ok: true, id }
    },
  )
}

export default marketingAutomationRoutes
