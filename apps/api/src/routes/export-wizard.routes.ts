/**
 * W9.2 — Export-wizard routes.
 *
 * Operator surface for ExportJob: list / get / create / download /
 * delete. Create runs the export inline in v0; very large exports
 * (W9.4 follow-up) move to a worker.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  ExportWizardService,
  type TargetEntity,
} from '../services/export-wizard.service.js'
import {
  type ColumnSpec,
  type ExportFormat,
} from '../services/export/renderers.js'
import prisma from '../db.js'

const exportService = new ExportWizardService(prisma)

interface CreateBody {
  jobName?: string
  description?: string | null
  format?: ExportFormat
  targetEntity?: TargetEntity
  columns?: ColumnSpec[]
  filters?: Record<string, unknown> | null
  createdBy?: string | null
}

const exportWizardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { status?: string; limit?: string } }>(
    '/export-jobs',
    async (request, reply) => {
      const jobs = await exportService.list({
        status: request.query.status,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      })
      return reply.send({ success: true, jobs })
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/export-jobs/:id',
    async (request, reply) => {
      const job = await exportService.get(request.params.id)
      if (!job) return reply.code(404).send({ success: false, error: 'Not found' })
      return reply.send({ success: true, job })
    },
  )

  fastify.post<{ Body: CreateBody }>(
    '/export-jobs',
    async (request, reply) => {
      const body = request.body ?? {}
      try {
        const job = await exportService.create({
          jobName: body.jobName ?? 'Export',
          description: body.description ?? null,
          format: (body.format ?? 'csv') as ExportFormat,
          targetEntity: (body.targetEntity ?? 'product') as TargetEntity,
          columns: body.columns ?? [],
          filters: body.filters ?? null,
          createdBy: body.createdBy ?? null,
        })
        return reply.code(201).send({ success: true, job })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const status =
          msg.startsWith('jobName is required') ||
          msg.startsWith('Unknown format') ||
          msg.startsWith('Unknown targetEntity') ||
          msg.startsWith('columns is required')
            ? 400
            : 500
        return reply.code(status).send({ success: false, error: msg })
      }
    },
  )

  /**
   * GET /api/export-jobs/:id/download
   *
   * Streams the rendered artifact back with the right content-type
   * + Content-Disposition. 404s when the job hasn't completed
   * (operator should poll /api/export-jobs/:id status first).
   */
  fastify.get<{ Params: { id: string } }>(
    '/export-jobs/:id/download',
    async (request, reply) => {
      const out = await exportService.download(request.params.id)
      if (!out) {
        return reply
          .code(404)
          .send({ success: false, error: 'Artifact not available' })
      }
      reply
        .header('Content-Type', out.contentType)
        .header(
          'Content-Disposition',
          `attachment; filename="${out.filename}"`,
        )
        .header('Content-Length', String(out.bytes.byteLength))
      return reply.send(out.bytes)
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/export-jobs/:id',
    async (request, reply) => {
      await exportService.delete(request.params.id)
      return reply.send({ success: true })
    },
  )
}

export default exportWizardRoutes
