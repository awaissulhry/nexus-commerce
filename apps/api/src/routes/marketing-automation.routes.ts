/**
 * MC.11.1 / A4.2 — Marketing-content automation rule CRUD + executor.
 *
 * Reuses the shared AutomationRule model with domain='marketing_content'.
 * AI actions (generate_content, fill_missing_content, ai_translate) are now
 * live: the /run endpoint dispatches directly to ListingContentService.
 * Non-AI actions (resize, watermark, tag_with) still emit DEFERRED until
 * their respective services are wired.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  ListingContentService,
  type ContentField,
} from '../services/ai/listing-content.service.js'
import {
  languageForMarketplace,
} from '../services/products/translation-resolver.service.js'
import { logger } from '../utils/logger.js'

const listingContentSvc = new ListingContentService()

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

  // ── A4.2 — Rule executor ──────────────────────────────────

  fastify.post(
    '/marketing-automation/rules/:id/run',
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const rule = await prisma.automationRule.findUnique({ where: { id } })
      if (!rule || rule.domain !== DOMAIN)
        return reply.code(404).send({ error: 'rule not found' })

      const startedAt = new Date()
      const actions = (rule.actions as Array<{ type?: string; config?: Record<string, unknown> }>) ?? []
      const action = actions[0]
      const actionType = action?.type ?? ''
      const config = (action?.config ?? {}) as Record<string, unknown>
      const dryRun = rule.dryRun === true

      // ── AI product-content actions ─────────────────────────────────────
      const AI_PRODUCT_ACTIONS = new Set(['generate_content', 'fill_missing_content', 'ai_translate'])

      if (AI_PRODUCT_ACTIONS.has(actionType)) {
        if (!listingContentSvc.isConfigured()) {
          return reply.code(503).send({ error: 'AI provider not configured — check GEMINI_API_KEY / ANTHROPIC_API_KEY' })
        }
        return reply.code(201).send(
          await runAiProductAction({ rule, actionType, config, dryRun, startedAt, id }),
        )
      }

      // ── Legacy / non-AI actions — still deferred ───────────────────────
      const reason = 'Action executor not yet wired for this action type'
      const exec = await prisma.automationRuleExecution.create({
        data: {
          ruleId: id,
          startedAt,
          finishedAt: new Date(),
          status: 'DEFERRED',
          dryRun,
          triggerData: { source: 'manual', firedAt: startedAt.toISOString() },
          actionResults: [{ type: actionType, ok: false, deferred: true, reason }] as never,
          errorMessage: null,
          durationMs: new Date().getTime() - startedAt.getTime(),
        },
      })
      await prisma.automationRule.update({
        where: { id },
        data: { executionCount: { increment: 1 }, lastExecutedAt: new Date() },
      })
      return reply.code(201).send({ execution: exec, status: 'DEFERRED', reason })
    },
  )

  // ── AI product-content action executor ────────────────────────────────
  async function runAiProductAction({
    rule, actionType, config, dryRun, startedAt, id,
  }: {
    rule: { id: string; dryRun: boolean | null; triggerConfig?: unknown }
    actionType: string
    config: Record<string, unknown>
    dryRun: boolean
    startedAt: Date
    id: string
  }) {
    const marketplace = ((config.marketplace as string) ?? 'IT').toUpperCase()
    const maxProducts = Math.min(Number(config.maxProducts ?? 50), 50)
    const rawFields = Array.isArray(config.fields) ? (config.fields as string[]) : ['title', 'bullets', 'description']
    const ALLOWED: ContentField[] = ['title', 'bullets', 'description', 'keywords']
    const fields = rawFields.filter((f): f is ContentField => ALLOWED.includes(f as ContentField))

    // ── Build target product list ────────────────────────────────────────
    const isTranslate = actionType === 'ai_translate'
    const onlyMissing = actionType === 'fill_missing_content'

    const targetLocale = isTranslate
      ? ((config.targetLocale as string) ?? 'DE').toUpperCase()
      : marketplace

    let productWhere: Record<string, unknown> = {}
    if (onlyMissing) {
      // Only products where at least one of the requested fields is empty
      const orClauses: Record<string, unknown>[] = []
      if (fields.includes('description')) orClauses.push({ description: null }, { description: '' })
      if (fields.includes('bullets')) orClauses.push({ bulletPoints: { isEmpty: true } })
      if (fields.includes('title')) orClauses.push({ name: null }, { name: '' })
      if (orClauses.length > 0) productWhere.OR = orClauses
    }

    // Respect trigger-level product filter if present (productType / brand)
    const triggerCfg = (rule.triggerConfig ?? {}) as Record<string, unknown>
    if (triggerCfg.productType) productWhere.productType = triggerCfg.productType
    if (triggerCfg.brand) productWhere.brand = triggerCfg.brand

    const products = await prisma.product.findMany({
      where: productWhere,
      take: maxProducts,
      select: {
        id: true, sku: true, name: true, brand: true, description: true,
        bulletPoints: true, keywords: true, weightValue: true, weightUnit: true,
        dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
        productType: true, variantAttributes: true, categoryAttributes: true,
      },
      orderBy: { updatedAt: 'asc' },
    })

    logger.info('[automation-ai] dispatching', {
      actionType, marketplace: isTranslate ? targetLocale : marketplace,
      dryRun, productCount: products.length, fields,
    })

    // ── Execute per-product ──────────────────────────────────────────────
    const results: Array<{ productId: string; sku: string; ok: boolean; written?: string[]; error?: string }> = []
    let okCount = 0

    for (const product of products) {
      try {
        const generated = await listingContentSvc.generate({
          product: {
            id: product.id,
            sku: product.sku ?? '',
            name: product.name ?? '',
            brand: product.brand ?? '',
            description: product.description ?? undefined,
            bulletPoints: product.bulletPoints ?? [],
            keywords: product.keywords ?? [],
            weightValue: product.weightValue != null ? Number(product.weightValue) : undefined,
            weightUnit: product.weightUnit ?? undefined,
            dimLength: product.dimLength != null ? Number(product.dimLength) : undefined,
            dimWidth: product.dimWidth != null ? Number(product.dimWidth) : undefined,
            dimHeight: product.dimHeight != null ? Number(product.dimHeight) : undefined,
            dimUnit: product.dimUnit ?? undefined,
            productType: product.productType ?? undefined,
            variantAttributes: (product.variantAttributes ?? undefined) as Record<string, string> | undefined,
            categoryAttributes: (product.categoryAttributes ?? undefined) as Record<string, string> | undefined,
          },
          marketplace: isTranslate ? targetLocale : marketplace,
          fields,
          terminology: [],
          provider: 'anthropic',
        })

        if (!dryRun) {
          const writeData: Record<string, unknown> = {}
          const targetLang = languageForMarketplace(isTranslate ? targetLocale : marketplace)
          const isPrimary = !isTranslate || targetLang === languageForMarketplace('IT')

          if (generated.title && fields.includes('title') && isPrimary) writeData.name = generated.title.content
          if (generated.description && fields.includes('description') && isPrimary) writeData.description = generated.description.content
          if (generated.bullets && fields.includes('bullets') && isPrimary) writeData.bulletPoints = generated.bullets.content
          if (generated.keywords && fields.includes('keywords') && isPrimary) writeData.keywords = generated.keywords.content.split(/\s+/).filter(Boolean)

          if (Object.keys(writeData).length > 0) {
            await prisma.product.update({ where: { id: product.id }, data: writeData as never })
          }

          // Translation path — write to ProductTranslation
          if (isTranslate && !isPrimary) {
            const translationFields: Record<string, unknown> = {}
            if (generated.title && fields.includes('title')) translationFields.title = generated.title.content
            if (generated.description && fields.includes('description')) translationFields.description = generated.description.content
            if (generated.bullets && fields.includes('bullets')) translationFields.bulletPoints = generated.bullets.content
            if (Object.keys(translationFields).length > 0) {
              await (prisma.productTranslation as any).upsert({
                where: { productId_language: { productId: product.id, language: targetLang } },
                update: translationFields,
                create: { productId: product.id, language: targetLang, ...translationFields },
              })
            }
          }
        }

        const written = fields.filter((f) => {
          if (f === 'title') return generated.title != null
          if (f === 'bullets') return generated.bullets != null
          if (f === 'description') return generated.description != null
          if (f === 'keywords') return generated.keywords != null
          return false
        })
        results.push({ productId: product.id, sku: product.sku ?? '', ok: true, written })
        okCount++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        logger.warn('[automation-ai] product failed', { productId: product.id, err: msg })
        results.push({ productId: product.id, sku: product.sku ?? '', ok: false, error: msg })
      }
    }

    // ── Record execution ────────────────────────────────────────────────
    const finishedAt = new Date()
    const status = results.length === 0 ? 'COMPLETED' : okCount === results.length ? 'COMPLETED' : okCount > 0 ? 'COMPLETED' : 'FAILED'
    const summary = dryRun
      ? `Dry run: would update ${products.length} products`
      : `Updated ${okCount}/${products.length} products`

    const exec = await prisma.automationRuleExecution.create({
      data: {
        ruleId: id,
        startedAt,
        finishedAt,
        status,
        dryRun,
        triggerData: { source: 'manual', firedAt: startedAt.toISOString() },
        actionResults: results as never,
        errorMessage: null,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    })
    await prisma.automationRule.update({
      where: { id },
      data: { executionCount: { increment: 1 }, lastExecutedAt: new Date() },
    })

    return { execution: exec, status, summary, productsMatched: products.length, productsOk: okCount, dryRun }
  }

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
