/**
 * PSIE — the product sheet's Export and Import (docs/product-sheet-import-export/PLAN.md). Two buttons, one engine:
 *
 *   POST /catalog-transfer/sheet/products/:productId/export   the editing file (xlsx, or a zip when it must split)
 *   POST /catalog-transfer/sheet/products/:productId/import   drop a file → a job in CHECKING
 *   GET  /catalog-transfer/sheet/imports/:jobId               the job (poll while CHECKING or SAVING)
 *   GET  /catalog-transfer/sheet/imports/:jobId/changes       every changed cell and every problem, paged
 *   GET  /catalog-transfer/sheet/imports/:jobId/problems      the problems as a CSV
 *   POST /catalog-transfer/sheet/imports/:jobId/apply         save (Nexus only; nothing is sent to a channel)
 *   POST /catalog-transfer/sheet/imports/:jobId/undo          put back what the import saved
 *
 * Permissions: the export route is `products.export`, everything else `products.import` (permissions-manifest.ts).
 */
import type {} from '@fastify/multipart'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { ProductTransferSelection } from '@nexus/shared/catalog-transfer'
import { TransferConflict } from '../services/pim/catalog-transfer.service.js'
import { PRODUCT_TRANSFER_MAX_BYTES } from '../services/pim/catalog-editor-workbook.js'
import { exportSheetFile } from '../services/pim/sheet-transfer/sheet-export.service.js'
import { transferErrorsCsv } from '../services/pim/catalog-transfer-file.js'
import { decisionsOf } from './catalog-transfer.routes.js'
import { applySheetImport, sheetImportChanges, sheetImportStatus, startSheetImport, undoSheetImport } from '../services/pim/sheet-transfer/sheet-import.service.js'

const actor = (request: FastifyRequest) => (request as FastifyRequest & { authUser?: { id?: string } }).authUser?.id ?? null
const marketOf = (value: unknown) => {
  const market = String(value ?? '').trim().toUpperCase()
  if (!/^(?:[A-Z]{2}|GLOBAL)$/.test(market)) throw new Error('Select a marketplace')
  return market
}

const sheetTransferRoutes: FastifyPluginAsync = async fastify => {
  fastify.setErrorHandler((error, request, reply) => {
    request.log.warn({ err: error }, 'Sheet transfer refused')
    const err = error as Error & { statusCode?: number }
    reply.code(error instanceof TransferConflict ? 409 : err.statusCode ?? 400).send({ error: err.message ?? 'The import or export failed' })
  })

  fastify.post('/catalog-transfer/sheet/products/:productId/export', async (request, reply) => {
    const productId = (request.params as { productId: string }).productId
    const body = request.body as { market?: string; selection?: ProductTransferSelection; fields?: string[] } | undefined
    if (body?.fields !== undefined && (!Array.isArray(body.fields) || !body.fields.length || body.fields.length > 1000 || body.fields.some(f => typeof f !== 'string' || !f.trim()))) throw new Error('Select valid columns for the export')
    const started = performance.now()
    const file = await exportSheetFile({ productId, market: marketOf(body?.market), selection: body?.selection as ProductTransferSelection, fields: body?.fields, userId: actor(request) })
    const { filename, notes } = file
    request.log.info({ productId, ms: Math.round(performance.now() - started), products: file.products, listings: file.listings, notes: notes.length }, 'sheet-export.done')
    return reply.header('Cache-Control', 'no-store').header('Content-Type', file.contentType)
      .header('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('X-Nexus-Export-Notes', encodeURIComponent(JSON.stringify({ total: notes.length, notes: notes.slice(0, 10) })))
      .header('Access-Control-Expose-Headers', 'Content-Disposition, X-Nexus-Export-Notes')
      .send(file.data)
  })

  fastify.post('/catalog-transfer/sheet/products/:productId/import', async (request, reply) => {
    const productId = (request.params as { productId: string }).productId
    const fields: Record<string, string> = {}
    let buffer: Buffer | undefined, filename = ''
    for await (const part of request.parts({ limits: { files: 1, fileSize: PRODUCT_TRANSFER_MAX_BYTES, fields: 4 } })) {
      if (part.type === 'file') { filename = part.filename; buffer = await part.toBuffer() }
      else fields[part.fieldname] = String(part.value ?? '')
    }
    if (!buffer) throw new Error('Drop a file: a Nexus export, an Amazon template, an eBay file or a CSV')
    return reply.code(201).send(await startSheetImport({ buffer, filename, productId, market: marketOf(fields.market), userId: actor(request), decisions: decisionsOf(fields),
      log: (event, detail) => request.log.info({ productId, filename, ...detail }, event) }))
  })

  fastify.get('/catalog-transfer/sheet/imports/:jobId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const status = await sheetImportStatus((request.params as { jobId: string }).jobId, actor(request))
    return status ?? reply.code(404).send({ error: 'Import not found' })
  })

  fastify.get('/catalog-transfer/sheet/imports/:jobId/changes', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const query = request.query as { page?: string; filter?: string; search?: string }
    const page = await sheetImportChanges((request.params as { jobId: string }).jobId, actor(request), { page: Number(query.page ?? 1), filter: query.filter, search: query.search })
    return page ?? reply.code(404).send({ error: 'Import not found' })
  })

  fastify.get('/catalog-transfer/sheet/imports/:jobId/problems', async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId, userId = actor(request)
    const issues = []
    for (let page = 1; ; page++) {
      const result = await sheetImportChanges(jobId, userId, { page, filter: 'problems' })
      if (!result) return reply.code(404).send({ error: 'Import not found' })
      issues.push(...result.changes.map(c => ({ row: c.row ?? 0, sku: c.sku, field: c.label, message: c.problem ?? '', source: { sheet: c.sheet, column: c.column } })))
      if (page * result.pageSize >= result.total) break
    }
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="import-problems.csv"').send(transferErrorsCsv(issues))
  })

  fastify.post('/catalog-transfer/sheet/imports/:jobId/apply', async (request, reply) => {
    const body = request.body as { reviewToken?: string } | undefined
    const status = await applySheetImport((request.params as { jobId: string }).jobId, actor(request), String(body?.reviewToken ?? ''))
    return status ? reply.code(202).send(status) : reply.code(404).send({ error: 'Import not found' })
  })

  fastify.post('/catalog-transfer/sheet/imports/:jobId/undo', async (request, reply) => {
    const status = await undoSheetImport((request.params as { jobId: string }).jobId, actor(request))
    return status ? reply.code(201).send(status) : reply.code(404).send({ error: 'Import not found' })
  })
}
export default sheetTransferRoutes
