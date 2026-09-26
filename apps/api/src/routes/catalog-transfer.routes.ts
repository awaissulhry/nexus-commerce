import type {} from '@fastify/multipart'
import { catalogTranslationRuns, previewCatalogTranslation, requireTranslationGeneration, revertCatalogTranslation } from '../services/pim/catalog-translate.js'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { TransferMode, ProductTransferSelection } from '@nexus/shared/catalog-transfer'
import { Readable } from 'node:stream'
import { transferErrorsCsv, TRANSFER_MAX_FILE_BYTES } from '../services/pim/catalog-transfer-file.js'
import { catalogTransferLanguages, catalogReadinessOptions, catalogTransferOptions, catalogTransferTemplate, exportCatalogTransfer } from '../services/pim/catalog-transfer-export.js'
import { readCatalogTransfer, startCatalogTransfer, catalogTransferStatus, recoverCatalogTransfers, TransferConflict } from '../services/pim/catalog-transfer.service.js'
import { stageTransferJob, readTransferJob, transferJobStatus, transferJobOutcomes, applyTransferJob, retryTransferJob, recoverTransferJobs, recentProductTransferJobs } from '../services/pim/catalog-transfer-jobs.js'
import { inspectCatalogSource, previewCatalogSource, listSourcePresets, listSourceHistory, saveSourcePreset, deleteSourcePreset, sourceMappingFields } from '../services/pim/catalog-source.service.js'
import { fetchCatalogSource } from '../services/pim/catalog-source-fetch.js'
import { catalogWorkbookTemplate, type WorkbookDestination } from '../services/pim/catalog-workbook-scopes.js'
import { listingReadiness } from '../services/pim/listing-readiness.service.js'
import { productTransferOptions, resolveProductTransferBoundary, checkProductTransferBoundary } from '../services/pim/catalog-product-transfer.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { workspaceContext } from '../lib/workspace-context.js'
import { recoverSheetImports } from '../services/pim/sheet-transfer/sheet-import.service.js'
import { writeEditorWorkbook, inspectEditorTransfer, readEditorInput, readEditorTransfer, requireEditorVersions, readCatalogTransferUpload, PRODUCT_TRANSFER_MAX_BYTES, type ChannelFileDecisions } from '../services/pim/catalog-editor-workbook.js'

const actor = (request: FastifyRequest) => (request as FastifyRequest & { authUser?: { id?: string } }).authUser?.id ?? null
const marketOf = (value: unknown) => {
  const market = String(value ?? '').trim().toUpperCase()
  if (!/^(?:[A-Z]{2}|GLOBAL)$/.test(market)) throw new Error('Select a marketplace for the attribute dictionary')
  return market
}
/**
 * CFI-4 / D1 — the Owner's confirmations that travel with an upload: `links` is a JSON object mapping a file SKU to
 * the Nexus SKU it is; `confirmDeletes` is 'true' or a JSON array of file SKUs. Anything else is refused by name, never guessed.
 */
export function decisionsOf(fields: Record<string, string>): ChannelFileDecisions {
  let links: Record<string, string> | undefined
  if (fields.links?.trim()) {
    let value: unknown
    try { value = JSON.parse(fields.links) } catch { throw new Error('Confirmed links must be a JSON object of file SKU → Nexus SKU') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 5000
      || Object.entries(value).some(([from, to]) => !from.trim() || from.length > 200 || typeof to !== 'string' || !to.trim() || to.length > 200)) throw new Error('Confirmed links must be a JSON object of file SKU → Nexus SKU')
    links = value as Record<string, string>
  }
  return { ...(links ? { links } : {}), ...confirmedDeletesOf(fields.confirmDeletes) }
}
/**
 * D1 — which delete rows the Owner confirmed: 'true' = every delete row in the file, 'false' or absent = none, or a
 * JSON array of the file SKUs confirmed one by one. Anything else is refused by name.
 */
const CONFIRM_DELETES_SHAPE = 'confirmDeletes must be true, false, or a JSON array of the file SKUs to end'
function confirmedDeletesOf(raw: string | undefined): Pick<ChannelFileDecisions, 'confirmDeletes'> {
  const value = raw?.trim()
  if (!value || value === 'false') return {}
  if (value === 'true') return { confirmDeletes: true }
  let skus: unknown
  try { skus = JSON.parse(value) } catch { throw new Error(CONFIRM_DELETES_SHAPE) }
  if (!Array.isArray(skus) || !skus.length || skus.length > 5000 || skus.some(sku => typeof sku !== 'string' || !sku.trim() || sku.length > 200) || new Set(skus).size !== skus.length) throw new Error(CONFIRM_DELETES_SHAPE)
  return { confirmDeletes: skus as string[] }
}
/**
 * 🔴 Recover interrupted imports in EVERY business. With business profiles on (production since 2026-09-16) both
 * recoverers read tenant tables, and outside a business profile they threw "Select a business profile." every 30 s —
 * an import interrupted by a restart or a deploy was never resumed. Each recoverer runs inside each active business's
 * context; one business (or one recoverer) failing is logged with its business id and never stops the rest.
 */
export async function recoverImportsInEveryBusiness(visit: (work: () => Promise<void>) => Promise<void> = visitActiveWorkspaces,
  log: (failure: { err: unknown; workspaceId: string | null; recoverer: string }) => void = () => {}) {
  await visit(async () => {
    for (const [recoverer, recover] of [['catalog-transfers', recoverCatalogTransfers], ['transfer-jobs', recoverTransferJobs], ['sheet-imports', recoverSheetImports]] as const) {
      try { await recover() } catch (err) { log({ err, workspaceId: workspaceContext()?.workspaceId ?? null, recoverer }) }
    }
  })
}
const catalogTransferRoutes: FastifyPluginAsync = async fastify => {
  fastify.setErrorHandler((error, request, reply) => {
    request.log.warn({ err: error }, 'Catalog transfer refused')
    const err = error as Error & { statusCode?: number }
    reply.code(error instanceof TransferConflict ? 409 : err.statusCode ?? 400).send({ error: err.message ?? 'Catalog transfer failed' })
  })
  fastify.get('/catalog-transfer/options', async () => catalogTransferOptions())
  fastify.get('/catalog-transfer/products/:productId/options', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const productId = (request.params as { productId: string }).productId
    const [options, recentJobs] = await Promise.all([productTransferOptions(productId), recentProductTransferJobs(productId, actor(request))])
    return { ...options, recentJobs }
  })
  fastify.post('/catalog-transfer/products/:productId/export', async (request, reply) => {
    const body = request.body as { market: string; selection: ProductTransferSelection; fields?: string[] }
    const boundary = await resolveProductTransferBoundary((request.params as { productId: string }).productId, body?.selection)
    if (body.fields !== undefined && (!Array.isArray(body.fields) || !body.fields.length || body.fields.length > 1000 || body.fields.some(f => typeof f !== 'string' || !f.trim()))) throw new Error('Select valid attributes for the editing export')
    const file = await exportCatalogTransfer({ market: marketOf(body.market), boundary, fields: body.fields, layout: 'wide', workbookWriter: scopes => writeEditorWorkbook(scopes, boundary, actor(request)) })
    await checkProductTransferBoundary(boundary)
    return reply.header('Cache-Control', 'no-store').header('Content-Type', file.contentType).header('Content-Disposition', `attachment; filename="${file.filename}"`).send(file.data)
  })
  fastify.post('/catalog-transfer/products/:productId/inspect', async (request, reply) => {
    const productId = (request.params as { productId: string }).productId
    await productTransferOptions(productId)
    const fields: Record<string, string> = {}
    let buffer: Buffer | undefined, filename = ''
    for await (const part of request.parts({ limits: { files: 1, fileSize: PRODUCT_TRANSFER_MAX_BYTES, fields: 2 } })) {
      if (part.type === 'file') { filename = part.filename; buffer = await part.toBuffer() }
      else fields[part.fieldname] = String(part.value ?? '')
    }
    if (!buffer) throw new Error('Choose a Nexus workbook, attribute CSV, editing ZIP, Amazon template or eBay workbook')
    // 🔴 Every stage says how long it took and what the heap looked like. On 2026-09-16 this
    // route's only trace was `incoming request`, and the reason it never completed had to be
    // reconstructed from proxy timings and a memory graph instead of read off a log line.
    return reply.code(201).send(await inspectEditorTransfer(buffer, filename, productId, actor(request),
      (event, detail) => request.log.info({ productId, ...detail }, event), decisionsOf(fields)))
  })
  fastify.post('/catalog-transfer/products/:productId/preview', async (request, reply) => {
    const productId = (request.params as { productId: string }).productId
    if (!request.isMultipart()) {
      const body = request.body as { inputId: string; selection: ProductTransferSelection; market: string }
      const boundary = await resolveProductTransferBoundary(productId, body?.selection)
      const parsed = requireEditorVersions(await readEditorInput(body.inputId, productId, actor(request)))
      return reply.code(201).send(await stageTransferJob({ ...parsed, boundary, mode: 'update', market: marketOf(body.market), userId: actor(request) }))
    }
    const fields: Record<string, string> = {}
    let buffer: Buffer | undefined, filename = ''
    for await (const part of request.parts({ limits: { files: 1, fileSize: PRODUCT_TRANSFER_MAX_BYTES, fields: 4 } })) {
      if (part.type === 'file') { filename = part.filename; buffer = await part.toBuffer() }
      else fields[part.fieldname] = String(part.value ?? '')
    }
    if (!buffer) throw new Error('Choose a Nexus editing workbook or attribute CSV')
    let selection: ProductTransferSelection
    try { selection = JSON.parse(fields.selection) } catch { throw new Error('Select the products and destinations for this import') }
    const boundary = await resolveProductTransferBoundary((request.params as { productId: string }).productId, selection)
    const parsed = requireEditorVersions(await readEditorTransfer(buffer, filename, productId, actor(request), undefined, decisionsOf(fields)))
    return reply.code(201).send(await stageTransferJob({ ...parsed, boundary, mode: 'update', market: marketOf(fields.market), filename, userId: actor(request) }))
  })
  fastify.post('/catalog-transfer/products/:productId/source/preview', async (request, reply) => {
    const body = request.body as Parameters<typeof previewCatalogSource>[0] & { selection: ProductTransferSelection }
    const boundary = await resolveProductTransferBoundary((request.params as { productId: string }).productId, body?.selection)
    return reply.code(201).send(await previewCatalogSource({ ...body, userId: actor(request), boundary }))
  })
  fastify.get('/catalog-transfer/languages', async () => catalogTransferLanguages())
  fastify.post('/catalog-transfer/translate/preview', async request => previewCatalogTranslation(request.body as import('@nexus/shared/products-grid').CatalogTranslateInput, actor(request)))
  fastify.post('/catalog-transfer/translate/apply', async () => requireTranslationGeneration())
  fastify.get('/catalog-transfer/translate/runs', async request => catalogTranslationRuns((request.query as { language: string }).language, actor(request)))
  fastify.post('/catalog-transfer/translate/:jobId/revert', async request => revertCatalogTranslation((request.params as { jobId: string }).jobId, actor(request)))
  fastify.get('/catalog-transfer/readiness/options', async () => catalogReadinessOptions())
  fastify.get('/catalog-transfer/readiness', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return listingReadiness(request.query as Record<string, unknown>, actor(request))
  })
  fastify.get('/catalog-transfer/source/history', async request => listSourceHistory(actor(request), Number((request.query as { page?: string }).page ?? 1)))
  fastify.get('/catalog-transfer/source/fields', async request => sourceMappingFields(request.query as Parameters<typeof sourceMappingFields>[0]))
  fastify.get('/catalog-transfer/source/presets', async request => listSourcePresets(actor(request), Number((request.query as { page?: string }).page ?? 1)))
  fastify.post('/catalog-transfer/source/presets', async (request, reply) => reply.code(201).send(await saveSourcePreset({ ...request.body as Parameters<typeof saveSourcePreset>[0], userId: actor(request) })))
  fastify.delete('/catalog-transfer/source/presets/:id', async request => {
    await deleteSourcePreset((request.params as { id: string }).id, (request.query as { version: string }).version, actor(request))
    return { deleted: true }
  })
  fastify.post('/catalog-transfer/source/inspect', async (request, reply) => {
    const part = await request.file({ limits: { files: 1, fileSize: TRANSFER_MAX_FILE_BYTES } })
    if (!part) throw new Error('Choose a CSV, XLSX or JSON source file')
    return reply.code(201).send(await inspectCatalogSource(await part.toBuffer(), part.filename, actor(request)))
  })
  fastify.post('/catalog-transfer/source/fetch', async (request, reply) => {
    const url = (request.body as { url?: string })?.url
    if (!url || typeof url !== 'string') throw new Error('Enter a source URL')
    const source = await fetchCatalogSource(url)
    return reply.code(201).send(await inspectCatalogSource(source.buffer, source.filename, actor(request), url))
  })
  fastify.post('/catalog-transfer/source/preview', async (request, reply) => reply.code(201).send(await previewCatalogSource({ ...request.body as Parameters<typeof previewCatalogSource>[0], userId: actor(request), boundary: undefined })))
  fastify.post('/catalog-transfer/template', async (request, reply) => {
    const body = request.body as { market?: string; familyId?: string; channel?: WorkbookDestination; channels?: WorkbookDestination[]; locales?: string[]; layout?: string }
    const file = body.layout === 'wide' ? await catalogWorkbookTemplate({ market: marketOf(body.market), familyId: String(body.familyId ?? ''), channels: body.channels, locales: body.locales })
      : await catalogTransferTemplate(marketOf(body?.market), String(body?.familyId ?? ''), body?.channel)
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="nexus-catalog-template.xlsx"').send(file)
  })
  fastify.post('/catalog-transfer/export', async (request, reply) => {
    const body = request.body as { market?: string; familyId?: string; skus?: string[]; purpose?: string; marketplaces?: string[]; layout?: 'wide' | 'attributes' }
    if (body?.purpose !== 'editing' && body?.purpose !== 'effective') throw new Error('Choose an editing export or effective listing values')
    if (body.skus !== undefined && (!Array.isArray(body.skus) || body.skus.some(s => typeof s !== 'string' || !s.trim()))) throw new Error('Specify non-empty SKUs')
    const file = await exportCatalogTransfer({ market: marketOf(body.market), familyId: body.familyId, skus: body.skus, effective: body.purpose === 'effective', marketplaces: body.marketplaces, layout: body.layout })
    return reply.header('Content-Type', file.contentType).header('Content-Disposition', `attachment; filename="${file.filename}"`).send(file.data)
  })
  fastify.post('/catalog-transfer/preview', async (request, reply) => {
    const fields: Record<string, string> = {}
    let buffer: Buffer | undefined, filename = ''
    for await (const part of request.parts({ limits: { files: 1, fileSize: TRANSFER_MAX_FILE_BYTES, fields: 9 } })) {
      if (part.type === 'file') { filename = part.filename; buffer = await part.toBuffer() }
      else fields[part.fieldname] = String(part.value ?? '')
    }
    if (!buffer) throw new Error('Choose a CSV, XLSX or XLSM file')
    if (!['create', 'update', 'upsert'].includes(fields.mode)) throw new Error('Choose Create, Update or Create or update')
    if (fields.blankPolicy && !['ignore', 'clear'].includes(fields.blankPolicy)) throw new Error('Blank cells must be ignored or cleared')
    // CFI-1 — every workbook is read on the parse worker, by what it IS; `format` is only the operator's hint.
    // An empty marketplace means "use the file's own" — valid for an Amazon template or an eBay workbook only.
    const chosenMarket = fields.market?.trim() ? marketOf(fields.market) : ''
    const parsed = await readCatalogTransferUpload(buffer, filename, { format: fields.format, accountId: fields.accountId, market: chosenMarket, familyId: fields.familyId,
      mode: fields.mode as TransferMode, blankPolicy: fields.blankPolicy as 'ignore' | 'clear' | undefined, ...decisionsOf(fields) }, (event, detail) => request.log.info({ filename, ...detail }, event))
    const staged = await stageTransferJob({ ...parsed, mode: fields.mode as TransferMode, market: parsed.market, filename, userId: actor(request) })
    return reply.code(201).send({ ...staged, links: parsed.links ?? [] })
  })
  fastify.get('/catalog-transfer/jobs/:jobId', async (request, reply) => {
    const current = await readTransferJob((request.params as { jobId: string }).jobId, actor(request))
    if (current) return transferJobStatus(current)
    const loaded = await readCatalogTransfer((request.params as { jobId: string }).jobId, actor(request))
    return loaded ? catalogTransferStatus(loaded) : reply.code(404).send({ error: 'Import job not found' })
  })
  fastify.get('/catalog-transfer/jobs/:jobId/errors', async (request, reply) => {
    const id = (request.params as { jobId: string }).jobId, userId = actor(request)
    if (await readTransferJob(id, userId)) {
      async function* csv() {
        yield transferErrorsCsv([])
        for (let page = 1; ; page++) {
          const result = await transferJobOutcomes(id, userId, page)
          if (!result?.rows.length) break
          for (const row of result.rows) {
            const issues = [...row.issues, ...(row.error ? [{ row: row.identity?.row ?? row.index, sku: row.identity?.sku ?? '', field: row.identity?.field ?? '', message: row.error, source: row.identity?.source }] : [])]
            for (const issue of issues) yield `\r\n${transferErrorsCsv([issue]).split('\r\n').slice(1).join('\r\n')}`
          }
          if (page * result.pageSize >= result.total) break
        }
      }
      return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="nexus-catalog-errors.csv"').send(Readable.from(csv()))
    }
    const loaded = await readCatalogTransfer((request.params as { jobId: string }).jobId, actor(request))
    if (!loaded) return reply.code(404).send({ error: 'Import job not found' })
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="nexus-catalog-errors.csv"').send(transferErrorsCsv(catalogTransferStatus(loaded).issues))
  })
  fastify.post('/catalog-transfer/jobs/:jobId/apply', async (request, reply) => {
    const body = request.body as { reviewToken?: string; readyOnly?: unknown } | undefined
    if (body?.readyOnly !== undefined && typeof body.readyOnly !== 'boolean') throw new Error('readyOnly must be true or false')
    // CFI-7 (D6) — `readyOnly` applies the ready records of a review that also holds refused ones; never implied.
    const current = await applyTransferJob((request.params as { jobId: string }).jobId, actor(request), body?.reviewToken as string, { readyOnly: body?.readyOnly === true })
    if (current) return reply.code(202).send(current)
    const result = await startCatalogTransfer((request.params as { jobId: string }).jobId, actor(request))
    return result ? reply.code(202).send(result) : reply.code(404).send({ error: 'Import job not found' })
  })
  fastify.get('/catalog-transfer/jobs/:jobId/outcomes', async (request, reply) => {
    const query = request.query as { page?: string; status?: string; sku?: string; destination?: string }
    const result = await transferJobOutcomes((request.params as { jobId: string }).jobId, actor(request), Number(query.page ?? 1), query.status, query)
    return result ?? reply.code(404).send({ error: 'Import job not found' })
  })
  fastify.post('/catalog-transfer/jobs/:jobId/retry', async (request, reply) => {
    const result = await retryTransferJob((request.params as { jobId: string }).jobId, actor(request))
    return result ? reply.code(201).send(result) : reply.code(404).send({ error: 'Import job not found' })
  })
  let recovering = false
  const timer = setInterval(() => {
    if (recovering) return
    recovering = true
    void recoverImportsInEveryBusiness(visitActiveWorkspaces, failure => fastify.log.warn(failure, 'Catalog import recovery deferred'))
      .catch(error => fastify.log.warn({ err: error }, 'Catalog import recovery deferred')).finally(() => { recovering = false })
  }, 30_000)
  timer.unref()
  fastify.addHook('onClose', async () => { clearInterval(timer) })
}
export default catalogTransferRoutes
