/**
 * W8.2 — Import-wizard routes.
 *
 * Two-step flow: POST /preview parses + auto-maps + persists a
 * PENDING_PREVIEW job. POST /:id/apply commits. Plus standard
 * CRUD-ish + the retry-failed + rollback paths from W8.1.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  ImportWizardService,
  type FileKind,
  type TargetEntity,
  type OnErrorMode,
} from '../services/import-wizard.service.js'
import {
  detectFileKind,
  parseFile,
} from '../services/import/parsers.js'
import {
  suggestMapping,
  applyMapping,
  type FieldDef,
} from '../services/import/column-mapping.js'

const importService = new ImportWizardService(prisma)

// Field catalogue per target entity. v0 ships the Product write-
// path's allowlist (matches W8.1 writeRow's ALLOWED_FIELDS) so the
// auto-mapper never suggests a column the apply path will reject.
const PRODUCT_FIELDS: FieldDef[] = [
  { id: 'sku', label: 'SKU' },
  { id: 'name', label: 'Name' },
  { id: 'brand', label: 'Brand' },
  { id: 'description', label: 'Description' },
  { id: 'basePrice', label: 'Base price' },
  { id: 'costPrice', label: 'Cost price' },
  { id: 'minPrice', label: 'Min price' },
  { id: 'maxPrice', label: 'Max price' },
  { id: 'totalStock', label: 'Total stock' },
  { id: 'lowStockThreshold', label: 'Low stock threshold' },
  { id: 'status', label: 'Status' },
  { id: 'productType', label: 'Product type' },
  { id: 'hsCode', label: 'HS code' },
  { id: 'countryOfOrigin', label: 'Country of origin' },
]

interface PreviewBody {
  jobName?: string
  description?: string | null
  filename?: string | null
  /** Pre-detected kind; falls back to detectFileKind(filename). */
  fileKind?: FileKind
  targetEntity?: TargetEntity
  /** Operator-supplied mapping override. Empty/missing = auto. */
  columnMapping?: Record<string, string>
  onError?: OnErrorMode
  /** CSV / JSON path: paste the raw text here. XLSX path: pass
   *  base64-encoded bytes via `bytesBase64`. */
  text?: string
  bytesBase64?: string
}

const importWizardRoutes: FastifyPluginAsync = async (fastify) => {
  /** GET /api/import-jobs */
  fastify.get<{
    Querystring: { status?: string; limit?: string }
  }>('/import-jobs', async (request, reply) => {
    const jobs = await importService.list({
      status: request.query.status,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
    })
    return reply.send({ success: true, jobs })
  })

  /** GET /api/import-jobs/:id */
  fastify.get<{ Params: { id: string } }>(
    '/import-jobs/:id',
    async (request, reply) => {
      const job = await importService.get(request.params.id)
      if (!job) return reply.code(404).send({ success: false, error: 'Not found' })
      return reply.send({ success: true, job })
    },
  )

  /** GET /api/import-jobs/:id/rows */
  fastify.get<{
    Params: { id: string }
    Querystring: { status?: string; limit?: string; offset?: string }
  }>('/import-jobs/:id/rows', async (request, reply) => {
    const rows = await importService.listRows(request.params.id, {
      status: request.query.status,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      offset: request.query.offset ? Number(request.query.offset) : undefined,
    })
    return reply.send({ success: true, rows })
  })

  /**
   * POST /api/import-jobs/preview
   *
   * Parse the supplied file, build a column mapping (operator-
   * supplied + auto-fill), apply it to every row, and persist a
   * PENDING_PREVIEW ImportJob. Returns the job + the suggested
   * mapping so the UI can confirm.
   */
  fastify.post<{ Body: PreviewBody }>(
    '/import-jobs/preview',
    async (request, reply) => {
      const body = request.body ?? {}
      try {
        const targetEntity: TargetEntity = body.targetEntity ?? 'product'
        const fileKind: FileKind =
          body.fileKind ?? detectFileKind(body.filename ?? null)

        const parsed = await parseFile(fileKind, {
          text: body.text,
          bytes: body.bytesBase64
            ? Buffer.from(body.bytesBase64, 'base64')
            : undefined,
        })

        // Determine the field catalogue for this entity.
        const fields =
          targetEntity === 'product' ? PRODUCT_FIELDS : PRODUCT_FIELDS
        const auto = suggestMapping(parsed.headers, fields)
        const mapping = { ...auto.mapping, ...(body.columnMapping ?? {}) }

        // Map every row to {field-id → value}. Validate sku presence
        // pre-persistence so we don't queue rows that can never
        // resolve a target entity.
        const rows = parsed.rows.map((raw, i) => {
          const values = applyMapping(raw, mapping)
          let parseError: string | undefined
          if (
            targetEntity === 'product' &&
            (!values.sku || String(values.sku).trim().length === 0)
          ) {
            parseError = 'row missing sku (no value mapped to the SKU field)'
          }
          return {
            rowIndex: i + 1,
            values,
            parseError,
          }
        })

        const job = await importService.create({
          jobName:
            body.jobName?.trim() ||
            `Import ${body.filename ?? new Date().toISOString().slice(0, 10)}`,
          description: body.description ?? null,
          source: 'upload',
          filename: body.filename ?? null,
          fileKind,
          targetEntity,
          columnMapping: mapping,
          onError: body.onError ?? 'skip',
          rows,
        })

        return reply.code(201).send({
          success: true,
          job,
          headers: parsed.headers,
          mapping,
          unmappedHeaders: auto.unmappedHeaders,
          unmappedFields: auto.unmappedFields,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return reply.code(400).send({ success: false, error: msg })
      }
    },
  )

  /** POST /api/import-jobs/:id/apply */
  fastify.post<{ Params: { id: string } }>(
    '/import-jobs/:id/apply',
    async (request, reply) => {
      try {
        const result = await importService.apply(request.params.id)
        return reply.send({ success: true, ...result })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.startsWith('ImportJob not found')) {
          return reply.code(404).send({ success: false, error: msg })
        }
        if (msg.startsWith('Cannot apply job')) {
          return reply.code(409).send({ success: false, error: msg })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /** POST /api/import-jobs/:id/retry-failed */
  fastify.post<{ Params: { id: string } }>(
    '/import-jobs/:id/retry-failed',
    async (request, reply) => {
      try {
        const newJob = await importService.retryFailed(request.params.id)
        return reply.code(201).send({ success: true, job: newJob })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.startsWith('No FAILED rows')) {
          return reply.code(409).send({ success: false, error: msg })
        }
        if (msg.startsWith('ImportJob not found')) {
          return reply.code(404).send({ success: false, error: msg })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /** POST /api/import-jobs/:id/rollback */
  fastify.post<{ Params: { id: string } }>(
    '/import-jobs/:id/rollback',
    async (request, reply) => {
      try {
        const result = await importService.rollback(request.params.id)
        return reply.code(201).send({ success: true, ...result })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.startsWith('ImportJob not found')) {
          return reply.code(404).send({ success: false, error: msg })
        }
        if (
          msg.startsWith('Cannot rollback') ||
          msg.startsWith('No SUCCESS rows')
        ) {
          return reply.code(409).send({ success: false, error: msg })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )
}

export default importWizardRoutes
