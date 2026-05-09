/**
 * W5.2 — Bulk-action template routes.
 *
 * /api/bulk-action-templates — CRUD + duplicate. The apply path
 * lives at POST /api/bulk-action-templates/:id/apply: it substitutes
 * parameters into the template's actionPayload, optionally overrides
 * filters, and creates a real BulkActionJob via BulkActionService.
 *
 * Same defensive shape as /api/bulk-ops/templates (W2 saved-views):
 * Zod-style runtime validation at the boundary, errors translated to
 * sensible HTTP codes.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  BulkActionTemplateService,
  type ParameterDecl,
} from '../services/bulk-action-template.service.js'
import { BulkActionService } from '../services/bulk-action.service.js'
import prisma from '../db.js'

const templateService = new BulkActionTemplateService(prisma)
const bulkActionService = new BulkActionService(prisma)

interface CreateBody {
  name?: string
  description?: string | null
  actionType?: string
  channel?: string | null
  actionPayload?: Record<string, unknown>
  defaultFilters?: Record<string, unknown> | null
  parameters?: ParameterDecl[]
  category?: string | null
  userId?: string | null
  createdBy?: string | null
}

interface ApplyBody {
  /** Operator-provided parameter values (name → typed value). */
  params?: Record<string, unknown>
  /** Optional override of the template's defaultFilters. When
   *  undefined the template's defaults are used; when null, the
   *  apply runs with no filters; when present, this replaces the
   *  defaults entirely. */
  filters?: Record<string, unknown> | null
  /** Optional explicit target IDs (matches CreateBulkJobSchema). */
  targetProductIds?: string[]
  /** Job name override; defaults to the template name. */
  jobName?: string
  createdBy?: string | null
}

const bulkActionTemplateRoutes: FastifyPluginAsync = async (fastify) => {
  /** GET /api/bulk-action-templates — list, optionally filtered. */
  fastify.get<{
    Querystring: {
      userId?: string
      category?: string
      actionType?: string
      includeBuiltins?: string
      limit?: string
    }
  }>('/bulk-action-templates', async (request, reply) => {
    try {
      const q = request.query
      const templates = await templateService.listTemplates({
        userId: q.userId === '' ? null : q.userId,
        category: q.category,
        actionType: q.actionType,
        includeBuiltins: q.includeBuiltins !== 'false',
        limit: q.limit ? Number(q.limit) : undefined,
      })
      return reply.send({ success: true, templates })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      fastify.log.error({ err: e }, '[bulk-action-templates] list failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /** GET /api/bulk-action-templates/:id */
  fastify.get<{ Params: { id: string } }>(
    '/bulk-action-templates/:id',
    async (request, reply) => {
      try {
        const template = await templateService.getTemplate(request.params.id)
        if (!template) {
          return reply
            .code(404)
            .send({ success: false, error: 'Template not found' })
        }
        return reply.send({ success: true, template })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /** POST /api/bulk-action-templates */
  fastify.post<{ Body: CreateBody }>(
    '/bulk-action-templates',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.name || !body.name.trim()) {
        return reply
          .code(400)
          .send({ success: false, error: 'name is required' })
      }
      if (!body.actionType) {
        return reply
          .code(400)
          .send({ success: false, error: 'actionType is required' })
      }
      try {
        const template = await templateService.createTemplate({
          name: body.name,
          description: body.description ?? null,
          actionType: body.actionType as never,
          channel: body.channel ?? null,
          actionPayload: body.actionPayload ?? {},
          defaultFilters: body.defaultFilters ?? null,
          parameters: body.parameters ?? [],
          category: body.category ?? null,
          userId: body.userId ?? null,
          createdBy: body.createdBy ?? null,
        })
        return reply.code(201).send({ success: true, template })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const status = msg.includes('not in KNOWN_BULK_ACTION_TYPES') ? 400 : 500
        return reply.code(status).send({ success: false, error: msg })
      }
    },
  )

  /** PATCH /api/bulk-action-templates/:id */
  fastify.patch<{
    Params: { id: string }
    Body: Partial<CreateBody>
  }>('/bulk-action-templates/:id', async (request, reply) => {
    try {
      const template = await templateService.updateTemplate(
        request.params.id,
        request.body as never,
      )
      return reply.send({ success: true, template })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('Template not found')) {
        return reply.code(404).send({ success: false, error: msg })
      }
      if (msg.startsWith('Cannot update a built-in')) {
        return reply.code(409).send({ success: false, error: msg })
      }
      if (msg.includes('not in KNOWN_BULK_ACTION_TYPES')) {
        return reply.code(400).send({ success: false, error: msg })
      }
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /** DELETE /api/bulk-action-templates/:id */
  fastify.delete<{ Params: { id: string } }>(
    '/bulk-action-templates/:id',
    async (request, reply) => {
      try {
        await templateService.deleteTemplate(request.params.id)
        return reply.send({ success: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.startsWith('Cannot delete a built-in')) {
          return reply.code(409).send({ success: false, error: msg })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /** POST /api/bulk-action-templates/:id/duplicate */
  fastify.post<{
    Params: { id: string }
    Body: { userId?: string | null; namePrefix?: string }
  }>('/bulk-action-templates/:id/duplicate', async (request, reply) => {
    try {
      const copy = await templateService.duplicateTemplate(
        request.params.id,
        {
          userId: request.body?.userId ?? null,
          namePrefix: request.body?.namePrefix,
        },
      )
      return reply.code(201).send({ success: true, template: copy })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('Template not found')) {
        return reply.code(404).send({ success: false, error: msg })
      }
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /**
   * POST /api/bulk-action-templates/:id/apply
   *
   * Substitutes parameters into the template, optionally overrides
   * filters / target IDs, and hands the result to BulkActionService.
   * createJob — the same flow the modal uses, just driven by a saved
   * template. Returns the new BulkActionJob row.
   */
  fastify.post<{
    Params: { id: string }
    Body: ApplyBody
  }>('/bulk-action-templates/:id/apply', async (request, reply) => {
    const { id } = request.params
    const body = request.body ?? {}
    try {
      const template = await templateService.getTemplate(id)
      if (!template) {
        return reply
          .code(404)
          .send({ success: false, error: 'Template not found' })
      }
      const { actionPayload, filters } = templateService.applyParameters(
        template,
        body.params ?? {},
        body.filters,
      )
      const job = await bulkActionService.createJob({
        jobName: body.jobName ?? template.name,
        actionType: template.actionType as never,
        channel: template.channel ?? undefined,
        actionPayload,
        filters: filters ?? undefined,
        targetProductIds: body.targetProductIds,
        createdBy: body.createdBy ?? null,
      } as never)
      // Best-effort telemetry; never blocks the apply.
      void templateService.recordUsage(id)
      return reply.code(201).send({ success: true, job })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('Required parameter missing')) {
        return reply.code(400).send({ success: false, error: msg })
      }
      if (msg.includes('must be ') || msg.includes('must be one of')) {
        return reply.code(400).send({ success: false, error: msg })
      }
      fastify.log.error(
        { err: e, templateId: id },
        '[bulk-action-templates] apply failed',
      )
      return reply.code(500).send({ success: false, error: msg })
    }
  })
}

export default bulkActionTemplateRoutes
